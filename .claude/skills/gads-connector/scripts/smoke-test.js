#!/usr/bin/env node
/**
 * Offline smoke test — validates that every module loads and that the pure
 * helper functions behave correctly, WITHOUT calling the Google Ads API or
 * requiring any credentials. Run it any time to confirm the connector is
 * wired up correctly:
 *
 *   node scripts/smoke-test.js     (or, from the package root: npm run connector:smoke)
 *
 * Exit code 0 = all good, 1 = a check failed.
 */

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}\n       ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('\n🧪 gads-connector — offline smoke test\n');

// 1. Every module must import without throwing (syntax / import-path check).
const queries = await import('./queries.js');
const mutator = await import('./mutator.js');
const client = await import('./client.js');
const config = await import('./config.js');
const accounts = await import('./accounts.js');
const csv = await import('./csv.js');
const output = await import('./output.js');
const safety = await import('./safety.js');
console.log('Module loading: ✅ all imports resolved\n');

console.log('Pure helpers:');

// 2. Micros <-> standard currency round-trip.
check('microsToStandard(150000000) === 150', () => {
  assert(queries.microsToStandard(150000000) === 150);
});
check('standardToMicros(150.5) === 150500000', () => {
  assert(mutator.standardToMicros(150.5) === 150500000);
});
check('micros round-trip is lossless for 2 decimals', () => {
  const v = 49.99;
  assert(queries.microsToStandard(mutator.standardToMicros(v)) === v);
});
check('microsToStandard(null) === 0', () => {
  assert(queries.microsToStandard(null) === 0);
});

// 3. Date helpers.
check('formatLocalPlainDate returns YYYY-MM-DD', () => {
  const s = queries.formatLocalPlainDate(new Date(2026, 0, 5)); // 5 Jan 2026
  assert(s === '2026-01-05', `got ${s}`);
});
check('calculateDateRange(30) returns valid bounded range', () => {
  const { start, end } = queries.calculateDateRange(30);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end));
  assert(start < end, 'start should be before end');
});

// 4. Config validation logic.
check('validateConfig throws when credentials are missing', () => {
  let threw = false;
  try {
    config.validateConfig({});
  } catch {
    threw = true;
  }
  assert(threw, 'expected validateConfig({}) to throw');
});
check('validateConfig passes with full credentials', () => {
  config.validateConfig({
    developer_token: 'x',
    client_id: 'x',
    client_secret: 'x',
    refresh_token: 'x',
  });
});
check('loadConfig() does not throw (returns object even without creds)', () => {
  const c = config.loadConfig();
  assert(c && typeof c === 'object');
});

// 5. Error unpacking.
check('unpackError flattens nested Google Ads errors', () => {
  const msg = client.unpackError({
    message: 'top',
    errors: [{ message: 'inner', error_code: { authorization_error: 'X' } }],
  });
  assert(msg.includes('top') && msg.includes('inner'), `got: ${msg}`);
});

// 6. Timezone-aware date formatting.
check('formatInTimeZone respects the account timezone', () => {
  // 2026-01-01 00:30 UTC is still 2025-12-31 in Los Angeles.
  const d = new Date('2026-01-01T00:30:00Z');
  assert(queries.formatInTimeZone(d, 'America/Los_Angeles') === '2025-12-31');
  assert(queries.formatInTimeZone(d, 'Europe/Warsaw') === '2026-01-01');
});
check('formatInTimeZone falls back gracefully on bad tz', () => {
  const s = queries.formatInTimeZone(new Date(2026, 0, 5), 'Not/AZone');
  assert(s === '2026-01-05', `got ${s}`);
});

// 7. GAQL date-range injection.
check('applyDateRange replaces LAST_30_DAYS', () => {
  const out = queries.applyDateRange('SELECT x FROM y WHERE segments.date DURING LAST_30_DAYS', { days: 7, timezone: 'Europe/Warsaw' });
  assert(/BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/.test(out), out);
});
check('applyDateRange injects WHERE when query has none', () => {
  const out = queries.applyDateRange('SELECT x FROM y ORDER BY x LIMIT 5', { days: 7 });
  assert(/WHERE segments\.date BETWEEN/.test(out) && /ORDER BY/.test(out), out);
});
check('applyDateRange leaves explicit BETWEEN untouched', () => {
  const q = "SELECT x FROM y WHERE segments.date BETWEEN '2026-01-01' AND '2026-01-31'";
  assert(queries.applyDateRange(q, { days: 7 }) === q);
});
check('applyDateRange no-ops without --days', () => {
  const q = 'SELECT x FROM y';
  assert(queries.applyDateRange(q, {}) === q);
});

