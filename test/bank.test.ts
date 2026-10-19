// Phase 3: the bank's operations and every rule R1–R13 (spec §6, §7).
import { describe, expect, it } from "vitest";
import { recall, remember } from "../src/bank";
import { clock, db, NOW, save, tamperToken } from "./helpers";

const rememberRaw = (input: unknown) => remember(db, input, clock);

describe("remember", () => {
  it("creates a name with its first record, then adds on top of it", async () => {
    const name = "test";
    const first = await rememberRaw({
      name,
      new_name: true,
      type: "log",
      description: "400 mg ibuprofen, around 21:00",
      body: "I took 400 mg ibuprofen last night around 9.",
      occurred_at: "2026-10-15T21:00:00+07:00",
    });
    expect(first).toMatchObject({
      name,
      type: "log",
      occurred_at: "2026-10-15T21:00:00+07:00",
      previous_id: null,
    });
    expect(first.created_at).toMatch(/Z$/);
    expect(first).not.toHaveProperty("corrects");

    const second = await save({ name });
    expect(second.previous_id).toBe(first.id);
  });

  it("stores occurred_at exactly as sent, with or without seconds and fractions", async () => {
    for (const occurred_at of ["2026-10-15T21:00+07:00", "2026-10-15T21:00:00.25+07:00", "2026-10-15T14:00:00Z"]) {
      const saved = await save({ name: "test", occurred_at });
      expect(saved.occurred_at).toBe(occurred_at);
    }
  });

  it("R1: a new name needs a known type", async () => {
    const base = { name: "test", new_name: true, description: "d", body: "b", occurred_at: "2026-10-15T21:00:00+07:00" };
    await expect(rememberRaw(base)).rejects.toThrow("type: must be one of: feedback, log, project, reference, user");
    await expect(rememberRaw({ ...base, type: "health" })).rejects.toThrow("type: must be one of:");
  });

  it("R2: an unknown name is refused, listing the existing names", async () => {
    await save({ name: "medication" });
    const meds = { name: "meds", description: "d", body: "b", occurred_at: "2026-10-15T21:00:00+07:00" };
    await expect(rememberRaw(meds)).rejects.toThrow(
      /^name 'meds' doesn't exist\. Existing names: .*medication \(log\).* pass new_name=true with a type to create 'meds'\.$/,
    );
    // With a type given, only names of that type are listed.
    await expect(rememberRaw({ ...meds, type: "log" })).rejects.toThrow(/Existing log names: .*medication/);
  });

  it("R3: new_name for an existing name is refused, naming its head", async () => {
    const name = "test";
    const saved = await save({ name });
    await expect(save({ name, new_name: true, type: "log" })).rejects.toThrow(
      `'${name}' already exists (log, head #${saved.id}). Omit new_name to add a new version, or choose a different name.`,
    );
  });

  it("R4: type is only for new names", async () => {
    const name = "test";
    await save({ name });
    await expect(save({ name, type: "log" })).rejects.toThrow(
      `type is only for new names; '${name}' already exists (log). Omit type.`,
    );
  });

  it.each([
    ["no offset", "2026-10-15T21:00:00"],
    ["not a time", "last monday"],
    ["date only", "2026-10-15"],
    ["February 30", "2026-02-30T12:00:00Z"],
    ["February 29 in a common year", "2027-02-29T12:00:00Z"],
    ["hour 24", "2026-10-15T24:00:00Z"],
    ["offset beyond +14:00", "2026-10-15T21:00:00+15:00"],
    ["space instead of T", "2026-10-15 21:00:00+07:00"],
    // SQLite's date functions only cover UTC years 0000–9999.
    ["a UTC moment before year 0000", "0000-01-01T00:00:00+07:00"],
    ["a UTC moment after year 9999", "9999-12-31T23:00:00-05:00"],
  ])("R5: refuses occurred_at with %s", async (_, occurred_at) => {
    await expect(save({ name: "test", occurred_at })).rejects.toThrow(
      "occurred_at: must be a real wall-clock time with offset, e.g. 2026-10-12T21:00:00+07:00",
    );
  });

  it("R5: accepts February 29 in a leap year", async () => {
    await expect(save({ name: "test", occurred_at: "2028-02-29T12:00:00Z" })).rejects.toThrow(/future/);
    await expect(save({ name: "test-2", occurred_at: "2024-02-29T12:00:00Z" })).resolves.toBeDefined();
  });

  it("R5: reads years 0000–0099 as written, not as 1900–1999", async () => {
    // Year 0 is a leap year in the proleptic Gregorian calendar SQLite uses; 1900 isn't.
    await expect(save({ name: "test", occurred_at: "0000-02-29T12:00:00Z" })).resolves.toBeDefined();

    const name = "test-2";
    const record = await save({ name, occurred_at: "0050-01-01T00:00:00Z" });
    const found = await recall(db, { name, after: "0049-12-31T00:00:00Z", before: "0050-01-02T00:00:00Z" });
    expect(found.records.map((r) => r.id)).toEqual([record.id]);
  });

  it("R6: refuses a future time, with 5 minutes of slack", async () => {
    const inFourMinutes = new Date(NOW + 4 * 60_000).toISOString();
    const inSixMinutes = new Date(NOW + 6 * 60_000).toISOString();
    await expect(save({ name: "test", occurred_at: inFourMinutes })).resolves.toBeDefined();
    await expect(save({ name: "test-2", occurred_at: inSixMinutes })).rejects.toThrow(
      "occurred_at is in the future; check the date and offset",
    );
  });

  it("R7: checks the name, description and body", async () => {
    await expect(save({ name: "My Meds" })).rejects.toThrow(
      "name: must be lowercase letters, digits and hyphens (1–64 characters), e.g. vanilla-cupcakes",
    );
    await expect(save({ name: "test", description: "two\nlines" })).rejects.toThrow(
      "description: must be one line of at most 200 characters",
    );
    await expect(save({ name: "test-2", description: "x".repeat(201) })).rejects.toThrow(
      "description: must be one line of at most 200 characters",
    );
    await expect(save({ name: "test-3", body: "x".repeat(17_240) })).rejects.toThrow(
      "body: is 17240 characters; the limit is 16000",
    );
    await expect(save({ name: "test-4", body: "x".repeat(16_000) })).resolves.toBeDefined();
  });

  it("R7: counts characters the way SQLite does, so an emoji is one", async () => {
    // "🍰" is one character but two UTF-16 units.
    await expect(save({ name: "test", body: "🍰".repeat(16_000) })).resolves.toBeDefined();
    await expect(save({ name: "test-2", description: "🍰".repeat(200) })).resolves.toBeDefined();
    await expect(save({ name: "test-3", body: "🍰".repeat(16_001) })).rejects.toThrow(
      "body: is 16001 characters; the limit is 16000",
    );
    await expect(save({ name: "test-4", description: "🍰".repeat(201) })).rejects.toThrow(
      "description: must be one line of at most 200 characters",
    );
  });

  it("R8: corrects and kind go together", async () => {
    const name = "test";
    const wrong = await save({ name });
    await expect(save({ name, corrects: wrong.id })).rejects.toThrow(
      "kind: is required with corrects (correction or retraction)",
    );
    await expect(save({ name, kind: "correction" })).rejects.toThrow("kind: needs corrects");
    await expect(save({ name, corrects: wrong.id, kind: "redaction" })).rejects.toThrow(
      "kind: must be correction or retraction",
    );
  });

  it("R9: a correction points to an existing record of the same name", async () => {
    const meals = "meals";
    const meds = "meds";
    const meal = await save({ name: meals });
    await save({ name: meds });
    await expect(save({ name: meds, corrects: meal.id, kind: "correction" })).rejects.toThrow(
      `#${meal.id} is in '${meals}', not '${meds}'`,
    );
    await expect(save({ name: meds, corrects: 999_999, kind: "correction" })).rejects.toThrow("#999999 doesn't exist");
  });

  it("R10: a record is corrected once; a correction is corrected in turn", async () => {
    const name = "test";
    const wrong = await save({ name, body: "ibuprofen" });
    const fix = await save({ name, body: "paracetamol", corrects: wrong.id, kind: "correction" });
    expect(fix).toMatchObject({ corrects: wrong.id, kind: "correction", previous_id: wrong.id });
    await expect(save({ name, corrects: wrong.id, kind: "retraction" })).rejects.toThrow(
      `#${wrong.id} is already corrected by #${fix.id}. To fix the correction, pass corrects=${fix.id}.`,
    );
    await expect(save({ name, corrects: fix.id, kind: "retraction" })).resolves.toMatchObject({ corrects: fix.id });
  });

  it("refuses unknown parameters instead of ignoring them", async () => {
    await expect(save({ name: "test", source: "web" })).rejects.toThrow(/Unrecognized key.*source/);
  });

  it("reports several problems at once", async () => {
    await expect(
      rememberRaw({ name: "Bad Name", description: "", body: "b", occurred_at: "yesterday" }),
    ).rejects.toThrow(/name: must be.*; description: can't be empty; occurred_at: must be/);
  });
});

describe("recall rules", () => {
  it("R11: an unknown name is an error, listing the names", async () => {
    await save({ name: "meals" });
    await expect(recall(db, { name: "food" })).rejects.toThrow(/^name 'food' doesn't exist\. Existing names: .*meals \(log\)/);
  });

  it("R12: ids can't be combined with other filters", async () => {
    await expect(recall(db, { ids: [1], name: "meals" })).rejects.toThrow(
      "ids can't be combined with other filters (got name)",
    );
    await expect(recall(db, { ids: [1, 2, 3, 4] })).rejects.toThrow("ids: takes 1 to 3 ids");
  });

  it("R13: relevance needs a query", async () => {
    await expect(recall(db, { order_by: "relevance" })).rejects.toThrow(
      "order_by=relevance needs a query; use occurred_at or created_at",
    );
  });

  it("checks the type, the time range and the keywords", async () => {
    await expect(recall(db, { type: "health" })).rejects.toThrow("type: must be one of:");
    await expect(
      recall(db, { after: "2026-10-16T00:00:00+07:00", before: "2026-10-15T00:00:00+07:00" }),
    ).rejects.toThrow("after must be earlier than before");
    await expect(recall(db, { before: "2026-02-30T00:00:00Z" })).rejects.toThrow("before: must be a real wall-clock time");
    await expect(recall(db, { query: " - ? " })).rejects.toThrow("query needs at least one keyword");
    await expect(recall(db, { order: "newest" })).rejects.toThrow(/Unrecognized key.*order/);
  });
});

describe("recall by ids", () => {
  it("returns exactly those records with full bodies, wrong ones included", async () => {
    const name = "test";
    const long = "x".repeat(2000);
    const wrong = await save({ name, body: long });
    const fix = await save({ name, body: long, corrects: wrong.id, kind: "correction" });
    const result = await recall(db, { ids: [fix.id, wrong.id, 999_999] });
    expect(result.records.map((r) => r.id)).toEqual([wrong.id, fix.id]);
    expect(result.records[0]).toMatchObject({ corrected_by: fix.id, corrected_kind: "correction", body: long });
    expect(result.records[1]).toMatchObject({ corrects: wrong.id, kind: "correction" });
    expect(result.records[0]).not.toHaveProperty("body_truncated");
    expect(result.missing_ids).toEqual([999_999]);
  });
});

describe("recall by filters", () => {
  it("marks wrong records with their correction instead of hiding them", async () => {
    const name = "test";
    const wrong = await save({ name, body: "ibuprofen" });
    const fix = await save({ name, body: "paracetamol", corrects: wrong.id, kind: "correction" });
    const retraction = await save({ name, body: "never took it", corrects: fix.id, kind: "retraction" });
    const { records, total } = await recall(db, { name, order_by: "created_at", direction: "oldest" });
    expect(total).toBe(3);
    expect(records).toEqual([
      expect.objectContaining({ id: wrong.id, corrected_by: fix.id, corrected_kind: "correction" }),
      expect.objectContaining({ id: fix.id, corrects: wrong.id, kind: "correction", corrected_by: retraction.id }),
      expect.objectContaining({ id: retraction.id, corrects: fix.id, kind: "retraction" }),
    ]);
    expect(records[2]).not.toHaveProperty("corrected_by");
  });

  describe("current: true leaves out wrong records and retractions, so total is the count (#9)", () => {
    // Monday 12 to Sunday 18 October 2026, +07:00.
    const week = { after: "2026-10-12T00:00:00+07:00", before: "2026-10-19T00:00:00+07:00" };
    const monday = "2026-10-12T09:00:00+07:00";
    const sundayBefore = "2026-10-11T09:00:00+07:00";

    it("a dose corrected to the Sunday before drops out of the week", async () => {
      const name = "test";
      const wrong = await save({ name, occurred_at: monday });
      await save({ name, occurred_at: sundayBefore, corrects: wrong.id, kind: "correction" });
      expect((await recall(db, { name, ...week })).total).toBe(1); // without the filter, the wrong one shows
      expect(await recall(db, { name, ...week, current: true })).toEqual({ records: [], total: 0 });
    });

    it("a dose corrected into the week counts once, from the correction", async () => {
      const name = "test";
      const wrong = await save({ name, occurred_at: sundayBefore });
      const fix = await save({ name, occurred_at: monday, corrects: wrong.id, kind: "correction" });
      const { records, total } = await recall(db, { name, ...week, current: true });
      expect(total).toBe(1);
      expect(records.map((r) => r.id)).toEqual([fix.id]);
    });

    it("a corrected then retracted dose counts zero", async () => {
      const name = "test";
      const wrong = await save({ name, occurred_at: monday });
      const fix = await save({ name, occurred_at: monday, corrects: wrong.id, kind: "correction" });
      await save({ name, occurred_at: "2026-10-13T09:00:00+07:00", corrects: fix.id, kind: "retraction" });
      expect((await recall(db, { name, ...week })).total).toBe(3);
      expect((await recall(db, { name, ...week, current: true })).total).toBe(0);
    });

    it("a chain counts only its last record", async () => {
      const name = "test";
      const a = await save({ name, occurred_at: monday });
      const b = await save({ name, occurred_at: monday, corrects: a.id, kind: "correction" });
      const c = await save({ name, occurred_at: monday, corrects: b.id, kind: "correction" });
      const other = await save({ name, occurred_at: "2026-10-14T09:00:00+07:00" });
      const { records, total } = await recall(db, { name, ...week, current: true, direction: "oldest" });
      expect(total).toBe(2);
      expect(records.map((r) => r.id)).toEqual([c.id, other.id]);
    });

    it("pages through current records only, and keeps its token to itself", async () => {
      const name = "test";
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        const wrong = await save({ name, occurred_at: monday });
        ids.push((await save({ name, occurred_at: monday, corrects: wrong.id, kind: "correction" })).id);
      }
      const seen: number[] = [];
      let token: string | undefined;
      do {
        const page = await recall(db, { name, current: true, direction: "oldest", max_results: 2, page_token: token });
        expect(page.total).toBe(5);
        seen.push(...page.records.map((r) => r.id));
        token = page.next_page_token;
      } while (token);
      expect(seen).toEqual(ids);

      const first = await recall(db, { name, current: true, max_results: 2 });
      await expect(recall(db, { name, max_results: 2, page_token: first.next_page_token })).rejects.toThrow(
        "page_token belongs to a different query",
      );
    });

    it("must be true or left out, and can't go with ids", async () => {
      await expect(recall(db, { current: false })).rejects.toThrow("current: must be true, or left out");
      await expect(recall(db, { ids: [1], current: true })).rejects.toThrow(
        "ids can't be combined with other filters (got current)",
      );
    });
  });

  it("filters on when it happened: after inclusive, before exclusive, across midnight UTC", async () => {
    const name = "test";
    // 06:00 on the 16th in +07:00 is 23:00 on the 15th in UTC.
    const morning = await save({ name, occurred_at: "2026-10-16T06:00:00+07:00" });
    const midnight = await save({ name, occurred_at: "2026-10-16T00:00:00+07:00" });
    const nextDay = await save({ name, occurred_at: "2026-10-15T17:00:00Z" }); // = 00:00 on the 16th +07:00
    await save({ name, occurred_at: "2026-10-15T23:59:59+07:00" });
    const { records } = await recall(db, {
      name,
      after: "2026-10-16T00:00:00+07:00",
      before: "2026-10-17T00:00:00+07:00",
      direction: "oldest",
    });
    expect(records.map((r) => r.id)).toEqual([midnight.id, nextDay.id, morning.id]);
    expect(records[2]!.occurred_at).toBe("2026-10-16T06:00:00+07:00");
  });

  it("orders by occurred_at with ties broken by id in the same direction", async () => {
    const name = "test";
    const a = await save({ name, occurred_at: "2026-10-15T08:00:00+07:00" });
    const b = await save({ name, occurred_at: "2026-10-15T08:00:00+07:00" });
    const c = await save({ name, occurred_at: "2026-10-15T07:00:00+07:00" });
    const newest = await recall(db, { name });
    expect(newest.records.map((r) => r.id)).toEqual([b.id, a.id, c.id]);
    const oldest = await recall(db, { name, direction: "oldest" });
    expect(oldest.records.map((r) => r.id)).toEqual([c.id, a.id, b.id]);
  });

  it("created_at with max_results 1 is the head, even when it happened earlier", async () => {
    const name = "project";
    await save({ name, occurred_at: "2026-10-15T09:00:00+07:00", body: "status on the 15th" });
    const head = await save({ name, occurred_at: "2026-10-03T09:00:00+07:00", body: "back on the 3rd we decided X" });
    const byCreated = await recall(db, { name, order_by: "created_at", max_results: 1 });
    expect(byCreated.records.map((r) => r.id)).toEqual([head.id]);
    const byOccurred = await recall(db, { name, max_results: 1 });
    expect(byOccurred.records[0]!.id).not.toBe(head.id);
  });

  it("filters by type", async () => {
    const recipe = "recipe";
    await save({ name: recipe, type: "reference", body: "flour and sugar" });
    const { records } = await recall(db, { type: "reference", query: "flour" });
    expect(records.map((r) => r.name)).toContain(recipe);
    expect(records.every((r) => r.type === "reference")).toBe(true);
  });

  it("cuts bodies short when a page has more than 3 records, and only then", async () => {
    const name = "test";
    const long = "y".repeat(800);
    for (let i = 0; i < 4; i++) await save({ name, body: long });
    const four = await recall(db, { name });
    expect(four.records.every((r) => r.body.length === 500 && r.body_truncated)).toBe(true);
    const three = await recall(db, { name, max_results: 3 });
    expect(three.records.every((r) => r.body.length === 800 && !("body_truncated" in r))).toBe(true);
  });

  it("cuts at a whole character, never through an emoji", async () => {
    const name = "test";
    const body = `${"a".repeat(499)}🍜${"b".repeat(100)}`; // the 500th character is the emoji
    for (let i = 0; i < 4; i++) await save({ name, body });
    const { records } = await recall(db, { name });
    expect(records.every((r) => r.body === `${"a".repeat(499)}🍜` && r.body_truncated)).toBe(true);
  });
});

describe("paging", () => {
  it.each(["newest", "oldest"] as const)(
    "walks %s through tied times with nothing skipped or repeated",
    async (direction) => {
      const name = "test";
      const ids: number[] = [];
      for (let i = 0; i < 25; i++) {
        // Five records per moment, so every page boundary falls inside a tie.
        const hour = String(8 + Math.floor(i / 5)).padStart(2, "0");
        ids.push((await save({ name, occurred_at: `2026-10-15T${hour}:00:00+07:00` })).id);
      }
      const seen: number[] = [];
      let token: string | undefined;
      let pages = 0;
      do {
        const page = await recall(db, { name, direction, page_token: token });
        expect(page.total).toBe(25);
        seen.push(...page.records.map((r) => r.id));
        token = page.next_page_token;
        pages += 1;
      } while (token);
      expect(pages).toBe(3);
      expect(seen).toEqual(direction === "oldest" ? ids : [...ids].reverse());
    },
  );

  it("pages by save order and by relevance too", async () => {
    const name = "test";
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push((await save({ name, body: `pancake breakfast ${i}` })).id);

    const first = await recall(db, { name, order_by: "created_at", max_results: 5 });
    const second = await recall(db, { name, order_by: "created_at", max_results: 5, page_token: first.next_page_token });
    expect([...first.records, ...second.records].map((r) => r.id)).toEqual([...ids].reverse().slice(0, 10));

    const all: number[] = [];
    let token: string | undefined;
    do {
      const page = await recall(db, { name, query: "pancake", max_results: 5, page_token: token });
      all.push(...page.records.map((r) => r.id));
      token = page.next_page_token;
    } while (token);
    expect(all.sort((x, y) => x - y)).toEqual(ids);
  });

  it("refuses a token from a different query, or a broken one", async () => {
    const name = "test";
    for (let i = 0; i < 3; i++) await save({ name });
    const page = await recall(db, { name, max_results: 1 });
    await expect(recall(db, { name, direction: "oldest", page_token: page.next_page_token })).rejects.toThrow(
      "page_token belongs to a different query",
    );
    await expect(recall(db, { name, page_token: "not-a-token" })).rejects.toThrow("page_token isn't valid");
  });

  it("pages through a query in any script, with short tokens (#1)", async () => {
    const name = "test";
    const ids: number[] = [];
    for (const extra of ["日本", "🍜", "—"]) ids.push((await save({ name, body: `ラーメン ${extra}` })).id);
    const seen: number[] = [];
    let token: string | undefined;
    do {
      const page = await recall(db, { name, query: "ラーメン 🍜 —", max_results: 1, page_token: token });
      seen.push(...page.records.map((r) => r.id));
      token = page.next_page_token;
      if (token) expect(token).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    } while (token);
    expect(seen.sort((x, y) => x - y)).toEqual(ids);
  });

  it("refuses a token whose position was garbled (#2)", async () => {
    const name = "test";
    for (let i = 0; i < 3; i++) await save({ name, body: `pancake ${i}` });
    const byTime = (await recall(db, { name, max_results: 1 })).next_page_token!;
    const bySave = (await recall(db, { name, order_by: "created_at", max_results: 1 })).next_page_token!;
    const byRelevance = (await recall(db, { name, query: "pancake", max_results: 1 })).next_page_token!;
    const garbled: [Record<string, unknown>, string][] = [
      [{}, tamperToken(byTime, (s) => (s.cursor = "x"))],
      [{}, tamperToken(byTime, (s) => (s.cursor = [42, 1]))],
      [{}, tamperToken(byTime, (s) => (s.extra = 1))],
      [{ order_by: "created_at" }, tamperToken(bySave, (s) => (s.cursor = ["x", 1]))],
      [{ query: "pancake" }, tamperToken(byRelevance, (s) => (s.offset = -1))],
      [{ query: "pancake" }, tamperToken(byRelevance, (s) => (s.offset = "5"))],
    ];
    for (const [filters, page_token] of garbled) {
      await expect(recall(db, { name, max_results: 1, ...filters, page_token })).rejects.toThrow(
        "page_token isn't valid; repeat the call without it",
      );
    }
  });
});

describe("search", () => {
  it("handles punctuation, plurals and filler words", async () => {
    const name = "recipe";
    const saved = await save({
      name,
      type: "reference",
      description: "Vanilla cupcakes from the co-op",
      body: "Don't overmix. Makes 12 cupcakes.",
    });
    for (const query of ["cupcake", "co-op", "don't", "what cupcakes did I save", `"vanilla"`, name]) {
      const { records } = await recall(db, { query });
      expect(records.map((r) => r.id), query).toContain(saved.id);
    }
  });

  it("ranks the better match first", async () => {
    const name = "test";
    const weak = await save({ name, description: "Dinner", body: "rice and a little garlic" });
    const strong = await save({ name, description: "Garlic bread", body: "garlic, garlic butter and more garlic" });
    const { records } = await recall(db, { name, query: "garlic" });
    expect(records.map((r) => r.id)).toEqual([strong.id, weak.id]);
  });

  describe("the topic name finds records but doesn't rank them (#11)", () => {
    const foods = ["Oatmeal", "Fried rice", "Noodle soup", "Chicken salad", "Pasta", "Toast", "Curry", "Sushi", "Pho", "Steak", "Tacos", "Ramen"];
    const meals = async () => {
      for (const food of foods) await save({ name: "meals", description: food, body: `Ate ${food.toLowerCase()}.` });
    };

    it("ranks a record whose text matches above a big topic named after the word", async () => {
      await meals();
      const plan = await save({ name: "diet-plan", type: "reference", body: "Prep three meals on Sunday and freeze them." });
      const { records, total } = await recall(db, { query: "meals" });
      expect(total).toBe(13);
      expect(records[0]!.id).toBe(plan.id);
    });

    it("does so however long the matching text is", async () => {
      await meals();
      const plan = await save({
        name: "diet-plan",
        type: "reference",
        body: `Prep three meals on Sunday. ${"Then shop, chop and freeze the rest. ".repeat(60)}`,
      });
      const mention = await save({ name: "meals", description: "Lunch with Sam", body: "Sam says these meals are his favourite." });
      const { records } = await recall(db, { query: "meals" });
      expect(records.slice(0, 2).map((r) => r.id).sort()).toEqual([plan.id, mention.id].sort());
    });

    it("still finds a topic's records by a word only its name has, newest first", async () => {
      await meals();
      const { records, total } = await recall(db, { query: "meals" });
      expect(total).toBe(12);
      expect(records.map((r) => r.description)).toEqual([...foods].reverse().slice(0, 10));
    });
  });
});
