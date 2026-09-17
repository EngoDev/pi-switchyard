import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { TaggedAgentMessage } from "../src/types.js";
import { summarizeOriginBranch, type OriginBranchSummaryInput } from "../src/tree-summary.js";

const user = (text: string, timestamp: number, threadId?: string): TaggedAgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
  ...(threadId ? { switchyard: { threadId, threadName: "aside" } } : {}),
});

const assistantTool = (path: string, timestamp: number, threadId?: string): TaggedAgentMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id: `call-${timestamp}`, name: "read", arguments: { path } }],
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
  stopReason: "toolUse",
  timestamp,
  ...(threadId ? { switchyard: { threadId, threadName: "aside" } } : {}),
});

const messageEntry = (id: string, message: TaggedAgentMessage, parentId: string | null = null) => ({
  type: "message" as const,
  id,
  parentId,
  timestamp: new Date(message.timestamp).toISOString(),
  message,
});

function input(entries: SessionEntry[], userWantsSummary = true): OriginBranchSummaryInput {
  return {
    entriesToSummarize: entries,
    userWantsSummary,
    customInstructions: undefined,
    replaceInstructions: undefined,
  };
}

test("tree navigation without a requested summary remains untouched", async () => {
  let calls = 0;
  const result = await summarizeOriginBranch(
    input([messageEntry("temp", user("aside", 1, "t1"))], false),
    async () => {
      calls += 1;
      return { summary: "unused" };
    },
  );
  assert.deepEqual(result, { action: "default" });
  assert.equal(calls, 0);
});

test("origin-only abandoned branches keep Pi's default summary behavior", async () => {
  let calls = 0;
  const result = await summarizeOriginBranch(
    input([messageEntry("origin", user("origin work", 1))]),
    async () => {
      calls += 1;
      return { summary: "unused" };
    },
  );
  assert.deepEqual(result, { action: "default" });
  assert.equal(calls, 0);
});

test("mixed branches summarize only origin messages and honor custom instructions", async () => {
  const request = input([
    messageEntry("origin", user("origin work", 1)),
    messageEntry("temp", user("temp aside", 2, "t1"), "origin"),
  ]);
  request.customInstructions = "Focus on decisions";
  request.replaceInstructions = true;
  const result = await summarizeOriginBranch(request, async (summaryRequest) => {
    assert.deepEqual(summaryRequest.messages.map((message) => (message as any).content[0].text), ["origin work"]);
    assert.equal(summaryRequest.customInstructions, "Focus on decisions");
    assert.equal(summaryRequest.replaceInstructions, true);
    return { summary: "origin branch summary" };
  });
  assert.equal(result.action, "summary");
  if (result.action !== "summary") return;
  assert.equal(result.summary.summary, "origin branch summary");
  assert.equal(result.summary.details.switchyard.excludedTempMessages, 1);
});

test("persisted temp custom messages are excluded from tree summaries", async () => {
  const customEntry: SessionEntry = {
    type: "custom_message",
    id: "custom-temp",
    parentId: "origin",
    timestamp: new Date(2).toISOString(),
    customType: "other-extension",
    content: "temp custom context",
    display: false,
    details: { switchyard: { threadId: "t1", threadName: "aside" } },
  };
  const result = await summarizeOriginBranch(
    input([messageEntry("origin", user("origin work", 1)), customEntry]),
    async (summaryRequest) => {
      assert.deepEqual(summaryRequest.messages.map((message) => message.role), ["user"]);
      return { summary: "origin only" };
    },
  );
  assert.equal(result.action, "summary");
});

test("an all-temp abandoned branch produces a deterministic origin placeholder", async () => {
  let calls = 0;
  const result = await summarizeOriginBranch(
    input([messageEntry("temp", user("temp only", 1, "t1"))]),
    async () => {
      calls += 1;
      return { summary: "unused" };
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.action, "summary");
  if (result.action === "summary") assert.match(result.summary.summary, /No origin-session work/);
});

test("tree summaries preserve origin file tags without temp-only files", async () => {
  const result = await summarizeOriginBranch(
    input([
      messageEntry("origin", user("origin work", 1)),
      messageEntry("origin-read", assistantTool("src/origin.ts", 2), "origin"),
      messageEntry("temp-read", assistantTool("src/temp.ts", 3, "t1"), "origin-read"),
    ]),
    async () => ({ summary: "summary" }),
  );
  assert.equal(result.action, "summary");
  if (result.action !== "summary") return;
  assert.match(result.summary.summary, /<read-files>[\s\S]*src\/origin\.ts/);
  assert.doesNotMatch(result.summary.summary, /temp\.ts/);
  assert.deepEqual(result.summary.details.readFiles, ["src/origin.ts"]);
});

test("tree summary failure cancels navigation rather than using a mixed fallback", async () => {
  const result = await summarizeOriginBranch(
    input([
      messageEntry("origin", user("origin work", 1)),
      messageEntry("temp", user("temp aside", 2, "t1"), "origin"),
    ]),
    async () => {
      throw new Error("summary unavailable");
    },
  );
  assert.deepEqual(result, { action: "cancel", reason: "summary unavailable" });
});
