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
  debug: "minimal",
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
    assert.equal(loaded.debug, "minimal");
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
    writeFileSync(getLegacyConfigPath(cwd, "project"), JSON.stringify({
      ...configured,
      debug: true,
    }));
    const loaded = loadConfig(cwd, true);
    assert.equal(loaded.debug, "minimal");
    assert.deepEqual(loaded.tiers, configured.tiers);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy debug booleans migrate to minimal and off", () => {
  const cwd = mkdtempSync(join(tmpdir(), "switchyard-debug-migration-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(getConfigPath(cwd, "project"), JSON.stringify({ debug: false }));
    assert.equal(loadConfig(cwd, true).debug, "off");
    writeFileSync(getConfigPath(cwd, "project"), JSON.stringify({ debug: true }));
    assert.equal(loadConfig(cwd, true).debug, "minimal");
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

test("temp thread limits load compatibly and normalize configured values", () => {
  const cwd = mkdtempSync(join(tmpdir(), "switchyard-limits-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(getConfigPath(cwd, "project"), JSON.stringify({
      tempThreadSoftTokenLimit: 500,
      tempThreadSoftTurnLimit: 0,
    }));
    const loaded = loadConfig(cwd, true);
    assert.equal(loaded.tempThreadSoftTokenLimit, 1_000);
    assert.equal(loaded.tempThreadSoftTurnLimit, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("sparse switching overrides preserve inherited thresholds and economics", () => {
  const cwd = mkdtempSync(join(tmpdir(), "switchyard-sparse-switching-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(getLegacyConfigPath(cwd, "project"), JSON.stringify({
      switching: {
        minSavingsRatio: 0.4,
        minSavingsUsd: 0.02,
        economics: {
          "custom/model": { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
        },
      },
    }));
    writeFileSync(getConfigPath(cwd, "project"), JSON.stringify({
      switching: { cacheAware: false },
    }));
    const loaded = loadConfig(cwd, true);
    assert.equal(loaded.switching.cacheAware, false);
    assert.equal(loaded.switching.minSavingsRatio, 0.4);
    assert.equal(loaded.switching.minSavingsUsd, 0.02);
    assert.equal(loaded.switching.economics["custom/model"]?.output, 8);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cache-aware switching policy and economics overrides round-trip", () => {
  const cwd = mkdtempSync(join(tmpdir(), "switchyard-economics-"));
  try {
    writeConfig(cwd, "project", {
      ...configured,
      switching: {
        ...DEFAULT_CONFIG.switching,
        downgradeConfidenceFloor: 0.8,
        minSavingsRatio: 0.3,
        economics: {
          "custom/model": {
            input: 2,
            output: 8,
            cacheRead: 0.2,
            cacheWrite: 2.5,
            tiers: [{
              inputTokensAbove: 200_000,
              input: 4,
              output: 12,
              cacheRead: 0.4,
              cacheWrite: 5,
            }],
          },
        },
      },
    });
    const loaded = loadConfig(cwd, true);
    assert.equal(loaded.switching.downgradeConfidenceFloor, 0.8);
    assert.equal(loaded.switching.minSavingsRatio, 0.3);
    assert.equal(loaded.switching.economics["custom/model"]?.tiers?.[0]?.input, 4);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("missing model tiers leave automatic routing unconfigured", () => {
  assert.equal(isConfigured(DEFAULT_CONFIG), false);
});
