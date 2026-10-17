// What the bank's operations return: the output half of the tool contract
// (spec §7). The input half is src/bank/schemas.ts. Claude receives these as
// JSON; optional fields are left out when they don't apply.

/** What a correction claims about the record it points at. */
export type Kind = "correction" | "retraction";

/** remember: the record just saved. */
export interface RememberResult {
  id: number;
  name: string;
  /** The name's type (fixed when the name was created). */
  type: string;
  /** Exactly as sent: wall-clock time with offset. */
  occurred_at: string;
  /** When it was saved, in UTC. */
  created_at: string;
  /** The record this one now sits on top of; null for a new name. */
  previous_id: number | null;
  /** Present when this record corrects an earlier one. */
  corrects?: number;
  kind?: Kind;
}

/** recall: one stored record. */
export interface RecalledRecord {
  id: number;
  name: string;
  type: string;
  description: string;
  body: string;
  /** Set when the body was cut to 500 characters (pages of more than 3). */
  body_truncated?: true;
  /** Exactly as sent: wall-clock time with offset. */
  occurred_at: string;
  /** When it was saved, in UTC. */
  created_at: string;
  /** This record corrects an earlier one. */
  corrects?: number;
  kind?: Kind;
  /** A later record says this one was wrong (computed when reading). */
  corrected_by?: number;
  corrected_kind?: Kind;
  /** Set when the owner redacted the text by hand. */
  modified_at?: string;
}

/** recall: one page of records. */
export interface RecallResult {
  records: RecalledRecord[];
  /** How many records match in total, across all pages. */
  total: number;
  /** Present when there are more: pass it back with the same filters. */
  next_page_token?: string;
  /** recall(ids) only: requested ids that don't exist. */
  missing_ids?: number[];
}

/** list_topics: one name and its latest record. */
export interface Topic {
  name: string;
  type: string;
  record_count: number;
  latest_id: number | null;
  latest_occurred_at: string | null;
  latest_description: string | null;
}

/** list_topics: one page of names, newest activity first. */
export interface ListTopicsResult {
  topics: Topic[];
  total: number;
  next_page_token?: string;
}
