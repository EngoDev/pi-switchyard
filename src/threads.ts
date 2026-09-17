import { randomUUID } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type {
  ParentContextItem,
  RouterSessionEntryData,
  TaggedAgentMessage,
  TempThread,
} from "./types.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "could",
  "do",
  "for",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "please",
  "the",
  "this",
  "to",
  "we",
  "with",
  "you",
]);

export function getMessageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function toParentContextItem(message: AgentMessage): ParentContextItem | undefined {
  if (!(["user", "assistant", "toolResult", "custom"] as string[]).includes(message.role)) return undefined;
  const text = getMessageText(message);
  if (!text) return undefined;
  const item: ParentContextItem = {
    role: message.role as ParentContextItem["role"],
    text,
    timestamp: message.timestamp,
  };
  if (message.role === "toolResult") item.toolName = message.toolName;
  return item;
}

export function getParentContext(messages: readonly AgentMessage[], limit: number): ParentContextItem[] {
  return messages
    .filter((message) => !(message as TaggedAgentMessage).jevRouter)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map(toParentContextItem)
    .filter((item): item is ParentContextItem => item !== undefined)
    .slice(-limit);
}

export function messagesFromEntries(entries: readonly SessionEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "message") messages.push(entry.message);
    if (entry.type === "custom_message") {
      const details = entry.details && typeof entry.details === "object"
        ? entry.details as Record<string, unknown>
        : undefined;
      const routerMetadata = details?.jevRouter;
      const jevRouter = routerMetadata && typeof routerMetadata === "object"
        && typeof (routerMetadata as Record<string, unknown>).threadId === "string"
        && typeof (routerMetadata as Record<string, unknown>).threadName === "string"
        ? routerMetadata as { threadId: string; threadName: string }
        : undefined;
      messages.push({
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: new Date(entry.timestamp).getTime(),
        ...(jevRouter ? { jevRouter } : {}),
      } as TaggedAgentMessage);
    }
  }
  return messages;
}

export function makeThreadName(prompt: string, existingNames: Iterable<string>): string {
  const existing = new Set(existingNames);
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .slice(0, 4);
  const base = (words.join("-") || "temp").slice(0, 36).replace(/-+$/g, "");
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function createTempThread(
  prompt: string,
  seedContext: ParentContextItem[],
  existingNames: Iterable<string>,
  now = new Date(),
): TempThread {
  const timestamp = now.toISOString();
  return {
    id: randomUUID().replaceAll("-", "").slice(0, 10),
    name: makeThreadName(prompt, existingNames),
    createdAt: timestamp,
    updatedAt: timestamp,
    seedContext,
    firstPrompt: prompt,
    lastUserText: prompt,
  };
}

export function updateThreadFromMessage(thread: TempThread, message: AgentMessage): void {
  const text = getMessageText(message);
  if (!text) return;
  thread.updatedAt = new Date(message.timestamp).toISOString();
  if (message.role === "user" || message.role === "custom") thread.lastUserText = text;
  if (message.role === "assistant") thread.lastAssistantText = text;
}

export function restoreThreads(entries: readonly SessionEntry[]): Map<string, TempThread> {
  const threads = new Map<string, TempThread>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "jev-router") continue;
    const data = entry.data as RouterSessionEntryData | undefined;
    if (data?.kind === "thread-created") threads.set(data.thread.id, { ...data.thread });
  }
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const tagged = entry.message as TaggedAgentMessage;
    const threadId = tagged.jevRouter?.threadId;
    if (!threadId) continue;
    const thread = threads.get(threadId);
    if (thread) updateThreadFromMessage(thread, entry.message);
  }
  return threads;
}

export function formatSeedContext(items: readonly ParentContextItem[]): string {
  if (items.length === 0) return "No parent messages were available when this temp thread was created.";
  return [
    "Parent-session snapshot captured when this temp thread was created:",
    ...items.map((item) => `[${item.role}] ${item.text}`),
  ].join("\n\n");
}

export function filterMessagesForThread(
  messages: readonly AgentMessage[],
  thread: TempThread,
): AgentMessage[] {
  const threadMessages = messages.filter(
    (message) => (message as TaggedAgentMessage).jevRouter?.threadId === thread.id,
  );
  const seedMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: formatSeedContext(thread.seedContext) }],
    timestamp: new Date(thread.createdAt).getTime(),
  };
  return [seedMessage, ...threadMessages];
}

export function filterMessagesForParent(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => !(message as TaggedAgentMessage).jevRouter);
}
