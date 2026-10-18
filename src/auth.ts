// Our part of the login (spec §11, build plan phase 5). The OAuth library
// owns tokens, registration and discovery; these routes are the pages it
// leaves to the application:
//
//   GET  /authorize  consent page: "Allow <client> to use your memory bank?"
//   POST /authorize  Deny: back to the client. Allow: off to GitHub's login.
//   GET  /callback   GitHub sends the browser back; check who it is against
//                    the allowlist, then hand the client its one-time code.
//
// These routes only throw; src/errors.ts says how each error is answered
// (following the library's consent-page guide: redirect back to the client
// only when that's safe, otherwise show a page).

import {
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { readConfig, type Props } from "./config";
import { LoginFailed } from "./errors";
import { githubAuthorizeUrl, githubUser, pkcePair } from "./github";
import { escape, html, lockDown, page } from "./pages";

/** The Worker's env, plus the helpers the OAuth library adds for its default handler. */
type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

export const authHandler = {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize" && request.method === "GET") return showConsent(request, env);
    if (pathname === "/authorize" && request.method === "POST") return submitConsent(request, env);
    if (pathname === "/callback" && request.method === "GET") return githubCallback(request, env);
    if (pathname === "/" && request.method === "GET") {
      return page(200, "Memory bank", "<p>A personal memory bank for Claude. Connect at <code>/mcp</code>.</p>");
    }
    return new Response("Not found", { status: 404 });
  },
};

async function showConsent(request: Request, env: AuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest); // first: a failed lookup leaves nothing behind
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("content-type", "text/html; charset=utf-8");
  lockDown(consent.headers);
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function submitConsent(request: Request, env: AuthEnv): Promise<Response> {
  const config = readConfig(env);
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle);
  // PKCE on our leg too: GitHub's code is useless without this verifier,
  // which never leaves the server (it rides in the library's encrypted state).
  const { verifier, challenge } = await pkcePair();
  const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  upstream.headers.set("location", githubAuthorizeUrl(config, upstream.state, challenge));
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function githubCallback(request: Request, env: AuthEnv): Promise<Response> {
  const config = readConfig(env);
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
  const params = new URL(request.url).searchParams;

  // The user declined at GitHub, or GitHub sent no code.
  const code = params.get("code");
  if (params.get("error") || !code) {
    throw loginFailed(original, headers, "access_denied", "GitHub sign-in was cancelled");
  }

  const user = await githubUser(config, code, data.verifier);
  if (!user) throw loginFailed(original, headers, "temporarily_unavailable", "GitHub sign-in failed; try again");

  // The allowlist: GitHub proved who this is; only one account may in.
  if (user.id !== config.allowedGithubId) {
    console.warn(`refused GitHub account ${user.login} (${user.id})`);
    throw loginFailed(original, headers, "access_denied", "This memory bank belongs to someone else");
  }

  const props: Props = { githubId: user.id, login: user.login };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: original.scope,
    props,
  });
  headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers });
}

/** Ends the login: back to the client with an OAuth error, keeping the library's cookie headers. */
function loginFailed(
  original: AuthRequest,
  headers: Headers,
  code: "access_denied" | "temporarily_unavailable",
  description: string,
): LoginFailed {
  headers.set("location", authorizationErrorRedirect(original, code, description));
  return new LoginFailed(headers, description);
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it (for example Claude Code).</p>"
    : "";
  return html(
    `Allow ${name}?`,
    `<h1>Allow ${name} to use your memory bank?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p>It will be able to save to and read from your memory bank. You'll sign in with GitHub next.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny">Deny</button>
</form>`,
  );
}
