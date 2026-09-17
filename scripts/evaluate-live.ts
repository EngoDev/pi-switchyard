import { TypeSafeClient } from "@typesafe-ai/sdk";

import { resolveTypeSafeApiKey } from "../src/auth.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { decideRoute } from "../src/router.js";
import type { RouterConfig, TempThread } from "../src/types.js";

const apiKey = resolveTypeSafeApiKey();
if (!apiKey) throw new Error("TYPESAFE_API_KEY is unavailable");

const client = new TypeSafeClient({
  apiKey,
  timeout: 3_000,
  retry: { maxRetries: 0 },
  logLevel: "off",
});
const routeClient = {
  systemOne: async (request: any, options: any) => client.systemOne(request, options) as any,
};
const config: RouterConfig = {
  ...DEFAULT_CONFIG,
  tiers: {
    genius: { provider: "openai", modelId: "gpt-genius", thinking: "default" },
    smart: { provider: "openai", modelId: "gpt-smart", thinking: "high" },
    handy: { provider: "openai", modelId: "gpt-handy", thinking: "high" },
    cheap: { provider: "openai", modelId: "gpt-cheap", thinking: "off" },
  },
};
const originContext = [
  { role: "user" as const, text: "Implement the new model router", timestamp: 1 },
  { role: "assistant" as const, text: "Implemented and tested the router", timestamp: 2 },
];
const prThread: TempThread = {
  id: "prcheck123",
  name: "pull-request-check",
  createdAt: new Date(3).toISOString(),
  updatedAt: new Date(4).toISOString(),
  seedContext: originContext,
  firstPrompt: "Did you create a pull request?",
  lastUserText: "Did you create a pull request?",
  lastAssistantText: "No pull request exists yet. Would you like me to create one?",
};

const cases: Array<{
  name: string;
  prompt: string;
  threads: TempThread[];
  lastVisibleRoute?: { threadId: string; threadName: string; tier: "handy"; model: string };
}> = [
  { name: "continue-main", prompt: "Continue implementing the router and fix the remaining tests.", threads: [] },
  { name: "pr-status-aside", prompt: "Did you create a pull request?", threads: [] },
  { name: "reuse-pr-thread", prompt: "Yes, create it.", threads: [prThread] },
  { name: "simple-main-status", prompt: "What files have changed?", threads: [] },
  {
    name: "current-temp-dependent",
    prompt: "Could the same PR failure affect merge automation?",
    threads: [prThread],
    lastVisibleRoute: { threadId: prThread.id, threadName: prThread.name, tier: "handy", model: "openai/gpt-handy" },
  },
  {
    name: "new-sibling-from-origin",
    prompt: "Separately, using only origin context, check whether the README was updated.",
    threads: [prThread],
    lastVisibleRoute: { threadId: prThread.id, threadName: prThread.name, tier: "handy", model: "openai/gpt-handy" },
  },
];

for (const item of cases) {
  const decision = await decideRoute(routeClient, {
    prompt: item.prompt,
    hasImages: false,
    originContext,
    threads: item.threads,
    config,
    ...(item.lastVisibleRoute ? { lastVisibleRoute: item.lastVisibleRoute } : {}),
  });
  console.log(item.name, JSON.stringify(decision));
}
