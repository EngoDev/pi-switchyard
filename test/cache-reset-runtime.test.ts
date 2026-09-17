import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { CACHE_RESET_CONSUMED, getCacheResetOpportunity, registerCacheResetDispatch } from "../src/cache-reset.js";

/** Real Pi agent loop and local HTTP transport; no paid models, real configs, or network credentials. */
async function fixture(automatic: boolean, failFirst = false, prePrompt = false) {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-reset-runtime-"));
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  const lifecycle: string[] = [];
  const opportunities: boolean[] = [];
  const models: string[] = [];
  let calls = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls++;
      lifecycle.push(`http-${calls}`);
      models.push(JSON.parse(Buffer.concat(chunks).toString()).model);
      // Record rather than throw in an async server callback.
      opportunities.push(Boolean(getCacheResetOpportunity(sm.getBranch(), "origin")));
      if (failFirst && calls === 1) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "intentional test failure" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const tool = automatic && !prePrompt && calls === 1;
      chunk({ id: `r${calls}`, object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: tool
        ? { role: "assistant", tool_calls: [{ index: 0, id: "noop-1", type: "function", function: { name: "noop", arguments: "{}" } }] }
        : { role: "assistant", content: "done" }, finish_reason: null }] });
      chunk({ id: `r${calls}`, object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: tool ? 2990 : 10, completion_tokens: 5, total_tokens: tool ? 2995 : 15 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let session: AgentSession | undefined;
  const settings = SettingsManager.inMemory({
    compaction: { enabled: automatic, keepRecentTokens: 40, reserveTokens: 100 },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.registerProvider("reset-fixture", {
        api: "openai-completions", apiKey: "dummy-local-only", baseUrl: `http://127.0.0.1:${port}/v1`,
        models: [{ id: "test-model", name: "test-model", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 3000, maxTokens: 500 }],
      });
      registerCacheResetDispatch(pi, () => "origin");
      pi.on("input", () => { lifecycle.push("input-preflight"); });
      pi.on("before_agent_start", (_event, ctx) => {
        lifecycle.push(getCacheResetOpportunity(ctx.sessionManager.getBranch(), "origin") ? "start-reset" : "start-normal");
      });
      pi.on("session_before_compact", (event) => ({
        compaction: { summary: "origin compacted", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore },
      }));
      pi.on("session_compact", () => { lifecycle.push("compacted"); });
    }],
  });
  try {
    await loader.reload();
    // Older history guarantees a cut exists; zero usage prevents pre-prompt automatic compaction.
    sm.appendMessage({ role: "user", content: "Old context ".repeat(100), timestamp: 1 });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Old reply ".repeat(100) }], api: "openai-completions", provider: "reset-fixture", model: "test-model", stopReason: "stop", timestamp: 2, usage: { input: prePrompt ? 2990 : 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: prePrompt ? 2991 : 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    sm.appendMessage({ role: "user", content: "Retained context", timestamp: 3 });
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: sm,
      tools: automatic ? ["noop"] : [],
      customTools: [{ name: "noop", label: "noop", description: "Test tool", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }],
    }));
    await session.bindExtensions({ mode: "print", onError: (error) => { throw new Error(error.error); } });
    await session.modelRuntime.setRuntimeApiKey("reset-fixture", "dummy-local-only");
    const fixtureModel = session.modelRuntime.getModel("reset-fixture", "test-model");
    assert.ok(fixtureModel);
    await session.setModel(fixtureModel);
    return {
      session, sm, lifecycle, opportunities, models,
      close: async () => {
        session?.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    session?.dispose(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); throw error;
  }
}

test("Pi manual compaction: first failed dispatch consumes reset; next user prompt is normal", { timeout: 20000 }, async () => {
  const f = await fixture(false, true);
  try {
    await f.session.compact();
    assert.ok(getCacheResetOpportunity(f.sm.getBranch(), "origin"));
    await f.session.prompt("first post-compaction request");
    assert.equal(getCacheResetOpportunity(f.sm.getBranch(), "origin"), undefined);
    await f.session.prompt("second post-compaction request");
    assert.deepEqual(f.lifecycle.filter((item) => item.startsWith("start-")), ["start-reset", "start-normal"]);
    assert.deepEqual(f.opportunities, [false, false], "receipt must exist before HTTP dispatch, not after response");
    assert.equal(f.sm.getBranch().filter((e) => e.type === "custom" && e.customType === CACHE_RESET_CONSUMED).length, 1);
    const reloaded = SessionManager.open(f.sm.getSessionFile()!);
    assert.equal(getCacheResetOpportunity(reloaded.getBranch(), "origin"), undefined);
  } finally { await f.close(); }
});

test("Pi pre-prompt compaction preserves preflight ordering and offers reset only to the pending request", { timeout: 20000 }, async () => {
  const f = await fixture(true, false, true);
  try {
    await f.session.prompt("pending user task");
    assert.deepEqual(f.lifecycle, ["input-preflight", "compacted", "start-reset", "http-1"]);
    await f.session.prompt("later user task");
    assert.deepEqual(f.lifecycle.slice(4), ["input-preflight", "start-normal", "http-2"]);
    assert.deepEqual(f.opportunities, [false, false]);
  } finally { await f.close(); }
});

test("Pi automatic compaction between tool turns consumes reset on the locked continuation", { timeout: 20000 }, async () => {
  const f = await fixture(true);
  try {
    await f.session.prompt("run noop and finish");
    assert.ok(f.lifecycle.includes("compacted"));
    assert.deepEqual(f.lifecycle.filter((item) => item.startsWith("start-")), ["start-normal"], "compaction continuation does not rerun routing");
    assert.deepEqual(f.models, ["test-model", "test-model"]);
    assert.deepEqual(f.opportunities, [false, false]);
    assert.equal(getCacheResetOpportunity(f.sm.getBranch(), "origin"), undefined);
    await f.session.prompt("next user request");
    assert.deepEqual(f.lifecycle.filter((item) => item.startsWith("start-")), ["start-normal", "start-normal"]);
  } finally { await f.close(); }
});
