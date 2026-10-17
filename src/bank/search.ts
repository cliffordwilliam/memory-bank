// Turns Claude's keywords into a safe FTS5 query (spec §7.2). Raw text is
// FTS5 syntax: "co-op" reads as a column filter and "don't" as an unfinished
// string. Quoting every word makes each one a plain term; OR between them
// means filler words can't cause zero results, and bm25 ranks the matches.

import { BankError } from "../errors";

const MAX_KEYWORDS = 20;

export function toFtsQuery(query: string): string {
  // Keep only words with at least one letter or digit; a lone "-" or "?"
  // would quote to a phrase with no terms.
  const words = query.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) {
    throw new BankError("query needs at least one keyword (letters or digits)");
  }
  if (words.length > MAX_KEYWORDS) {
    throw new BankError(`query has ${words.length} keywords; use at most ${MAX_KEYWORDS}`);
  }
  return words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" OR ");
}
