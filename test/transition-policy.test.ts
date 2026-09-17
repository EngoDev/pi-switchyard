import assert from "node:assert/strict";
import test from "node:test";

import type { Model } from "@earendil-works/pi-ai";

import { DEFAULT_CONFIG } from "../src/config.js";
import {
  acceptTierRecommendation,
  decideModelTransition,
  type RoutedModel,
  type TierRecommendationEvidence,
} from "../src/switching.js";
import type { TierName } from "../src/types.js";

function model(id: string, input: number, output: number, cacheRead = input / 10): Model<any> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input, output, cacheRead, cacheWrite: input * 1.25 },
    contextWindow: 1_000_000,
    maxTokens: 32_000,
  };
}

const smart = model("smart", 5, 30);
const handy = model("handy", 2, 12);
const cheap = model("cheap", 0.2, 1.2);

function routed(tier: TierName, value: Model<any> = tier === "smart" ? smart : tier === "handy" ? handy : cheap): RoutedModel {
  return {
    tier,
    model: value,
    tierConfig: { provider: value.provider, modelId: value.id, thinking: "default" },
  };
}

let evidenceId = 0;
function rec(tier: TierName, confidence = 1): TierRecommendationEvidence {
  evidenceId += 1;
  return {
    requestId: `e${evidenceId}`,
    tier,
    confidence,
    tierProbabilities: {
      genius: tier === "genius" ? 1 : 0,
      smart: tier === "smart" ? 1 : 0,
      handy: tier === "handy" ? 1 : 0,
      cheap: tier === "cheap" ? 1 : 0,
    },
  };
}

function decide(
  history: TierRecommendationEvidence[],
  current: TierRecommendationEvidence,
  overrides: Partial<typeof DEFAULT_CONFIG.switching> = {},
) {
  return decideModelTransition({
    incumbent: routed("smart"),
    requested: routed(current.tier),
    candidates: [routed("cheap"), routed("handy"), routed("smart")],
    currentRecommendation: current,
    recommendationHistory: history,
    contextTokens: 20_000,
    promptTokens: 200,
    warmCacheRatio: 0.9,
    warmCacheSource: "observed",
    cacheWriteRatio: 0.2,
    expectedOutputTokens: 1_000,
    config: {
      ...DEFAULT_CONFIG.switching,
      minSavingsRatio: 0,
      minSavingsUsd: 0,
      returnCostMultiplier: 0,
      ...overrides,
    },
  });
}

test("accepted image escalation persists a stable request ID and corrected probabilities", () => {
  const accepted = acceptTierRecommendation("request-1", {
    target: "origin",
    tier: "cheap",
    targetConfidence: 1,
    tierConfidence: 0.9,
    targetProbabilities: { origin: 1 },
    tierProbabilities: { genius: 0, smart: 0, handy: 0, cheap: 1 },
  }, "smart");
  assert.equal(accepted.requestId, "request-1");
  assert.equal(accepted.tier, "smart");
  assert.deepEqual(accepted.tierProbabilities, { genius: 0, smart: 1, handy: 0, cheap: 0 });
});

test("disabling cache-aware policy bypasses trend accumulation", () => {
  const result = decide([], rec("cheap"), { cacheAware: false });
  assert.equal(result.selected.tier, "cheap");
  assert.equal(result.reason, "cache-awareness-disabled");
});

test("one easy request is insufficient evidence for a downgrade", () => {
  const result = decide([], rec("cheap"));
  assert.equal(result.selected.tier, "smart");
  assert.equal(result.reason, "insufficient-evidence");
});

test("sustained easy recommendations trigger a stable downgrade", () => {
  const result = decide([rec("cheap")], rec("cheap"));
  assert.equal(result.selected.tier, "cheap");
  assert.equal(result.reason, "stable-downgrade");
});

test("one harder request weakens but does not erase a strong downgrade trend", () => {
  const result = decide(
    [rec("cheap"), rec("cheap"), rec("smart"), rec("cheap")],
    rec("cheap"),
  );
  assert.equal(result.selected.tier, "cheap");
  assert.equal(result.evidence?.cheap?.passes, true);
});

test("alternating easy and hard work does not cause model thrashing", () => {
  const result = decide(
    [rec("cheap"), rec("smart"), rec("cheap"), rec("smart")],
    rec("cheap"),
  );
  assert.equal(result.selected.tier, "smart");
  assert.equal(result.evidence?.cheap?.passes, false);
});

test("evidence can choose a stable middle tier instead of an extreme", () => {
  const result = decide(
    [rec("cheap"), rec("handy"), rec("smart"), rec("handy")],
    rec("cheap"),
  );
  assert.equal(result.selected.tier, "handy");
  assert.equal(result.evidence?.cheap?.passes, false);
  assert.equal(result.evidence?.handy?.passes, true);
});

