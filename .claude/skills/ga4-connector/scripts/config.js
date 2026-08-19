/**
 * Configuration for the GA4 connector — zero npm dependencies.
 *
 * Deliberately reuses the OAuth client of the Google Ads connector: in practice
 * both live in the same Google Cloud project, so the user only has to enable two
 * extra APIs instead of registering a second client and redirect URI.
 *
 * Credential lookup, first hit wins:
 *   client id/secret : GA4_CLIENT_ID/GA4_CLIENT_SECRET -> GADS_CLIENT_ID/GADS_CLIENT_SECRET -> ~/google-ads.yaml
 *   refresh token    : GA4_REFRESH_TOKEN -> token file (GA4_TOKEN_PATH -> ~/.ads-agent/ga4-token.json)
 *
 * The refresh token is NEVER shared with Google Ads: its scope is
 * analytics.readonly and reusing the Ads token would fail with a scope error.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(__dirname, '..');
// scripts/ -> ga4-connector/ -> skills/ -> .claude/ -> <package root>
export const PACKAGE_ROOT = path.resolve(SKILL_ROOT, '..', '..', '..');

export const SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];
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
  if (e.GA4_CLIENT_ID && e.GA4_CLIENT_SECRET) {
    return { clientId: e.GA4_CLIENT_ID, clientSecret: e.GA4_CLIENT_SECRET, source: 'GA4_CLIENT_ID (.env)' };
  }
  if (e.GADS_CLIENT_ID && e.GADS_CLIENT_SECRET) {
    return { clientId: e.GADS_CLIENT_ID, clientSecret: e.GADS_CLIENT_SECRET, source: 'GADS_CLIENT_ID (.env, wspólny projekt GCP)' };
  }
  const yaml = readGoogleAdsYaml();
  if (yaml) return { ...yaml, source: `${yaml.source} (wspólny projekt GCP)` };

  throw new Error(
    'Brak client_id/client_secret OAuth.\n' +
      'Konektor szuka po kolei:\n' +
      '  1. GA4_CLIENT_ID + GA4_CLIENT_SECRET (.env)\n' +
      '  2. GADS_CLIENT_ID + GADS_CLIENT_SECRET (.env) — ten sam projekt GCP co Google Ads\n' +
      '  3. ~/google-ads.yaml\n' +
      'Jeśli masz już działający konektor Google Ads, nie musisz nic zakładać — wystarczy\n' +
      'włączyć w tym samym projekcie GCP „Google Analytics Data API” i „Google Analytics Admin API”.'
  );
}

// ---------------------------------------------------------------------------
// Token profiles
//
// One Google login rarely sees every client's GA4 property: sometimes you can't
// be added as a user, sometimes the properties are simply split across your own
// accounts. A profile is a named token file, so several logins coexist instead
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
    if (e.GA4_TOKEN_PATH) return e.GA4_TOKEN_PATH;
    return path.join(TOKEN_DIR, 'ga4-token.json');
  }
  return path.join(TOKEN_DIR, `ga4-token-${name}.json`);
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
    const m = f.match(/^ga4-token-(.+)\.json$/);
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
 * Refresh token for a profile. GA4_REFRESH_TOKEN in .env applies to the default
 * profile only — a named profile always comes from its own file.
 */
export function refreshToken(profile) {
  if (!assertProfileName(profile)) {
    const e = env();
    if (e.GA4_REFRESH_TOKEN) return e.GA4_REFRESH_TOKEN;
  }
  return readToken(profile)?.refresh_token || null;
}

