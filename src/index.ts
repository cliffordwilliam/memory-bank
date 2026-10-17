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
    const allowed = readConfig(env).allowedGithubId;
    const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
    if (props?.githubId !== allowed) return new Response("Forbidden", { status: 403 });
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
