// The Worker (build plan phase 5). The OAuth library sits in front of
// everything: it serves discovery, client registration and the token
// endpoint, and only lets requests with a valid access token through to /mcp.
// Our own pages (consent, GitHub callback) are the default handler.
//
// The top-level fetch is the HTTP error boundary: the library calls our
// handlers without catching, so anything they throw ends up there, and
// errorResponse() in src/errors.ts answers it. (Tool errors have their own
// boundary inside the MCP reply; see src/errors.ts.)

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { authHandler } from "./auth";
import { spendLoginBudget } from "./bank/store";
import { readConfig, type Props } from "./config";
import { errorResponse } from "./errors";
import { createBankServer } from "./mcp";

/**
 * Whether the grant behind this request belongs to the allowed account. Checked
 * on every request, not just at login, so changing ALLOWED_GITHUB_ID locks out
 * tokens issued before the change.
 */
function isAllowed(env: Env, ctx: ExecutionContext): boolean {
  // ctx.props is the grant's props, but the OAuth library types it as unknown.
  const props = (ctx as ExecutionContext<Partial<Props> | undefined>).props;
  return props?.githubId === readConfig(env).allowedGithubId;
}

/** /mcp, reached only with a valid token. */
const bankApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!isAllowed(env, ctx)) return new Response("Forbidden", { status: 403 });
    return createMcpHandler(() => createBankServer(env.DB))(request, env, ctx);
  },
};

// The provider's settings depend on PUBLIC_URL, so it's built on the first
// request (once per Worker instance) rather than at import time.
let provider: OAuthProvider<Env> | undefined;
let providerUrl: string | undefined;

function oauthProvider(publicUrl: string): OAuthProvider<Env> {
  if (!provider || providerUrl !== publicUrl) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: bankApi,
      defaultHandler: authHandler as unknown as ExportedHandler<Env>,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      // Claude prefers a Client ID Metadata Document when the server
      // supports it, which avoids registering a new client per connection.
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${publicUrl}/mcp`, resource_name: "Memory bank" },
    });
    providerUrl = publicUrl;
  }
  return provider;
}

/**
 * How many requests a UTC day may send to the anonymous routes that write to
 * KV (issue #8). Each can lead to two KV writes (consent page, then approval),
 * so this keeps them under 400 of the Free plan's 1,000 a day, leaving the
 * rest for token refreshes: connected apps keep working while it's spent.
 */
export const LOGIN_BUDGET = 200;

/** Whether this request needs no login and writes to KV. */
function spendsBudget(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (
    (pathname === "/oauth/register" && request.method === "POST") ||
    (pathname === "/authorize" && request.method === "GET")
  );
}

/** Seconds until 00:00 UTC, when the budget (and KV's quota) starts again. */
function secondsToUtcMidnight(): number {
  return Math.ceil((new Date().setUTCHours(24, 0, 0, 0) - Date.now()) / 1000);
}

export default {
  async fetch(request, env, ctx) {
    try {
      // Every request starts by validating the settings; a bad one refuses everyone.
      const { publicUrl } = readConfig(env);
      if (spendsBudget(request) && !(await spendLoginBudget(env.DB, LOGIN_BUDGET))) {
        return new Response("Today's login budget is used up; try again after 00:00 UTC.", {
          status: 429,
          headers: { "retry-after": String(secondsToUtcMidnight()) },
        });
      }
      return await oauthProvider(publicUrl).fetch(request, env, ctx);
    } catch (error) {
      return errorResponse(error); // src/errors.ts: how each kind of error is answered
    }
  },
} satisfies ExportedHandler<Env>;
