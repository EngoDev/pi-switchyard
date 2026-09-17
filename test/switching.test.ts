import assert from "node:assert/strict";
import test from "node:test";

import type { Model } from "@earendil-works/pi-ai";

import { DEFAULT_CONFIG } from "../src/config.js";
import { evaluateModelSwitch, type RoutedModel } from "../src/switching.js";

function model(id: string, cost: Model<any>["cost"]): Model<any> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost,
    contextWindow: 1_000_000,
    maxTokens: 32_000,
  };
}

const expensive = model("expensive", { input: 10, output: 30, cacheRead: 0.1, cacheWrite: 12 });
const cheap = model("cheap", { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 });

function routed(tier: RoutedModel["tier"], value: Model<any>): RoutedModel {
  return {
    tier,
    model: value,
    tierConfig: { provider: value.provider, modelId: value.id, thinking: "default" },
  };
}

const switching = DEFAULT_CONFIG.switching;

test("disabling cache awareness always accepts Jev's candidate", () => {
  const result = evaluateModelSwitch({
    incumbent: routed("smart", expensive),
    candidate: routed("cheap", cheap),
    tierConfidence: 0,
    contextTokens: 1_000_000,
    promptTokens: 100,
    warmCacheRatio: 1,
    expectedOutputTokens: 1,
    config: { ...switching, cacheAware: false },
  });
  assert.equal(result.selection, "candidate");
  assert.equal(result.reason, "cache-awareness-disabled");
});

test("new threads use Jev's candidate without a cache penalty", () => {
  const result = evaluateModelSwitch({
    incumbent: undefined,
    candidate: routed("cheap", cheap),
    tierConfidence: 0.9,
    contextTokens: 10_000,
    promptTokens: 100,
    warmCacheRatio: undefined,
    expectedOutputTokens: 500,
    config: switching,
  });
  assert.equal(result.selection, "candidate");
  assert.equal(result.reason, "new-thread");
});

test("same-model tier changes preserve the candidate thinking selection", () => {
  const incumbent = routed("smart", expensive);
  const candidate = {
    ...routed("handy", expensive),
    tierConfig: { provider: "test", modelId: "expensive", thinking: "low" as const },
  };
  const result = evaluateModelSwitch({
    incumbent,
    candidate,
    tierConfidence: 0.9,
    contextTokens: 50_000,
    promptTokens: 100,
    warmCacheRatio: 0.9,
    expectedOutputTokens: 500,
    config: switching,
  });
  assert.equal(result.selection, "candidate");
  assert.equal(result.reason, "same-model");
  assert.equal(result.selected.tierConfig.thinking, "low");
});

test("same-model downgrades still require confidence before reducing thinking", () => {
  const result = evaluateModelSwitch({
    incumbent: routed("genius", expensive),
    candidate: routed("cheap", expensive),
    tierConfidence: 0.5,
    contextTokens: 1_000,
    promptTokens: 100,
    warmCacheRatio: 1,
    expectedOutputTokens: 100,
    config: switching,
  });
  assert.equal(result.selection, "incumbent");
  assert.equal(result.reason, "low-downgrade-confidence");
});

test("capability upgrades bypass cache economics by default", () => {
  const result = evaluateModelSwitch({
    incumbent: routed("cheap", cheap),
    candidate: routed("genius", expensive),
    tierConfidence: 0.9,
    contextTokens: 100_000,
    promptTokens: 100,
    warmCacheRatio: 0.95,
    expectedOutputTokens: 500,
    config: switching,
  });
  assert.equal(result.selection, "candidate");
  assert.equal(result.reason, "capability-upgrade");
});

test("warm cache suppresses a downgrade whose cold switch is more expensive", () => {
  const result = evaluateModelSwitch({
    incumbent: routed("smart", expensive),
    candidate: routed("cheap", cheap),
    tierConfidence: 0.95,
    contextTokens: 100_000,
    promptTokens: 100,
    warmCacheRatio: 0.95,
    expectedOutputTokens: 100,
    config: switching,
  });
  assert.equal(result.selection, "incumbent");
  assert.equal(result.reason, "insufficient-savings");
  assert.ok((result.economics?.coldSwitchCostUsd ?? 0) > (result.economics?.warmStayCostUsd ?? 0));
});

test("a downgrade switches when immediate savings clear both thresholds", () => {
  const result = evaluateModelSwitch({
    incumbent: routed("smart", expensive),
    candidate: routed("cheap", cheap),
    tierConfidence: 0.95,
    contextTokens: 1_000,
    promptTokens: 100,
    warmCacheRatio: 0.2,
    expectedOutputTokens: 10_000,
    config: switching,
  });
  assert.equal(result.selection, "candidate");
  assert.equal(result.reason, "material-savings");
  assert.ok((result.economics?.savingsRatio ?? 0) >= switching.minSavingsRatio);
});

test("low-confidence downgrades stay on the incumbent", () => {
  const result = evaluateModelSwitch({
    incumbent: routed("smart", expensive),
    candidate: routed("cheap", cheap),
    tierConfidence: 0.5,
    contextTokens: 1_000,
    promptTokens: 100,
    warmCacheRatio: 0,
    expectedOutputTokens: 10_000,
    config: switching,
  });
  assert.equal(result.selection, "incumbent");
  assert.equal(result.reason, "low-downgrade-confidence");
});

test("unknown zero pricing stays unless policy explicitly allows switching", () => {
  const unknownA = model("unknown-a", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const unknownB = model("unknown-b", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const base = {
    incumbent: routed("smart", unknownA),
    candidate: routed("cheap", unknownB),
    tierConfidence: 0.9,
    contextTokens: 1_000,
    promptTokens: 100,
    warmCacheRatio: 0,
    expectedOutputTokens: 100,
  };
  assert.equal(evaluateModelSwitch({ ...base, config: switching }).selection, "incumbent");
  assert.equal(evaluateModelSwitch({
    ...base,
    config: { ...switching, unknownCostPolicy: "switch" },
  }).selection, "candidate");
});

test("cache-write rates apply only to the estimated cache-write bucket", () => {
  const costlyWrites = model("costly-writes", { input: 1, output: 0, cacheRead: 0.1, cacheWrite: 100 });
  const result = evaluateModelSwitch({
    incumbent: routed("smart", expensive),
    candidate: routed("cheap", costlyWrites),
    tierConfidence: 1,
    contextTokens: 1_000,
    promptTokens: 100,
    warmCacheRatio: 0,
    cacheWriteRatio: 0,
    expectedOutputTokens: 0,
    config: { ...switching, assumedCacheWriteRatio: 0 },
  });
  assert.equal(result.economics?.coldSwitchCostUsd, 0.001);
});

test("Switchyard economics overrides and long-context tiers take precedence", () => {
  const result = evaluateModelSwitch({
    incumbent: routed("smart", expensive),
    candidate: routed("cheap", cheap),
    tierConfidence: 0.95,
    contextTokens: 300_000,
    promptTokens: 100,
    warmCacheRatio: 0.9,
    expectedOutputTokens: 500,
    config: {
      ...switching,
      economics: {
        "test/cheap": {
          input: 1,
          output: 2,
          cacheRead: 0.1,
          cacheWrite: 1,
          tiers: [{
            inputTokensAbove: 200_000,
            input: 50,
            output: 50,
            cacheRead: 5,
            cacheWrite: 50,
          }],
        },
      },
    },
  });
  assert.equal(result.selection, "incumbent");
  assert.equal(result.economics?.candidateRates.input, 50);
});
