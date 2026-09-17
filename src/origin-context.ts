import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { getMessageText, getRouterMetadata, toOriginContextItem } from "./threads.js";
import type { OriginContextItem } from "./types.js";

export const ORIGIN_CONTEXT_ROLES = ["user", "assistant", "toolResult", "custom"] as const;
export type OriginContextRole = (typeof ORIGIN_CONTEXT_ROLES)[number];
export type OriginContextOrder = "newest" | "oldest";

export interface OriginContextQuery {
  query?: string;
  roles?: OriginContextRole[];
  offset?: number;
  limit?: number;
  order?: OriginContextOrder;
  includeToolResults?: boolean;
}

export function selectOriginContext(
  messages: readonly AgentMessage[],
  params: OriginContextQuery,
): OriginContextItem[] {
  const roles = new Set<OriginContextRole>(
    params.roles ?? (params.includeToolResults ? ["user", "assistant", "toolResult"] : ["user", "assistant"]),
  );
  if (!params.includeToolResults) roles.delete("toolResult");
  const query = params.query?.trim().toLowerCase();
  let items = messages
    .filter((message) => !getRouterMetadata(message))
    .filter((message) => roles.has(message.role as OriginContextRole))
    .filter((message) => !query || getMessageText(message).toLowerCase().includes(query))
    .map(toOriginContextItem)
    .filter((item): item is OriginContextItem => item !== undefined);

  if ((params.order ?? "newest") === "newest") items = items.reverse();
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const limit = Math.max(1, Math.min(20, Math.trunc(params.limit ?? 5)));
  return items.slice(offset, offset + limit);
}

export function formatOriginContextResult(items: readonly OriginContextItem[]): string {
  if (items.length === 0) return "No origin-session context matched the request.";
  return items
    .map((item, index) => {
      const tool = item.toolName ? `:${item.toolName}` : "";
      return `## ${index + 1}. ${item.role}${tool}\n${item.text}`;
    })
    .join("\n\n");
}
