import assert from "node:assert/strict";
import test from "node:test";

import jevRouterExtension, { formatRouteStatus } from "../index.js";

test("exports a Pi extension factory", () => {
  assert.equal(typeof jevRouterExtension, "function");
});

test("debug status identifies thread, tier, model, and thinking", () => {
  const status = formatRouteStatus({
    threadId: "thread1",
    threadName: "pull-request",
    tier: "cheap",
    provider: "openai",
    modelId: "gpt-luna",
    thinking: "default",
    decision: {
      target: "thread1",
      tier: "cheap",
      targetConfidence: 0.9,
      tierConfidence: 0.9,
      targetProbabilities: { thread1: 0.9 },
      tierProbabilities: { genius: 0, smart: 0, handy: 0.1, cheap: 0.9 },
    },
  }, "high");
  assert.match(status, /temp:pull-request/);
  assert.match(status, /cheap/);
  assert.match(status, /openai\/gpt-luna/);
  assert.match(status, /high/);
});
