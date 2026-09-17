import type { Model, ModelCostRates } from "@earendil-works/pi-ai";
import type { CacheResetOpportunity } from "./cache-reset.js";

import type {
  RouteDecision,
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
  | "insufficient-savings"
  | "insufficient-evidence"
  | "return-cost-not-covered"
  | "stable-downgrade"
  | "same-model-stable-downgrade"
  | "shadow-downgrade"
  | "no-effective-downgrade"
  | "dominated-economics"
  | "in-flight-task-lock";

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
  cacheResetOpportunity?: CacheResetOpportunity;
  selection: "candidate" | "incumbent";
  selected: RoutedModel;
  incumbent?: RoutedModel;
  proposed?: RoutedModel;
  reason: ModelSwitchReason;
  economics?: SwitchEconomics;
  evidence?: Record<string, DestinationEvidence>;
  forecast?: DowngradeForecast;
  evaluations?: DestinationEvaluation[];
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
    // Compare the incumbent and candidate with the same uncached-prefix bucket mix.
    // Otherwise an assumed candidate write ratio can manufacture savings.
    inputBucketCost(prefixTokens, candidateRates, cacheWriteRatio)
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

export function acceptTierRecommendation(
  requestId: string,
  decision: RouteDecision,
  resolvedTier: TierName,
): TierRecommendationEvidence {
  return {
    requestId,
    tier: resolvedTier,
    confidence: decision.tierConfidence,
    tierProbabilities: resolvedTier === decision.tier
      ? { ...decision.tierProbabilities }
      : Object.fromEntries(
          CAPABILITY_ORDER.map((tier) => [tier, tier === resolvedTier ? 1 : 0]),
        ) as Record<TierName, number>,
  };
}

export interface TierRecommendationEvidence {
  requestId: string;
  tier: TierName;
  confidence: number;
  tierProbabilities: Record<TierName, number>;
}

export interface DestinationEvidence {
  tier: TierName;
  score: number;
  supportWeight: number;
  oppositionWeight: number;
  returnProbability: number;
  passes: boolean;
}

export interface DowngradeForecast {
  turns: number;
  perTurnReturnProbability: number;
  cumulativeReturnProbability: number;
  baselineCostUsd: number;
  transitionCostUsd: number;
  returnCostReserveUsd: number;
  netSavingsUsd: number;
  netSavingsRatio: number;
}

export interface DestinationEvaluation {
  destination: RoutedModel;
  evidence: DestinationEvidence;
  economics?: SwitchEconomics;
  forecast?: DowngradeForecast;
  gates: {
    currentRequirement: boolean;
    confidence: boolean;
    evidence: boolean;
    economics: boolean;
    savings: boolean;
    effectiveThinkingReduction: boolean;
    notRateDominated: boolean;
  };
}

export interface ModelTransitionInput {
  /** Only supplied while the first post-reset provider request is still undispatched. */
  cacheResetOpportunity?: CacheResetOpportunity;
  taskPhase?: "new-request" | "continuing";
  incumbent: RoutedModel | undefined;
  requested: RoutedModel;
  candidates: RoutedModel[];
  currentRecommendation: TierRecommendationEvidence;
  recommendationHistory: TierRecommendationEvidence[];
  contextTokens: number;
  promptTokens: number;
  warmCacheRatio: number | undefined;
  warmCacheSource?: "observed" | "assumed" | "invalidated" | "no-history";
  cacheWriteRatio?: number;
  expectedOutputTokens: number;
  config: SwitchingConfig;
}

export interface ModelTransitionDecision extends ModelSwitchDecision {
  requested: RoutedModel;
  evaluations?: DestinationEvaluation[];
}

function normalizedProbabilities(evidence: TierRecommendationEvidence): Record<TierName, number> {
  const total = CAPABILITY_ORDER.reduce((sum, tier) => sum + Math.max(0, evidence.tierProbabilities[tier] ?? 0), 0);
  if (total <= 0) {
    return Object.fromEntries(
      CAPABILITY_ORDER.map((tier) => [tier, tier === evidence.tier ? 1 : 0]),
    ) as Record<TierName, number>;
  }
  return Object.fromEntries(
    CAPABILITY_ORDER.map((tier) => [tier, Math.max(0, evidence.tierProbabilities[tier] ?? 0) / total]),
  ) as Record<TierName, number>;
}

function destinationEvidence(
  tier: TierName,
  history: TierRecommendationEvidence[],
  config: SwitchingConfig,
): DestinationEvidence {
  const destination = CAPABILITY_ORDER.indexOf(tier);
  let supportWeight = 0;
  let oppositionWeight = 0;
  let rawSupport = 0;
  let rawOpposition = 0;
  const newestFirst = [...history].reverse();
  for (let age = 0; age < newestFirst.length; age += 1) {
    const item = newestFirst[age]!;
    const probabilities = normalizedProbabilities(item);
    const recency = config.evidenceDecay ** age;
    const confidenceWeight = 0.25 + 0.75 * Math.max(0, Math.min(1, item.confidence));
    const weight = recency * confidenceWeight;
    const supportProbability = CAPABILITY_ORDER.reduce(
      (sum, candidateTier, index) => sum + (index <= destination ? probabilities[candidateTier] : 0),
      0,
    );
    const oppositionProbability = Math.max(0, 1 - supportProbability);
    supportWeight += weight * supportProbability;
    oppositionWeight += weight * oppositionProbability * config.hardRequirementPenalty;
    rawSupport += weight * supportProbability;
    rawOpposition += weight * oppositionProbability;
  }
  const denominator = supportWeight + oppositionWeight;
  const score = denominator > 0 ? supportWeight / denominator : 0;
  const rawDenominator = rawSupport + rawOpposition;
  const observedReturnProbability = rawDenominator > 0 ? rawOpposition / rawDenominator : 1;
  const returnProbability = Math.max(config.returnProbabilityFloor, observedReturnProbability);
  return {
    tier,
    score,
    supportWeight,
    oppositionWeight,
    returnProbability,
    passes: score >= config.minimumEvidenceScore
      && supportWeight >= config.minimumEvidenceWeight,
  };
}

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function providerEffectiveThinking(
  model: Model<any>,
  thinking: TierConfig["thinking"],
): string | undefined {
  if (thinking === "default") return undefined;
  const mapped = model.thinkingLevelMap?.[thinking];
  if (mapped === null) return undefined;
  return typeof mapped === "string" ? mapped : thinking;
}

function sameModelHasEffectiveThinkingReduction(incumbent: RoutedModel, destination: RoutedModel): boolean {
  if (!sameModel(incumbent.model, destination.model)) return true;
  const currentValue = providerEffectiveThinking(incumbent.model, incumbent.tierConfig.thinking);
  const nextValue = providerEffectiveThinking(destination.model, destination.tierConfig.thinking);
  if (!currentValue || !nextValue || currentValue === nextValue) return false;
  const current = THINKING_ORDER.indexOf(currentValue as (typeof THINKING_ORDER)[number]);
  const next = THINKING_ORDER.indexOf(nextValue as (typeof THINKING_ORDER)[number]);
  return current >= 0 && next >= 0 && next < current;
}

function candidateRatesAreDominated(incumbent: ModelCostRates, candidate: ModelCostRates): boolean {
  const keys: Array<keyof ModelCostRates> = ["input", "output", "cacheRead", "cacheWrite"];
  // A different model with equal-or-higher rates cannot create genuine savings;
  // apparent gains would come only from asymmetric cache assumptions.
  return keys.every((key) => candidate[key] >= incumbent[key]);
}

function warmCostFromRates(
  rates: ModelCostRates,
  contextTokens: number,
  promptTokens: number,
  outputTokens: number,
  warmRatio: number,
  cacheWriteRatio: number,
): number {
  const prefixTokens = Math.max(0, contextTokens - promptTokens);
  const warmTokens = prefixTokens * warmRatio;
  const coldPrefixTokens = prefixTokens - warmTokens;
  return usd(warmTokens, rates.cacheRead)
    + inputBucketCost(coldPrefixTokens, rates, cacheWriteRatio)
    + usd(promptTokens, rates.input)
    + usd(outputTokens, rates.output);
}

/**
 * Deterministic economic-safety policy for model transitions.
 *
 * This is the single decision boundary for evidence-based downgrades. It performs no
 * I/O and reads no hidden state: callers must provide routing evidence, cache epoch
 * observations, candidate models, pricing, and policy explicitly. Historical evidence
 * may support a downgrade but can never override the current accepted requirement.
 */
export function decideModelTransition(rawInput: ModelTransitionInput): ModelTransitionDecision {
  // A reset changes initial costs only, never the requirement or evidence gates.
  const input: ModelTransitionInput = rawInput.cacheResetOpportunity
    ? { ...rawInput, warmCacheRatio: 0, warmCacheSource: "invalidated" }
    : rawInput;
  const { incumbent, requested, config } = input;
  const reset = input.cacheResetOpportunity ? { cacheResetOpportunity: input.cacheResetOpportunity } : {};
  if (input.taskPhase === "continuing" && incumbent) {
    return { ...reset, selection: "incumbent", selected: incumbent, incumbent, requested, reason: "in-flight-task-lock" };
  }
  const immediateResult = evaluateModelSwitch({
    incumbent,
    candidate: requested,
    tierConfidence: input.currentRecommendation.confidence,
    contextTokens: input.contextTokens,
    promptTokens: input.promptTokens,
    warmCacheRatio: input.warmCacheRatio,
    ...(input.warmCacheSource ? { warmCacheSource: input.warmCacheSource } : {}),
    ...(input.cacheWriteRatio !== undefined ? { cacheWriteRatio: input.cacheWriteRatio } : {}),
    expectedOutputTokens: input.expectedOutputTokens,
    config,
  });
  const immediate: ModelSwitchDecision = { ...reset, ...immediateResult };
  if (!incumbent || !config.cacheAware) return { ...immediate, requested };

  const incumbentCapability = CAPABILITY_ORDER.indexOf(incumbent.tier);
  const requiredCapability = CAPABILITY_ORDER.indexOf(input.currentRecommendation.tier);
  const deduplicated = new Map<string, TierRecommendationEvidence>();
  for (const item of [...input.recommendationHistory, input.currentRecommendation]) {
    deduplicated.delete(item.requestId);
    deduplicated.set(item.requestId, item);
  }
  const history = [...deduplicated.values()];
  if (requiredCapability >= incumbentCapability) {
    const evaluations: DestinationEvaluation[] = input.candidates
      .filter((candidate) => CAPABILITY_ORDER.indexOf(candidate.tier) < requiredCapability)
      .map((destination) => {
        const evidence = destinationEvidence(destination.tier, history, config);
        return {
          destination,
          evidence,
          gates: {
            currentRequirement: false,
            confidence: input.currentRecommendation.confidence >= config.downgradeConfidenceFloor,
            evidence: evidence.passes,
            economics: false,
            savings: false,
            effectiveThinkingReduction: sameModelHasEffectiveThinkingReduction(incumbent, destination),
            notRateDominated: true,
          },
        };
      });
    if (requiredCapability > incumbentCapability) {
      return {
        selection: "candidate",
        selected: requested,
        incumbent,
        requested,
        reason: "capability-upgrade",
        ...reset,
        evaluations,
      };
    }
    return { ...immediate, requested, evaluations };
  }
  const evidenceByTier: Record<string, DestinationEvidence> = {};
  const evaluations: DestinationEvaluation[] = [];
  const uniqueCandidates = new Map<TierName, RoutedModel>();
  for (const candidate of input.candidates) uniqueCandidates.set(candidate.tier, candidate);
  for (const [tier, destination] of uniqueCandidates) {
    const capability = CAPABILITY_ORDER.indexOf(tier);
    if (capability >= incumbentCapability) continue;
    const evidence = destinationEvidence(tier, history, config);
    evidenceByTier[tier] = evidence;
    const same = sameModel(incumbent.model, destination.model);
    const thinkingReduction = sameModelHasEffectiveThinkingReduction(incumbent, destination);
    const baseGates = {
      currentRequirement: capability >= requiredCapability,
      confidence: input.currentRecommendation.confidence >= config.downgradeConfidenceFloor,
      evidence: evidence.passes,
      economics: same ? thinkingReduction : false,
      savings: same ? thinkingReduction : false,
      effectiveThinkingReduction: thinkingReduction,
      notRateDominated: true,
    };
    if (same) {
      evaluations.push({ destination, evidence, gates: baseGates });
      continue;
    }
    const economicsDecision = evaluateModelSwitch({
      incumbent,
      candidate: destination,
      tierConfidence: 1,
      contextTokens: input.contextTokens,
      promptTokens: input.promptTokens,
      warmCacheRatio: input.warmCacheRatio,
      ...(input.warmCacheSource ? { warmCacheSource: input.warmCacheSource } : {}),
      ...(input.cacheWriteRatio !== undefined ? { cacheWriteRatio: input.cacheWriteRatio } : {}),
      expectedOutputTokens: input.expectedOutputTokens,
      config: { ...config, downgradeConfidenceFloor: 0, minSavingsRatio: 0, minSavingsUsd: 0 },
    });
    const economics = economicsDecision.economics;
    if (!economics) {
      const allowed = config.unknownCostPolicy === "switch";
      evaluations.push({
        destination,
        evidence,
        gates: {
          ...baseGates,
          economics: allowed,
          savings: allowed,
        },
      });
      continue;
    }
    const rateDominated = candidateRatesAreDominated(
      economics.incumbentRates,
      economics.candidateRates,
    );
    const destinationWarmCost = warmCostFromRates(
      economics.candidateRates,
      economics.contextTokens,
      economics.promptTokens,
      economics.expectedOutputTokens,
      config.assumedWarmCacheRatio,
      config.assumedCacheWriteRatio,
    );
    const incumbentFutureWarmCost = warmCostFromRates(
      economics.incumbentRates,
      economics.contextTokens,
      economics.promptTokens,
      economics.expectedOutputTokens,
      config.assumedWarmCacheRatio,
      config.assumedCacheWriteRatio,
    );
    const incumbentColdReturnCost = warmCostFromRates(
      economics.incumbentRates,
      economics.contextTokens,
      economics.promptTokens,
      economics.expectedOutputTokens,
      0,
      config.assumedCacheWriteRatio,
    );
    const turns = Math.max(1, config.forecastTurns);
    const perTurnReturnProbability = Math.max(0, Math.min(1, evidence.returnProbability));
    const cumulativeReturnProbability = turns <= 1
      ? 0
      : 1 - (1 - perTurnReturnProbability) ** (turns - 1);
    const baselineCostUsd = economics.warmStayCostUsd + incumbentFutureWarmCost * (turns - 1);
    let transitionCostUsd = economics.coldSwitchCostUsd;
    for (let futureTurn = 1; futureTurn < turns; futureTurn += 1) {
      const destinationSurvival = (1 - perTurnReturnProbability) ** futureTurn;
      transitionCostUsd += destinationSurvival * destinationWarmCost
        + (1 - destinationSurvival) * incumbentFutureWarmCost;
    }
    const returnCostReserveUsd = Math.max(0, incumbentColdReturnCost - incumbentFutureWarmCost)
      * cumulativeReturnProbability
      * config.returnCostMultiplier;
    const netSavingsUsd = baselineCostUsd - transitionCostUsd - returnCostReserveUsd;
    const netSavingsRatio = baselineCostUsd > 0 ? netSavingsUsd / baselineCostUsd : 0;
    const savings = netSavingsUsd >= config.minSavingsUsd
      && netSavingsRatio >= config.minSavingsRatio;
    evaluations.push({
      destination,
      evidence,
      economics,
      gates: {
        ...baseGates,
        economics: true,
        savings: savings && !rateDominated,
        notRateDominated: !rateDominated,
      },
      forecast: {
        turns,
        perTurnReturnProbability,
        cumulativeReturnProbability,
        baselineCostUsd,
        transitionCostUsd,
        returnCostReserveUsd,
        netSavingsUsd,
        netSavingsRatio,
      },
    });
  }

  const passing = evaluations.filter((item) => Object.values(item.gates).every(Boolean));
  passing.sort((a, b) => {
    const aSavings = a.forecast?.netSavingsUsd ?? 0;
    const bSavings = b.forecast?.netSavingsUsd ?? 0;
    if (aSavings !== bSavings) return bSavings - aSavings;
    return CAPABILITY_ORDER.indexOf(a.destination.tier) - CAPABILITY_ORDER.indexOf(b.destination.tier);
  });
  const winner = passing[0];
  if (!winner) {
    const eligible = evaluations.filter((item) => item.gates.currentRequirement);
    const confidenceFailed = eligible.length > 0 && eligible.every((item) => !item.gates.confidence);
    const hasEvidence = eligible.some((item) => item.gates.confidence && item.gates.evidence);
    const unknownEconomics = evaluations.some((item) =>
      item.gates.currentRequirement
      && item.gates.confidence
      && item.gates.evidence
      && !sameModel(incumbent.model, item.destination.model)
      && !item.gates.economics);
    const noEffectiveDowngrade = evaluations.some((item) =>
      item.gates.currentRequirement
      && item.gates.confidence
      && item.gates.evidence
      && sameModel(incumbent.model, item.destination.model)
      && !item.gates.effectiveThinkingReduction);
    const dominatedEconomics = evaluations.some((item) =>
      item.gates.currentRequirement
      && item.gates.confidence
      && item.gates.evidence
      && !item.gates.notRateDominated);
    const audit = [...evaluations].sort(
      (a, b) => (b.forecast?.netSavingsUsd ?? -Infinity) - (a.forecast?.netSavingsUsd ?? -Infinity),
    )[0];
    return {
      ...immediate,
      selection: "incumbent",
      selected: incumbent,
      incumbent,
      requested,
      reason: confidenceFailed
        ? "low-downgrade-confidence"
        : unknownEconomics
          ? "unknown-economics-stay"
          : noEffectiveDowngrade
            ? "no-effective-downgrade"
            : dominatedEconomics
              ? "dominated-economics"
              : hasEvidence
                ? "return-cost-not-covered"
                : "insufficient-evidence",
      ...(audit?.economics ? { economics: audit.economics } : {}),
      ...(audit?.forecast ? { forecast: audit.forecast } : {}),
      evidence: evidenceByTier,
      evaluations,
    };
  }

  const same = sameModel(incumbent.model, winner.destination.model);
  const reason: ModelSwitchReason = config.downgradeMode === "shadow"
    ? "shadow-downgrade"
    : same
      ? "same-model-stable-downgrade"
      : "stable-downgrade";
  return {
    ...reset,
    selection: config.downgradeMode === "shadow" ? "incumbent" : "candidate",
    selected: config.downgradeMode === "shadow" ? incumbent : winner.destination,
    incumbent,
    requested,
    ...(config.downgradeMode === "shadow" ? { proposed: winner.destination } : {}),
    reason,
    ...(winner.economics ? { economics: winner.economics } : {}),
    evidence: evidenceByTier,
    ...(winner.forecast ? { forecast: winner.forecast } : {}),
    evaluations,
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
  const resetLabel = decision.cacheResetOpportunity ? ` · ${decision.cacheResetOpportunity.reason} reset` : "";
  const prefix = `Switchyard · ${thread}${resetLabel}`;
  const current = decision.incumbent ? shortModel(decision.incumbent) : undefined;
  const selected = shortModel(decision.selected);
  if (!current) return `${prefix} · selected ${selected} · new thread`;
  if (decision.reason === "same-model") {
    return `${prefix} · ${requested.model.id} ${decision.incumbent!.tierConfig.thinking} → ${decision.selected.tierConfig.thinking} · same model`;
  }
  if (decision.reason === "same-model-stable-downgrade") {
    return `${prefix} · ${current} → ${selected} · stable thinking downgrade`;
  }
  if (decision.reason === "stable-downgrade" && decision.forecast) {
    return `${prefix} · ${current} → ${selected} · stable downgrade · forecast save $${decision.forecast.netSavingsUsd.toFixed(4)} (${(decision.forecast.netSavingsRatio * 100).toFixed(1)}%)`;
  }
  if (decision.reason === "shadow-downgrade") {
    return `${prefix} · kept ${current} · proposed ${decision.proposed ? shortModel(decision.proposed) : shortModel(requested)} · shadow mode`;
  }
  if (decision.reason === "insufficient-evidence") {
    return `${prefix} · kept ${current} · ${shortModel(requested)} downgrade trend still building`;
  }
  if (decision.reason === "return-cost-not-covered") {
    return `${prefix} · kept ${current} · return cost not yet covered`;
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
    ...(decision.proposed ? [`proposed:  ${fullModel(decision.proposed)}`] : []),
    `reason:    ${decision.reason}`,
    `confidence: target ${(context.targetConfidence * 100).toFixed(1)}% · tier ${(context.tierConfidence * 100).toFixed(1)}%`,
  ];
  if (decision.cacheResetOpportunity) {
    lines.push(
      "",
      `cache state:   invalidated-by-${decision.cacheResetOpportunity.reason}`,
      "switch window: first provider dispatch after reset (single-use)",
      "initial costs: incumbent cold · candidate cold",
    );
  }
  if (decision.reason === "in-flight-task-lock") lines.push("", "current task continues on its assigned model");
  if (decision.evidence) {
    const evidenceLines = CAPABILITY_ORDER
      .filter((tier) => decision.evidence?.[tier])
      .map((tier) => {
        const evidence = decision.evidence![tier]!;
        return `${tier}: score ${(evidence.score * 100).toFixed(1)}% · support ${evidence.supportWeight.toFixed(2)} · opposition ${evidence.oppositionWeight.toFixed(2)}${evidence.passes ? " · pass" : " · fail"}`;
      });
    if (evidenceLines.length > 0) lines.push("", "evidence:", ...evidenceLines);
  }
  if (decision.evaluations && decision.evaluations.length > 0) {
    lines.push("", "destinations:");
    for (const evaluation of decision.evaluations) {
      const failed = Object.entries(evaluation.gates)
        .filter(([, passed]) => !passed)
        .map(([gate]) => gate);
      const forecast = evaluation.forecast
        ? ` · net $${evaluation.forecast.netSavingsUsd.toFixed(4)} (${(evaluation.forecast.netSavingsRatio * 100).toFixed(1)}%)`
        : "";
      lines.push(`${evaluation.destination.tier}: ${failed.length === 0 ? "pass" : `fail ${failed.join(",")}`}${forecast}`);
    }
  }
  if (decision.forecast) {
    lines.push(
      "",
      `forecast:      ${decision.forecast.turns} turns · return ${(decision.forecast.perTurnReturnProbability * 100).toFixed(1)}%/turn · ${(decision.forecast.cumulativeReturnProbability * 100).toFixed(1)}% cumulative`,
      `baseline:      $${decision.forecast.baselineCostUsd.toFixed(4)}`,
      `transition:    $${decision.forecast.transitionCostUsd.toFixed(4)}`,
      `return reserve:$${decision.forecast.returnCostReserveUsd.toFixed(4)}`,
      `net savings:   $${decision.forecast.netSavingsUsd.toFixed(4)} (${(decision.forecast.netSavingsRatio * 100).toFixed(1)}%)`,
    );
  }
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
