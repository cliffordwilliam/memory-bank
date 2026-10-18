// Page tokens (spec §7.2). A token is opaque to Claude: base64url JSON holding
// where the previous page ended plus a fingerprint of the filters, so a token
// can't be reused with different filters by mistake.
//
// Everything in a token is ASCII (a hex hash, slugs, UTC times, numbers),
// which btoa needs. The filters themselves never go in: a query can be in any
// script (#1), so the fingerprint is a hash of them.

import { z } from "zod";
import { BankError } from "../errors";

export interface PageState {
  /** Fingerprint of the filters that produced the page. */
  f: string;
  /** Where to continue: the last row's sort key and id, or an offset. */
  cursor?: [string | number, number];
  offset?: number;
}

/** A short hash of the filters that produced a page. */
export async function fingerprintOf(filters: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(filters)));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A token continuing after the last row's sort key and id. */
export const cursorState = <K extends z.ZodType>(key: K) =>
  z.strictObject({ f: z.string(), cursor: z.tuple([key, z.int()]) });

/** A token continuing at an offset (relevance order). */
export const offsetState = z.strictObject({ f: z.string(), offset: z.int().nonnegative() });

export function encodePageToken(state: PageState): string {
  return btoa(JSON.stringify(state)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Decodes a token made with this fingerprint and checks it has the shape the
 * caller expects, so a garbled position can't reach the database (#2).
 */
export function decodePageToken<T>(token: string, fingerprint: string, shape: z.ZodType<T>): T {
  const invalid = new BankError("page_token isn't valid; repeat the call without it");
  let state: unknown;
  try {
    state = JSON.parse(atob(token.replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    throw invalid;
  }
  if (typeof state !== "object" || state === null || (state as { f?: unknown }).f !== fingerprint) {
    throw new BankError(
      "page_token belongs to a different query; repeat the same filters, or start again without page_token",
    );
  }
  const parsed = shape.safeParse(state);
  if (!parsed.success) throw invalid;
  return parsed.data;
}
