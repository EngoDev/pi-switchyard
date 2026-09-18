import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { TransitionAudit } from "./switching.js";

export const TIER_NAMES = ["genius", "smart", "handy", "cheap"] as const;
export type TierName = (typeof TIER_NAMES)[number];
export type ThinkingSelection = ThinkingLevel | "default";
export type DebugMode = "off" | "minimal" | "verbose";

export interface TierConfig {
  provider: string;
  modelId: string;
  thinking: ThinkingSelection;
}

export interface ModelEconomics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<{
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }>;
}

export interface SwitchingConfig {
  cacheAware: boolean;
  upgradesAlwaysSwitch: boolean;
  downgradeConfidenceFloor: number;
  minSavingsRatio: number;
  minSavingsUsd: number;
  unknownCostPolicy: "stay" | "switch";
  assumedWarmCacheRatio: number;
  assumedCacheWriteRatio: number;
  defaultExpectedOutputTokens: number;
  downgradeMode: "enforce" | "shadow";
  evidenceDecay: number;
  minimumEvidenceScore: number;
  minimumEvidenceWeight: number;
  hardRequirementPenalty: number;
  forecastTurns: number;
  returnProbabilityFloor: number;
  returnCostMultiplier: number;
  economics: Record<string, ModelEconomics>;
}

export interface RouterConfig {
  version: 1;
  enabled: boolean;
  debug: DebugMode;
  tiers: Partial<Record<TierName, TierConfig>>;
  routerContextMessages: number;
  initialOriginMessages: number;
  targetConfidenceFloor: number;
  tierConfidenceFloor: number;
  tempThreadSoftTokenLimit: number;
  tempThreadSoftTurnLimit: number;
  switching: SwitchingConfig;
}

export interface TempThread {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  seedContext: OriginContextItem[];
  firstPrompt: string;
  lastUserText?: string;
  lastAssistantText?: string;
}

export interface OriginContextItem {
  role: "user" | "assistant" | "toolResult" | "custom";
  text: string;
  timestamp: number;
  toolName?: string;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RouteDecision {
  requestId?: string;
  target: "origin" | "new_temp_from_origin" | string;
  tier: TierName;
  targetConfidence: number;
  tierConfidence: number;
  targetProbabilities: Record<string, number>;
  tierProbabilities: Record<TierName, number>;
  /** Jev's own routing-call token usage, when the TypeSafe SDK reports it. */
  jevUsage?: JevUsage;
}

export interface ActiveRoute {
  threadId: "origin" | string;
  threadName: string;
  tier: TierName;
  provider: string;
  modelId: string;
  thinking: ThinkingSelection;
  decision: RouteDecision;
}

export interface RouterMessageMetadata {
  threadId: string;
  threadName: string;
}

export type TaggedAgentMessage = AgentMessage & {
  switchyard?: RouterMessageMetadata;
  /** Legacy metadata written by pi-jev-router. */
  jevRouter?: RouterMessageMetadata;
};

export interface PersistedThreadCreated {
  kind: "thread-created";
  thread: TempThread;
}

export interface PersistedThreadRetired {
  kind: "thread-retired";
  threadId: string;
  threadName: string;
  reason: "summarized-to-origin" | "promoted";
  timestamp: string;
}

export interface PersistedLifecyclePending {
  kind: "lifecycle-pending";
  token: string;
  pendingPrompt: string;
  pendingImageCount: number;
  timestamp: string;
}

export interface PersistedLifecycleCompleted {
  kind: "lifecycle-completed";
  token: string;
  timestamp: string;
}

export interface PersistedPromotionPending {
  kind: "promotion-pending";
  token: string;
  thread: TempThread;
  pendingPrompt: string;
  pendingImageCount: number;
  timestamp: string;
}

export interface PersistedPromotionCompleted {
  kind: "promotion-completed";
  token: string;
  childSession?: string;
  outcome: "completed" | "cancelled";
  timestamp: string;
}

export interface PersistedPromotedSession {
  kind: "promoted-session";
  token: string;
  sourceSession?: string;
  sourceEntryId?: string;
  sourceThreadId: string;
  sourceThreadName: string;
  pendingPrompt: string;
  pendingImageCount: number;
}

export interface PersistedPromotionConsumed {
  kind: "promotion-consumed";
  token: string;
  pendingPrompt: string;
  timestamp: string;
}

export interface PersistedRoute {
  kind: "route";
  route: ActiveRoute;
  prompt: string;
  timestamp: string;
  /** Compact model-transition audit for this route decision. Absent on entries written before task 26. */
  audit?: TransitionAudit;
}

/**
 * Actual per-request model execution observation, persisted once an agent run settles.
 *
 * Keyed by the same stable `requestId` as the `route` entry it belongs to, so a usage
 * report can join pre-execution estimate/audit data against observed billed usage
 * without duplicating the estimate. Aggregates every assistant turn of the request
 * (tool-loop turns, failed/retried attempts, steered continuations, and nested tool
 * usage when reported). Absent for requests interrupted before the agent run settled.
 */
export interface PersistedUsageObserved {
  kind: "usage-observed";
  requestId: string;
  threadId: string;
  threadName: string;
  tier: TierName;
  provider: string;
  modelId: string;
  /** Number of provider assistant attempts aggregated into `usage`. */
  turnCount: number;
  usage: Usage;
  /** Actual provider/model identifiers reported by responses; exposes proxy substitutions. */
  reportedModels: string[];
  timestamp: string;
}

export type RouterSessionEntryData =
  | PersistedThreadCreated
  | PersistedThreadRetired
  | PersistedLifecyclePending
  | PersistedLifecycleCompleted
  | PersistedPromotionPending
  | PersistedPromotionCompleted
  | PersistedPromotedSession
  | PersistedPromotionConsumed
  | PersistedRoute
  | PersistedUsageObserved;
