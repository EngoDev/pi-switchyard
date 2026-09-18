import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { TierName } from "./types.js";

/**
 * Manual routing overrides ("pins") for Switchyard.
 *
 * Two independent mechanisms:
 *
 * - A **thread pin** fixes the tier for a specific logical thread (origin or a
 *   named temp) until explicitly unpinned. It applies whenever that thread is
 *   the effective target of a request, regardless of how the target was
 *   chosen.
 * - A **next-request override** is a one-shot target and/or tier override
 *   consumed the first time it is applied to an accepted, provider-bound
 *   request-including a failed one. It is not consumed merely by being
 *   created, and it survives reload until it is applied or explicitly
 *   cleared with `/switchyard unpin`.
 *
 * Both are projected from custom entries on the active branch, exactly like
 * the rest of Switchyard's durable state: no process-local flags, no
 * cross-branch leakage.
 */

export const PIN_ENTRY_TYPE = "switchyard-pin";
export const NEXT_OVERRIDE_ENTRY_TYPE = "switchyard-next-override";

export interface PinSetEntryData {
  kind: "set";
  threadId: string;
  threadName: string;
  tier: TierName;
  timestamp: string;
}

export interface PinClearedEntryData {
  kind: "cleared";
  threadId: string;
  timestamp: string;
}

export type PinEntryData = PinSetEntryData | PinClearedEntryData;

export interface NextOverrideSetEntryData {
  kind: "set";
  token: string;
  target?: "origin";
  tier?: TierName;
  timestamp: string;
}

export interface NextOverrideResolvedEntryData {
  kind: "resolved";
  token: string;
  outcome: "consumed" | "cleared";
  timestamp: string;
}

export type NextOverrideEntryData = NextOverrideSetEntryData | NextOverrideResolvedEntryData;

export interface PendingNextOverride {
  token: string;
  target?: "origin";
  tier?: TierName;
}

/** Branch-local thread pins: threadId -> pinned tier. Rebuilt from scratch per branch. */
export function restoreThreadPins(entries: readonly SessionEntry[]): Map<string, TierName> {
  const pins = new Map<string, TierName>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PIN_ENTRY_TYPE) continue;
    const data = entry.data as PinEntryData | undefined;
    if (data?.kind === "set") pins.set(data.threadId, data.tier);
    if (data?.kind === "cleared") pins.delete(data.threadId);
  }
  return pins;
}

/** The pending one-shot next-request override, or undefined once consumed/cleared. */
export function restoreNextOverride(entries: readonly SessionEntry[]): PendingNextOverride | undefined {
  let pending: PendingNextOverride | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== NEXT_OVERRIDE_ENTRY_TYPE) continue;
    const data = entry.data as NextOverrideEntryData | undefined;
    if (data?.kind === "set") {
      pending = {
        token: data.token,
        ...(data.target ? { target: data.target } : {}),
        ...(data.tier ? { tier: data.tier } : {}),
      };
    }
    if (data?.kind === "resolved" && pending?.token === data.token) pending = undefined;
  }
  return pending;
}

/**
 * Merge a new pin-next/route-origin command into any still-pending next-request
 * override so `/switchyard pin-next cheap` and `/switchyard route origin` can be
 * issued independently and still combine into a single one-shot override.
 */
export function mergeNextOverride(
  existing: PendingNextOverride | undefined,
  patch: { target?: "origin"; tier?: TierName },
  token: string,
): PendingNextOverride {
  const target = patch.target ?? existing?.target;
  const tier = patch.tier ?? existing?.tier;
  return {
    token,
    ...(target ? { target } : {}),
    ...(tier ? { tier } : {}),
  };
}

export interface TargetOverrideResult {
  target: string;
  overridden: boolean;
}

/**
 * Manual target override wins over Jev's target. This must be applied before
 * temp-thread lifecycle checks: forcing "origin" means the request can never
 * be held for an existing temp thread's soft-limit prompt.
 */
export function applyTargetOverride(
  target: string,
  nextOverride: PendingNextOverride | undefined,
): TargetOverrideResult {
  if (nextOverride?.target) return { target: nextOverride.target, overridden: true };
  return { target, overridden: false };
}

export type TierOverrideSource = "jev" | "next-override" | "thread-pin";

export interface TierOverrideResult {
  tier: TierName;
  source: TierOverrideSource;
}

/**
 * Manual tier override wins over Jev's tier and over the deterministic
 * cache-aware transition policy: a one-shot next-request tier beats a
 * thread pin, which beats Jev's recommendation. `threadId` is the resolved
 * target thread (undefined for a not-yet-created new temp thread, which
 * cannot already carry a pin).
 */
export function applyTierOverride(
  tier: TierName,
  threadId: string | undefined,
  nextOverride: PendingNextOverride | undefined,
  threadPins: ReadonlyMap<string, TierName>,
): TierOverrideResult {
  if (nextOverride?.tier) return { tier: nextOverride.tier, source: "next-override" };
  if (threadId !== undefined) {
    const pinned = threadPins.get(threadId);
    if (pinned) return { tier: pinned, source: "thread-pin" };
  }
  return { tier, source: "jev" };
}

function describeNextOverride(next: PendingNextOverride | undefined): string | undefined {
  if (!next) return undefined;
  const parts = [
    next.target ? `target→${next.target}` : undefined,
    next.tier ? `tier→${next.tier}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? `next: ${parts.join(" ")}` : undefined;
}

/** Compact footer/status text describing any active pin/next override, or undefined when none. */
export function formatManualOverrideStatus(
  pinnedTier: TierName | undefined,
  threadLabel: string,
  next: PendingNextOverride | undefined,
): string | undefined {
  const parts = [
    pinnedTier ? `pinned ${pinnedTier} (${threadLabel})` : undefined,
    describeNextOverride(next),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Consume the pending next-request override exactly once, at Pi's
 * `before_provider_request` boundary-after the payload is built, before
 * dispatch. This mirrors the cache-reset single-use window: retries and
 * failed requests do not leave the override available, and a request that
 * never reaches dispatch (held for a lifecycle prompt, cancelled, or never
 * routed because Switchyard is disabled) leaves it untouched.
 *
 * `getAppliedToken` must return the token of the override that was actually
 * used to resolve the in-flight request's target/tier, or undefined when no
 * override was applied this turn.
 */
export function registerNextOverrideDispatch(
  pi: ExtensionAPI,
  getAppliedToken: () => string | undefined,
  onConsumed: (token: string) => void,
): void {
  pi.on("before_provider_request", () => {
    const token = getAppliedToken();
    if (!token) return;
    pi.appendEntry(NEXT_OVERRIDE_ENTRY_TYPE, {
      kind: "resolved",
      token,
      outcome: "consumed",
      timestamp: new Date().toISOString(),
    } satisfies NextOverrideEntryData);
    onConsumed(token);
  });
}
