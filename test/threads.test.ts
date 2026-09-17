import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
  filterMessagesForParent,
  filterMessagesForThread,
  getParentContext,
  makeThreadName,
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

test("parent context excludes tagged temp messages", () => {
  const messages: AgentMessage[] = [user("main", 1), assistant("main answer", 2), user("aside", 3, "t1")];
  assert.deepEqual(getParentContext(messages, 5).map((item) => item.text), ["main", "main answer"]);
  assert.deepEqual(filterMessagesForParent(messages).map((message) => message.timestamp), [1, 2]);
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

test("thread names are readable and unique", () => {
  assert.equal(makeThreadName("Did you create a PR for this?", []), "did-create-pr");
  assert.equal(makeThreadName("Did you create a PR for this?", ["did-create-pr"]), "did-create-pr-2");
});
