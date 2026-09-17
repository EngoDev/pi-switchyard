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
  warmCacheSource?: "observed" | "assumed" | "invalidated" | "no-history";
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
  warmCacheSource: "observed" | "assumed" | "invalidated" | "no-history";
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
  incumbent?: RoutedModel;
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
    return {
      selection: "candidate",
      selected: candidate,
      ...(incumbent ? { incumbent } : {}),
      reason: "cache-awareness-disabled",
    };
  }
  if (!incumbent) return { selection: "candidate", selected: candidate, reason: "new-thread" };

  const incumbentCapability = CAPABILITY_ORDER.indexOf(incumbent.tier);
  const candidateCapability = CAPABILITY_ORDER.indexOf(candidate.tier);
  if (candidateCapability > incumbentCapability && config.upgradesAlwaysSwitch) {
    return { selection: "candidate", selected: candidate, incumbent, reason: "capability-upgrade" };
  }
  if (candidateCapability < incumbentCapability && input.tierConfidence < config.downgradeConfidenceFloor) {
    return {
      selection: "incumbent",
      selected: incumbent,
      incumbent,
      reason: "low-downgrade-confidence",
    };
  }
  if (sameModel(incumbent.model, candidate.model)) {
    return { selection: "candidate", selected: candidate, incumbent, reason: "same-model" };
  }

  const contextTokens = Math.max(input.promptTokens, input.contextTokens);
  const promptTokens = Math.max(0, Math.min(contextTokens, input.promptTokens));
  const prefixTokens = Math.max(0, contextTokens - promptTokens);
  const warmCacheRatio = Math.max(0, Math.min(1, input.warmCacheRatio ?? config.assumedWarmCacheRatio));
  const warmCacheSource = input.warmCacheSource
    ?? (input.warmCacheRatio === undefined ? "assumed" : "observed");
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
      incumbent,
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
    warmCacheSource,
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
        incumbent,
        reason: "material-savings",
        economics,
      }
    : {
        selection: "incumbent",
        selected: incumbent,
        incumbent,
        reason: "insufficient-savings",
        economics,
      };
}

function shortModel(value: RoutedModel): string {
  return `${value.tier}/${value.model.id}`;
}

function fullModel(value: RoutedModel | undefined): string {
  return value
    ? `${value.tier} / ${value.model.provider}/${value.model.id}`
    : "none (new logical thread)";
}

export interface SwitchDiagnosticContext {
  thread: string;
  targetConfidence: number;
  tierConfidence: number;
  config: SwitchingConfig;
}

export function formatMinimalSwitchDecision(
  decision: ModelSwitchDecision,
  requested: RoutedModel,
  thread: string,
): string {
  const prefix = `Switchyard · ${thread}`;
  const current = decision.incumbent ? shortModel(decision.incumbent) : undefined;
  const selected = shortModel(decision.selected);
  if (!current) return `${prefix} · selected ${selected} · new thread`;
  if (decision.reason === "same-model") {
    return `${prefix} · ${requested.model.id} ${decision.incumbent!.tierConfig.thinking} → ${decision.selected.tierConfig.thinking} · same model`;
  }
  if (decision.selection === "candidate") {
    if (decision.reason === "capability-upgrade") {
      return `${prefix} · ${current} → ${selected} · capability upgrade`;
    }
    if (decision.economics) {
      return `${prefix} · ${current} → ${selected} · switched · save $${decision.economics.savingsUsd.toFixed(4)} (${(decision.economics.savingsRatio * 100).toFixed(1)}%)`;
    }
    return `${prefix} · ${current} → ${selected} · ${decision.reason}`;
  }

  const wanted = shortModel(requested);
  if (decision.reason === "unknown-economics-stay") {
    return `${prefix} · kept ${current} · ${wanted} pricing unknown`;
  }
  if (decision.economics) {
    if (decision.economics.savingsUsd < 0) {
      return `${prefix} · kept ${current} · wanted ${wanted} · cold switch costs $${Math.abs(decision.economics.savingsUsd).toFixed(4)} more`;
    }
    return `${prefix} · kept ${current} · wanted ${wanted} · $${decision.economics.savingsUsd.toFixed(4)} savings below threshold`;
  }
  return `${prefix} · kept ${current} · wanted ${wanted} · ${decision.reason}`;
}

export function formatVerboseSwitchDecision(
  decision: ModelSwitchDecision,
  requested: RoutedModel,
  context: SwitchDiagnosticContext,
): string {
  const lines = [
    `Switchyard economics · ${context.thread}`,
    "",
    `current:   ${fullModel(decision.incumbent)}`,
    `requested: ${fullModel(requested)}`,
    `selected:  ${fullModel(decision.selected)}`,
    `reason:    ${decision.reason}`,
    `confidence: target ${(context.targetConfidence * 100).toFixed(1)}% · tier ${(context.tierConfidence * 100).toFixed(1)}%`,
  ];
  if (decision.economics) {
    const economics = decision.economics;
    lines.push(
      "",
      `context:       ${Math.round(economics.contextTokens).toLocaleString()} tokens`,
      `prompt:        ${Math.round(economics.promptTokens).toLocaleString()} tokens`,
      `expected out:  ${Math.round(economics.expectedOutputTokens).toLocaleString()} tokens`,
      `warm prefix:   ${(economics.warmCacheRatio * 100).toFixed(0)}% ${economics.warmCacheSource}`,
      `cache writes:  ${(economics.cacheWriteRatio * 100).toFixed(0)}% of uncached prefix`,
      "",
      `warm stay:     $${economics.warmStayCostUsd.toFixed(4)}`,
      `cold switch:   $${economics.coldSwitchCostUsd.toFixed(4)}`,
      `savings:       $${economics.savingsUsd.toFixed(4)} (${(economics.savingsRatio * 100).toFixed(1)}%)`,
      `threshold:     $${context.config.minSavingsUsd} / ${(context.config.minSavingsRatio * 100).toFixed(0)}%`,
    );
  } else if (decision.reason === "capability-upgrade") {
    lines.push("", "cache economics bypassed for capability upgrade");
  } else if (decision.reason === "same-model") {
    lines.push("", `thinking: ${decision.incumbent?.tierConfig.thinking ?? "unknown"} → ${decision.selected.tierConfig.thinking}`, "no model-cache switch required");
  } else if (decision.reason.startsWith("unknown-economics")) {
    lines.push("", "pricing metadata is unavailable for one or both models");
  }
  return lines.join("\n");
}
