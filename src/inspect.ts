import type { Model, ModelCostRates, ModelCostTier, Usage } from "@earendil-works/pi-ai";

import type { RouteHistoryEntry } from "./threads.js";
import type { TransitionAudit } from "./switching.js";
import { buildUsageReportLines, type UsageSnapshot } from "./usage.js";
import type { ModelEconomics, ThinkingSelection, TierName } from "./types.js";

/**
 * Pure, read-only building blocks for `/switchyard inspect`.
 *
 * Every function here takes already-resolved plain data (no `ExtensionContext`,
 * no live model registry lookups) so the diagnostic report can be unit tested
 * without mocking Pi's runtime.
 */

export interface CacheUsageSummary {
  sampleCount: number;
  /** input + cacheRead + cacheWrite across the observed samples. */
  observedTokens: number;
  observedCacheReadTokens: number;
  /** observedCacheReadTokens / observedTokens, or undefined when there is no usage yet. */
  cacheReadRatio: number | undefined;
}

export function summarizeCacheUsage(usages: readonly Usage[]): CacheUsageSummary {
  const observedTokens = usages.reduce((sum, usage) => sum + usage.input + usage.cacheRead + usage.cacheWrite, 0);
  const observedCacheReadTokens = usages.reduce((sum, usage) => sum + usage.cacheRead, 0);
  return {
    sampleCount: usages.length,
    observedTokens,
    observedCacheReadTokens,
    cacheReadRatio: observedTokens > 0 ? observedCacheReadTokens / observedTokens : undefined,
  };
}

export type PricingProvenance = "switchyard-override" | "pi-metadata" | "unknown";

export interface ModelPricingSnapshot {
  provider: string;
  modelId: string;
  provenance: PricingProvenance;
  rates?: ModelCostRates;
  longContextTiers?: ModelCostTier[];
}

function hasKnownRates(rates: ModelCostRates): boolean {
  return rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0;
}

/**
 * Determine pricing and its provenance for a configured model: an explicit
 * `switching.economics` override, Pi's own model metadata, or unknown.
 */
export function resolveModelPricing(
  key: { provider: string; modelId: string },
  model: Model<any> | undefined,
  economicsOverrides: Record<string, ModelEconomics>,
): ModelPricingSnapshot {
  const override = economicsOverrides[`${key.provider}/${key.modelId}`];
  if (override) {
    return {
      provider: key.provider,
      modelId: key.modelId,
      provenance: "switchyard-override",
      rates: {
        input: override.input,
        output: override.output,
        cacheRead: override.cacheRead,
        cacheWrite: override.cacheWrite,
      },
      ...(override.tiers && override.tiers.length > 0 ? { longContextTiers: override.tiers } : {}),
    };
  }
  const cost = model?.cost;
  if (cost && hasKnownRates(cost)) {
    return {
      provider: key.provider,
      modelId: key.modelId,
      provenance: "pi-metadata",
      rates: {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
      },
      ...(cost.tiers && cost.tiers.length > 0 ? { longContextTiers: cost.tiers } : {}),
    };
  }
  return { provider: key.provider, modelId: key.modelId, provenance: "unknown" };
}

export interface RecentRouteSummary {
  timestamp: string;
  requestedTier?: TierName;
  requestedTierSource: "audit" | "legacy-decision";
  requestedProvider?: string;
  requestedModelId?: string;
  selectedTier: TierName;
  selectedProvider: string;
  selectedModelId: string;
  reason?: string;
}

/** Requested-vs-selected tiers/models for a thread's most recent route decisions. */
export function summarizeRouteHistory(
  history: readonly RouteHistoryEntry[],
  limit = 5,
): RecentRouteSummary[] {
  return history.slice(-Math.max(0, limit)).map(({ route, timestamp, audit }) => ({
    timestamp,
    requestedTierSource: audit ? "audit" : "legacy-decision",
    ...(audit
      ? {
          requestedTier: audit.requestedTier,
          requestedProvider: audit.requestedProvider,
          requestedModelId: audit.requestedModelId,
        }
      : { requestedTier: route.decision.tier }),
    selectedTier: route.tier,
    selectedProvider: route.provider,
    selectedModelId: route.modelId,
    ...(audit ? { reason: audit.reason } : {}),
  }));
}

