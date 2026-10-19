import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

// Every test starts from the same state: a freshly migrated, empty D1 and an
// empty KV, like a transaction rolled back after each test. D1 refuses BEGIN
// and SAVEPOINT, and the plugin isolates storage per test file only, so
// instead each test drops every table, reruns the migrations and clears KV
// (about 5 ms). test/isolation.test.ts proves it.
beforeEach(async () => {
  await resetD1();
  await clearKv();
});

async function resetD1(): Promise<void> {
  // The FTS index's shadow tables go with it; sqlite_ and _cf_ tables are internal.
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'records\\_fts\\_%' ESCAPE '\\'`,
  ).all<{ name: string }>();
  if (results.length > 0) {
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = on"),
      ...results.map(({ name }) => env.DB.prepare(`DROP TABLE "${name}"`)),
    ]);
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

async function clearKv(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list({ cursor });
    await Promise.all(page.keys.map(({ name }) => env.OAUTH_KV.delete(name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
