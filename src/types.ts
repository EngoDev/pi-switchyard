import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";

export const TIER_NAMES = ["genius", "smart", "handy", "cheap"] as const;
export type TierName = (typeof TIER_NAMES)[number];
export type ThinkingSelection = ThinkingLevel | "default";

export interface TierConfig {
  provider: string;
  modelId: string;
  thinking: ThinkingSelection;
}

export interface RouterConfig {
  version: 1;
  enabled: boolean;
  debug: boolean;
  tiers: Partial<Record<TierName, TierConfig>>;
  routerContextMessages: number;
  initialOriginMessages: number;
  targetConfidenceFloor: number;
  tierConfidenceFloor: number;
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

export interface RouteDecision {
  target: "origin" | "new_temp" | string;
  tier: TierName;
  targetConfidence: number;
  tierConfidence: number;
  targetProbabilities: Record<string, number>;
  tierProbabilities: Record<TierName, number>;
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

export interface PersistedRoute {
  kind: "route";
  route: ActiveRoute;
  prompt: string;
  timestamp: string;
}

export type RouterSessionEntryData = PersistedThreadCreated | PersistedRoute;
