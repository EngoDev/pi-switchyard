import assert from "node:assert/strict";
import test from "node:test";

import type { Model } from "@earendil-works/pi-ai";

import { getThinkingSelections } from "../src/configuration-ui.js";

function model(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    id: "test",
    name: "test",
    api: "openai-responses",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...overrides,
  };
}

test("thinking selector offers only off for non-reasoning models", () => {
  assert.deepEqual(getThinkingSelections(model({ reasoning: false })), ["default", "off"]);
});

test("thinking selector respects unsupported and extended levels", () => {
  assert.deepEqual(
    getThinkingSelections(model({
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    })),
    ["default", "low", "medium", "high", "xhigh"],
  );
});
