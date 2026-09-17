import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
  filterMessagesForOrigin,
  filterMessagesForThread,
  findMissingTempLabels,
  getOriginContext,
  makeThreadName,
  messagesFromEntries,
  threadContextFromEntries,
} from "../src/threads.js";
import type { TaggedAgentMessage, TempThread } from "../src/types.js";

const user = (text: string, timestamp: number, threadId?: string): TaggedAgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
  ...(threadId ? { jevRouter: { threadId, threadName: "temp" } } : {}),
});

const assistant = (text: string, timestamp: number, threadId?: string): TaggedAgentMessage => ({
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
  stopReason: "stop",
  timestamp,
  ...(threadId ? { jevRouter: { threadId, threadName: "temp" } } : {}),
});

test("origin context excludes tagged temp prompts and assistant answers", () => {
  const messages: AgentMessage[] = [
    user("main", 1),
    assistant("main answer", 2),
    user("aside", 3, "t1"),
    assistant("temp answer", 4, "t1"),
  ];
  assert.deepEqual(getOriginContext(messages, 5).map((item) => item.text), ["main", "main answer"]);
  assert.deepEqual(filterMessagesForOrigin(messages).map((message) => message.timestamp), [1, 2]);
});

test("temp context contains a seed snapshot and only its own messages", () => {
  const thread: TempThread = {
    id: "t1",
    name: "pr-check",
    createdAt: new Date(10).toISOString(),
    updatedAt: new Date(10).toISOString(),
    firstPrompt: "Did you create a PR?",
    seedContext: [{ role: "user", text: "Implement routing", timestamp: 1 }],
  };
  const messages: AgentMessage[] = [user("main", 1), user("aside", 2, "t1"), assistant("no PR", 3, "t1"), user("other", 4, "t2")];
  const filtered = filterMessagesForThread(messages, thread);
  assert.equal(filtered.length, 3);
  assert.match(JSON.stringify(filtered[0]), /Implement routing/);
  assert.deepEqual(filtered.slice(1).map((message) => message.timestamp), [2, 3]);
});

test("temp history remains recoverable from the full branch after origin compaction", () => {
  const thread: TempThread = {
    id: "t1",
    name: "pr-check",
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
    firstPrompt: "Did you create a PR?",
    seedContext: [],
  };
  const tempMessage = {
    type: "message" as const,
    id: "temp-user",
    parentId: null,
    timestamp: new Date(2).toISOString(),
    message: user("old temp message", 2, "t1"),
  };
  const compaction = {
    type: "compaction" as const,
    id: "compact",
    parentId: "temp-user",
    timestamp: new Date(3).toISOString(),
    summary: "origin-only summary",
    firstKeptEntryId: "temp-user",
    tokensBefore: 100,
  };
  const context = threadContextFromEntries([tempMessage, compaction], thread);
  assert.match(JSON.stringify(context), /old temp message/);
});

test("temp compaction summary replaces old temp messages and keeps retained tail", () => {
  const thread: TempThread = {
    id: "t1",
    name: "pr-check",
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
    firstPrompt: "Did you create a PR?",
    seedContext: [],
  };
  const entries = [
    {
      type: "message" as const,
      id: "old-temp",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: user("summarized old temp", 1, "t1"),
    },
    {
      type: "message" as const,
      id: "kept-origin",
      parentId: "old-temp",
      timestamp: new Date(2).toISOString(),
      message: user("origin boundary", 2),
    },
    {
      type: "message" as const,
      id: "kept-temp",
      parentId: "kept-origin",
      timestamp: new Date(3).toISOString(),
      message: user("retained temp", 3, "t1"),
    },
    {
      type: "compaction" as const,
      id: "compact",
      parentId: "kept-temp",
      timestamp: new Date(4).toISOString(),
      summary: "origin summary",
      firstKeptEntryId: "kept-origin",
      tokensBefore: 100,
      details: {
        readFiles: [],
        modifiedFiles: [],
        jevRouter: {
          threadAware: true,
          tempThreads: {
            t1: {
              threadName: "pr-check",
              summary: "temp summary",
              firstKeptEntryId: "kept-origin",
            },
          },
        },
      },
    },
    {
      type: "message" as const,
      id: "failed-temp",
      parentId: "compact",
      timestamp: new Date(5).toISOString(),
      message: { ...assistant("overflow failure", 5, "t1"), stopReason: "error" as const },
    },
    {
      type: "message" as const,
      id: "post-temp",
      parentId: "failed-temp",
      timestamp: new Date(6).toISOString(),
      message: user("post-compaction temp", 6, "t1"),
    },
  ];
  const context = threadContextFromEntries(entries, thread);
  const serialized = JSON.stringify(context);
  assert.match(serialized, /temp summary/);
  assert.match(serialized, /retained temp/);
  assert.match(serialized, /post-compaction temp/);
  assert.doesNotMatch(serialized, /summarized old temp|overflow failure/);
});

test("finds temp prompts and answers that need visible tree labels", () => {
  const userEntry = {
    type: "message" as const,
    id: "temp-user",
    parentId: null,
    timestamp: new Date(1).toISOString(),
    message: user("aside", 1, "t1"),
  };
  const answerEntry = {
    type: "message" as const,
    id: "temp-answer",
    parentId: "temp-user",
    timestamp: new Date(2).toISOString(),
    message: assistant("temp answer", 2, "t1"),
  };
  assert.deepEqual(findMissingTempLabels([userEntry, answerEntry], () => undefined), [
    { entryId: "temp-user", label: "temp:temp" },
    { entryId: "temp-answer", label: "temp:temp" },
  ]);
  assert.deepEqual(findMissingTempLabels([userEntry, answerEntry], () => "already-labeled"), []);
});

test("custom-message temp metadata is restored from persisted details", () => {
  const messages = messagesFromEntries([{
    type: "custom_message",
    id: "entry1",
    parentId: null,
    timestamp: new Date(1).toISOString(),
    customType: "other-extension",
    content: "temp context",
    display: false,
    details: { jevRouter: { threadId: "t1", threadName: "temp" } },
  }]);
  assert.equal((messages[0] as TaggedAgentMessage | undefined)?.jevRouter?.threadId, "t1");
  assert.deepEqual(filterMessagesForOrigin(messages), []);
});

test("thread names are readable and unique", () => {
  assert.equal(makeThreadName("Did you create a PR for this?", []), "did-create-pr");
  assert.equal(makeThreadName("Did you create a PR for this?", ["did-create-pr"]), "did-create-pr-2");
});
