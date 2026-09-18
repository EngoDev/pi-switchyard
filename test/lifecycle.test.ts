import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG } from "../src/config.js";
import {
  ensurePromotionMessagesDurable,
  estimateTempThreadStats,
  fingerprintImages,
  formatTempThreadHandoff,
  isSwitchyardHandoffPersisted,
  projectTempThreadBudget,
} from "../src/lifecycle.js";
import {
  findPendingPromotedPrompt,
  findRecoverableLifecycle,
  findRecoverablePromotion,
  findThreadBranchPoint,
  messagesForPromotedSession,
  restoreThreads,
} from "../src/threads.js";
import type { RouterSessionEntryData, TaggedAgentMessage, TempThread } from "../src/types.js";

const thread: TempThread = {
  id: "t1",
  name: "oauth-check",
  createdAt: new Date(1).toISOString(),
  updatedAt: new Date(1).toISOString(),
  seedContext: [{ role: "user", text: "Implement authentication", timestamp: 0 }],
  firstPrompt: "Why did OAuth fail?",
};

const user = (text: string, timestamp: number, threadId?: string): TaggedAgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
  ...(threadId ? { switchyard: { threadId, threadName: "oauth-check" } } : {}),
});

const assistant = (text: string, timestamp: number, threadId?: string, stopReason: "stop" | "error" = "stop"): TaggedAgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp,
  ...(threadId ? { switchyard: { threadId, threadName: "oauth-check" } } : {}),
});

function messageEntry(id: string, message: AgentMessage, parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

function customEntry(id: string, data: RouterSessionEntryData, parentId: string | null = null): SessionEntry {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: new Date(1).toISOString(),
    customType: "switchyard",
    data,
  };
}

test("temp budget projects the held prompt and checks token and turn soft limits", () => {
  const entries = [messageEntry("u1", user("Why did OAuth fail?", 1, "t1"))];
  const byTurns = projectTempThreadBudget(entries, thread, "Could logout fail too?", undefined, {
    ...DEFAULT_CONFIG,
    tempThreadSoftTokenLimit: 0,
    tempThreadSoftTurnLimit: 2,
  });
  assert.equal(byTurns.turns, 2);
  assert.equal(byTurns.turnLimitExceeded, true);
  assert.equal(byTurns.exceeded, true);

  const byTokens = projectTempThreadBudget(entries, thread, "x".repeat(8_000), undefined, {
    ...DEFAULT_CONFIG,
    tempThreadSoftTokenLimit: 1,
    tempThreadSoftTurnLimit: 0,
  });
  assert.equal(byTokens.tokenLimitExceeded, true);
  assert.ok(byTokens.tokens > 1);
});

test("estimateTempThreadStats reports the same context/turns projectTempThreadBudget uses, without a hypothetical prompt", () => {
  const entries = [
    messageEntry("u1", user("Why did OAuth fail?", 1, "t1")),
    messageEntry("a1", assistant("Checked the logs", 2, "t1"), "u1"),
  ];
  const stats = estimateTempThreadStats(entries, thread);
  assert.equal(stats.turns, 1);
  assert.ok(stats.tokens > 0);

  const budget = projectTempThreadBudget(entries, thread, "Could logout fail too?", undefined, {
    ...DEFAULT_CONFIG,
    tempThreadSoftTokenLimit: 0,
    tempThreadSoftTurnLimit: 0,
  });
  assert.equal(budget.turns, stats.turns + 1);
  assert.ok(budget.tokens > stats.tokens);
});

test("isSwitchyardHandoffPersisted only matches a handoff custom message tagged with the given operation id", () => {
  const handoffEntry = (id: string, operationId: string): SessionEntry => ({
    type: "custom_message",
    id,
    parentId: null,
    timestamp: new Date(1).toISOString(),
    customType: "switchyard-handoff",
    content: "handoff text",
    display: true,
    details: { switchyardHandoff: { operationId, sourceThreadId: "t1", sourceThreadName: "oauth-check" } },
  });
  assert.equal(isSwitchyardHandoffPersisted([handoffEntry("h1", "op-1")], "op-1"), true);
  assert.equal(isSwitchyardHandoffPersisted([handoffEntry("h1", "op-1")], "op-2"), false);
  assert.equal(isSwitchyardHandoffPersisted([], "op-1"), false);
  const unrelated: SessionEntry = {
    type: "custom_message",
    id: "other",
    parentId: null,
    timestamp: new Date(1).toISOString(),
    customType: "other-extension",
    content: "unrelated",
    display: false,
  };
  assert.equal(isSwitchyardHandoffPersisted([unrelated], "op-1"), false);
});

