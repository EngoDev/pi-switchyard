import assert from "node:assert/strict";
import test from "node:test";

import type { RouteClient } from "../src/router.js";
import { decideRoute, upgradeTier } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { RouterConfig, TempThread } from "../src/types.js";

const config: RouterConfig = {
  ...DEFAULT_CONFIG,
  tiers: {
    genius: { provider: "openai", modelId: "gpt-genius", thinking: "default" },
    smart: { provider: "openai", modelId: "gpt-smart", thinking: "high" },
    handy: { provider: "openai", modelId: "gpt-handy", thinking: "high" },
    cheap: { provider: "openai", modelId: "gpt-cheap", thinking: "off" },
  },
};

function mockClient(target: string, tier: string, targetConfidence = 0.9, tierConfidence = 0.9): RouteClient {
  return {
    systemOne: async () => ({
      answers: {
        target: {
          choice: target,
          confidence: targetConfidence,
          probabilities: { origin: 0.1, new_temp: 0.9, [target]: 0.9 },
        },
        tier: {
          choice: tier,
          confidence: tierConfidence,
          probabilities: { genius: 0, smart: 0.1, handy: 0.2, cheap: 0.7 },
        },
      },
    }),
  };
}

test("Jev unavailability returns undefined instead of choosing a fallback", async () => {
  const client: RouteClient = {
    systemOne: async () => {
      throw new Error("offline");
    },
  };
  const result = await decideRoute(client, {
    prompt: "Continue",
    hasImages: false,
    originContext: [],
    threads: [],
    config,
  });
  assert.equal(result, undefined);
});

test("maps dynamic temp Choice options back to thread IDs", async () => {
  const thread: TempThread = {
    id: "abc123",
    name: "pr-check",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    seedContext: [],
    firstPrompt: "Did you create a PR?",
  };
  const result = await decideRoute(mockClient("temp_abc123", "cheap"), {
    prompt: "Yes, create it",
    hasImages: false,
    originContext: [],
    threads: [thread],
    config,
  });
  assert.equal(result?.target, "abc123");
  assert.equal(result?.tier, "cheap");
});

test("low target confidence stays on origin and low tier confidence upgrades", async () => {
  const result = await decideRoute(mockClient("new_temp", "cheap", 0.1, 0.1), {
    prompt: "Do something ambiguous",
    hasImages: false,
    originContext: [],
    threads: [],
    config,
  });
  assert.equal(result?.target, "origin");
  assert.equal(result?.tier, "handy");
  assert.equal(upgradeTier("genius"), "genius");
});
