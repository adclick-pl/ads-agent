---
name: gads-connector
description: |
  Connect to and manage Google Ads accounts (agency/MCC or in-house) through a self-contained Node.js connector. Use when the user wants to query a Google Ads account (campaigns, keywords, search terms, budgets, raw GAQL), or mutate it (pause/enable campaigns, change daily budgets, add negative keywords or placement exclusions). Triggers: "gads-connector", "Google Ads connector", "połącz się z Google Ads", "pobierz kampanie z konta", "zmień budżet", "wstrzymaj kampanię", "dodaj negatywy", "raw GAQL", "test połączenia Google Ads".
---

# Google Ads Connector (gads-connector)

Self-contained connector that lets Claude Code (or any AI mini-agent) talk to the
Google Ads API. Written in Node.js, built on the
[`google-ads-api`](https://www.npmjs.com/package/google-ads-api) wrapper. Everything
the skill needs lives inside this folder — scripts, config templates, and an offline
test — so it is portable and testable.

**Skill folder:** `.claude/skills/gads-connector/`
All commands below are run **from inside that folder** unless noted.

## When to use this skill

- The user wants to **read** a Google Ads account: campaigns, keywords, search
  terms, placements, budgets, or an arbitrary GAQL query.
- The user wants to **mutate** an account: pause/enable a campaign, change a daily
  budget, add campaign negative keywords, or add account-level placement exclusions.
- Agency / MCC setups (parent → child accounts) and single in-house accounts both work.

Do **not** use this for writing ad copy (→ `gads-reklamy`), client-facing reports
(→ `raport-klienta` / `gads-raport`), or portfolio reviews (→ `przeglad-tygodniowy`).
This skill is the low-level *connection layer* those workflows can build on.

## First-time setup (once per machine)

1. **Install dependencies** (only the first time, or after `git pull`).
   Run `npm install` once at the **package root** (the `Ads-Agent/` folder that
   holds `package.json`). `node_modules` lives there and serves every skill —
   Node resolves packages up the directory tree, so this skill folder stays clean.
2. **Verify the wiring offline** — no credentials needed, proves the code runs.
   From this skill folder:
   ```bash
   node scripts/smoke-test.js
   ```
3. **Add credentials.** Copy `references/.env.example` → `.env` (in this skill
   folder) and fill in the five values.
   To obtain them, follow `README.md` → *Setup Google Ads API*. If you only have a
   `client_id` + `client_secret`, generate a refresh token interactively:
   ```bash
   node scripts/auth.js        # opens a browser, prints the refresh_token
   ```
   > Auth runs in the **foreground** and waits for the user to authorize in the
   > browser — never background it.
4. **Test the live connection:**
   ```bash
   node scripts/cli.js --action=test-connection
   ```

## How to operate (the agent's playbook)

The connector exposes the same capabilities through four interfaces. **For use
inside Claude Code, prefer the CLI** (`node scripts/cli.js ...`) — it is the only
interface that needs no extra process and returns clean JSON with `--json`.

### Choosing the account

Pass the target account with `--customer=<10-digit-ID>`. Optionally, users can
keep an account registry at `.claude/accounts.json` (project root, gitignored —
see `references/accounts.example.json`), and then refer to accounts by **name or alias**:

```bash
node scripts/cli.js --list-accounts            # show the registry (names → IDs)
node scripts/cli.js --action=get-campaigns --account="Example Client One" --days=30
```

When an account is resolved from the registry, its `login_customer_id` (MCC) and
`timezone` are applied automatically. With no registry, just use raw IDs.

**Finding an account when you don't know its ID — use `list-accessible`.**
`list-accounts` only lists children of *one* MCC, so it misses accounts that were
shared with you **directly** (e.g. a client added you as a user on their own
account, outside our MCC). `list-accessible` enumerates **everything you can
reach** — directly-shared accounts *and* every child under each MCC you manage —
and for each row shows the `login_customer_id` you must pass to query it:

```bash
node scripts/cli.js --action=list-accessible --auto
```

- `Login (MCC) = — bezpośrednio —` → query the account directly (`--customer=<ID>`,
  no `--login-customer-id`). This is the case for accounts shared straight to you.
- `Login (MCC) = <id>` → pass that MCC: `--customer=<ID> --login-customer-id=<id>`.

Reach for this first whenever the user names an account that isn't in the registry
or isn't found under the MCC.

### Read actions (safe, no confirmation needed)

**For the authoritative, always-current list of actions, run `node scripts/cli.js --help`.**
It is generated from the code, so it never drifts — do not maintain a copy of the
action catalog here (e.g. there are separate `get-search-terms` for Search and
`get-pmax-search-terms` for Performance Max; `--help` always shows what exists).

Common shape — pick the action from `--help`, then add `--customer` and flags:

```bash
node scripts/cli.js --help
node scripts/cli.js --action=<action> --customer=1234567890 --days=30 --auto
```

Output modes:
- **`--auto` — recommended default for agent use.** The connector returns the
  rows inline as JSON when the result is small (≤ 500 rows by default), and only
  writes a CSV file when it's large — then stdout returns
  `{output, rowCount, columns, preview}` (a 10-row preview), so big pulls never
  flood the context window. Tune the cut-off with `--max-inline-rows=N`. If you
  also pass `--output=path.csv`, that's where a large result is written; otherwise
  it goes to a temp file.
- `--json` — **force** inline JSON regardless of size. Use only when you know the
  result is small, or you deliberately want every row in context.
- `--output=path.csv` — **force** writing to a CSV file (returns the summary, no
  rows inline).
- neither — a human-readable table (for a person, not for parsing).

Prefer `--auto` for reads: it gives you the data directly when small and protects
context automatically when large — no need to guess the size up front.

Keyword research: `keyword-ideas` is **not GAQL** — it calls the Keyword Planner
service (`generateKeywordIdeas`). Pass `--keywords="a,b"` and/or `--url=...` as
seeds; it returns avg monthly searches, competition and the top-of-page bid range,
sorted by volume. Defaults target Poland (`--geo=2616`) + Polish (`--language=1030`);
override for other markets. Use it as the base layer to expand a keyword set — a
script can build clustering/intent/scoring on top of these rows.

Dates: `--days=N` computes the range in the account's timezone — taken from
`accounts.json` if set, otherwise fetched from the account via the API, otherwise
the machine's local time. In a raw GAQL query you can also use Google's own macros
(`segments.date DURING LAST_30_DAYS`), which Google evaluates in the account timezone.

### Write actions (mutations) — ALWAYS dry-run first

Every mutation supports `--dry-run`, which simulates the change and returns what
*would* happen without touching the account.

**Mandatory protocol:**
1. Run the mutation with `--dry-run` and **show the user the simulated result**.
2. Wait for explicit user confirmation.
3. Re-run the exact same command **without** `--dry-run` to commit.

```bash
# Pause / enable a campaign
node scripts/cli.js --action=update-status --customer=1234567890 --campaign=987654321 --status=PAUSED --dry-run

# Change a daily budget (standard currency, not micros)
node scripts/cli.js --action=update-budget --customer=1234567890 --budget-id=111222333 --amount=150.00 --dry-run

# Add campaign negative keywords (comma-separated; default broad match)
node scripts/cli.js --action=add-negatives --customer=1234567890 --campaign=987654321 --keywords="darmowy,tani,za darmo" --dry-run

# Add account-level placement exclusions (display/PMax spam domains)
node scripts/cli.js --action=add-negative-placements --customer=1234567890 --domains="spam.example,clickfarm.example" --dry-run
```

**SafetyLimits (budget).** `update-budget` reads the current budget and **blocks
any change larger than 40%** (up or down), and also blocks the change if it can't
read the current amount to verify the scale. The block is reported in the
`safety` field of the result. `--dry-run` shows the verdict (`safety.safe`,
`safety.pctChange`) without committing. To push a deliberate large change through,
re-run with `--force` — but only after confirming the new amount with the user.

## Hard rules for the agent

1. **NEVER delete / remove Google Ads resources — in any form.** The connector does
   not delete campaigns, ad groups, keywords, or anything else, and you must not
   work around this by writing ad-hoc code against `google-ads-api` (e.g.
   `.remove()`, status `REMOVED`, or a `mutateResources` delete op). If the user
   asks to delete something, **show this warning and stop**: removal in Google Ads
   is permanent and irreversible — instead pause it (`--status=PAUSED`), or, if a
   true deletion is really needed, do it by hand in the Google Ads UI. Pausing is
   reversible; deleting is not.
2. **Safety first.** Never commit a mutation without first showing a `--dry-run`
   result and getting explicit user confirmation.
3. **Standard currency, never micros.** Budgets and costs are always in standard
   units (e.g. `150.00`). The connector converts to/from micros internally — do not
   ask the user for, or print, micro-amounts.
4. **MCC integrity.** For agency accounts, `GADS_LOGIN_CUSTOMER_ID` (the MCC) must
   be set so child-account queries don't fail with `PERMISSION_DENIED`. The target
   child account is passed via `--customer`.
5. **Confirm the account.** Before any mutation, confirm with the user which
   `--customer` (10-digit ID) is being changed. Run `list-accounts` if unsure.
6. **Customer IDs** are 10 digits; dashes are stripped automatically.

## GAQL cookbook

`references/*.gaql` holds ready-to-run queries for common review tasks (daily/
weekly/monthly account KPIs, campaign overview, search terms, MCC child accounts,
label lookup). When the user asks for one of these, read the matching file and run
it via `raw-query` rather than writing GAQL from scratch:

```bash
node scripts/cli.js --action=raw-query --customer=1234567890 --query="$(cat references/campaigns-overview.gaql)" --json
```

See `references/README.md` for the full list. Before writing any GAQL by hand,
check `references/gaql-best-practices.md` (rules + lessons-learned to avoid errors).

## Other interfaces (optional)

- **MCP server** — exposes the same actions as Claude Code tools (`gads_*`).
  Start manually with `node scripts/mcp-server.js`, or register persistently in `~/.claude.json`
  (see `README.md` → *MCP server*).
- **Programmatic** — `import { getCampaigns } from './scripts/queries.js'` etc.

See `README.md` for full setup, troubleshooting, and the GAQL field reference.
