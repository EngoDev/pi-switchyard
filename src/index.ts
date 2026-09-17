import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolveTypeSafeApiKey } from "./auth.js";
import { isConfigured, loadConfig } from "./config.js";
import { registerConfigurationCommand } from "./configuration-ui.js";
import { decideRoute, type RouteClient } from "./router.js";
import {
  formatParentContextResult,
  PARENT_CONTEXT_ROLES,
  selectParentContext,
} from "./parent-context.js";
import {
  createTempThread,
  filterMessagesForParent,
  filterMessagesForThread,
  getParentContext,
  messagesFromEntries,
  restoreThreads,
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

const ROUTER_ENTRY_TYPE = "jev-router";
const STATUS_KEY = "jev-router";
const PARENT_CONTEXT_TOOL = "get_context_from_parent";
const CAPABILITY_ORDER: TierName[] = ["cheap", "handy", "smart", "genius"];

function toRouteClient(client: TypeSafeClient): RouteClient {
  return {
    systemOne: async (request, options) => {
      return (await client.systemOne(request as never, options)) as never;
    },
  };
}

function findLastRoute(entries: readonly SessionEntry[]): ActiveRoute | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== ROUTER_ENTRY_TYPE) continue;
    const data = entry.data as RouterSessionEntryData | undefined;
    if (data?.kind === "route") return data.route;
  }
  return undefined;
}