test("history can never underpower the current accepted requirement", () => {
  const result = decide(
    Array.from({ length: 10 }, () => rec("cheap")),
    rec("smart"),
  );
  assert.equal(result.selected.tier, "smart");
  assert.equal(result.evaluations?.find((item) => item.destination.tier === "cheap")?.gates.currentRequirement, false);
});

test("accepted upgrades are a hard floor even when economic upgrade bypass is disabled", () => {
  const result = decideModelTransition({
    incumbent: routed("cheap"),
    requested: routed("smart"),
    candidates: [routed("cheap"), routed("smart")],
    currentRecommendation: rec("smart"),
    recommendationHistory: [],
    contextTokens: 100_000,
    promptTokens: 100,
    warmCacheRatio: 1,
    expectedOutputTokens: 100,
    config: { ...DEFAULT_CONFIG.switching, upgradesAlwaysSwitch: false },
  });
  assert.equal(result.selected.tier, "smart");
  assert.equal(result.reason, "capability-upgrade");
});

test("a destination that is more expensive at every rate cannot win after cache invalidation", () => {
  const incumbentModel = model("dominant", 10, 0, 1);
  incumbentModel.cost.cacheWrite = 10;
  const worseModel = model("dominated", 11, 0, 1.1);
  worseModel.cost.cacheWrite = 11;
  const current = rec("cheap");
  const result = decideModelTransition({
    incumbent: routed("smart", incumbentModel),
    requested: routed("cheap", worseModel),
    candidates: [routed("cheap", worseModel), routed("smart", incumbentModel)],
    currentRecommendation: current,
    recommendationHistory: [rec("cheap")],
    contextTokens: 100_000,
    promptTokens: 0,
    warmCacheRatio: 0,
    warmCacheSource: "invalidated",
    expectedOutputTokens: 0,
    config: { ...DEFAULT_CONFIG.switching, returnCostMultiplier: 0 },
  });
  assert.equal(result.selected.model.id, "dominant");
});

test("equal-rate models cannot manufacture savings from asymmetric cache-write assumptions", () => {
  const incumbentModel = model("equal-a", 10, 0, 1);
  incumbentModel.cost.cacheWrite = 12.5;
  const candidateModel = model("equal-b", 10, 0, 1);
  candidateModel.cost.cacheWrite = 12.5;
  const result = decideModelTransition({
    incumbent: routed("smart", incumbentModel),
    requested: routed("cheap", candidateModel),
    candidates: [routed("cheap", candidateModel), routed("smart", incumbentModel)],
    currentRecommendation: rec("cheap"),
    recommendationHistory: [rec("cheap")],
    contextTokens: 100_000,
    promptTokens: 0,
    warmCacheRatio: 0,
    warmCacheSource: "invalidated",
    cacheWriteRatio: 1,
    expectedOutputTokens: 0,
    config: {
      ...DEFAULT_CONFIG.switching,
      forecastTurns: 1,
      returnCostMultiplier: 0,
      minSavingsRatio: 0,
      minSavingsUsd: 0,
    },
  });
  assert.equal(result.selected.model.id, "equal-a");
  assert.equal(result.reason, "dominated-economics");
});

test("a trivial output discount cannot exploit asymmetric cache-write assumptions", () => {
  const incumbentModel = model("mixed-a", 10, 30, 1);
  incumbentModel.cost.cacheWrite = 20;
  const candidateModel = model("mixed-b", 10.01, 29, 1.001);
  candidateModel.cost.cacheWrite = 20.02;
  const result = decideModelTransition({
    incumbent: routed("smart", incumbentModel),
    requested: routed("cheap", candidateModel),
    candidates: [routed("cheap", candidateModel), routed("smart", incumbentModel)],
    currentRecommendation: rec("cheap"),
    recommendationHistory: [rec("cheap")],
    contextTokens: 100_000,
    promptTokens: 0,
    warmCacheRatio: 0,
    warmCacheSource: "observed",
    cacheWriteRatio: 1,
    expectedOutputTokens: 1,
    config: { ...DEFAULT_CONFIG.switching, forecastTurns: 1 },
  });
  assert.equal(result.selected.model.id, "mixed-a");
});

