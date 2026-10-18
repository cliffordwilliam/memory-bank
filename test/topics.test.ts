// Phase 3: list_topics (spec §7.3). Its own file, so it starts with an empty bank.
import { describe, expect, it } from "vitest";
import { listTopics } from "../src/bank";
import { db, save, tamperToken } from "./helpers";

describe("list_topics", () => {
  it("is empty on an empty bank", async () => {
    expect(await listTopics(db, {})).toEqual({ topics: [], total: 0 });
  });

  it("lists names by latest activity, with counts and the latest record", async () => {
    await save({ name: "meals", description: "Oatmeal", occurred_at: "2026-10-15T07:00:00+07:00" });
    await save({ name: "vanilla-cupcakes", type: "reference", description: "Vanilla cupcakes, makes 12" });
    await save({ name: "meals", description: "Fried rice", occurred_at: "2026-10-15T19:00:00+07:00" });
    const head = await save({ name: "memory-bank", type: "project", description: "Phase 3 in progress" });

    const { topics, total } = await listTopics(db, {});
    expect(total).toBe(3);
    expect(topics.map((t) => t.name)).toEqual(["memory-bank", "meals", "vanilla-cupcakes"]);
    expect(topics[0]).toEqual({
      name: "memory-bank",
      type: "project",
      record_count: 1,
      latest_id: head.id,
      latest_occurred_at: "2026-10-15T21:00:00+07:00",
      latest_description: "Phase 3 in progress",
    });
    expect(topics[1]).toMatchObject({ record_count: 2, latest_description: "Fried rice" });
  });

  it("filters by type and checks the type", async () => {
    const { topics } = await listTopics(db, { type: "log" });
    expect(topics.map((t) => t.name)).toEqual(["meals"]);
    await expect(listTopics(db, { type: "health" })).rejects.toThrow("type: must be one of:");
  });

  it("pages with nothing skipped or repeated", async () => {
    const all = (await listTopics(db, {})).topics.map((t) => t.name);
    const first = await listTopics(db, { max_results: 2 });
    const second = await listTopics(db, { max_results: 2, page_token: first.next_page_token });
    expect([...first.topics, ...second.topics].map((t) => t.name)).toEqual(all);
    expect(second.next_page_token).toBeUndefined();
    await expect(listTopics(db, { type: "log", page_token: first.next_page_token })).rejects.toThrow(
      "page_token belongs to a different query",
    );
  });

  it("refuses a token whose position was garbled (#2)", async () => {
    const first = await listTopics(db, { max_results: 1 });
    for (const cursor of ["x", [1, 2], ["meals", "x"]]) {
      const page_token = tamperToken(first.next_page_token!, (s) => (s.cursor = cursor));
      await expect(listTopics(db, { max_results: 1, page_token })).rejects.toThrow(
        "page_token isn't valid; repeat the call without it",
      );
    }
  });
});
