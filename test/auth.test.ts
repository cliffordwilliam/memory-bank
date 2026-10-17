// Phase 5: the login, the whole way Claude and a browser walk it (spec §11).
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { authHandler } from "../src/auth";
import worker from "../src/index";
import {
  CookieJar,
  decide,
  exchangeCode,
  githubCallback,
  login,
  mockGitHub,
  openConsent,
  ORIGIN,
  OWNER,
  ownerTokens,
  registerClient,
  send,
  STRANGER,
  type Tokens,
} from "./oauth";

/**
 * Calls the Worker module directly with a custom env (e.g. a changed allowlist).
 * Test-built Requests lack the cf fields a real incoming request carries, hence the cast.
 */
async function callWorker(request: Request, workerEnv: Record<string, unknown>): Promise<Response> {
  return worker.fetch(
    request as Request<unknown, IncomingRequestCfProperties>,
    { ...env, ...workerEnv } as Env,
    createExecutionContext(),
  );
}

const toolsList = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

function callMcp(token: string | null, workerEnv?: Record<string, unknown>): Promise<Response> {
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      host: "localhost:8787",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: toolsList,
  });
  // With a custom env, call the Worker module directly instead of through exports.
  return workerEnv
    ? callWorker(request, workerEnv)
    : send("/mcp", { method: request.method, headers: request.headers, body: toolsList });
}

