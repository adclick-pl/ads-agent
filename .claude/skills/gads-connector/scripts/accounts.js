import fs from 'fs';
import path from 'path';

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
    return accounts.find((a) => a.default) || null;
  }

  const sel = String(selector).trim();
  const selId = cleanId(sel);
  const selLower = sel.toLowerCase();

  return (
    accounts.find((a) => a.id && a.id === selId) ||
    accounts.find((a) => a.key && a.key.toLowerCase() === selLower) ||
    accounts.find((a) => a.name && a.name.toLowerCase() === selLower) ||
    accounts.find((a) => a.aliases.some((al) => String(al).toLowerCase() === selLower)) ||
    null
  );
}
