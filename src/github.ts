// The GitHub side of the login: "who is this?" (spec §11). Our Worker is the
// client here and GitHub the issuer, with PKCE on this leg too. We only need
// the numeric user id, so no scopes are requested and GitHub's token is used
// once and never stored.

import type { Config } from "./config";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

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
 * logged). The caller decides what that means for the login.
 */
export async function githubUser(config: Config, code: string, verifier: string): Promise<{ id: number; login: string } | null> {
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

    const userResponse = await fetch(USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.access_token}`,
        "user-agent": "memory-bank",
        "x-github-api-version": "2022-11-28",
      },
    });
    const user = (await userResponse.json().catch(() => ({}))) as { id?: unknown; login?: unknown };
    if (!userResponse.ok || typeof user.id !== "number" || typeof user.login !== "string") {
      console.error(`GitHub user lookup failed: ${userResponse.status}`);
      return null;
    }
    return { id: user.id, login: user.login };
  } catch (error) {
    // fetch itself throws when GitHub can't be reached at all.
    console.error(`GitHub unreachable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
