// The GitHub side of the login: "who is this?" (spec §11). Our Worker is the
// client here and GitHub the issuer, with PKCE on this leg too. We only need
// the numeric user id, so no scopes are requested and GitHub's token is used
// once, never stored, and revoked.

import type { Config } from "./config";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const API_HEADERS = { accept: "application/vnd.github+json", "user-agent": "memory-bank", "x-github-api-version": "2022-11-28" };

export function callbackUrl(config: Config): string {
  return `${config.publicUrl}/callback`;
}

/** A fresh PKCE verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function githubAuthorizeUrl(config: Config, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.githubClientId);
  url.searchParams.set("redirect_uri", callbackUrl(config));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  return url.href;
}

/**
 * Trades GitHub's one-time code for the account's numeric id and login, or
 * null when GitHub refused, failed or couldn't be reached (the reason is
 * logged). The caller decides what that means for the login. GitHub's token
 * is revoked once the lookup is done, in the background via `ctx`.
 */
export async function githubUser(
  config: Config,
  ctx: ExecutionContext,
  code: string,
  verifier: string,
): Promise<{ id: number; login: string } | null> {
  try {
    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
        redirect_uri: callbackUrl(config),
        code_verifier: verifier,
      }),
    });
    const token = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!tokenResponse.ok || !token.access_token) {
      console.error(`GitHub token exchange failed: ${token.error ?? tokenResponse.status}`);
      return null;
    }

    const accessToken = token.access_token;
    try {
      const userResponse = await fetch(USER_URL, { headers: { ...API_HEADERS, authorization: `Bearer ${accessToken}` } });
      const user = (await userResponse.json().catch(() => ({}))) as { id?: unknown; login?: unknown };
      if (!userResponse.ok || typeof user.id !== "number" || typeof user.login !== "string") {
        console.error(`GitHub user lookup failed: ${userResponse.status}`);
        return null;
      }
      return { id: user.id, login: user.login };
    } finally {
      // Only after the lookup, so the two can't race.
      ctx.waitUntil(revokeToken(config, accessToken));
    }
  } catch (error) {
    // fetch itself throws when GitHub can't be reached at all.
    console.error(`GitHub unreachable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Asks GitHub to revoke a token we're done with, so logins don't leave live
 * tokens behind. Best effort: a failure is logged and the login goes on.
 */
async function revokeToken(config: Config, accessToken: string): Promise<void> {
  try {
    // GitHub's docs don't say how this endpoint authenticates; Basic with the
    // app's id and secret was checked on a real login (204, then /user 401).
    const response = await fetch(`https://api.github.com/applications/${config.githubClientId}/token`, {
      method: "DELETE",
      headers: {
        ...API_HEADERS,
        authorization: `Basic ${btoa(`${config.githubClientId}:${config.githubClientSecret}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (response.status !== 204) console.error(`GitHub token revoke failed: ${response.status}`);
  } catch (error) {
    console.error(`GitHub token revoke failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
