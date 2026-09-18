import { existsSync } from "node:fs";

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import { StringEnum, uuidv7 } from "@earendil-works/pi-ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  BorderedLoader,
  convertToLlm,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  estimateTokens,
  formatSize,
  serializeConversation,
  sessionEntryToContextMessages,
  SessionManager,
  truncateHead,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InputEvent,
  type InputEventResult,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolveTypeSafeApiKey } from "./auth.js";
import { getCacheResetOpportunity, registerCacheResetDispatch } from "./cache-reset.js";
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
import {
  applyTargetOverride,
  applyTierOverride,
  formatManualOverrideStatus,
  mergeNextOverride,
  NEXT_OVERRIDE_ENTRY_TYPE,
  PIN_ENTRY_TYPE,
  registerNextOverrideDispatch,
  restoreNextOverride,
  restoreThreadPins,
  type NextOverrideEntryData,
  type PendingNextOverride,
  type PinEntryData,
} from "./overrides.js";
import {
  ensurePromotionMessagesDurable,
  fingerprintImages,
  formatTempThreadHandoff,
  projectTempThreadBudget,
} from "./lifecycle.js";
import { decideRoute, type RouteClient } from "./router.js";
import {
  formatOriginContextResult,
  ORIGIN_CONTEXT_ROLES,
  selectOriginContext,
} from "./origin-context.js";
import {
  acceptTierRecommendation,
  buildTransitionAudit,
  decideModelTransition,
  formatMinimalSwitchDecision,
  formatVerboseSwitchDecision,
  type ModelTransitionDecision,
  type RoutedModel,
  type TransitionAudit,
  type TierRecommendationEvidence,
} from "./switching.js";
import { summarizeOriginBranch } from "./tree-summary.js";
import {
  createTempThread,
  filterMessagesForOrigin,
  findMissingTempLabels,
  findCurrentModelEpochUsage,
  findLastRouteForThread,
  findRouteAuditHistoryForThread,
  findRouteHistoryForThread,
  findPendingPromotedPrompt,
  findRecoverableLifecycle,
  findRecoverablePromotion,
  findThreadBranchPoint,
  getOriginContext,
  messagesForPromotedSession,
  messagesFromEntries,
  restoreThreads,
  threadContextFromEntries,
  updateThreadFromMessage,
} from "./threads.js";
import {
  formatInspectReport,
  resolveModelPricing,
  summarizeCacheUsage,
  summarizeRouteHistory,
  type InspectSnapshot,
  type ThreadInspection,
} from "./inspect.js";
import { TIER_NAMES } from "./types.js";
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

type PendingRouteDecision = {
  requestId: string;
  prompt: string;
  imageFingerprint: string;
  decision: Awaited<ReturnType<typeof decideRoute>>;
};

type RequestIdentity = {
  generation: number;
  sessionFile: string | undefined;
  leafId: string | null;
};

type PendingPromotion = {
  token: string;
  lifecycleToken: string;
  prompt: string;
  images?: ImageContent[];
  thread: TempThread;
  messages: AgentMessage[];
  parentSession?: string;
  sourceEntryId?: string;
};

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
  const target = legacyTarget
    ? "origin"
    : route.decision.target === "new_temp"
      ? "new_temp_from_origin"
      : route.decision.target;
  return {
    ...route,
    threadId: legacyOrigin ? "origin" : route.threadId,
    threadName: legacyOrigin ? "origin" : route.threadName,
    decision: {
      ...route.decision,
      target,
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
    if (data?.kind === "thread-retired") return undefined;
    if (data?.kind === "route") return normalizePersistedRoute(data.route);
  }
  return undefined;
}

export function formatRouteStatus(route: ActiveRoute, effectiveThinking: ThinkingLevel): string {
  const thread = route.threadId === "origin" ? "origin" : `temp:${route.threadName}`;
  return `switchyard ${thread} · ${route.tier} · ${route.provider}/${route.modelId} · ${effectiveThinking}`;
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

function resolveTransitionCandidates(
  ctx: ExtensionContext,
  config: RouterConfig,
  hasImages: boolean,
): RoutedModel[] {
  return TIER_NAMES.flatMap((tier) => {
    const tierConfig = config.tiers[tier];
    if (!tierConfig) return [];
    const model = ctx.modelRegistry.find(tierConfig.provider, tierConfig.modelId);
    if (!model || (hasImages && !modelSupportsImages(model))) return [];
    return [{ tier, tierConfig, model }];
  });
}

function getSessionMessages(ctx: ExtensionContext): AgentMessage[] {
  return messagesFromEntries(ctx.sessionManager.getBranch());
}

function estimatePromptTokens(prompt: string, imageCount: number): number {
  return Math.max(1, Math.ceil(prompt.length / 4)) + imageCount * 1_600;
}

function resolveThreadIncumbent(
  ctx: ExtensionContext,
  threadId: string,
  hasImages: boolean,
): RoutedModel | undefined {
  const route = findLastRouteForThread(ctx.sessionManager.getBranch(), threadId);
  if (!route) return undefined;
  const model = ctx.modelRegistry.find(route.provider, route.modelId);
  if (!model || (hasImages && !modelSupportsImages(model))) return undefined;
  return {
    tier: route.tier,
    model,
    tierConfig: {
      provider: route.provider,
      modelId: route.modelId,
      thinking: route.thinking,
    },
  };
}

function threadMessagesForSwitching(
  ctx: ExtensionContext,
  threadId: string,
  thread: TempThread | undefined,
): AgentMessage[] {
  if (threadId === "origin") {
    return filterMessagesForOrigin(
      ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages),
    );
  }
  return thread ? threadContextFromEntries(ctx.sessionManager.getBranch(), thread) : [];
}

