// list_topics: the index of names, like MEMORY.md (spec §7.3).

import { z } from "zod";
import { BankError } from "../errors";
import { cursorState, decodePageToken, encodePageToken, fingerprintOf } from "./paging";
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

  const fingerprint = await fingerprintOf(["topics", input.type]);
  const page = input.page_token ? decodePageToken(input.page_token, fingerprint, cursorState(z.string())) : undefined;

  // Newest activity first (highest latest_id); names break ties so paging is exact.
  const { total, rows } = await queryTopics(db, {
    type: input.type,
    limit: maxResults + 1,
    cursor: page?.cursor,
  });

  const pageRows = rows.slice(0, maxResults);
  const last = pageRows[pageRows.length - 1];
  const next =
    rows.length > maxResults && last
      ? encodePageToken({ f: fingerprint, cursor: [last.name, last.sort_id] })
      : undefined;

  return {
    topics: pageRows.map(({ sort_id: _, ...topic }) => topic),
    total,
    ...(next && { next_page_token: next }),
  };
}
