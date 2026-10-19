# Dependency versions

Every dependency in `package.json` is pinned to an exact version (no `^` or `~`), so an install today and an install in a year fetch the same code. `package-lock.json` pins everything those packages pull in as well. Upgrades are deliberate: change the version here and in `package.json`, read the changelog, and run the tests.

Dependabot (`.github/dependabot.yml`) opens a PR each week for anything newer, keeping the pins exact, and the Test workflow runs on it. It doesn't edit this file: update the table in the same PR before merging.

Versions chosen on 2026-10-16.

## Runtime dependencies (shipped to Cloudflare)

| Package | Version | What it does here | Why this version |
|---|---|---|---|
| `agents` | 0.28.1 | Cloudflare's library for agents and MCP. We use only `createMcpHandler` and `getMcpAuthContext` from `agents/mcp/server`: they answer MCP requests statelessly and give tool code the logged-in user's props. | The latest release. `createMcpHandler` is the path Cloudflare's docs recommend for new servers; the older `McpAgent` is deprecated. |
| `@modelcontextprotocol/server` | 2.3.1 | The official MCP SDK's server side: the `McpServer` class and `registerTool`, which turn Zod schemas into the tool definitions Claude sees. | The exact version `agents` 0.28.1 declares as its peer, and the one Cloudflare's examples use. |
| `@cloudflare/workers-oauth-provider` | 1.2.3 | The OAuth server that Claude logs in through: discovery metadata, client registration, tokens, PKCE, refresh rotation, plus safe helpers for the consent page and the GitHub sign-in redirect. | The latest release. The 1.x line added the consent and upstream helpers (older demos hand-write about 870 lines for this) and requires the canonical resource URL that MCP clients check. |
| `zod` | 4.6.7 | Input validation for every tool argument, with our friendly error messages. The MCP SDK reads the same schemas to describe the tools. | The latest 4.x. `agents` and the MCP SDK both require Zod 4. |

`agents` also declares `@modelcontextprotocol/sdk` 1.32.1 and `@modelcontextprotocol/client` 2.3.1 as required peers, so npm installs them automatically. We don't import them ourselves, so they aren't listed in `package.json`; `package-lock.json` pins them.

## Development tools (only on your machine)

| Package | Version | What it does here | Why this version |
|---|---|---|---|
| `wrangler` | 4.151.1 | Cloudflare's command-line tool: local dev server, D1 and KV management, migrations, secrets, deploys, generated types. | The latest release. It needs Node ≥ 22, which is why `package.json` has `"engines": { "node": ">=22" }`. |
| `typescript` | 6.0.3 | Type-checking only (`tsc --noEmit`). Wrangler's bundler strips the types when building. | The latest 6.x. TypeScript 7 (the native rewrite) is new, and Cloudflare's own examples still use 6. |
| `vitest` | 4.1.12 | The test runner, similar to pytest. | The latest 4.x. Cloudflare's testing docs specify `vitest@^4.1.0`. Vitest 5 is allowed by the plugin, but the docs haven't caught up yet. |
| `@cloudflare/vitest-plugin` | 1.4.4 | Runs the tests inside `workerd`, Cloudflare's runtime, with real local D1 and KV. | The latest release. It replaced the older `@cloudflare/vitest-pool-workers`. |

## Not added on purpose

- **`@types/node`:** Wrangler suggests it because `nodejs_compat` is on, but our code doesn't use Node APIs.
- **`hono`, `octokit`:** used in older GitHub-login demos, but the OAuth library's 1.x helpers and one `fetch` to GitHub's API replace them.
- **`vite`, `react`, UI packages:** the server has no web pages beyond the login screens.

## Install scripts

npm 12 blocks dependency install scripts unless they're approved. Three were blocked, and none is needed:
- `esbuild` and `workerd` get their Linux binaries through optional platform packages (`@esbuild/linux-x64`, `@cloudflare/workerd-linux-64`), and their scripts only check those.
- `core-js-pure` (pulled in indirectly by `agents`) only prints a funding message.
