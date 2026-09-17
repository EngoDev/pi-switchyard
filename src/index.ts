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

function routeStatus(route: ActiveRoute, effectiveThinking: ThinkingLevel): string {
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
  let needsTreeLabel = false;

  function setParentContextToolEnabled(enabled: boolean): void {
    const active = pi.getActiveTools();
    const isActive = active.includes(PARENT_CONTEXT_TOOL);
    if (enabled && !isActive) pi.setActiveTools([...active, PARENT_CONTEXT_TOOL]);
    if (!enabled && isActive) pi.setActiveTools(active.filter((name) => name !== PARENT_CONTEXT_TOOL));
  }

  function clearDebugStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function showDebugStatus(ctx: ExtensionContext, route: ActiveRoute): void {
    if (!config.debug) {
      clearDebugStatus(ctx);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", routeStatus(route, pi.getThinkingLevel())));
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
    setConfig: (next) => {
      config = next;
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
    config = loadConfig(ctx.cwd);
    threads = restoreThreads(ctx.sessionManager.getEntries());
    activeRoute = undefined;
    lastVisibleRoute = findLastRoute(ctx.sessionManager.getEntries());
    needsTreeLabel = false;
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

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (event.streamingBehavior) return { action: "continue" };

    activeRoute = undefined;
    needsTreeLabel = false;
    if (!routeClient || !config.enabled || !isConfigured(config)) {
      clearDebugStatus(ctx);
      return { action: "continue" };
    }

    const sessionMessages = getSessionMessages(ctx);
    const decision = await decideRoute(routeClient, {
      prompt: event.text,
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
      return { action: "continue" };
    }

    const resolved = resolveTierModel(ctx, config, decision.tier, (event.images?.length ?? 0) > 0);
    if (!resolved) {
      clearDebugStatus(ctx);
      return { action: "continue" };
    }

    let targetThread: TempThread | undefined;
    if (decision.target === "new_temp") {
      targetThread = createTempThread(
        event.text,
        getParentContext(sessionMessages, config.initialParentMessages),
        [...threads.values()].map((thread) => thread.name),
      );
    } else if (decision.target !== "parent") {
      targetThread = threads.get(decision.target);
      if (!targetThread) {
        clearDebugStatus(ctx);
        return { action: "continue" };
      }
    }

    const modelSet = await pi.setModel(resolved.model);
    if (!modelSet) {
      clearDebugStatus(ctx);
      return { action: "continue" };
    }
    if (resolved.tierConfig.thinking !== "default") {
      pi.setThinkingLevel(resolved.tierConfig.thinking);
    }

    if (targetThread && !threads.has(targetThread.id)) {
      threads.set(targetThread.id, targetThread);
      pi.appendEntry(ROUTER_ENTRY_TYPE, {
        kind: "thread-created",
        thread: targetThread,
      } satisfies RouterSessionEntryData);
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
    needsTreeLabel = activeRoute.threadId !== "parent";
    setParentContextToolEnabled(activeRoute.threadId !== "parent");
    pi.appendEntry(ROUTER_ENTRY_TYPE, {
      kind: "route",
      route: activeRoute,
      prompt: event.text,
      timestamp: new Date().toISOString(),
    } satisfies RouterSessionEntryData);
    showDebugStatus(ctx, activeRoute);

    return { action: "continue" };
  });

  pi.on("message_end", (event) => {
    if (!activeRoute || activeRoute.threadId === "parent") return;
    const tagged: TaggedAgentMessage = {
      ...event.message,
      jevRouter: {
        threadId: activeRoute.threadId,
        threadName: activeRoute.threadName,
      },
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
    if (!needsTreeLabel || !activeRoute || activeRoute.threadId === "parent") return;
    const leafId = ctx.sessionManager.getLeafId();
    const leaf = leafId ? ctx.sessionManager.getEntry(leafId) : undefined;
    if (leaf?.type === "message" && leaf.message.role === "user") {
      pi.setLabel(leaf.id, `temp:${activeRoute.threadName}`);
    }
    needsTreeLabel = false;
  });

  pi.on("agent_settled", () => {
    setParentContextToolEnabled(false);
    activeRoute = undefined;
    needsTreeLabel = false;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    setParentContextToolEnabled(false);
    activeRoute = undefined;
    routeClient = undefined;
    clearDebugStatus(ctx);
  });
}
