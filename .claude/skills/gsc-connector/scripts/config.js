/**
 * Configuration for the Search Console connector — zero npm dependencies.
 *
 * Deliberately reuses the OAuth client of the Google Ads connector: in practice
 * all three connectors live in the same Google Cloud project, so the user only
 * has to enable one extra API instead of registering another client and
 * redirect URI.
 *
 * Credential lookup, first hit wins:
 *   client id/secret : GSC_CLIENT_ID/GSC_CLIENT_SECRET -> GADS_CLIENT_ID/GADS_CLIENT_SECRET -> ~/google-ads.yaml
 *   refresh token    : GSC_REFRESH_TOKEN -> token file (GSC_TOKEN_PATH -> ~/.ads-agent/gsc-token.json)
 *
 * The refresh token is NEVER shared with Google Ads or GA4: its scope is
 * webmasters.readonly and reusing another connector's token fails with a scope
 * error.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(__dirname, '..');
// scripts/ -> gsc-connector/ -> skills/ -> .claude/ -> <package root>
export const PACKAGE_ROOT = path.resolve(SKILL_ROOT, '..', '..', '..');

export const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
// Same callback path as the Ads and GA4 connectors — one registered redirect URI
// serves all three.
export const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

// ---------------------------------------------------------------------------
// .env — a minimal parser, so the connector stays dependency-free
// ---------------------------------------------------------------------------
function parseEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Strip matching quotes; an unquoted value keeps everything before a ` #` comment.
    if (/^"(.*)"$/s.test(value) || /^'(.*)'$/s.test(value)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

let envCache = null;

/** Merged environment: real env wins, then skill .env, package .env, cwd .env. */
export function env() {
  if (envCache) return envCache;
  const files = [
    path.join(SKILL_ROOT, '.env'),
    path.join(PACKAGE_ROOT, '.env'),
    path.join(process.cwd(), '.env'),
  ];
  const merged = {};
  for (const f of files) {
    for (const [k, v] of Object.entries(parseEnvFile(f))) {
      if (merged[k] === undefined) merged[k] = v;
    }
  }
  envCache = new Proxy(
    {},
    {
      get: (_t, key) =>
        process.env[key] !== undefined && process.env[key] !== ''
          ? process.env[key]
          : merged[key],
    }
  );
  return envCache;
}

