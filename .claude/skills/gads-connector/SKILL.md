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

### Write actions (mutations) — simulation is the default

**Writes are opt-in.** Every mutating action runs as a simulation and returns what
*would* happen; it touches the account only when you pass **`--commit`**. Reads are
unaffected. This is enforced in the CLI, not by convention: the read-only actions are
a closed set and everything else — including any action added later — needs
`--commit`. A forgotten flag can therefore only ever produce a dry-run. A simulated
run ends with a `🔒 SYMULACJA` line, so a dry-run can't be mistaken for a done deal.

**Mandatory protocol:**
1. Run the mutation (no flag needed — it simulates) and **show the user the result**.
2. Wait for explicit user confirmation.
3. Re-run the exact same command **with `--commit`** to write.

`--dry-run` still works and forces a simulation even alongside `--commit`; it is now
redundant on its own, kept so older commands keep behaving safely.

```bash
# Pause / enable a campaign
node scripts/cli.js --action=update-status --customer=1234567890 --campaign=987654321 --status=PAUSED

# Pause / enable ADS by bare ad ID (the id shown in the UI), single, list or CSV
node scripts/cli.js --action=update-ad-status --customer=1234567890 --ad=670502653180,670502653181 --status=PAUSED

# Pause / enable AD GROUPS by id
node scripts/cli.js --action=update-ad-group-status --customer=1234567890 --ad-group=112447007410 --status=ENABLED

# Change a daily budget (standard currency, not micros)
node scripts/cli.js --action=update-budget --customer=1234567890 --budget-id=111222333 --amount=150.00

# Add campaign negative keywords (comma-separated; default broad match)
node scripts/cli.js --action=add-negatives --customer=1234567890 --campaign=987654321 --keywords="darmowy,tani,za darmo"

# Add account-level placement exclusions (display/PMax spam domains)
node scripts/cli.js --action=add-negative-placements --customer=1234567890 --domains="spam.example,clickfarm.example"

# Change an ad's Final URL — single ad (works for RSA; legacy text ads are immutable)
node scripts/cli.js --action=update-ad-url --customer=1234567890 --ad=670502653180 --url="https://example.pl/kategoria/" --domain=example.pl

# Change a keyword's Final URL override — single keyword (--criterion=adGroupId~criterionId)
node scripts/cli.js --action=update-keyword-url --customer=1234567890 --criterion=112447007410~495997481489 --url="https://example.pl/kategoria/" --domain=example.pl

# Bulk Final URL swap (ads or keywords) from a CSV map — columns: id,final_url[,label]
#   id = bare ad ID (ads) or adGroupId~criterionId (keywords), or a full resource_name
node scripts/cli.js --action=update-ad-url --customer=1234567890 --input=urls.csv --domain=example.pl

# Repoint a sitelink's Final URL (data-preserving: clone asset + relink + pause old link)
#   --sitelink is the FULL link resource name; batch via --input (col: link_resource_name,final_url)
node scripts/cli.js --action=update-sitelink-url --customer=1234567890 --sitelink="customers/1234567890/campaignAssets/111~222~SITELINK" --url="https://example.pl/kategoria/" --domain=example.pl
```

**Final URL updates (`update-ad-url`, `update-keyword-url`).** Built for site
migrations / domain restructures where many ads or keyword-level Final URLs point
at old (redirecting) paths. Both take either a single item (`--ad` / `--criterion`
+ `--url`) or a batch `--input=map.csv`. Guardrails: every URL is validated as a
well-formed http(s) URL and — with `--domain=<host>` — must stay on that host
(off-domain or malformed URLs block the **whole** batch, nothing half-applies).
`--dry-run` reads the current URLs and returns a per-item `from → to` diff (plus
`found`/`changed` flags) so you can eyeball it before committing.

**Sitelink URL swaps (`update-sitelink-url`).** Sitelink assets are (largely)
immutable, so this can't edit the URL in place — instead it does the
data-preserving swap in ONE atomic `mutateResources`: it **clones** the asset
(same link text + descriptions) with the new Final URL, **links** the clone at the
same level/parent (`ENABLED`), and sets the **old link to `PAUSED`** (kept, not
removed, so its history survives). Input is the FULL link resource name
(`--sitelink=` or CSV column `link_resource_name`) — a bare ID won't do, because
the same asset can be linked at campaign / ad-group / account level. New assets are
de-duplicated by (source asset + new URL): one clone is made even when a sitelink
is linked in many places, then linked N times. Same URL validation + `--domain`
lock as above. Caveat: a separate **mobile** Final URL is NOT carried to the clone
(the dry-run `plan.warning` flags it) — the desktop URL is used for both.

