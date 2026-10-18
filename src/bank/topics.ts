// list_topics: the index of names, like MEMORY.md (spec §7.3).

import { BankError } from "../errors";
import { decodePageToken, encodePageToken } from "./paging";
import type { ListTopicsResult } from "./results";
import { DEFAULT_TOPICS_RESULTS, listTopicsInput, parse } from "./schemas";
import { queryTopics, typeNames } from "./store";

export async function listTopics(db: D1Database, raw: unknown): Promise<ListTopicsResult> {
  const input = parse(listTopicsInput, raw);
  const maxResults = input.max_results ?? DEFAULT_TOPICS_RESULTS;

  if (input.type !== undefined) {
    const types = await typeNames(db);
    if (!types.includes(input.type)) throw new BankError(`type: must be one of: ${types.join(", ")}`);
  }

  const fingerprint = JSON.stringify(["topics", input.type]);
  const page = input.page_token ? decodePageToken(input.page_token, fingerprint) : undefined;

  // Newest activity first (highest latest_id); names break ties so paging is exact.
  const { total, rows } = await queryTopics(db, {
    type: input.type,
    limit: maxResults + 1,
    after: page?.after as [string, number] | undefined,
  });

  const pageRows = rows.slice(0, maxResults);
  const last = pageRows[pageRows.length - 1];
  const next =
    rows.length > maxResults && last
      ? encodePageToken({ f: fingerprint, after: [last.name, last.sort_id] })
      : undefined;

  return {
    topics: pageRows.map(({ sort_id: _, ...topic }) => topic),
    total,
    ...(next && { next_page_token: next }),
  };
}
