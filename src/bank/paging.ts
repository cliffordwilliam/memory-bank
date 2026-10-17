// Page tokens (spec §7.2). A token is opaque to Claude: base64url JSON holding
// where the previous page ended plus a fingerprint of the filters, so a token
// can't be reused with different filters by mistake.

import { BankError } from "../errors";

export interface PageState {
  /** Fingerprint of the filters that produced the page. */
  f: string;
  /** Where to continue: the last row's sort key and id, or an offset. */
  after?: [string | number, number];
  offset?: number;
}

export function encodePageToken(state: PageState): string {
  return btoa(JSON.stringify(state)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodePageToken(token: string, fingerprint: string): PageState {
  let state: PageState;
  try {
    const b64 = token.replaceAll("-", "+").replaceAll("_", "/");
    state = JSON.parse(atob(b64)) as PageState;
  } catch {
    throw new BankError("page_token isn't valid; repeat the call without it");
  }
  if (typeof state !== "object" || state === null || state.f !== fingerprint) {
    throw new BankError(
      "page_token belongs to a different query; repeat the same filters, or start again without page_token",
    );
  }
  return state;
}
