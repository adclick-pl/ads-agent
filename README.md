# Ads-Agent

A Claude Code **skill package** for Google Ads. It bundles a low-level connector
(talk to the Google Ads API) with related skills (e.g. ad writing).

## Layout

```
Ads-Agent/                          ← package root (this folder)
├── package.json                    ← one manifest, deps for all skills
├── package-lock.json
├── node_modules/                   ← gitignored, created by `npm install`
├── CHANGELOG.md                    ← what landed and what it does (PL)
├── .gitignore
├── Klienci/                        ← per-client data (config.json, context, reports)
└── .claude/
    └── skills/
        ├── gads-connector/         ← Google Ads API connector (CLI + MCP)
        ├── ga4-connector/          ← Google Analytics 4 connector (CLI, read-only)
        ├── gsc-connector/          ← Google Search Console connector (CLI, read-only)
        ├── gads-reklamy/           ← Google Ads RSA ad writer (Polish, no setup)
        └── gads-wykluczenia-hasel/ ← negative keyword finder (report + copy-paste lists)
        #   …more skills added here over time
```

One project, one install: run `npm install` once at this root and every bundled
skill shares it — no per-skill `package.json` or `node_modules`.

## Getting started

**Guided install (recommended).** Install [Claude Code](https://claude.com/claude-code),
open an empty folder in it, and paste:

> First check whether git is installed and install it for me if it isn't (detect
> my system — macOS or Windows). Then clone
> https://github.com/adclick-pl/ads-agent into my current folder: if the folder is
> empty, run `git clone https://github.com/adclick-pl/ads-agent .` (with the dot);
> if it isn't empty, clone into an `ads-agent` subfolder. Then read ONBOARDING.md
> and walk me through the installation. Work autonomously and only involve me when
> necessary.

Claude reads [`ONBOARDING.md`](ONBOARDING.md) and walks you through everything
(Node, dependencies, Google Ads API, connection test) step by step — works on
macOS and Windows.

**Manual install.**

```bash
npm install               # once, from this folder

npm run connector:smoke   # offline self-test (no credentials)
npm run connector:auth    # generate a Google Ads refresh token
npm run connector:test    # verify the live API connection
```

Getting the Google Ads API credentials is covered step by step in
[`ONBOARDING.md`](ONBOARDING.md) (step 3). Each skill documents its own usage in
`.claude/skills/<skill>/SKILL.md`.

## Skills

| Skill | What it does |
|---|---|
| `gads-connector` | Connect to and manage Google Ads accounts (read + mutations) via CLI and MCP. Needs the Google Ads API credentials from [`ONBOARDING.md`](ONBOARDING.md). |
| `gads-reklamy` | Write effective Google Ads RSA ads in Polish via a guided 4-step process (data → company & competitor research → ad angles for approval → headlines/descriptions). Pure prompting — **no setup or credentials needed**, works the moment you open the folder in Claude Code. |
| `ga4-connector` | Read **Google Analytics 4**: reports (channels, campaigns, landing pages, products, monthly cohorts, realtime) and property configuration (data streams, key events, custom dimensions, attribution settings, Google Ads links). Read-only — the OAuth scope is `analytics.readonly`, so it can never change a client's property. **No npm dependencies**; reuses the Google Ads OAuth client, so setup is two APIs to enable plus one consent. Supports several Google logins side by side via token profiles. |
| `gsc-connector` | Read **Google Search Console**: search performance (clicks, impressions, CTR, position by query, page, country, device), submitted sitemaps and their errors, and URL Inspection — whether a URL is indexed, which canonical Google picked, when it was last crawled, and where it knows the URL from. Read-only — the OAuth scope is `webmasters.readonly`, so it can never touch a client's property. **No npm dependencies**; reuses the Google Ads OAuth client, so setup is one API to enable plus one consent. Knows that `sc-domain:` and URL-prefix properties are different objects, and says what your login actually has when Google answers 403. |
| `gads-wykluczenia-hasel` | Find **negative keywords**: an HTML report, per campaign, splitting wasteful search terms into "certain — exclude" and "check by hand", each with 30-day and 12-month numbers plus a plain-language reason, and copy-paste-ready lists. Combines four signals (30-day spend, a full year without conversions, keyword-match distance, and an AI relevance verdict that knows your offer). Read-only — it never changes the account. Needs `gads-connector` configured. |

*(More skills will be added to `.claude/skills/` over time. What each release
brought, in Polish: [`CHANGELOG.md`](CHANGELOG.md).)*

## Notes

- Credentials and the account registry are **gitignored** (`.env`,
  `google-ads.yaml`, `accounts.json`). Only `*.example` templates are shipped.
- **Where keys live:** the Google Ads connector reads its credentials from
  `~/google-ads.yaml` or a skill-local `.env`. For keys shared across skills, the
  **canonical place is a single `.env` in this package root** (next to
  `package.json`) — it is loaded automatically and gitignored. Create it only when
  a skill actually needs a key.

## Disclaimer

This software is provided **"as is", without warranty of any kind**. You are
responsible for how you use it — including compliance with the
[Google Ads Terms of Service](https://support.google.com/adspolicy), the Google
Ads API policies, data-protection law (e.g. GDPR/RODO), and any agreements with
your own clients. Always review changes (use `--dry-run`) before applying them to
a live account. The authors are not liable for any damages arising from use of
this template.

## License

Free to use and modify, including commercially — run it on your own and your
clients' Google Ads accounts. The only thing you may not do is use it to build
or sell a product that competes with it. Full terms:
[PolyForm Shield 1.0.0](LICENSE).