**New sitelink sets (`add-sitelinks`, `pause-sitelinks`).** `add-sitelinks` builds
a fresh sitelink set from `--input=map.csv` (cols `level`=customer|campaign,
`campaign_id`, `link_text`, `description1`, `description2`, `final_url`): creates the
assets and links them at account or campaign level in one atomic call. It is
**idempotent** — first reads the sitelinks that already exist (`ENABLED` or
`PAUSED`) and skips any with the same parent + text + URL, so re-running the same
CSV adds nothing (the dry-run reports `skipped` vs `linksToAdd`). Texts are checked
against Google's limits (`link_text` 25, descriptions 35, descriptions as a pair).
`pause-sitelinks` retires links (status `PAUSED`, kept not removed) — the data-
preserving way to swap a whole set: `add-sitelinks` the new one, `pause-sitelinks`
the old resource names.

**Trial campaigns block `update-status` / `update-budget`.** Google rejects status,
budget and date changes on DRAFT and EXPERIMENT campaigns
(`CANNOT_MODIFY_FOR_TRIAL_CAMPAIGN`). `update-status` reads `campaign.experiment_type`
up front and refuses in the **dry-run**, so you find out before the commit rather
than after. Such a campaign can only be retired in the UI (Kampanie → Eksperymenty);
an old finished experiment can sit `ENABLED` with zero traffic for years.

**Status changes below campaign level (`update-ad-status`, `update-ad-group-status`,
`update-keyword-status`).**
`update-status` only moves campaigns; these two move ads and ad groups. Both take a
single id, a comma-separated list, or `--input=map.csv` (`ad_id,status` /
`ad_group_id,status`) — a per-row `status` column overrides `--status`. Both read the
current state first, so `--dry-run` returns a real `from → to` diff with a `changed`
flag, and rows already in the target status are reported as `unchanged` instead of
being rewritten. All-or-nothing: an id that can't be resolved (typo, or REMOVED)
refuses the whole batch. `REMOVED` is rejected by the no-delete policy, same as
everywhere else.

`update-keyword-status` takes `adGroupId~criterionId` (the same composite key as
`update-keyword-url`) — a bare criterion id is refused, because criterion ids are
only unique within an ad group. Note that pausing one variant of a same-meaning pair
(broad `netia internet` while broad `internet netia` stays on) usually just moves the
traffic to the sibling; check for reversed-word-order twins before concluding you
stopped the spend.

Three jobs these exist for:
- **Freeing an RSA slot.** Google caps an ad group at **3 ENABLED responsive search
  ads**; a 4th makes `add-ads` fail with `ENABLED_RESPONSIVE_SEARCH_CREATIVES_PER_AD_GROUP`,
  and since the batch is atomic it takes every other ad in the same file down with it.
  Pause an old creative first, then `add-ads`.
- **Reviving a paused ad group.** `create-ad-groups` is idempotent and *skips* a group
  whose name already exists (matching is case-insensitive — `Orange` finds `ORANGE`),
  so it can never bring one back. `update-ad-group-status` is how you do that.

**Building out a campaign (`create-ad-groups`, `add-keywords`).** The pair that
turns a keyword research file into a live structure. `create-ad-groups` takes
`--input=map.csv` (cols `campaign_id`, `ad_group_name`, optional `status`) and
creates `SEARCH_STANDARD` ad groups in an existing campaign. `add-keywords` takes
`--input=map.csv` (cols `keyword`, `match_type`, optional `final_url`, plus either
`ad_group_id` **or** `campaign_id` + `ad_group_name`) and adds POSITIVE keywords —
note `add-negatives` is a different action for exclusions.

```bash
node scripts/cli.js --action=create-ad-groups --customer=1234567890 --input=groups.csv
node scripts/cli.js --action=add-keywords    --customer=1234567890 --input=keywords.csv
```

Both are **idempotent**: they read what already exists (ad group names in the
campaign / keyword text + match type in the ad group, `ENABLED` or `PAUSED`) and
skip it, so re-running the same CSV adds nothing. Keyword text is checked against
Google's limits (80 chars, 10 words, forbidden characters) and rejects `[brackets]`
or `"quotes"` left in the text — match type belongs in `match_type`, not in the
keyword. No CPC bids are set: the campaigns this targets run Smart Bidding, where
an ad-group bid is ignored.

**Order matters.** Addressing ad groups by name is what lets you write the keyword
file before the groups exist — but it means `add-keywords --dry-run` **fails until
the groups are created** (it refuses the whole batch and lists the unresolved
names). So the flow is: dry-run groups → confirm → create → dry-run keywords →
confirm → add. Keyword *text* validation runs before the group lookup, so that
first failure still tells you whether the keyword file itself is clean.

Two caveats: `parseCsv` reads **commas** (a `;`-separated export from Excel PL will
not parse), and batches over 1000 operations are chunked — atomic within a chunk,
so the result reports `chunks` to make a partial apply visible.

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
2. **Safety first.** Never pass `--commit` without first showing the simulated
   result and getting explicit user confirmation. The CLI makes simulation the
   default so a slip can't write, but `--commit` is yours to type deliberately —
   never as a reflex, and never on the same turn the user first sees the plan.
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
