import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { TransitionAudit } from "./switching.js";
import type {
  JevUsage,
  PersistedUsageObserved,
  RouterSessionEntryData,
  TierName,
} from "./types.js";

/**
 * Pure, read-only usage aggregation and reporting for Switchyard.
 *
 * This module performs no I/O and reads no hidden state: every function takes
 * already-resolved plain data (session entries, messages, usage records) so
 * actual-spend reporting can be unit tested without mocking Pi's runtime.
 *
 * Vocabulary is deliberate throughout: "estimated" figures are the pre-request
 * warm-stay/cold-switch forecast produced by the transition policy before a
 * request is dispatched; "observed" figures are actual billed usage aggregated
 * from assistant turns after the request settles. The difference between them
 * is a forecast-vs-actual comparison, never a "measured saving".
 */

const SWITCHYARD_CUSTOM_TYPES = new Set(["switchyard", "jev-router"]);

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function addUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...((first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined)
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
      : {}),
    ...((first.reasoning !== undefined || second.reasoning !== undefined)
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
      : {}),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
}

export function cacheHitRatio(usage: Usage): number | undefined {
  const denominator = usage.input + usage.cacheRead + usage.cacheWrite;
  return denominator > 0 ? usage.cacheRead / denominator : undefined;
}

export interface PendingUsageAccumulator {
  requestId: string;
  threadId: string;
  threadName: string;
  tier: TierName;
  provider: string;
  modelId: string;
  usage: Usage;
  turnCount: number;
  reportedModels: string[];
}

export function createUsageAccumulator(route: {
  requestId: string;
  threadId: string;
  threadName: string;
  tier: TierName;
  provider: string;
  modelId: string;
}): PendingUsageAccumulator {
  return { ...route, usage: ZERO_USAGE, turnCount: 0, reportedModels: [] };
}

/**
 * Fold one assistant turn into a request's usage accumulator.
 *
 * Failed, aborted, retried, and proxy-substituted provider attempts are included
 * when they report usage: they are real observed spend even if Pi later removes
 * them from replay context. Nested model usage reported by tools is included too.
 */
export function accumulateAssistantTurn(
  accumulator: PendingUsageAccumulator,
  message: AgentMessage,
): PendingUsageAccumulator {
  if (message.role === "toolResult") {
    return message.usage
      ? { ...accumulator, usage: addUsage(accumulator.usage, message.usage) }
      : accumulator;
  }
  if (message.role !== "assistant") return accumulator;
  const reportedModel = `${message.provider}/${message.model}`;
  return {
    ...accumulator,
    usage: addUsage(accumulator.usage, message.usage),
    turnCount: accumulator.turnCount + 1,
    reportedModels: accumulator.reportedModels.includes(reportedModel)
      ? accumulator.reportedModels
      : [...accumulator.reportedModels, reportedModel],
  };
}

export function toPersistedUsageObserved(
  accumulator: PendingUsageAccumulator,
  timestamp: string,
): PersistedUsageObserved {
  return {
    kind: "usage-observed",
    requestId: accumulator.requestId,
    threadId: accumulator.threadId,
    threadName: accumulator.threadName,
    tier: accumulator.tier,
    provider: accumulator.provider,
    modelId: accumulator.modelId,
    turnCount: accumulator.turnCount,
    usage: accumulator.usage,
    reportedModels: accumulator.reportedModels,
    timestamp,
  };
}

interface RawRouteRecord {
  requestId: string;
  threadId: string;
  threadName: string;
  tier: TierName;
  provider: string;
  modelId: string;
  timestamp: string;
  reason?: TransitionAudit["reason"];
  jevUsage?: JevUsage;
  economics?: TransitionAudit["economics"];
  forecast?: TransitionAudit["forecast"];
}

function isSwitchyardEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
  return entry.type === "custom" && SWITCHYARD_CUSTOM_TYPES.has(entry.customType);
}

