import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { TIER_NAMES, type RouterConfig, type TierConfig, type TierName } from "./types.js";

export const DEFAULT_CONFIG: RouterConfig = {
  version: 1,
  enabled: true,
  debug: false,
  tiers: {},
  routerContextMessages: 5,
  initialOriginMessages: 5,
  targetConfidenceFloor: 0.15,
  tierConfidenceFloor: 0.45,
};

export type ConfigScope = "global" | "project";
const THINKING_SELECTIONS = new Set([
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function getConfigPath(cwd: string, scope: ConfigScope): string {
  return scope === "global"
    ? join(getAgentDir(), "switchyard.json")
    : join(cwd, CONFIG_DIR_NAME, "switchyard.json");
}

export function getLegacyConfigPath(cwd: string, scope: ConfigScope): string {
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
    typeof candidate.thinking === "string" &&
    THINKING_SELECTIONS.has(candidate.thinking)
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
  const initialOriginMessages = typeof input.initialOriginMessages === "number"
    ? input.initialOriginMessages
    : input.initialParentMessages;
  if (typeof initialOriginMessages === "number") {
    result.initialOriginMessages = Math.max(1, Math.min(20, Math.trunc(initialOriginMessages)));
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

export function readScopeConfig(cwd: string, scope: ConfigScope): Partial<RouterConfig> {
  const legacy = readConfigFile(getLegacyConfigPath(cwd, scope));
  const current = readConfigFile(getConfigPath(cwd, scope));
  return {
    ...legacy,
    ...current,
    tiers: { ...legacy.tiers, ...current.tiers },
  };
}

export function loadConfig(cwd: string, includeProject = false): RouterConfig {
  const globalConfig = readScopeConfig(cwd, "global");
  const projectConfig = includeProject ? readScopeConfig(cwd, "project") : {};
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

function writeConfigValue(cwd: string, scope: ConfigScope, config: Partial<RouterConfig>): string {
  const path = getConfigPath(cwd, scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function writeConfig(cwd: string, scope: ConfigScope, config: RouterConfig): string {
  return writeConfigValue(cwd, scope, config);
}

export function writeConfigPatch(
  cwd: string,
  scope: ConfigScope,
  patch: Partial<RouterConfig>,
): string {
  const current = readScopeConfig(cwd, scope);
  const tiers = patch.tiers ? { ...current.tiers, ...patch.tiers } : current.tiers;
  const next: Partial<RouterConfig> = {
    ...current,
    ...patch,
    version: 1,
    ...(tiers ? { tiers } : {}),
  };
  return writeConfigValue(cwd, scope, next);
}

export function isConfigured(config: RouterConfig): config is RouterConfig & {
  tiers: Record<TierName, TierConfig>;
} {
  return TIER_NAMES.every((tier) => isTierConfig(config.tiers[tier]));
}