export interface ThreadInspection {
  id: string;
  name: string;
  active: boolean;
  incumbent?: {
    tier: TierName;
    provider: string;
    modelId: string;
    thinking: ThinkingSelection;
  };
  /** Compaction-aware estimate of the thread's current context tokens, when computable. */
  contextTokens?: number;
  cacheUsage?: CacheUsageSummary;
  resetOpportunity?: { reason: "compaction" | "branch-summary" };
  recentRoutes: RecentRouteSummary[];
  latestAudit?: TransitionAudit;
  /** Manual tier pin for this specific logical thread, persisted branch-locally until unpinned. */
  pinnedTier?: TierName;
}

export interface InspectSnapshot {
  generatedAt: string;
  threads: ThreadInspection[];
  pricing: ModelPricingSnapshot[];
  /** Pending one-shot override for the next accepted provider-bound request, if any. */
  nextOverride?: { target?: "origin"; tier?: TierName };
  usage?: UsageSnapshot;
}

function formatTokens(tokens: number): string {
  return `${Math.round(tokens).toLocaleString()} tokens`;
}

function formatRate(rates: ModelCostRates): string {
  return `input $${rates.input}/M · output $${rates.output}/M · cacheRead $${rates.cacheRead}/M · cacheWrite $${rates.cacheWrite}/M`;
}

function formatLongContextTiers(tiers: readonly ModelCostTier[]): string[] {
  return tiers
    .slice()
    .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
    .map((tier) => `    above ${tier.inputTokensAbove.toLocaleString()} tokens: ${formatRate(tier)}`);
}

function formatGates(gates: Record<string, boolean>): string {
  const failed = Object.entries(gates).filter(([, passed]) => !passed).map(([gate]) => gate);
  return failed.length === 0 ? "pass" : `fail (${failed.join(", ")})`;
}

function formatEvidenceLine(tier: TierName, evidence: TransitionAudit["evidence"]): string | undefined {
  const item = evidence?.[tier];
  if (!item) return undefined;
  return `    ${tier}: score ${(item.score * 100).toFixed(1)}% · support ${item.supportWeight.toFixed(2)} · opposition ${item.oppositionWeight.toFixed(2)} · ${item.passes ? "pass" : "fail"}`;
}

function formatAudit(audit: TransitionAudit): string[] {
  const lines = [
    `  transition audit (latest): requested ${audit.requestedTier} · ${audit.requestedProvider}/${audit.requestedModelId}`,
    `    reason: ${audit.reason}${audit.cacheResetReason ? ` · cache invalidated by ${audit.cacheResetReason}` : ""}`,
  ];
  if (audit.evidence) {
    const evidenceLines = (["cheap", "handy", "smart", "genius"] as TierName[])
      .map((tier) => formatEvidenceLine(tier, audit.evidence))
      .filter((line): line is string => line !== undefined);
    if (evidenceLines.length > 0) lines.push("    evidence:", ...evidenceLines);
  }
  if (audit.evaluations && audit.evaluations.length > 0) {
    lines.push("    destinations:");
    for (const evaluation of audit.evaluations) {
      const forecast = evaluation.forecast
        ? ` · net $${evaluation.forecast.netSavingsUsd.toFixed(4)} (${(evaluation.forecast.netSavingsRatio * 100).toFixed(1)}%)`
        : "";
      lines.push(`      ${evaluation.tier} (${evaluation.provider}/${evaluation.modelId}): ${formatGates(evaluation.gates)}${forecast}`);
    }
  }
  if (audit.forecast) {
    lines.push(
      `    forecast: ${audit.forecast.turns} turns · return ${(audit.forecast.perTurnReturnProbability * 100).toFixed(1)}%/turn · ${(audit.forecast.cumulativeReturnProbability * 100).toFixed(1)}% cumulative`,
      `    net savings: $${audit.forecast.netSavingsUsd.toFixed(4)} (${(audit.forecast.netSavingsRatio * 100).toFixed(1)}%)`,
    );
  }
  if (audit.economics) {
    lines.push(
      `    economics: warm stay $${audit.economics.warmStayCostUsd.toFixed(4)} · cold switch $${audit.economics.coldSwitchCostUsd.toFixed(4)} · savings $${audit.economics.savingsUsd.toFixed(4)} (${(audit.economics.savingsRatio * 100).toFixed(1)}%)`,
    );
  }
  return lines;
}

