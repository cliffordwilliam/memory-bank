// Small lookups used by the operations and their error messages.

const LIST_LIMIT = 100;

export async function typeNames(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT name FROM types ORDER BY name").all<{ name: string }>();
  return results.map((r) => r.name);
}

export interface NameInfo {
  name: string;
  type: string;
  head: number | null;
}

export async function getName(db: D1Database, name: string): Promise<NameInfo | null> {
  return db
    .prepare(
      `SELECT n.name, n.type, (SELECT max(id) FROM records r WHERE r.name = n.name) AS head
       FROM names n WHERE n.name = ?`,
    )
    .bind(name)
    .first<NameInfo>();
}

/**
 * "Existing log names: meals, medication." or "Existing names: meals (log), …"
 * A personal bank has tens of names, so listing them all is the most useful
 * hint; fuzzy matching would miss synonyms like meds/medication.
 */
export async function describeNames(db: D1Database, type?: string): Promise<string> {
  const stmt = type
    ? db.prepare("SELECT name, type FROM names WHERE type = ? ORDER BY name").bind(type)
    : db.prepare("SELECT name, type FROM names ORDER BY name");
  const { results } = await stmt.all<{ name: string; type: string }>();
  if (results.length === 0) {
    return type ? `There are no ${type} names yet.` : "There are no names yet.";
  }
  const shown = results.slice(0, LIST_LIMIT).map((r) => (type ? r.name : `${r.name} (${r.type})`));
  const more = results.length > LIST_LIMIT ? `, and ${results.length - LIST_LIMIT} more` : "";
  return `${type ? `Existing ${type} names` : "Existing names"}: ${shown.join(", ")}${more}.`;
}
