import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  TIER_NAMES,
  type ModelEconomics,
  type RouterConfig,
  type SwitchingConfig,
  type TierConfig,
  type TierName,
} from "./types.js";

export const DEFAULT_CONFIG: RouterConfig = {
  version: 1,
  enabled: true,
  debug: "off",
  tiers: {},
  routerContextMessages: 5,
  initialOriginMessages: 5,
  targetConfidenceFloor: 0.15,
  tierConfidenceFloor: 0.45,
  tempThreadSoftTokenLimit: 32_000,
  tempThreadSoftTurnLimit: 12,
  switching: {
    cacheAware: true,
    upgradesAlwaysSwitch: true,
    downgradeConfidenceFloor: 0.7,
    minSavingsRatio: 0.2,
    minSavingsUsd: 0.001,
    unknownCostPolicy: "stay",
    assumedWarmCacheRatio: 0.75,
    assumedCacheWriteRatio: 0.5,
    defaultExpectedOutputTokens: 800,
    downgradeMode: "enforce",
    evidenceDecay: 0.8,
    minimumEvidenceScore: 0.65,
    minimumEvidenceWeight: 1.5,
    hardRequirementPenalty: 1.5,
    forecastTurns: 3,
    returnProbabilityFloor: 0.25,
    returnCostMultiplier: 1,
    economics: {},
  },
};

export type ConfigScope = "global" | "project";
export type SwitchingConfigPatch = Partial<Omit<SwitchingConfig, "economics">> & {
  economics?: Record<string, ModelEconomics>;
};
type ConfigFragment = Omit<Partial<RouterConfig>, "switching"> & {
  switching?: SwitchingConfigPatch;
};
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

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeEconomics(value: unknown): ModelEconomics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const base = nonNegativeNumber(input.input);
  const output = nonNegativeNumber(input.output);
  const cacheRead = nonNegativeNumber(input.cacheRead);
  const cacheWrite = nonNegativeNumber(input.cacheWrite);
  if (base === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  const tiers = Array.isArray(input.tiers)
    ? input.tiers.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const tier = raw as Record<string, unknown>;
        const inputTokensAbove = nonNegativeNumber(tier.inputTokensAbove);
        const tierInput = nonNegativeNumber(tier.input);
        const tierOutput = nonNegativeNumber(tier.output);
        const tierCacheRead = nonNegativeNumber(tier.cacheRead);
        const tierCacheWrite = nonNegativeNumber(tier.cacheWrite);
        return inputTokensAbove === undefined
          || tierInput === undefined
          || tierOutput === undefined
          || tierCacheRead === undefined
          || tierCacheWrite === undefined
          ? []
          : [{
              inputTokensAbove: Math.trunc(inputTokensAbove),
              input: tierInput,
              output: tierOutput,
              cacheRead: tierCacheRead,
              cacheWrite: tierCacheWrite,
            }];
      })
    : [];
  return {
    input: base,
    output,
    cacheRead,
    cacheWrite,
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

function normalizeSwitching(value: unknown): SwitchingConfigPatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const switching: SwitchingConfigPatch = {};
  if (typeof input.cacheAware === "boolean") switching.cacheAware = input.cacheAware;
  if (typeof input.upgradesAlwaysSwitch === "boolean") switching.upgradesAlwaysSwitch = input.upgradesAlwaysSwitch;
  if (typeof input.downgradeConfidenceFloor === "number") {
    switching.downgradeConfidenceFloor = Math.max(0, Math.min(1, input.downgradeConfidenceFloor));
  }
  if (typeof input.minSavingsRatio === "number") {
    switching.minSavingsRatio = Math.max(0, Math.min(1, input.minSavingsRatio));
  }
  if (typeof input.minSavingsUsd === "number") switching.minSavingsUsd = Math.max(0, input.minSavingsUsd);
  if (input.unknownCostPolicy === "stay" || input.unknownCostPolicy === "switch") {
    switching.unknownCostPolicy = input.unknownCostPolicy;
  }
  if (typeof input.assumedWarmCacheRatio === "number") {
    switching.assumedWarmCacheRatio = Math.max(0, Math.min(1, input.assumedWarmCacheRatio));
  }
  if (typeof input.assumedCacheWriteRatio === "number") {
    switching.assumedCacheWriteRatio = Math.max(0, Math.min(1, input.assumedCacheWriteRatio));
  }
  if (typeof input.defaultExpectedOutputTokens === "number") {
    switching.defaultExpectedOutputTokens = Math.max(0, Math.min(1_000_000, Math.trunc(input.defaultExpectedOutputTokens)));
  }
  if (input.downgradeMode === "enforce" || input.downgradeMode === "shadow") {
    switching.downgradeMode = input.downgradeMode;
  }
  if (typeof input.evidenceDecay === "number") {
    switching.evidenceDecay = Math.max(0, Math.min(1, input.evidenceDecay));
  }
  if (typeof input.minimumEvidenceScore === "number") {
    switching.minimumEvidenceScore = Math.max(0, Math.min(1, input.minimumEvidenceScore));
  }
  if (typeof input.minimumEvidenceWeight === "number") {
    switching.minimumEvidenceWeight = Math.max(0, input.minimumEvidenceWeight);
  }
  if (typeof input.hardRequirementPenalty === "number") {
    switching.hardRequirementPenalty = Math.max(0, input.hardRequirementPenalty);
  }
  if (typeof input.forecastTurns === "number") {
    switching.forecastTurns = Math.max(1, Math.min(100, Math.trunc(input.forecastTurns)));
  }
  if (typeof input.returnProbabilityFloor === "number") {
    switching.returnProbabilityFloor = Math.max(0, Math.min(1, input.returnProbabilityFloor));
  }
  if (typeof input.returnCostMultiplier === "number") {
    switching.returnCostMultiplier = Math.max(0, input.returnCostMultiplier);
  }
  if (input.economics && typeof input.economics === "object") {
    const economicsOverrides: Record<string, ModelEconomics> = {};
    for (const [model, raw] of Object.entries(input.economics as Record<string, unknown>)) {
      const economics = normalizeEconomics(raw);
      if (economics) economicsOverrides[model] = economics;
    }
    switching.economics = economicsOverrides;
  }
  return switching;
}

