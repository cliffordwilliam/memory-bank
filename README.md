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

Claude's built-in memories don't cross over: claude.ai (web and phone) keeps
one, Claude Code keeps another, and a new Claude Code session starts from
what its own memory happened to write down. This bank is one memory they all
share, so you can pick up a thought wherever you are.

On the way home, from your phone: "I want to grow herbs on the balcony this
spring, basil and mint, in a self-watering planter. Save it to the bank." At
your desk, in a fresh Claude Code session: "Check the bank: what was my
balcony idea?" Claude reads it back and you carry on from there, then save
the plan you made, and your phone has it next time.

What goes in stays as Claude wrote it. No model summarizes, merges or
rewrites your notes behind the scenes, and nothing is edited or deleted:
changes are new records on top of the old ones, so you can always see what
was said and when.

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
That's deliberate. Nothing in the bank can be deleted by Claude, and
everything in it reaches every Claude app you use, so what goes in should be
what you chose to put there. Something saved by mistake, like a password or a
private detail, stays and shows up elsewhere until you redact it by hand
([Admin](#admin-only-you-can-do-these)), and backups keep it until they
expire. Reading only when asked keeps your notes out of conversations they
don't belong in.

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

**Turn off the built-in memory, so it doesn't mix with the bank.** Claude
Code and claude.ai each have their own memory, written and rewritten by the
model behind the scenes, which is exactly what this bank exists to avoid. With
both on, Claude reads two memories that can disagree, saves things in one but
not the other, and you can't tell which answer came from where. Keep the bank
as the only memory:
- **Claude Code:** set `"autoMemoryEnabled": false` in `~/.claude/settings.json`.
- **claude.ai and the phone app:** under **Settings → Memory**, turn off
  **Generate memory from chats** (*Pause memory* keeps what's there, *Reset
  memory* deletes it for good) and **Search and reference chats**.

**Tell Claude Code to read the bank at the start of a session.** The apps
only use the bank when asked, so ask once, in `~/.claude/CLAUDE.md`, which
every Claude Code session reads. Mine says:

```markdown
# Memory

My memory lives in the Memory bank connector, shared with my other Claude
apps. Claude Code's built-in auto memory is turned off.

- At the start of a session, call list_topics, then recall my feedback and
  user topics and follow them. Recall a project or reference topic when the
  work touches it. This instruction is me asking you to read the bank.
- Save only when I ask. When you learn something worth keeping (a correction,
  a preference, a project's new state), suggest saving it in one line and wait
  for my yes.
- Never save secrets, tokens or keys.
- If the bank is unreachable, say so and carry on.
```

**A routine for Claude Code that works well with the bank.** Since the bank
carries what matters between sessions, old conversations aren't needed:
- Start with plain `claude`: a fresh context, and the bank is read first.
- Switching to something new? `/clear` gives a fresh context (fewer tokens,
  better focus) without leaving the terminal.
- `claude --continue` only to pick up an unfinished task after a restart, such
  as after an update or to load a newly added connector.
- Optionally, set `"cleanupPeriodDays": 1` in `~/.claude/settings.json`. Each
  `/clear` leaves the old conversation on disk; Claude Code deletes session
  data older than this many days when it starts (default 30, minimum 1), so
  `/resume` then only reaches back a day.

## Deploying your own

One person, one bank: the login lets in a single GitHub account, so everyone
who wants one deploys their own. You need a Cloudflare account (free), a
GitHub account and Node 22 or later, and a Claude plan that supports custom
connectors (check [Anthropic's help center](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)).

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
   Put both ids into `wrangler.jsonc`.
5. **Production settings**, entered as secrets (only the names are in `wrangler.jsonc`):
   ```
   npx wrangler secret put PUBLIC_URL             # https://memory-bank.<subdomain>.workers.dev
   npx wrangler secret put GITHUB_CLIENT_ID       # the prod app's
   npx wrangler secret put GITHUB_CLIENT_SECRET   # the prod app's
   npx wrangler secret put ALLOWED_GITHUB_ID      # your numeric GitHub id
   ```
   `wrangler secret bulk <file>` uploads a dotenv file in one go.
6. **Deploy:** `npm run deploy`. It creates the database tables (applying
   the migrations in `migrations/`, after asking you to confirm), then
   deploys the Worker, which refuses to go out while any of the four settings
   is missing. Check that
   `https://memory-bank.<subdomain>.workers.dev/.well-known/oauth-protected-resource/mcp`
   shows your address, then connect Claude as above.

**Every setting fails closed.** A missing secret, a non-numeric allowed id or
a malformed URL means nobody gets in: the bank answers `500 This memory bank
isn't configured yet.` and the Worker log names the problem.

## Updating

```
git pull
npm ci
npm run deploy
```

`npm run deploy` first applies any new database migrations, then deploys the
code that needs them; with nothing new it says `No migrations to apply!` and
deploys. Always deploy this way: a plain `wrangler deploy` skips the
migrations, and new code on an old database fails.

**Claude may keep seeing the old tools for a while.** After an update that
changes the tools (a new field, a reworded description), claude.ai can keep
showing Claude the old definitions for hours or longer. It caches each
connector's tool list on its own servers, and restarting Claude or
reconnecting the connector doesn't reliably refresh it. Nothing on your side
can force it; changes here are kept compatible with the old definitions, so
the bank keeps working in the meantime.

## Your data

**Where it lives.** Your records are in your own Cloudflare D1 database and
nowhere else; the bank's only outbound calls are to GitHub during login and
to fetch a connecting app's public metadata. What Claude reads from the bank
becomes part of that conversation, like anything else you tell Claude.

**What protects it.** Cloudflare encrypts D1 on disk and in transit
([AES-256 and TLS, with keys Cloudflare manages](https://developers.cloudflare.com/d1/reference/data-security/)),
but the bank adds no encryption of its own: anyone who can sign in to your
Cloudflare account can read every record. Encrypting inside the bank wouldn't
change that. The Worker has to read the text to search it and hand it to
Claude, so its key would sit in the same Cloudflare account as the data, in
reach of the very person it would be meant to stop. So the bank is as private
as your accounts: use a strong password and two-factor login on Cloudflare,
on GitHub (it's the bank's login), and wherever your backups go.

**Backups are up to you.** D1's Time Travel can restore the database to any
moment in the last 7 days (on the free plan), but that's all the bank keeps on
its own. One way to do more, and the way mine works: a nightly GitHub Action
in a separate, private repo exports the three tables of bank data, with a
Cloudflare API token as a secret:

```
npx wrangler d1 export memory-bank --remote --no-schema \
  --table types --table names --table records --output backup.sql
```

and uploads the file to a private storage bucket that keeps 30 days. To restore
into a freshly migrated database, turn the export's `types` inserts into
upserts first, since the migrations already insert the default types.

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
edit, as a safety net, and backups keep it until they expire (see
[Your data](#your-data)).

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

Every test starts from a freshly migrated, empty database (`test/apply-migrations.ts`), so no test depends on another.

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
