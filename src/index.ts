import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { StringEnum, uuidv7 } from "@earendil-works/pi-ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  convertToLlm,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  serializeConversation,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolveTypeSafeApiKey } from "./auth.js";
import {
  collectOriginFileLists,
  collectTempCompactionInput,
  COMPACTION_FILES_ENTRY_TYPE,
  compactOriginThread,
  compactTempThread,
  findPreviousOriginFileLists,
  type OriginSummaryRequest,
  type OriginSummaryResult,
} from "./compaction.js";
import { isConfigured, loadConfig } from "./config.js";
import { registerConfigurationCommand } from "./configuration-ui.js";
import { decideRoute, type RouteClient } from "./router.js";
import {
  formatOriginContextResult,
  ORIGIN_CONTEXT_ROLES,
  selectOriginContext,
} from "./origin-context.js";
import {
  createTempThread,
  filterMessagesForOrigin,
  findMissingTempLabels,
  getOriginContext,
  messagesFromEntries,
  restoreThreads,
  threadContextFromEntries,
  updateThreadFromMessage,
} from "./threads.js";
import type {
  ActiveRoute,
  RouterConfig,
  RouterSessionEntryData,
  TaggedAgentMessage,
  TempThread,
  TierConfig,
  TierName,
} from "./types.js";

const SWITCHYARD_ENTRY_TYPE = "switchyard";
const LEGACY_ROUTER_ENTRY_TYPE = "jev-router";
const STATUS_KEY = "switchyard";
const ORIGIN_CONTEXT_TOOL = "get_context_from_origin";
const CAPABILITY_ORDER: TierName[] = ["cheap", "handy", "smart", "genius"];

function toRouteClient(client: TypeSafeClient): RouteClient {
  return {
    systemOne: async (request, options) => {
      return (await client.systemOne(request as never, options)) as never;
    },
  };
}

function normalizePersistedRoute(route: ActiveRoute): ActiveRoute {
  const legacyOrigin = route.threadId === ("parent" as string);
  const legacyTarget = route.decision.target === "parent";
  return {
    ...route,
    threadId: legacyOrigin ? "origin" : route.threadId,
    threadName: legacyOrigin ? "origin" : route.threadName,
    decision: {
      ...route.decision,
      target: legacyTarget ? "origin" : route.decision.target,
    },
  };
}

function findLastRoute(entries: readonly SessionEntry[]): ActiveRoute | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "custom"
      || (entry.customType !== SWITCHYARD_ENTRY_TYPE && entry.customType !== LEGACY_ROUTER_ENTRY_TYPE)
    ) continue;
    const data = entry.data as RouterSessionEntryData | undefined;
    if (data?.kind === "route") return normalizePersistedRoute(data.route);
  }
  return undefined;
}

export function formatRouteStatus(route: ActiveRoute, effectiveThinking: ThinkingLevel): string {
  const thread = route.threadId === "origin" ? "origin" : `temp:${route.threadName}`;
  return `jev ${thread} · ${route.tier} · ${route.provider}/${route.modelId} · ${effectiveThinking}`;
}

function modelSupportsImages(model: Model<any>): boolean {
  return model.input.includes("image");
}

function resolveTierModel(
  ctx: ExtensionContext,
  config: RouterConfig,
  requestedTier: TierName,
  hasImages: boolean,
): { tier: TierName; tierConfig: TierConfig; model: Model<any> } | undefined {
  const start = CAPABILITY_ORDER.indexOf(requestedTier);
  const candidates = hasImages ? CAPABILITY_ORDER.slice(Math.max(0, start)) : [requestedTier];
  for (const tier of candidates) {
    const tierConfig = config.tiers[tier];
    if (!tierConfig) continue;
    const model = ctx.modelRegistry.find(tierConfig.provider, tierConfig.modelId);
    if (!model) continue;
    if (hasImages && !modelSupportsImages(model)) continue;
    return { tier, tierConfig, model };
  }
  return undefined;
}