// 8. CSV serialisation.
check('rowsToCsv builds header + rows and escapes commas/quotes', () => {
  const out = csv.rowsToCsv([
    { name: 'A, Inc', cost: 10 },
    { name: 'B "x"', cost: 20 },
  ]);
  const lines = out.split('\n');
  assert(lines[0] === 'name,cost', lines[0]);
  assert(lines[1] === '"A, Inc",10', lines[1]);
  assert(lines[2] === '"B ""x""",20', lines[2]);
});
check('rowsToCsv unions ragged columns', () => {
  const out = csv.rowsToCsv([{ a: 1 }, { b: 2 }]);
  assert(out.split('\n')[0] === 'a,b', out);
});
check('rowsToCsv returns empty string for no rows', () => {
  assert(csv.rowsToCsv([]) === '');
});

// 8b. Output-mode decision (inline vs CSV by row count).
check('chooseOutputMode: small result → json', () => {
  assert(output.chooseOutputMode(10, { threshold: 500 }) === 'json');
});
check('chooseOutputMode: large result → csv', () => {
  assert(output.chooseOutputMode(501, { threshold: 500 }) === 'csv');
});
check('chooseOutputMode: at threshold → json (inclusive)', () => {
  assert(output.chooseOutputMode(500, { threshold: 500 }) === 'json');
});
check('chooseOutputMode: forceJson overrides large', () => {
  assert(output.chooseOutputMode(9999, { threshold: 500, forceJson: true }) === 'json');
});
check('chooseOutputMode: forceCsv overrides small', () => {
  assert(output.chooseOutputMode(1, { threshold: 500, forceCsv: true }) === 'csv');
});
check('defaultCsvPath includes action and ends with .csv', () => {
  const p = output.defaultCsvPath('get-search-terms');
  assert(p.includes('get-search-terms') && p.endsWith('.csv'), p);
});

// 8c. SafetyLimits — budget-change guardrails.
check('checkBudgetChange: small change (within limit) is safe', () => {
  const r = safety.checkBudgetChange(100, 130, { limitPct: 40 }); // +30%
  assert(r.safe === true, JSON.stringify(r));
  assert(r.pctChange === 30, `got ${r.pctChange}`);
});
check('checkBudgetChange: jump over limit is blocked', () => {
  const r = safety.checkBudgetChange(100, 200, { limitPct: 40 }); // +100%
  assert(r.safe === false && r.reason, JSON.stringify(r));
});
check('checkBudgetChange: big cut over limit is blocked', () => {
  const r = safety.checkBudgetChange(100, 30, { limitPct: 40 }); // -70%
  assert(r.safe === false, JSON.stringify(r));
});
check('checkBudgetChange: at the limit is safe (inclusive)', () => {
  const r = safety.checkBudgetChange(100, 140, { limitPct: 40 }); // +40%
  assert(r.safe === true, JSON.stringify(r));
});
check('checkBudgetChange: unknown baseline is treated as unsafe', () => {
  const r = safety.checkBudgetChange(null, 100, { limitPct: 40 });
  assert(r.safe === false && r.pctChange === null, JSON.stringify(r));
});
check('checkBudgetChange: default limit is 40%', () => {
  assert(safety.DEFAULT_MAX_BUDGET_CHANGE_PCT === 40);
  const r = safety.checkBudgetChange(100, 150); // +50%, no opts → default 40
  assert(r.safe === false, JSON.stringify(r));
});
check('pctChange: basic and zero-baseline behaviour', () => {
  assert(safety.pctChange(100, 150) === 50);
  assert(safety.pctChange(0, 10) === Infinity);
  assert(safety.pctChange(0, 0) === 0);
});

// 8d. No-delete policy — REMOVED is refused, pause/enable allowed.
check('assertNotRemoval throws for REMOVED', () => {
  let threw = false;
  try { safety.assertNotRemoval('REMOVED'); } catch { threw = true; }
  assert(threw, 'expected REMOVED to be rejected');
});
check('assertNotRemoval is case-insensitive', () => {
  let threw = false;
  try { safety.assertNotRemoval('removed'); } catch { threw = true; }
  assert(threw, 'expected lowercase removed to be rejected');
});
check('assertNotRemoval allows PAUSED and ENABLED', () => {
  safety.assertNotRemoval('PAUSED');
  safety.assertNotRemoval('ENABLED');
});

// 9. Account registry loads without throwing (may be empty if no accounts.json).
check('loadAccounts() returns an array', () => {
  assert(Array.isArray(accounts.loadAccounts()));
});
check('resolveAccount(undefined) does not throw', () => {
  accounts.resolveAccount(undefined);
});

console.log(`\nResult: ${passed} passed, ${failed} failed.\n`);
process.exit(failed === 0 ? 0 : 1);
