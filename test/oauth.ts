// Test helpers for the login: a stand-in GitHub, a tiny cookie jar, and the
// whole OAuth flow the way Claude and a browser walk it (see the step list
// in src/auth.ts). Requests go through the Worker's real fetch handler.
import { exports } from "cloudflare:workers";
import { vi } from "vitest";

export const ORIGIN = "http://localhost:8787";
export const OWNER = { id: 1001, login: "owner" };
export const STRANGER = { id: 2002, login: "stranger" };
const CLIENT_REDIRECT = "http://localhost:3000/callback";

/** Sends a request into the Worker, with the Host header every real request has. */
export function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", "localhost:8787");
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }));
}

/** Collects Set-Cookie values and replays them, like a browser. */
export class CookieJar {
  private cookies = new Map<string, string>();
  take(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Replaces GitHub: the token endpoint checks the client credentials, the code
 * and the PKCE verifier against the challenge our Worker sent; /user answers
 * as `user` until the token is revoked, which needs the app's credentials
 * (Basic). Other fetches pass through.
 */
export function mockGitHub(
  user: { id: number; login: string },
  options: GitHubOptions = {},
) {
  const challenges = new Map<string, string>(); // code -> challenge
  const revoked: string[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (options.unreachable && new URL(request.url).hostname.endsWith("github.com")) {
      throw new TypeError("Network connection lost.");
    }
    if (request.url === "https://github.com/login/oauth/access_token") {
      const form = await request.formData();
      const challenge = challenges.get(String(form.get("code") ?? ""));
      const ok =
        !options.failTokenExchange &&
        form.get("client_id") === "test-github-client" &&
        form.get("client_secret") === "test-github-secret" &&
        form.get("redirect_uri") === `${ORIGIN}/callback` &&
        challenge !== undefined &&
        (await s256(String(form.get("code_verifier") ?? ""))) === challenge;
      return Response.json(ok ? { access_token: "gho_test", token_type: "bearer", scope: "" } : { error: "bad_verification_code" });
    }
    if (request.url === "https://api.github.com/user") {
      return request.headers.get("authorization") === "Bearer gho_test" && !revoked.includes("gho_test")
        ? Response.json(user)
        : new Response("Bad credentials", { status: 401 });
    }
    if (request.method === "DELETE" && request.url === "https://api.github.com/applications/test-github-client/token") {
      if (options.failRevoke) return new Response("Server error", { status: 500 });
      if (request.headers.get("authorization") !== `Basic ${btoa("test-github-client:test-github-secret")}`) {
        return new Response("Not found", { status: 404 });
      }
      revoked.push(((await request.json()) as { access_token: string }).access_token);
      return new Response(null, { status: 204 });
    }
    return realFetch(input, init);
  });
  return {
    /** The tokens our Worker has revoked so far (it does so in the background). */
    revoked,
    /** What GitHub would do after the user signs in: issue a code for this login. */
    issueCode(githubAuthorizeUrl: string): string {
      const url = new URL(githubAuthorizeUrl);
      const code = `gh-code-${challenges.size + 1}`;
      challenges.set(code, url.searchParams.get("code_challenge")!);
      return code;
    },
    restore: () => spy.mockRestore(),
  };
}

export interface GitHubOptions {
  failTokenExchange?: boolean;
  unreachable?: boolean;
  failRevoke?: boolean;
}

export interface Client {
  clientId: string;
  verifier: string;
  challenge: string;
}

/** Registers a client the way Claude does (dynamic client registration). */
export async function registerClient(): Promise<Client> {
  const response = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test client",
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (response.status !== 201) throw new Error(`registration failed: ${response.status} ${await response.text()}`);
  const { client_id } = (await response.json()) as { client_id: string };
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  return { clientId: client_id, verifier, challenge: await s256(verifier) };
}

/** Step 1–2: the client sends the browser to /authorize; we show the consent page. */
export async function openConsent(client: Client, jar: CookieJar): Promise<{ response: Response; handle: string }> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: client.challenge,
    code_challenge_method: "S256",
    state: "client-state",
    resource: `${ORIGIN}/mcp`,
  });
  const response = await send(`/authorize?${params}`);
  jar.take(response);
  const html = await response.clone().text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { response, handle };
}

/** Step 3: the user clicks Allow or Deny. */
export async function decide(handle: string, decision: "approve" | "deny", jar: CookieJar): Promise<Response> {
  const response = await send("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ handle, decision }),
  });
  jar.take(response);
  return response;
}

/** Step 4: GitHub sends the browser back to our callback. */
export async function githubCallback(query: string, jar: CookieJar): Promise<Response> {
  const response = await send(`/callback?${query}`, { headers: { cookie: jar.header() } });
  jar.take(response);
  return response;
}

/** Step 5: the client trades our one-time code (plus its PKCE secret) for tokens. */
export function exchangeCode(client: Client, code: string, verifier = client.verifier): Promise<Response> {
  return send("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT_REDIRECT,
      client_id: client.clientId,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
}

/** The whole login as `user`, start to finish. Returns where the browser ends up. */
export async function login(user: { id: number; login: string }, options: GitHubOptions = {}) {
  const github = mockGitHub(user, options);
  try {
    const client = await registerClient();
    const jar = new CookieJar();
    const { handle } = await openConsent(client, jar);
    const toGitHub = await decide(handle, "approve", jar);
    const githubUrl = toGitHub.headers.get("location")!;
    const state = new URL(githubUrl).searchParams.get("state")!;
    const code = github.issueCode(githubUrl);
    const back = await githubCallback(new URLSearchParams({ code, state }).toString(), jar);
    return { client, final: new URL(back.headers.get("location")!), revoked: github.revoked };
  } finally {
    github.restore();
  }
}

/** Logs in as the owner and returns tokens. */
export async function ownerTokens(): Promise<Tokens & { client_id: string }> {
  const { client, final } = await login(OWNER);
  const response = await exchangeCode(client, final.searchParams.get("code")!);
  if (response.status !== 200) throw new Error(`token exchange failed: ${await response.text()}`);
  return { ...((await response.json()) as Tokens), client_id: client.clientId };
}
