// The data layer: every SQL statement the Worker runs, and nowhere else.
//
// Read top to bottom, this file is the proof of a promise in the spec: the
// server only ever SELECTs and INSERTs. There is no UPDATE and no DELETE
// here (test/store.test.ts checks that across all of src/), so the edits
// the triggers still allow are the owner's alone.
//
// These functions return plain rows and decide nothing: the rules, the error
// messages and the shape Claude sees live in the operations that call them.

import type { Kind, Topic } from "./results";

// ── types and names ─────────────────────────────────────────────────────────

export interface TypeRow {
  name: string;
  description: string;
}

/** The types table: names and the descriptions Claude reads. */
export async function types(db: D1Database): Promise<TypeRow[]> {
  const { results } = await db.prepare("SELECT name, description FROM types ORDER BY name").all<TypeRow>();
  return results;
}

export async function typeNames(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT name FROM types ORDER BY name").all<{ name: string }>();
  return results.map((r) => r.name);
}

export interface NameRow {
  name: string;
  type: string;
  /** The name's newest record, or null if it has none. */
  head: number | null;
}

export async function getName(db: D1Database, name: string): Promise<NameRow | null> {
  return db
    .prepare(
      `SELECT n.name, n.type, (SELECT max(id) FROM records r WHERE r.name = n.name) AS head
       FROM names n WHERE n.name = ?`,
    )
    .bind(name)
    .first<NameRow>();
}

/** Every name (of one type, if given), alphabetically. */
export async function listNames(db: D1Database, type?: string): Promise<{ name: string; type: string }[]> {
  const stmt = type
    ? db.prepare("SELECT name, type FROM names WHERE type = ? ORDER BY name").bind(type)
    : db.prepare("SELECT name, type FROM names ORDER BY name");
  const { results } = await stmt.all<{ name: string; type: string }>();
  return results;
}

// ── saving ──────────────────────────────────────────────────────────────────

/** The record a correction points at: its name, and whether it's already corrected. */
export async function correctionTarget(
  db: D1Database,
  id: number,
): Promise<{ name: string; corrected_by: number | null } | null> {
  return db
    .prepare(
      `SELECT r.name, c.id AS corrected_by
       FROM records r LEFT JOIN records c ON c.corrects = r.id
       WHERE r.id = ?`,
    )
    .bind(id)
    .first<{ name: string; corrected_by: number | null }>();
}

export interface NewRecord {
  name: string;
  /** Set to create the name in the same batch, with this type. */
  newNameType?: string;
  occurred_at: string;
  description: string;
  body: string;
  corrects?: number;
  kind?: Kind;
}

/**
 * Inserts the record, and the name first if it's new, in one batch: either
 * both land or neither does. Throws the database's error when a constraint
 * or trigger refuses (e.g. another save got in first).
 */
export async function insertRecord(
  db: D1Database,
  record: NewRecord,
): Promise<{ id: number; occurred_at: string; created_at: string }> {
  const statements: D1PreparedStatement[] = [];
  if (record.newNameType !== undefined) {
    statements.push(db.prepare("INSERT INTO names (name, type) VALUES (?, ?)").bind(record.name, record.newNameType));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO records (name, occurred_at, description, body, corrects, kind)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id, occurred_at, created_at`,
      )
      .bind(
        record.name,
        record.occurred_at,
        record.description,
        record.body,
        record.corrects ?? null,
        record.kind ?? null,
      ),
  );
  const results = await db.batch<{ id: number; occurred_at: string; created_at: string }>(statements);
  return results[results.length - 1]!.results[0]!;
}

/** The record directly below `id` in its name's chain, or null. */
export async function previousId(db: D1Database, name: string, id: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT max(id) AS id FROM records WHERE name = ? AND id < ?")
    .bind(name, id)
    .first<{ id: number | null }>();
  return row?.id ?? null;
}

// ── reading records ─────────────────────────────────────────────────────────

/** One record as stored, with its name's type and its correction links. */
export interface RecordRow {
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
  kind: Kind | null;
  corrected_by: number | null;
  corrected_kind: Kind | null;
}

const COLUMNS = `
  r.id, r.name, n.type, r.description, r.body, r.occurred_at, r.occurred_at_utc,
  r.created_at, r.modified_at, r.corrects, r.kind,
  c.id AS corrected_by, c.kind AS corrected_kind`;

const JOINS = `
  JOIN names n ON n.name = r.name
  LEFT JOIN records c ON c.corrects = r.id`;

/** Exactly these records, in id order. */
export async function recordsByIds(db: D1Database, ids: number[]): Promise<RecordRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM records r ${JOINS} WHERE r.id IN (${ids.map(() => "?").join(", ")}) ORDER BY r.id`)
    .bind(...ids)
    .all<RecordRow>();
  return results;
}

