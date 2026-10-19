// Proves the per-test reset in test/apply-migrations.ts: whatever one test
// writes is gone in the next, and each starts freshly migrated. Vitest runs a
// file's tests in order, so the second test always runs after the first.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("each test starts from the same state", () => {
  it("writes to every kind of storage", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO names (name, type) VALUES ('leftover', 'log')"),
      env.DB.prepare(
        "INSERT INTO records (name, occurred_at, description, body) VALUES ('leftover', '2026-10-19T12:00:00+07:00', 'leftover', 'leftover')",
      ),
      env.DB.prepare("INSERT INTO types (name, description) VALUES ('leftover', 'Left over.')"),
      env.DB.prepare("INSERT INTO login_budget (day) VALUES (date('now'))"),
    ]);
    await env.OAUTH_KV.put("leftover", "1");
    expect(await count("records")).toBe(1);
  });

  it("sees none of it in the next test, with the migrations' seed back in place", async () => {
    expect(await count("names")).toBe(0);
    expect(await count("records")).toBe(0);
    expect(await count("login_budget")).toBe(0);
    expect(await env.DB.prepare("SELECT name FROM types ORDER BY name").all()).toMatchObject({
      results: ["feedback", "log", "project", "reference", "user"].map((name) => ({ name })),
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM records_fts WHERE records_fts MATCH 'leftover'").first()).toEqual({ n: 0 });
    expect((await env.OAUTH_KV.list()).keys).toEqual([]);
  });

  it("starts ids from 1 again, so no test depends on how many ran before it", async () => {
    await env.DB.prepare("INSERT INTO names (name, type) VALUES ('first', 'log')").run();
    const { id } = (await env.DB.prepare(
      "INSERT INTO records (name, occurred_at, description, body) VALUES ('first', '2026-10-19T12:00:00+07:00', 'd', 'b') RETURNING id",
    ).first<{ id: number }>())!;
    expect(id).toBe(1);
  });
});
