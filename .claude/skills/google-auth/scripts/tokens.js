/**
 * Google OAuth token store — one refresh token per Google account, shared by
 * every connector in the package (Ads, GA4, Search Console, Merchant Center,
 * Tag Manager, Gmail, Calendar, Sheets). Zero npm dependencies, Node 18+.
 *
 * Why one token per ACCOUNT, not per service:
 *   - a file is named after the e-mail Google reports for the login (id_token),
 *     never after what the caller hoped to log in as — so authorizing a second
 *     account creates a second file instead of overwriting the first;
 *   - adding a service extends the same token (include_granted_scopes), so the
 *     user clicks once per account, not once per service.
 *
 * Layout (override the directory with ADS_AGENT_GOOGLE_DIR):
 *   ~/.ads-agent/google/<email>.json   refresh token + granted scopes + label
 *   ~/.ads-agent/google/_config.json   { "default": "<email>" }
 *   ~/.ads-agent/google/.cache/        short-lived access tokens
 *
 * Usage:
 *   import { getAccessToken } from '../../google-auth/scripts/tokens.js';
 *   const { accessToken, email } = await getAccessToken('ga4', account);
 * CommonJS (Node 22+): const tokens = require('<path>/tokens.js');
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> google-auth/ -> skills/ -> .claude/ -> <package root>
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const CLI = path.join(__dirname, 'cli.js');

const GA = 'https://www.googleapis.com/auth/';
export const SERVICES = {
  ads: { name: 'Google Ads', scopes: [`${GA}adwords`] },
  ga4: { name: 'Google Analytics 4', scopes: [`${GA}analytics.readonly`] },
  gsc: { name: 'Search Console', scopes: [`${GA}webmasters.readonly`] },
  gmc: { name: 'Merchant Center', scopes: [`${GA}content`] },
  gtm: {
    name: 'Tag Manager',
    scopes: [
      `${GA}tagmanager.readonly`,
      `${GA}tagmanager.edit.containers`,
      `${GA}tagmanager.edit.containerversions`,
      `${GA}tagmanager.publish`,
    ],
  },
  gmail: { name: 'Gmail', scopes: [`${GA}gmail.modify`] },
  calendar: { name: 'Kalendarz Google', scopes: [`${GA}calendar`] },
  sheets: { name: 'Arkusze Google', scopes: [`${GA}spreadsheets`] },
  docs: { name: 'Dokumenty Google', scopes: [`${GA}documents`] },
};
// Non-sensitive; lets us read WHO logged in from the id_token.
const IDENTITY_SCOPES = ['openid', 'email'];

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // NO_ACCOUNT | NO_SCOPE | AMBIGUOUS | INVALID_GRANT | CLIENT_MISMATCH | CONFIG
  }
}

// ---------------------------------------------------------------------------
// Environment: real env wins, then package-root .env, then cwd .env
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
    let v = m[2].trim();
    if (/^"(.*)"$/s.test(v) || /^'(.*)'$/s.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

let envMerged = null;
function env(key) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  if (!envMerged) {
    envMerged = {};
    for (const f of [path.join(PACKAGE_ROOT, '.env'), path.join(process.cwd(), '.env')]) {
      for (const [k, v] of Object.entries(parseEnvFile(f))) if (envMerged[k] === undefined) envMerged[k] = v;
    }
  }
  return envMerged[key];
}

export const REDIRECT_URI = () => env('GOOGLE_REDIRECT_URI') || 'http://localhost:3000/oauth2callback';
export const storeDir = () => env('ADS_AGENT_GOOGLE_DIR') || path.join(os.homedir(), '.ads-agent', 'google');
const configPath = () => path.join(storeDir(), '_config.json');
const cachePath = (email) => path.join(storeDir(), '.cache', `${email}.json`);
const tokenFile = (email) => path.join(storeDir(), `${email.toLowerCase()}.json`);
export const googleAdsYamlPath = () => env('GOOGLE_ADS_YAML') || path.join(os.homedir(), 'google-ads.yaml');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomic write, owner-only — a half-written token file would lock the user out. */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// OAuth client (one per installation)
// ---------------------------------------------------------------------------
function yamlScalar(raw, key) {
  const m = raw.match(new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'#\\r\\n]+)["']?`, 'm'));
  return m ? m[1].trim() : undefined;
}

/** @returns {{clientId: string, clientSecret: string, source: string}} */
export function oauthClient() {
  if (env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET')) {
    return { clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET'), source: 'GOOGLE_CLIENT_ID (.env)' };
  }
  if (env('GADS_CLIENT_ID') && env('GADS_CLIENT_SECRET')) {
    return { clientId: env('GADS_CLIENT_ID'), clientSecret: env('GADS_CLIENT_SECRET'), source: 'GADS_CLIENT_ID (.env)' };
  }
  try {
    const raw = fs.readFileSync(googleAdsYamlPath(), 'utf8');
    const clientId = yamlScalar(raw, 'client_id');
    const clientSecret = yamlScalar(raw, 'client_secret');
    if (clientId && clientSecret) return { clientId, clientSecret, source: googleAdsYamlPath() };
  } catch {
    /* no yaml */
  }
  throw new AuthError(
    'CONFIG',
    'Brak klienta OAuth (client_id + client_secret). Konektor szuka po kolei:\n' +
      '  1. GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (.env)\n' +
      '  2. GADS_CLIENT_ID + GADS_CLIENT_SECRET (.env)\n' +
      '  3. ~/google-ads.yaml (client_id, client_secret)'
  );
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
const hasScopes = (granted, needed) => needed.every((s) => granted.includes(s));
const servicesOf = (scopes) => Object.keys(SERVICES).filter((k) => hasScopes(scopes, SERVICES[k].scopes));

function assertService(service) {
  if (!SERVICES[service]) {
    throw new AuthError('CONFIG', `Nieznana usługa „${service}”. Dostępne: ${Object.keys(SERVICES).join(', ')}.`);
  }
  return SERVICES[service];
}

export function defaultEmail() {
  return readJson(configPath())?.default || null;
}

/** Every authorized Google account on this machine. */
export function listAccounts() {
  let files = [];
  try {
    files = fs.readdirSync(storeDir()).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    return [];
  }
  const dflt = defaultEmail();
  return files
    .map((f) => readJson(path.join(storeDir(), f)))
    .filter((t) => t?.email && t.refresh_token)
    .map((t) => ({ ...t, services: servicesOf(t.scopes || []), default: t.email === dflt }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Match an e-mail or a label (case-insensitive). */
export function findAccount(selector) {
  if (!selector) return null;
  const s = String(selector).trim().toLowerCase();
  const all = listAccounts();
  return all.find((a) => a.email.toLowerCase() === s) || all.find((a) => a.label?.toLowerCase() === s) || null;
}

export function hasAccountFor(service) {
  assertService(service);
  return listAccounts().some((a) => a.services.includes(service));
}

const fixCommand = (service, account) =>
  `node "${CLI}" --action=auth --services=${service}${account ? ` --account=${account}` : ''}`;

/**
 * Which account serves this call. Explicit selector > GOOGLE_ACCOUNT env >
 * the only account with the service > the default account.
 */
export function resolveAccount(service, selector) {
  const svc = assertService(service);
  const sel = selector || env('GOOGLE_ACCOUNT');
  const all = listAccounts();

  if (sel) {
    const acct = findAccount(sel);
    if (!acct) {
      throw new AuthError(
        'NO_ACCOUNT',
        `Konto Google „${sel}” nie jest autoryzowane.\n` +
          `Autoryzowane: ${all.map((a) => a.email + (a.label ? ` (${a.label})` : '')).join(', ') || '(żadne)'}\n` +
          `Dodaj je: ${fixCommand(service)}${/@/.test(sel) ? '' : ` --label=${sel}`}`
      );
    }
    if (!acct.services.includes(service)) {
      throw new AuthError(
        'NO_SCOPE',
        `Konto ${acct.email} nie ma jeszcze zgody na ${svc.name}.\n` +
          `Rozszerz zgodę (poprzednie usługi zostają): ${fixCommand(service, acct.email)}`
      );
    }
    return acct;
  }

  const candidates = all.filter((a) => a.services.includes(service));
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) {
    throw new AuthError('NO_ACCOUNT', `Żadne konto Google nie ma zgody na ${svc.name}.\nAutoryzuj: ${fixCommand(service)}`);
  }
  const dflt = candidates.find((a) => a.default);
  if (dflt) return dflt;
  throw new AuthError(
    'AMBIGUOUS',
    `Zgodę na ${svc.name} ma kilka kont: ${candidates.map((a) => a.email).join(', ')}.\n` +
      `Wskaż konto (--account=<email albo etykieta>) albo ustaw domyślne:\n` +
      `  node "${CLI}" --action=set-default --account=<email>`
  );
}

function assertClient(acct) {
  const { clientId } = oauthClient();
  if (acct.client_id && acct.client_id !== clientId) {
    throw new AuthError(
      'CLIENT_MISMATCH',
      `Token konta ${acct.email} wydano dla innego klienta OAuth niż obecny (${clientId.slice(0, 12)}…).\n` +
        `Autoryzuj ponownie: ${fixCommand(acct.services[0] || 'ads', acct.email)}`
    );
  }
}

/** Refresh token + client for libraries that refresh on their own (googleapis, google-ads-api). */
export function getCredentials(service, selector) {
  const acct = resolveAccount(service, selector);
  assertClient(acct);
  const { clientId, clientSecret } = oauthClient();
  return { clientId, clientSecret, refreshToken: acct.refresh_token, email: acct.email, label: acct.label };
}

const memo = new Map();

/** A fresh access token for the service. Cached in memory and on disk until 60 s before expiry. */
export async function getAccessToken(service, selector) {
  const acct = resolveAccount(service, selector);
  assertClient(acct);
  const now = Date.now();

  const hit = memo.get(acct.email) || readJson(cachePath(acct.email));
  if (hit?.access_token && hit.expiry > now + 60_000 && hit.refresh_token_hash === hash(acct.refresh_token)) {
    memo.set(acct.email, hit);
    return { accessToken: hit.access_token, email: acct.email };
  }

  const { clientId, clientSecret } = oauthClient();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: acct.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      markInvalid(acct.email, acct.refresh_token, data.error_description);
      throw new AuthError(
        'INVALID_GRANT',
        `Token konta ${acct.email} został unieważniony (${data.error_description || 'invalid_grant'}).\n` +
          `Przyczyny: zmiana hasła (dotyczy tokenów z Gmailem), cofnięty dostęp, 6 miesięcy bez użycia.\n` +
          `Autoryzuj ponownie: node "${CLI}" --action=auth --services=${acct.services.join(',')} --account=${acct.email}`
      );
    }
    throw new Error(`Odświeżenie tokena ${acct.email} nie powiodło się: ${data.error_description || data.error || res.status}`);
  }

  const entry = {
    access_token: data.access_token,
    expiry: now + (data.expires_in || 3600) * 1000,
    refresh_token_hash: hash(acct.refresh_token),
  };
  memo.set(acct.email, entry);
  try {
    writeJson(cachePath(acct.email), entry);
  } catch {
    /* the cache is an optimisation */
  }
  if (acct.invalid_at) clearInvalid(acct.email, acct.refresh_token);
  return { accessToken: data.access_token, email: acct.email };
}

// Cheap fingerprint, so a cached access token never outlives the refresh token it came from.
function hash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (Math.imul(31, h) + String(s).charCodeAt(i)) | 0;
  return h;
}

function markInvalid(email, refreshToken, reason) {
  const t = readJson(tokenFile(email));
  if (!t || t.refresh_token !== refreshToken) return; // replaced meanwhile — leave the new one alone
  writeJson(tokenFile(email), { ...t, invalid_at: new Date().toISOString(), invalid_reason: reason || 'invalid_grant' });
}

function clearInvalid(email, refreshToken) {
  const t = readJson(tokenFile(email));
  if (!t || t.refresh_token !== refreshToken) return;
  delete t.invalid_at;
  delete t.invalid_reason;
  writeJson(tokenFile(email), t);
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
export function parseServices(list) {
  const raw = String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
  const names = raw.includes('all') ? Object.keys(SERVICES) : raw;
  names.forEach(assertService);
  if (!names.length) throw new AuthError('CONFIG', `Podaj --services=<lista>. Dostępne: ${Object.keys(SERVICES).join(', ')}, all.`);
  return names;
}

/**
 * Consent link. `account` (e-mail) pre-selects the login and extends that
 * account's token: the link asks for the account's current scopes plus the new ones.
 */
export function authUrl({ services, account, label } = {}) {
  const names = parseServices(Array.isArray(services) ? services.join(',') : services);
  const known = account ? findAccount(account) : null;
  // An existing account asks again for everything it already has: Google does not
  // reliably fold earlier grants into the new refresh token, even with
  // include_granted_scopes — the new token could otherwise carry only the new service.
  const scopes = new Set([...IDENTITY_SCOPES, ...(known?.scopes || []), ...names.flatMap((n) => SERVICES[n].scopes)]);
  const { clientId } = oauthClient();
  const state = Buffer.from(JSON.stringify({ label: label || undefined, services: names })).toString('base64url');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI(),
    response_type: 'code',
    scope: [...scopes].join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    // consent: Google returns a refresh token only on an explicit consent screen.
    prompt: known || /@/.test(account || '') ? 'consent' : 'select_account consent',
    state,
  });
  const hint = known?.email || (/@/.test(account || '') ? account : null);
  if (hint) params.set('login_hint', hint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload.email ? String(payload.email).toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Exchange the callback code and store the token under the e-mail Google
 * reports. Never replaces a token with one that has fewer scopes.
 * @returns {{email, status: 'nowe'|'rozszerzone'|'odnowione'|'zachowane', services, missing, exports}}
 */
export async function exchangeCode(code, stateRaw) {
  let state = {};
  try {
    state = JSON.parse(Buffer.from(String(stateRaw || ''), 'base64url').toString('utf8')) || {};
  } catch {
    /* state is a convenience */
  }
  const { clientId, clientSecret } = oauthClient();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI(), grant_type: 'authorization_code' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Wymiana kodu nie powiodła się: ${data.error_description || data.error || res.status}`);

  const email = emailFromIdToken(data.id_token);
  if (!email) throw new Error('Google nie zwróciło adresu e-mail (brak zakresu „email”). Token NIE został zapisany.');
  if (!data.refresh_token) throw new Error('Google nie zwróciło refresh tokena. Uruchom autoryzację ponownie. Token NIE został zapisany.');

  const granted = String(data.scope || '').split(/\s+/).filter(Boolean);
  const requested = (state.services || []).filter((s) => SERVICES[s]);
  const missing = requested.filter((s) => !hasScopes(granted, SERVICES[s].scopes));

  const existing = readJson(tokenFile(email));
  const sameClient = existing?.client_id === clientId;
  if (existing && sameClient && !existing.invalid_at && !hasScopes(granted, existing.scopes || [])) {
    // Fewer scopes than the working token — keep the old one, it serves more.
    return { email, status: 'zachowane', services: servicesOf(existing.scopes || []), granted: servicesOf(granted), missing, exports: [] };
  }

  let label = state.label || existing?.label;
  if (label) {
    const clash = listAccounts().find((a) => a.label?.toLowerCase() === label.toLowerCase() && a.email !== email);
    if (clash) label = existing?.label; // a label names one account; keep the old owner
  }

  const now = new Date().toISOString();
  writeJson(tokenFile(email), {
    email,
    label: label || undefined,
    client_id: clientId,
    scopes: granted,
    refresh_token: data.refresh_token,
    // Google sends this only for time-limited tokens (app in "Testing" = 7 days).
    refresh_expires_at: data.refresh_token_expires_in
      ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()
      : undefined,
    created_at: existing?.created_at || now,
    updated_at: now,
  });
  try {
    fs.rmSync(cachePath(email), { force: true });
  } catch {
    /* ignore */
  }
  memo.delete(email);
  if (!defaultEmail()) writeJson(configPath(), { ...(readJson(configPath()) || {}), default: email });

  const status = !existing ? 'nowe' : servicesOf(granted).length > servicesOf(existing.scopes || []).length ? 'rozszerzone' : 'odnowione';
  return { email, status, services: servicesOf(granted), missing, refreshExpiresAt: data.refresh_token_expires_in ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString() : null, exports: syncExports() };
}

