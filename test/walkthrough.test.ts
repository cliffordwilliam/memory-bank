// The spec §14 walkthrough, call by call (UTC+7, Friday 2026-10-16, 10:00).
// Its own file, so the bank starts empty and ids are predictable.
import { describe, expect, it } from "vitest";
import { listTopics, recall, remember } from "../src/bank";
import { clock, db } from "./helpers";

const call = (input: unknown) => remember(db, input, clock);

describe("spec §14 walkthrough", () => {
  it("runs end to end", async () => {
    // "Save this vanilla cupcake recipe to the bank: …"
    expect((await listTopics(db, { type: "reference" })).topics).toEqual([]);
    const recipe = await call({
      name: "vanilla-cupcakes",
      new_name: true,
      type: "reference",
      description: "Vanilla cupcakes, makes 12",
      body: "Cream 115 g butter with 150 g sugar…",
      occurred_at: "2026-10-16T10:00:00+07:00",
    });
    // Saving it as new again is refused, so Claude asks: new version or different recipe?
    await expect(call({ ...recipeInput(), new_name: true, type: "reference" })).rejects.toThrow(
      `'vanilla-cupcakes' already exists (reference, head #${recipe.id})`,
    );

    // "I took 400 mg ibuprofen last night around 9, log it in the bank."
    await call({
      name: "medication",
      new_name: true,
      type: "log",
      description: "First dose",
      body: "Took a vitamin in the morning.",
      occurred_at: "2026-10-15T08:00:00+07:00",
    });
    const dose = await call({
      name: "medication",
      description: "400 mg ibuprofen, around 21:00",
      body: "I took 400 mg ibuprofen last night around 9.",
      occurred_at: "2026-10-15T21:00:00+07:00",
    });

    // "Correction for the bank: it was paracetamol, not ibuprofen."
    const found = await recall(db, {
      name: "medication",
      query: "ibuprofen",
      after: "2026-10-15T00:00:00+07:00",
      before: "2026-10-16T10:00:00+07:00",
    });
    expect(found.records.map((r) => r.id)).toEqual([dose.id]);
    const fix = await call({
      name: "medication",
      corrects: dose.id,
      kind: "correction",
      description: "Paracetamol, not ibuprofen, around 21:00",
      body: "Correction for the bank: it was paracetamol, not ibuprofen.",
      occurred_at: "2026-10-15T21:00:00+07:00",
    });
    expect(fix.previous_id).toBe(dose.id);

    // "Check the bank: what did I take on the 15th?" (before the retraction)
    const the15th = { name: "medication", after: "2026-10-15T00:00:00+07:00", before: "2026-10-16T00:00:00+07:00", direction: "oldest" };
    const beforeRetraction = await recall(db, the15th);
    expect(beforeRetraction.records.map((r) => [r.description, r.corrected_kind ?? null])).toEqual([
      ["First dose", null],
      ["400 mg ibuprofen, around 21:00", "correction"],
      ["Paracetamol, not ibuprofen, around 21:00", null],
    ]);

    // "Actually I never took it, remove that from the bank."
    const retraction = await call({
      name: "medication",
      corrects: fix.id,
      kind: "retraction",
      description: "Never took the dose logged around 21:00 on the 15th",
      body: "Actually I never took it, remove that from the bank.",
      occurred_at: "2026-10-16T10:00:00+07:00",
    });

    // The same question after it: #57 corrected, #58 retracted; the retraction
    // itself is saved with today's time, so it's outside this range.
    const afterRetraction = await recall(db, the15th);
    expect(afterRetraction.records.map((r) => [r.id, r.corrected_by ?? null, r.corrected_kind ?? null])).toEqual([
      [dose.id - 1, null, null],
      [dose.id, fix.id, "correction"],
      [fix.id, retraction.id, "retraction"],
    ]);

    // "Check the bank: what did I eat last week?"
    await call({
      name: "meals",
      new_name: true,
      type: "log",
      description: "Oatmeal",
      body: "Oatmeal for breakfast.",
      occurred_at: "2026-10-06T07:30:00+07:00",
    });
    await call({
      name: "meals",
      description: "Fried rice",
      body: "Fried rice for dinner.",
      occurred_at: "2026-10-11T19:00:00+07:00",
    });
    await call({
      name: "meals",
      description: "Noodles (this week)",
      body: "Noodles.",
      occurred_at: "2026-10-13T12:00:00+07:00",
    });
    const lastWeek = await recall(db, {
      name: "meals",
      after: "2026-10-05T00:00:00+07:00",
      before: "2026-10-12T00:00:00+07:00",
      direction: "oldest",
      max_results: 20,
    });
    expect(lastWeek.records.map((r) => r.description)).toEqual(["Oatmeal", "Fried rice"]);

    // "Check the bank: when was my last dose?"
    const lastDose = await recall(db, { name: "medication", order_by: "occurred_at", max_results: 1 });
    expect(lastDose.records[0]).toMatchObject({ id: retraction.id, kind: "retraction" });

    // "Check the bank: where's my bank project at?"
    await call({
      name: "memory-bank",
      new_name: true,
      type: "project",
      description: "Phase 2 done",
      body: "Schema and triggers committed.",
      occurred_at: "2026-10-16T09:00:00+07:00",
    });
    const status = await call({
      name: "memory-bank",
      description: "Phase 3 in progress",
      body: "Bank logic being written; walkthrough test passing.",
      occurred_at: "2026-10-16T10:00:00+07:00",
    });
    const projects = await listTopics(db, { type: "project" });
    expect(projects.topics.map((t) => t.name)).toEqual(["memory-bank"]);
    const current = await recall(db, { name: "memory-bank", order_by: "created_at", max_results: 1 });
    expect(current.records.map((r) => r.id)).toEqual([status.id]);
    expect(current.records[0]!.body).toBe("Bank logic being written; walkthrough test passing.");

    // "Check the bank: what's my current cupcake recipe?"
    const references = await listTopics(db, { type: "reference" });
    expect(references.topics[0]).toMatchObject({ name: "vanilla-cupcakes", latest_id: recipe.id });
    const recipeNow = await recall(db, { ids: [references.topics[0]!.latest_id!] });
    expect(recipeNow.records[0]!.body).toBe("Cream 115 g butter with 150 g sugar…");

    // "What's in my bank?"
    const everything = await listTopics(db, {});
    expect(everything.topics.map((t) => [t.name, t.type, t.record_count])).toEqual([
      ["memory-bank", "project", 2],
      ["meals", "log", 3],
      ["medication", "log", 4],
      ["vanilla-cupcakes", "reference", 1],
    ]);
  });
});

function recipeInput() {
  return {
    name: "vanilla-cupcakes",
    description: "Vanilla cupcakes, makes 12",
    body: "Cream 115 g butter with 150 g sugar…",
    occurred_at: "2026-10-16T10:00:00+07:00",
  };
}
