import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { getRouterMetadata, messagesFromEntries } from "./threads.js";

export const COMPACTION_FILES_ENTRY_TYPE = "switchyard-compaction-files";
const LEGACY_COMPACTION_FILES_ENTRY_TYPE = "jev-router-compaction-files";

export interface OriginCompactionInput {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  previousSummary: string | undefined;
  firstKeptEntryId: string;
  tokensBefore: number;
  customInstructions: string | undefined;
  previousFileLists?: {
    readFiles: string[];
    modifiedFiles: string[];
  };
}

export interface OriginSummaryRequest {
  scope: { kind: "origin" } | { kind: "temp"; threadId: string; threadName: string };
  messages: AgentMessage[];
  previousSummary: string | undefined;
  customInstructions: string | undefined;
  replaceInstructions?: boolean;
}

export interface OriginSummaryResult {
  summary: string;
  usage?: Usage;
}

export type OriginSummarizer = (request: OriginSummaryRequest) => Promise<OriginSummaryResult>;

export type OriginCompactionOutcome =
  | { action: "default" }
  | { action: "cancel"; reason: string }
  | {
      action: "compact";
      compaction: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        usage?: Usage;
        details: {
          readFiles: string[];
          modifiedFiles: string[];
          switchyard: {
            version: 1;
            threadAware: true;
            excludedTempMessages: number;
            tempThreads?: Record<string, {
              threadName: string;
              summary: string;
              firstKeptEntryId: string;
            }>;
          };
        };
      };
    };

function isTempMessage(message: AgentMessage): boolean {
  return Boolean(getRouterMetadata(message));
}

function fileListsFromCompaction(entry: Extract<SessionEntry, { type: "compaction" }>): {
  readFiles: string[];
  modifiedFiles: string[];
} | undefined {
  if (!entry.details || typeof entry.details !== "object") return undefined;
  const details = entry.details as Record<string, unknown>;
  if (!Array.isArray(details.readFiles) || !Array.isArray(details.modifiedFiles)) return undefined;
  return {
    readFiles: details.readFiles.filter((value): value is string => typeof value === "string"),
    modifiedFiles: details.modifiedFiles.filter((value): value is string => typeof value === "string"),
  };
}

export function findPreviousOriginFileLists(entries: readonly SessionEntry[]): {
  readFiles: string[];
  modifiedFiles: string[];
} | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "custom"
      || (entry.customType !== COMPACTION_FILES_ENTRY_TYPE && entry.customType !== LEGACY_COMPACTION_FILES_ENTRY_TYPE)
    ) continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (!data || !Array.isArray(data.readFiles) || !Array.isArray(data.modifiedFiles)) continue;
    return {
      readFiles: data.readFiles.filter((value): value is string => typeof value === "string"),
      modifiedFiles: data.modifiedFiles.filter((value): value is string => typeof value === "string"),
    };
  }

  const compactionIndexes = entries
    .map((entry, index) => entry.type === "compaction" ? index : -1)
    .filter((index) => index >= 0);
  if (compactionIndexes.length === 0) return undefined;

  const inspect = (position: number): { readFiles: string[]; modifiedFiles: string[] } | undefined => {
    const entryIndex = compactionIndexes[position];
    const entry = entryIndex === undefined ? undefined : entries[entryIndex];
    if (!entry || entry.type !== "compaction") return undefined;
    const lists = fileListsFromCompaction(entry);
    if (!lists) return undefined;
    const details = entry.details as Record<string, unknown>;
    const router = details.switchyard ?? details.jevRouter;
    if (router && typeof router === "object" && (router as Record<string, unknown>).threadAware === true) {
      return lists;
    }

    const previousIndex = position > 0 ? compactionIndexes[position - 1] : undefined;
    const previousEntry = previousIndex === undefined ? undefined : entries[previousIndex];
    if (previousEntry && previousEntry.type === "compaction" && !inspect(position - 1)) return undefined;
    const startIndex = previousEntry && previousEntry.type === "compaction"
      ? entries.findIndex((candidate) => candidate.id === previousEntry.firstKeptEntryId)
      : 0;
    const endIndex = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
    if (endIndex < 0) return undefined;
    const summarizedRange = entries.slice(Math.max(0, startIndex), endIndex);
    const containsTemp = summarizedRange.some((candidate) =>
      candidate.type === "message" && isTempMessage(candidate.message));
    return containsTemp ? undefined : lists;
  };

  return inspect(compactionIndexes.length - 1);
}

export function collectOriginFileLists(
  messages: readonly AgentMessage[],
  previous?: { readFiles: string[]; modifiedFiles: string[] },
): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set(previous?.readFiles ?? []);
  const modified = new Set(previous?.modifiedFiles ?? []);
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const path = typeof block.arguments.path === "string" ? block.arguments.path : undefined;
      if (!path) continue;
      if (block.name === "read") read.add(path);
      if (block.name === "write" || block.name === "edit") modified.add(path);
    }
  }
  for (const path of modified) read.delete(path);
  return {
    readFiles: [...read].sort(),
    modifiedFiles: [...modified].sort(),
  };
}

