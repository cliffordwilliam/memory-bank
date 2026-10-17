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
import { readConfig, type Props } from "./config";
import { errorResponse } from "./errors";
import { createBankServer } from "./mcp";

/**
 * /mcp, reached only with a valid token. The allowed id is checked again on
 * every request, not just at login, so changing ALLOWED_GITHUB_ID locks out
 * tokens issued before the change.
 */
const bankApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { allowedGithubId, publicUrl } = readConfig(env);
    const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
    if (props?.githubId !== allowedGithubId) return revokedToken(publicUrl);
    return createMcpHandler(() => createBankServer(env.DB))(request, env, ctx);
  },
};

/**
 * A token whose account is no longer allowed counts as revoked: 401 with
 * invalid_token (RFC 6750 §3.1), pointing at the same discovery document as
 * the library's own 401s. Clients then start a fresh login, which ends at
 * GitHub's callback with "This memory bank belongs to someone else", rather
 * than stopping at a 403 they can't act on. No token is issued, so no loop.
 */
function revokedToken(publicUrl: string): Response {
  const metadata = `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
  return new Response("This token's account is no longer allowed.", {
    status: 401,
    headers: {
      "www-authenticate": `Bearer realm="OAuth", error="invalid_token", error_description="account no longer allowed", resource_metadata="${metadata}"`,
    },
  });
}

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

export default {
  async fetch(request, env, ctx) {
    try {
      // Every request starts by validating the settings; a bad one refuses everyone.
      const { publicUrl } = readConfig(env);
      return await oauthProvider(publicUrl).fetch(request, env, ctx);
    } catch (error) {
      return errorResponse(error); // src/errors.ts: how each kind of error is answered
    }
  },
} satisfies ExportedHandler<Env>;
