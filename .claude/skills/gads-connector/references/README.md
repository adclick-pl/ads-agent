# references/

This folder holds two kinds of files:

- **Config templates** you copy when setting up: `.env.example` → `.env` (skill
  root), `google-ads.yaml.example` → `~/google-ads.yaml`, `accounts.example.json`
  → `.claude/accounts.json` (project root).
- **The GAQL cookbook** (below): ready-to-run queries + `gaql-best-practices.md`.

# GAQL cookbook

Ready-to-run [GAQL](https://developers.google.com/google-ads/api/docs/query/overview)
queries for the most common review tasks. They mirror the kinds of pulls used in a
weekly review, a monthly review, and a single-account review — kept generic (no
account IDs, placeholder values only).

## How to run one

Read the `.gaql` file, then pass its contents to the connector's `raw-query`:

```bash
node scripts/cli.js --action=raw-query --customer=1234567890 \
  --query="$(cat references/list-campaigns.gaql)" --auto
# or write a large result straight to CSV:
node scripts/cli.js --action=raw-query --customer=1234567890 \
  --query="$(cat references/list-search-terms.gaql)" --output=/tmp/terms.csv
```

Notes:
- **Dates:** files use `segments.date DURING LAST_30_DAYS`, which Google evaluates
  in the account timezone. Passing `--days=N` rewrites that to an explicit range,
  computed in the account's timezone (from `accounts.json`, else fetched from the
  account via the API, else the machine's local time).
- **Cost:** `metrics.cost_micros` is auto-converted to standard currency (`metrics.cost`)
  in the output — you don't deal with micros.
- **MCC queries** (`list-accounts.gaql`) run against the manager account.

## The queries

| File | What it returns |
|---|---|
| `list-accounts.gaql` | Client (non-manager) accounts under the MCC |
| `list-campaigns.gaql` | Active campaigns with basic performance |
| `list-search-terms.gaql` | Search terms for **Search** campaigns |
| `pmax-search-terms.gaql` | Search terms for **Performance Max** campaigns (`campaign_search_term_view`) |
| `account-summary.gaql` | One summary row (totals) for the period |

These are starting points — copy a file, tweak the columns/filters, and run it.

Before writing GAQL from scratch, skim **`gaql-best-practices.md`** — our rules and
lessons-learned for avoiding common query errors (valid date macros, segmentation,
micros, MCC). Add to it whenever you hit and solve a new error.