function extractRouteRecords(entries: readonly SessionEntry[]): RawRouteRecord[] {
  const records: RawRouteRecord[] = [];
  for (const entry of entries) {
    if (!isSwitchyardEntry(entry)) continue;
    const data = entry.data as RouterSessionEntryData | undefined;
    if (data?.kind !== "route") continue;
    // Route entries persisted before requestId tracking existed cannot be joined to usage.
    const requestId = data.route.decision.requestId;
    if (!requestId) continue;
    const threadId = data.route.threadId === ("parent" as string) ? "origin" : data.route.threadId;
    records.push({
      requestId,
      threadId,
      threadName: threadId === "origin" ? "origin" : data.route.threadName,
      tier: data.route.tier,
      provider: data.route.provider,
      modelId: data.route.modelId,
      timestamp: data.timestamp,
      ...(data.audit?.reason ? { reason: data.audit.reason } : {}),
      ...(data.route.decision.jevUsage ? { jevUsage: data.route.decision.jevUsage } : {}),
      ...(data.audit?.economics ? { economics: data.audit.economics } : {}),
      ...(data.audit?.forecast ? { forecast: data.audit.forecast } : {}),
    });
  }
  return records;
}

function extractUsageObservations(entries: readonly SessionEntry[]): Map<string, PersistedUsageObserved> {
  const observations = new Map<string, PersistedUsageObserved>();
  for (const entry of entries) {
    if (!isSwitchyardEntry(entry)) continue;
    const data = entry.data as RouterSessionEntryData | undefined;
    if (data?.kind !== "usage-observed") continue;
    // One settled aggregate is authoritative. Defensive duplicates from replay or
    // future recovery paths must not silently replace the original observation.
    if (!observations.has(data.requestId)) observations.set(data.requestId, data);
  }
  return observations;
}

export interface UsageRequestRow {
  requestId: string;
  threadId: string;
  threadName: string;
  tier: TierName;
  provider: string;
  modelId: string;
  timestamp: string;
  reason?: TransitionAudit["reason"];
  /** True when this request's model differs from the previous request routed to the same thread. */
  switched: boolean;
  /** Pre-request forecast: cost of staying warm on the incumbent, from the transition audit. */
  estimatedWarmStayUsd?: number;
  /** Pre-request forecast: cost of a cold switch to the candidate, from the transition audit. */
  estimatedColdSwitchUsd?: number;
  jevOverhead?: JevUsage;
  /** Present once the agent run settled and usage was observed. */
  turnCount?: number;
  observedUsage?: Usage;
  observedCacheHitRatio?: number;
  reportedModels?: string[];
}

/** Join persisted route (pre-execution estimate/audit) and usage-observed (actual) entries by requestId. */
export function buildUsageRequestRows(entries: readonly SessionEntry[]): UsageRequestRow[] {
  const routes = extractRouteRecords(entries);
  const observations = extractUsageObservations(entries);
  const lastModelKeyByThread = new Map<string, string>();
  const rows: UsageRequestRow[] = [];
  for (const route of routes) {
    const modelKey = `${route.provider}/${route.modelId}`;
    const previousModelKey = lastModelKeyByThread.get(route.threadId);
    const switched = previousModelKey !== undefined && previousModelKey !== modelKey;
    lastModelKeyByThread.set(route.threadId, modelKey);
    const observation = observations.get(route.requestId);
    const observedCacheHitRatio = observation ? cacheHitRatio(observation.usage) : undefined;
    rows.push({
      requestId: route.requestId,
      threadId: route.threadId,
      threadName: route.threadName,
      tier: route.tier,
      provider: route.provider,
      modelId: route.modelId,
      timestamp: route.timestamp,
      switched,
      ...(route.reason ? { reason: route.reason } : {}),
      ...(route.economics ? { estimatedWarmStayUsd: route.economics.warmStayCostUsd } : {}),
      ...(route.economics ? { estimatedColdSwitchUsd: route.economics.coldSwitchCostUsd } : {}),
      ...(route.jevUsage ? { jevOverhead: route.jevUsage } : {}),
      ...(observation
        ? {
            turnCount: observation.turnCount,
            observedUsage: observation.usage,
            reportedModels: observation.reportedModels,
            ...(observedCacheHitRatio !== undefined ? { observedCacheHitRatio } : {}),
          }
        : {}),
    });
  }
  return rows;
}

export interface ThreadSwitchSummary {
  threadId: string;
  threadName: string;
  /** Number of times this thread's incumbent model actually changed. */
  totalSwitches: number;
  /** Number of A→B→A patterns: a quick return to a model left one switch earlier. */
  rapidReturns: number;
}