// ---------------------------------------------------------------------------
// ~/google-ads.yaml — read the two scalars we need without a YAML parser
// ---------------------------------------------------------------------------
function readGoogleAdsYaml() {
  const file = path.join(os.homedir(), 'google-ads.yaml');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const pick = (key) => {
    const m = raw.match(new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'#\\r\\n]+)["']?`, 'm'));
    return m ? m[1].trim() : undefined;
  };
  const clientId = pick('client_id');
  const clientSecret = pick('client_secret');
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, source: file };
}

/** @returns {{clientId: string, clientSecret: string, source: string}} */
export function oauthClient() {
  const e = env();
  if (e.GSC_CLIENT_ID && e.GSC_CLIENT_SECRET) {
    return { clientId: e.GSC_CLIENT_ID, clientSecret: e.GSC_CLIENT_SECRET, source: 'GSC_CLIENT_ID (.env)' };
  }
  if (e.GADS_CLIENT_ID && e.GADS_CLIENT_SECRET) {
    return { clientId: e.GADS_CLIENT_ID, clientSecret: e.GADS_CLIENT_SECRET, source: 'GADS_CLIENT_ID (.env, wspólny projekt GCP)' };
  }
  const yaml = readGoogleAdsYaml();
  if (yaml) return { ...yaml, source: `${yaml.source} (wspólny projekt GCP)` };

  throw new Error(
    'Brak client_id/client_secret OAuth.\n' +
      'Konektor szuka po kolei:\n' +
      '  1. GSC_CLIENT_ID + GSC_CLIENT_SECRET (.env)\n' +
      '  2. GADS_CLIENT_ID + GADS_CLIENT_SECRET (.env) — ten sam projekt GCP co Google Ads\n' +
      '  3. ~/google-ads.yaml\n' +
      'Jeśli masz już działający konektor Google Ads, nie musisz nic zakładać — wystarczy\n' +
      'włączyć w tym samym projekcie GCP „Google Search Console API”.'
  );
}

// ---------------------------------------------------------------------------
// Token profiles
//
// One Google login rarely sees every client's property — in Search Console even
// less often than in GA4, because access is granted per property by whoever owns
// the site. A profile is a named token file, so several logins coexist instead
// of overwriting each other. No profile = the default token, unchanged.
// ---------------------------------------------------------------------------
export const TOKEN_DIR = path.join(os.homedir(), '.ads-agent');

/** Profile names are used in filenames — keep them boring. */
export function assertProfileName(profile) {
  if (profile === undefined || profile === null || profile === '') return undefined;
  const p = String(profile).trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(p)) {
    throw new Error(
      `Niedozwolona nazwa profilu „${p}”. Dozwolone: litery, cyfry, kropka, myślnik, podkreślenie.`
    );
  }
  return p;
}

export function tokenPath(profile) {
  const name = assertProfileName(profile);
  if (!name) {
    const e = env();
    if (e.GSC_TOKEN_PATH) return e.GSC_TOKEN_PATH;
    return path.join(TOKEN_DIR, 'gsc-token.json');
  }
  return path.join(TOKEN_DIR, `gsc-token-${name}.json`);
}

/** Every authorized profile on this machine. The default one is named "(domyślny)". */
export function listProfiles() {
  const out = [];
  const dflt = tokenPath();
  if (fs.existsSync(dflt)) out.push({ profile: null, label: '(domyślny)', file: dflt });
  let entries = [];
  try {
    entries = fs.readdirSync(TOKEN_DIR);
  } catch {
    return out;
  }
  for (const f of entries.sort()) {
    const m = f.match(/^gsc-token-(.+)\.json$/);
    if (m) out.push({ profile: m[1], label: m[1], file: path.join(TOKEN_DIR, f) });
  }
  return out;
}

export function readToken(profile) {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(profile), 'utf8'));
  } catch {
    return null;
  }
}

export function writeToken(token, profile) {
  const p = tokenPath(profile);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(token, null, 2), { mode: 0o600 });
  return p;
}

/**
 * Refresh token for a profile. GSC_REFRESH_TOKEN in .env applies to the default
 * profile only — a named profile always comes from its own file.
 */
export function refreshToken(profile) {
  if (!assertProfileName(profile)) {
    const e = env();
    if (e.GSC_REFRESH_TOKEN) return e.GSC_REFRESH_TOKEN;
  }
  return readToken(profile)?.refresh_token || null;
}

// ---------------------------------------------------------------------------
// Site identifiers
//
// Search Console knows two kinds of property and they are NOT interchangeable:
//   sc-domain:example.com     domain property (every subdomain, http + https)
//   https://example.com/      URL-prefix property — the string must match EXACTLY,
//                             trailing slash included
//
// Asking for a form the account doesn't own returns 403, which reads like a
// permission problem and isn't. Normalising here (and listing near matches on a
// 403, see api.js) turns that dead end into an answerable question.
// ---------------------------------------------------------------------------
export function isSiteLike(raw) {
  const s = String(raw ?? '').trim();
  return /^sc-domain:/i.test(s) || /^https?:\/\//i.test(s);
}

/** Canonical form of a site string. URL-prefix properties always end with "/". */
export function normalizeSite(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^sc-domain:/i.test(s)) {
    return 'sc-domain:' + s.slice('sc-domain:'.length).trim().toLowerCase().replace(/\/+$/, '');
  }
  if (/^https?:\/\//i.test(s)) {
    let url;
    try {
      url = new URL(s);
    } catch {
      return s;
    }
    // Host is case-insensitive, the path is not — lowercase only the origin.
    const origin = `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
    const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return `${origin}${pathname}`;
  }
  return s;
}

/** A bare domain like "example.com" — no scheme, no path, but a dot in it. */
export function looksLikeBareDomain(raw) {
  const s = String(raw ?? '').trim();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s);
}

// ---------------------------------------------------------------------------
// Account registry — the SAME .claude/accounts.json the Ads and GA4 connectors
// resolve against, so one selector ("--site=zielonyogrod") points at the Ads
// account, its GA4 property and its Search Console property alike. The GSC
// identifier lives in the `gscSite` field.
//
// The reader is duplicated here rather than imported from another connector on
// purpose: each skill has to stay shippable on its own. The FORMAT is shared —
// documented once in gads-connector/references/accounts.example.json.
// ---------------------------------------------------------------------------

/** Walk up from cwd looking for `.claude/accounts.json`. */
function findAccountsFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.claude', 'accounts.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

export function accountsFile() {
  const explicit = env().GSC_ACCOUNTS_PATH;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  return findAccountsFile();
}

