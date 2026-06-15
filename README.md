# Ads-Agent

A Claude Code **skill package** for Google Ads. It bundles a low-level connector
(talk to the Google Ads API) with related skills (e.g. ad writing).

## Layout

```
Ads-Agent/                       ← package root (this folder)
├── package.json                 ← one manifest, deps for all skills
├── package-lock.json
├── node_modules/                ← gitignored, created by `npm install`
├── .gitignore
└── .claude/
    └── skills/
        ├── gads-connector/      ← Google Ads API connector (CLI + MCP)
        └── gads-reklamy/        ← Google Ads RSA ad writer (Polish, no setup)
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

*(More skills will be added to `.claude/skills/` over time.)*

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
