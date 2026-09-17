import type { Model, ModelCostRates } from "@earendil-works/pi-ai";

import type {
  SwitchingConfig,
  TierConfig,
  TierName,
} from "./types.js";

const CAPABILITY_ORDER: TierName[] = ["cheap", "handy", "smart", "genius"];

export interface RoutedModel {
  tier: TierName;
  tierConfig: TierConfig;
  model: Model<any>;
}

export interface ModelSwitchInput {
  incumbent: RoutedModel | undefined;
  candidate: RoutedModel;
  tierConfidence: number;
  contextTokens: number;
  promptTokens: number;
  warmCacheRatio: number | undefined;
  cacheWriteRatio?: number;
  expectedOutputTokens: number;
  config: SwitchingConfig;
}

export type ModelSwitchReason =
  | "cache-awareness-disabled"
  | "new-thread"
  | "same-model"
  | "capability-upgrade"
  | "low-downgrade-confidence"
  | "unknown-economics-stay"
  | "unknown-economics-switch"
  | "material-savings"
  | "insufficient-savings";

export interface SwitchEconomics {
  contextTokens: number;
  promptTokens: number;
  warmCacheRatio: number;
  cacheWriteRatio: number;
  expectedOutputTokens: number;
  incumbentRates: ModelCostRates;
  candidateRates: ModelCostRates;
  warmStayCostUsd: number;
  coldSwitchCostUsd: number;
  savingsUsd: number;
  savingsRatio: number;
}

export interface ModelSwitchDecision {
  selection: "candidate" | "incumbent";
  selected: RoutedModel;
  reason: ModelSwitchReason;
  economics?: SwitchEconomics;
}

function modelKey(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function sameModel(first: Model<any>, second: Model<any>): boolean {
  return first.provider === second.provider && first.id === second.id;
}

function resolveRates(model: Model<any>, contextTokens: number, config: SwitchingConfig): ModelCostRates {
  const economics = config.economics[modelKey(model)] ?? model.cost;
  let rates: ModelCostRates = economics;
  for (const tier of [...(economics.tiers ?? [])].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)) {
    if (contextTokens > tier.inputTokensAbove) rates = tier;
  }
  return {
    input: rates.input,
    output: rates.output,
    cacheRead: rates.cacheRead,
    cacheWrite: rates.cacheWrite,
  };
}

function hasKnownEconomics(rates: ModelCostRates): boolean {
  return rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0;
}

function inputBucketCost(
  tokens: number,
  rates: ModelCostRates,
  cacheWriteRatio: number,
): number {
  const writeTokens = tokens * cacheWriteRatio;
  const ordinaryInputTokens = tokens - writeTokens;
  return usd(ordinaryInputTokens, rates.input) + usd(writeTokens, rates.cacheWrite);
}

function usd(tokens: number, perMillionTokens: number): number {
  return (Math.max(0, tokens) / 1_000_000) * perMillionTokens;
}

