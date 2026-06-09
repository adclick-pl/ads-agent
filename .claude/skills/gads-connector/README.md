# gads-connector

A Node.js connector that lets Claude Code and AI mini-agents read and manage
**Google Ads** accounts — for agencies (MCC) or in-house teams. It ships inside the
**Ads-Agent** skill package; dependencies are installed once at the package root.

It wraps the [`google-ads-api`](https://www.npmjs.com/package/google-ads-api) client
and exposes its capabilities through three interfaces:

| Interface | Command | Best for |
|---|---|---|
| **CLI** | `node scripts/cli.js --action=...` | Claude Code, manual terminal use |
| **MCP server** | `node scripts/mcp-server.js` | Native Claude Code tools (`gads_*`) |
| **Programmatic** | `import { ... } from './scripts/queries.js'` | Building other Node scripts |

## Quick start

```bash
# 1. install dependencies ONCE at the package root (the Ads-Agent/ folder that
#    has package.json). node_modules lives there and serves every skill; Node
#    resolves packages up the tree, so this skill folder stays clean.
#       cd <package root> && npm install

# the remaining commands run from THIS skill folder:
node scripts/smoke-test.js                     # 2. offline self-test (no credentials)
cp references/.env.example .env                # 3. add credentials (see below), then edit .env
node scripts/auth.js                           # 4. (if needed) generate a refresh_token
node scripts/cli.js --action=test-connection   # 5. verify the live connection
```

## Where things live

The skill root is kept minimal (`SKILL.md`, `README.md`, `package.json`,
`.gitignore`). Everything else is under two folders:

```
scripts/      all the Node code (CLI, MCP server, queries, mutations, auth, helpers)
references/   GAQL cookbook + the template files you copy:
              ├── .env.example              → copy to .env (in the skill root)
              ├── google-ads.yaml.example   → copy to ~/google-ads.yaml
              ├── accounts.example.json     → copy to .claude/accounts.json (project root)
              ├── *.gaql                     ready-to-run example queries
              ├── gaql-best-practices.md     rules + lessons for writing GAQL
              └── README.md                  cookbook index
```

So when this README says "copy `.env.example`", the file is at
`references/.env.example`.

## Capabilities

**Read:** `test-connection`, `list-accounts`, `get-campaigns`, `get-keywords`,
`get-search-terms`, `get-pmax-search-terms` (Performance Max), `keyword-ideas`
(Keyword Planner research — search volume, competition, bid range), `get-budgets`,
`raw-query` (arbitrary GAQL).

**Write (mutations, all support `--dry-run`):** `update-status` (pause/enable a
campaign — never delete), `update-budget` (daily budget, with the 40% SafetyLimit),
`add-negatives` (campaign negative keywords), `add-negative-placements`
(account-level domain exclusions). The connector has **no delete action** — see the
[Safety model](#safety-model).

Run `node scripts/cli.js --help` for the full option list.

## Configuration

Credentials are read in this order:

1. A `.env` file **in this skill folder** (copy from `references/.env.example`).
2. The current working directory's `.env` (dotenv default).
3. `~/google-ads.yaml` in your home directory (copy from `references/google-ads.yaml.example`).

Required values: `GADS_DEVELOPER_TOKEN`, `GADS_CLIENT_ID`, `GADS_CLIENT_SECRET`,
`GADS_REFRESH_TOKEN`. For agency/MCC use also set `GADS_LOGIN_CUSTOMER_ID` (the
manager account). `GADS_DEFAULT_CUSTOMER_ID` is the account used when no
`--customer` is passed.

> **Never commit `.env` or `google-ads.yaml`** — both are in `.gitignore`.

### Account registry (optional)

To refer to accounts by name instead of a 10-digit ID, create
`.claude/accounts.json` in your project root (copy `references/accounts.example.json`). It
maps friendly names/aliases → account ID, and optionally carries each account's
`login_customer_id` (MCC) and `timezone`, which are then applied automatically:

```bash
node scripts/cli.js --list-accounts                      # list the registry
node scripts/cli.js --action=get-campaigns --account="Example Client One" --days=30
```

`accounts.json` holds client IDs, so it is **gitignored** — the shareable skill
ships only `references/accounts.example.json` with placeholder data. Without a registry,
everything still works with raw `--customer=<ID>`.

Fields (per account; keys starting with `_` are documentation and ignored):

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Human-readable name; shown in `--list-accounts` and usable as a selector. |
| `id` | yes | 10-digit Google Ads customer ID — the account that gets queried/changed. |
| `login_customer_id` | for MCC | The manager (MCC) account this one sits under. Prevents `PERMISSION_DENIED` on child accounts. Omit for standalone accounts. |
| `currency` | no | Currency code (USD/EUR/PLN…). Informational only. |
| `timezone` | recommended | IANA timezone (e.g. `Europe/Warsaw`); makes `--days` ranges align with the account's local time. |
| `type` | no | Free-form tag for your own grouping. Not used by the connector. |
| `default` | no | Set `true` on **exactly one** account = the one used when you run a command with no `--account`/`--customer`. |
| `aliases` | no | Extra short names you can pass to `--account`. |

### Output: inline vs CSV (row-count aware)

Read actions support three output modes:

- **`--auto` (recommended)** — returns rows inline as JSON when the result is
  small (≤ 500 rows by default), and writes a CSV only when it's large — then
  stdout returns `{output, rowCount, columns, preview}`. This keeps big pulls out
  of the AI's context window without you having to predict the size. Tune the
  cut-off with `--max-inline-rows=N`; set the large-result destination with
  `--output=path.csv` (otherwise a temp file is used).
- `--json` — force inline JSON regardless of size.
- `--output=path.csv` — force writing to CSV (returns the summary, no rows inline).

```bash
node scripts/cli.js --action=get-search-terms --customer=1234567890 --days=90 --auto
# small result → JSON inline; large result → CSV path + 10-row preview
```

## Setup Google Ads API (getting the credentials)

1. **Google Cloud project** — create one at [console.cloud.google.com](https://console.cloud.google.com), then enable the **Google Ads API**.
2. **OAuth client** — *APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app*. Copy the `client_id` and `client_secret`.
3. **Developer token** — in your Google Ads **MCC** account: *Tools → API Center*. Apply for a token (test tokens work immediately on test accounts; production access needs Google approval, usually 1–2 days).
4. **Refresh token** — put `client_id` + `client_secret` in `.env`, then run `node scripts/auth.js`. It opens a browser, you authorize the Google account that has access to the ads accounts, and it prints (and offers to save) the `refresh_token`.
5. **Customer IDs** — your 10-digit account numbers (dashes optional, stripped automatically).

## MCP server

To register the connector as persistent Claude Code tools, add this to `~/.claude.json`
under `mcpServers` (use the absolute path on your machine):

```json
{
  "mcpServers": {
    "gads-connector": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/.claude/skills/gads-connector/scripts/mcp-server.js"],
      "env": {
        "GADS_DEVELOPER_TOKEN": "...",
        "GADS_CLIENT_ID": "...",
        "GADS_CLIENT_SECRET": "...",
        "GADS_REFRESH_TOKEN": "...",
        "GADS_LOGIN_CUSTOMER_ID": "1234567890"
      }
    }
  }
}
```

Exposed tools: `gads_list_accounts`, `gads_get_campaigns`, `gads_get_keywords`,
`gads_get_search_terms`, `gads_keyword_ideas`, `gads_get_budgets`,
`gads_execute_query`, `gads_update_campaign_status`, `gads_update_budget`,
`gads_add_negative_keywords`, `gads_add_negative_placements`.

## Safety model

The connector is built so an AI agent can touch a live Google Ads account
**without** being able to do real damage. The safeguards, in plain terms:

1. **Dry-run before every change.** Every mutation supports `--dry-run` (CLI) /
   `dryRun: true` (MCP) and returns the *simulated* result without touching the
   account. The skill instructs the agent to **always dry-run, show you the result,
   and wait for your confirmation** before committing.
2. **Budget guardrail (SafetyLimits).** `update-budget` reads the current budget
   and **blocks any change larger than 40%** (up or down). If it can't read the
   current amount to verify the scale, it blocks too (fail-safe). The only way past
   it is a deliberate `--force` — so a typo like `1500` instead of `150` is stopped,
   not executed.
3. **No deletion, ever.** The connector **cannot delete** campaigns, ad groups,
   keywords or anything else — there is no delete action, `REMOVED` status is
   rejected, and there is no override. Deletion in Google Ads is permanent; the
   connector only offers reversible actions (pause instead of delete). A true
   deletion must be done by hand in the Google Ads UI.
4. **Pause, don't destroy.** Turning a campaign off uses `PAUSED` — fully
   reversible — never removal.
5. **Account confirmation.** Before any change the agent confirms *which* account
   (`--customer`) is being modified.
6. **Standard currency, never micros.** Budgets and costs are entered in normal
   units (e.g. `150.00`); the connector handles the micros conversion internally,
   removing a whole class of off-by-a-million mistakes.
7. **Read-only stays read-only.** `raw-query` runs GAQL, which cannot mutate — any
   custom query an agent writes is inherently safe.
8. **Your data stays local.** Credentials live in `.env` / `~/google-ads.yaml` on
   your machine (both gitignored) — not in the cloud, not on anyone else's server.
9. **Offline self-test.** `smoke-test.js` validates the connector's logic (incl. the
   safety checks) without credentials or any API call.

> Marketing note: this list is the source of truth for "why it's safe" messaging
> (landing pages, PDF, posts). Keep it in sync when safeguards change.

## Troubleshooting

| Error | Cause / fix |
|---|---|
| `invalid_grant` | Refresh token expired or revoked → re-run `node scripts/auth.js`. |
| `PERMISSION_DENIED` | Missing/incorrect `GADS_LOGIN_CUSTOMER_ID` for an MCC child account, or the OAuth user lacks access. |
| `DEVELOPER_TOKEN_NOT_APPROVED` | Token still pending Google approval, or used against a non-test account before approval. |
| `Missing required ... configuration` | `.env` not filled in / not found — check it's in this folder. |
| Module import errors | Run `npm install` at the package root (`Ads-Agent/`). |

## License

Not yet decided — to be set at publication. Until then this is private and ships
without a `LICENSE` file. Independent of and not affiliated with any third-party
"brain" template or community.
