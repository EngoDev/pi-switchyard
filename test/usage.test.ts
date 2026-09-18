import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { accumulateAssistantTurn, buildUsageSnapshot, createUsageAccumulator, formatUsageReport, toPersistedUsageObserved } from "../src/usage.js";
import type { RouterSessionEntryData, TierName } from "../src/types.js";

const usage = (cost: number, cacheRead = 0) => ({ input: 100, output: 10, cacheRead, cacheWrite: 0, totalTokens: 110 + cacheRead, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const assistant = (model: string, cost: number, stopReason: "stop" | "error" = "stop"): AgentMessage => ({ role: "assistant", content: [], api: "openai-completions", provider: "test", model, usage: usage(cost), stopReason, timestamp: 1 });

function custom(id: string, data: RouterSessionEntryData): SessionEntry {
  return { type: "custom", id, parentId: null, timestamp: data.kind === "route" ? data.timestamp : "timestamp" in data ? data.timestamp : "now", customType: "switchyard", data };
}
function route(id: string, modelId: string, tier: TierName, audit = true): SessionEntry {
  const timestamp = `2026-01-01T00:00:0${id}.000Z`;
  return custom(`route-${id}`, {
    kind: "route", timestamp, prompt: "prompt",
    route: { threadId: "origin", threadName: "origin", tier, provider: "test", modelId, thinking: "high", decision: { requestId: `request-${id}`, target: "origin", tier, targetConfidence: 1, tierConfidence: 1, targetProbabilities: { origin: 1 }, tierProbabilities: { genius: 0, smart: tier === "smart" ? 1 : 0, handy: 0, cheap: tier === "cheap" ? 1 : 0 }, jevUsage: { inputTokens: 20, outputTokens: 4 } } },
    ...(audit ? { audit: { requestedTier: "cheap", requestedProvider: "test", requestedModelId: "B", reason: modelId === "B" ? "stable-downgrade" : "return-cost-not-covered", economics: { contextTokens: 1000, promptTokens: 10, warmCacheRatio: 0.9, warmCacheSource: "observed", cacheWriteRatio: 0, expectedOutputTokens: 10, incumbentRates: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 }, candidateRates: { input: 0.2, output: 0.2, cacheRead: 0.02, cacheWrite: 0.2 }, warmStayCostUsd: 0.01, coldSwitchCostUsd: 0.005, savingsUsd: 0.005, savingsRatio: 0.5 } } } : {}),
  });
}
function observed(id: string, modelId: string, cost: number, cacheRead = 0): SessionEntry {
  return custom(`observed-${id}`, { kind: "usage-observed", requestId: `request-${id}`, threadId: "origin", threadName: "origin", tier: modelId === "A" ? "smart" : "cheap", provider: "test", modelId, turnCount: 1, usage: usage(cost, cacheRead), reportedModels: [`test/${modelId}`], timestamp: `2026-01-01T00:00:1${id}.000Z` });
}

test("actual usage counts failed, retried, and proxy-substituted billed attempts", () => {
  let acc = createUsageAccumulator({ requestId: "r", threadId: "origin", threadName: "origin", tier: "smart", provider: "test", modelId: "A" });
  acc = accumulateAssistantTurn(acc, assistant("A", 0.2, "error"));
  acc = accumulateAssistantTurn(acc, assistant("B", 9));
  acc = accumulateAssistantTurn(acc, assistant("A", 0.3));
  acc = accumulateAssistantTurn(acc, {
    role: "toolResult", toolCallId: "nested", toolName: "nested-model", content: [], isError: false, timestamp: 2, usage: usage(0.2),
  });
  assert.equal(acc.turnCount, 3);
  assert.equal(acc.usage.cost.total, 9.7);
  assert.deepEqual(acc.reportedModels, ["test/A", "test/B"]);
  assert.equal(toPersistedUsageObserved(acc, "now").requestId, "r");
});

test("usage snapshot joins estimates to observations and detects A→B→A", () => {
  const entries = [route("1", "A", "smart"), observed("1", "A", 0.4, 900), route("2", "B", "cheap"), observed("2", "B", 0.1), route("3", "A", "smart"), observed("3", "A", 0.5)];
  const snapshot = buildUsageSnapshot(entries, "now");
  assert.equal(snapshot.recent.length, 3);
  assert.equal(snapshot.recent[1]?.estimatedWarmStayUsd, 0.01);
  assert.equal(snapshot.recent[1]?.observedUsage?.cost.total, 0.1);
  assert.equal(snapshot.switches[0]?.totalSwitches, 2);
  assert.equal(snapshot.switches[0]?.rapidReturns, 1);
  assert.equal(snapshot.jevOverhead.requestCount, 3);
  assert.equal(snapshot.totalsByThreadModel.reduce((sum, item) => sum + item.observedCostUsd, 0), 1);
});

test("duplicate durable observations cannot overwrite the first settled aggregate", () => {
  const first = observed("1", "A", 0.4);
  const duplicate = observed("1", "A", 99);
  const rows = buildUsageSnapshot([route("1", "A", "smart"), first, duplicate], "now").recent;
  assert.equal(rows[0]?.observedUsage?.cost.total, 0.4);
});

test("report distinguishes observed cost from counterfactual estimates", () => {
  const report = formatUsageReport(buildUsageSnapshot([route("1", "A", "smart"), observed("1", "A", 0.4)], "now"));
  assert.match(report, /estimated \(pre-request forecast\)/);
  assert.match(report, /observed \(actual billed usage\)/);
  assert.match(report, /not a measured saving/i);
  assert.doesNotMatch(report, /^measured savings?:/im);
});