export function setDefault(selector) {
  const acct = findAccount(selector);
  if (!acct) throw new AuthError('NO_ACCOUNT', `Konto „${selector}” nie jest autoryzowane.`);
  writeJson(configPath(), { ...(readJson(configPath()) || {}), default: acct.email });
  return { email: acct.email, exports: syncExports() };
}

export function setLabel(selector, label) {
  const acct = findAccount(selector);
  if (!acct) throw new AuthError('NO_ACCOUNT', `Konto „${selector}” nie jest autoryzowane.`);
  if (label && !/^[a-z0-9][a-z0-9._-]*$/i.test(label)) throw new AuthError('CONFIG', `Niedozwolona etykieta „${label}”.`);
  const clash = label && listAccounts().find((a) => a.label?.toLowerCase() === label.toLowerCase() && a.email !== acct.email);
  if (clash) throw new AuthError('CONFIG', `Etykieta „${label}” należy już do ${clash.email}.`);
  const t = readJson(tokenFile(acct.email));
  writeJson(tokenFile(acct.email), { ...t, label: label || undefined });
  return { email: acct.email, label };
}

// ---------------------------------------------------------------------------
// Exports — copies of a token in the format some other tool reads directly
// (python google-ads, scripts you cannot change). The store stays the source
// of truth; exports are rewritten after every authorization and default change.
//
// _config.json → "exports": [
//   { "type": "google-ads-yaml", "path": "~/google-ads.yaml" },
//   { "type": "oauth-token-json", "service": "gmail",
//     "token": "~/some/token.json", "credentials": "~/some/credentials.json" }
// ]
// Without "exports", ~/google-ads.yaml is kept in sync (if it exists).
// ---------------------------------------------------------------------------
const expandHome = (p) => String(p).replace(/^~(?=\/|$)/, os.homedir());

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Refresh token of the account serving Google Ads by default → the yaml's refresh_token line. */
function exportGoogleAdsYaml(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'brak-pliku', file };
  }
  let acct;
  try {
    acct = resolveAccount('ads');
  } catch {
    return { status: 'brak-konta', file };
  }
  if (yamlScalar(raw, 'client_id') !== acct.client_id) return { status: 'inny-klient', file };
  if (yamlScalar(raw, 'refresh_token') === acct.refresh_token) return { status: 'aktualny', file, email: acct.email };
  const line = `refresh_token: ${acct.refresh_token}`;
  writeText(file, /^\s*refresh_token\s*:.*$/m.test(raw) ? raw.replace(/^\s*refresh_token\s*:.*$/m, line) : raw.replace(/\s*$/, `\n${line}\n`));
  return { status: 'zaktualizowany', file, email: acct.email };
}

