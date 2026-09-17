import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  getConfigPath,
  getLegacyConfigPath,
  isConfigured,
  loadConfig,
  writeConfig,
} from "../src/config.js";
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
  const cwd = mkdtempSync(join(tmpdir(), "switchyard-config-"));
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

test("legacy Jev Router project configuration remains readable", () => {
  const cwd = mkdtempSync(join(tmpdir(), "switchyard-legacy-config-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(getLegacyConfigPath(cwd, "project"), JSON.stringify(configured));
    const loaded = loadConfig(cwd, true);
    assert.equal(loaded.debug, true);
    assert.deepEqual(loaded.tiers, configured.tiers);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("untrusted project configuration is ignored", () => {
  const cwd = mkdtempSync(join(tmpdir(), "switchyard-untrusted-"));
  try {
    const globalOnly = loadConfig(cwd, false);
    writeConfig(cwd, "project", configured);
    const loaded = loadConfig(cwd, false);
    assert.deepEqual(loaded, globalOnly);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("missing model tiers leave automatic routing unconfigured", () => {
  assert.equal(isConfigured(DEFAULT_CONFIG), false);
});
