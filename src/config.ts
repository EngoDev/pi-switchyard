import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { TIER_NAMES, type RouterConfig, type TierConfig, type TierName } from "./types.js";

export const DEFAULT_CONFIG: RouterConfig = {
  version: 1,
  enabled: true,
  debug: false,
  tiers: {},
  routerContextMessages: 5,
  initialParentMessages: 5,
  targetConfidenceFloor: 0.45,
  tierConfidenceFloor: 0.45,
};

export type ConfigScope = "global" | "project";

export function getConfigPath(cwd: string, scope: ConfigScope): string {
  return scope === "global"
    ? join(getAgentDir(), "jev-router.json")
    : join(cwd, CONFIG_DIR_NAME, "jev-router.json");
}

function isTierConfig(value: unknown): value is TierConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TierConfig>;
  return (
    typeof candidate.provider === "string" &&
    candidate.provider.length > 0 &&
    typeof candidate.modelId === "string" &&
    candidate.modelId.length > 0 &&
    typeof candidate.thinking === "string"
  );
}

function normalizePartial(value: unknown): Partial<RouterConfig> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const tiers: Partial<Record<TierName, TierConfig>> = {};
  if (input.tiers && typeof input.tiers === "object") {
    const rawTiers = input.tiers as Record<string, unknown>;
    for (const tier of TIER_NAMES) {
      if (isTierConfig(rawTiers[tier])) tiers[tier] = rawTiers[tier];
    }
  }

  const result: Partial<RouterConfig> = { tiers };
  if (typeof input.enabled === "boolean") result.enabled = input.enabled;
  if (typeof input.debug === "boolean") result.debug = input.debug;
  if (typeof input.routerContextMessages === "number") {
    result.routerContextMessages = Math.max(1, Math.min(20, Math.trunc(input.routerContextMessages)));
  }
  if (typeof input.initialParentMessages === "number") {
    result.initialParentMessages = Math.max(1, Math.min(20, Math.trunc(input.initialParentMessages)));
  }
  if (typeof input.targetConfidenceFloor === "number") {
    result.targetConfidenceFloor = Math.max(0, Math.min(1, input.targetConfidenceFloor));
  }
  if (typeof input.tierConfidenceFloor === "number") {
    result.tierConfidenceFloor = Math.max(0, Math.min(1, input.tierConfidenceFloor));
  }
  return result;
}

function readConfigFile(path: string): Partial<RouterConfig> {
  if (!existsSync(path)) return {};
  try {
    return normalizePartial(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

export function loadConfig(cwd: string): RouterConfig {
  const globalConfig = readConfigFile(getConfigPath(cwd, "global"));
  const projectConfig = readConfigFile(getConfigPath(cwd, "project"));
  return {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
    version: 1,
    tiers: {
      ...DEFAULT_CONFIG.tiers,
      ...globalConfig.tiers,
      ...projectConfig.tiers,
    },
  };
}

export function writeConfig(cwd: string, scope: ConfigScope, config: RouterConfig): string {
  const path = getConfigPath(cwd, scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export function isConfigured(config: RouterConfig): config is RouterConfig & {
  tiers: Record<TierName, TierConfig>;
} {
  return TIER_NAMES.every((tier) => isTierConfig(config.tiers[tier]));
}
