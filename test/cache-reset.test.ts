import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { availableCacheResets, CACHE_RESET_CONSUMED, getCacheResetOpportunity, registerCacheResetDispatch } from "../src/cache-reset.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { decideModelTransition, type ModelTransitionInput, type RoutedModel, type TierRecommendationEvidence } from "../src/switching.js";
import type { TierName } from "../src/types.js";

function reset(id = "reset", temp?: string): SessionEntry {
  return {
    type: "compaction", id, parentId: null, timestamp: new Date(0).toISOString(),
    summary: "origin summary", firstKeptEntryId: "tail", tokensBefore: 10000,
    ...(temp ? { details: { switchyard: { tempThreads: { [temp]: { summary: "temp summary", firstKeptEntryId: "tail" } } } } } : {}),
  };
}
function receipt(entryId = "reset", threadId = "origin"): SessionEntry {
  return { type: "custom", id: `receipt-${entryId}-${threadId}`, parentId: entryId, timestamp: new Date(1).toISOString(), customType: CACHE_RESET_CONSUMED, data: { entryId, threadId, reason: "compaction" } };
}
function candidate(tier: TierName, input: number): RoutedModel {
  return {
    tier, tierConfig: { provider: "test", modelId: tier, thinking: "high" },
    model: { id: tier, name: tier, provider: "test", api: "openai-completions", baseUrl: "https://example.test", reasoning: true, input: ["text"], cost: { input, output: input, cacheRead: input / 10, cacheWrite: input }, contextWindow: 100000, maxTokens: 1000 },
  };
}
function rec(tier: TierName, requestId: string): TierRecommendationEvidence {
  return { tier, requestId, confidence: 1, tierProbabilities: { genius: 0, smart: tier === "smart" ? 1 : 0, handy: 0, cheap: tier === "cheap" ? 1 : 0 } };
}
function decisionInput(tier: "smart" | "cheap" = "cheap"): ModelTransitionInput {
  const smart = candidate("smart", 10), cheap = candidate("cheap", 0.2);
  return {
    incumbent: smart, requested: tier === "smart" ? smart : cheap, candidates: [smart, cheap],
    currentRecommendation: rec(tier, "current"), recommendationHistory: [rec("cheap", "one"), rec("cheap", "two"), rec("cheap", "three")],
    contextTokens: 10000, promptTokens: 100, expectedOutputTokens: 100, warmCacheRatio: 0.95, warmCacheSource: "observed", config: DEFAULT_CONFIG.switching,
  };
}

test("idle/manual compaction exposes a branch-local opportunity until dispatch", () => {
  const entries = [reset()];
  const opportunity = getCacheResetOpportunity(entries, "origin");
  assert.deepEqual(opportunity, { entryId: "reset", threadId: "origin", reason: "compaction" });
  decideModelTransition({ ...decisionInput(), cacheResetOpportunity: opportunity! });
  assert.deepEqual(getCacheResetOpportunity(entries, "origin"), opportunity, "model evaluation does not consume it");
  assert.equal(getCacheResetOpportunity([...entries, receipt()], "origin"), undefined);
});

test("first post-compaction stay consumes the opportunity; later cheap request cannot reuse it", () => {
  const entries = [reset()];
  const first = decideModelTransition({ ...decisionInput("smart"), cacheResetOpportunity: getCacheResetOpportunity(entries, "origin")! });
  assert.equal(first.selected.tier, "smart");
  const after = [...entries, receipt()];
  const resetForSecond = getCacheResetOpportunity(after, "origin");
  const second = decideModelTransition({ ...decisionInput(), ...(resetForSecond ? { cacheResetOpportunity: resetForSecond } : {}) });
  assert.equal(second.cacheResetOpportunity, undefined);
  assert.equal(second.economics?.warmCacheRatio, 0.95);
});

test("reset changes costs but contributes no evidence and bypasses no downgrade gates", () => {
  const base = decisionInput();
  const opportunity = getCacheResetOpportunity([reset()], "origin")!;
  const ordinary = decideModelTransition(base);
  const cold = decideModelTransition({ ...base, cacheResetOpportunity: opportunity });
  assert.deepEqual(cold.evidence, ordinary.evidence);
  assert.equal(cold.economics?.warmCacheRatio, 0);
  assert.equal(cold.selected.tier, "cheap");
  const weak = decideModelTransition({ ...base, recommendationHistory: [], cacheResetOpportunity: opportunity });
  assert.equal(weak.selected.tier, "smart");
  assert.equal(weak.reason, "insufficient-evidence");
  const lowConfidence = decideModelTransition({ ...base, currentRecommendation: { ...base.currentRecommendation, confidence: 0.1 }, cacheResetOpportunity: opportunity });
  assert.equal(lowConfidence.selected.tier, "smart");
  const expensiveReturn = decideModelTransition({ ...base, config: { ...base.config, returnCostMultiplier: 1000 }, cacheResetOpportunity: opportunity });
  assert.equal(expensiveReturn.selected.tier, "smart");
});

