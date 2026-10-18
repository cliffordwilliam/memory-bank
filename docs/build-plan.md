# Memory bank: build plan (2026-10-16)

Builds the design in `bank-spec.md` (draft 6, final). Each phase ends with a check you can see for yourself, and a commit. Nothing goes online until phase 6.

**Who does what:**
- **You:** anything that needs `sudo`, a browser login, or your accounts:
  - pacman;
  - `wrangler login`;
  - creating the GitHub OAuth apps;
  - adding the connector in claude.ai.
- **Claude:** writes the code, migrations, tests and docs. Explains each file. Runs the local commands and tests.
- **Review:** after each phase you read the diff and the explanation, and only then do we commit and move on.

## Phase 0: prerequisites (you)

1. Install Node and npm from `extra`:
   ```
   sudo pacman -S nodejs-lts-krypton npm
   ```
   - The LTS (24) is what Cloudflare's tooling is tested against.
   - Plain `nodejs` (26, the current release) would probably work too. LTS just means fewer surprises.
   - `npm` works with either.
2. A Cloudflare account on the free plan, if you don't have one yet. No card needed.
3. 2FA turned on for GitHub and claude.ai.

**Done when:** `node --version` and `npm --version` both print a version.

## Phase 1: docs and scaffold

**First, read the current docs** (Claude reads them and summarizes; links for you below). APIs move, so nothing gets written from memory:
- Cloudflare: remote MCP server guide, `createMcpHandler`, and the authorization/`workers-oauth-provider` page.
- The MCP TypeScript SDK: registering tools with Zod schemas.
- D1: getting started, migrations, local development, limits.
- Workers testing: `@cloudflare/vitest-plugin` (it replaced `@cloudflare/vitest-pool-workers`).
- SQLite: FTS5 external-content tables and triggers, generated columns, date functions, `RAISE()` in triggers.
- claude.ai custom connectors (remote MCP, OAuth callback URL), and Claude Code's MCP docs (connectors through your claude.ai account).

**Then the scaffold:**
- **The repo at `~/projects/<name>`,** with `git init`.
- **`package.json` with exact versions,** and only the dependencies the docs call for: `wrangler`, `typescript`, the MCP/agents package, `@cloudflare/workers-oauth-provider`, `zod`, `vitest`, `@cloudflare/vitest-plugin`.
- **`wrangler.jsonc`** with local-only D1 and KV bindings for now.
- **`tsconfig.json`, `.gitignore`** (`.wrangler/`, `node_modules/`, `.dev.vars`).
- **`docs/spec.md`** (copied from `bank-spec.md`) and `docs/build-plan.md` (this file).

**Done when:** `npx wrangler --version` runs inside the repo, and a hello-world Worker answers on `npx wrangler dev`.

### Phase 1 findings (from the docs, 2026-10-16)

**Versions (pinned exactly):**
- `agents` 0.28.1, `@modelcontextprotocol/server` 2.3.1, `@cloudflare/workers-oauth-provider` 1.2.3, `zod` 4.6.7;
- dev: `wrangler` 4.151.1 (needs Node ≥22), `typescript` 6.0.3, `vitest` 4.1.12, `@cloudflare/vitest-plugin` 1.4.4.

**Packaging:**
- npm also installs `agents`' required peers: `@modelcontextprotocol/sdk` and `@modelcontextprotocol/client`.
- npm 12 blocks dependency install scripts. `esbuild` and `workerd` get their Linux binaries through optional packages, so nothing needs approving.
- TypeScript 7 (the native rewrite) is skipped, because Cloudflare's examples use 6.

**MCP server:**
- `createMcpHandler(factory)` from `agents/mcp/server` builds a fresh `McpServer` (from `@modelcontextprotocol/server`) per request. It's stateless, with no Durable Object.
- Tools are registered with `server.registerTool(name, { description, inputSchema: { …zod } }, handler)`.
- The default export must be an object with `fetch()`.

