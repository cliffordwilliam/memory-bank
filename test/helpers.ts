import { env } from "cloudflare:workers";
import { remember } from "../src/bank";

export const db = env.DB;

/** Friday 2026-10-16, 10:00 in UTC+7 (the spec's walkthrough moment). */
export const NOW = Date.parse("2026-10-16T03:00:00Z");
export const clock = { now: NOW };

let counter = 0;
/** A fresh name per test, so tests in one file don't share chains. */
export function uniqueName(prefix = "t"): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Saves a record with sensible defaults; creates the name on first use. */
export async function save(fields: Record<string, unknown> & { name: string }) {
  const created = await db.prepare("SELECT 1 FROM names WHERE name = ?").bind(fields.name).first();
  return remember(
    db,
    {
      description: "A description",
      body: "A body",
      occurred_at: "2026-10-15T21:00:00+07:00",
      ...(created ? {} : { new_name: true, type: "log" }),
      ...fields,
    },
    clock,
  );
}

/**
 * A page token with its decoded state changed, the way a client garbling a
 * long opaque string might. Tokens are base64url JSON (src/bank/paging.ts).
 */
export function tamperToken(token: string, change: (state: Record<string, unknown>) => void): string {
  const state = JSON.parse(atob(token.replaceAll("-", "+").replaceAll("_", "/")));
  change(state);
  return btoa(JSON.stringify(state)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
