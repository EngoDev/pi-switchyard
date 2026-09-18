import assert from "node:assert/strict";
import test from "node:test";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { formatInspectReport, formatThreadInspection, resolveModelPricing, summarizeCacheUsage, summarizeRouteHistory } from "../src/inspect.js";
import { buildTransitionAudit, decideModelTransition, type RoutedModel } from "../src/switching.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { RouteHistoryEntry } from "../src/threads.js";

const usage = (input: number, cacheRead: number): Usage => ({ input, cacheRead, cacheWrite: 0, output: 10, totalTokens: input + cacheRead + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const model = (id: string, input = 1): Model<any> => ({ id, name: id, provider: "test", api: "openai-completions", baseUrl: "https://example.test", reasoning: true, input: ["text"], cost: { input, output: input * 2, cacheRead: input / 10, cacheWrite: input }, contextWindow: 100000, maxTokens: 1000 });
const routed = (tier: "smart" | "cheap", m: Model<any>): RoutedModel => ({ tier, model: m, tierConfig: { provider: m.provider, modelId: m.id, thinking: "high" } });

test("cache inspection summarizes observed epoch usage", () => {
  assert.deepEqual(summarizeCacheUsage([usage(100, 900), usage(200, 800)]), {
    sampleCount: 2, observedTokens: 2000, observedCacheReadTokens: 1700, cacheReadRatio: 0.85,
  });
});

test("pricing inspection reports override, Pi metadata, unknown and long tiers", () => {
  const piModel = model("pi");
  piModel.cost.tiers = [{ inputTokensAbove: 50000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2 }];
  assert.equal(resolveModelPricing({ provider: "test", modelId: "pi" }, piModel, {}).provenance, "pi-metadata");
  const override = resolveModelPricing({ provider: "test", modelId: "pi" }, piModel, {
    "test/pi": { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3, tiers: [{ inputTokensAbove: 40000, input: 4, output: 8, cacheRead: 0.4, cacheWrite: 4 }] },
  });
  assert.equal(override.provenance, "switchyard-override");
  assert.equal(override.longContextTiers?.[0]?.inputTokensAbove, 40000);
  assert.equal(resolveModelPricing({ provider: "none", modelId: "missing" }, undefined, {}).provenance, "unknown");
});

test("transition audits are JSON-safe and preserve evidence, forecasts and reset reason", () => {
  const smart = routed("smart", model("smart", 10));
  const cheap = routed("cheap", model("cheap", 0.1));
  const decision = decideModelTransition({
    cacheResetOpportunity: { entryId: "c1", threadId: "origin", reason: "compaction" },
    incumbent: smart, requested: cheap, candidates: [smart, cheap],
    currentRecommendation: { requestId: "r2", tier: "cheap", confidence: 1, tierProbabilities: { genius: 0, smart: 0, handy: 0, cheap: 1 } },
    recommendationHistory: [{ requestId: "r1", tier: "cheap", confidence: 1, tierProbabilities: { genius: 0, smart: 0, handy: 0, cheap: 1 } }],
    contextTokens: 10000, promptTokens: 100, warmCacheRatio: 1, expectedOutputTokens: 100,
    config: { ...DEFAULT_CONFIG.switching, minSavingsRatio: 0, minSavingsUsd: 0, returnCostMultiplier: 0 },
  });
  const audit = buildTransitionAudit(decision);
  assert.equal(audit.cacheResetReason, "compaction");
  assert.equal(audit.reason, decision.reason);
  assert.doesNotMatch(JSON.stringify(audit), /baseUrl|contextWindow/);
  structuredClone(audit);
});

test("route inspection distinguishes requested and selected values with legacy fallback", () => {
  const baseRoute = {
    threadId: "origin" as const, threadName: "origin", tier: "smart" as const, provider: "test", modelId: "smart", thinking: "high" as const,
    decision: { requestId: "r", target: "origin" as const, tier: "cheap" as const, targetConfidence: 1, tierConfidence: 1, targetProbabilities: { origin: 1 }, tierProbabilities: { genius: 0, smart: 0, handy: 0, cheap: 1 } },
  };
  const history: RouteHistoryEntry[] = [
    { route: baseRoute, timestamp: "old" },
    { route: baseRoute, timestamp: "new", audit: { requestedTier: "cheap", requestedProvider: "test", requestedModelId: "cheap", reason: "insufficient-evidence" } },
  ];
  const result = summarizeRouteHistory(history);
  assert.equal(result[0]?.requestedTier, "cheap");
  assert.equal(result[0]?.requestedTierSource, "legacy-decision");
  assert.equal(result[1]?.requestedTierSource, "audit");
  assert.equal(result[1]?.requestedModelId, "cheap");
  assert.equal(result[1]?.selectedModelId, "smart");
});

test("single-thread inspection exposes pin, incumbent and context", () => {
  const text = formatThreadInspection({ id: "t1", name: "temp:one", active: false, pinnedTier: "smart", contextTokens: 123, recentRoutes: [], incumbent: { tier: "handy", provider: "test", modelId: "terra", thinking: "high" } });
  assert.match(text, /manual pin: smart/);
  assert.match(text, /handy.*test\/terra/);
  assert.match(text, /123 tokens/);
});

test("inspect report renders threads, reset state, route audit and pricing provenance", () => {
  const text = formatInspectReport({
    generatedAt: "now",
    threads: [{
      id: "origin", name: "origin", active: true, contextTokens: 12345,
      incumbent: { tier: "smart", provider: "test", modelId: "smart", thinking: "high" },
      cacheUsage: summarizeCacheUsage([usage(100, 900)]), resetOpportunity: { reason: "compaction" }, recentRoutes: [],
      latestAudit: { requestedTier: "cheap", requestedProvider: "test", requestedModelId: "cheap", reason: "insufficient-evidence" },
    }],
    pricing: [resolveModelPricing({ provider: "test", modelId: "smart" }, model("smart"), {})],
  });
  assert.match(text, /origin \[active\]/);
  assert.match(text, /12,345 tokens/);
  assert.match(text, /pending single-use reset from compaction/);
  assert.match(text, /insufficient-evidence/);
  assert.match(text, /pi-metadata/);
});