export interface RecordQuery {
  /** A ready FTS5 expression (see search.ts), or none. */
  fts?: string;
  name?: string;
  type?: string;
  /** UTC bounds on occurred_at_utc: after inclusive, before exclusive. */
  afterUtc?: string;
  beforeUtc?: string;
  orderBy: "relevance" | "occurred_at" | "created_at";
  direction: "newest" | "oldest";
  limit: number;
  /**
   * Where the previous page ended: [occurred_at_utc or id, id] of its last
   * row, for occurred_at/created_at. Relevance pages by offset instead.
   */
  cursor?: [string | number, number];
  offset?: number;
}

/** One page of matching records, plus how many match in all. */
export async function queryRecords(db: D1Database, q: RecordQuery): Promise<{ total: number; rows: RecordRow[] }> {
  const from = q.fts ? `records_fts JOIN records r ON r.id = records_fts.rowid ${JOINS}` : `records r ${JOINS}`;
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.fts) (where.push("records_fts MATCH ?"), params.push(q.fts));
  if (q.name !== undefined) (where.push("r.name = ?"), params.push(q.name));
  if (q.type !== undefined) (where.push("n.type = ?"), params.push(q.type));
  if (q.afterUtc !== undefined) (where.push("r.occurred_at_utc >= ?"), params.push(q.afterUtc));
  if (q.beforeUtc !== undefined) (where.push("r.occurred_at_utc < ?"), params.push(q.beforeUtc));

  // Sorting, and where the next page continues. Ties always break by id in
  // the same direction, so every position is unique.
  const desc = q.direction === "newest";
  const cmp = desc ? "<" : ">";
  const pageWhere = [...where];
  const pageParams = [...params];
  let order: string;
  let offset = 0;
  if (q.orderBy === "relevance") {
    order = "records_fts.rank, r.id DESC";
    offset = q.offset ?? 0;
  } else if (q.orderBy === "occurred_at") {
    order = `r.occurred_at_utc ${desc ? "DESC" : "ASC"}, r.id ${desc ? "DESC" : "ASC"}`;
    if (q.cursor) {
      const [time, id] = q.cursor;
      pageWhere.push(`(r.occurred_at_utc ${cmp} ? OR (r.occurred_at_utc = ? AND r.id ${cmp} ?))`);
      pageParams.push(time, time, id);
    }
  } else {
    // created_at: save order, which is id order.
    order = `r.id ${desc ? "DESC" : "ASC"}`;
    if (q.cursor) {
      pageWhere.push(`r.id ${cmp} ?`);
      pageParams.push(q.cursor[1]);
    }
  }

  const whereSql = (clauses: string[]) => (clauses.length ? `WHERE ${clauses.join(" AND ")}` : "");
  const [countResult, pageResult] = await db.batch<RecordRow | { total: number }>([
    db.prepare(`SELECT count(*) AS total FROM ${from} ${whereSql(where)}`).bind(...params),
    db
      .prepare(`SELECT ${COLUMNS} FROM ${from} ${whereSql(pageWhere)} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...pageParams, q.limit, offset),
  ]);
  return {
    total: (countResult!.results[0] as { total: number }).total,
    rows: pageResult!.results as RecordRow[],
  };
}

// ── topics ──────────────────────────────────────────────────────────────────

/** A topic plus the key it's sorted and paged by (its latest id, 0 if none). */
export type TopicRow = Topic & { sort_id: number };

export interface TopicQuery {
  type?: string;
  limit: number;
  /** Where the previous page ended: [name, sort_id] of its last row. */
  cursor?: [string, number];
}

/** One page of names, newest activity first, plus how many there are in all. */
export async function queryTopics(db: D1Database, q: TopicQuery): Promise<{ total: number; rows: TopicRow[] }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.type !== undefined) (where.push("n.type = ?"), params.push(q.type));
  const pageWhere: string[] = [];
  const pageParams: unknown[] = [];
  if (q.cursor) {
    const [name, latest] = q.cursor;
    pageWhere.push("(t.sort_id < ? OR (t.sort_id = ? AND t.name > ?))");
    pageParams.push(latest, latest, name);
  }

  const summary = `
    SELECT n.name, n.type, count(r.id) AS record_count, max(r.id) AS latest_id,
           coalesce(max(r.id), 0) AS sort_id
    FROM names n LEFT JOIN records r ON r.name = n.name
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY n.name`;

  const [countResult, pageResult] = await db.batch<{ total: number } | TopicRow>([
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
      .bind(...params, ...pageParams, q.limit),
  ]);
  return {
    total: (countResult!.results[0] as { total: number }).total,
    rows: pageResult!.results as TopicRow[],
  };
}