export function appendFileLists(
  summary: string,
  fileLists: { readFiles: string[]; modifiedFiles: string[] },
): string {
  const clean = summary
    .replace(/\n*<read-files>[\s\S]*?<\/read-files>/g, "")
    .replace(/\n*<modified-files>[\s\S]*?<\/modified-files>/g, "")
    .trimEnd();
  const sections: string[] = [];
  if (fileLists.readFiles.length > 0) {
    sections.push(`<read-files>\n${fileLists.readFiles.join("\n")}\n</read-files>`);
  }
  if (fileLists.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${fileLists.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length > 0 ? `${clean}\n\n${sections.join("\n\n")}` : clean;
}

export async function compactOriginThread(
  input: OriginCompactionInput,
  summarize: OriginSummarizer,
): Promise<OriginCompactionOutcome> {
  const allMessages = [...input.messagesToSummarize, ...input.turnPrefixMessages];
  const excludedTempMessages = allMessages.filter(isTempMessage).length;
  if (excludedTempMessages === 0) return { action: "default" };

  const originMessages = allMessages.filter((message) => !isTempMessage(message));
  const fileLists = collectOriginFileLists(originMessages, input.previousFileLists);
  if (originMessages.length === 0) {
    return {
      action: "compact",
      compaction: {
        summary: appendFileLists(
          input.previousSummary ?? "No additional origin-session messages were included in this compaction span.",
          fileLists,
        ),
        firstKeptEntryId: input.firstKeptEntryId,
        tokensBefore: input.tokensBefore,
        details: {
          ...fileLists,
          switchyard: {
            version: 1,
            threadAware: true,
            excludedTempMessages,
          },
        },
      },
    };
  }

  try {
    const result = await summarize({
      scope: { kind: "origin" },
      messages: originMessages,
      previousSummary: input.previousSummary,
      customInstructions: input.customInstructions,
    });
    if (!result.summary.trim()) return { action: "cancel", reason: "Origin compaction summary was empty" };
    return {
      action: "compact",
      compaction: {
        summary: appendFileLists(result.summary, fileLists),
        firstKeptEntryId: input.firstKeptEntryId,
        tokensBefore: input.tokensBefore,
        ...(result.usage ? { usage: result.usage } : {}),
        details: {
          ...fileLists,
          switchyard: {
            version: 1,
            threadAware: true,
            excludedTempMessages,
          },
        },
      },
    };
  } catch (error) {
    return {
      action: "cancel",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function collectTempCompactionInput(
  entries: readonly SessionEntry[],
  threadId: string,
  currentFirstKeptEntryId: string,
): { messages: AgentMessage[]; previousSummary: string | undefined } {
  let previousSummary: string | undefined;
  let previousBoundaryId: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "compaction" || !entry.details || typeof entry.details !== "object") continue;
    const details = entry.details as Record<string, unknown>;
    const router = details.switchyard ?? details.jevRouter;
    if (!router || typeof router !== "object") continue;
    const tempThreads = (router as Record<string, unknown>).tempThreads;
    if (!tempThreads || typeof tempThreads !== "object") continue;
    const record = (tempThreads as Record<string, unknown>)[threadId];
    if (!record || typeof record !== "object") continue;
    const candidate = record as Record<string, unknown>;
    if (typeof candidate.summary !== "string" || typeof candidate.firstKeptEntryId !== "string") continue;
    previousSummary = candidate.summary;
    previousBoundaryId = candidate.firstKeptEntryId;
    break;
  }

  const startIndex = previousBoundaryId
    ? entries.findIndex((entry) => entry.id === previousBoundaryId)
    : 0;
  const endIndex = entries.findIndex((entry) => entry.id === currentFirstKeptEntryId);
  if (endIndex < 0) return { messages: [], previousSummary };
  const messages = messagesFromEntries(entries.slice(Math.max(0, startIndex), endIndex));
  return { messages, previousSummary };
}

export interface TempCompactionInput {
  threadId: string;
  threadName: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  previousSummary: string | undefined;
  firstKeptEntryId: string;
  customInstructions: string | undefined;
}

export type TempCompactionOutcome =
  | { action: "default" }
  | { action: "cancel"; reason: string }
  | {
      action: "compact";
      summary: {
        threadName: string;
        summary: string;
        firstKeptEntryId: string;
        usage?: Usage;
      };
    };

export async function compactTempThread(
  input: TempCompactionInput,
  summarize: OriginSummarizer,
): Promise<TempCompactionOutcome> {
  const messages = [...input.messagesToSummarize, ...input.turnPrefixMessages]
    .filter((message) => getRouterMetadata(message)?.threadId === input.threadId)
    .filter((message) => message.role !== "assistant"
      || (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "length"));
  if (messages.length === 0) return { action: "default" };
  try {
    const result = await summarize({
      scope: { kind: "temp", threadId: input.threadId, threadName: input.threadName },
      messages,
      previousSummary: input.previousSummary,
      customInstructions: input.customInstructions,
    });
    if (!result.summary.trim()) return { action: "cancel", reason: "Temp compaction summary was empty" };
    return {
      action: "compact",
      summary: {
        threadName: input.threadName,
        summary: result.summary,
        firstKeptEntryId: input.firstKeptEntryId,
        ...(result.usage ? { usage: result.usage } : {}),
      },
    };
  } catch (error) {
    return {
      action: "cancel",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
