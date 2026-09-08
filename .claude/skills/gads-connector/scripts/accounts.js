import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Account registry — resolves friendly account names/aliases to Google Ads IDs,
 * so users can say "campaigns for Example Client" instead of a 10-digit ID.
 *
 * Looks for `.claude/accounts.json` by walking up from the current working
 * directory (or an explicit start dir). The file is user-provided and
 * gitignored (it holds client IDs). See `references/accounts.example.json` for the format.
 * The file is an object keyed by a slug, each entry shaped like:
 *   {
 *     "name": "Example Client One",
 *     "id": "1234567890",
 *     "login_customer_id": "1112223334",   // MCC for this account (optional)
 *     "currency": "USD",
 *     "timezone": "Europe/London",
 *     "type": "client",
 *     "default": true,                       // used when no account is given
 *     "aliases": ["client-one", "example-one"]
 *   }
 */

const cleanId = (v) => (v ? String(v).replace(/-/g, '').trim() : undefined);

/** Walk up the directory tree to find `.claude/accounts.json`. */
export function findAccountsFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, '.claude', 'accounts.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/** Load and normalise the registry into an array of account records. */
export function loadAccounts(startDir = process.cwd()) {
  const file = findAccountsFile(startDir);
  if (!file) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${file}: ${e.message}`);
  }
  // Keys starting with "_" are documentation (e.g. _README, _fields), not accounts.
  const entries = Array.isArray(raw)
    ? raw
    : Object.entries(raw)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, v]) => ({ key, ...v }));
  return entries.map((a) => ({
    key: a.key,
    name: a.name,
    id: cleanId(a.id),
    login_customer_id: cleanId(a.login_customer_id),
    currency: a.currency,
    timezone: a.timezone,
    type: a.type,
    default: !!a.default,
    aliases: Array.isArray(a.aliases) ? a.aliases : [],
    _file: file,
  }));
}

/**
 * Resolve a selector (account name, alias, slug key, or raw 10-digit ID) to a
 * registry record. Returns null if not found. Case-insensitive for text.
 * Pass `selector` undefined/empty to get the account flagged `default: true`.
 */
export function resolveAccount(selector, startDir = process.cwd()) {
  const accounts = loadAccounts(startDir);
  if (accounts.length === 0) return null;

  if (!selector) {
    const defaults = accounts.filter((a) => a.default);
    if (defaults.length > 1) {
      throw new Error(
        `${defaults.length} kont ma "default": true (${defaults.map((a) => a.key).join(', ')}).\n` +
        `Rejestr: ${defaults[0]._file}\n` +
        'Zostaw flagę na jednym koncie albo podawaj --account jawnie.'
      );
    }
    return defaults[0] || null;
  }

  const sel = String(selector).trim();
  const selId = cleanId(sel);
  const selLower = sel.toLowerCase();

  // Tiers are tried in order of precision, but WITHIN a tier every match is
  // collected. A selector matching two entries used to resolve to whichever came
  // first in file order — silently, and in a tool that pauses keywords and moves
  // budgets. A wrong account that looks right is the worst failure this module
  // can produce, so ambiguity stops the run instead of picking for the operator.
  const tiers = [
    accounts.filter((a) => a.id && a.id === selId),
    accounts.filter((a) => a.key && a.key.toLowerCase() === selLower),
    accounts.filter((a) => a.name && a.name.toLowerCase() === selLower),
    accounts.filter((a) => a.aliases.some((al) => String(al).toLowerCase() === selLower)),
  ];

  for (const matches of tiers) {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const where = matches.map((a) => `${a.key} (${a.id || 'bez id'})`).join(', ');
      throw new Error(
        `Selektor „${sel}" wskazuje ${matches.length} kont: ${where}.\n` +
        `Rejestr: ${matches[0]._file}\n` +
        'Usuń powtórzenie albo wskaż konto 10-cyfrowym ID.'
      );
    }
  }
  return null;
}

/**
 * Structural collisions in the registry, as human-readable lines. Empty array
 * means the registry is unambiguous.
 *
 * `resolveAccount` only complains about the selector it was given, so a broken
 * entry stays invisible until somebody happens to name it. This reports the
 * whole file at once — used when writing to the registry and worth calling from
 * diagnostics.
 */
