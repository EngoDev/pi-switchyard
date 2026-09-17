import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
  collectTempCompactionInput,
  COMPACTION_FILES_ENTRY_TYPE,
  compactOriginThread,
  compactTempThread,
  findPreviousOriginFileLists,
  type OriginCompactionInput,
} from "../src/compaction.js";
import type { TaggedAgentMessage } from "../src/types.js";

const user = (text: string, timestamp: number, threadId?: string): TaggedAgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
  ...(threadId ? { jevRouter: { threadId, threadName: "aside" } } : {}),
});

const assistantTool = (name: "read" | "write" | "edit", path: string, timestamp: number, threadId?: string): TaggedAgentMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id: `call-${timestamp}`, name, arguments: { path } }],
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
  ...(threadId ? { jevRouter: { threadId, threadName: "aside" } } : {}),
});

function input(messages: AgentMessage[], turnPrefixMessages: AgentMessage[] = []): OriginCompactionInput {
  return {
    messagesToSummarize: messages,
    turnPrefixMessages,
    previousSummary: undefined,
    firstKeptEntryId: "kept-entry",
    tokensBefore: 1234,
    customInstructions: undefined,
  };
}

test("origin-only sessions keep Pi's default compaction behavior", async () => {
  let summarizeCalls = 0;
  const result = await compactOriginThread(input([user("origin work", 1)]), async () => {
    summarizeCalls += 1;
    return { summary: "should not run" };
  });
  assert.deepEqual(result, { action: "default" });
  assert.equal(summarizeCalls, 0);
});

test("persisted temp custom messages are excluded from origin compaction", async () => {
  const persistedTempCustom: AgentMessage = {
    role: "custom",
    customType: "other-extension",
    content: "temp-only custom context",
    display: false,
    details: { jevRouter: { threadId: "temp1", threadName: "aside" } },
    timestamp: 2,
  };
  const result = await compactOriginThread(
    input([user("origin history", 1), persistedTempCustom]),
    async (request) => {
      assert.deepEqual(request.messages.map((message) => message.role), ["user"]);
      return { summary: "origin summary" };
    },
  );
  assert.equal(result.action, "compact");
});

test("mixed compaction summarizes only origin messages, including split-turn filtering", async () => {
  const request = input(
    [user("origin history", 1), user("temp history", 2, "temp1")],
    [user("origin split prefix", 3), user("temp split prefix", 4, "temp1")],
  );
  request.previousSummary = "previous origin summary";
  request.customInstructions = "Focus on decisions";

  const result = await compactOriginThread(request, async (summaryRequest) => {
    assert.deepEqual(summaryRequest.messages.map((message) => (message as any).content[0].text), [
      "origin history",
      "origin split prefix",
    ]);
    assert.equal(summaryRequest.previousSummary, "previous origin summary");
    assert.equal(summaryRequest.customInstructions, "Focus on decisions");
    return { summary: "origin-only summary" };
  });

  assert.equal(result.action, "compact");
  if (result.action !== "compact") return;
  assert.equal(result.compaction.summary, "origin-only summary");
  assert.equal(result.compaction.firstKeptEntryId, "kept-entry");
  assert.equal(result.compaction.tokensBefore, 1234);
  assert.equal(result.compaction.details.jevRouter.excludedTempMessages, 2);
});

test("mixed compaction preserves cumulative origin file tracking without temp files", async () => {
  const request = input([
    user("origin work", 1),
    assistantTool("read", "src/origin.ts", 2),
    assistantTool("write", "src/temp.ts", 3, "temp1"),
  ]);
  request.previousFileLists = {
    readFiles: ["src/previous-read.ts"],
    modifiedFiles: ["src/previous-edit.ts"],
  };
  const result = await compactOriginThread(request, async () => ({ summary: "summary" }));
  assert.equal(result.action, "compact");
  if (result.action !== "compact") return;
  assert.deepEqual(result.compaction.details.readFiles, ["src/origin.ts", "src/previous-read.ts"]);
  assert.deepEqual(result.compaction.details.modifiedFiles, ["src/previous-edit.ts"]);
  assert.match(result.compaction.summary, /<read-files>[\s\S]*src\/origin\.ts/);
  assert.match(result.compaction.summary, /<modified-files>[\s\S]*src\/previous-edit\.ts/);
  assert.doesNotMatch(result.compaction.summary, /temp\.ts/);
  assert.doesNotMatch(JSON.stringify(result.compaction.details), /temp\.ts/);
});

