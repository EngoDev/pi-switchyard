import { choice, type ChoiceCriteria, type EntryType, type RequestOptions } from "@typesafe-ai/sdk";

import { sanitizeForRouter } from "./privacy.js";
import { TIER_NAMES, type RouteDecision, type RouterConfig, type TempThread, type TierName } from "./types.js";
import type { OriginContextItem } from "./types.js";

export interface RouteRequest {
  prompt: string;
  hasImages: boolean;
  originContext: OriginContextItem[];
  threads: TempThread[];
  config: RouterConfig;
  signal?: AbortSignal;
  lastVisibleRoute?: {
    threadId: string;
    threadName: string;
    tier: TierName;
    model: string;
  };
}

interface RouteResponse {
  answers: {
    target: {
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    };
    tier: {
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    };
  };
}

export interface RouteClient {
  systemOne(request: {
    model: string;
    state: EntryType;
    questions: Record<string, unknown>;
  }, options?: RequestOptions): Promise<RouteResponse>;
}

export const TIER_CRITERIA = {
  genius: {
    what: "The hardest work: novel architecture, broad ambiguous changes, high-stakes decisions, deep debugging, or tasks where a weaker answer would be costly.",
    not_for: "Routine implementation, ordinary repository work, status checks, or simple factual answers.",
    examples: ["Design a new distributed subsystem", "Diagnose an elusive cross-component correctness bug"],
  },
  smart: {
    what: "Substantial analysis or implementation requiring strong reasoning, multiple coordinated steps, or meaningful design judgment.",
    not_for: "The most novel/high-stakes work, or straightforward mechanical operations.",
    examples: ["Implement a multi-file feature from a clear design", "Review a non-trivial change for correctness"],
  },
  handy: {
    what: "Routine coding and repository operations that need competence but have a clear path and bounded consequences.",
    not_for: "Novel architecture or tiny lookups that need almost no reasoning.",
    examples: ["Create a pull request", "Run tests and fix a straightforward failure", "Make a small local edit"],
  },
  cheap: {
    what: "Quick, low-risk lookups, status checks, simple commands, confirmations, or short factual responses.",
    not_for: "Work requiring substantial code changes, broad context, or difficult judgment.",
    examples: ["Did you create a PR?", "What branch are we on?", "List the changed files"],
  },
} as const satisfies ChoiceCriteria;

function buildTargetCriteria(threads: readonly TempThread[]): {
  criteria: ChoiceCriteria;
  optionToThreadId: Map<string, string>;
} {
  const criteria: ChoiceCriteria = {
    origin: {
      what: "Continue the primary work in the origin conversation.",
      use_when: "The request advances, changes, verifies, or depends directly on the main task, or its result should remain in the origin task's future context.",
      not_for: "Bounded side questions, status checks, pull-request or branch administration, unrelated work whose transcript would distract the main task, or requests that require context unique to an existing temp. Continue the relevant temp first; it can later hand its result back to origin.",
      examples: ["Continue implementing the router", "Use the design we agreed on to fix the remaining tests"],
    },
    new_temp_from_origin: {
      what: "Create a new flat sibling temporary thread seeded only with a small snapshot of the origin conversation.",
      use_when: "The request is a bounded aside that needs origin context but is independent of facts, conclusions, tool results, and unresolved work unique to every existing temp thread, including the currently visible one.",
      not_for: "Anything that depends on the currently visible temp thread, a follow-up to another existing temp thread, or a direct continuation of the primary work. If current-temp context is needed, continue that temp even when the request introduces a related subtopic.",
      examples: ["While a test aside is visible, independently check whether the origin task's README was updated", "What branch are we on?", "Explain an unrelated concept using only origin context"],
    },
  };
  const optionToThreadId = new Map<string, string>();
  for (const thread of threads) {
    const option = `temp_${thread.id}`;
    optionToThreadId.set(option, thread.id);
    criteria[option] = {
      what: `Continue the existing temporary thread named ${thread.name}.`,
      original_purpose: sanitizeForRouter(thread.firstPrompt, 1_200),
      latest_user_message: sanitizeForRouter(thread.lastUserText ?? "", 1_200),
      latest_assistant_answer: sanitizeForRouter(thread.lastAssistantText ?? "", 1_200),
      use_when: "The new request follows up on, confirms, corrects, continues, or relies on facts, conclusions, tool results, or unresolved work from this specific temporary thread. For the currently visible temp, choose this even when the request opens a related subtopic that could otherwise look like a new aside.",
    };
  }
  return { criteria, optionToThreadId };
}