/** Model switch and rapid-return (A→B→A) counts, one entry per thread that has route history. */
export function summarizeModelSwitches(rows: readonly UsageRequestRow[]): ThreadSwitchSummary[] {
  const byThread = new Map<string, UsageRequestRow[]>();
  for (const row of rows) {
    const list = byThread.get(row.threadId);
    if (list) list.push(row);
    else byThread.set(row.threadId, [row]);
  }
  const summaries: ThreadSwitchSummary[] = [];
  for (const [threadId, threadRows] of byThread) {
    const sorted = [...threadRows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const epochs: string[] = [];
    for (const row of sorted) {
      const key = `${row.provider}/${row.modelId}`;
      if (epochs.at(-1) !== key) epochs.push(key);
    }
    let rapidReturns = 0;
    for (let index = 0; index + 2 < epochs.length; index += 1) {
      if (epochs[index] === epochs[index + 2] && epochs[index] !== epochs[index + 1]) rapidReturns += 1;
    }
    summaries.push({
      threadId,
      threadName: sorted[0]?.threadName ?? threadId,
      totalSwitches: Math.max(0, epochs.length - 1),
      rapidReturns,
    });
  }
  return summaries.sort((a, b) => a.threadId.localeCompare(b.threadId));
}

export interface CacheHitBehaviorSummary {
  afterSwitchAverage?: number;
  afterSwitchSamples: number;
  stableAverage?: number;
  stableSamples: number;
}

/** Observed cache-hit ratio immediately after a model switch versus while staying on the same model. */
export function summarizeCacheHitBehavior(rows: readonly UsageRequestRow[]): CacheHitBehaviorSummary {
  const afterSwitch: number[] = [];
  const stable: number[] = [];
  for (const row of rows) {
    if (row.observedCacheHitRatio === undefined) continue;
    (row.switched ? afterSwitch : stable).push(row.observedCacheHitRatio);
  }
  const average = (values: number[]) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
  const afterSwitchAverage = average(afterSwitch);
  const stableAverage = average(stable);
  return {
    ...(afterSwitchAverage !== undefined ? { afterSwitchAverage } : {}),
    afterSwitchSamples: afterSwitch.length,
    ...(stableAverage !== undefined ? { stableAverage } : {}),
    stableSamples: stable.length,
  };
}

export interface JevOverheadSummary {
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** Total token overhead Jev itself consumed making routing decisions, when the SDK reports it. */
export function summarizeJevOverhead(rows: readonly UsageRequestRow[]): JevOverheadSummary {
  let requestCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const row of rows) {
    if (!row.jevOverhead) continue;
    requestCount += 1;
    totalInputTokens += row.jevOverhead.inputTokens;
    totalOutputTokens += row.jevOverhead.outputTokens;
  }
  return { requestCount, totalInputTokens, totalOutputTokens };
}

export interface ThreadModelTotal {
  threadId: string;
  threadName: string;
  provider: string;
  modelId: string;
  requestCount: number;
  observedCostUsd: number;
  observedTokens: number;
}

/** Observed spend and token totals grouped by thread and model. */
export function summarizeTotalsByThreadModel(rows: readonly UsageRequestRow[]): ThreadModelTotal[] {
  const totals = new Map<string, ThreadModelTotal>();
  for (const row of rows) {
    if (!row.observedUsage) continue;
    const key = `${row.threadId}\u0000${row.provider}/${row.modelId}`;
    const existing = totals.get(key);
    if (existing) {
      existing.requestCount += 1;
      existing.observedCostUsd += row.observedUsage.cost.total;
      existing.observedTokens += row.observedUsage.totalTokens;
    } else {
      totals.set(key, {
        threadId: row.threadId,
        threadName: row.threadName,
        provider: row.provider,
        modelId: row.modelId,
        requestCount: 1,
        observedCostUsd: row.observedUsage.cost.total,
        observedTokens: row.observedUsage.totalTokens,
      });
    }
  }
  return [...totals.values()].sort((a, b) => b.observedCostUsd - a.observedCostUsd);
}

export interface UsageSnapshot {
  generatedAt: string;
  recent: UsageRequestRow[];
  switches: ThreadSwitchSummary[];
  cacheHitBehavior: CacheHitBehaviorSummary;
  jevOverhead: JevOverheadSummary;
  totalsByThreadModel: ThreadModelTotal[];
}

export function buildUsageSnapshot(
  entries: readonly SessionEntry[],
  generatedAt: string,
  recentLimit = 10,
): UsageSnapshot {
  const rows = buildUsageRequestRows(entries);
  return {
    generatedAt,
    recent: rows.slice(-Math.max(0, recentLimit)),
    switches: summarizeModelSwitches(rows),
    cacheHitBehavior: summarizeCacheHitBehavior(rows),
    jevOverhead: summarizeJevOverhead(rows),
    totalsByThreadModel: summarizeTotalsByThreadModel(rows),
  };
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function threadLabel(threadId: string, threadName: string): string {
  return threadId === "origin" ? "origin" : `temp:${threadName}`;
}

function formatRequestRow(row: UsageRequestRow): string[] {
  const model = `${row.tier} · ${row.provider}/${row.modelId}`;
  const header = `${row.timestamp} · ${threadLabel(row.threadId, row.threadName)} · ${model}`
    + (row.switched ? " · switched" : "")
    + (row.reason ? ` · ${row.reason}` : "");
  const lines = [header];
  lines.push(
    `  estimated (pre-request forecast): warm-stay ${formatUsd(row.estimatedWarmStayUsd)} · cold-switch ${formatUsd(row.estimatedColdSwitchUsd)}`,
  );
  lines.push(
    row.observedUsage
      ? `  observed (actual billed usage):   $${row.observedUsage.cost.total.toFixed(4)} · ${row.turnCount ?? 0} turn(s) · cache-hit ${formatRatio(row.observedCacheHitRatio)}`
      : "  observed (actual billed usage):   not yet settled",
  );
  if (row.reportedModels && row.reportedModels.some((model) => model !== `${row.provider}/${row.modelId}`)) {
    lines.push(`  reported model(s): ${row.reportedModels.join(", ")} (differs from selected route)`);
  }
  if (row.jevOverhead) {
    lines.push(`  Jev routing overhead: ${row.jevOverhead.inputTokens} in / ${row.jevOverhead.outputTokens} out tokens`);
  }
  return lines;
}

/** Lines suitable for embedding a compact usage section inside another report (e.g. `/switchyard inspect`). */
export function buildUsageReportLines(snapshot: UsageSnapshot): string[] {
  const lines: string[] = [
    "Estimated figures are pre-request warm-stay/cold-switch forecasts from the transition policy.",
    "Observed figures are actual billed usage aggregated from assistant turns after a request settles.",
    "The gap between them is a forecast-vs-actual comparison, not a measured saving.",
    "",
    `Recent requests (${snapshot.recent.length}):`,
  ];
  if (snapshot.recent.length === 0) lines.push("  none recorded yet");
  for (const row of snapshot.recent) lines.push(...formatRequestRow(row).map((line) => `  ${line}`), "");

  lines.push("Model switches by thread:");
  if (snapshot.switches.length === 0) {
    lines.push("  none recorded yet");
  } else {
    for (const summary of snapshot.switches) {
      lines.push(
        `  ${threadLabel(summary.threadId, summary.threadName)}: ${summary.totalSwitches} switch(es) · ${summary.rapidReturns} rapid A→B→A return(s)`,
      );
    }
  }
  lines.push("");

  lines.push("Cache-hit behavior:");
  lines.push(
    `  immediately after a switch: ${formatRatio(snapshot.cacheHitBehavior.afterSwitchAverage)} avg over ${snapshot.cacheHitBehavior.afterSwitchSamples} request(s)`,
  );
  lines.push(
    `  staying on the same model:  ${formatRatio(snapshot.cacheHitBehavior.stableAverage)} avg over ${snapshot.cacheHitBehavior.stableSamples} request(s)`,
  );
  lines.push("");

  lines.push("Jev routing overhead:");
  lines.push(
    `  ${snapshot.jevOverhead.requestCount} request(s) · ${snapshot.jevOverhead.totalInputTokens} in / ${snapshot.jevOverhead.totalOutputTokens} out tokens`,
  );
  lines.push("");

  lines.push("Totals by thread/model (observed):");
  if (snapshot.totalsByThreadModel.length === 0) {
    lines.push("  none recorded yet");
  } else {
    for (const total of snapshot.totalsByThreadModel) {
      lines.push(
        `  ${threadLabel(total.threadId, total.threadName)} · ${total.provider}/${total.modelId}: ${total.requestCount} request(s) · $${total.observedCostUsd.toFixed(4)} · ${total.observedTokens.toLocaleString()} tokens`,
      );
    }
  }
  return lines;
}

export function formatUsageReport(snapshot: UsageSnapshot): string {
  const lines = [`Switchyard Usage · ${snapshot.generatedAt}`, "", ...buildUsageReportLines(snapshot)];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
