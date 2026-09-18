import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CACHE_RESET_CONSUMED, getCacheResetOpportunity } from "../src/cache-reset.js";
import { NEXT_OVERRIDE_ENTRY_TYPE, PIN_ENTRY_TYPE, restoreNextOverride, restoreThreadPins } from "../src/overrides.js";
import { buildUsageSnapshot } from "../src/usage.js";
import { filterMessagesForOrigin, findMissingTempLabels, restoreThreads, threadContextFromEntries } from "../src/threads.js";
import type { RouterSessionEntryData, TempThread, TierName } from "../src/types.js";

let sequence = 0;
function entry(data: RouterSessionEntryData, parentId: string | null = null): SessionEntry {
  sequence++;
  return { type: "custom", id: `custom-${sequence}`, parentId, timestamp: "timestamp" in data ? data.timestamp : new Date(sequence).toISOString(), customType: "switchyard", data };
}
function route(requestId: string, threadId: string, modelId: string, tier: TierName, parentId: string | null): SessionEntry {
  return entry({ kind: "route", prompt: "prompt", timestamp: new Date(++sequence).toISOString(), route: { threadId, threadName: threadId, tier, provider: "test", modelId, thinking: "high", decision: { requestId, target: threadId, tier, targetConfidence: 1, tierConfidence: 1, targetProbabilities: { [threadId]: 1 }, tierProbabilities: { genius: 0, smart: tier === "smart" ? 1 : 0, handy: 0, cheap: tier === "cheap" ? 1 : 0 } } } }, parentId);
}
function assistant(id: string, threadId: string | undefined, modelId: string, cost: number, parentId: string): SessionEntry {
  const message: AgentMessage = { role: "assistant", content: [{ type: "text", text: `${id} answer` }], api: "openai-completions", provider: "test", model: modelId, stopReason: "stop", timestamp: ++sequence, usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, totalTokens: 160, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }, ...(threadId ? { switchyard: { threadId, threadName: threadId } } : {}) } as AgentMessage;
  return { type: "message", id, parentId, timestamp: new Date(sequence).toISOString(), message };
}
const thread: TempThread = { id: "t1", name: "status", createdAt: new Date(1).toISOString(), updatedAt: new Date(1).toISOString(), seedContext: [{ role: "user", text: "origin seed", timestamp: 1 }], firstPrompt: "status?" };

test("origin→temp→origin→compaction→failure→reload preserves every subsystem boundary", () => {
  const created = entry({ kind: "thread-created", thread });
  const originRoute = route("r1", "origin", "A", "smart", created.id);
  const originAnswer = assistant("a1", undefined, "A", 0.4, originRoute.id);
  const tempRoute = route("r2", "t1", "B", "cheap", originAnswer.id);
  const tempAnswer = assistant("a2", "t1", "B", 0.1, tempRoute.id);
  const backRoute = route("r3", "origin", "A", "smart", tempAnswer.id);
  const backAnswer = assistant("a3", undefined, "A", 0.5, backRoute.id);
  const compaction: SessionEntry = { type: "compaction", id: "compact", parentId: backAnswer.id, timestamp: new Date(++sequence).toISOString(), summary: "origin summary", firstKeptEntryId: originRoute.id, tokensBefore: 1000, details: { switchyard: { threadAware: true, excludedTempMessages: 1, tempThreads: { t1: { threadName: "status", summary: "temp summary", firstKeptEntryId: originRoute.id } } } } };
  const consumed: SessionEntry = { type: "custom", id: "consumed", parentId: compaction.id, timestamp: new Date(++sequence).toISOString(), customType: CACHE_RESET_CONSUMED, data: { entryId: "compact", threadId: "origin", reason: "compaction" } };
  const observed = entry({ kind: "usage-observed", requestId: "r3", threadId: "origin", threadName: "origin", tier: "smart", provider: "test", modelId: "A", turnCount: 1, reportedModels: ["test/A"], usage: backAnswer.type === "message" && backAnswer.message.role === "assistant" ? backAnswer.message.usage : assert.fail(), timestamp: new Date(++sequence).toISOString() }, consumed.id);
  const reloaded = structuredClone([created, originRoute, originAnswer, tempRoute, tempAnswer, backRoute, backAnswer, compaction, consumed, observed]) as SessionEntry[];
  assert.equal(restoreThreads(reloaded).has("t1"), true);
  const origin = filterMessagesForOrigin(reloaded.filter((e): e is Extract<SessionEntry,{type:"message"}> => e.type === "message").map((e) => e.message));
  assert.doesNotMatch(JSON.stringify(origin), /a2 answer/);
  assert.match(JSON.stringify(threadContextFromEntries(reloaded, thread)), /temp summary/);
  assert.equal(getCacheResetOpportunity(reloaded, "origin"), undefined);
  assert.equal(buildUsageSnapshot(reloaded, "now").recent.at(-1)?.observedUsage?.cost.total, 0.5);
  assert.deepEqual(findMissingTempLabels(reloaded, () => undefined).map((item) => item.entryId), ["a2"]);
});

test("branch divergence keeps pins, one-shot overrides and reset receipts branch-local", () => {
  const pin: SessionEntry = { type: "custom", id: "pin", parentId: null, timestamp: "1", customType: PIN_ENTRY_TYPE, data: { kind: "set", threadId: "origin", threadName: "origin", tier: "smart", timestamp: "1" } };
  const next: SessionEntry = { type: "custom", id: "next", parentId: "pin", timestamp: "2", customType: NEXT_OVERRIDE_ENTRY_TYPE, data: { kind: "set", token: "n1", tier: "cheap", timestamp: "2" } };
  const compact: SessionEntry = { type: "compaction", id: "c", parentId: "next", timestamp: "3", summary: "summary", firstKeptEntryId: "pin", tokensBefore: 100 };
  const receipt: SessionEntry = { type: "custom", id: "receipt", parentId: "c", timestamp: "4", customType: CACHE_RESET_CONSUMED, data: { entryId: "c", threadId: "origin", reason: "compaction" } };
  const branchBeforeDispatch = [pin, next, compact];
  const branchAfterDispatch = [...branchBeforeDispatch, receipt];
  assert.equal(restoreThreadPins(branchBeforeDispatch).get("origin"), "smart");
  assert.equal(restoreNextOverride(branchBeforeDispatch)?.tier, "cheap");
  assert.ok(getCacheResetOpportunity(branchBeforeDispatch, "origin"));
  assert.equal(getCacheResetOpportunity(branchAfterDispatch, "origin"), undefined);
  assert.equal(restoreNextOverride(branchAfterDispatch)?.tier, "cheap", "cache receipt cannot consume an unrelated manual override");
});