export function registryConflicts(startDir = process.cwd()) {
  const accounts = loadAccounts(startDir);
  const problems = [];
  const seen = (get, label) => {
    const map = new Map();
    for (const a of accounts) {
      for (const raw of [].concat(get(a)).filter(Boolean)) {
        const v = String(raw).toLowerCase();
        if (!map.has(v)) map.set(v, []);
        map.get(v).push(a.key);
      }
    }
    for (const [v, keys] of map) {
      if (keys.length > 1) problems.push(`${label} „${v}" powtarza się we wpisach: ${keys.join(', ')}`);
    }
  };

  seen((a) => a.key, 'Klucz');
  seen((a) => a.id, 'ID konta');
  seen((a) => a.aliases, 'Alias');

  // An alias shadowing another entry's key or name never resolves to its own
  // entry: `resolveAccount` matches keys before aliases, so the other account wins.
  const keys = new Map(accounts.map((a) => [String(a.key).toLowerCase(), a.key]));
  const names = new Map(accounts.filter((a) => a.name).map((a) => [String(a.name).toLowerCase(), a.key]));
  for (const a of accounts) {
    for (const al of a.aliases) {
      const v = String(al).toLowerCase();
      if (keys.has(v) && keys.get(v) !== a.key) {
        problems.push(`Alias „${al}" wpisu ${a.key} jest kluczem wpisu ${keys.get(v)} — nigdy nie wskaże ${a.key}`);
      } else if (names.has(v) && names.get(v) !== a.key) {
        problems.push(`Alias „${al}" wpisu ${a.key} jest nazwą wpisu ${names.get(v)} — nigdy nie wskaże ${a.key}`);
      }
    }
  }

  const defaults = accounts.filter((a) => a.default).map((a) => a.key);
  if (defaults.length > 1) {
    problems.push(`Kilka kont ma "default": true (${defaults.join(', ')}) — wywołanie bez --account jest losowe`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Account name -> registry key / client folder name
//
// ONE implementation, because two separate things read it and they must agree:
// the key an account is stored under here, and the name of that client's folder
// under `Klienci/`. When they disagree, adding a registry entry RENAMES the
// folder and every report written before it is orphaned in the old one.
//
// Convention: JOINED lowercase ASCII, no separators ("zielonyogrod"). It matches
// the keys `ga4-connector` and `gsc-connector` already propose, so all three
// agree without importing each other — those two are deliberately self-contained
// and reach the shared OAuth client through `~/google-ads.yaml`, not through code.
//
// Noise is stripped BEFORE joining, because joining is what makes it unreadable:
// "Nowak i Syn sp. z o.o." would otherwise read `nowakisynspzoo`. Keep NOISE
// SHORT and extend it only on evidence from a real account name — an over-eager
// pattern silently renames a client's folder, which is the failure this module
// exists to prevent.
// ---------------------------------------------------------------------------

const PL_CHARS = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

/**
 * Boilerplate that carries no identity. Applied AFTER lowercasing and the Polish
 * transliteration, so every pattern here is plain ASCII.
 */
const NOISE = [
  /\bsp[\s.]*z[\s.]*o[\s.]*o\.?/g,                    // sp. z o.o. / sp z oo / spzoo
  /\bspolka\b/g,
  /\bs\.\s*a\./g,                                     // S.A. — dots required, bare "sa" is a word
  /\bs\.\s*c\./g,                                     // S.C.
  /\b[pf]\.?\s*h\.?\s*u\.?\b/g,                       // PHU / FHU / P.H.U.
  /\b(ltd|llc|inc|gmbh|bv)\b/g,                       // common international forms
  /\.(pl|com|eu|net|org|es|info|shop|store|de|uk|co)\b/g, // domain endings ("com" before "co")
  /\b(www|mcc)\b/g,
  /\bga\s?4\b/g,                                      // GA4 tag carried over from property names
  /\bgoogle\s+ads\b/g,                                // boilerplate in Ads account names
];

/** Raw slug: lowercase ASCII, noise removed, separators dropped, capped at 40 chars. */
export function slugifyName(name) {
  if (!name) return '';
  let s = String(name)
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => PL_CHARS[c] || c);
  for (const re of NOISE) s = s.replace(re, ' ');
  return s.replace(/[^a-z0-9]+/g, '').slice(0, 40);
}

/**
 * The registry key / client folder name for an account, or '' when the name
 * yields nothing a human could use.
 *
 * Digits are refused on purpose. `Klienci/1234567890` tells an operator nothing,
 * and a slug equal to `blockId` means the name lookup fell back to the customer
 * id. Callers must treat '' as "ask the user", never as "use the number".
 */
export function accountSlug(name, blockId) {
  const s = slugifyName(name);
  if (!s) return '';
  if (/^\d+$/.test(s)) return '';
  if (blockId && s === String(blockId)) return '';
  return s;
}

// ---------------------------------------------------------------------------
// Bootstrapping the registry
//
// Every connector in this package READS `.claude/accounts.json`, and until now
// nothing created it for Google Ads. With dozens of accounts under an MCC the
// only options were typing it by hand or writing a throwaway generator, and a
// throwaway generator invents its own key rules with no validation.
//
// What this deliberately does NOT do:
//   * no `aliases` — an alias is pure convenience, and a selector nobody checked
//     is a wrong-account risk in a tool that changes budgets. Keys are enough.
//   * no `default` — with dozens of accounts, guessing which one is "the" one
//     is worse than requiring `--account`.
//   * no overwrite — an id already in the registry is left exactly as it is, so
//     re-running is safe. Same rule as the sitelink writer: declarative, not
//     imperative.
//   * no naming under ambiguity — two accounts slugging to the same key are both
//     skipped and reported, never suffixed into `client2`.
// ---------------------------------------------------------------------------

/** Where a registry write lands: the one found by walking up, else the package root. */
export function registryPath(startDir = process.cwd()) {
  const found = findAccountsFile(startDir);
  if (found) return found;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, '..', '..', '..', '..');
  return path.join(packageRoot, '.claude', 'accounts.json');
}

const ENABLED = new Set(['ENABLED', 2, '2']);

/**
 * Turn rows from `listAccessibleAccounts()` into registry entries to ADD.
 * Pure: no API, no filesystem, so the whole policy is testable offline.
 *
 * @param {Array} rows     accounts as returned by listAccessibleAccounts()
 * @param {Object} existing already-parsed registry (may be `{}`)
 * @returns {{add: Object, skipped: Array<{id: string, name: string, reason: string}>}}
 */
export function buildRegistryDraft(rows = [], existing = {}) {
  const add = {};
  const skipped = [];
  const skip = (r, reason) => skipped.push({ id: r.id, name: r.descriptive_name || '', reason });

  const knownIds = new Map();
  const knownKeys = new Set();
  for (const [k, v] of Object.entries(existing || {})) {
    if (k.startsWith('_')) continue;
    knownKeys.add(k.toLowerCase());
    const id = cleanId(v?.id);
    if (id) knownIds.set(id, k);
  }

  // Pass 1: decide a key for every candidate, so collisions inside this batch
  // can be seen before anything is written.
  const candidates = [];
  for (const r of rows) {
    if (r.manager) { skip(r, 'konto managerskie (MCC) — nie jest kontem klienta'); continue; }
    if (r.status != null && !ENABLED.has(r.status)) { skip(r, `status ${r.status}`); continue; }
    const id = cleanId(r.id);
    if (!id) { skip(r, 'brak ID konta'); continue; }
    if (knownIds.has(id)) { skip(r, `już w rejestrze pod kluczem „${knownIds.get(id)}"`); continue; }

    const key = accountSlug(r.descriptive_name, id);
    if (!key) { skip(r, 'z nazwy konta nie da się zbudować czytelnego klucza — nazwij je ręcznie'); continue; }
    if (knownKeys.has(key)) { skip(r, `klucz „${key}" jest już zajęty w rejestrze — nazwij to konto ręcznie`); continue; }
    candidates.push({ row: r, id, key });
  }

  const perKey = new Map();
  for (const c of candidates) perKey.set(c.key, [...(perKey.get(c.key) || []), c]);

  for (const [key, group] of perKey) {
    if (group.length > 1) {
      // Suffixing would produce a selector that means nothing to an operator.
      for (const c of group) {
        skip(c.row, `nazwa daje ten sam klucz „${key}" co konto ${group.filter((g) => g !== c).map((g) => g.id).join(', ')} — nazwij je ręcznie`);
      }
      continue;
    }
    const { row, id } = group[0];
    const entry = { name: row.descriptive_name || key, id };
    if (row.login_customer_id) entry.login_customer_id = cleanId(row.login_customer_id);
    if (row.currency_code) entry.currency = row.currency_code;
    if (row.time_zone) entry.timezone = row.time_zone;
    add[key] = entry;
  }

  return { add, skipped };
}

const REGISTRY_README =
  'Rejestr kont — wspólny dla gads-connector (pole "id"), ga4-connector ' +
  '("ga4PropertyId") i gsc-connector ("gscSite"). Klucz wpisu jest selektorem dla ' +
  'wszystkich trzech: --account=<klucz> w Adsach, --property=<klucz> w GA4, ' +
  '--site=<klucz> w Search Console. Klucze pisane są małymi literami bez separatorów ' +
  '(np. "zielonyogrod") i są zarazem nazwą folderu klienta w Klienci/. Klucze ' +
  'zaczynające się od _ są ignorowane. Opis pól: ' +
  '.claude/skills/gads-connector/references/accounts.example.json';

/**
 * Merge new entries into the registry file and write it atomically.
 * Existing entries are never touched; a half-written file would break every
 * connector in the package, hence tmp + rename.
 */
export function writeRegistry(file, add) {
  let registry = {};
  if (fs.existsSync(file)) {
    try {
      registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Rejestr ${file} nie jest poprawnym JSON-em (${e.message}). Napraw go ręcznie.`);
    }
  } else {
    registry = { _README: REGISTRY_README };
  }

  for (const [key, entry] of Object.entries(add)) {
    if (Object.prototype.hasOwnProperty.call(registry, key)) continue; // never overwrite
    registry[key] = entry;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}