function normalizeTierProbabilities(probabilities: Record<string, number>): Record<TierName, number> {
  return {
    genius: probabilities.genius ?? 0,
    smart: probabilities.smart ?? 0,
    handy: probabilities.handy ?? 0,
    cheap: probabilities.cheap ?? 0,
  };
}

export function upgradeTier(tier: TierName): TierName {
  const capabilityOrder: TierName[] = ["cheap", "handy", "smart", "genius"];
  const index = capabilityOrder.indexOf(tier);
  return capabilityOrder[Math.min(index + 1, capabilityOrder.length - 1)] ?? "genius";
}

export async function decideRoute(client: RouteClient, request: RouteRequest): Promise<RouteDecision | undefined> {
  const { criteria: targetCriteria, optionToThreadId } = buildTargetCriteria(request.threads);
  const configuredTiers = Object.fromEntries(
    TIER_NAMES.map((tier) => {
      const configured = request.config.tiers[tier];
      return [
        tier,
        configured
          ? { model: `${configured.provider}/${configured.modelId}`, thinking: configured.thinking }
          : null,
      ];
    }),
  );

  try {
    const response = await client.systemOne(
      {
        model: "jev-latest",
        state: {
          request: {
            text: sanitizeForRouter(request.prompt, 8_000),
            has_images: request.hasImages,
          },
          origin_context: request.originContext.map((item) => ({
            role: item.role,
            text: sanitizeForRouter(item.text, 2_000),
            timestamp: item.timestamp,
            tool_name: item.toolName ?? null,
          })),
          existing_temp_threads: request.threads.map((thread) => ({
            id: thread.id,
            name: thread.name,
            original_purpose: sanitizeForRouter(thread.firstPrompt, 1_200),
            latest_user_message: sanitizeForRouter(thread.lastUserText ?? "", 1_200),
            latest_assistant_answer: sanitizeForRouter(thread.lastAssistantText ?? "", 1_200),
          })),
          last_visible_route: request.lastVisibleRoute ?? null,
          configured_tiers: configuredTiers,
        },
        questions: {
          target: choice(
            {
              question: "Which conversation thread should handle `request.text`?",
              focus: "Protect the primary task from unrelated context while preserving continuity for work that belongs together.",
            },
            targetCriteria,
          ),
          tier: choice(
            {
              question: "What is the least expensive capability tier that can reliably complete `request.text`?",
              focus: "Choose based on reasoning difficulty, breadth, ambiguity, and consequences—not message length or prestige of the configured model name.",
            },
            TIER_CRITERIA,
          ),
        },
      },
      {
        timeout: 3_000,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const targetAnswer = response.answers.target;
    const tierAnswer = response.answers.tier;
    let target = targetAnswer.choice;
    if (targetAnswer.confidence < request.config.targetConfidenceFloor) target = "origin";
    else if (target === "new_temp") target = "new_temp_from_origin";
    else if (optionToThreadId.has(target)) target = optionToThreadId.get(target) ?? "origin";
    else if (target !== "origin" && target !== "new_temp_from_origin") return undefined;

    let tier = tierAnswer.choice as TierName;
    if (!TIER_NAMES.includes(tier)) return undefined;
    if (tierAnswer.confidence < request.config.tierConfidenceFloor) tier = upgradeTier(tier);

    return {
      target,
      tier,
      targetConfidence: targetAnswer.confidence,
      tierConfidence: tierAnswer.confidence,
      targetProbabilities: { ...targetAnswer.probabilities },
      tierProbabilities: normalizeTierProbabilities({ ...tierAnswer.probabilities }),
    };
  } catch {
    return undefined;
  }
}
