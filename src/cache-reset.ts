import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getRouterMetadata, summaryAffectsThread } from "./threads.js";

export const CACHE_RESET_CONSUMED = "switchyard-cache-reset-consumed";

export interface CacheResetOpportunity {
  entryId: string;
  threadId: string;
  reason: "compaction" | "branch-summary";
}

/** Project single-use opportunities from the active branch; no process-local flags. */
export function availableCacheResets(entries: readonly SessionEntry[]): CacheResetOpportunity[] {
  const pending = new Map<string, CacheResetOpportunity>();
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const affected = new Set(["origin"]);
      if (entry.type === "compaction" && entry.details && typeof entry.details === "object") {
        const details = entry.details as Record<string, unknown>;
        const metadata = details.switchyard ?? details.jevRouter;
        if (metadata && typeof metadata === "object") {
          const tempThreads = (metadata as Record<string, unknown>).tempThreads;
          if (tempThreads && typeof tempThreads === "object") {
            for (const id of Object.keys(tempThreads)) affected.add(id);
          }
        }
      }
      for (const threadId of affected) {
        if (!summaryAffectsThread(entry, threadId)) continue;
        pending.set(threadId, {
          entryId: entry.id,
          threadId,
          reason: entry.type === "compaction" ? "compaction" : "branch-summary",
        });
      }
    } else if (entry.type === "custom" && entry.customType === CACHE_RESET_CONSUMED) {
      const data = entry.data as Partial<CacheResetOpportunity> | undefined;
      if (data?.threadId && pending.get(data.threadId)?.entryId === data.entryId) pending.delete(data.threadId);
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      // Compatibility for sessions created before dispatch receipts existed.
      // Failed/aborted responses count too: success is not a condition of consumption.
      pending.delete(getRouterMetadata(entry.message)?.threadId ?? "origin");
    }
  }
  return [...pending.values()];
}

export function getCacheResetOpportunity(
  entries: readonly SessionEntry[],
  threadId: string,
): CacheResetOpportunity | undefined {
  return availableCacheResets(entries).find((opportunity) => opportunity.threadId === threadId);
}

/**
 * Pi awaits before_provider_request after constructing the payload, before dispatch.
 * Write the receipt here, not at selection/message_end: retries and failed requests
 * cannot leave a reset available. With no isolated route, the full transcript may
 * be sent, so consume all affected threads conservatively. This hook never routes.
 */
export function registerCacheResetDispatch(
  pi: ExtensionAPI,
  getIsolatedThread: () => string | undefined,
): void {
  pi.on("before_provider_request", (_event, ctx) => {
    const threadId = getIsolatedThread();
    for (const opportunity of availableCacheResets(ctx.sessionManager.getBranch())) {
      if (threadId !== undefined && opportunity.threadId !== threadId) continue;
      pi.appendEntry(CACHE_RESET_CONSUMED, opportunity);
    }
  });
}
