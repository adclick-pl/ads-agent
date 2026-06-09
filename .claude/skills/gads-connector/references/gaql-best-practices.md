# GAQL best practices

One place for the rules and lessons that keep our Google Ads queries working.
When you hit a GAQL error and figure out the cause, **add a short entry here** so
we don't trip over it again.

How to add a lesson: append a bullet under the right section in the form
`**Symptom / error** → the rule to follow`. Keep it one or two lines, generic
(no client IDs/names).

---

## Dates

- **Valid `DURING` macros** (use these, nothing else): `TODAY`, `YESTERDAY`,
  `LAST_7_DAYS`, `LAST_14_DAYS`, `LAST_30_DAYS`, `LAST_BUSINESS_WEEK`,
  `THIS_WEEK_SUN_TODAY`, `THIS_WEEK_MON_TODAY`, `LAST_WEEK_SUN_SAT`,
  `LAST_WEEK_MON_SUN`, `THIS_MONTH`, `LAST_MONTH`. Anything like `LAST_90_DAYS`
  or `LAST_60_DAYS` is **invalid** → use an explicit `BETWEEN` range instead
  (or pass `--days=N`, which the connector turns into a `BETWEEN`).
- **Date format** is `'YYYY-MM-DD'` in single quotes: `segments.date BETWEEN '2026-01-01' AND '2026-01-31'`.
- Dates are evaluated in the **account's timezone**, not the operator's machine.
  The connector's `--days` already computes the range in the account timezone.

## Query shape

- **No `SELECT *`** — GAQL requires every field to be listed explicitly.
- **Adding a segment changes the rows.** `segments.date`, `segments.device`, etc.
  split metrics into one row per segment value (and force a date filter). Only
  segment when you actually need the breakdown, or totals will look "duplicated".
- A query returns **one resource per `FROM`**. You can't pull, say, keyword and
  placement data in one query — run separate queries against `keyword_view` and
  `detail_placement_view`.
- Use `LIMIT` for exploration; for full pulls use `--output=file.csv` so big
  result sets don't flood the context window.

## Metrics & values

- **Money is in micros.** `metrics.cost_micros`, `campaign_budget.amount_micros`,
  `metrics.conversions_value` (value is not micros) — the connector auto-converts
  `*_micros` to standard currency in its output, so read `metrics.cost`, not micros.
- `metrics.conversions` counts by **event time**; `metrics.conversions_by_conversion_date`
  attributes to the **conversion date** — use the latter for period-over-period
  trends so late conversions land in the right bucket.

## Keyword Planner (not GAQL)

- **Keyword research / search-volume ideas are NOT available via GAQL.** There is no
  `keyword_view` query that returns Planner ideas or monthly search volumes for
  *new* keywords. Use the connector action `keyword-ideas`
  (`KeywordPlanIdeaService.generateKeywordIdeas`) instead — separate API service,
  same auth. `get-keywords` only reports the performance of keywords **already** on
  the account (`keyword_view`), not research.

## Accounts / MCC

- **Querying the manager (MCC) account directly for metrics usually returns nothing
  useful** — metrics live on the child accounts. Query each child with its
  `--customer=<ID>` and the MCC as `login_customer_id` (set automatically when the
  account comes from `accounts.json`).
- `PERMISSION_DENIED` on a child account → missing/incorrect `login_customer_id`
  (the MCC), or the OAuth user lacks access to that account.

## Filtering

- You can filter on metrics in `WHERE` (e.g. `metrics.cost_micros > 0`), but
  remember a date filter is still required for any query that returns metrics.
- Enum filters use bare values in quotes: `campaign.status = 'ENABLED'`,
  `campaign.status != 'REMOVED'`.

---

## Lessons learned (append below)

<!-- Add new entries here as we hit and solve real errors. Format:
- **<error or symptom>** → <the rule / what to do instead>  (date, optional)
-->

- **Performance Max search terms come back empty from `search_term_view`** → for
  PMax, raw search terms live in `campaign_search_term_view` (field
  `campaign_search_term_view.search_term`, NOT `segments.search_term`, which raises
  "incompatible segment", and not `keyword.info.text`). Avoid
  `campaign_search_term_insight` too — it only returns bucketed categories and is
  empty for fresh campaigns. (verified on the MWM meble account)
