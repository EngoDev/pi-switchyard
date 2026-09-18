import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

import { estimateTempThreadStats } from "./lifecycle.js";
import { findLastRouteForThread } from "./threads.js";
import type { TempThread } from "./types.js";

/**
 * Pure, read-only building blocks for `/switchyard threads`.
 *
 * Every function here takes already-resolved plain data (a session's entries and the live
 * `TempThread` snapshots), so the bounded/filterable list and its per-thread summary can be unit
 * tested without mocking Pi's runtime or the model registry.
 */

export interface ThreadSummaryRow {
  id: string;
  name: string;
  /** Compact "tier · provider/modelId" label, or a placeholder when the thread has never routed. */
  incumbentLabel: string;
  /** Compaction-aware estimated context tokens, with no hypothetical pending prompt added. */
  contextTokens: number;
  /** Completed user turns tagged to this thread. */
  turns: number;
}

const NO_INCUMBENT_LABEL = "no incumbent yet";

export function buildThreadSummaryRows(
  entries: readonly SessionEntry[],
  threads: readonly TempThread[],
): ThreadSummaryRow[] {
  return threads.map((thread) => {
    const incumbent = findLastRouteForThread(entries, thread.id);
    const stats = estimateTempThreadStats(entries, thread);
    return {
      id: thread.id,
      name: thread.name,
      incumbentLabel: incumbent
        ? `${incumbent.tier} · ${incumbent.provider}/${incumbent.modelId}`
        : NO_INCUMBENT_LABEL,
      contextTokens: stats.tokens,
      turns: stats.turns,
    };
  });
}

export function formatThreadSummaryDescription(row: ThreadSummaryRow): string {
  const turnLabel = row.turns === 1 ? "1 turn" : `${row.turns} turns`;
  return `${row.incumbentLabel} · ~${Math.round(row.contextTokens).toLocaleString()} tokens · ${turnLabel}`;
}

/** Bounded/filterable list items for the thread picker; `showPicker` supplies search and scroll bounds. */
export function buildThreadSelectItems(rows: readonly ThreadSummaryRow[]): SelectItem[] {
  return rows.map((row) => ({
    value: row.id,
    label: `temp:${row.name}`,
    description: formatThreadSummaryDescription(row),
  }));
}

export type ThreadManagementAction = "inspect" | "rename" | "summarize" | "promote" | "retire";

export const THREAD_ACTION_ITEMS: ReadonlyArray<SelectItem & { value: ThreadManagementAction }> = [
  {
    value: "inspect",
    label: "Inspect",
    description: "Read-only snapshot of this thread's incumbent, context, and recent routes",
  },
  {
    value: "rename",
    label: "Rename",
    description: "Change its display name for future labels and routing; history keeps its original label",
  },
  {
    value: "summarize",
    label: "Summarize into origin",
    description: "Attribute a handoff summary to origin, then archive this thread",
  },
  {
    value: "promote",
    label: "Promote to child session",
    description: "Create a durable child session seeded from this thread's history",
  },
  {
    value: "retire",
    label: "Retire",
    description: "Archive without deleting history (confirmation required)",
  },
];
