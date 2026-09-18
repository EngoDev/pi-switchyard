import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildThreadSelectItems, buildThreadSummaryRows, formatThreadSummaryDescription, THREAD_ACTION_ITEMS } from "../src/thread-management.js";
import type { RouterSessionEntryData, TempThread } from "../src/types.js";

const thread: TempThread = { id: "t1", name: "pr-check", createdAt: new Date(1).toISOString(), updatedAt: new Date(1).toISOString(), firstPrompt: "PR?", seedContext: [] };
const custom = (data: RouterSessionEntryData): SessionEntry => ({ type: "custom", id: data.kind, parentId: null, timestamp: "timestamp" in data ? data.timestamp : "now", customType: "switchyard", data });

test("thread rows include incumbent and compaction-aware context stats", () => {
  const route = custom({ kind: "route", prompt: "PR?", timestamp: "now", route: { threadId: "t1", threadName: "pr-check", tier: "cheap", provider: "test", modelId: "luna", thinking: "low", decision: { requestId: "r", target: "t1", tier: "cheap", targetConfidence: 1, tierConfidence: 1, targetProbabilities: { t1: 1 }, tierProbabilities: { genius: 0, smart: 0, handy: 0, cheap: 1 } } } });
  const message: SessionEntry = { type: "message", id: "user", parentId: route.id, timestamp: "now", message: { role: "user", content: "check", timestamp: 2, switchyard: { threadId: "t1", threadName: "pr-check" } } as any };
  const row = buildThreadSummaryRows([route, message], [thread])[0]!;
  assert.equal(row.incumbentLabel, "cheap · test/luna");
  assert.equal(row.turns, 1);
  assert.ok(row.contextTokens > 0);
  assert.match(formatThreadSummaryDescription(row), /cheap.*tokens.*1 turn/);
  assert.deepEqual(buildThreadSelectItems([row])[0]?.value, "t1");
});

test("thread management exposes every explicit action", () => {
  assert.deepEqual(THREAD_ACTION_ITEMS.map((item) => item.value), ["inspect", "rename", "summarize", "promote", "retire"]);
});
