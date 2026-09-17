import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  appendFileLists,
  collectOriginFileLists,
  type OriginSummarizer,
} from "./compaction.js";
import { getRouterMetadata } from "./threads.js";

export interface OriginBranchSummaryInput {
  entriesToSummarize: SessionEntry[];
  userWantsSummary: boolean;
  customInstructions: string | undefined;
  replaceInstructions: boolean | undefined;
}

export type OriginBranchSummaryOutcome =
  | { action: "default" }
  | { action: "cancel"; reason: string }
  | {
      action: "summary";
      summary: {
        summary: string;
        usage?: Usage;
        details: {
          readFiles: string[];
          modifiedFiles: string[];
          switchyard: {
            version: 1;
            threadAware: true;
            excludedTempMessages: number;
          };
        };
      };
    };

function entryMessages(entry: SessionEntry): AgentMessage[] {
  return sessionEntryToContextMessages(entry);
}

function entryContainsTemp(entry: SessionEntry): boolean {
  return entryMessages(entry).some((message) => Boolean(getRouterMetadata(message)));
}

function previousOriginFileLists(entries: readonly SessionEntry[]): {
  readFiles: string[];
  modifiedFiles: string[];
} | undefined {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  let found = false;
  for (const entry of entries) {
    if (entry.type !== "branch_summary" || !entry.details || typeof entry.details !== "object") continue;
    const details = entry.details as Record<string, unknown>;
    const router = details.switchyard ?? details.jevRouter;
    if (!router || typeof router !== "object" || (router as Record<string, unknown>).threadAware !== true) continue;
    if (Array.isArray(details.readFiles)) {
      for (const path of details.readFiles) if (typeof path === "string") readFiles.add(path);
    }
    if (Array.isArray(details.modifiedFiles)) {
      for (const path of details.modifiedFiles) if (typeof path === "string") modifiedFiles.add(path);
    }
    found = true;
  }
  return found ? { readFiles: [...readFiles], modifiedFiles: [...modifiedFiles] } : undefined;
}

export async function summarizeOriginBranch(
  input: OriginBranchSummaryInput,
  summarize: OriginSummarizer,
): Promise<OriginBranchSummaryOutcome> {
  if (!input.userWantsSummary) return { action: "default" };

  const tempEntries = input.entriesToSummarize.filter(entryContainsTemp);
  if (tempEntries.length === 0) return { action: "default" };

  const originEntries = input.entriesToSummarize.filter((entry) => !entryContainsTemp(entry));
  const originMessages = originEntries.flatMap(entryMessages);
  const fileLists = collectOriginFileLists(originMessages, previousOriginFileLists(originEntries));
  if (originMessages.length === 0) {
    return {
      action: "summary",
      summary: {
        summary: appendFileLists("No origin-session work was present on the abandoned branch.", fileLists),
        details: {
          ...fileLists,
          switchyard: {
            version: 1,
            threadAware: true,
            excludedTempMessages: tempEntries.flatMap(entryMessages).length,
          },
        },
      },
    };
  }

  try {
    const result = await summarize({
      scope: { kind: "origin" },
      messages: originMessages,
      previousSummary: undefined,
      customInstructions: input.customInstructions,
      ...(input.replaceInstructions !== undefined
        ? { replaceInstructions: input.replaceInstructions }
        : {}),
    });
    if (!result.summary.trim()) return { action: "cancel", reason: "Origin branch summary was empty" };
    return {
      action: "summary",
      summary: {
        summary: appendFileLists(result.summary, fileLists),
        ...(result.usage ? { usage: result.usage } : {}),
        details: {
          ...fileLists,
          switchyard: {
            version: 1,
            threadAware: true,
            excludedTempMessages: tempEntries.flatMap(entryMessages).length,
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