test("compaction in flight cannot change the assigned model regardless of trend or mode", () => {
  for (const cacheAware of [true, false]) {
    const base = decisionInput();
    const result = decideModelTransition({ ...base, taskPhase: "continuing", cacheResetOpportunity: getCacheResetOpportunity([reset()], "origin")!, config: { ...base.config, cacheAware } });
    assert.equal(result.selected.model.id, "smart");
    assert.equal(result.reason, "in-flight-task-lock");
  }
});

test("receipts survive reload and failures without requiring an assistant response", () => {
  const entries = JSON.parse(JSON.stringify([reset(), receipt()])) as SessionEntry[];
  assert.deepEqual(availableCacheResets(entries), []);
  // Recovery of an aborted/failed old session also treats the attempt as consumption.
  const response: SessionEntry = { type: "message", id: "failed", parentId: "reset", timestamp: new Date(2).toISOString(), message: {
    role: "assistant", content: [], api: "openai-completions", provider: "test", model: "smart", stopReason: "error", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } };
  assert.equal(getCacheResetOpportunity([reset(), response], "origin"), undefined);
});

test("only affected threads are reset; newer compactions replace old opportunities", () => {
  const entries = [reset("r1", "temp-one"), receipt("r1"), reset("r2")];
  assert.equal(getCacheResetOpportunity(entries, "temp-two"), undefined);
  assert.equal(getCacheResetOpportunity(entries, "temp-one")?.entryId, "r1");
  assert.equal(getCacheResetOpportunity(entries, "origin")?.entryId, "r2");
  assert.equal(getCacheResetOpportunity([...entries, receipt("r1")], "origin")?.entryId, "r2");
  const fork = [reset("r1")];
  assert.ok(getCacheResetOpportunity(fork, "origin"), "receipt from another branch is not inherited");
});

test("branch-summary reset is origin-only and an unsuccessful compaction cannot replenish it", () => {
  const branchSummary: SessionEntry = {
    type: "branch_summary", id: "branch-summary", parentId: null, timestamp: new Date(1).toISOString(), fromId: "old-leaf", summary: "origin only",
  };
  const entries = [branchSummary, receipt("branch-summary")];
  assert.equal(getCacheResetOpportunity([branchSummary], "origin")?.reason, "branch-summary");
  assert.equal(getCacheResetOpportunity([branchSummary], "t1"), undefined);
  // A failed/cancelled compaction appends no checkpoint: the old consumed state remains.
  assert.deepEqual(availableCacheResets(entries), []);
  assert.equal(getCacheResetOpportunity([...entries, reset("fresh-reset")], "origin")?.entryId, "fresh-reset");
});

test("shadow decisions and cancellations before dispatch do not mutate or consume a reset", () => {
  const base = decisionInput();
  const input = {
    ...base,
    config: { ...base.config, downgradeMode: "shadow" as const },
    cacheResetOpportunity: getCacheResetOpportunity([reset()], "origin")!,
  };
  const original = structuredClone(input);
  const first = decideModelTransition(input);
  const second = decideModelTransition(input);
  assert.deepEqual(input, original);
  assert.deepEqual(first, second);
  assert.equal(first.selected.tier, "smart");
  assert.equal(first.reason, "shadow-downgrade");
  assert.ok(getCacheResetOpportunity([reset()], "origin"));
  assert.equal(getCacheResetOpportunity([reset(), receipt()], "origin"), undefined);
});

test("the real registered dispatch hook consumes once before failure or retry and never switches models", () => {
  const sm = SessionManager.inMemory("/tmp");
  sm.appendCompaction("origin summary", "tail", 10000);
  let isolated: string | undefined = "origin";
  let dispatch: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let writes = 0;
  const pi = {
    on: (name: string, handler: typeof dispatch) => { assert.equal(name, "before_provider_request"); dispatch = handler; },
    appendEntry: (name: string, data: unknown) => { writes++; sm.appendCustomEntry(name, data); },
    setModel: () => { assert.fail("dispatch must never switch a model mid-task"); },
  } as unknown as ExtensionAPI;
  registerCacheResetDispatch(pi, () => isolated);
  const ctx = { sessionManager: sm } as unknown as ExtensionContext;
  assert.ok(getCacheResetOpportunity(sm.getBranch(), "origin"));
  dispatch!({}, ctx); // request will fail after this boundary; no assistant response
  assert.equal(getCacheResetOpportunity(sm.getBranch(), "origin"), undefined);
  dispatch!({}, ctx); // retry
  assert.equal(writes, 1);
  sm.appendCompaction("next summary", "tail", 10000, { switchyard: { tempThreads: { t1: {} } } });
  isolated = "t1";
  dispatch!({}, ctx);
  assert.ok(getCacheResetOpportunity(sm.getBranch(), "origin"));
  assert.equal(getCacheResetOpportunity(sm.getBranch(), "t1"), undefined);
  isolated = undefined; // Jev disabled/unavailable: unfiltered transcript dispatch
  dispatch!({}, ctx);
  assert.deepEqual(availableCacheResets(sm.getBranch()), []);
});