**OAuth (`workers-oauth-provider` 1.x):**
- `OAuthProvider({ apiRoute: '/mcp', apiHandler, defaultHandler, authorizeEndpoint, tokenEndpoint, clientRegistrationEndpoint?, resourceMetadata: { resource }, requiredScopes?, clientIdMetadataDocumentEnabled? })`.
- `resourceMetadata.resource` must be the exact public `/mcp` URL: `http://localhost:…` for dev, `https://…workers.dev/mcp` for prod. So it comes from a variable per environment.
- The built-in consent and upstream helpers (`describeConsent`, `beginConsent`, `approveConsent`, `denyConsent`, `beginUpstream`, `finishUpstream`) replace the hand-written helper file in older GitHub demos. No Hono and no Octokit are needed: one `fetch` to `api.github.com/user` gets the numeric id.
- Tool code reads props via `getMcpAuthContext()`.
- Tokens are stored hashed and props encrypted in KV (`OAUTH_KV`).
- Refresh tokens rotate, and grants last 30 days by default (`refreshTokenTTL`).
- **Allowlist:** check the numeric GitHub id at `/callback` before `completeAuthorization`, *and* again in the API handler on every request, so changing the allowed id locks out old tokens.

**Claude's connector requirements** (claude.com/docs/connectors/building/authentication):
- A `401` with `resource_metadata` is needed to start sign-in.
- Claude uses DCR, or CIMD when the metadata advertises `client_id_metadata_document_supported` and `none`. CIMD needs the `global_fetch_strictly_public` compatibility flag.
- Callbacks: `https://claude.ai/api/mcp/auth_callback` for web, desktop and phone, and port-agnostic loopback for Claude Code (`http://localhost/callback`, `http://127.0.0.1/callback`).
- S256 PKCE; form-urlencoded token requests; rotated refresh tokens; `invalid_grant` on dead refresh tokens; a 10 s endpoint and 30 s refresh time limit.
- Traffic comes from `160.79.104.0/21`.
- The library covers PKCE, rotation, the token endpoint and loopback handling. We verify loopback-`localhost` matching in phase 7.

**D1:**
- Supports STORED generated columns, created with the table (`ALTER TABLE` can only add VIRTUAL ones), using deterministic expressions only. Phase 2 confirms `strftime(…, occurred_at)` is accepted.
- Tests load migrations with `readD1Migrations` (from `@cloudflare/vitest-plugin/config`) and apply them in a setup file. Exact signatures are checked in phase 2.

## Phase 2: the database

- **`migrations/0001_init.sql`** creates the `types`, `names` and `records` tables, `occurred_at_utc`, the indexes, the FTS5 table and all triggers, and seeds the five types with their descriptions.
- **Apply it locally:** `npx wrangler d1 migrations apply <db> --local`.
- **Tests against the local D1, at the SQL level:**
  - every trigger: deletes refused, forbidden updates refused, the admin updates allowed and setting `modified_at`, a redaction refreshing the index;
  - `occurred_at_utc` derived correctly, with invalid times refused;
  - `corrects`: the same-name check, once per record, no self-correction, and `kind` both-or-neither.

**Done when:** the SQL tests pass, and you can run the admin commands from spec §10 against the local database by hand.

## Phase 3: the bank logic (no MCP, no login)

- **Plain TypeScript functions:** `remember`, `recall` and `listTopics`, using the local D1.
- **Zod schemas** for every input, with the friendly error messages R1–R13.
- **Search:** keyword quoting, OR plus bm25, `order_by` and `direction` with the id tie-break, and paging tokens.
- **Output:** `corrected_by` and `corrected_kind` computed, body truncation, and the "stored data" label.
- **Tests:**
  - every rule R1–R13;
  - the time round-trips (midnight, month and year boundaries, `+05:30`, negative offsets, `2026-02-30`, the 5-minute future slack);
  - search with punctuation and plurals;
  - paging with tied times;
  - the head via `order_by=created_at`;
  - `previous_id`.

**Done when:** all tests pass, and the spec §14 walkthrough runs as a test script with the expected results.