// ---------------------------------------------------------------------------
// Account registry — the SAME .claude/accounts.json the Ads connector resolves
// against, so one selector ("--property=zielonyogrod") points at both the Ads
// account and its GA4 property. The GA4 id lives in the `ga4PropertyId` field.
//
// The reader is duplicated here rather than imported from gads-connector on
// purpose: each skill has to stay shippable on its own. The FORMAT is shared —
// documented once in gads-connector/references/accounts.example.json.
// ---------------------------------------------------------------------------
const bareId = (v) => (v ? String(v).replace(/^properties\//, '').trim() : undefined);

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
  const explicit = env().GA4_ACCOUNTS_PATH;
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
    ga4PropertyId: bareId(a.ga4PropertyId),
    // Which Google login sees this property. Absent = the default token.
    ga4Profile: a.ga4Profile ? String(a.ga4Profile).trim() : undefined,
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
 * Accepts "123456789", "properties/123456789", or an account selector from
 * .claude/accounts.json (key, name or alias). An explicit `profile` always wins
 * over the registry's `ga4Profile` — that is the escape hatch when a property
 * moves between logins.
 *
 * @returns {{propertyId: string, profile: string|undefined}}
 */
export function resolveTarget(input, profile) {
  const explicit = assertProfileName(profile);
  const raw = String(input ?? '').trim();

  // 1. A literal id always wins.
  const direct = bareId(raw);
  if (direct && /^\d+$/.test(direct)) {
    // No registry entry to consult unless the id happens to be listed there.
    const known = loadAccounts().find((a) => a.ga4PropertyId === direct);
    return { propertyId: direct, profile: explicit ?? known?.ga4Profile };
  }

  // 2. A selector from the registry.
  if (raw) {
    const hit = findAccount(raw);
    if (hit?.ga4PropertyId) {
      return { propertyId: hit.ga4PropertyId, profile: explicit ?? hit.ga4Profile };
    }
    if (hit) {
      throw new Error(
        `Konto „${hit.name || hit.key}” jest w rejestrze, ale nie ma pola ga4PropertyId.\n` +
          `Znajdź ID: node scripts/cli.js --action=properties\n` +
          `Potem dopisz je do ${hit._file}:  "ga4PropertyId": "<numeryczne ID usługi>"`
      );
    }
    const known = loadAccounts();
    throw new Error(
      `Nie rozpoznaję property „${raw}”.` +
        (known.length
          ? `\nKonta w rejestrze: ${known.map((a) => a.key || a.name).join(', ')}` +
            `\nZ przypisaną usługą GA4: ${known.filter((a) => a.ga4PropertyId).map((a) => a.key || a.name).join(', ') || '(żadne)'}`
          : '\nRejestr .claude/accounts.json nie istnieje.') +
        '\nPodaj numeryczne ID albo uruchom `--action=properties`, żeby je znaleźć.'
    );
  }

  // 3. Nothing given — fall back to .env, then to the registry default.
  const fromEnv = bareId(env().GA4_DEFAULT_PROPERTY);
  if (fromEnv) return { propertyId: fromEnv, profile: explicit };
  const fallback = findAccount(null);
  if (fallback?.ga4PropertyId) {
    return { propertyId: fallback.ga4PropertyId, profile: explicit ?? fallback.ga4Profile };
  }

  throw new Error(
    'Nie podano property. Użyj --property=<ID albo alias konta>, ustaw GA4_DEFAULT_PROPERTY\n' +
      'w .env, albo dopisz "ga4PropertyId" do konta oznaczonego jako default w .claude/accounts.json.\n' +
      'Nie znasz ID? `--action=properties` wypisze wszystko, co widzi autoryzowane konto.'
  );
}

/** Property id only — kept for callers that don't care which login is used. */
export function resolveProperty(input, profile) {
  return resolveTarget(input, profile).propertyId;
}

// ---------------------------------------------------------------------------
// Writing to the registry
//
// The ONLY write this connector performs, and never on its own initiative: the
// CLI proposes, the user confirms, `--action=remember` writes. Two reasons for
// the ceremony. The key becomes the shared selector for BOTH connectors, so it
// is a naming decision, not a derivable value. And most accounts here already
// exist with an Ads id and no GA4 property — blind appending would create a
// second entry for a client that is already listed, and the registry would rot
// the more it was used.
// ---------------------------------------------------------------------------

/**
 * Where a write should land: an explicit GA4_ACCOUNTS_PATH (even if the file does
 * not exist yet — that is where the user asked for it), else the registry found
 * by walking up, else a fresh one at <package>/.claude/accounts.json.
 */
export function registryTarget() {
  const explicit = env().GA4_ACCOUNTS_PATH;
  if (explicit) return explicit;
  return accountsFile() || path.join(PACKAGE_ROOT, '.claude', 'accounts.json');
}

/** GA4 display names carry boilerplate; the registry wants the client, not the tag. */
export function cleanDisplayName(displayName) {
  const s = String(displayName || '')
    .replace(/[–—-]?\s*\bga[\s-]?4\b\s*[–—-]?/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s–—-]+|[\s–—-]+$/g, '')
    .trim();
  return s || null;
}

/** Turn a GA4 display name into a plausible key: "Zielony Ogród.pl – GA4" -> "zielonyogrod". */
export function proposeAlias(displayName) {
  const bez = String(displayName || '')
    .replace(/\bga[\s-]?4\b/gi, ' ')
    .replace(/\.(pl|com|eu|net|es|info|org)\b/gi, ' ')
    .replace(/\b(www|sklep|analytics|nowa strona|test)\b/gi, ' ');
  const alias = bez
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
export function rememberProperty({ propertyId, alias, name, profile }) {
  const id = bareId(propertyId);
  if (!id || !/^\d+$/.test(id)) throw new Error(`„${propertyId}” nie jest numerycznym ID usługi GA4.`);
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
        'Rejestr kont — wspólny dla gads-connector (pole "id") i ga4-connector ' +
        '(pola "ga4PropertyId" i "ga4Profile"). Klucz wpisu jest selektorem dla obu: ' +
        '--account=<klucz> w Adsach, --property=<klucz> w GA4. Klucze z podkreśleniem ' +
        'na początku są ignorowane. Opis pól: ' +
        '.claude/skills/gads-connector/references/accounts.example.json',
    };
  }

  // Already known under some key? Never create a second entry for one property.
  const istniejacyKlucz = Object.keys(rejestr).find(
    (k) => !k.startsWith('_') && bareId(rejestr[k]?.ga4PropertyId) === id
  );
  if (istniejacyKlucz) {
    return {
      action: 'bez-zmian',
      key: istniejacyKlucz,
      file,
      note: `Usługa ${id} jest już w rejestrze pod kluczem „${istniejacyKlucz}”.`,
    };
  }

  const wpisIstnieje = Object.prototype.hasOwnProperty.call(rejestr, key) && !key.startsWith('_');
  if (wpisIstnieje) {
    rejestr[key] = { ...rejestr[key], ga4PropertyId: id };
    if (profile) rejestr[key].ga4Profile = profile;
  } else {
    rejestr[key] = { name: name || key, ga4PropertyId: id };
    if (profile) rejestr[key].ga4Profile = profile;
  }

  // Atomic: a half-written registry would break the Ads connector too.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rejestr, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);

  return { action: wpisIstnieje ? 'uzupelnione' : 'dopisane', key, file };
}