/** Single-thread read-only report for `/switchyard threads` → Inspect. */
export function formatThreadInspection(thread: ThreadInspection): string {
  return formatThread(thread).join("\n");
}

function formatThread(thread: ThreadInspection): string[] {
  const lines = [`${thread.active ? "●" : "○"} ${thread.name}${thread.active ? " [active]" : ""}`];
  if (thread.pinnedTier) lines.push(`  manual pin: ${thread.pinnedTier} (persists until /switchyard unpin)`);
  lines.push(
    thread.incumbent
      ? `  incumbent: ${thread.incumbent.tier} · ${thread.incumbent.provider}/${thread.incumbent.modelId} · thinking: ${thread.incumbent.thinking}`
      : "  incumbent: none yet",
  );
  lines.push(
    thread.contextTokens !== undefined
      ? `  context: ~${formatTokens(thread.contextTokens)} (compaction-aware)`
      : "  context: unknown",
  );
  if (thread.cacheUsage) {
    const ratio = thread.cacheUsage.cacheReadRatio !== undefined
      ? `${(thread.cacheUsage.cacheReadRatio * 100).toFixed(1)}% cache-read`
      : "no observed cache-read";
    lines.push(
      `  cache epoch: ${thread.cacheUsage.sampleCount} sample(s) · ${formatTokens(thread.cacheUsage.observedTokens)} · ${ratio}`,
    );
  } else {
    lines.push("  cache epoch: no usage observed yet");
  }
  lines.push(
    thread.resetOpportunity
      ? `  reset opportunity: pending single-use reset from ${thread.resetOpportunity.reason}`
      : "  reset opportunity: none pending",
  );
  if (thread.recentRoutes.length > 0) {
    lines.push("  recent tiers (requested → selected):");
    for (const route of thread.recentRoutes) {
      const requested = route.requestedProvider && route.requestedModelId
        ? `${route.requestedTier ?? "?"} (${route.requestedProvider}/${route.requestedModelId})`
        : `${route.requestedTier ?? "?"} [legacy decision]`;
      const selected = `${route.selectedTier} (${route.selectedProvider}/${route.selectedModelId})`;
      const reason = route.reason ? ` · ${route.reason}` : "";
      lines.push(`    ${route.timestamp}: ${requested} → ${selected}${reason}`);
    }
  } else {
    lines.push("  recent tiers: none recorded");
  }
  if (thread.latestAudit) lines.push(...formatAudit(thread.latestAudit));
  return lines;
}

function formatPricing(entry: ModelPricingSnapshot): string[] {
  const lines = [`${entry.provider}/${entry.modelId} [${entry.provenance}]`];
  if (entry.rates) {
    lines.push(`  ${formatRate(entry.rates)}`);
    if (entry.longContextTiers && entry.longContextTiers.length > 0) {
      lines.push("  long-context tiers:", ...formatLongContextTiers(entry.longContextTiers));
    }
  } else {
    lines.push("  pricing metadata unavailable");
  }
  return lines;
}

function formatNextOverride(next: { target?: "origin"; tier?: TierName }): string {
  const parts = [
    next.target ? `target → ${next.target}` : undefined,
    next.tier ? `tier → ${next.tier}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(", ") : "(empty)";
}

export function formatInspectReport(snapshot: InspectSnapshot): string {
  const lines = [`Switchyard Inspect · ${snapshot.generatedAt}`, ""];
  lines.push(
    snapshot.nextOverride
      ? `Pending next-request override: ${formatNextOverride(snapshot.nextOverride)}`
      : "Pending next-request override: none",
    "",
  );
  lines.push(`Threads (${snapshot.threads.length}):`);
  for (const thread of snapshot.threads) {
    lines.push(...formatThread(thread), "");
  }
  if (snapshot.usage) {
    lines.push("Usage:", ...buildUsageReportLines(snapshot.usage).map((line) => `  ${line}`), "");
  }
  lines.push("Model pricing:");
  if (snapshot.pricing.length === 0) {
    lines.push("  no tiers configured");
  } else {
    for (const entry of snapshot.pricing) lines.push(...formatPricing(entry).map((line) => `  ${line}`));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
