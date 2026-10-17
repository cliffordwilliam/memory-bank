// Phase 3: the bank's operations and every rule R1–R13 (spec §6, §7).
import { describe, expect, it } from "vitest";
import { recall, remember } from "../src/bank";
import { clock, db, NOW, save, uniqueName } from "./helpers";

const rememberRaw = (input: unknown) => remember(db, input, clock);

describe("remember", () => {
  it("creates a name with its first record, then adds on top of it", async () => {
    const name = uniqueName();
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
      const saved = await save({ name: uniqueName(), occurred_at });
      expect(saved.occurred_at).toBe(occurred_at);
    }
  });

  it("R1: a new name needs a known type", async () => {
    const base = { name: uniqueName(), new_name: true, description: "d", body: "b", occurred_at: "2026-10-15T21:00:00+07:00" };
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
    const name = uniqueName();
    const saved = await save({ name });
    await expect(save({ name, new_name: true, type: "log" })).rejects.toThrow(
      `'${name}' already exists (log, head #${saved.id}). Omit new_name to add a new version, or choose a different name.`,
    );
  });

  it("R4: type is only for new names", async () => {
    const name = uniqueName();
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
  ])("R5: refuses occurred_at with %s", async (_, occurred_at) => {
    await expect(save({ name: uniqueName(), occurred_at })).rejects.toThrow(
      "occurred_at: must be a real wall-clock time with offset, e.g. 2026-10-12T21:00:00+07:00",
    );
  });

  it("R5: accepts February 29 in a leap year", async () => {
    await expect(save({ name: uniqueName(), occurred_at: "2028-02-29T12:00:00Z" })).rejects.toThrow(/future/);
    await expect(save({ name: uniqueName(), occurred_at: "2024-02-29T12:00:00Z" })).resolves.toBeDefined();
  });

  it("R6: refuses a future time, with 5 minutes of slack", async () => {
    const inFourMinutes = new Date(NOW + 4 * 60_000).toISOString();
    const inSixMinutes = new Date(NOW + 6 * 60_000).toISOString();
    await expect(save({ name: uniqueName(), occurred_at: inFourMinutes })).resolves.toBeDefined();
    await expect(save({ name: uniqueName(), occurred_at: inSixMinutes })).rejects.toThrow(
      "occurred_at is in the future; check the date and offset",
    );
  });

  it("R7: checks the name, description and body", async () => {
    await expect(save({ name: "My Meds" })).rejects.toThrow(
      "name: must be lowercase letters, digits and hyphens (1–64 characters), e.g. vanilla-cupcakes",
    );
    await expect(save({ name: uniqueName(), description: "two\nlines" })).rejects.toThrow(
      "description: must be one line of at most 200 characters",
    );
    await expect(save({ name: uniqueName(), description: "x".repeat(201) })).rejects.toThrow(
      "description: must be one line of at most 200 characters",
    );
    await expect(save({ name: uniqueName(), body: "x".repeat(17_240) })).rejects.toThrow(
      "body: is 17240 characters; the limit is 16000",
    );
    await expect(save({ name: uniqueName(), body: "x".repeat(16_000) })).resolves.toBeDefined();
  });

  it("R8: corrects and kind go together", async () => {
    const name = uniqueName();
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
    const meals = uniqueName("meals");
    const meds = uniqueName("meds");
    const meal = await save({ name: meals });
    await save({ name: meds });
    await expect(save({ name: meds, corrects: meal.id, kind: "correction" })).rejects.toThrow(
      `#${meal.id} is in '${meals}', not '${meds}'`,
    );
    await expect(save({ name: meds, corrects: 999_999, kind: "correction" })).rejects.toThrow("#999999 doesn't exist");
  });

  it("R10: a record is corrected once; a correction is corrected in turn", async () => {
    const name = uniqueName();
    const wrong = await save({ name, body: "ibuprofen" });
    const fix = await save({ name, body: "paracetamol", corrects: wrong.id, kind: "correction" });
    expect(fix).toMatchObject({ corrects: wrong.id, kind: "correction", previous_id: wrong.id });
    await expect(save({ name, corrects: wrong.id, kind: "retraction" })).rejects.toThrow(
      `#${wrong.id} is already corrected by #${fix.id}. To fix the correction, pass corrects=${fix.id}.`,
    );
    await expect(save({ name, corrects: fix.id, kind: "retraction" })).resolves.toMatchObject({ corrects: fix.id });
  });

  it("refuses unknown parameters instead of ignoring them", async () => {
    await expect(save({ name: uniqueName(), source: "web" })).rejects.toThrow(/Unrecognized key.*source/);
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
    const name = uniqueName();
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
    const name = uniqueName();
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

  it("filters on when it happened: after inclusive, before exclusive, across midnight UTC", async () => {
    const name = uniqueName();
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
    const name = uniqueName();
    const a = await save({ name, occurred_at: "2026-10-15T08:00:00+07:00" });
    const b = await save({ name, occurred_at: "2026-10-15T08:00:00+07:00" });
    const c = await save({ name, occurred_at: "2026-10-15T07:00:00+07:00" });
    const newest = await recall(db, { name });
    expect(newest.records.map((r) => r.id)).toEqual([b.id, a.id, c.id]);
    const oldest = await recall(db, { name, direction: "oldest" });
    expect(oldest.records.map((r) => r.id)).toEqual([c.id, a.id, b.id]);
  });

  it("created_at with max_results 1 is the head, even when it happened earlier", async () => {
    const name = uniqueName("project");
    await save({ name, occurred_at: "2026-10-15T09:00:00+07:00", body: "status on the 15th" });
    const head = await save({ name, occurred_at: "2026-10-03T09:00:00+07:00", body: "back on the 3rd we decided X" });
    const byCreated = await recall(db, { name, order_by: "created_at", max_results: 1 });
    expect(byCreated.records.map((r) => r.id)).toEqual([head.id]);
    const byOccurred = await recall(db, { name, max_results: 1 });
    expect(byOccurred.records[0]!.id).not.toBe(head.id);
  });

  it("filters by type", async () => {
    const recipe = uniqueName("recipe");
    await save({ name: recipe, type: "reference", body: "flour and sugar" });
    const { records } = await recall(db, { type: "reference", query: "flour" });
    expect(records.map((r) => r.name)).toContain(recipe);
    expect(records.every((r) => r.type === "reference")).toBe(true);
  });

  it("cuts bodies short when a page has more than 3 records, and only then", async () => {
    const name = uniqueName();
    const long = "y".repeat(800);
    for (let i = 0; i < 4; i++) await save({ name, body: long });
    const four = await recall(db, { name });
    expect(four.records.every((r) => r.body.length === 500 && r.body_truncated)).toBe(true);
    const three = await recall(db, { name, max_results: 3 });
    expect(three.records.every((r) => r.body.length === 800 && !("body_truncated" in r))).toBe(true);
  });
});

describe("paging", () => {
  it.each(["newest", "oldest"] as const)(
    "walks %s through tied times with nothing skipped or repeated",
    async (direction) => {
      const name = uniqueName();
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
    const name = uniqueName();
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
    const name = uniqueName();
    for (let i = 0; i < 3; i++) await save({ name });
    const page = await recall(db, { name, max_results: 1 });
    await expect(recall(db, { name, direction: "oldest", page_token: page.next_page_token })).rejects.toThrow(
      "page_token belongs to a different query",
    );
    await expect(recall(db, { name, page_token: "not-a-token" })).rejects.toThrow("page_token isn't valid");
  });
});

describe("search", () => {
  it("handles punctuation, plurals and filler words", async () => {
    const name = uniqueName("recipe");
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
    const name = uniqueName();
    const weak = await save({ name, description: "Dinner", body: "rice and a little garlic" });
    const strong = await save({ name, description: "Garlic bread", body: "garlic, garlic butter and more garlic" });
    const { records } = await recall(db, { name, query: "garlic" });
    expect(records.map((r) => r.id)).toEqual([strong.id, weak.id]);
  });
});