function evaluateThreadModelSwitch(
  ctx: ExtensionContext,
  threadId: string,
  thread: TempThread | undefined,
  requested: RoutedModel,
  candidates: RoutedModel[],
  currentRecommendation: TierRecommendationEvidence,
  prompt: string,
  imageCount: number,
  providerOverheadTokens: number,
  config: RouterConfig,
): ModelTransitionDecision {
  const messages = threadMessagesForSwitching(ctx, threadId, thread);
  const incumbent = resolveThreadIncumbent(ctx, threadId, imageCount > 0);
  const recentUsage = incumbent
    ? findCurrentModelEpochUsage(
        ctx.sessionManager.getBranch(),
        threadId,
        incumbent.model.provider,
        incumbent.model.id,
      )
    : [];
  const cacheInput = recentUsage.reduce(
    (sum, usage) => sum + usage.input + usage.cacheRead + usage.cacheWrite,
    0,
  );
  const observedCacheRead = recentUsage.reduce((sum, usage) => sum + usage.cacheRead, 0);
  const cacheResetOpportunity = getCacheResetOpportunity(ctx.sessionManager.getBranch(), threadId);
  const cacheInvalidated = cacheResetOpportunity !== undefined;
  const warmCacheRatio = cacheInvalidated
    ? 0
    : cacheInput > 0
      ? observedCacheRead / cacheInput
      : undefined;
  const warmCacheSource = cacheInvalidated
    ? "invalidated" as const
    : cacheInput > 0
      ? "observed" as const
      : "no-history" as const;
  const observedCacheWrite = recentUsage.reduce((sum, usage) => sum + usage.cacheWrite, 0);
  const observedUncachedInput = recentUsage.reduce((sum, usage) => sum + usage.input + usage.cacheWrite, 0);
  const cacheWriteRatio = observedUncachedInput > 0
    ? observedCacheWrite / observedUncachedInput
    : undefined;
  const outputSamples = recentUsage.map((usage) => usage.output).filter((tokens) => tokens > 0);
  const expectedOutputTokens = outputSamples.length > 0
    ? outputSamples.reduce((sum, tokens) => sum + tokens, 0) / outputSamples.length
    : config.switching.defaultExpectedOutputTokens;
  const promptTokens = estimatePromptTokens(prompt, imageCount);
  const contextTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0)
    + promptTokens
    + Math.max(0, providerOverheadTokens);
  const recommendationHistory: TierRecommendationEvidence[] = findRouteHistoryForThread(
    ctx.sessionManager.getBranch(),
    threadId,
  ).slice(-32).map((route, index) => ({
    requestId: route.decision.requestId ?? `legacy-${index}-${route.provider}-${route.modelId}`,
    tier: route.decision.tier,
    confidence: route.decision.tierConfidence,
    tierProbabilities: route.decision.tierProbabilities,
  }));
  return decideModelTransition({
    ...(cacheResetOpportunity ? { cacheResetOpportunity } : {}),
    taskPhase: "new-request",
    incumbent,
    requested,
    candidates,
    currentRecommendation,
    recommendationHistory,
    contextTokens,
    promptTokens,
    warmCacheRatio,
    warmCacheSource,
    ...(cacheWriteRatio !== undefined ? { cacheWriteRatio } : {}),
    expectedOutputTokens,
    config: config.switching,
  });
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
  if (!ctx.model) throw new Error("No model is available for thread-aware summarization");
  const conversation = serializeConversation(convertToLlm(request.messages));
  const previousLabel = request.scope.kind === "origin" ? "Previous origin summary" : "Previous temp-thread summary";
  const previous = request.previousSummary
    ? `\n\n## ${previousLabel}\n${request.previousSummary}`
    : "";
  const scopeName = request.scope.kind === "origin"
    ? "origin conversation"
    : `temp thread ${request.scope.threadName}`;
  const standardInstructions = `Create a structured continuation summary for the ${scopeName} only.\n\nCapture its goal, constraints, progress, decisions, files, blockers, and next steps.`;
  const mainInstructions = request.replaceInstructions && request.customInstructions
    ? request.customInstructions
    : standardInstructions;
  const custom = !request.replaceInstructions && request.customInstructions
    ? `\n\n## User focus instructions\n${request.customInstructions}`
    : "";
  const prompt = `${mainInstructions}

Do not continue the conversation. Messages from other logical threads have already been removed; do not infer or add unrelated work.${previous}${custom}

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
    throw new Error(response.errorMessage ?? `Thread-aware summarization stopped with ${response.stopReason}`);
  }
  const summary = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!summary) throw new Error("Thread-aware summarization returned an empty summary");
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
  let pendingTransitionAudit: TransitionAudit | undefined;
  let pendingCompactionFileLists: { readFiles: string[]; modifiedFiles: string[] } | undefined;
  let pendingRouteDecision: PendingRouteDecision | undefined;
  let forcePromotedPrompt: ReturnType<typeof findPendingPromotedPrompt>;
  let recoverablePromotion: ReturnType<typeof findRecoverablePromotion>;
  let recoverableLifecycle: ReturnType<typeof findRecoverableLifecycle>;
  let pendingPromotedToConsume: { token: string; prompt: string } | undefined;
  const pendingPromotions = new Map<string, PendingPromotion>();
  let lifecycleGeneration = 0;
  let activeLifecycleController: AbortController | undefined;
  let runtimeInvalidated = false;
  let originFallbackForNext = false;
  let routeMetadataPersisted = false;
  let threadPins = new Map<string, TierName>();
  let pendingNextOverride: PendingNextOverride | undefined;
  let appliedNextOverrideToken: string | undefined;

  registerCacheResetDispatch(pi, () => activeRoute?.threadId ?? (originFallbackForNext ? "origin" : undefined));
  registerNextOverrideDispatch(
    pi,
    () => appliedNextOverrideToken,
    (token) => {
      if (pendingNextOverride?.token === token) pendingNextOverride = undefined;
      appliedNextOverrideToken = undefined;
    },
  );

  function setOriginContextToolEnabled(enabled: boolean): void {
    const active = pi.getActiveTools();
    const isActive = active.includes(ORIGIN_CONTEXT_TOOL);
    if (enabled && !isActive) pi.setActiveTools([...active, ORIGIN_CONTEXT_TOOL]);
    if (!enabled && isActive) pi.setActiveTools(active.filter((name) => name !== ORIGIN_CONTEXT_TOOL));
  }

  function clearDebugStatus(ctx: ExtensionContext): void {
    const overrideText = overrideStatusText();
    ctx.ui.setStatus(STATUS_KEY, overrideText ? ctx.ui.theme.fg("accent", overrideText) : undefined);
  }

  function restoreBranchState(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch();
    threads = restoreThreads(branch);
    activeRoute = undefined;
    lastVisibleRoute = findLastRoute(branch);
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    pendingTransitionAudit = undefined;
    pendingRouteDecision = undefined;
    forcePromotedPrompt = findPendingPromotedPrompt(branch);
    recoverablePromotion = findRecoverablePromotion(branch);
    recoverableLifecycle = findRecoverableLifecycle(branch);
    pendingPromotedToConsume = undefined;
    originFallbackForNext = false;
    routeMetadataPersisted = false;
    threadPins = restoreThreadPins(branch);
    pendingNextOverride = restoreNextOverride(branch);
    appliedNextOverrideToken = undefined;
  }

  function currentLogicalThread(): { id: string; name: string } {
    const route = activeRoute ?? lastVisibleRoute;
    if (!route) return { id: "origin", name: "origin" };
    return { id: route.threadId, name: route.threadId === "origin" ? "origin" : route.threadName };
  }

  function overrideStatusText(): string | undefined {
    const current = currentLogicalThread();
    const threadLabel = current.id === "origin" ? "origin" : `temp:${current.name}`;
    return formatManualOverrideStatus(threadPins.get(current.id), threadLabel, pendingNextOverride);
  }

  function ensureTempTreeLabels(ctx: ExtensionContext): void {
    const labels = findMissingTempLabels(
      ctx.sessionManager.getBranch(),
      (entryId) => ctx.sessionManager.getLabel(entryId),
    );
    for (const { entryId, label } of labels) pi.setLabel(entryId, label);
  }

  function showDebugStatus(ctx: ExtensionContext, route: ActiveRoute): void {
    if (config.debug === "off") {
      clearDebugStatus(ctx);
      return;
    }
    const base = formatRouteStatus(route, pi.getThinkingLevel());
    const overrideText = overrideStatusText();
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", overrideText ? `${base} · ${overrideText}` : base));
  }

  function refreshOverrideStatus(ctx: ExtensionContext): void {
    if (config.debug !== "off" && routeClient && lastVisibleRoute) showDebugStatus(ctx, lastVisibleRoute);
    else clearDebugStatus(ctx);
  }

  function pinTier(ctx: ExtensionCommandContext, tier: TierName, scope: "thread" | "next"): void {
    if (scope === "thread") {
      const current = currentLogicalThread();
      threadPins.set(current.id, tier);
      pi.appendEntry(PIN_ENTRY_TYPE, {
        kind: "set",
        threadId: current.id,
        threadName: current.name,
        tier,
        timestamp: new Date().toISOString(),
      } satisfies PinEntryData);
      refreshOverrideStatus(ctx);
      ctx.ui.notify(
        `Pinned ${tier} for ${current.id === "origin" ? "origin" : `temp:${current.name}`}`,
        "info",
      );
      return;
    }
    pendingNextOverride = mergeNextOverride(
      pendingNextOverride,
      { tier },
      pendingNextOverride?.token ?? uuidv7(),
    );
    pi.appendEntry(NEXT_OVERRIDE_ENTRY_TYPE, {
      kind: "set",
      token: pendingNextOverride.token,
      ...(pendingNextOverride.target ? { target: pendingNextOverride.target } : {}),
      ...(pendingNextOverride.tier ? { tier: pendingNextOverride.tier } : {}),
      timestamp: new Date().toISOString(),
    } satisfies NextOverrideEntryData);
    refreshOverrideStatus(ctx);
    ctx.ui.notify(`Pinned ${tier} for the next request`, "info");
  }

  function unpin(ctx: ExtensionCommandContext): void {
    const current = currentLogicalThread();
    let cleared = false;
    if (threadPins.has(current.id)) {
      threadPins.delete(current.id);
      pi.appendEntry(PIN_ENTRY_TYPE, {
        kind: "cleared",
        threadId: current.id,
        timestamp: new Date().toISOString(),
      } satisfies PinEntryData);
      cleared = true;
    }
    if (pendingNextOverride) {
      pi.appendEntry(NEXT_OVERRIDE_ENTRY_TYPE, {
        kind: "resolved",
        token: pendingNextOverride.token,
        outcome: "cleared",
        timestamp: new Date().toISOString(),
      } satisfies NextOverrideEntryData);
      pendingNextOverride = undefined;
      cleared = true;
    }
    refreshOverrideStatus(ctx);
    ctx.ui.notify(
      cleared ? "Cleared the active Switchyard pin(s)" : "No Switchyard pin was active",
      cleared ? "info" : "warning",
    );
  }

  function routeOrigin(ctx: ExtensionCommandContext): void {
    pendingNextOverride = mergeNextOverride(
      pendingNextOverride,
      { target: "origin" },
      pendingNextOverride?.token ?? uuidv7(),
    );
    pi.appendEntry(NEXT_OVERRIDE_ENTRY_TYPE, {
      kind: "set",
      token: pendingNextOverride.token,
      ...(pendingNextOverride.target ? { target: pendingNextOverride.target } : {}),
      ...(pendingNextOverride.tier ? { tier: pendingNextOverride.tier } : {}),
      timestamp: new Date().toISOString(),
    } satisfies NextOverrideEntryData);
    refreshOverrideStatus(ctx);
    ctx.ui.notify("The next request will route to origin", "info");
  }

  function invalidateLifecycle(): void {
    lifecycleGeneration += 1;
    activeLifecycleController?.abort();
    activeLifecycleController = undefined;
  }

  function captureRequestIdentity(ctx: ExtensionContext): RequestIdentity {
    return {
      generation: lifecycleGeneration,
      sessionFile: ctx.sessionManager.getSessionFile(),
      leafId: ctx.sessionManager.getLeafId(),
    };
  }

  function requestIdentityIsCurrent(identity: RequestIdentity, ctx: ExtensionContext): boolean {
    return identity.generation === lifecycleGeneration
      && !runtimeInvalidated
      && ctx.sessionManager.getSessionFile() === identity.sessionFile
      && ctx.sessionManager.getLeafId() === identity.leafId;
  }

  function restoreHeldPromptIfCurrent(identity: RequestIdentity, event: InputEvent, ctx: ExtensionContext): void {
    if (runtimeInvalidated || ctx.sessionManager.getSessionFile() !== identity.sessionFile) return;
    const sameLogicalPlace = identity.generation === lifecycleGeneration
      || ctx.sessionManager.getLeafId() === identity.leafId;
    if (!sameLogicalPlace) return;
    ctx.ui.setEditorText(event.text);
    const imageNote = event.images?.length
      ? ` Reattach ${event.images.length} image(s) before resubmitting.`
      : "";
    ctx.ui.notify(`The pending message was cancelled because the session context changed.${imageNote}`, "warning");
  }

  async function summarizeTempForLifecycle(
    thread: TempThread,
    ctx: ExtensionContext,
  ): Promise<
    | { action: "summary"; result: OriginSummaryResult }
    | { action: "cancelled"; stale: boolean }
    | { action: "error"; error: unknown }
  > {
    const generation = ++lifecycleGeneration;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const leafId = ctx.sessionManager.getLeafId();
    const controller = new AbortController();
    activeLifecycleController = controller;
    const request: OriginSummaryRequest = {
      scope: { kind: "temp", threadId: thread.id, threadName: thread.name },
      messages: threadContextFromEntries(ctx.sessionManager.getBranch(), thread),
      previousSummary: undefined,
      customInstructions: undefined,
    };

    try {
      let outcome:
        | { action: "summary"; result: OriginSummaryResult }
        | { action: "error"; error: unknown }
        | undefined;
      if (ctx.mode === "tui") {
        outcome = await ctx.ui.custom((tui, theme, _keybindings, done) => {
          const loader = new BorderedLoader(tui, theme, `Summarizing temp:${thread.name}…`);
          loader.onAbort = () => {
            controller.abort();
            done(undefined);
          };
          summarizeThreadWithPi(request, ctx, controller.signal)
            .then((result) => done({ action: "summary", result }))
            .catch((error) => done({ action: "error", error }));
          return loader;
        });
      } else {
        try {
          outcome = {
            action: "summary",
            result: await summarizeThreadWithPi(request, ctx, controller.signal),
          };
        } catch (error) {
          outcome = { action: "error", error };
        }
      }

      const stale = generation !== lifecycleGeneration
        || runtimeInvalidated
        || (generation === lifecycleGeneration
          && (ctx.sessionManager.getSessionFile() !== sessionFile || ctx.sessionManager.getLeafId() !== leafId));
      if (stale || controller.signal.aborted || !outcome) return { action: "cancelled", stale };
      return outcome;
    } finally {
      if (activeLifecycleController === controller) activeLifecycleController = undefined;
    }
  }

  async function requestRouteDecision(
    prompt: string,
    hasImages: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof decideRoute>>> {
    if (!routeClient || !config.enabled || !isConfigured(config)) return undefined;
    const sessionMessages = getSessionMessages(ctx);
    return decideRoute(routeClient, {
      prompt,
      hasImages,
      originContext: getOriginContext(sessionMessages, config.routerContextMessages),
      threads: [...threads.values()],
      config,
      ...(signal ? { signal } : {}),
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
  }

  function restorePromotionAfterCancellation(payload: PendingPromotion, ctx: ExtensionCommandContext): void {
    threads.set(payload.thread.id, payload.thread);
    pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
      kind: "thread-created",
      thread: payload.thread,
    } satisfies RouterSessionEntryData);
    pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
      kind: "promotion-completed",
      token: payload.token,
      outcome: "cancelled",
      timestamp: new Date().toISOString(),
    } satisfies RouterSessionEntryData);
    ctx.ui.setEditorText(payload.prompt);
    ctx.ui.notify("Promotion cancelled; the pending message was restored to the editor", "info");
  }

  async function promotePending(ctx: ExtensionCommandContext, token: string): Promise<void> {
    const payload = pendingPromotions.get(token);
    if (!payload) {
      ctx.ui.notify("The pending temp-thread promotion is no longer available", "error");
      return;
    }
    pendingPromotions.delete(token);
    threads.delete(payload.thread.id);
    lastVisibleRoute = undefined;
    pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
      kind: "promotion-pending",
      token: payload.token,
      thread: payload.thread,
      pendingPrompt: payload.prompt,
      pendingImageCount: payload.images?.length ?? 0,
      timestamp: new Date().toISOString(),
    } satisfies RouterSessionEntryData);
    pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
      kind: "lifecycle-completed",
      token: payload.lifecycleToken,
      timestamp: new Date().toISOString(),
    } satisfies RouterSessionEntryData);
    pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
      kind: "thread-retired",
      threadId: payload.thread.id,
      threadName: payload.thread.name,
      reason: "promoted",
      timestamp: new Date().toISOString(),
    } satisfies RouterSessionEntryData);

    let replacementStarted = false;
    try {
      const result = await ctx.newSession({
        ...(payload.parentSession ? { parentSession: payload.parentSession } : {}),
        setup: async (sessionManager) => {
          for (const message of payload.messages) {
            sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
          }
          sessionManager.appendSessionInfo(`Promoted: ${payload.thread.name}`);
          sessionManager.appendCustomEntry(SWITCHYARD_ENTRY_TYPE, {
            kind: "promoted-session",
            token: payload.token,
            ...(payload.parentSession ? { sourceSession: payload.parentSession } : {}),
            ...(payload.sourceEntryId ? { sourceEntryId: payload.sourceEntryId } : {}),
            sourceThreadId: payload.thread.id,
            sourceThreadName: payload.thread.name,
            pendingPrompt: payload.prompt,
            pendingImageCount: payload.images?.length ?? 0,
          } satisfies RouterSessionEntryData);
        },
        withSession: async (newContext) => {
          replacementStarted = true;
          const childSession = newContext.sessionManager.getSessionFile();
          if (payload.parentSession && childSession && existsSync(childSession)) {
            try {
              SessionManager.open(payload.parentSession).appendCustomEntry(SWITCHYARD_ENTRY_TYPE, {
                kind: "promotion-completed",
                token: payload.token,
                ...(childSession ? { childSession } : {}),
                outcome: "completed",
                timestamp: new Date().toISOString(),
              } satisfies RouterSessionEntryData);
            } catch {
              // The child is already valid; leaving the durable pending marker lets the source recover safely.
            }
          }
          try {
            await newContext.sendUserMessage([
              { type: "text", text: payload.prompt },
              ...(payload.images ?? []),
            ], { expandPromptTemplates: true });
          } catch (error) {
            newContext.ui.setEditorText(payload.prompt);
            const imageNote = payload.images?.length
              ? ` Reattach ${payload.images.length} image(s) before resubmitting.`
              : "";
            newContext.ui.notify(
              `The child session was created, but its pending message could not be submitted: ${error instanceof Error ? error.message : String(error)}.${imageNote}`,
              "error",
            );
          }
        },
      });
      if (result.cancelled) restorePromotionAfterCancellation(payload, ctx);
    } catch (error) {
      if (!replacementStarted && !runtimeInvalidated) {
        restorePromotionAfterCancellation(payload, ctx);
        ctx.ui.notify(
          `Could not promote temp:${payload.thread.name}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }
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

  function buildInspectSnapshot(ctx: ExtensionContext): InspectSnapshot {
    const branch = ctx.sessionManager.getBranch();
    const descriptors: Array<{ id: string; name: string; thread?: TempThread }> = [
      { id: "origin", name: "origin" },
      ...[...threads.values()].map((thread) => ({ id: thread.id, name: `temp:${thread.name}`, thread })),
    ];
    const inspectedThreads: ThreadInspection[] = descriptors.map(({ id, name, thread }) => {
      const incumbentRoute = findLastRouteForThread(branch, id);
      const usages = incumbentRoute
        ? findCurrentModelEpochUsage(branch, id, incumbentRoute.provider, incumbentRoute.modelId, 20)
        : [];
      const routeHistory = findRouteAuditHistoryForThread(branch, id);
      const reset = getCacheResetOpportunity(branch, id);
      const messages = threadMessagesForSwitching(ctx, id, thread);
      const contextTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
      const pinnedTier = threadPins.get(id);
      return {
        id,
        name,
        active: lastVisibleRoute?.threadId === id,
        ...(incumbentRoute
          ? {
              incumbent: {
                tier: incumbentRoute.tier,
                provider: incumbentRoute.provider,
                modelId: incumbentRoute.modelId,
                thinking: incumbentRoute.thinking,
              },
            }
          : {}),
        contextTokens,
        ...(incumbentRoute ? { cacheUsage: summarizeCacheUsage(usages) } : {}),
        ...(reset ? { resetOpportunity: { reason: reset.reason } } : {}),
        recentRoutes: summarizeRouteHistory(routeHistory),
        ...(routeHistory.at(-1)?.audit ? { latestAudit: routeHistory.at(-1)!.audit } : {}),
        ...(pinnedTier ? { pinnedTier } : {}),
      };
    });
    const pricing = TIER_NAMES.flatMap((tier) => {
      const tierConfig = config.tiers[tier];
      if (!tierConfig) return [];
      return [resolveModelPricing(
        { provider: tierConfig.provider, modelId: tierConfig.modelId },
        ctx.modelRegistry.find(tierConfig.provider, tierConfig.modelId),
        config.switching.economics,
      )];
    });
    return {
      generatedAt: new Date().toISOString(),
      threads: inspectedThreads,
      pricing,
      ...(pendingNextOverride
        ? {
            nextOverride: {
              ...(pendingNextOverride.target ? { target: pendingNextOverride.target } : {}),
              ...(pendingNextOverride.tier ? { tier: pendingNextOverride.tier } : {}),
            },
          }
        : {}),
    };
  }

  async function inspect(ctx: ExtensionCommandContext): Promise<void> {
    const report = formatInspectReport(buildInspectSnapshot(ctx));
    if (ctx.mode === "tui") {
      await ctx.ui.editor("Switchyard Inspect (read-only; edits are discarded)", report);
    } else {
      ctx.ui.notify(report, "info");
    }
  }

  registerConfigurationCommand(pi, {
    getConfig: () => config,
    reloadConfig: (ctx) => {
      config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    },
    onDebugChanged: (ctx) => {
      if (config.enabled && config.debug !== "off" && routeClient && lastVisibleRoute) {
        showDebugStatus(ctx, lastVisibleRoute);
      } else {
        clearDebugStatus(ctx);
      }
    },
    inspect,
    promotePending,
    getCurrentThread: () => currentLogicalThread(),
    getManualOverrideSummary: () => overrideStatusText(),
    pinTier,
    unpin,
    routeOrigin,
  });

  pi.on("session_start", (_event, ctx) => {
    runtimeInvalidated = false;
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    restoreBranchState(ctx);
    ensureTempTreeLabels(ctx);
    if (recoverableLifecycle && ctx.hasUI) {
      ctx.ui.setEditorText(recoverableLifecycle.prompt);
      const imageNote = recoverableLifecycle.imageCount > 0
        ? ` Reattach ${recoverableLifecycle.imageCount} image(s) before resubmitting.`
        : "";
      ctx.ui.notify(`Recovered a message from an interrupted temp-thread lifecycle action.${imageNote}`, "warning");
    } else if (recoverablePromotion && ctx.hasUI) {
      ctx.ui.setEditorText(recoverablePromotion.prompt);
      const imageNote = recoverablePromotion.imageCount > 0
        ? ` Reattach ${recoverablePromotion.imageCount} image(s) before resubmitting.`
        : "";
      ctx.ui.notify(`Recovered a message from an interrupted temp-thread promotion.${imageNote}`, "warning");
    } else if (forcePromotedPrompt && ctx.hasUI) {
      ctx.ui.setEditorText(forcePromotedPrompt.prompt);
      const imageNote = forcePromotedPrompt.imageCount > 0
        ? ` Reattach ${forcePromotedPrompt.imageCount} image(s) before resubmitting.`
        : "";
      ctx.ui.notify(`Recovered an unsubmitted message in this promoted child session.${imageNote}`, "warning");
    }
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
      if (lastVisibleRoute && config.debug !== "off") showDebugStatus(ctx, lastVisibleRoute);
      else clearDebugStatus(ctx);
    } catch {
      routeClient = undefined;
      clearDebugStatus(ctx);
    }
  });

  pi.on("session_before_switch", () => {
    invalidateLifecycle();
  });

  pi.on("session_before_fork", () => {
    invalidateLifecycle();
  });

  pi.on("session_before_tree", async (event, ctx) => {
    invalidateLifecycle();
    const outcome = await summarizeOriginBranch(
      {
        entriesToSummarize: event.preparation.entriesToSummarize,
        userWantsSummary: event.preparation.userWantsSummary,
        customInstructions: event.preparation.customInstructions,
        replaceInstructions: event.preparation.replaceInstructions,
      },
      (request) => summarizeThreadWithPi(request, ctx, event.signal),
    );
    if (outcome.action === "default") return;
    if (outcome.action === "cancel") {
      if (!event.signal.aborted) {
        ctx.ui.notify(`Origin-only tree summary cancelled: ${outcome.reason}`, "error");
      }
      return { cancel: true };
    }
    if (config.debug === "verbose") {
      ctx.ui.notify(
        `Origin-only tree summary excluded ${outcome.summary.details.switchyard.excludedTempMessages} temp message(s)`,
        "info",
      );
    }
    return { summary: outcome.summary };
  });

  pi.on("session_tree", (_event, ctx) => {
    setOriginContextToolEnabled(false);
    restoreBranchState(ctx);
    ensureTempTreeLabels(ctx);
    if (config.debug !== "off" && routeClient && lastVisibleRoute) showDebugStatus(ctx, lastVisibleRoute);
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
    if (config.debug === "verbose") {
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

  async function handleInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
    if (event.source === "extension" || event.streamingBehavior) {
      pendingRouteDecision = undefined;
      return { action: "continue" as const };
    }
    if (recoverableLifecycle) {
      pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
        kind: "lifecycle-completed",
        token: recoverableLifecycle.token,
        timestamp: new Date().toISOString(),
      } satisfies RouterSessionEntryData);
      recoverableLifecycle = undefined;
    }
    if (recoverablePromotion) {
      pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
        kind: "thread-created",
        thread: recoverablePromotion.thread,
      } satisfies RouterSessionEntryData);
      pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
        kind: "promotion-completed",
        token: recoverablePromotion.token,
        outcome: "cancelled",
        timestamp: new Date().toISOString(),
      } satisfies RouterSessionEntryData);
      recoverablePromotion = undefined;
    }

    if (!routeClient || !config.enabled || !isConfigured(config)) return { action: "continue" as const };

    const identity = captureRequestIdentity(ctx);
    const hasImages = (event.images?.length ?? 0) > 0;
    const routeController = new AbortController();
    activeLifecycleController = routeController;
    let decision: Awaited<ReturnType<typeof decideRoute>>;
    try {
      decision = await requestRouteDecision(event.text, hasImages, ctx, routeController.signal);
    } finally {
      if (activeLifecycleController === routeController) activeLifecycleController = undefined;
    }
    if (!requestIdentityIsCurrent(identity, ctx) || routeController.signal.aborted) {
      pendingRouteDecision = undefined;
      restoreHeldPromptIfCurrent(identity, event, ctx);
      return { action: "handled" as const };
    }
    if (decision) {
      const targetOverride = applyTargetOverride(decision.target, pendingNextOverride);
      if (targetOverride.overridden) decision = { ...decision, target: targetOverride.target };
    }
    pendingRouteDecision = {
      requestId: uuidv7(),
      prompt: event.text,
      imageFingerprint: fingerprintImages(event.images),
      decision,
    };
    if (!decision) return { action: "continue" as const };

    if (decision.target === "origin" || decision.target === "new_temp_from_origin") {
      return { action: "continue" as const };
    }
    const targetThread = threads.get(decision.target);
    if (!targetThread) return { action: "continue" as const };
    const budget = projectTempThreadBudget(
      ctx.sessionManager.getBranch(),
      targetThread,
      event.text,
      event.images,
      config,
    );
    if (!budget.exceeded || !ctx.hasUI) return { action: "continue" as const };

    const lifecycleToken = uuidv7().replaceAll("-", "");
    pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
      kind: "lifecycle-pending",
      token: lifecycleToken,
      pendingPrompt: event.text,
      pendingImageCount: event.images?.length ?? 0,
      timestamp: new Date().toISOString(),
    } satisfies RouterSessionEntryData);

    const selectionIdentity = captureRequestIdentity(ctx);
    const reasons = [
      budget.tokenLimitExceeded ? `${budget.tokens.toLocaleString()} estimated tokens` : undefined,
      budget.turnLimitExceeded ? `${budget.turns} user turns` : undefined,
    ].filter((value): value is string => value !== undefined).join(" and ");
    const canPromote = ctx.sessionManager.getSessionFile() !== undefined && ctx.model !== undefined;
    const choices = [
      ...(canPromote ? ["Promote to a child session"] : []),
      "Summarize into origin",
      "Cancel and restore the message",
    ];
    const choice = await ctx.ui.select(
      `Temp thread “${targetThread.name}” is getting long (${reasons}). What do you want to do?`,
      choices,
    );
    if (!requestIdentityIsCurrent(selectionIdentity, ctx)) {
      pendingRouteDecision = undefined;
      restoreHeldPromptIfCurrent(selectionIdentity, event, ctx);
      return { action: "handled" as const };
    }

    if (!choice || choice === "Cancel and restore the message") {
      pendingRouteDecision = undefined;
      ctx.ui.setEditorText(event.text);
      const imageNote = hasImages ? ` Reattach ${event.images?.length ?? 0} image(s) before resubmitting.` : "";
      ctx.ui.notify(`Pending message restored to the editor.${imageNote}`, "info");
      return { action: "handled" as const };
    }

    if (choice === "Promote to a child session") {
      const token = uuidv7().replaceAll("-", "");
      const branch = ctx.sessionManager.getBranch();
      const parentSession = ctx.sessionManager.getSessionFile();
      const sourceEntryId = findThreadBranchPoint(branch, targetThread.id);
      pendingPromotions.set(token, {
        token,
        lifecycleToken,
        prompt: event.text,
        ...(event.images ? { images: [...event.images] } : {}),
        thread: { ...targetThread, seedContext: [...targetThread.seedContext] },
        messages: ensurePromotionMessagesDurable(
          messagesForPromotedSession(branch, targetThread),
          ctx.model!,
        ),
        ...(parentSession !== undefined ? { parentSession } : {}),
        ...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
      });
      pendingRouteDecision = undefined;
      ctx.ui.setEditorText(event.text);
      setTimeout(() => {
        try {
          pi.sendUserMessage(`/switchyard __promote ${token}`, { expandPromptTemplates: true });
        } catch {
          pendingPromotions.delete(token);
        }
      }, 0);
      return { action: "handled" as const };
    }

    try {
      const summaryOutcome = await summarizeTempForLifecycle(targetThread, ctx);
      if (summaryOutcome.action === "cancelled") {
        pendingRouteDecision = undefined;
        if (!summaryOutcome.stale) {
          ctx.ui.setEditorText(event.text);
          ctx.ui.notify("Temp-thread summarization cancelled; the pending message was restored", "info");
        }
        return { action: "handled" as const };
      }
      if (summaryOutcome.action === "error") throw summaryOutcome.error;
      const summary = summaryOutcome.result;
      const handoffOperationId = uuidv7();
      pi.sendMessage({
        customType: "switchyard-handoff",
        content: formatTempThreadHandoff(targetThread, summary.summary),
        display: true,
        details: {
          switchyardHandoff: {
            operationId: handoffOperationId,
            sourceThreadId: targetThread.id,
            sourceThreadName: targetThread.name,
            usage: summary.usage,
          },
        },
      });
      const handoffPersisted = ctx.sessionManager.getBranch().some((entry) =>
        entry.type === "custom_message"
        && entry.customType === "switchyard-handoff"
        && entry.details
        && typeof entry.details === "object"
        && (entry.details as Record<string, unknown>).switchyardHandoff
        && typeof (entry.details as Record<string, unknown>).switchyardHandoff === "object"
        && ((entry.details as Record<string, unknown>).switchyardHandoff as Record<string, unknown>).operationId
          === handoffOperationId);
      if (!handoffPersisted) {
        throw new Error("The origin handoff could not be persisted");
      }
      pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
        kind: "lifecycle-completed",
        token: lifecycleToken,
        timestamp: new Date().toISOString(),
      } satisfies RouterSessionEntryData);
      threads.delete(targetThread.id);
      lastVisibleRoute = undefined;
      pendingRouteDecision = undefined;
      originFallbackForNext = true;
      pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
        kind: "thread-retired",
        threadId: targetThread.id,
        threadName: targetThread.name,
        reason: "summarized-to-origin",
        timestamp: new Date().toISOString(),
      } satisfies RouterSessionEntryData);
      return handleInput(event, ctx);
    } catch (error) {
      pendingRouteDecision = undefined;
      ctx.ui.setEditorText(event.text);
      ctx.ui.notify(
        `Could not complete the handoff for temp:${targetThread.name}; the pending message was restored: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return { action: "handled" as const };
    }
  }

  pi.on("input", handleInput);

  pi.on("before_agent_start", async (event, ctx) => {
    const hasImages = (event.images?.length ?? 0) > 0;
    const preflight = pendingRouteDecision;
    pendingRouteDecision = undefined;
    if (pendingThreadCreated && !routeMetadataPersisted) threads.delete(pendingThreadCreated.id);
    activeRoute = undefined;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    pendingTransitionAudit = undefined;
    routeMetadataPersisted = false;
    appliedNextOverrideToken = undefined;

    if (!routeClient || !config.enabled || !isConfigured(config)) {
      clearDebugStatus(ctx);
      return;
    }

    const sessionMessages = getSessionMessages(ctx);
    let decision = preflight
      ? preflight.decision
      : await requestRouteDecision(event.prompt, hasImages, ctx);
    if (
      decision
      && preflight
      && (preflight.prompt !== event.prompt
        || preflight.imageFingerprint !== fingerprintImages(event.images))
    ) {
      // Pi expands skills/templates and later input handlers may transform text/images after our input hook.
      // The transformed request has not passed a temp budget check, so keep it in origin.
      decision = { ...decision, target: "origin" };
    }
    const promotedPrompt = forcePromotedPrompt
      ?? findPendingPromotedPrompt(ctx.sessionManager.getBranch());
    const forceOrigin = promotedPrompt !== undefined;
    if (promotedPrompt) {
      pendingPromotedToConsume = { token: promotedPrompt.token, prompt: promotedPrompt.prompt };
      forcePromotedPrompt = undefined;
    }
    if (decision && forceOrigin) decision = { ...decision, target: "origin" };

    if (decision) {
      const targetOverride = applyTargetOverride(decision.target, pendingNextOverride);
      if (targetOverride.overridden) {
        decision = { ...decision, target: targetOverride.target };
        appliedNextOverrideToken = pendingNextOverride?.token;
      }
    }

    // Jev unavailable, timed out, or returned an unusable answer: Pi proceeds untouched.
    if (!decision) {
      clearDebugStatus(ctx);
      return;
    }

    // Manual target/tier overrides are applied before model resolution and the deterministic
    // transition policy: a next-request override beats a thread pin, which beats Jev's tier.
    // The provisional thread id equals decision.target for origin/existing temps; a brand-new
    // temp thread has no id yet and therefore cannot already carry a pin.
    const provisionalThreadId = decision.target === "new_temp_from_origin" ? undefined : decision.target;
    let tierOverride = applyTierOverride(decision.tier, provisionalThreadId, pendingNextOverride, threadPins);
    if (tierOverride.source === "next-override") appliedNextOverrideToken = pendingNextOverride?.token;

    let resolved = resolveTierModel(ctx, config, tierOverride.tier, hasImages);
    if (!resolved && tierOverride.source !== "jev") {
      if (tierOverride.source === "thread-pin" && provisionalThreadId) {
        threadPins.delete(provisionalThreadId);
        pi.appendEntry(PIN_ENTRY_TYPE, {
          kind: "cleared",
          threadId: provisionalThreadId,
          timestamp: new Date().toISOString(),
        } satisfies PinEntryData);
        ctx.ui.notify(`Cleared invalid ${tierOverride.tier} pin; using Jev's tier for this request`, "warning");
      } else {
        ctx.ui.notify(`The next-request ${tierOverride.tier} pin is unavailable; using Jev's tier while preserving its target override`, "warning");
      }
      tierOverride = { tier: decision.tier, source: "jev" };
      resolved = resolveTierModel(ctx, config, decision.tier, hasImages);
    }
    if (!resolved) {
      if (pendingNextOverride && appliedNextOverrideToken === pendingNextOverride.token) {
        pi.appendEntry(NEXT_OVERRIDE_ENTRY_TYPE, {
          kind: "resolved",
          token: pendingNextOverride.token,
          outcome: "cleared",
          timestamp: new Date().toISOString(),
        } satisfies NextOverrideEntryData);
        pendingNextOverride = undefined;
        appliedNextOverrideToken = undefined;
        ctx.ui.notify("Cleared an unusable next-request override because no valid fallback model was available", "warning");
      }
      clearDebugStatus(ctx);
      return;
    }

    let targetThread: TempThread | undefined;
    if (decision.target === "new_temp_from_origin") {
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

    const targetThreadId = targetThread?.id ?? "origin";
    const candidate: RoutedModel = {
      tier: resolved.tier,
      model: resolved.model,
      tierConfig: resolved.tierConfig,
    };
    const transitionCandidates = resolveTransitionCandidates(ctx, config, hasImages);
    const currentRecommendation = acceptTierRecommendation(
      preflight?.requestId ?? uuidv7(),
      decision,
      resolved.tier,
    );
    const activeToolNames = new Set(pi.getActiveTools());
    if (targetThreadId !== "origin") activeToolNames.add(ORIGIN_CONTEXT_TOOL);
    const providerVisibleTools = pi.getAllTools()
      .filter((tool) => activeToolNames.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    const providerOverheadTokens = Math.ceil(
      (event.systemPrompt.length + JSON.stringify(providerVisibleTools).length) / 4,
    );
    const manualTierOverrideActive = tierOverride.source !== "jev";
    const manualOverrideIncumbent = manualTierOverrideActive
      ? resolveThreadIncumbent(ctx, targetThreadId, hasImages)
      : undefined;
    const switchDecision: ModelTransitionDecision = manualTierOverrideActive
      ? {
          selection: "candidate",
          selected: candidate,
          requested: candidate,
          ...(manualOverrideIncumbent ? { incumbent: manualOverrideIncumbent } : {}),
          reason: tierOverride.source === "next-override" ? "manual-override-next" : "manual-override-thread-pin",
        }
      : evaluateThreadModelSwitch(
          ctx,
          targetThreadId,
          targetThread,
          candidate,
          transitionCandidates,
          currentRecommendation,
          event.prompt,
          event.images?.length ?? 0,
          providerOverheadTokens,
          config,
        );
    const selectedModel = switchDecision.selected;

    const modelSet = await pi.setModel(selectedModel.model);
    if (!modelSet) {
      if (pendingThreadCreated) threads.delete(pendingThreadCreated.id);
      pendingThreadCreated = undefined;
      clearDebugStatus(ctx);
      return;
    }
    if (selectedModel.tierConfig.thinking !== "default") {
      pi.setThinkingLevel(selectedModel.tierConfig.thinking);
    }
    const effectiveThinking = pi.getThinkingLevel();

    activeRoute = {
      threadId: targetThreadId,
      threadName: targetThread?.name ?? "origin",
      tier: selectedModel.tier,
      provider: selectedModel.tierConfig.provider,
      modelId: selectedModel.tierConfig.modelId,
      thinking: effectiveThinking,
      decision: {
        ...decision,
        requestId: currentRecommendation.requestId,
        tier: currentRecommendation.tier,
        tierProbabilities: currentRecommendation.tierProbabilities,
      },
    };
    originFallbackForNext = false;
    lastVisibleRoute = activeRoute;
    pendingRoutePrompt = event.prompt;
    pendingTransitionAudit = buildTransitionAudit(switchDecision);
    setOriginContextToolEnabled(activeRoute.threadId !== "origin");
    showDebugStatus(ctx, activeRoute);
    const thread = activeRoute.threadId === "origin" ? "origin" : `temp:${activeRoute.threadName}`;
    if (config.debug === "minimal") {
      ctx.ui.notify(formatMinimalSwitchDecision(switchDecision, candidate, thread), "info");
    } else if (config.debug === "verbose") {
      ctx.ui.notify(formatVerboseSwitchDecision(switchDecision, candidate, {
        thread,
        targetConfidence: activeRoute.decision.targetConfidence,
        tierConfidence: activeRoute.decision.tierConfidence,
        config: config.switching,
      }), "info");
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
    if (!activeRoute) {
      if (originFallbackForNext) return { messages: filterMessagesForOrigin(event.messages) };
      return;
    }
    if (activeRoute.threadId === "origin") {
      return { messages: filterMessagesForOrigin(event.messages) };
    }
    const thread = threads.get(activeRoute.threadId);
    if (!thread) return;
    return { messages: threadContextFromEntries(ctx.sessionManager.getBranch(), thread) };
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (pendingPromotedToConsume) {
      pi.appendEntry(SWITCHYARD_ENTRY_TYPE, {
        kind: "promotion-consumed",
        token: pendingPromotedToConsume.token,
        pendingPrompt: pendingPromotedToConsume.prompt,
        timestamp: new Date().toISOString(),
      } satisfies RouterSessionEntryData);
      pendingPromotedToConsume = undefined;
    }
    if (routeMetadataPersisted || !activeRoute || !pendingRoutePrompt) return;
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
      ...(pendingTransitionAudit ? { audit: pendingTransitionAudit } : {}),
    } satisfies RouterSessionEntryData);
    routeMetadataPersisted = true;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    pendingTransitionAudit = undefined;
  });

  pi.on("agent_settled", (_event, ctx) => {
    ensureTempTreeLabels(ctx);
    setOriginContextToolEnabled(false);
    if (pendingThreadCreated && !routeMetadataPersisted) threads.delete(pendingThreadCreated.id);
    activeRoute = undefined;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    pendingTransitionAudit = undefined;
    pendingRouteDecision = undefined;
    originFallbackForNext = false;
    routeMetadataPersisted = false;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    runtimeInvalidated = true;
    invalidateLifecycle();
    setOriginContextToolEnabled(false);
    if (pendingThreadCreated && !routeMetadataPersisted) threads.delete(pendingThreadCreated.id);
    activeRoute = undefined;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    pendingTransitionAudit = undefined;
    pendingRouteDecision = undefined;
    originFallbackForNext = false;
    routeMetadataPersisted = false;
    routeClient = undefined;
    clearDebugStatus(ctx);
  });
}
