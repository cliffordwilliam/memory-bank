// recall: read records, like a GET with filters and pages (spec §7.2).
// Nothing is hidden: wrong records come back too, marked with corrected_by.

import { BankError } from "../errors";
import { describeNames } from "./lookups";
import { decodePageToken, encodePageToken, type PageState } from "./paging";
import type { RecalledRecord, RecallResult } from "./results";
import { DEFAULT_RECALL_RESULTS, parse, recallInput, type RecallInput } from "./schemas";
import { toFtsQuery } from "./search";
import { getName, queryRecords, recordsByIds, type RecordRow, typeNames } from "./store";
import { millisToUtcText, wallClockToMillis } from "./time";

/** Pages with more records than this get their bodies cut short. */
export const FULL_BODY_LIMIT = 3;
export const TRUNCATED_BODY = 500;

export async function recall(db: D1Database, raw: unknown): Promise<RecallResult> {
  const input = parse(recallInput, raw);
  return input.ids ? recallByIds(db, input) : recallByFilters(db, input);
}

async function recallByIds(db: D1Database, input: RecallInput): Promise<RecallResult> {
  // R12: ids are exact; filters would only hide some of them.
  const others = Object.keys(input).filter((key) => key !== "ids");
  if (others.length > 0) {
    throw new BankError(`ids can't be combined with other filters (got ${others.join(", ")})`);
  }
  const ids = [...new Set(input.ids!)];
  const results = await recordsByIds(db, ids);
  const found = new Set(results.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  return {
    records: results.map((row) => toRecord(row, false)),
    total: results.length,
    ...(missing.length > 0 && { missing_ids: missing }),
  };
}

async function recallByFilters(db: D1Database, input: RecallInput): Promise<RecallResult> {
  const orderBy = input.order_by ?? (input.query !== undefined ? "relevance" : "occurred_at");
  const direction = input.direction ?? "newest";
  const maxResults = input.max_results ?? DEFAULT_RECALL_RESULTS;

  // R13: relevance only means something with keywords.
  if (orderBy === "relevance" && input.query === undefined) {
    throw new BankError("order_by=relevance needs a query; use occurred_at or created_at");
  }
  // R11: a misremembered name is an error, never a confident "nothing found".
  if (input.name !== undefined && !(await getName(db, input.name))) {
    throw new BankError(`name '${input.name}' doesn't exist. ${await describeNames(db)}`);
  }
  if (input.type !== undefined) {
    const types = await typeNames(db);
    if (!types.includes(input.type)) throw new BankError(`type: must be one of: ${types.join(", ")}`);
  }
  const after = input.after !== undefined ? millisToUtcText(wallClockToMillis(input.after)!) : undefined;
  const before = input.before !== undefined ? millisToUtcText(wallClockToMillis(input.before)!) : undefined;
  if (after !== undefined && before !== undefined && after >= before) {
    throw new BankError("after must be earlier than before");
  }
  const fts = input.query !== undefined ? toFtsQuery(input.query) : undefined;

  const fingerprint = JSON.stringify([fts, input.name, input.type, after, before, orderBy, direction]);
  const page: PageState | undefined = input.page_token ? decodePageToken(input.page_token, fingerprint) : undefined;
  const offset = page?.offset ?? 0;

  const { total, rows } = await queryRecords(db, {
    fts,
    name: input.name,
    type: input.type,
    afterUtc: after,
    beforeUtc: before,
    orderBy,
    direction,
    limit: maxResults + 1, // one extra, to know whether there's a next page
    after: page?.after,
    offset,
  });

  const hasMore = rows.length > maxResults;
  const pageRows = rows.slice(0, maxResults);
  const last = pageRows[pageRows.length - 1];
  let next: string | undefined;
  if (hasMore && last) {
    next = encodePageToken(
      orderBy === "relevance"
        ? { f: fingerprint, offset: offset + maxResults }
        : { f: fingerprint, after: [orderBy === "occurred_at" ? last.occurred_at_utc : last.id, last.id] },
    );
  }

  const truncate = pageRows.length > FULL_BODY_LIMIT;
  return {
    records: pageRows.map((row) => toRecord(row, truncate)),
    total,
    ...(next && { next_page_token: next }),
  };
}

function toRecord(row: RecordRow, truncate: boolean): RecalledRecord {
  const cut = truncate && row.body.length > TRUNCATED_BODY;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    body: cut ? row.body.slice(0, TRUNCATED_BODY) : row.body,
    ...(cut && { body_truncated: true as const }),
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    ...(row.corrects !== null && { corrects: row.corrects, kind: row.kind! }),
    ...(row.corrected_by !== null && { corrected_by: row.corrected_by, corrected_kind: row.corrected_kind! }),
    ...(row.modified_at !== null && { modified_at: row.modified_at }),
  };
}