function getSessionMessages(ctx: ExtensionContext): AgentMessage[] {
  return messagesFromEntries(ctx.sessionManager.getBranch());
}

function mergeUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...((first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined)
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
      : {}),
    ...((first.reasoning !== undefined || second.reasoning !== undefined)
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
      : {}),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
}

async function summarizeThreadWithPi(
  request: OriginSummaryRequest,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<OriginSummaryResult> {
  if (!ctx.model) throw new Error("No model is available for origin-only compaction");
  const conversation = serializeConversation(convertToLlm(request.messages));
  const previousLabel = request.scope.kind === "origin" ? "Previous origin summary" : "Previous temp-thread summary";
  const previous = request.previousSummary
    ? `\n\n## ${previousLabel}\n${request.previousSummary}`
    : "";
  const custom = request.customInstructions
    ? `\n\n## User focus instructions\n${request.customInstructions}`
    : "";
  const scopeName = request.scope.kind === "origin"
    ? "origin conversation"
    : `temp thread ${request.scope.threadName}`;
  const prompt = `Create a structured continuation summary for the ${scopeName} only.

Capture its goal, constraints, progress, decisions, files, blockers, and next steps. Do not continue the conversation. Messages from other logical threads have already been removed; do not infer or add unrelated work.${previous}${custom}

<thread-conversation>\n${conversation}\n</thread-conversation>`;
  const response = await ctx.modelRegistry.complete(
    ctx.model,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      }],
    },
    {
      maxTokens: Math.min(8192, ctx.model.maxTokens),
      signal,
      cacheRetention: "none",
      sessionId: uuidv7(),
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
    throw new Error(response.errorMessage ?? `Origin compaction stopped with ${response.stopReason}`);
  }
  const summary = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return { summary, usage: response.usage };
}

