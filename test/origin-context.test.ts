import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { formatOriginContextResult, selectOriginContext } from "../src/origin-context.js";
import type { TaggedAgentMessage } from "../src/types.js";

const user = (text: string, timestamp: number, threadId?: string): TaggedAgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
  ...(threadId ? { switchyard: { threadId, threadName: "temp" } } : {}),
});

const assistant = (text: string, timestamp: number): AgentMessage => ({
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
});

const toolResult = (text: string, timestamp: number): AgentMessage => ({
  role: "toolResult",
  toolCallId: `call-${timestamp}`,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError: false,
  timestamp,
});

test("retrieves bounded origin context newest first and excludes temp messages", () => {
  const messages = [
    user("implement router", 1),
    assistant("working on router", 2),
    toolResult("secret output", 3),
    user("did you make a PR", 4, "temp1"),
    user("add debug mode", 5),
  ];
  const items = selectOriginContext(messages, { limit: 2 });
  assert.deepEqual(items.map((item) => item.text), ["add debug mode", "working on router"]);
});

test("supports role, query, offset, order, and tool-result filters", () => {
  const messages = [user("first", 1), toolResult("build passed", 2), assistant("second", 3)];
  assert.deepEqual(
    selectOriginContext(messages, {
      query: "build",
      roles: ["toolResult"],
      includeToolResults: true,
      order: "oldest",
      offset: 0,
      limit: 10,
    }).map((item) => item.text),
    ["build passed"],
  );
  assert.equal(selectOriginContext(messages, { order: "oldest", offset: 1, limit: 1 })[0]?.text, "second");
});

test("formats context with roles and tool names", () => {
  const text = formatOriginContextResult([
    { role: "toolResult", toolName: "bash", text: "ok", timestamp: 1 },
  ]);
  assert.match(text, /toolResult:bash/);
  assert.match(text, /ok/);
});