describe("discovery (what Claude reads first)", () => {
  it("/mcp without a token is 401, pointing at the resource metadata", async () => {
    const response = await callMcp(null);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("publishes the resource and the authorization server", async () => {
    const resource = await (await send("/.well-known/oauth-protected-resource/mcp")).json<any>();
    expect(resource.resource).toBe(`${ORIGIN}/mcp`);
    expect(resource.authorization_servers).toEqual([ORIGIN]);

    const server = await (await send("/.well-known/oauth-authorization-server")).json<any>();
    expect(server).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
    expect(server.token_endpoint_auth_methods_supported).toContain("none");
  });
});

describe("the owner's login", () => {
  let tokens: Tokens & { client_id: string };

  it("goes consent → GitHub → back to the client with a one-time code", async () => {
    const { final } = await login(OWNER);
    expect(final.origin + final.pathname).toBe("http://localhost:3000/callback");
    expect(final.searchParams.get("state")).toBe("client-state");
    expect(final.searchParams.get("code")).toBeTruthy();
    expect(final.searchParams.get("iss")).toBe(ORIGIN);
  });

  it("issues tokens that open /mcp", async () => {
    tokens = await ownerTokens();
    const response = await callMcp(tokens.access_token);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"name":"remember"');
  });

  it("refreshes to a new pair that also works", async () => {
    const response = await send("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      // A public client (no secret, like Claude) names itself on every token request.
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: tokens.client_id,
      }),
    });
    expect(response.status).toBe(200);
    const refreshed = await response.json<Tokens>();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect((await callMcp(refreshed.access_token)).status).toBe(200);
  });

  it("the consent page shows the client, where access goes, and can't be framed", async () => {
    const client = await registerClient();
    const { response } = await openConsent(client, new CookieJar());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Allow Test client to use your memory bank?");
    expect(html).toContain("<strong>localhost</strong>");
    expect(html).toContain("This sends access to an app on your computer.");
    expect(html).toContain("isn't verified");
    expect(response.headers.get("content-security-policy") ?? response.headers.get("x-frame-options")).toBeTruthy();
  });

  it("escapes a client name chosen to inject HTML", async () => {
    const response = await send("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: '<script>alert("x")</script>',
        redirect_uris: ["http://localhost:3000/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = await response.json<{ client_id: string }>();
    const client = { ...(await registerClient()), clientId: client_id };
    const html = await (await openConsent(client, new CookieJar())).response.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
  });
});

describe("the error boundary (src/index.ts)", () => {
  // The library and the MCP handler answer their own failures (a broken KV
  // reads as "Invalid client_id"; a broken database behind /mcp is a JSON-RPC
  // "Internal server error"). The boundary is the last stop for our own route
  // code, so simulate a bug there.
  it("answers a bug in our own code with a plain 500 that leaks nothing", async () => {
    const spy = vi.spyOn(authHandler, "fetch").mockRejectedValue(new Error("bug: secret-detail-123"));
    try {
      const response = await send("/authorize");
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toBe("Internal error.");
      expect(body).not.toContain("secret-detail");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("refusals", () => {
  it("someone else's GitHub account gets access_denied and no code", async () => {
    const { final } = await login(STRANGER);
    expect(final.searchParams.get("error")).toBe("access_denied");
    expect(final.searchParams.get("error_description")).toBe("This memory bank belongs to someone else");
    expect(final.searchParams.get("code")).toBeNull();
  });

  it("Deny on the consent page goes back with access_denied", async () => {
    const client = await registerClient();
    const jar = new CookieJar();
    const { handle } = await openConsent(client, jar);
    const response = await decide(handle, "deny", jar);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state");
  });

  it("cancelling at GitHub goes back with access_denied", async () => {
    const client = await registerClient();
    const jar = new CookieJar();
    const { handle } = await openConsent(client, jar);
    const toGitHub = await decide(handle, "approve", jar);
    const state = new URL(toGitHub.headers.get("location")!).searchParams.get("state")!;
    const back = await githubCallback(new URLSearchParams({ error: "access_denied", state }).toString(), jar);
    expect(new URL(back.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("a GitHub failure goes back with temporarily_unavailable", async () => {
    const github = mockGitHub(OWNER, { failTokenExchange: true });
    try {
      const client = await registerClient();
      const jar = new CookieJar();
      const { handle } = await openConsent(client, jar);
      const toGitHub = await decide(handle, "approve", jar);
      const githubUrl = toGitHub.headers.get("location")!;
      const state = new URL(githubUrl).searchParams.get("state")!;
      const back = await githubCallback(new URLSearchParams({ code: github.issueCode(githubUrl), state }).toString(), jar);
      expect(new URL(back.headers.get("location")!).searchParams.get("error")).toBe("temporarily_unavailable");
    } finally {
      github.restore();
    }
  });

  it("GitHub being unreachable also goes back with temporarily_unavailable", async () => {
    const github = mockGitHub(OWNER, { unreachable: true });
    try {
      const client = await registerClient();
      const jar = new CookieJar();
      const { handle } = await openConsent(client, jar);
      const githubUrl = (await decide(handle, "approve", jar)).headers.get("location")!;
      const state = new URL(githubUrl).searchParams.get("state")!;
      const back = await githubCallback(new URLSearchParams({ code: "any", state }).toString(), jar);
      expect(back.status).toBe(302);
      expect(new URL(back.headers.get("location")!).searchParams.get("error")).toBe("temporarily_unavailable");
    } finally {
      github.restore();
    }
  });

  it("the consent form works once, and only in the browser that opened it", async () => {
    const client = await registerClient();
    const jar = new CookieJar();
    const { handle } = await openConsent(client, jar);
    // Another browser (no cookies) posting the same handle is refused.
    expect((await decide(handle, "approve", new CookieJar())).status).toBe(400);
    // The real browser can use it once...
    expect((await decide(handle, "approve", jar)).status).toBe(302);
    // ...and not twice.
    expect((await decide(handle, "approve", jar)).status).toBe(400);
  });

  it("GitHub's callback only works in the browser that started the login", async () => {
    const github = mockGitHub(OWNER);
    try {
      const client = await registerClient();
      const jar = new CookieJar();
      const { handle } = await openConsent(client, jar);
      const githubUrl = (await decide(handle, "approve", jar)).headers.get("location")!;
      const state = new URL(githubUrl).searchParams.get("state")!;
      const query = new URLSearchParams({ code: github.issueCode(githubUrl), state }).toString();
      expect((await githubCallback(query, new CookieJar())).status).toBe(400);
    } finally {
      github.restore();
    }
  });

  it("a stolen one-time code is useless without the client's PKCE secret", async () => {
    const { client, final } = await login(OWNER);
    const response = await exchangeCode(client, final.searchParams.get("code")!, "not-the-real-verifier");
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe("invalid_grant");
  });

  it("a made-up token gets 401", async () => {
    expect((await callMcp("made-up-token")).status).toBe(401);
  });

  it("changing the allowed id locks out tokens issued before the change", async () => {
    const tokens = await ownerTokens();
    expect((await callMcp(tokens.access_token, {})).status).toBe(200);
    expect((await callMcp(tokens.access_token, { ALLOWED_GITHUB_ID: "2002" })).status).toBe(403);
  });

  it.each([
    ["no allowed id", { ALLOWED_GITHUB_ID: undefined }],
    ["a malformed allowed id", { ALLOWED_GITHUB_ID: "owner" }],
    ["no GitHub secret", { GITHUB_CLIENT_SECRET: undefined }],
    ["no PUBLIC_URL", { PUBLIC_URL: undefined }],
    ["a PUBLIC_URL with a path", { PUBLIC_URL: "http://localhost:8787/mcp" }],
  ])("with %s, nobody gets in", async (_, broken) => {
    const tokens = await ownerTokens();
    expect((await callMcp(tokens.access_token, broken)).status).toBe(500);
    const consent = await callWorker(
      new Request(`${ORIGIN}/authorize?response_type=code`, { headers: { host: "localhost:8787" } }),
      broken,
    );
    expect(consent.status).toBe(500);
  });
});