export function formatRouteStatus(route: ActiveRoute, effectiveThinking: ThinkingLevel): string {
  const thread = route.threadId === "parent" ? "parent" : `temp:${route.threadName}`;
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

export default function jevRouterExtension(pi: ExtensionAPI): void {
  let config: RouterConfig;
  let routeClient: RouteClient | undefined;
  let threads = new Map<string, TempThread>();
  let activeRoute: ActiveRoute | undefined;
  let lastVisibleRoute: ActiveRoute | undefined;
  let pendingThreadCreated: TempThread | undefined;
  let pendingRoutePrompt: string | undefined;
  let routeMetadataPersisted = false;

  function setParentContextToolEnabled(enabled: boolean): void {
    const active = pi.getActiveTools();
    const isActive = active.includes(PARENT_CONTEXT_TOOL);
    if (enabled && !isActive) pi.setActiveTools([...active, PARENT_CONTEXT_TOOL]);
    if (!enabled && isActive) pi.setActiveTools(active.filter((name) => name !== PARENT_CONTEXT_TOOL));
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

  function showDebugStatus(ctx: ExtensionContext, route: ActiveRoute): void {
    if (!config.debug) {
      clearDebugStatus(ctx);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", formatRouteStatus(route, pi.getThinkingLevel())));
  }

  pi.registerTool({
    name: PARENT_CONTEXT_TOOL,
    label: "Get Context From Parent",
    description: "Retrieve a bounded, filtered slice of messages from the parent logical session. Available only in Jev-routed temp threads. Results are limited to 20 messages and 50KB.",
    promptSnippet: "Retrieve additional context from the parent session when the temp thread's initial snapshot is insufficient",
    promptGuidelines: [
      "Use get_context_from_parent only when the current temp thread needs specific parent-session information that is absent from its initial snapshot.",
      "Prefer a narrow query and small limit when using get_context_from_parent.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Case-insensitive text filter" })),
      roles: Type.Optional(Type.Array(StringEnum(PARENT_CONTEXT_ROLES))),
      offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
      order: Type.Optional(StringEnum(["newest", "oldest"] as const, { default: "newest" })),
      includeToolResults: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!activeRoute || activeRoute.threadId === "parent") {
        throw new Error("get_context_from_parent is only available inside a routed temp thread");
      }
      const items = selectParentContext(getSessionMessages(ctx), params);
      const raw = formatParentContextResult(items);
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
    routeClient = undefined;
    setParentContextToolEnabled(false);

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
    setParentContextToolEnabled(false);
    restoreBranchState(ctx);
    if (config.debug && routeClient && lastVisibleRoute) showDebugStatus(ctx, lastVisibleRoute);
    else clearDebugStatus(ctx);
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
      parentContext: getParentContext(sessionMessages, config.routerContextMessages),
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
        getParentContext(sessionMessages, config.initialParentMessages),
        [...threads.values()].map((thread) => thread.name),
      );
      pendingThreadCreated = targetThread;
      threads.set(targetThread.id, targetThread);
    } else if (decision.target !== "parent") {
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
      threadId: targetThread?.id ?? "parent",
      threadName: targetThread?.name ?? "parent",
      tier: resolved.tier,
      provider: resolved.tierConfig.provider,
      modelId: resolved.tierConfig.modelId,
      thinking: resolved.tierConfig.thinking,
      decision: { ...decision, tier: resolved.tier },
    };
    lastVisibleRoute = activeRoute;
    pendingRoutePrompt = event.prompt;
    setParentContextToolEnabled(activeRoute.threadId !== "parent");
    showDebugStatus(ctx, activeRoute);
    if (config.debug) {
      const thread = activeRoute.threadId === "parent" ? "parent" : `temp:${activeRoute.threadName}`;
      ctx.ui.notify(
        `Jev route → ${thread} | ${activeRoute.tier} | ${activeRoute.provider}/${activeRoute.modelId} | thinking:${pi.getThinkingLevel()} | confidence target:${activeRoute.decision.targetConfidence.toFixed(2)} tier:${activeRoute.decision.tierConfidence.toFixed(2)}`,
        "info",
      );
    }
  });

  pi.on("message_end", (event) => {
    if (!activeRoute || activeRoute.threadId === "parent") return;
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
        ? { details: { ...existingDetails, jevRouter: metadata } }
        : {}),
      jevRouter: metadata,
    };
    const thread = threads.get(activeRoute.threadId);
    if (thread) updateThreadFromMessage(thread, event.message);
    return { message: tagged };
  });

  pi.on("context", (event) => {
    if (!activeRoute) return;
    if (activeRoute.threadId === "parent") {
      return { messages: filterMessagesForParent(event.messages) };
    }
    const thread = threads.get(activeRoute.threadId);
    if (!thread) return;
    return { messages: filterMessagesForThread(event.messages, thread) };
  });

  pi.on("turn_start", (_event, ctx) => {
    if (routeMetadataPersisted || !activeRoute || !pendingRoutePrompt) return;
    const leafId = ctx.sessionManager.getLeafId();
    const leaf = leafId ? ctx.sessionManager.getEntry(leafId) : undefined;
    if (activeRoute.threadId !== "parent" && leaf?.type === "message" && leaf.message.role === "user") {
      pi.setLabel(leaf.id, `temp:${activeRoute.threadName}`);
    }
    if (pendingThreadCreated) {
      pi.appendEntry(ROUTER_ENTRY_TYPE, {
        kind: "thread-created",
        thread: pendingThreadCreated,
      } satisfies RouterSessionEntryData);
    }
    pi.appendEntry(ROUTER_ENTRY_TYPE, {
      kind: "route",
      route: activeRoute,
      prompt: pendingRoutePrompt,
      timestamp: new Date().toISOString(),
    } satisfies RouterSessionEntryData);
    routeMetadataPersisted = true;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
  });

  pi.on("agent_settled", () => {
    setParentContextToolEnabled(false);
    if (pendingThreadCreated && !routeMetadataPersisted) threads.delete(pendingThreadCreated.id);
    activeRoute = undefined;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    routeMetadataPersisted = false;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    setParentContextToolEnabled(false);
    if (pendingThreadCreated && !routeMetadataPersisted) threads.delete(pendingThreadCreated.id);
    activeRoute = undefined;
    pendingThreadCreated = undefined;
    pendingRoutePrompt = undefined;
    routeMetadataPersisted = false;
    routeClient = undefined;
    clearDebugStatus(ctx);
  });
}
