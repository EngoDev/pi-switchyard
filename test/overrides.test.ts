import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
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
  type PinEntryData,
} from "../src/overrides.js";

function custom(id: string, type: string, data: unknown, parentId: string | null = null): SessionEntry {
  return { type: "custom", id, parentId, timestamp: new Date().toISOString(), customType: type, data };
}

test("thread pins restore and clear branch-locally", () => {
  const set = custom("set", PIN_ENTRY_TYPE, { kind: "set", threadId: "t1", threadName: "one", tier: "handy", timestamp: "now" } satisfies PinEntryData);
  const clear = custom("clear", PIN_ENTRY_TYPE, { kind: "cleared", threadId: "t1", timestamp: "later" } satisfies PinEntryData, "set");
  assert.equal(restoreThreadPins([set]).get("t1"), "handy");
  assert.equal(restoreThreadPins([set, clear]).has("t1"), false);
  assert.equal(restoreThreadPins([]).size, 0);
});

test("next overrides merge target and tier and survive until resolved", () => {
  const tier = mergeNextOverride(undefined, { tier: "cheap" }, "token1");
  const merged = mergeNextOverride(tier, { target: "origin" }, tier.token);
  assert.deepEqual(merged, { token: "token1", target: "origin", tier: "cheap" });
  const set = custom("set", NEXT_OVERRIDE_ENTRY_TYPE, { kind: "set", ...merged, timestamp: "now" } satisfies NextOverrideEntryData);
  assert.deepEqual(restoreNextOverride([set]), merged);
  const done = custom("done", NEXT_OVERRIDE_ENTRY_TYPE, { kind: "resolved", token: "token1", outcome: "consumed", timestamp: "later" } satisfies NextOverrideEntryData, "set");
  assert.equal(restoreNextOverride([set, done]), undefined);
  assert.deepEqual(restoreNextOverride([set]), merged, "receipt from a different branch is not visible");
});

test("manual precedence is next override, thread pin, then Jev", () => {
  const pins = new Map([["t1", "handy" as const]]);
  const next = { token: "token", target: "origin" as const, tier: "cheap" as const };
  assert.deepEqual(applyTargetOverride("t1", next), { target: "origin", overridden: true });
  assert.deepEqual(applyTierOverride("smart", "t1", next, pins), { tier: "cheap", source: "next-override" });
  assert.deepEqual(applyTierOverride("smart", "t1", undefined, pins), { tier: "handy", source: "thread-pin" });
  assert.deepEqual(applyTierOverride("smart", "t2", undefined, pins), { tier: "smart", source: "jev" });
});

test("manual override status remains compact and visible", () => {
  assert.equal(formatManualOverrideStatus("smart", "origin", { token: "t", target: "origin", tier: "cheap" }), "pinned smart (origin) · next: target→origin tier→cheap");
  assert.equal(formatManualOverrideStatus(undefined, "origin", undefined), undefined);
});

test("real dispatch hook consumes an applied override once, including failure/retry", () => {
  const sm = SessionManager.inMemory("/tmp");
  sm.appendCustomEntry(NEXT_OVERRIDE_ENTRY_TYPE, { kind: "set", token: "token", tier: "cheap", timestamp: "now" } satisfies NextOverrideEntryData);
  let applied: string | undefined;
  let handler: (() => void) | undefined;
  let consumed = 0;
  const pi = {
    on: (name: string, fn: () => void) => { assert.equal(name, "before_provider_request"); handler = fn; },
    appendEntry: (name: string, data: unknown) => sm.appendCustomEntry(name, data),
  } as unknown as ExtensionAPI;
  registerNextOverrideDispatch(pi, () => applied, (token) => { assert.equal(token, "token"); consumed++; applied = undefined; });
  handler!();
  assert.ok(restoreNextOverride(sm.getBranch()), "not applied means not consumed");
  applied = "token";
  handler!();
  assert.equal(restoreNextOverride(sm.getBranch()), undefined);
  handler!();
  assert.equal(consumed, 1);
  const reloaded = structuredClone(sm.getBranch()) as SessionEntry[];
  assert.equal(restoreNextOverride(reloaded), undefined);
});
