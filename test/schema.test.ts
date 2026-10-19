// SQL-level tests for migrations/0001_init.sql: the tables, constraints and
// triggers, exercised directly against a local D1 (spec §5, build plan phase 2).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const db = env.DB;

let counter = 0;
/** A fresh, valid name for each test, so tests don't share chains. */
function uniqueName(prefix = "test"): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

async function createName(name: string, type = "log"): Promise<void> {
  await db.prepare("INSERT INTO names (name, type) VALUES (?, ?)").bind(name, type).run();
}

interface RecordInput {
  name: string;
  occurredAt?: string;
  description?: string;
  body?: string;
  corrects?: number | null;
  kind?: string | null;
}

/** Inserts a record and returns its id. */
async function addRecord(input: RecordInput): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO records (name, occurred_at, description, body, corrects, kind)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      input.name,
      input.occurredAt ?? "2026-10-15T21:00:00+07:00",
      input.description ?? "A description",
      input.body ?? "A body",
      input.corrects ?? null,
      input.kind ?? null,
    )
    .first<{ id: number }>();
  return row!.id;
}

async function getRecord(id: number) {
  return db.prepare("SELECT * FROM records WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

async function search(query: string): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT rowid AS id FROM records_fts WHERE records_fts MATCH ? ORDER BY rowid")
    .bind(query)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

describe("types", () => {
  it("are seeded with the five types and their descriptions", async () => {
    const { results } = await db
      .prepare("SELECT name, description FROM types ORDER BY name")
      .all<{ name: string; description: string }>();
    expect(results.map((t) => t.name)).toEqual(["feedback", "log", "project", "reference", "user"]);
    for (const t of results) expect(t.description.length).toBeGreaterThan(20);
  });
});

describe("names", () => {
  it("accept a lowercase slug with a known type", async () => {
    await createName("vanilla-cupcakes", "reference");
    const row = await db.prepare("SELECT * FROM names WHERE name = 'vanilla-cupcakes'").first();
    expect(row).toMatchObject({ type: "reference", modified_at: null });
    expect(row!.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("refuse an unknown type", async () => {
    await expect(createName(uniqueName(), "health")).rejects.toThrow(/FOREIGN KEY/i);
  });

  it.each(["Meds", "my meds", "meds_2", "", "x".repeat(65)])("refuse the bad slug %j", async (name) => {
    await expect(createName(name)).rejects.toThrow(/CHECK/i);
  });

  it("are unique", async () => {
    const name = uniqueName();
    await createName(name);
    await expect(createName(name)).rejects.toThrow(/UNIQUE|PRIMARY KEY/i);
  });
});

describe("records", () => {
  it("need an existing name", async () => {
    await expect(addRecord({ name: "no-such-name" })).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("get ids in save order and a created_at in UTC", async () => {
    const name = uniqueName();
    await createName(name);
    const first = await addRecord({ name });
    const second = await addRecord({ name });
    expect(second).toBeGreaterThan(first);
    expect((await getRecord(first))!.created_at).toMatch(/Z$/);
  });

  it("refuse a multi-line or too long description", async () => {
    const name = uniqueName();
    await createName(name);
    await expect(addRecord({ name, description: "two\nlines" })).rejects.toThrow(/CHECK/i);
    await expect(addRecord({ name, description: "x".repeat(201) })).rejects.toThrow(/CHECK/i);
  });

  it("accept a body of 16,000 characters and refuse 16,001 or an empty one", async () => {
    const name = uniqueName();
    await createName(name);
    await addRecord({ name, body: "x".repeat(16000) });
    await expect(addRecord({ name, body: "x".repeat(16001) })).rejects.toThrow(/CHECK/i);
    await expect(addRecord({ name, body: "" })).rejects.toThrow(/CHECK/i);
  });
});

describe("occurred_at and its derived UTC copy", () => {
  it.each([
    // [as sent, derived UTC]
    ["2026-10-15T21:00:00+07:00", "2026-10-15T14:00:00.000Z"],
    // Early morning local time is the previous day in UTC.
    ["2026-10-16T06:00:00+07:00", "2026-10-15T23:00:00.000Z"],
    // Across a month boundary and a year boundary.
    ["2026-11-01T03:30:00+07:00", "2026-10-31T20:30:00.000Z"],
    ["2027-01-01T05:00:00+07:00", "2026-12-31T22:00:00.000Z"],
    // Half-hour and negative offsets.
    ["2026-10-15T09:00:00+05:30", "2026-10-15T03:30:00.000Z"],
    ["2026-10-15T20:00:00-05:00", "2026-10-16T01:00:00.000Z"],
    // Already UTC, with and without fractional seconds.
    ["2026-10-15T14:00:00Z", "2026-10-15T14:00:00.000Z"],
    ["2026-10-15T14:00:00.250Z", "2026-10-15T14:00:00.250Z"],
  ])("stores %s verbatim and derives %s", async (sent, utc) => {
    const name = uniqueName();
    await createName(name);
    const record = await getRecord(await addRecord({ name, occurredAt: sent }));
    expect(record!.occurred_at).toBe(sent);
    expect(record!.occurred_at_utc).toBe(utc);
  });

  it("refuses a time without an offset", async () => {
    const name = uniqueName();
    await createName(name);
    await expect(addRecord({ name, occurredAt: "2026-10-15T21:00:00" })).rejects.toThrow(/CHECK/i);
  });

  it("refuses text that isn't a time, because the derived copy would be NULL", async () => {
    const name = uniqueName();
    await createName(name);
    await expect(addRecord({ name, occurredAt: "last monday+07:00" })).rejects.toThrow(/NOT NULL/i);
  });

  it("documents that SQLite silently rolls an impossible date over (so Zod must refuse it)", async () => {
    const name = uniqueName();
    await createName(name);
    const record = await getRecord(await addRecord({ name, occurredAt: "2026-02-30T12:00:00Z" }));
    expect(record!.occurred_at_utc).toBe("2026-03-02T12:00:00.000Z");
  });

  it("sorts by the moment, not by the text", async () => {
    const name = uniqueName();
    await createName(name);
    // As text, "21:00+07:00" sorts after "15:00Z", but it's the earlier moment.
    const later = await addRecord({ name, occurredAt: "2026-10-15T15:00:00Z" });
    const earlier = await addRecord({ name, occurredAt: "2026-10-15T21:00:00+07:00" });
    const { results } = await db
      .prepare("SELECT id FROM records WHERE name = ? ORDER BY occurred_at_utc, id")
      .bind(name)
      .all<{ id: number }>();
    expect(results.map((r) => r.id)).toEqual([earlier, later]);
  });
});

describe("corrections", () => {
  it("link a new record to an earlier one of the same name", async () => {
    const name = uniqueName();
    await createName(name);
    const wrong = await addRecord({ name, body: "ibuprofen" });
    const fix = await addRecord({ name, body: "paracetamol", corrects: wrong, kind: "correction" });
    expect(await getRecord(fix)).toMatchObject({ corrects: wrong, kind: "correction" });
  });

  it("refuse a record of another name", async () => {
    const a = uniqueName();
    const b = uniqueName();
    await createName(a);
    await createName(b);
    const other = await addRecord({ name: a });
    await expect(addRecord({ name: b, corrects: other, kind: "correction" })).rejects.toThrow(
      /corrects: must point to an existing record of the same name/,
    );
  });

  it("refuse a record that doesn't exist", async () => {
    const name = uniqueName();
    await createName(name);
    await expect(addRecord({ name, corrects: 999_999, kind: "correction" })).rejects.toThrow(
      /corrects: must point/,
    );
  });

  it("refuse a record correcting itself, even with the next id guessed", async () => {
    const name = uniqueName();
    await createName(name);
    const last = await addRecord({ name });
    await expect(addRecord({ name, corrects: last + 1, kind: "correction" })).rejects.toThrow(
      /corrects: must point/,
    );
  });

  it("allow only one correction per record; a correction is corrected in turn", async () => {
    const name = uniqueName();
    await createName(name);
    const wrong = await addRecord({ name });
    const fix = await addRecord({ name, corrects: wrong, kind: "correction" });
    await expect(addRecord({ name, corrects: wrong, kind: "retraction" })).rejects.toThrow(/UNIQUE/i);
    const retraction = await addRecord({ name, corrects: fix, kind: "retraction" });
    expect(await getRecord(retraction)).toMatchObject({ corrects: fix, kind: "retraction" });
  });

  it("need corrects and kind together, and kind must be known", async () => {
    const name = uniqueName();
    await createName(name);
    const wrong = await addRecord({ name });
    await expect(addRecord({ name, corrects: wrong })).rejects.toThrow(/CHECK/i);
    await expect(addRecord({ name, kind: "correction" })).rejects.toThrow(/CHECK/i);
    await expect(addRecord({ name, corrects: wrong, kind: "redaction" })).rejects.toThrow(/CHECK/i);
  });
});

describe("append-only", () => {
  it.each(["records", "names", "types"])("refuses deleting from %s", async (table) => {
    // The triggers fire per row, so there must be rows to delete.
    const name = uniqueName();
    await createName(name);
    await addRecord({ name });
    await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow(/append-only/);
  });

  it.each([
    ["id", "id + 1000"],
    ["name", "'other'"],
    ["created_at", "'2020-01-01T00:00:00.000Z'"],
    ["occurred_at", "'2020-01-01T00:00:00Z'"],
    ["corrects", "NULL"],
    ["kind", "NULL"],
  ])("refuses changing a record's %s", async (column, value) => {
    const name = uniqueName();
    await createName(name);
    const id = await addRecord({ name });
    await expect(db.prepare(`UPDATE records SET ${column} = ${value} WHERE id = ?`).bind(id).run()).rejects.toThrow(
      /append-only/,
    );
  });

  it("refuses writing the generated UTC copy", async () => {
    const name = uniqueName();
    await createName(name);
    const id = await addRecord({ name });
    await expect(
      db.prepare("UPDATE records SET occurred_at_utc = 'x' WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/generated column/i);
  });

  it.each([
    ["name", "'renamed'"],
    ["created_at", "'2020-01-01T00:00:00.000Z'"],
  ])("refuses changing a name's %s", async (column, value) => {
    const name = uniqueName();
    await createName(name);
    await expect(
      db.prepare(`UPDATE names SET ${column} = ${value} WHERE name = ?`).bind(name).run(),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses renaming a type", async () => {
    await expect(db.prepare("UPDATE types SET name = 'meals' WHERE name = 'log'").run()).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("full-text search", () => {
  it("finds new records, with plurals matching the singular", async () => {
    const name = uniqueName();
    await createName(name, "reference");
    const id = await addRecord({ name, description: "Vanilla cupcakes", body: "Makes 12 with cream cheese frosting" });
    expect(await search("cupcake")).toContain(id);
    expect(await search("frosting")).toContain(id);
    expect(await search(`"${name}"`)).toContain(id);
  });

  it("documents that raw punctuation is search syntax (so the server must quote words)", async () => {
    // "test-1" parses as a column filter, and an unbalanced quote is a syntax error.
    await expect(search("test-1")).rejects.toThrow(/no such column/);
    await expect(search("don't")).rejects.toThrow(/syntax error/);
    await expect(search(`"don't"`)).resolves.toBeDefined();
  });
});

describe("admin edits (spec §10)", () => {
  it("a redaction keeps the record, stamps modified_at and purges the old words from search", async () => {
    const name = uniqueName();
    await createName(name);
    const id = await addRecord({ name, body: "My password is hunter2" });
    expect(await search("hunter2")).toContain(id);

    await db.prepare("UPDATE records SET body = 'My password is [redacted]' WHERE id = ?").bind(id).run();
    await db.prepare("INSERT INTO records_fts (records_fts) VALUES ('optimize')").run();

    const record = await getRecord(id);
    expect(record).toMatchObject({ body: "My password is [redacted]" });
    expect(record!.modified_at).toMatch(/Z$/);
    expect(await search("hunter2")).not.toContain(id);
    expect(await search("redacted")).toContain(id);
  });

  it("changing a name's type stamps modified_at", async () => {
    const name = uniqueName();
    await createName(name, "user");
    await db.prepare("UPDATE names SET type = 'project' WHERE name = ?").bind(name).run();
    const row = await db.prepare("SELECT type, modified_at FROM names WHERE name = ?").bind(name).first();
    expect(row!.type).toBe("project");
    expect(row!.modified_at).toMatch(/Z$/);
  });

  it("changing a name's type still has to name a known type", async () => {
    const name = uniqueName();
    await createName(name);
    await expect(
      db.prepare("UPDATE names SET type = 'health' WHERE name = ?").bind(name).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("rewording a type's description works", async () => {
    await db.prepare("UPDATE types SET description = 'Reworded.' WHERE name = 'feedback'").run();
    const row = await db.prepare("SELECT description FROM types WHERE name = 'feedback'").first();
    expect(row!.description).toBe("Reworded.");
  });

  it("adding a type works", async () => {
    await db.prepare("INSERT INTO types (name, description) VALUES ('idea', 'Ideas to revisit.')").run();
    const name = uniqueName();
    await createName(name, "idea");
  });
});