export default function switchyardExtension(pi: ExtensionAPI): void {
  let config: RouterConfig;
  let routeClient: RouteClient | undefined;
  let threads = new Map<string, TempThread>();
  let activeRoute: ActiveRoute | undefined;
  let lastVisibleRoute: ActiveRoute | undefined;
  let pendingThreadCreated: TempThread | undefined;
  let pendingRoutePrompt: string | undefined;
  let pendingCompactionFileLists: { readFiles: string[]; modifiedFiles: string[] } | undefined;
  let routeMetadataPersisted = false;

  function setOriginContextToolEnabled(enabled: boolean): void {
    const active = pi.getActiveTools();
    const isActive = active.includes(ORIGIN_CONTEXT_TOOL);
    if (enabled && !isActive) pi.setActiveTools([...active, ORIGIN_CONTEXT_TOOL]);
    if (!enabled && isActive) pi.setActiveTools(active.filter((name) => name !== ORIGIN_CONTEXT_TOOL));
  }

  function clearDebugStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function restoreBranchState(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch();
    threads = restoreThreads(branch);
    activeRoute = undefined;
    lastVisibleRoute = findLastRoute(branch);
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    routeMetadataPersisted = false;
  }

  function ensureTempTreeLabels(ctx: ExtensionContext): void {
    const labels = findMissingTempLabels(
      ctx.sessionManager.getBranch(),
      (entryId) => ctx.sessionManager.getLabel(entryId),
    );
    for (const { entryId, label } of labels) pi.setLabel(entryId, label);
  }

  function showDebugStatus(ctx: ExtensionContext, route: ActiveRoute): void {
    if (!config.debug) {
      clearDebugStatus(ctx);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", formatRouteStatus(route, pi.getThinkingLevel())));
  }

  pi.registerTool({
    name: ORIGIN_CONTEXT_TOOL,
    label: "Get Context From Origin",
    description: "Retrieve a bounded, filtered slice of messages from the origin logical session. Available only in Jev-routed temp threads. Results are limited to 20 messages and 50KB.",
    promptSnippet: "Retrieve additional context from the origin session when the temp thread's initial snapshot is insufficient",
    promptGuidelines: [
      "Use get_context_from_origin only when the current temp thread needs specific origin-session information that is absent from its initial snapshot.",
      "Prefer a narrow query and small limit when using get_context_from_origin.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Case-insensitive text filter" })),
      roles: Type.Optional(Type.Array(StringEnum(ORIGIN_CONTEXT_ROLES))),
      offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
      order: Type.Optional(StringEnum(["newest", "oldest"] as const, { default: "newest" })),
      includeToolResults: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!activeRoute || activeRoute.threadId === "origin") {
        throw new Error("get_context_from_origin is only available inside a routed temp thread");
      }
      const items = selectOriginContext(getSessionMessages(ctx), params);
      const raw = formatOriginContextResult(items);
      const truncation = truncateHead(raw, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      let text = truncation.content;
      if (truncation.truncated) {
        text += `\n\n[Context truncated to ${formatSize(truncation.outputBytes)}. Use a narrower query, offset, or limit.]`;
      }
      return {
        content: [{ type: "text", text }],
        details: { matched: items.length, query: params },
      };
    },
  });

  registerConfigurationCommand(pi, {
    getConfig: () => config,
    reloadConfig: (ctx) => {
      config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    },
    onDebugChanged: (ctx) => {
      if (config.enabled && config.debug && routeClient && lastVisibleRoute) {
        showDebugStatus(ctx, lastVisibleRoute);
      } else {
        clearDebugStatus(ctx);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    restoreBranchState(ctx);
    ensureTempTreeLabels(ctx);
    routeClient = undefined;
    setOriginContextToolEnabled(false);

    const apiKey = resolveTypeSafeApiKey();
    if (!apiKey) {
      clearDebugStatus(ctx);
      return;
    }
    try {
      routeClient = toRouteClient(
        new TypeSafeClient({
          apiKey,
          defaultModel: "jev-latest",
          timeout: 3_000,
          retry: { maxRetries: 0 },
          logLevel: "off",
        }),
      );
      if (lastVisibleRoute && config.debug) showDebugStatus(ctx, lastVisibleRoute);
      else clearDebugStatus(ctx);
    } catch {
      routeClient = undefined;
      clearDebugStatus(ctx);
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    setOriginContextToolEnabled(false);
    restoreBranchState(ctx);
    ensureTempTreeLabels(ctx);
    if (config.debug && routeClient && lastVisibleRoute) showDebugStatus(ctx, lastVisibleRoute);
    else clearDebugStatus(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    pendingCompactionFileLists = undefined;
    const { preparation, branchEntries, customInstructions, signal } = event;
    const previousFileLists = findPreviousOriginFileLists(branchEntries);
    const outcome = await compactOriginThread(
      {
        messagesToSummarize: preparation.messagesToSummarize,
        turnPrefixMessages: preparation.turnPrefixMessages,
        previousSummary: preparation.previousSummary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        customInstructions,
        ...(previousFileLists ? { previousFileLists } : {}),
      },
      (request) => summarizeThreadWithPi(request, ctx, signal),
    );
    if (outcome.action === "default") {
      pendingCompactionFileLists = collectOriginFileLists(
        [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
        previousFileLists,
      );
      return;
    }
    if (outcome.action === "cancel") {
      if (!signal.aborted) {
        ctx.ui.notify(`Origin-only compaction cancelled: ${outcome.reason}`, "error");
      }
      return { cancel: true };
    }

    const tempRoute = activeRoute && activeRoute.threadId !== "origin"
      ? activeRoute
      : lastVisibleRoute && lastVisibleRoute.threadId !== "origin"
        ? lastVisibleRoute
        : undefined;
    if (tempRoute) {
      const tempInput = collectTempCompactionInput(
        branchEntries,
        tempRoute.threadId,
        preparation.firstKeptEntryId,
      );
      const tempOutcome = await compactTempThread(
        {
          threadId: tempRoute.threadId,
          threadName: tempRoute.threadName,
          messagesToSummarize: tempInput.messages,
          turnPrefixMessages: [],
          previousSummary: tempInput.previousSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          customInstructions,
        },
        (request) => summarizeThreadWithPi(request, ctx, signal),
      );
      if (tempOutcome.action === "cancel") {
        if (!signal.aborted) {
          ctx.ui.notify(`Temp-thread compaction cancelled: ${tempOutcome.reason}`, "error");
        }
        return { cancel: true };
      }
      if (tempOutcome.action === "compact") {
        const { usage, ...tempSummary } = tempOutcome.summary;
        outcome.compaction.details.switchyard.tempThreads = {
          [tempRoute.threadId]: tempSummary,
        };
        const combinedUsage = mergeUsage(outcome.compaction.usage, usage);
        if (combinedUsage) outcome.compaction.usage = combinedUsage;
      }
    }

    pendingCompactionFileLists = {
      readFiles: outcome.compaction.details.readFiles,
      modifiedFiles: outcome.compaction.details.modifiedFiles,
    };
    if (config.debug) {
      ctx.ui.notify(
        `Origin-only compaction excluded ${outcome.compaction.details.switchyard.excludedTempMessages} temp message(s)`,
        "info",
      );
    }
    return { compaction: outcome.compaction };
  });

  pi.on("session_compact", (event) => {
    if (!pendingCompactionFileLists) return;
    pi.appendEntry(COMPACTION_FILES_ENTRY_TYPE, {
      compactionEntryId: event.compactionEntry.id,
      ...pendingCompactionFileLists,
    });
    pendingCompactionFileLists = undefined;
  });

  pi.on("session_compact_failed", () => {
    pendingCompactionFileLists = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (pendingThreadCreated && !routeMetadataPersisted) threads.delete(pendingThreadCreated.id);
    activeRoute = undefined;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    routeMetadataPersisted = false;

    if (!routeClient || !config.enabled || !isConfigured(config)) {
      clearDebugStatus(ctx);
      return;
    }

    const sessionMessages = getSessionMessages(ctx);
    const decision = await decideRoute(routeClient, {
      prompt: event.prompt,
      hasImages: (event.images?.length ?? 0) > 0,
      originContext: getOriginContext(sessionMessages, config.routerContextMessages),
      threads: [...threads.values()],
      config,
      ...(lastVisibleRoute
        ? {
            lastVisibleRoute: {
              threadId: lastVisibleRoute.threadId,
              threadName: lastVisibleRoute.threadName,
              tier: lastVisibleRoute.tier,
              model: `${lastVisibleRoute.provider}/${lastVisibleRoute.modelId}`,
            },
          }
        : {}),
    });

    // Jev unavailable, timed out, or returned an unusable answer: Pi proceeds untouched.
    if (!decision) {
      clearDebugStatus(ctx);
      return;
    }

    const resolved = resolveTierModel(ctx, config, decision.tier, (event.images?.length ?? 0) > 0);
    if (!resolved) {
      clearDebugStatus(ctx);
      return;
    }

    let targetThread: TempThread | undefined;
    if (decision.target === "new_temp") {
      targetThread = createTempThread(
        event.prompt,
        getOriginContext(sessionMessages, config.initialOriginMessages),
        [...threads.values()].map((thread) => thread.name),
      );
      pendingThreadCreated = targetThread;
      threads.set(targetThread.id, targetThread);
    } else if (decision.target !== "origin") {
      targetThread = threads.get(decision.target);
      if (!targetThread) {
        clearDebugStatus(ctx);
        return;
      }
    }

    const modelSet = await pi.setModel(resolved.model);
    if (!modelSet) {
      if (pendingThreadCreated) threads.delete(pendingThreadCreated.id);
      pendingThreadCreated = undefined;
      clearDebugStatus(ctx);
      return;
    }
    if (resolved.tierConfig.thinking !== "default") {
      pi.setThinkingLevel(resolved.tierConfig.thinking);
    }

    activeRoute = {
      threadId: targetThread?.id ?? "origin",
      threadName: targetThread?.name ?? "origin",
      tier: resolved.tier,
      provider: resolved.tierConfig.provider,
      modelId: resolved.tierConfig.modelId,
      thinking: resolved.tierConfig.thinking,
      decision: { ...decision, tier: resolved.tier },
    };
    lastVisibleRoute = activeRoute;
    pendingRoutePrompt = event.prompt;
    setOriginContextToolEnabled(activeRoute.threadId !== "origin");
    showDebugStatus(ctx, activeRoute);
    if (config.debug) {
      const thread = activeRoute.threadId === "origin" ? "origin" : `temp:${activeRoute.threadName}`;
      ctx.ui.notify(
        `Switchyard route → ${thread} | ${activeRoute.tier} | ${activeRoute.provider}/${activeRoute.modelId} | thinking:${pi.getThinkingLevel()} | confidence target:${activeRoute.decision.targetConfidence.toFixed(2)} tier:${activeRoute.decision.tierConfidence.toFixed(2)}`,
        "info",
      );
    }
  });

  pi.on("message_end", (event) => {
    if (!activeRoute || activeRoute.threadId === "origin") return;
    const metadata = {
      threadId: activeRoute.threadId,
      threadName: activeRoute.threadName,
    };
    const existingDetails = event.message.role === "custom"
      && event.message.details
      && typeof event.message.details === "object"
      && !Array.isArray(event.message.details)
      ? event.message.details as Record<string, unknown>
      : {};
    const tagged: TaggedAgentMessage = {
      ...event.message,
      ...(event.message.role === "custom"
        ? { details: { ...existingDetails, switchyard: metadata } }
        : {}),
      switchyard: metadata,
    };
    const thread = threads.get(activeRoute.threadId);
    if (thread) updateThreadFromMessage(thread, event.message);
    return { message: tagged };
  });

  pi.on("context", (event, ctx) => {
    if (!activeRoute) return;
    if (activeRoute.threadId === "origin") {
      return { messages: filterMessagesForOrigin(event.messages) };
    }
    const thread = threads.get(activeRoute.threadId);
    if (!thread) return;
    return { messages: threadContextFromEntries(ctx.sessionManager.getBranch(), thread) };
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant" || routeMetadataPersisted || !activeRoute || !pendingRoutePrompt) return;
    const leafId = ctx.sessionManager.getLeafId();
    const leaf = leafId ? ctx.sessionManager.getEntry(leafId) : undefined;
    if (activeRoute.threadId !== "origin" && leaf?.type === "message" && leaf.message.role === "user") {
      pi.setLabel(leaf.id, `temp:${activeRoute.threadName}`);
    }
    if (pendingThreadCreated) {
      pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
        kind: "thread-created",
        thread: pendingThreadCreated,
      } satisfies RouterSessionEntryData);
    }
    pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
      kind: "route",
      route: activeRoute,
      prompt: pendingRoutePrompt,
      timestamp: new Date().toISOString(),
    } satisfies RouterSessionEntryData);
    routeMetadataPersisted = true;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
  });

  pi.on("agent_settled", (_event, ctx) => {
    ensureTempTreeLabels(ctx);
    setOriginContextToolEnabled(false);
    if (pendingThreadCreated && !routeMetadataPersisted) threads.delete(pendingThreadCreated.id);
    activeRoute = undefined;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    routeMetadataPersisted = false;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    setOriginContextToolEnabled(false);
    if (pendingThreadCreated && !routeMetadataPersisted) threads.delete(pendingThreadCreated.id);
    activeRoute = undefined;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    routeMetadataPersisted = false;
    routeClient = undefined;
    clearDebugStatus(ctx);
  });
}