/** Registry entries, normalised. Empty array when no registry exists. */
export function loadAccounts() {
  const file = accountsFile();
  if (!file) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Nie mogę sparsować ${file}: ${e.message}`);
  }
  // Keys starting with "_" are documentation, not accounts.
  const entries = Array.isArray(raw)
    ? raw
    : Object.entries(raw)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, v]) => ({ key, ...v }));

  return entries.map((a) => ({
    key: a.key,
    name: a.name,
    aliases: Array.isArray(a.aliases) ? a.aliases : [],
    adsId: a.id ? String(a.id).replace(/-/g, '').trim() : undefined,
    gscSite: a.gscSite ? normalizeSite(a.gscSite) : undefined,
    // Which Google login sees this property. Absent = the default token.
    gscProfile: a.gscProfile ? String(a.gscProfile).trim() : undefined,
    default: !!a.default,
    _file: file,
  }));
}

/** Match a selector against key / name / aliases. Case-insensitive. */
function findAccount(selector) {
  const accounts = loadAccounts();
  if (!accounts.length) return null;
  if (!selector) return accounts.find((a) => a.default) || null;

  const sel = String(selector).trim().toLowerCase();
  return (
    accounts.find((a) => a.key?.toLowerCase() === sel) ||
    accounts.find((a) => a.name?.toLowerCase() === sel) ||
    accounts.find((a) => a.aliases.some((al) => String(al).toLowerCase() === sel)) ||
    null
  );
}

/**
 * Resolve a selector to the property AND the login that can see it.
 *
 * Accepts "sc-domain:example.com", "https://example.com/", an account selector
 * from .claude/accounts.json (key, name or alias), or a bare domain — the last
 * one is a GUESS at a domain property and is flagged as such, because Search
 * Console answers the wrong form with 403 rather than "no such property".
 *
 * @returns {{site: string, profile: string|undefined, assumed?: string}}
 */
export function resolveTarget(input, profile) {
  const explicit = assertProfileName(profile);
  const raw = String(input ?? '').trim();

  // 1. A literal property string always wins.
  if (isSiteLike(raw)) {
    const site = normalizeSite(raw);
    const known = loadAccounts().find((a) => a.gscSite === site);
    return { site, profile: explicit ?? known?.gscProfile };
  }

  // 2. A selector from the registry.
  if (raw) {
    const hit = findAccount(raw);
    if (hit?.gscSite) {
      return { site: hit.gscSite, profile: explicit ?? hit.gscProfile };
    }
    if (hit) {
      throw new Error(
        `Konto „${hit.name || hit.key}” jest w rejestrze, ale nie ma pola gscSite.\n` +
          `Zobacz, co widzi Twój login: node scripts/cli.js --action=sites\n` +
          `Potem dopisz je do ${hit._file}:  "gscSite": "sc-domain:example.com"`
      );
    }

    // 3. A bare domain — assume a domain property, but say so out loud.
    if (looksLikeBareDomain(raw)) {
      return {
        site: `sc-domain:${raw.toLowerCase()}`,
        profile: explicit,
        assumed:
          `Założyłem property domenową sc-domain:${raw.toLowerCase()}. ` +
          'Jeśli w GSC masz prefiks URL, podaj go wprost (np. --site="https://' + raw.toLowerCase() + '/").',
      };
    }

    const known = loadAccounts();
    throw new Error(
      `Nie rozpoznaję property „${raw}”.` +
        (known.length
          ? `\nKonta w rejestrze: ${known.map((a) => a.key || a.name).join(', ')}` +
            `\nZ przypisaną property GSC: ${known.filter((a) => a.gscSite).map((a) => a.key || a.name).join(', ') || '(żadne)'}`
          : '\nRejestr .claude/accounts.json nie istnieje.') +
        '\nPodaj property wprost („sc-domain:example.com” albo „https://example.com/”)\n' +
        'albo uruchom `--action=sites`, żeby zobaczyć, co widzi Twój login.'
    );
  }

  // 4. Nothing given — fall back to .env, then to the registry default.
  const fromEnv = env().GSC_DEFAULT_SITE;
  if (fromEnv) return { site: normalizeSite(fromEnv), profile: explicit };
  const fallback = findAccount(null);
  if (fallback?.gscSite) {
    return { site: fallback.gscSite, profile: explicit ?? fallback.gscProfile };
  }

  throw new Error(
    'Nie podano property. Użyj --site=<property albo alias konta>, ustaw GSC_DEFAULT_SITE\n' +
      'w .env, albo dopisz "gscSite" do konta oznaczonego jako default w .claude/accounts.json.\n' +
      'Nie wiesz, co masz? `--action=sites` wypisze wszystko, co widzi autoryzowane konto.'
  );
}

/** Site only — kept for callers that don't care which login is used. */
export function resolveSite(input, profile) {
  return resolveTarget(input, profile).site;
}

// ---------------------------------------------------------------------------
// Writing to the registry
//
// The ONLY write this connector performs, and never on its own initiative: the
// CLI proposes, the user confirms, `--action=remember` writes. The key becomes
// the shared selector for ALL THREE connectors, so it is a naming decision, not
// a derivable value — and most accounts here already exist with an Ads id, so
// blind appending would create a second entry for a client already listed.
// ---------------------------------------------------------------------------

/**
 * Where a write should land: an explicit GSC_ACCOUNTS_PATH (even if the file does
 * not exist yet — that is where the user asked for it), else the registry found
 * by walking up, else a fresh one at <package>/.claude/accounts.json.
 */
export function registryTarget() {
  const explicit = env().GSC_ACCOUNTS_PATH;
  if (explicit) return explicit;
  return accountsFile() || path.join(PACKAGE_ROOT, '.claude', 'accounts.json');
}

/** The bare hostname behind a property string, for naming and matching. */
export function siteHost(site) {
  const s = String(site || '').trim();
  if (/^sc-domain:/i.test(s)) return s.slice('sc-domain:'.length).toLowerCase().replace(/\/+$/, '');
  try {
    return new URL(s).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return s.toLowerCase();
  }
}

/** Turn a property into a plausible registry key: "sc-domain:zielony-ogrod.pl" -> "zielonyogrod". */
export function proposeAlias(site) {
  const host = siteHost(site)
    .replace(/^www\./, '')
    .replace(/\.(pl|com|eu|net|es|info|org|shop|co\.uk|example)$/i, '');
  const alias = host
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]/g, '');
  return alias || null;
}

/** An existing entry that probably means the same client, or null. */
export function likelyExisting(alias) {
  if (!alias) return null;
  const norm = (s) =>
    String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]/g, '');
  const a = norm(alias);
  if (a.length < 4) return null;
  return (
    loadAccounts().find((x) => {
      const kandydaci = [x.key, x.name, ...(x.aliases || [])].map(norm).filter(Boolean);
      return kandydaci.some((k) => k === a || (k.length >= 4 && (k.startsWith(a) || a.startsWith(k))));
    }) || null
  );
}

/**
 * Add or complete one registry entry.
 * @returns {{action: 'uzupelnione'|'dopisane'|'bez-zmian', key: string, file: string, note?: string}}
 */
export function rememberSite({ site, alias, name, profile }) {
  const value = normalizeSite(site);
  if (!isSiteLike(value)) {
    throw new Error(
      `„${site}” nie wygląda na property Search Console.\n` +
        'Oczekiwany format: „sc-domain:example.com” albo „https://example.com/”.'
    );
  }
  const key = String(alias || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(key)) {
    throw new Error(`Alias „${key}” jest niepoprawny. Dozwolone: litery, cyfry, kropka, myślnik, podkreślenie.`);
  }

  const file = registryTarget();
  let rejestr = {};
  if (fs.existsSync(file)) {
    try {
      rejestr = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Rejestr ${file} nie jest poprawnym JSON-em (${e.message}). Napraw go ręcznie.`);
    }
  } else {
    rejestr = {
      _README:
        'Rejestr kont — wspólny dla gads-connector (pole "id"), ga4-connector ' +
        '(pola "ga4PropertyId" i "ga4Profile") oraz gsc-connector (pola "gscSite" ' +
        'i "gscProfile"). Klucz wpisu jest selektorem dla wszystkich: --account=<klucz> ' +
        'w Adsach, --property=<klucz> w GA4, --site=<klucz> w Search Console. Klucze ' +
        'z podkreśleniem na początku są ignorowane. Opis pól: ' +
        '.claude/skills/gads-connector/references/accounts.example.json',
    };
  }

  // Already known under some key? Never create a second entry for one property.
  const istniejacyKlucz = Object.keys(rejestr).find(
    (k) => !k.startsWith('_') && rejestr[k]?.gscSite && normalizeSite(rejestr[k].gscSite) === value
  );
  if (istniejacyKlucz) {
    return {
      action: 'bez-zmian',
      key: istniejacyKlucz,
      file,
      note: `Property ${value} jest już w rejestrze pod kluczem „${istniejacyKlucz}”.`,
    };
  }

  const wpisIstnieje = Object.prototype.hasOwnProperty.call(rejestr, key) && !key.startsWith('_');
  if (wpisIstnieje) {
    rejestr[key] = { ...rejestr[key], gscSite: value };
    if (profile) rejestr[key].gscProfile = profile;
  } else {
    rejestr[key] = { name: name || key, gscSite: value };
    if (profile) rejestr[key].gscProfile = profile;
  }

  // Atomic: a half-written registry would break the other two connectors too.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rejestr, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);

  return { action: wpisIstnieje ? 'uzupelnione' : 'dopisane', key, file };
}
