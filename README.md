# Memory bank

One memory for every Claude app. claude.ai on the web, the Claude phone app
and Claude Code all read and write the same bank through a single custom
connector, so something saved from your phone is there when you ask from your
terminal.

It's a small remote [MCP](https://modelcontextprotocol.io) server on
Cloudflare's free plan (Workers, D1, KV), with GitHub login locked to one
account. There's no AI model on the server: Claude writes the records, and the
server stores them exactly as sent.

## Why this exists

Most memory tools for AI assistants run a model over your notes: they
classify them, merge duplicates, resolve contradictions and write summaries.
This bank deliberately doesn't. It was built because model rewriting distorts
notes, and an earlier experiment of mine showed it happening.

That experiment ("curator") tested a local memory for Claude Code with the
same storage design as this bank: notes stored word for word, add-only, with
corrections as new records. In its first version, a second Claude also
rewrote, classified and summarized the notes. It failed in two ways:

- **It steered.** A summary said "X is the likely place to fix it", and every
  later plan followed it into the wrong place.
- **It distorted.** A note listing "examples: A, B, C" became "only A, B and C
  exist".

A later version kept the notes verbatim and had a fresh Claude answer recall
questions from them. Tested blind against Claude Code's built-in memory on a
real codebase (past commits replayed as tasks, fix plans scored 0–3 by a
blind grader, three recalls per chain):

| | Built-in memory | Curator (verbatim, add-only) |
|---|---|---|
| Plan scores, pilot chain | 2 / 2 / 2 | 2 / 2 / 2 |
| Plan scores, held-out chain | 2 / 3 / 2 | 3 / 3 / 2 |
| Confidently wrong answers | none | none |
| Irrelevant share of memory context | 40–60% | 35–55% |
| Extra cost per chain | – | ~$0.89–1.59 (the curator was a Claude) |
| Recall time | ~45 s | ~90–120 s |

Each cell is a single run, and there were only two chains, so this is
evidence rather than proof. What it supports: **a verbatim, add-only store
held up at least as well as built-in memory, and the model layer on top
added cost and delay without clearly helping.** So this bank keeps the store
and drops the model. What the tests don't show is whether one central bank
is worth having. That's the part this project is for.

## How it works

**Names are branches, records are commits.**

- A **name** (`vanilla-cupcakes`, `meals`, `memory-bank`) is created once,
  with a **type**:
  - `user`: lasting facts about you;
  - `feedback`: rules for Claude;
  - `project`: ongoing work;
  - `reference`: recipes, how-tos;
  - `log`: things that happened, such as meals and doses.
- Every save adds a new **record** on top of its name. The newest record is
  the current version; older ones are history.
- **Nothing is edited or deleted.** If something was wrong, a new record
  points at it with `corrects` and says whether it was a `correction` or a
  `retraction`. The wrong record then shows `corrected_by` wherever it
  appears. To count things ("how many doses this week?"), Claude asks
  recall for `current: true`, which leaves out wrong records and
  retractions, so the total is the count.
- **Every record keeps two times:**
  - when it happened (`occurred_at`), stored exactly as Claude sent it, in
    wall-clock time with your offset;
  - when it was saved (`created_at`, UTC).

**Three tools:**

| Tool | What it does |
|---|---|
| `remember` | Add one record to a name (`new_name: true` plus a `type` to create the name) |
| `recall` | Read records like a GET:<br>• filter by keywords (full-text search), name, type and time range<br>• sort by relevance, by when it happened, or by when it was saved<br>• page through the results |
| `list_topics` | The index: every name with its type, record count and latest record |

Results come back labeled as stored data, never instructions, so a saved note
can't steer Claude. The full design is in [`docs/spec.md`](docs/spec.md).

## Using it

**Claude only uses the bank when you ask:** "save this to the bank", "check
the bank: what did I eat last week?". It never uses it on its own initiative.

**Connecting:**
1. Go to claude.ai → **Customize → Connectors → + Add → Add custom connector**.
2. Enter the name, plus the URL `https://<your-worker>.workers.dev/mcp`.
3. Choose **sign in now** and **Claude's published identity**.

You'll see the bank's consent page, then GitHub's login. The phone app and
Claude Code pick up the connector through your claude.ai account, with no
separate setup. In Claude Code, a session started before you added it needs
a restart (`claude --continue` keeps the conversation).

**Claude Code works best with a time hook.** Every save needs the wall-clock
time with your offset. The web and phone apps show Claude the current time
and your timezone, but Claude Code only knows the date: without help, it has
to run `date` or ask you before saving. A one-line `UserPromptSubmit` hook
fixes that: Claude Code runs it on every message you send and shows Claude its
output alongside the message, e.g.

```
Current local time: 2026-10-18T17:30:12+07:00 (Sunday)
```