## Phase 4: MCP tools (local, no login)

- **Wrap the three functions** as MCP tools with `createMcpHandler`.
- **Tool definitions** are built from the Zod schemas and the `types` table, and the descriptions carry the spec §7 texts.
- **Try it locally** with the MCP Inspector against `wrangler dev`: call each tool by hand and read exactly what Claude would see.

**Done when:** you've called all three tools in the Inspector and the descriptions and errors read well to you.

## Phase 5: login (local)

1. **You:** create two GitHub OAuth apps:
   - "dev", with callback `http://localhost:8787/callback` (the port `wrangler dev` uses);
   - "prod", whose callback URL we fill in at phase 6.
2. Copy `.dev.vars.example` to `.dev.vars` (never committed) and fill in the dev app's id and secret and your GitHub id (`PUBLIC_URL` is already `http://localhost:8787`).
3. **The code:**
   - `workers-oauth-provider` in front of `/mcp`;
   - the GitHub handler;
   - the numeric-id allowlist, checked on every request and failing closed when the setting is missing.

**Done when:**
- the Inspector goes through a GitHub login and reaches the tools;
- with the allowlist set to another number, you're refused;
- with no allowlist set, everyone is refused.

## Phase 6: deploy

1. **You:** `npx wrangler login` (in the browser).
2. **Create the remote resources:** the remote D1 database and the KV namespace. Put their ids in `wrangler.jsonc`.
3. **Apply the migration remotely:** `npx wrangler d1 migrations apply <db> --remote`.
4. **Settings:** `wrangler secret put` each of `PUBLIC_URL` (the real `workers.dev` address), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `ALLOWED_GITHUB_ID`. `wrangler deploy` refuses to go out while any is missing.
5. **You:** set the prod OAuth app's callback to `https://<worker>.workers.dev/callback`.
6. `npx wrangler deploy`.
7. **Allowlist check online:** set a different id, confirm you're refused, then set yours back.

**Done when:** the deployed Worker refuses everyone except you.

## Phase 7: connect and try it for real

1. **You:** add the connector at claude.ai (Settings → Connectors → custom), using `https://<worker>.workers.dev/mcp`, and log in with GitHub.
2. Check it appears in claude.ai web, the phone app and Claude Code (as a `claude_ai` tool).
3. Run the spec §14 walkthrough by hand from each app. Note anything Claude hesitates over and fix the tool descriptions.

**Done when:** a record saved from the phone is recalled from Claude Code, and the other way round.

## Phase 8: README

- **Why the project exists:** other memory tools merge and summarize notes with a model. The curator tests showed how that distorts notes, and the README cites those results.
- **What it is:** the three tools, the branch/commit model, and corrections.
- **How to deploy your own:** phases 0, 5 and 6, shortened.
- **The admin commands** (spec §10).
- **The Claude Code time hook:** that Claude Code works best with it, and how to set it up (or a "coming next" note until it exists).

**Done when:** you've read it and it's committed.

## After the first version (in this order)

1. **Backups:** done 2026-10-18, in a separate private repo (`memory-bank-backup`). A nightly GitHub Action runs one `wrangler d1 export --remote --no-schema` of `types`, `names` and `records` and uploads the SQL to Backblaze B2, kept 30 days. Restore tested against the live data, corrections included. Chosen over a Worker writing JSON to R2: the copy lives outside Cloudflare, and it's plain SQL. Its README and `restore.md` hold the setup and the restore steps.
2. **The Claude Code time hook:** done 2026-10-18, as `hooks/time-hook.json` plus README instructions.
3. **Delete the curator repo:** done 2026-10-18, with the test kit, once the README recorded its results.

## Decisions needed before phase 1

1. **Repo name and location:** e.g. `~/projects/memory-bank`.
2. **GitHub repo:** private or public. Public matters if others should use it; nothing secret is ever in the repo either way.
3. **Node:** `nodejs-lts-krypton` (recommended) or plain `nodejs`.