function normalizePartial(value: unknown): ConfigFragment {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const tiers: Partial<Record<TierName, TierConfig>> = {};
  if (input.tiers && typeof input.tiers === "object") {
    const rawTiers = input.tiers as Record<string, unknown>;
    for (const tier of TIER_NAMES) {
      if (isTierConfig(rawTiers[tier])) tiers[tier] = rawTiers[tier];
    }
  }

  const result: ConfigFragment = { tiers };
  if (typeof input.enabled === "boolean") result.enabled = input.enabled;
  if (input.debug === "off" || input.debug === "minimal" || input.debug === "verbose") {
    result.debug = input.debug;
  } else if (typeof input.debug === "boolean") {
    result.debug = input.debug ? "minimal" : "off";
  }
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
  if (typeof input.tempThreadSoftTokenLimit === "number") {
    result.tempThreadSoftTokenLimit = input.tempThreadSoftTokenLimit <= 0
      ? 0
      : Math.max(1_000, Math.min(1_000_000, Math.trunc(input.tempThreadSoftTokenLimit)));
  }
  if (typeof input.tempThreadSoftTurnLimit === "number") {
    result.tempThreadSoftTurnLimit = input.tempThreadSoftTurnLimit <= 0
      ? 0
      : Math.max(1, Math.min(1_000, Math.trunc(input.tempThreadSoftTurnLimit)));
  }
  const switching = normalizeSwitching(input.switching);
  if (switching) result.switching = switching;
  return result;
}

function readConfigFile(path: string): ConfigFragment {
  if (!existsSync(path)) return {};
  try {
    return normalizePartial(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function mergeSwitching(base: SwitchingConfig, override?: SwitchingConfigPatch): SwitchingConfig {
  if (!override) return { ...base, economics: { ...base.economics } };
  return {
    ...base,
    ...override,
    economics: { ...base.economics, ...(override.economics ?? {}) },
  };
}

function mergeSwitchingFragments(
  base?: SwitchingConfigPatch,
  override?: SwitchingConfigPatch,
): SwitchingConfigPatch | undefined {
  if (!base && !override) return undefined;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
    economics: { ...(base?.economics ?? {}), ...(override?.economics ?? {}) },
  };
}

export function readScopeConfig(cwd: string, scope: ConfigScope): ConfigFragment {
  const legacy = readConfigFile(getLegacyConfigPath(cwd, scope));
  const current = readConfigFile(getConfigPath(cwd, scope));
  const switching = mergeSwitchingFragments(legacy.switching, current.switching);
  return {
    ...legacy,
    ...current,
    tiers: { ...legacy.tiers, ...current.tiers },
    ...(switching ? { switching } : {}),
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
    switching: mergeSwitching(
      mergeSwitching(DEFAULT_CONFIG.switching, globalConfig.switching),
      projectConfig.switching,
    ),
  };
}

function writeConfigValue(cwd: string, scope: ConfigScope, config: ConfigFragment | RouterConfig): string {
  const path = getConfigPath(cwd, scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function writeConfig(cwd: string, scope: ConfigScope, config: RouterConfig): string {
  return writeConfigValue(cwd, scope, config);
}

export function writeSwitchingPatch(
  cwd: string,
  scope: ConfigScope,
  patch: SwitchingConfigPatch,
): string {
  const current = readScopeConfig(cwd, scope);
  const switching = mergeSwitchingFragments(current.switching, patch) ?? patch;
  return writeConfigValue(cwd, scope, {
    ...current,
    version: 1,
    switching,
  });
}

export function writeConfigPatch(
  cwd: string,
  scope: ConfigScope,
  patch: Partial<RouterConfig>,
): string {
  const current = readScopeConfig(cwd, scope);
  const tiers = patch.tiers ? { ...current.tiers, ...patch.tiers } : current.tiers;
  const switching = patch.switching
    ? mergeSwitching(
        mergeSwitching(DEFAULT_CONFIG.switching, current.switching),
        patch.switching,
      )
    : current.switching;
  const next: ConfigFragment = {
    ...current,
    ...patch,
    version: 1,
    ...(tiers ? { tiers } : {}),
    ...(switching ? { switching } : {}),
  };
  return writeConfigValue(cwd, scope, next);
}

export function isConfigured(config: RouterConfig): config is RouterConfig & {
  tiers: Record<TierName, TierConfig>;
} {
  return TIER_NAMES.every((tier) => isTierConfig(config.tiers[tier]));
}
