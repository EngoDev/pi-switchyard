import { createHash } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { getRouterMetadata, messagesFromEntries, threadContextFromEntries } from "./threads.js";
import type { RouterConfig, TempThread } from "./types.js";

export function fingerprintImages(images: readonly ImageContent[] | undefined): string {
  if (!images || images.length === 0) return "none";
  return createHash("sha256").update(JSON.stringify(images)).digest("hex");
}

export function ensurePromotionMessagesDurable(
  messages: readonly AgentMessage[],
  model: Model<any>,
): AgentMessage[] {
  if (messages.some((message) => message.role === "assistant")) return [...messages];
  return [
    ...messages,
    {
      role: "assistant",
      content: [{
        type: "text",
        text: "Switchyard promoted this temporary thread into a child session before it received a complete assistant response.",
      }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ];
}

export interface TempThreadBudget {
  tokens: number;
  turns: number;
  tokenLimitExceeded: boolean;
  turnLimitExceeded: boolean;
  exceeded: boolean;
}

export function projectTempThreadBudget(
  entries: readonly SessionEntry[],
  thread: TempThread,
  prompt: string,
  images: readonly ImageContent[] | undefined,
  config: RouterConfig,
): TempThreadBudget {
  const context = threadContextFromEntries(entries, thread);
  const pending: AgentMessage = {
    role: "user",
    content: [
      { type: "text", text: prompt },
      ...(images ?? []),
    ],
    timestamp: Date.now(),
  };
  const tokens = [...context, pending].reduce((total, message) => total + estimateTokens(message), 0);
  const turns = messagesFromEntries(entries).filter(
    (message) => message.role === "user" && getRouterMetadata(message)?.threadId === thread.id,
  ).length + 1;
  const tokenLimitExceeded = config.tempThreadSoftTokenLimit > 0
    && tokens >= config.tempThreadSoftTokenLimit;
  const turnLimitExceeded = config.tempThreadSoftTurnLimit > 0
    && turns >= config.tempThreadSoftTurnLimit;
  return {
    tokens,
    turns,
    tokenLimitExceeded,
    turnLimitExceeded,
    exceeded: tokenLimitExceeded || turnLimitExceeded,
  };
}

export function formatTempThreadHandoff(thread: TempThread, summary: string): string {
  return [
    `Switchyard handoff from temp:${thread.name}`,
    "",
    "The user chose to retire this temporary thread and return its relevant context to the origin conversation.",
    "",
    "<summary>",
    summary.trim(),
    "</summary>",
  ].join("\n");
}
