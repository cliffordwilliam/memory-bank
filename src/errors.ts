// Every kind of error the Worker throws, and how each is answered.
//
// Route code just throws. There are two boundaries, one per protocol:
//
//   HTTP (all routes)        errorResponse() below, called by the top-level
//                            fetch in index.ts
//   MCP (inside a tool call) respond() in mcp.ts. A tool failure must come
//                            back *inside* the MCP reply (JSON-RPC with
//                            isError: true), so Claude reads it as "fix your
//                            call" rather than "the server is broken".
//
// | Error              | Thrown by                    | Answered as                              |
// |--------------------|------------------------------|------------------------------------------|
// | BankError          | src/bank/* (a rule broke)    | MCP tool error with the message (mcp.ts) |
// | ConfigError        | config.ts (bad settings)     | 500 "not configured"                     |
// | LoginFailed        | auth.ts (login refused)      | redirect back to the client with error   |
// | AuthorizationError | OAuth library (bad request)  | redirect if safe, else a 400 page        |
// | CimdFetchError     | OAuth library (client's      | 400 page                                 |
// |                    | metadata unreachable)        |                                          |
// | anything else      | a bug or an outage           | logged; a bare 500 with no details       |

import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { escape, page } from "./pages";

export { AuthorizationError, CimdFetchError };

/** A bank rule was broken. The message tells Claude how to fix the call. */
export class BankError extends Error {
  override name = "BankError";
}

/** A setting is missing or meaningless. Nobody gets in until it's fixed. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * The login ends here, and the browser goes back to the client with an OAuth
 * error (e.g. access_denied). Carries the finished redirect, cookies included.
 */
export class LoginFailed extends Error {
  override name = "LoginFailed";
  constructor(
    readonly redirect: Headers,
    reason: string,
  ) {
    super(reason);
  }
}

/** The HTTP boundary: turns anything thrown by a route into its reply. */
export function errorResponse(error: unknown): Response {
  if (error instanceof LoginFailed) {
    return new Response(null, { status: 302, headers: error.redirect });
  }
  // The library sets redirectTo only once the client and its redirect URI are verified.
  if (error instanceof AuthorizationError && error.redirectTo) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error instanceof AuthorizationError) {
    return page(400, "Sign-in failed", `<p>${escape(error.description)}</p>`);
  }
  if (error instanceof CimdFetchError) {
    return page(400, "Sign-in failed", "<p>This app could not be verified.</p>");
  }
  if (error instanceof ConfigError) {
    console.error("memory-bank is not configured:", error.message);
    return new Response("This memory bank isn't configured yet.", { status: 500 });
  }
  console.error("memory-bank internal error:", error instanceof Error ? (error.stack ?? error.message) : error);
  return new Response("Internal error.", { status: 500 });
}
