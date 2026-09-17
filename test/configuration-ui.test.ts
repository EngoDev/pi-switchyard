import assert from "node:assert/strict";
import test from "node:test";

import type { Model } from "@earendil-works/pi-ai";

import {
  buildCategoryItems,
  getThinkingSelections,
  MODEL_PICKER_MAX_VISIBLE,
} from "../src/configuration-ui.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { filterPickerItems } from "../src/picker.js";

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

test("category menu shows every tier's current model and thinking", () => {
  const items = buildCategoryItems({
    ...DEFAULT_CONFIG,
    tiers: {
      genius: { provider: "openai", modelId: "gpt-astra", thinking: "xhigh" },
      cheap: { provider: "openai", modelId: "gpt-luna", thinking: "default" },
    },
  });
  assert.equal(items[0]?.label, "genius");
  assert.match(items[0]?.description ?? "", /openai\/gpt-astra.*xhigh/);
  assert.equal(items[1]?.description, "not configured");
  assert.match(items[3]?.description ?? "", /openai\/gpt-luna.*default/);
});

test("model picker is bounded and filters across labels and descriptions", () => {
  assert.equal(MODEL_PICKER_MAX_VISIBLE, 10);
  const items = [
    { value: "openai/gpt-luna", label: "gpt-luna", description: "openai · fast model" },
    { value: "anthropic/opus", label: "opus", description: "anthropic · deep model" },
  ];
  assert.deepEqual(filterPickerItems(items, "anthropic").map((item) => item.value), ["anthropic/opus"]);
  assert.deepEqual(filterPickerItems(items, "luna").map((item) => item.value), ["openai/gpt-luna"]);
});