test("origin file tracking survives a safe custom to default compaction sequence", () => {
  const entries = [
    { type: "message" as const, id: "old", parentId: null, timestamp: new Date(1).toISOString(), message: user("old", 1) },
    { type: "message" as const, id: "keep1", parentId: "old", timestamp: new Date(2).toISOString(), message: user("keep one", 2) },
    {
      type: "compaction" as const,
      id: "custom",
      parentId: "keep1",
      timestamp: new Date(3).toISOString(),
      summary: "origin summary",
      firstKeptEntryId: "keep1",
      tokensBefore: 100,
      details: {
        readFiles: ["src/a.ts"],
        modifiedFiles: [],
        jevRouter: { threadAware: true },
      },
    },
    { type: "message" as const, id: "next", parentId: "custom", timestamp: new Date(4).toISOString(), message: user("next", 4) },
    { type: "message" as const, id: "keep2", parentId: "next", timestamp: new Date(5).toISOString(), message: user("keep two", 5) },
    {
      type: "compaction" as const,
      id: "default",
      parentId: "keep2",
      timestamp: new Date(6).toISOString(),
      summary: "updated summary",
      firstKeptEntryId: "keep2",
      tokensBefore: 200,
      details: { readFiles: [], modifiedFiles: ["src/b.ts"] },
    },
    {
      type: "custom" as const,
      id: "file-marker",
      parentId: "default",
      timestamp: new Date(7).toISOString(),
      customType: COMPACTION_FILES_ENTRY_TYPE,
      data: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
    },
  ];
  assert.deepEqual(findPreviousOriginFileLists(entries), {
    readFiles: ["src/a.ts"],
    modifiedFiles: ["src/b.ts"],
  });
});

test("an all-temp span preserves the previous origin summary without a model call", async () => {
  const request = input([user("temp only", 1, "temp1")]);
  request.previousSummary = "existing origin summary";
  let summarizeCalls = 0;
  const result = await compactOriginThread(request, async () => {
    summarizeCalls += 1;
    return { summary: "should not run" };
  });
  assert.equal(summarizeCalls, 0);
  assert.equal(result.action, "compact");
  if (result.action === "compact") assert.equal(result.compaction.summary, "existing origin summary");
});

test("temp compaction includes messages across interleaved global compaction boundaries", () => {
  const entries = [
    { type: "message" as const, id: "b1", parentId: null, timestamp: new Date(1).toISOString(), message: user("boundary one", 1) },
    {
      type: "compaction" as const,
      id: "c1",
      parentId: "b1",
      timestamp: new Date(2).toISOString(),
      summary: "origin one",
      firstKeptEntryId: "b1",
      tokensBefore: 100,
      details: {
        jevRouter: {
          threadAware: true,
          tempThreads: {
            temp1: { threadName: "aside", summary: "old temp summary", firstKeptEntryId: "b1" },
          },
        },
      },
    },
    { type: "message" as const, id: "mid", parentId: "c1", timestamp: new Date(3).toISOString(), message: user("between boundaries", 3, "temp1") },
    { type: "message" as const, id: "b2", parentId: "mid", timestamp: new Date(4).toISOString(), message: user("boundary two", 4) },
    {
      type: "compaction" as const,
      id: "c2",
      parentId: "b2",
      timestamp: new Date(5).toISOString(),
      summary: "origin two",
      firstKeptEntryId: "b2",
      tokensBefore: 200,
    },
    { type: "message" as const, id: "late", parentId: "c2", timestamp: new Date(6).toISOString(), message: user("after second compaction", 6, "temp1") },
    { type: "message" as const, id: "b3", parentId: "late", timestamp: new Date(7).toISOString(), message: user("current boundary", 7) },
  ];
  const collected = collectTempCompactionInput(entries, "temp1", "b3");
  assert.equal(collected.previousSummary, "old temp summary");
  assert.deepEqual(collected.messages.map((message) => (message as any).content[0].text), [
    "boundary one",
    "between boundaries",
    "boundary two",
    "after second compaction",
  ]);
});

test("active temp compaction summarizes only that temp thread", async () => {
  const result = await compactTempThread(
    {
      threadId: "temp1",
      threadName: "aside",
      messagesToSummarize: [
        user("origin work", 1),
        user("target temp", 2, "temp1"),
        user("other temp", 3, "temp2"),
      ],
      turnPrefixMessages: [user("target prefix", 4, "temp1")],
      previousSummary: "previous temp summary",
      firstKeptEntryId: "kept-entry",
      customInstructions: undefined,
    },
    async (request) => {
      assert.deepEqual(request.messages.map((message) => (message as any).content[0].text), [
        "target temp",
        "target prefix",
      ]);
      assert.equal(request.previousSummary, "previous temp summary");
      return { summary: "compacted temp summary" };
    },
  );
  assert.equal(result.action, "compact");
  if (result.action !== "compact") return;
  assert.equal(result.summary.summary, "compacted temp summary");
  assert.equal(result.summary.firstKeptEntryId, "kept-entry");
});

test("origin summarization failure cancels instead of falling back to mixed compaction", async () => {
  const result = await compactOriginThread(
    input([user("origin work", 1), user("temp aside", 2, "temp1")]),
    async () => {
      throw new Error("summarizer unavailable");
    },
  );
  assert.deepEqual(result, { action: "cancel", reason: "summarizer unavailable" });
});

test("an empty origin summary cancels compaction", async () => {
  const result = await compactOriginThread(
    input([user("origin work", 1), user("temp aside", 2, "temp1")]),
    async () => ({ summary: "  " }),
  );
  assert.deepEqual(result, { action: "cancel", reason: "Origin compaction summary was empty" });
});