test("periodic smart-cheap-cheap work does not manufacture savings before an expected return", () => {
  const incumbentModel = model("periodic-smart", 10, 0, 1);
  incumbentModel.cost.cacheWrite = 10;
  const cheapModel = model("periodic-cheap", 4.1, 0, 0.41);
  cheapModel.cost.cacheWrite = 4.1;
  const current = rec("cheap");
  const result = decideModelTransition({
    incumbent: routed("smart", incumbentModel),
    requested: routed("cheap", cheapModel),
    candidates: [routed("cheap", cheapModel), routed("smart", incumbentModel)],
    currentRecommendation: current,
    recommendationHistory: [rec("smart"), rec("cheap")],
    contextTokens: 100_000,
    promptTokens: 0,
    warmCacheRatio: 2 / 3,
    warmCacheSource: "observed",
    expectedOutputTokens: 0,
    config: DEFAULT_CONFIG.switching,
  });
  assert.equal(result.selected.model.id, "periodic-smart");
  assert.equal(result.reason, "return-cost-not-covered");
});

test("same-model thinking downgrades require trend evidence and an actual lower thinking level", () => {
  const lowThinking: RoutedModel = {
    tier: "handy",
    model: smart,
    tierConfig: { provider: "test", modelId: "smart", thinking: "low" },
  };
  const current = rec("handy");
  const result = decideModelTransition({
    incumbent: { ...routed("smart"), tierConfig: { provider: "test", modelId: "smart", thinking: "high" } },
    requested: lowThinking,
    candidates: [lowThinking, routed("smart")],
    currentRecommendation: current,
    recommendationHistory: [rec("handy")],
    contextTokens: 20_000,
    promptTokens: 100,
    warmCacheRatio: 0.9,
    expectedOutputTokens: 1_000,
    config: DEFAULT_CONFIG.switching,
  });
  assert.equal(result.selected.tier, "handy");
  assert.equal(result.reason, "same-model-stable-downgrade");

  const noOp = decideModelTransition({
    incumbent: { ...routed("smart"), tierConfig: { provider: "test", modelId: "smart", thinking: "high" } },
    requested: { ...lowThinking, tierConfig: { provider: "test", modelId: "smart", thinking: "default" } },
    candidates: [{ ...lowThinking, tierConfig: { provider: "test", modelId: "smart", thinking: "default" } }, routed("smart")],
    currentRecommendation: current,
    recommendationHistory: [rec("handy")],
    contextTokens: 20_000,
    promptTokens: 100,
    warmCacheRatio: 0.9,
    expectedOutputTokens: 1_000,
    config: DEFAULT_CONFIG.switching,
  });
  assert.equal(noOp.selected.tier, "smart");
  assert.equal(noOp.reason, "no-effective-downgrade");
});

test("provider-aliased thinking levels are not treated as an effective downgrade", () => {
  const aliased = {
    ...smart,
    thinkingLevelMap: { high: "high", medium: "high" },
  };
  const destination: RoutedModel = {
    tier: "handy",
    model: aliased,
    tierConfig: { provider: "test", modelId: "smart", thinking: "medium" },
  };
  const result = decideModelTransition({
    incumbent: {
      tier: "smart",
      model: aliased,
      tierConfig: { provider: "test", modelId: "smart", thinking: "high" },
    },
    requested: destination,
    candidates: [destination],
    currentRecommendation: rec("handy"),
    recommendationHistory: [rec("handy")],
    contextTokens: 10_000,
    promptTokens: 100,
    warmCacheRatio: 1,
    expectedOutputTokens: 100,
    config: DEFAULT_CONFIG.switching,
  });
  assert.equal(result.selected.tier, "smart");
  assert.equal(result.reason, "no-effective-downgrade");
});

test("a same-model no-op does not outrank a genuinely economical model downgrade", () => {
  const sameDefault: RoutedModel = {
    tier: "handy",
    model: smart,
    tierConfig: { provider: "test", modelId: "smart", thinking: "default" },
  };
  const current = rec("cheap");
  const result = decideModelTransition({
    incumbent: { ...routed("smart"), tierConfig: { provider: "test", modelId: "smart", thinking: "high" } },
    requested: routed("cheap"),
    candidates: [routed("cheap"), sameDefault, routed("smart")],
    currentRecommendation: current,
    recommendationHistory: [rec("cheap")],
    contextTokens: 20_000,
    promptTokens: 100,
    warmCacheRatio: 0.5,
    expectedOutputTokens: 2_000,
    config: { ...DEFAULT_CONFIG.switching, minSavingsRatio: 0, minSavingsUsd: 0, returnCostMultiplier: 0 },
  });
  assert.equal(result.selected.tier, "cheap");
  assert.equal(result.evaluations?.find((item) => item.destination.tier === "handy")?.gates.effectiveThinkingReduction, false);
});

test("return-cost reserve can block an otherwise attractive downgrade", () => {
  const result = decide(
    [rec("cheap"), rec("cheap"), rec("smart"), rec("cheap")],
    rec("cheap"),
    { returnCostMultiplier: 100, minSavingsRatio: 0.01 },
  );
  assert.equal(result.selected.tier, "smart");
  assert.equal(result.reason, "return-cost-not-covered");
  assert.ok(result.evaluations?.some((item) => item.forecast && !item.gates.savings));
});

