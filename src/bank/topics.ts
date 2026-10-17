// list_topics: the index of names, like MEMORY.md (spec §7.3).

import { BankError } from "./errors";
import { typeNames } from "./lookups";
import { decodePageToken, encodePageToken } from "./paging";
import { listTopicsInput, parse } from "./schemas";

const DEFAULT_MAX_RESULTS = 50;

export interface Topic {
  name: string;
  type: string;
  record_count: number;
  latest_id: number | null;
  latest_occurred_at: string | null;
  latest_description: string | null;
}

export interface ListTopicsResult {
  topics: Topic[];
  total: number;
  next_page_token?: string;
}

export async function listTopics(db: D1Database, raw: unknown): Promise<ListTopicsResult> {
  const input = parse(listTopicsInput, raw);
  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;

  if (input.type !== undefined) {
    const types = await typeNames(db);
    if (!types.includes(input.type)) throw new BankError(`type must be one of: ${types.join(", ")}`);
  }

  const fingerprint = JSON.stringify(["topics", input.type]);
  const page = input.page_token ? decodePageToken(input.page_token, fingerprint) : undefined;

  // Newest activity first (highest latest_id); names break ties so paging is exact.
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.type !== undefined) (where.push("n.type = ?"), params.push(input.type));
  const pageWhere: string[] = [];
  const pageParams: unknown[] = [];
  if (page?.after) {
    const [name, latest] = page.after;
    pageWhere.push("(t.sort_id < ? OR (t.sort_id = ? AND t.name > ?))");
    pageParams.push(latest, latest, name);
  }

  const summary = `
    SELECT n.name, n.type, count(r.id) AS record_count, max(r.id) AS latest_id,
           coalesce(max(r.id), 0) AS sort_id
    FROM names n LEFT JOIN records r ON r.name = n.name
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY n.name`;

  const [countResult, pageResult] = await db.batch<{ total: number } | Topic & { sort_id: number }>([
    db.prepare(`SELECT count(*) AS total FROM names n ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).bind(...params),
    db
      .prepare(
        `WITH t AS (${summary})
         SELECT t.name, t.type, t.record_count, t.latest_id, t.sort_id,
                l.occurred_at AS latest_occurred_at, l.description AS latest_description
         FROM t LEFT JOIN records l ON l.id = t.latest_id
         ${pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : ""}
         ORDER BY t.sort_id DESC, t.name
         LIMIT ?`,
      )
      .bind(...params, ...pageParams, maxResults + 1),
  ]);
  const total = (countResult!.results[0] as { total: number }).total;
  const rows = pageResult!.results as (Topic & { sort_id: number })[];

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
