// recall: read records, like a GET with filters and pages (spec §7.2).
// Nothing is hidden: wrong records come back too, marked with corrected_by.

import { BankError } from "./errors";
import { describeNames, getName, typeNames } from "./lookups";
import { decodePageToken, encodePageToken, type PageState } from "./paging";
import { parse, recallInput, type RecallInput } from "./schemas";
import { toFtsQuery } from "./search";
import { millisToUtcText, wallClockToMillis } from "./time";

const DEFAULT_MAX_RESULTS = 10;
/** Pages with more records than this get their bodies cut short. */
const FULL_BODY_LIMIT = 3;
const TRUNCATED_BODY = 500;

export interface RecalledRecord {
  id: number;
  name: string;
  type: string;
  description: string;
  body: string;
  body_truncated?: true;
  occurred_at: string;
  created_at: string;
  corrects?: number;
  kind?: string;
  corrected_by?: number;
  corrected_kind?: string;
  modified_at?: string;
}

export interface RecallResult {
  records: RecalledRecord[];
  total: number;
  next_page_token?: string;
  missing_ids?: number[];
}

interface Row {
  id: number;
  name: string;
  type: string;
  description: string;
  body: string;
  occurred_at: string;
  occurred_at_utc: string;
  created_at: string;
  modified_at: string | null;
  corrects: number | null;
  kind: string | null;
  corrected_by: number | null;
  corrected_kind: string | null;
}

const COLUMNS = `
  r.id, r.name, n.type, r.description, r.body, r.occurred_at, r.occurred_at_utc,
  r.created_at, r.modified_at, r.corrects, r.kind,
  c.id AS corrected_by, c.kind AS corrected_kind`;

const JOINS = `
  JOIN names n ON n.name = r.name
  LEFT JOIN records c ON c.corrects = r.id`;

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
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM records r ${JOINS} WHERE r.id IN (${ids.map(() => "?").join(", ")}) ORDER BY r.id`)
    .bind(...ids)
    .all<Row>();
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
  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;

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
    if (!types.includes(input.type)) throw new BankError(`type must be one of: ${types.join(", ")}`);
  }
  const after = input.after !== undefined ? millisToUtcText(wallClockToMillis(input.after)!) : undefined;
  const before = input.before !== undefined ? millisToUtcText(wallClockToMillis(input.before)!) : undefined;
  if (after !== undefined && before !== undefined && after >= before) {
    throw new BankError("after must be earlier than before");
  }
  const fts = input.query !== undefined ? toFtsQuery(input.query) : undefined;

  const from = fts ? `records_fts JOIN records r ON r.id = records_fts.rowid ${JOINS}` : `records r ${JOINS}`;
  const where: string[] = [];
  const params: unknown[] = [];
  if (fts) (where.push("records_fts MATCH ?"), params.push(fts));
  if (input.name !== undefined) (where.push("r.name = ?"), params.push(input.name));
  if (input.type !== undefined) (where.push("n.type = ?"), params.push(input.type));
  if (after !== undefined) (where.push("r.occurred_at_utc >= ?"), params.push(after));
  if (before !== undefined) (where.push("r.occurred_at_utc < ?"), params.push(before));

  const fingerprint = JSON.stringify([fts, input.name, input.type, after, before, orderBy, direction]);
  const page: PageState | undefined = input.page_token ? decodePageToken(input.page_token, fingerprint) : undefined;

  // Sorting, and where the next page continues. Ties always break by id in
  // the same direction, so every position is unique.
  const desc = direction === "newest";
  const cmp = desc ? "<" : ">";
  const pageWhere = [...where];
  const pageParams = [...params];
  let order: string;
  let offset = 0;
  if (orderBy === "relevance") {
    order = "records_fts.rank, r.id DESC";
    offset = page?.offset ?? 0;
  } else if (orderBy === "occurred_at") {
    order = `r.occurred_at_utc ${desc ? "DESC" : "ASC"}, r.id ${desc ? "DESC" : "ASC"}`;
    if (page?.after) {
      const [time, id] = page.after;
      pageWhere.push(`(r.occurred_at_utc ${cmp} ? OR (r.occurred_at_utc = ? AND r.id ${cmp} ?))`);
      pageParams.push(time, time, id);
    }
  } else {
    // created_at: save order, which is id order.
    order = `r.id ${desc ? "DESC" : "ASC"}`;
    if (page?.after) {
      pageWhere.push(`r.id ${cmp} ?`);
      pageParams.push(page.after[1]);
    }
  }

  const whereSql = (clauses: string[]) => (clauses.length ? `WHERE ${clauses.join(" AND ")}` : "");
  const [countResult, pageResult] = await db.batch<Row | { total: number }>([
    db.prepare(`SELECT count(*) AS total FROM ${from} ${whereSql(where)}`).bind(...params),
    db
      .prepare(`SELECT ${COLUMNS} FROM ${from} ${whereSql(pageWhere)} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...pageParams, maxResults + 1, offset),
  ]);
  const total = (countResult!.results[0] as { total: number }).total;
  const rows = pageResult!.results as Row[];

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

function toRecord(row: Row, truncate: boolean): RecalledRecord {
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