To set it up, merge [`hooks/time-hook.json`](hooks/time-hook.json) into
`~/.claude/settings.json` (user settings, so it works in every project; add the
`UserPromptSubmit` entry to your existing `hooks` if you have some). It's only
`date` and `sed`, so it works on Linux and macOS alike; the `sed` turns `+0700`
into the `+07:00` the bank expects. New sessions pick it up; in a running one,
open `/hooks` once.

## Deploying your own

You need a Cloudflare account (free), a GitHub account and Node 22 or later.

1. **Clone and install:** `npm install`.
2. **Two GitHub OAuth apps**, under GitHub Settings → Developer settings → OAuth Apps:
   - **dev**, with callback `http://localhost:8787/callback`;
   - **prod**, with callback `https://memory-bank.<subdomain>.workers.dev/callback`.

   Your workers.dev subdomain is in the Cloudflare dashboard under Workers & Pages.
3. **Local settings:** copy `.dev.vars.example` to `.dev.vars` and fill in:
   - the dev app's client id and secret;
   - your numeric GitHub id (`https://api.github.com/users/<login>` → `id`).

   Then `npm run dev`, and connect the
   [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
   (`npx @modelcontextprotocol/inspector`, Streamable HTTP,
   `http://localhost:8787/mcp`) to try the login and tools locally.
4. **Cloudflare resources:**
   ```
   npx wrangler login
   npx wrangler d1 create memory-bank
   npx wrangler kv namespace create OAUTH_KV
   ```
   Put both ids into `wrangler.jsonc`, then run
   `npx wrangler d1 migrations apply memory-bank --remote`.
5. **Production settings**, entered as secrets (only the names are in `wrangler.jsonc`):
   ```
   npx wrangler secret put PUBLIC_URL             # https://memory-bank.<subdomain>.workers.dev
   npx wrangler secret put GITHUB_CLIENT_ID       # the prod app's
   npx wrangler secret put GITHUB_CLIENT_SECRET   # the prod app's
   npx wrangler secret put ALLOWED_GITHUB_ID      # your numeric GitHub id
   ```
   `wrangler secret bulk <file>` uploads a dotenv file in one go.
6. **Deploy:** `npx wrangler deploy`. It refuses to go out while any of the
   four settings is missing. Check that
   `https://memory-bank.<subdomain>.workers.dev/.well-known/oauth-protected-resource/mcp`
   shows your address, then connect Claude as above.

**Every setting fails closed.** A missing secret, a non-numeric allowed id or
a malformed URL means nobody gets in: the bank answers `500 This memory bank
isn't configured yet.` and the Worker log names the problem.

## Admin (only you can do these)

Claude can only add and read; the server code contains no UPDATE or DELETE
statement, and a test checks that. Database triggers block deletes and
changes to ids, names, times and correction links for everyone. What's left
is yours, with your Cloudflare credentials:

```
# Redact sensitive text saved by mistake (the record stays; the old words leave the search index)
npx wrangler d1 execute memory-bank --remote --command "UPDATE records SET body = '…' WHERE id = 57"
npx wrangler d1 execute memory-bank --remote --command "INSERT INTO records_fts(records_fts) VALUES('optimize')"

# Change a name's type
npx wrangler d1 execute memory-bank --remote --command "UPDATE names SET type = 'project' WHERE name = 'garden-plan'"

# Add a type, or reword one (Claude sees the descriptions in the tool definitions)
npx wrangler d1 execute memory-bank --remote --command "INSERT INTO types (name, description) VALUES ('idea', 'Ideas to revisit.')"
npx wrangler d1 execute memory-bank --remote --command "UPDATE types SET description = '…' WHERE name = 'idea'"
```

D1's Time Travel can still restore a redacted text for a few days after the
edit, as a safety net. So can backups: mine are taken nightly by a separate
private repo (a GitHub Action that exports the three tables as SQL to
Backblaze B2) and keep a redacted text until they expire after 30 days.

## Development

```
npm run dev         # local Worker on http://localhost:8787 (reads .dev.vars)
npm test            # the tests, against a local D1, inside Cloudflare's runtime
npm run typecheck   # regenerates the runtime types, then tsc
```

GitHub Actions runs the typecheck and the tests on every push to `main` and
every pull request (`.github/workflows/test.yml`), with no secrets.
Dependabot opens weekly update PRs for the pinned dependencies and the
workflow's actions.

The tests come in three layers:
- **SQL:** the schema and triggers;
- **the bank's operations;**
- **whole requests the way Claude sends them,** including the full OAuth flow
  with a stand-in GitHub.

Where things live:
- [`docs/spec.md`](docs/spec.md): the design;
- [`docs/build-plan.md`](docs/build-plan.md): how it was built, phase by phase;
- [`docs/versions.md`](docs/versions.md): why each dependency is pinned where it is;
- `src/errors.ts`: every error and how it's answered;
- `src/bank/store.ts`: every SQL statement.