test("unknown economics still require evidence and obey the configured policy", () => {
  const unknownSmart = model("unknown-smart", 0, 0, 0);
  const unknownCheap = model("unknown-cheap", 0, 0, 0);
  const history = [rec("cheap")];
  const current = rec("cheap");
  const base = {
    incumbent: routed("smart", unknownSmart),
    requested: routed("cheap", unknownCheap),
    candidates: [routed("cheap", unknownCheap), routed("smart", unknownSmart)],
    currentRecommendation: current,
    recommendationHistory: history,
    contextTokens: 10_000,
    promptTokens: 100,
    warmCacheRatio: 0,
    expectedOutputTokens: 100,
  };
  const stayed = decideModelTransition({
    ...base,
    config: { ...DEFAULT_CONFIG.switching, unknownCostPolicy: "stay" },
  });
  const switched = decideModelTransition({
    ...base,
    config: { ...DEFAULT_CONFIG.switching, unknownCostPolicy: "switch" },
  });
  assert.equal(stayed.selected.tier, "smart");
  assert.equal(stayed.reason, "unknown-economics-stay");
  assert.equal(switched.selected.tier, "cheap");
});

test("shadow mode proposes but does not execute a proven downgrade", () => {
  const result = decide([rec("cheap")], rec("cheap"), { downgradeMode: "shadow" });
  assert.equal(result.selected.tier, "smart");
  assert.equal(result.proposed?.tier, "cheap");
  assert.equal(result.reason, "shadow-downgrade");
});

test("duplicate request IDs do not increase evidence", () => {
  const duplicate = rec("cheap");
  const once = decide([duplicate], rec("cheap"), { minimumEvidenceWeight: 2 });
  const repeated = decide([duplicate, duplicate, duplicate], {
    ...rec("cheap"),
    requestId: duplicate.requestId,
  }, { minimumEvidenceWeight: 2 });
  assert.equal(once.evidence?.cheap?.passes, false);
  assert.equal(repeated.evidence?.cheap?.passes, false);
});

test("forecast return probability endpoints stop crediting destination turns after return", () => {
  const history = [rec("cheap"), rec("cheap")];
  const current = rec("cheap");
  const neverReturn = decide(history, current, {
    returnProbabilityFloor: 0,
    hardRequirementPenalty: 0,
    returnCostMultiplier: 1,
  });
  const certainReturn = decide(history, current, {
    returnProbabilityFloor: 1,
    returnCostMultiplier: 1,
  });
  assert.equal(neverReturn.forecast?.perTurnReturnProbability, 0);
  assert.equal(neverReturn.forecast?.cumulativeReturnProbability, 0);
  assert.equal(certainReturn.forecast?.perTurnReturnProbability, 1);
  assert.equal(certainReturn.forecast?.cumulativeReturnProbability, 1);
  assert.ok((certainReturn.forecast?.transitionCostUsd ?? 0) > (neverReturn.forecast?.transitionCostUsd ?? 0));
});

test("raising candidate prices cannot improve forecast downgrade savings", () => {
  const history = [rec("cheap"), rec("cheap"), rec("cheap")];
  const current = rec("cheap");
  let previousSavings = Infinity;
  for (const price of [0.1, 0.5, 1, 2, 4]) {
    const candidateModel = model(`cheap-${price}`, price, price * 4);
    const result = decideModelTransition({
      incumbent: routed("smart"),
      requested: routed("cheap", candidateModel),
      candidates: [routed("cheap", candidateModel), routed("smart")],
      currentRecommendation: current,
      recommendationHistory: history,
      contextTokens: 20_000,
      promptTokens: 200,
      warmCacheRatio: 0.9,
      expectedOutputTokens: 1_000,
      config: { ...DEFAULT_CONFIG.switching, minSavingsRatio: 0, minSavingsUsd: 0, returnCostMultiplier: 0 },
    });
    const savings = result.forecast?.netSavingsUsd ?? -Infinity;
    assert.ok(savings <= previousSavings);
    previousSavings = savings;
  }
});

test("raising return cost cannot make a downgrade more attractive", () => {
  const history = [rec("cheap"), rec("cheap"), rec("smart"), rec("cheap")];
  const current = rec("cheap");
  let previousSavings = Infinity;
  for (const multiplier of [0, 0.5, 1, 2, 5, 10]) {
    const result = decide(history, current, { returnCostMultiplier: multiplier });
    const savings = result.forecast?.netSavingsUsd ?? -Infinity;
    assert.ok(savings <= previousSavings);
    previousSavings = savings;
  }
});