/** googleapis-style token.json (+ credentials.json with the same client, so the pair always matches). */
function exportTokenJson({ service, token, credentials }) {
  const file = expandHome(token);
  let acct;
  try {
    acct = resolveAccount(service);
  } catch {
    return { status: 'brak-konta', file };
  }
  if (readJson(file)?.refresh_token === acct.refresh_token) return { status: 'aktualny', file, email: acct.email };
  writeText(file, JSON.stringify({ refresh_token: acct.refresh_token, scope: acct.scopes.join(' '), token_type: 'Bearer' }, null, 2) + '\n');
  if (credentials) {
    const { clientId, clientSecret } = oauthClient();
    writeText(
      expandHome(credentials),
      JSON.stringify({ web: { client_id: clientId, client_secret: clientSecret, redirect_uris: [REDIRECT_URI()] } }, null, 2) + '\n'
    );
  }
  return { status: 'zaktualizowany', file, email: acct.email };
}

export function syncExports() {
  const list = readJson(configPath())?.exports || [{ type: 'google-ads-yaml', path: googleAdsYamlPath() }];
  return list.map((e) => {
    try {
      if (e.type === 'google-ads-yaml') return { type: e.type, ...exportGoogleAdsYaml(expandHome(e.path || googleAdsYamlPath())) };
      if (e.type === 'oauth-token-json') return { type: e.type, ...exportTokenJson(e) };
      return { type: e.type, status: 'nieznany-typ' };
    } catch (err) {
      return { type: e.type, status: 'blad', error: err.message };
    }
  });
}
