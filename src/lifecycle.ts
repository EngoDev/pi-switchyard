import { createHash } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { getRouterMetadata, messagesFromEntries, threadContextFromEntries } from "./threads.js";
import type { RouterConfig, TempThread } from "./types.js";

export function fingerprintImages(images: readonly ImageContent[] | undefined): string {
  if (!images || images.length === 0) return "none";
  return createHash("sha256").update(JSON.stringify(images)).digest("hex");
}

export function ensurePromotionMessagesDurable(
  messages: readonly AgentMessage[],
  model: Model<any>,
): AgentMessage[] {
  if (messages.some((message) => message.role === "assistant")) return [...messages];
  return [
    ...messages,
    {
      role: "assistant",
      content: [{
        type: "text",
        text: "Switchyard promoted this temporary thread into a child session before it received a complete assistant response.",
      }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ];
}

export interface TempThreadBudget {
  tokens: number;
  turns: number;
  tokenLimitExceeded: boolean;
  turnLimitExceeded: boolean;
  exceeded: boolean;
}

export interface TempThreadStats {
  /** Compaction-aware estimated context tokens for this thread, with no pending prompt added. */
  tokens: number;
  /** Completed user turns tagged to this thread. */
  turns: number;
}

/**
 * Compaction-aware context/turn estimate for a temp thread as it stands right now, with no
 * hypothetical pending prompt added. Shared by the bounded-lifecycle budget check and by
 * `/switchyard threads`' read-only list, so both report the same numbers for the same thread.
 */
export function estimateTempThreadStats(
  entries: readonly SessionEntry[],
  thread: TempThread,
): TempThreadStats {
  const context = threadContextFromEntries(entries, thread);
  const tokens = context.reduce((total, message) => total + estimateTokens(message), 0);
  const turns = messagesFromEntries(entries).filter(
    (message) => message.role === "user" && getRouterMetadata(message)?.threadId === thread.id,
  ).length;
  return { tokens, turns };
}

export function projectTempThreadBudget(
  entries: readonly SessionEntry[],
  thread: TempThread,
  prompt: string,
  images: readonly ImageContent[] | undefined,
  config: RouterConfig,
): TempThreadBudget {
  const stats = estimateTempThreadStats(entries, thread);
  const pending: AgentMessage = {
    role: "user",
    content: [
      { type: "text", text: prompt },
      ...(images ?? []),
    ],
    timestamp: Date.now(),
  };
  const tokens = stats.tokens + estimateTokens(pending);
  const turns = stats.turns + 1;
  const tokenLimitExceeded = config.tempThreadSoftTokenLimit > 0
    && tokens >= config.tempThreadSoftTokenLimit;
  const turnLimitExceeded = config.tempThreadSoftTurnLimit > 0
    && turns >= config.tempThreadSoftTurnLimit;
  return {
    tokens,
    turns,
    tokenLimitExceeded,
    turnLimitExceeded,
    exceeded: tokenLimitExceeded || turnLimitExceeded,
  };
}

export function formatTempThreadHandoff(thread: TempThread, summary: string): string {
  return [
    `Switchyard handoff from temp:${thread.name}`,
    "",
    "The user chose to retire this temporary thread and return its relevant context to the origin conversation.",
    "",
    "<summary>",
    summary.trim(),
    "</summary>",
  ].join("\n");
}

/**
 * Confirms a `switchyard-handoff` custom message was actually appended to the branch under the
 * given operation id before its source temp thread is retired. Both the automatic (budget-driven)
 * and explicit (`/switchyard threads`) summarize-into-origin flows must verify this before
 * retiring their thread, so a failed/partial append never silently drops the thread's work.
 */
export function isSwitchyardHandoffPersisted(
  entries: readonly SessionEntry[],
  operationId: string,
): boolean {
  return entries.some((entry) => {
    if (entry.type !== "custom_message" || entry.customType !== "switchyard-handoff") return false;
    if (!entry.details || typeof entry.details !== "object") return false;
    const handoff = (entry.details as Record<string, unknown>).switchyardHandoff;
    if (!handoff || typeof handoff !== "object") return false;
    return (handoff as Record<string, unknown>).operationId === operationId;
  });
}
