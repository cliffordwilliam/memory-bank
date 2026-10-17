// Hints for error messages, built from what the store returns.

import { listNames } from "./store";

const LIST_LIMIT = 100;

/**
 * "Existing log names: meals, medication." or "Existing names: meals (log), …"
 * A personal bank has tens of names, so listing them all is the most useful
 * hint; fuzzy matching would miss synonyms like meds/medication.
 */
export async function describeNames(db: D1Database, type?: string): Promise<string> {
  const names = await listNames(db, type);
  if (names.length === 0) {
    return type ? `There are no ${type} names yet.` : "There are no names yet.";
  }
  const shown = names.slice(0, LIST_LIMIT).map((r) => (type ? r.name : `${r.name} (${r.type})`));
  const more = names.length > LIST_LIMIT ? `, and ${names.length - LIST_LIMIT} more` : "";
  return `${type ? `Existing ${type} names` : "Existing names"}: ${shown.join(", ")}${more}.`;
}