test("image fingerprints change when transformed attachments change", () => {
  const first = [{ type: "image" as const, mimeType: "image/png", data: "aaa" }];
  const second = [{ type: "image" as const, mimeType: "image/png", data: "bbb" }];
  assert.notEqual(fingerprintImages(first), fingerprintImages(second));
  assert.equal(fingerprintImages(undefined), "none");
});

test("promotion always includes an assistant entry so Pi persists the child before source completion", () => {
  const model = {
    id: "test-model",
    name: "test-model",
    api: "openai-responses" as const,
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  const durable = ensurePromotionMessagesDurable([user("only user", 1, "t1")], model);
  assert.equal(durable.some((message) => message.role === "assistant"), true);
  const sessionDir = mkdtempSync(join(tmpdir(), "switchyard-promoted-session-"));
  try {
    const manager = SessionManager.create(process.cwd(), sessionDir);
    for (const message of durable) {
      manager.appendMessage(message as Parameters<typeof manager.appendMessage>[0]);
    }
    assert.equal(existsSync(manager.getSessionFile() ?? ""), true);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
  const existing = [user("user", 1, "t1"), assistant("answer", 2, "t1")];
  assert.equal(ensurePromotionMessagesDurable(existing, model).length, existing.length);
});

test("handoff is explicitly attributed to the retired temp thread", () => {
  const handoff = formatTempThreadHandoff(thread, "Race condition found.");
  assert.match(handoff, /Switchyard handoff from temp:oauth-check/);
  assert.match(handoff, /<summary>\nRace condition found\.\n<\/summary>/);
});

test("promotion transfers only replayable messages from one temp and removes routing metadata", () => {
  const entries = [
    messageEntry("origin", user("origin work", 1)),
    messageEntry("temp-user", user("OAuth detail", 2, "t1"), "origin"),
    messageEntry("temp-answer", assistant("OAuth answer", 3, "t1"), "temp-user"),
    messageEntry("failed", assistant("failed output", 4, "t1", "error"), "temp-answer"),
    messageEntry("other", user("other temp", 5, "t2"), "failed"),
  ];
  const promoted = messagesForPromotedSession(entries, thread);
  const serialized = JSON.stringify(promoted);
  assert.match(serialized, /Implement authentication/);
  assert.match(serialized, /OAuth detail/);
  assert.match(serialized, /OAuth answer/);
  assert.doesNotMatch(serialized, /origin work|failed output|other temp|switchyard|jevRouter/);
  assert.equal(findThreadBranchPoint(entries, "t1"), "origin");
});

test("held lifecycle prompts remain recoverable until completed or durably submitted", () => {
  const pending = customEntry("lifecycle-pending", {
    kind: "lifecycle-pending",
    token: "lifecycle1",
    pendingPrompt: "Continue the investigation",
    pendingImageCount: 1,
    timestamp: new Date(1).toISOString(),
  });
  assert.deepEqual(findRecoverableLifecycle([pending]), {
    token: "lifecycle1",
    prompt: "Continue the investigation",
    imageCount: 1,
  });
  const completed = customEntry("lifecycle-completed", {
    kind: "lifecycle-completed",
    token: "lifecycle1",
    timestamp: new Date(2).toISOString(),
  }, "lifecycle-pending");
  assert.equal(findRecoverableLifecycle([pending, completed]), undefined);
  assert.equal(findRecoverableLifecycle([
    pending,
    messageEntry("submitted-user", user("Continue the investigation", 3), "lifecycle-pending"),
  ]), undefined);
});

test("retired temps stay archived and promoted-session origin forcing is consumed by a route", () => {
  const created = customEntry("created", { kind: "thread-created", thread });
  const retired = customEntry("retired", {
    kind: "thread-retired",
    threadId: thread.id,
    threadName: thread.name,
    reason: "summarized-to-origin",
    timestamp: new Date(2).toISOString(),
  }, "created");
  assert.equal(restoreThreads([created, retired]).size, 0);

  const promotionPending = customEntry("promotion-pending", {
    kind: "promotion-pending",
    token: "token1",
    thread,
    pendingPrompt: "Continue the investigation",
    pendingImageCount: 2,
    timestamp: new Date(3).toISOString(),
  }, "retired");
  const promotionRetired = customEntry("promotion-retired", {
    kind: "thread-retired",
    threadId: thread.id,
    threadName: thread.name,
    reason: "promoted",
    timestamp: new Date(3).toISOString(),
  }, "promotion-pending");
  assert.equal(restoreThreads([created, promotionPending, promotionRetired]).size, 1);
  assert.deepEqual(findRecoverablePromotion([promotionPending]), {
    token: "token1",
    thread,
    prompt: "Continue the investigation",
    imageCount: 2,
  });
  const laterRetirement = customEntry("later-retirement", {
    kind: "thread-retired",
    threadId: thread.id,
    threadName: thread.name,
    reason: "summarized-to-origin",
    timestamp: new Date(4).toISOString(),
  }, "retired");
  assert.equal(restoreThreads([created, promotionPending, promotionRetired, laterRetirement]).size, 0);
  assert.equal(findRecoverablePromotion([promotionPending, promotionRetired, laterRetirement]), undefined);

  const promotionCompleted = customEntry("promotion-completed", {
    kind: "promotion-completed",
    token: "token1",
    outcome: "completed",
    timestamp: new Date(4).toISOString(),
  }, "retired");
  assert.equal(restoreThreads([created, promotionPending, promotionRetired, promotionCompleted]).size, 0);
  assert.equal(findRecoverablePromotion([promotionPending, promotionCompleted]), undefined);

  const restoredBeforeCompletion = customEntry("restored-thread", {
    kind: "thread-created",
    thread,
  }, "promotion-retired");
  const cancelledCompletion = customEntry("cancelled-completion", {
    kind: "promotion-completed",
    token: "token1",
    outcome: "cancelled",
    timestamp: new Date(5).toISOString(),
  }, "restored-thread");
  assert.equal(restoreThreads([
    created,
    promotionPending,
    promotionRetired,
    restoredBeforeCompletion,
  ]).size, 1);
  assert.equal(restoreThreads([
    created,
    promotionPending,
    promotionRetired,
    restoredBeforeCompletion,
    cancelledCompletion,
  ]).size, 1);

  const promoted = customEntry("promoted", {
    kind: "promoted-session",
    token: "child-token",
    sourceThreadId: thread.id,
    sourceThreadName: thread.name,
    pendingPrompt: "Continue the investigation",
    pendingImageCount: 1,
  });
  assert.deepEqual(findPendingPromotedPrompt([promoted]), {
    token: "child-token",
    prompt: "Continue the investigation",
    imageCount: 1,
  });
  const consumed = customEntry("consumed", {
    kind: "promotion-consumed",
    token: "child-token",
    pendingPrompt: "Continue the investigation",
    timestamp: new Date(2).toISOString(),
  }, "promoted");
  assert.equal(findPendingPromotedPrompt([promoted, consumed]), undefined);
  assert.equal(findPendingPromotedPrompt([
    promoted,
    messageEntry("durable-user", user("expanded promoted request", 5), "promoted"),
  ]), undefined);

  const route = customEntry("route", {
    kind: "route",
    route: {
      threadId: "origin",
      threadName: "origin",
      tier: "smart",
      provider: "openai",
      modelId: "test",
      thinking: "high",
      decision: {
        target: "origin",
        tier: "smart",
        targetConfidence: 1,
        tierConfidence: 1,
        targetProbabilities: { origin: 1 },
        tierProbabilities: { genius: 0, smart: 1, handy: 0, cheap: 0 },
      },
    },
    prompt: "Continue the investigation",
    timestamp: new Date(3).toISOString(),
  }, "promoted");
  assert.equal(findPendingPromotedPrompt([promoted, route]), undefined);
});