export function evaluateModelSwitch(input: ModelSwitchInput): ModelSwitchDecision {
  const { incumbent, candidate, config } = input;
  if (!config.cacheAware) {
    return { selection: "candidate", selected: candidate, reason: "cache-awareness-disabled" };
  }
  if (!incumbent) return { selection: "candidate", selected: candidate, reason: "new-thread" };

  const incumbentCapability = CAPABILITY_ORDER.indexOf(incumbent.tier);
  const candidateCapability = CAPABILITY_ORDER.indexOf(candidate.tier);
  if (candidateCapability > incumbentCapability && config.upgradesAlwaysSwitch) {
    return { selection: "candidate", selected: candidate, reason: "capability-upgrade" };
  }
  if (candidateCapability < incumbentCapability && input.tierConfidence < config.downgradeConfidenceFloor) {
    return {
      selection: "incumbent",
      selected: incumbent,
      reason: "low-downgrade-confidence",
    };
  }
  if (sameModel(incumbent.model, candidate.model)) {
    return { selection: "candidate", selected: candidate, reason: "same-model" };
  }

  const contextTokens = Math.max(input.promptTokens, input.contextTokens);
  const promptTokens = Math.max(0, Math.min(contextTokens, input.promptTokens));
  const prefixTokens = Math.max(0, contextTokens - promptTokens);
  const warmCacheRatio = Math.max(0, Math.min(1, input.warmCacheRatio ?? config.assumedWarmCacheRatio));
  const cacheWriteRatio = Math.max(0, Math.min(1, input.cacheWriteRatio ?? config.assumedCacheWriteRatio));
  const warmTokens = prefixTokens * warmCacheRatio;
  const incumbentColdTokens = contextTokens - warmTokens;
  const expectedOutputTokens = Math.max(0, input.expectedOutputTokens);
  const incumbentRates = resolveRates(incumbent.model, contextTokens, config);
  const candidateRates = resolveRates(candidate.model, contextTokens, config);

  if (!hasKnownEconomics(incumbentRates) || !hasKnownEconomics(candidateRates)) {
    const useCandidate = config.unknownCostPolicy === "switch";
    return {
      selection: useCandidate ? "candidate" : "incumbent",
      selected: useCandidate ? candidate : incumbent,
      reason: useCandidate ? "unknown-economics-switch" : "unknown-economics-stay",
    };
  }

  const warmStayCostUsd =
    usd(warmTokens, incumbentRates.cacheRead)
    + inputBucketCost(Math.max(0, incumbentColdTokens - promptTokens), incumbentRates, cacheWriteRatio)
    + usd(promptTokens, incumbentRates.input)
    + usd(expectedOutputTokens, incumbentRates.output);
  const coldSwitchCostUsd =
    inputBucketCost(prefixTokens, candidateRates, config.assumedCacheWriteRatio)
    + usd(promptTokens, candidateRates.input)
    + usd(expectedOutputTokens, candidateRates.output);
  const savingsUsd = warmStayCostUsd - coldSwitchCostUsd;
  const savingsRatio = warmStayCostUsd > 0 ? savingsUsd / warmStayCostUsd : 0;
  const economics: SwitchEconomics = {
    contextTokens,
    promptTokens,
    warmCacheRatio,
    cacheWriteRatio,
    expectedOutputTokens,
    incumbentRates,
    candidateRates,
    warmStayCostUsd,
    coldSwitchCostUsd,
    savingsUsd,
    savingsRatio,
  };
  const materialSavings = savingsUsd >= config.minSavingsUsd
    && savingsRatio >= config.minSavingsRatio;
  return materialSavings
    ? {
        selection: "candidate",
        selected: candidate,
        reason: "material-savings",
        economics,
      }
    : {
        selection: "incumbent",
        selected: incumbent,
        reason: "insufficient-savings",
        economics,
      };
}

export function formatSwitchDecision(decision: ModelSwitchDecision, requested: RoutedModel): string {
  const requestedName = `${requested.tier}/${requested.model.provider}/${requested.model.id}`;
  const selectedName = `${decision.selected.tier}/${decision.selected.model.provider}/${decision.selected.model.id}`;
  if (!decision.economics) {
    return `Switchyard model policy: requested ${requestedName}; selected ${selectedName} (${decision.reason})`;
  }
  const economics = decision.economics;
  return [
    `Switchyard model policy: requested ${requestedName}; selected ${selectedName} (${decision.reason})`,
    `warm stay $${economics.warmStayCostUsd.toFixed(4)} · cold switch $${economics.coldSwitchCostUsd.toFixed(4)}`,
    `savings $${economics.savingsUsd.toFixed(4)} (${(economics.savingsRatio * 100).toFixed(1)}%) · warm prefix ${(economics.warmCacheRatio * 100).toFixed(0)}%`,
  ].join(" · ");
}
