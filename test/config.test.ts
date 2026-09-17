import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, getConfigPath, isConfigured, loadConfig, writeConfig } from "../src/config.js";
import type { RouterConfig } from "../src/types.js";

const configured: RouterConfig = {
  ...DEFAULT_CONFIG,
  debug: true,
  tiers: {
    genius: { provider: "openai", modelId: "genius", thinking: "xhigh" },
    smart: { provider: "openai", modelId: "smart", thinking: "high" },
    handy: { provider: "openai", modelId: "handy", thinking: "medium" },
    cheap: { provider: "openai", modelId: "cheap", thinking: "default" },
  },
};

test("project configuration round-trips including debug and model tiers", () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-router-config-"));
  try {
    const path = writeConfig(cwd, "project", configured);
    assert.equal(path, getConfigPath(cwd, "project"));
    const loaded = loadConfig(cwd, true);
    assert.equal(loaded.debug, true);
    assert.deepEqual(loaded.tiers, configured.tiers);
    assert.equal(isConfigured(loaded), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("untrusted project configuration is ignored", () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-router-untrusted-"));
  try {
    writeConfig(cwd, "project", configured);
    const loaded = loadConfig(cwd, false);
    assert.equal(loaded.debug, DEFAULT_CONFIG.debug);
    assert.equal(isConfigured(loaded), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("missing model tiers leave automatic routing unconfigured", () => {
  assert.equal(isConfigured(DEFAULT_CONFIG), false);
});
