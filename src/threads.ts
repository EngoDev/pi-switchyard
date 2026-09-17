import { randomUUID } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type {
  OriginContextItem,
  RouterMessageMetadata,
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

export function getRouterMetadata(message: AgentMessage): RouterMessageMetadata | undefined {
  const topLevel = (message as TaggedAgentMessage).jevRouter;
  if (topLevel) return topLevel;
  if (message.role !== "custom" || !message.details || typeof message.details !== "object") return undefined;
  const nested = (message.details as Record<string, unknown>).jevRouter;
  if (!nested || typeof nested !== "object") return undefined;
  const candidate = nested as Record<string, unknown>;
  return typeof candidate.threadId === "string" && typeof candidate.threadName === "string"
    ? { threadId: candidate.threadId, threadName: candidate.threadName }
    : undefined;
}

export function getMessageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function toOriginContextItem(message: AgentMessage): OriginContextItem | undefined {
  if (!(["user", "assistant", "toolResult", "custom"] as string[]).includes(message.role)) return undefined;
  const text = getMessageText(message);
  if (!text) return undefined;
  const item: OriginContextItem = {
    role: message.role as OriginContextItem["role"],
    text,
    timestamp: message.timestamp,
  };
  if (message.role === "toolResult") item.toolName = message.toolName;
  return item;
}

export function getOriginContext(messages: readonly AgentMessage[], limit: number): OriginContextItem[] {
  return messages
    .filter((message) => !getRouterMetadata(message))
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map(toOriginContextItem)
    .filter((item): item is OriginContextItem => item !== undefined)
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
  seedContext: OriginContextItem[],
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
    const threadId = getRouterMetadata(entry.message)?.threadId;
    if (!threadId) continue;
    const thread = threads.get(threadId);
    if (thread) updateThreadFromMessage(thread, entry.message);
  }
  return threads;
}

export function formatSeedContext(items: readonly OriginContextItem[]): string {
  if (items.length === 0) return "No origin messages were available when this temp thread was created.";
  return [
    "Origin-session snapshot captured when this temp thread was created:",
    ...items.map((item) => `[${item.role}] ${item.text}`),
  ].join("\n\n");
}

export function filterMessagesForThread(
  messages: readonly AgentMessage[],
  thread: TempThread,
): AgentMessage[] {
  const threadMessages = messages.filter(
    (message) => getRouterMetadata(message)?.threadId === thread.id,
  );
  const seedMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: formatSeedContext(thread.seedContext) }],
    timestamp: new Date(thread.createdAt).getTime(),
  };
  return [seedMessage, ...threadMessages];
}

export function filterMessagesForOrigin(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => !getRouterMetadata(message));
}

function isReplayableThreadMessage(message: AgentMessage): boolean {
  return message.role !== "assistant"
    || (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "length");
}

export function threadContextFromEntries(
  entries: readonly SessionEntry[],
  thread: TempThread,
): AgentMessage[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "compaction" || !entry.details || typeof entry.details !== "object") continue;
    const router = (entry.details as Record<string, unknown>).jevRouter;
    if (!router || typeof router !== "object") continue;
    const tempThreads = (router as Record<string, unknown>).tempThreads;
    if (!tempThreads || typeof tempThreads !== "object") continue;
    const record = (tempThreads as Record<string, unknown>)[thread.id];
    if (!record || typeof record !== "object") continue;
    const summary = (record as Record<string, unknown>).summary;
    const firstKeptEntryId = (record as Record<string, unknown>).firstKeptEntryId;
    if (typeof summary !== "string" || typeof firstKeptEntryId !== "string") continue;

    const boundaryIndex = entries.findIndex((candidate) => candidate.id === firstKeptEntryId);
    const tailEntries = entries.slice(boundaryIndex >= 0 ? boundaryIndex : index + 1);
    const tailMessages = messagesFromEntries(tailEntries)
      .filter((message) => getRouterMetadata(message)?.threadId === thread.id)
      .filter(isReplayableThreadMessage);
    const context = filterMessagesForThread(tailMessages, thread);
    context.splice(1, 0, {
      role: "user",
      content: [{ type: "text", text: `Previous summary for temp thread ${thread.name}:\n\n${summary}` }],
      timestamp: new Date(entry.timestamp).getTime(),
    });
    return context;
  }

  const messages = messagesFromEntries(entries)
    .filter(isReplayableThreadMessage);
  return filterMessagesForThread(messages, thread);
}

export function findMissingTempLabels(
  entries: readonly SessionEntry[],
  getLabel: (entryId: string) => string | undefined,
): Array<{ entryId: string; label: string }> {
  const missing: Array<{ entryId: string; label: string }> = [];
  for (const entry of entries) {
    if (
      entry.type !== "message"
      || (entry.message.role !== "user" && entry.message.role !== "assistant")
    ) continue;
    const metadata = getRouterMetadata(entry.message);
    if (!metadata || getLabel(entry.id)) continue;
    missing.push({ entryId: entry.id, label: `temp:${metadata.threadName}` });
  }
  return missing;
}
