import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { getMessageText, toParentContextItem } from "./threads.js";
import type { ParentContextItem, TaggedAgentMessage } from "./types.js";

export const PARENT_CONTEXT_ROLES = ["user", "assistant", "toolResult", "custom"] as const;
export type ParentContextRole = (typeof PARENT_CONTEXT_ROLES)[number];
export type ParentContextOrder = "newest" | "oldest";

export interface ParentContextQuery {
  query?: string;
  roles?: ParentContextRole[];
  offset?: number;
  limit?: number;
  order?: ParentContextOrder;
  includeToolResults?: boolean;
}

export function selectParentContext(
  messages: readonly AgentMessage[],
  params: ParentContextQuery,
): ParentContextItem[] {
  const roles = new Set<ParentContextRole>(
    params.roles ?? (params.includeToolResults ? ["user", "assistant", "toolResult"] : ["user", "assistant"]),
  );
  if (!params.includeToolResults) roles.delete("toolResult");
  const query = params.query?.trim().toLowerCase();
  let items = messages
    .filter((message) => !(message as TaggedAgentMessage).jevRouter)
    .filter((message) => roles.has(message.role as ParentContextRole))
    .filter((message) => !query || getMessageText(message).toLowerCase().includes(query))
    .map(toParentContextItem)
    .filter((item): item is ParentContextItem => item !== undefined);

  if ((params.order ?? "newest") === "newest") items = items.reverse();
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const limit = Math.max(1, Math.min(20, Math.trunc(params.limit ?? 5)));
  return items.slice(offset, offset + limit);
}

export function formatParentContextResult(items: readonly ParentContextItem[]): string {
  if (items.length === 0) return "No parent-session context matched the request.";
  return items
    .map((item, index) => {
      const tool = item.toolName ? `:${item.toolName}` : "";
      return `## ${index + 1}. ${item.role}${tool}\n${item.text}`;
    })
    .join("\n\n");
}
