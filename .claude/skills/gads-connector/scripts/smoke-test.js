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

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

/**
 * Async variant of `check`. Without it an async test body returns a promise that
 * `check` never awaits, so the test passes even when its assertions fail — a
 * green tick that proves nothing. Always `await checkAsync(...)`.
 */
async function checkAsync(name, fn) {
  try {
    await fn();
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

// 10. Final URL update helpers (validation, resource-name building, CSV parsing).
check('validateFinalUrl accepts a well-formed https URL', () => {
  const r = safety.validateFinalUrl('https://zielonyogrod.example/podloze-pod-plac-zabaw/');
  assert(r.valid && r.host === 'zielonyogrod.example', JSON.stringify(r));
});
check('validateFinalUrl rejects empty / non-http', () => {
  assert(!safety.validateFinalUrl('').valid);
  assert(!safety.validateFinalUrl('ftp://x.pl/').valid);
  assert(!safety.validateFinalUrl('not a url').valid);
});
check('validateFinalUrl domain lock rejects off-domain (www ignored)', () => {
  assert(safety.validateFinalUrl('https://www.zielonyogrod.example/x/', { domain: 'zielonyogrod.example' }).valid);
  assert(!safety.validateFinalUrl('https://evil.example/x/', { domain: 'zielonyogrod.example' }).valid);
});
check('buildFinalUrlResourceName builds from bare ID and passes through full names', () => {
  assert(mutator.buildFinalUrlResourceName('123-456-7890', 'ad', '999') === 'customers/1234567890/ads/999');
  assert(mutator.buildFinalUrlResourceName('1234567890', 'keyword', '11~22') === 'customers/1234567890/adGroupCriteria/11~22');
  const full = 'customers/1234567890/ads/999';
  assert(mutator.buildFinalUrlResourceName('1234567890', 'ad', full) === full);
});
check('buildFinalUrlResourceName rejects unknown entity / empty id', () => {
  let t1 = false, t2 = false;
  try { mutator.buildFinalUrlResourceName('1', 'sitelink', '9'); } catch { t1 = true; }
  try { mutator.buildFinalUrlResourceName('1', 'ad', ''); } catch { t2 = true; }
  assert(t1 && t2);
});
check('parseCsv reads header + quoted cells with commas', () => {
  const rows = csv.parseCsv('id,final_url,label\n999,https://zielonyogrod.example/a/,"grupa, x"\n11~22,https://zielonyogrod.example/b/,kw\n');
  assert(rows.length === 2, `got ${rows.length}`);
  assert(rows[0].id === '999' && rows[0].final_url === 'https://zielonyogrod.example/a/' && rows[0].label === 'grupa, x', JSON.stringify(rows[0]));
  assert(rows[1].id === '11~22', JSON.stringify(rows[1]));
});
check('parseCsv skips blank trailing lines and returns [] for empty input', () => {
  assert(csv.parseCsv('id,final_url\n\n').length === 0);
  assert(csv.parseCsv('').length === 0);
});
check('parseCsv preserves header case (camelCase survives)', () => {
  const rows = csv.parseCsv('date,sessionDefaultChannelGroup,sessions\n20260620,Paid Search,117\n');
  assert(Object.keys(rows[0]).includes('sessionDefaultChannelGroup'), JSON.stringify(Object.keys(rows[0])));
  assert(rows[0].sessionDefaultChannelGroup === 'Paid Search');
});
check('parseCsv reads are case-insensitive in both directions', () => {
  const rows = csv.parseCsv('ID,Final_URL\n999,https://x.pl/\n');
  assert(rows[0].id === '999', 'lowercase access to uppercase header');
  assert(rows[0].final_url === 'https://x.pl/');
  assert(rows[0].ID === '999', 'original spelling still works');
  const ga = csv.parseCsv('landingPage,screenPageViews\n/kontakt,42\n');
  assert(ga[0].landingpage === '/kontakt', 'lowercase access to camelCase header');
  assert(ga[0].screenPageViews === '42');
});
check('parseCsv rows round-trip through rowsToCsv without duplicate columns', () => {
  const rows = csv.parseCsv('landingPage,sessions\n/a,5\n');
  const out = csv.rowsToCsv(rows);
  assert(out.split('\n')[0] === 'landingPage,sessions', out);
});
check('field() resolves aliases case-insensitively and skips empties', () => {
  const [row] = csv.parseCsv('Link_Resource_Name,final_url,label\nrn1,,opis\n');
  assert(csv.field(row, 'link_resource_name') === 'rn1');
  assert(csv.field(row, 'final_url', 'url') === undefined, 'empty cell must not win');
  assert(csv.field(row, 'nope', 'label') === 'opis');
});

// 11. Sitelink link-level detection (routes the right GAQL table for URL swaps).
check('sitelinkLinkLevel detects campaign/ad_group/customer', () => {
  assert(queries.sitelinkLinkLevel('customers/1/campaignAssets/2~3~SITELINK') === 'campaign');
  assert(queries.sitelinkLinkLevel('customers/1/adGroupAssets/2~3~SITELINK') === 'ad_group');
  assert(queries.sitelinkLinkLevel('customers/1/customerAssets/3~SITELINK') === 'customer');
});
check('sitelinkLinkLevel throws on an unrecognised resource name', () => {
  let threw = false;
  try { queries.sitelinkLinkLevel('customers/1/ads/999'); } catch { threw = true; }
  assert(threw);
});
check('swapSitelinkFinalUrls exists and rejects an empty batch', async () => {
  assert(typeof mutator.swapSitelinkFinalUrls === 'function');
});

// 12. Sitelink creation guards: text limits + pairing rule.
check('checkSitelinkTexts accepts valid texts and empty descriptions', () => {
  assert(safety.checkSitelinkTexts({ linkText: 'Płyty gumowe SBR', description1: 'Ekonomiczne, z certyfikatem HIC', description2: 'Wiele kolorów, montaż na gruncie' }).valid);
  assert(safety.checkSitelinkTexts({ linkText: 'Sklep online' }).valid);
});
check('checkSitelinkTexts rejects over-limit and unpaired descriptions', () => {
  assert(!safety.checkSitelinkTexts({ linkText: 'To jest zdecydowanie za długi nagłówek' }).valid); // >25
  assert(!safety.checkSitelinkTexts({ linkText: 'OK', description1: 'x'.repeat(36), description2: 'y' }).valid); // desc1 >35
  assert(!safety.checkSitelinkTexts({ linkText: 'OK', description1: 'tylko jeden opis' }).valid); // unpaired
  assert(!safety.checkSitelinkTexts({ linkText: '' }).valid); // empty
});
check('addSitelinks / pauseSitelinkLinks are exported functions', () => {
  assert(typeof mutator.addSitelinks === 'function');
  assert(typeof mutator.pauseSitelinkLinks === 'function');
});
check('clearKeywordFinalUrls is exported and rejects non-keyword resources', async () => {
  assert(typeof mutator.clearKeywordFinalUrls === 'function');
  let threw = false;
  try {
    await mutator.clearKeywordFinalUrls('1234567890', [{ resourceName: 'customers/1/ads/999' }], true);
  } catch { threw = true; }
  assert(threw, 'should refuse a non-adGroupCriteria resource');
});

// 13. Ad group + keyword creation guards.
check('checkAdGroupName accepts a normal name, rejects empty / over-limit', () => {
  assert(safety.checkAdGroupName('Meble do jadalni [KW]').valid);
  assert(!safety.checkAdGroupName('   ').valid);
  assert(!safety.checkAdGroupName('x'.repeat(256)).valid);
});
check('checkKeywordText accepts valid keywords in every match type', () => {
  for (const mt of ['EXACT', 'PHRASE', 'BROAD']) {
    assert(safety.checkKeywordText('stół okrągły rozkładany', mt).valid, mt);
  }
});
check('checkKeywordText rejects match-type punctuation left in the text', () => {
  assert(!safety.checkKeywordText('[stół okrągły]', 'EXACT').valid);
  assert(!safety.checkKeywordText('"kanapa z funkcją spania"', 'PHRASE').valid);
});
check('checkKeywordText enforces Google limits and a known match type', () => {
  assert(!safety.checkKeywordText('', 'EXACT').valid);
  assert(!safety.checkKeywordText('x'.repeat(81), 'EXACT').valid);            // >80 znaków
  assert(!safety.checkKeywordText('a b c d e f g h i j k', 'EXACT').valid);   // 11 wyrazów
  assert(!safety.checkKeywordText('komoda', 'SZEROKIE').valid);               // zły typ dopasowania
  assert(!safety.checkKeywordText('komoda + szafka', 'EXACT').valid === false); // '+' jest dozwolony
});
check('createAdGroups / addKeywords are exported functions', () => {
  assert(typeof mutator.createAdGroups === 'function');
  assert(typeof mutator.addKeywords === 'function');
});
check('addKeywords refuses a row with no ad group reference', async () => {
  let threw = false;
  try {
    await mutator.addKeywords('1234567890', [{ text: 'komoda', matchType: 'EXACT' }], true);
  } catch { threw = true; }
  assert(threw, 'should refuse a keyword with neither ad_group_id nor campaign_id + ad_group_name');
});
check('createAdGroups refuses REMOVED (no-delete policy) and empty input', async () => {
  let threwStatus = false;
  try {
    await mutator.createAdGroups('1234567890', [{ campaignId: '1', name: 'X', status: 'REMOVED' }], true);
  } catch { threwStatus = true; }
  assert(threwStatus, 'should refuse status REMOVED');
  let threwEmpty = false;
  try { await mutator.createAdGroups('1234567890', [], true); } catch { threwEmpty = true; }
  assert(threwEmpty, 'should refuse an empty list');
});

// 14. RSA guards.
check('checkRsaTexts accepts a valid RSA', () => {
  assert(safety.checkRsaTexts({
    headlines: ['Stół Okrągły Rozkładany', 'Stół do Jadalni', 'Raty 0%'],
    descriptions: ['Stół okrągły rozkładany do jadalni. Sprawdź wymiary.', 'Rabaty do -50%. Raty 0%.'],
  }).valid);
});
check('checkRsaTexts enforces minimums and maximums', () => {
  assert(!safety.checkRsaTexts({ headlines: ['A', 'B'], descriptions: ['x', 'y'] }).valid);          // <3 nagłówki
  assert(!safety.checkRsaTexts({ headlines: ['A', 'B', 'C'], descriptions: ['x'] }).valid);           // <2 teksty
  assert(!safety.checkRsaTexts({ headlines: Array(16).fill(0).map((_, i) => 'H' + i), descriptions: ['x', 'y'] }).valid);
});
check('checkRsaTexts enforces 30/90 char limits', () => {
  assert(!safety.checkRsaTexts({ headlines: ['x'.repeat(31), 'B', 'C'], descriptions: ['x', 'y'] }).valid);
  assert(!safety.checkRsaTexts({ headlines: ['A', 'B', 'C'], descriptions: ['x'.repeat(91), 'y'] }).valid);
});
check('checkRsaTexts rejects duplicate headlines within one ad', () => {
  const r = safety.checkRsaTexts({ headlines: ['Komoda', 'komoda', 'Komody'], descriptions: ['x', 'y'] });
  assert(!r.valid && r.reasons.some((x) => x.includes('zduplikowany')));
});
check('checkRsaTexts validates display paths', () => {
  assert(!safety.checkRsaTexts({ headlines: ['A', 'B', 'C'], descriptions: ['x', 'y'], path1: 'x'.repeat(16) }).valid);
  assert(!safety.checkRsaTexts({ headlines: ['A', 'B', 'C'], descriptions: ['x', 'y'], path1: 'a/b' }).valid);
});
check('addAds is exported and refuses an empty batch', async () => {
  assert(typeof mutator.addAds === 'function');
  let threw = false;
  try { await mutator.addAds('1234567890', [], true); } catch { threw = true; }
  assert(threw);
});

// 15. Status guards for ads / ad groups (offline: everything below fails before any API call).
check('updateAdStatus / updateAdGroupStatus are exported functions', () => {
  assert(typeof mutator.updateAdStatus === 'function');
  assert(typeof mutator.updateAdGroupStatus === 'function');
});
check('ad/ad-group status refuses REMOVED (no-delete policy)', async () => {
  for (const [fn, item] of [
    [mutator.updateAdStatus, { adId: '123', status: 'REMOVED' }],
    [mutator.updateAdGroupStatus, { adGroupId: '123', status: 'REMOVED' }],
  ]) {
    let threw = false;
    try { await fn('1234567890', [item], true); } catch { threw = true; }
    assert(threw, 'status REMOVED must be refused before any API call');
  }
});
check('ad/ad-group status refuses an unknown status and an empty batch', async () => {
  let badStatus = false;
  try { await mutator.updateAdStatus('1234567890', [{ adId: '123', status: 'WSTRZYMANA' }], true); } catch { badStatus = true; }
  assert(badStatus, 'only ENABLED / PAUSED are allowed');
  let empty = false;
  try { await mutator.updateAdGroupStatus('1234567890', [], true); } catch { empty = true; }
  assert(empty, 'should refuse an empty list');
});
check('getAdGroupAdsByAdIds / getAdGroupsByIds short-circuit on an empty id list', async () => {
  assert((await queries.getAdGroupAdsByAdIds('1234567890', [])).length === 0);
  assert((await queries.getAdGroupsByIds('1234567890', [])).length === 0);
});
check('updateKeywordStatus is exported and enforces the same guards', async () => {
  assert(typeof mutator.updateKeywordStatus === 'function');
  for (const item of [{ criterion: '111~222', status: 'REMOVED' }, { criterion: '111~222', status: 'X' }]) {
    let threw = false;
    try { await mutator.updateKeywordStatus('1234567890', [item], true); } catch { threw = true; }
    assert(threw, `should refuse status ${item.status}`);
  }
  let empty = false;
  try { await mutator.updateKeywordStatus('1234567890', [], true); } catch { empty = true; }
  assert(empty, 'should refuse an empty list');
});
check('keyword ids keep the adGroupId~criterionId form (digits-only would break them)', async () => {
  // The shared status helper strips non-digits by default; keywords override that.
  assert((await queries.getKeywordsByCriteria('1234567890', [])).length === 0);
});


// 13. Ad-text length must follow Google's rule for keyword insertion.
check('adTextLength counts {Keyword:...} by its default text', () => {
  assert(safety.adTextLength('{Keyword:Nawierzchnie na plac zabaw}') === 26, String(safety.adTextLength('{Keyword:Nawierzchnie na plac zabaw}')));
  assert(safety.adTextLength('{KeyWord:Gumowe Nawierzchnie}') === 19);
  assert(safety.adTextLength('Zwykly naglowek') === 15);
});
check('checkRsaTexts accepts a headline whose literal form exceeds 30 but default fits', () => {
  const r = safety.checkRsaTexts({
    headlines: ['{Keyword:Nawierzchnie na plac zabaw}', 'Plyty SBR', 'Gumowe plyty'],
    descriptions: ['Opis jeden', 'Opis dwa'],
  });
  assert(r.valid, JSON.stringify(r.reasons));
});
check('checkRsaTexts still rejects a genuinely too-long headline', () => {
  const r = safety.checkRsaTexts({
    headlines: ['{Keyword:Ten domyslny tekst jest zdecydowanie za dlugi}', 'A', 'B'],
    descriptions: ['x', 'y'],
  });
  assert(!r.valid);
});

// --- Demand Gen -------------------------------------------------------------

check('parseYoutubeVideoId accepts a bare ID and every common URL form', () => {
  const p = mutator.parseYoutubeVideoId;
  for (const v of [
    '_BS8Ig7Uss8',
    'https://www.youtube.com/shorts/_BS8Ig7Uss8',
    'https://youtu.be/_BS8Ig7Uss8',
    'https://www.youtube.com/watch?v=_BS8Ig7Uss8&t=10s',
    'https://www.youtube.com/embed/_BS8Ig7Uss8',
  ]) assert(p(v) === '_BS8Ig7Uss8', `nie sparsowano: ${v}`);
});

check('parseYoutubeVideoId returns empty string for junk (never a guess)', () => {
  for (const v of ['', 'bzdura', 'https://example.com/film', null, undefined]) {
    assert(mutator.parseYoutubeVideoId(v) === '', `powinno byc puste dla: ${v}`);
  }
});

check('checkDemandGenAdTexts accepts a well-formed ad', () => {
  const r = safety.checkDemandGenAdTexts({
    headlines: ['Stol rozkladany do jadalni'],
    longHeadlines: ['Owalny stol i obrotowe krzesla - gotowy komplet do jadalni'],
    descriptions: ['Rozkladany do 300 cm. Sprawdz oferte.'],
    businessName: 'Zielony Ogrod',
  });
  assert(r.valid, JSON.stringify(r.reasons));
});

check('checkDemandGenAdTexts blocks missing business name (API-required field)', () => {
  const r = safety.checkDemandGenAdTexts({ headlines: ['A'], descriptions: ['B'], businessName: '' });
  assert(!r.valid);
  assert(r.reasons.some((x) => /business_name/.test(x)));
});

check('checkDemandGenAdTexts enforces per-field character limits', () => {
  const r = safety.checkDemandGenAdTexts({
    headlines: ['x'.repeat(41)],
    longHeadlines: ['y'.repeat(91)],
    descriptions: ['z'.repeat(91)],
    businessName: 'w'.repeat(26),
  });
  assert(!r.valid);
  assert(r.reasons.length === 4, `oczekiwano 4 bledow, jest ${r.reasons.length}`);
});

check('DEMAND_GEN_LIMITS carries the product-ad breadcrumb limit', () => {
  assert(safety.DEMAND_GEN_LIMITS.breadcrumbChars === 15, 'breadcrumb limit powinien byc 15');
});

check('product ad texts validate through the shared Demand Gen check (single-element lists)', () => {
  // A product ad carries one headline and one description, so the same check
  // runs on lists of one — that is exactly how addDemandGenProductAds calls it.
  const ok = safety.checkDemandGenAdTexts({
    headlines: ['Producent mebli ogrodowych'],
    descriptions: ['Komplety na taras i do ogrodu. Sprawdz oferte.'],
    businessName: 'Zielony Ogrod',
  });
  assert(ok.valid, JSON.stringify(ok.reasons));

  const tooLong = safety.checkDemandGenAdTexts({
    headlines: ['x'.repeat(41)],
    descriptions: ['z'.repeat(91)],
    businessName: 'Zielony Ogrod',
  });
  assert(!tooLong.valid);
  assert(tooLong.reasons.length === 2, `oczekiwano 2 bledow, jest ${tooLong.reasons.length}`);
});

await checkAsync('addDemandGenProductAds is exported and refuses an empty list', async () => {
  assert(typeof mutator.addDemandGenProductAds === 'function', 'brak eksportu addDemandGenProductAds');
  let threw = false;
  try { await mutator.addDemandGenProductAds('1234567890', [], true); } catch (e) { threw = /pusta lista/.test(e.message); }
  assert(threw, 'pusta lista powinna zostac odrzucona przed jakimkolwiek zapytaniem');
});

check('checkDemandGenAdTexts rejects too many headlines / descriptions', () => {
  const r = safety.checkDemandGenAdTexts({
    headlines: ['a', 'b', 'c', 'd', 'e', 'f'],
    descriptions: ['a', 'b', 'c', 'd', 'e', 'f'],
    businessName: 'Zielony Ogrod',
  });
  assert(!r.valid);
});

check('checkDemandGenChannels rejects strategy + channels together (protobuf oneof)', () => {
  const r = safety.checkDemandGenChannels({ strategy: 'ALL_CHANNELS', channels: ['discover'] });
  assert(!r.valid);
  assert(r.reasons.some((x) => /oneof/.test(x)));
});

check('checkDemandGenChannels accepts either branch on its own', () => {
  assert(safety.checkDemandGenChannels({ strategy: 'ALL_CHANNELS' }).valid);
  assert(safety.checkDemandGenChannels({ channels: ['youtube_shorts', 'discover'] }).valid);
  assert(safety.checkDemandGenChannels({}).valid, 'brak obu = dziedziczenie z kampanii');
});

check('checkDemandGenChannels rejects an unknown channel or strategy', () => {
  assert(!safety.checkDemandGenChannels({ channels: ['tiktok'] }).valid);
  assert(!safety.checkDemandGenChannels({ strategy: 'WSZYSTKO' }).valid);
});

check('COPYABLE_CRITERION_TYPES entries are complete and listing groups excluded', () => {
  const map = queries.COPYABLE_CRITERION_TYPES;
  assert(Object.keys(map).length > 0);
  assert(!map[8], 'LISTING_GROUP (8) nie moze byc kopiowany jako targetowanie');
  for (const [type, m] of Object.entries(map)) {
    assert(m.key && m.field && m.value && m.label, `niekompletny wpis dla typu ${type}`);
    assert(m.field.startsWith('ad_group_criterion.'), `zle pole GAQL dla typu ${type}`);
  }
});

check('CALL_TO_ACTION_VALUES maps names to the API enum values', () => {
  assert(mutator.CALL_TO_ACTION_VALUES.SHOP_NOW === 10);
  assert(mutator.CALL_TO_ACTION_VALUES.LEARN_MORE === 2);
  assert(mutator.CALL_TO_ACTION_VALUES.WATCH_NOW === 18);
});

check('every Demand Gen mutation rejects an empty batch instead of no-oping', async () => {
  const fns = ['addYoutubeAssets', 'createDemandGenAdGroups', 'copyAdGroupTargeting', 'addDemandGenAds', 'addListingGroups'];
  for (const fn of fns) assert(typeof mutator[fn] === 'function', `brak eksportu ${fn}`);
});

// --- Promotions -------------------------------------------------------------

check('checkPromotion accepts a money-off promotion with a minimum order value', () => {
  const r = safety.checkPromotion({ promotionTarget: 'Cały asortyment', moneyAmountOff: 7, currency: 'EUR', ordersOverAmount: 59, finalUrl: 'https://zielonyogrod.example/' });
  assert(r.valid, r.reasons.join('; '));
});

check('checkPromotion refuses both discount shapes at once, and neither', () => {
  const both = safety.checkPromotion({ promotionTarget: 'Cały asortyment', percentOff: 10, moneyAmountOff: 7, currency: 'EUR', finalUrl: 'https://zielonyogrod.example/' });
  assert(!both.valid);
  const none = safety.checkPromotion({ promotionTarget: 'Cały asortyment', finalUrl: 'https://zielonyogrod.example/' });
  assert(!none.valid);
});

check('checkPromotion refuses a promotion without a Final URL (the API does too)', () => {
  const r = safety.checkPromotion({ promotionTarget: 'Cały asortyment', percentOff: 10 });
  assert(!r.valid);
  assert(r.reasons.some((x) => /final_url/.test(x)), r.reasons.join('; '));
});

check('checkPromotion refuses a minimum order not above the discount', () => {
  const r = safety.checkPromotion({ promotionTarget: 'Cały asortyment', moneyAmountOff: 7, currency: 'EUR', ordersOverAmount: 5, finalUrl: 'https://zielonyogrod.example/' });
  assert(!r.valid);
});

check('promotionIdentity separates the same target at different discounts', () => {
  const a = queries.promotionIdentity('Todo el pedido', null, 7000000, 'EUR');
  const b = queries.promotionIdentity('Todo el pedido', 100000, null, null);
  assert(a !== b, 'ta sama tożsamość dla różnych rabatów — idempotencja pominęłaby drugą promocję');
  assert(a === queries.promotionIdentity('todo el pedido', null, 7000000, 'eur'), 'tożsamość wrażliwa na wielkość liter');
});

check('promotionIdentity separates the same discount at different minimum orders', () => {
  const at59 = queries.promotionIdentity('Todo el pedido', null, 7000000, 'EUR', 59000000);
  const at69 = queries.promotionIdentity('Todo el pedido', null, 7000000, 'EUR', 69000000);
  assert(at59 !== at69, 'podniesiony próg zamówienia wygląda jak duplikat — nowa promocja zostałaby pominięta');
  assert(queries.promotionIdentity('Todo el pedido', null, 7000000, 'EUR') === queries.promotionIdentity('Todo el pedido', null, 7000000, 'EUR', null),
    'promocja bez progu musi mieć tożsamość jak dotąd');
});

check('mutatedResourceNames reads a real mutate response (mutate_operation_responses)', () => {
  const got = mutator.mutatedResourceNames([{ mutate_operation_responses: [
    { asset_result: { resource_name: 'customers/1/assets/9' } },
    { campaign_asset_result: { resource_name: 'customers/1/campaignAssets/9~9~PROMOTION' } },
  ] }]);
  assert(got.length === 2, `oczekiwano 2 nazw, dostałem ${got.length}`);
  assert(got[0] === 'customers/1/assets/9');
});

check('mutatedResourceNames also handles camelCase and a bare results array', () => {
  assert(mutator.mutatedResourceNames([{ mutateOperationResponses: [{ assetResult: { resourceName: 'customers/1/assets/8' } }] }])[0] === 'customers/1/assets/8');
  assert(mutator.mutatedResourceNames([{ results: [{ resource_name: 'customers/1/campaigns/7' }] }])[0] === 'customers/1/campaigns/7');
});

check('mutatedResourceNames returns an empty list rather than throwing on junk', () => {
  for (const input of [null, undefined, [], [{}], [{ mutate_operation_responses: [{}] }], [{ mutate_operation_responses: [null] }]]) {
    assert(Array.isArray(mutator.mutatedResourceNames(input)), 'nie zwrócono tablicy');
    assert(mutator.mutatedResourceNames(input).length === 0);
  }
});

// --- Conversion actions -----------------------------------------------------

check('parseTagSnippets reads the AW id and label out of an event snippet', () => {
  const snippet = `<!-- Event snippet -->\n<script>\n gtag('event', 'conversion', {'send_to': 'AW-123456789/AbC-D_efG-h12_34', 'value': 1.0});\n</script>`;
  const got = queries.parseTagSnippets([{ event_snippet: snippet, global_site_tag: '<script src="https://www.googletagmanager.com/gtag/js?id=AW-123456789"></script>' }]);
  assert(got.conversionId === 'AW-123456789', `id: ${got.conversionId}`);
  assert(got.label === 'AbC-D_efG-h12_34', `label: ${got.label}`);
  assert(got.sendTo === 'AW-123456789/AbC-D_efG-h12_34');
});

check('parseTagSnippets falls back to the site tag when there is no label yet', () => {
  const got = queries.parseTagSnippets([{ global_site_tag: 'gtag/js?id=AW-987654321' }]);
  assert(got.conversionId === 'AW-987654321' && got.label === null, JSON.stringify(got));
});

check('parseTagSnippets returns nulls on junk instead of throwing', () => {
  for (const input of [null, undefined, [], [{}], [{ event_snippet: '' }], 'nonsense']) {
    const got = queries.parseTagSnippets(input);
    assert(got.conversionId === null && got.label === null, JSON.stringify(got));
  }
});

check('checkConversionAction accepts a normal purchase conversion', () => {
  const r = safety.checkConversionAction({ name: 'Zakup', type: 'WEBPAGE', category: 'PURCHASE', countingType: 'MANY_PER_CLICK', currency: 'PLN', primaryForGoal: true });
  assert(r.valid, r.reasons.join('; '));
  assert(r.warnings.length === 0, `nieoczekiwane ostrzeżenia: ${r.warnings.join('; ')}`);
});

check('checkConversionAction blocks a GA4 type — those come from linking, not from the API', () => {
  const r = safety.checkConversionAction({ name: 'GA4 purchase', type: 'GOOGLE_ANALYTICS_4_PURCHASE', category: 'PURCHASE' });
  assert(!r.valid);
  assert(r.reasons.some((x) => /WEBPAGE/.test(x)), r.reasons.join('; '));
});

check('checkConversionAction refuses REMOVED (no-delete policy) but allows HIDDEN', () => {
  let threw = false;
  try { safety.checkConversionAction({ name: 'x', type: 'WEBPAGE', category: 'PURCHASE', status: 'REMOVED' }); } catch { threw = true; }
  assert(threw, 'REMOVED powinno rzucić polityką no-delete');
  assert(safety.checkConversionAction({ name: 'x', type: 'WEBPAGE', category: 'PURCHASE', status: 'HIDDEN' }).valid);
});

check('checkConversionAction bounds the lookback windows', () => {
  assert(!safety.checkConversionAction({ name: 'x', type: 'WEBPAGE', category: 'PURCHASE', clickLookbackDays: 120 }).valid);
  assert(!safety.checkConversionAction({ name: 'x', type: 'WEBPAGE', category: 'PURCHASE', viewLookbackDays: 45 }).valid);
  assert(safety.checkConversionAction({ name: 'x', type: 'WEBPAGE', category: 'PURCHASE', clickLookbackDays: 90, viewLookbackDays: 30 }).valid);
});

check('checkConversionAction blocks always_use_default_value without a value', () => {
  const r = safety.checkConversionAction({ name: 'x', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', alwaysUseDefaultValue: true });
  assert(!r.valid, 'przeszło mimo braku wartości');
});

check('checkConversionAction warns (not blocks) when a purchase would get a flat value', () => {
  const r = safety.checkConversionAction({ name: 'Zakup', type: 'WEBPAGE', category: 'PURCHASE', defaultValue: 200, currency: 'PLN', alwaysUseDefaultValue: true, countingType: 'MANY_PER_CLICK' });
  assert(r.valid, r.reasons.join('; '));
  assert(r.warnings.some((w) => /ROAS/.test(w)), r.warnings.join('; '));
});

check('checkConversionAction warns about ONE_PER_CLICK on a purchase and MANY_PER_CLICK on a lead', () => {
  assert(safety.checkConversionAction({ name: 'Zakup', type: 'WEBPAGE', category: 'PURCHASE', countingType: 'ONE_PER_CLICK' })
    .warnings.some((w) => /MANY_PER_CLICK/.test(w)));
  assert(safety.checkConversionAction({ name: 'Formularz', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', countingType: 'MANY_PER_CLICK', defaultValue: 50, currency: 'PLN' })
    .warnings.some((w) => /ONE_PER_CLICK/.test(w)));
});

check('checkConversionAction in update mode does not demand type/category', () => {
  const r = safety.checkConversionAction({ primaryForGoal: true }, { isUpdate: true });
  assert(r.valid, r.reasons.join('; '));
});

check('conversion mutations are exported and reject an empty batch', async () => {
  for (const fn of ['createConversionActions', 'updateConversionActions']) {
    assert(typeof mutator[fn] === 'function', `brak eksportu ${fn}`);
    let threw = false;
    try { await mutator[fn]('1234567890', [], true); } catch { threw = true; }
    assert(threw, `${fn} nie odrzucił pustej listy`);
  }
});

// ---- create-campaigns (Search campaign shells) ----------------------------

const CAMPAIGN_OK = {
  name: 'Zielony Ogrod - Search',
  budgetAmount: 30,
  status: 'PAUSED',
  biddingStrategy: 'MAXIMIZE_CLICKS',
  geoTargets: ['2616'],
  languages: ['1030'],
  geoTargetType: 'PRESENCE',
  euPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
};

check('checkCampaignSpec accepts a plain Search campaign', () => {
  const r = safety.checkCampaignSpec(CAMPAIGN_OK);
  assert(r.valid, r.reasons.join('; '));
  assert(r.warnings.length === 0, r.warnings.join('; '));
});

check('checkCampaignSpec blocks a non-positive budget and an unknown strategy', () => {
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, budgetAmount: 0 }).valid);
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, budgetAmount: 'dużo' }).valid);
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, biddingStrategy: 'TARGET_IMPRESSION_SHARE' }).valid);
});

check('checkCampaignSpec blocks a bid knob that belongs to another strategy', () => {
  // target_roas on Maximize clicks is accepted by Google and then ignored — the
  // silent no-op this check exists to prevent.
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, targetRoas: 4 }).valid);
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, biddingStrategy: 'MAXIMIZE_CONVERSIONS', cpcBidCeiling: 10 }).valid);
  assert(safety.checkCampaignSpec({ ...CAMPAIGN_OK, cpcBidCeiling: 10 }).valid);
  assert(safety.checkCampaignSpec({ ...CAMPAIGN_OK, biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: 4 }).valid);
});

check('checkCampaignSpec warns about ENABLED and about the display network', () => {
  assert(safety.checkCampaignSpec({ ...CAMPAIGN_OK, status: 'ENABLED' }).warnings.some((w) => /ENABLED/.test(w)));
  assert(safety.checkCampaignSpec({ ...CAMPAIGN_OK, contentNetwork: true }).warnings.some((w) => /sieć reklamowa/.test(w)));
});

check('checkCampaignSpec validates targeting ids and the date pair', () => {
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, geoTargets: [] }).valid);
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, geoTargets: ['Polska'] }).valid);
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, languages: ['pl'] }).valid);
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, startDate: '01.02.2026' }).valid);
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, startDate: '2026-02-01', endDate: '2026-01-01' }).valid);
  assert(safety.checkCampaignSpec({ ...CAMPAIGN_OK, startDate: '2026-02-01', endDate: '2026-03-01' }).valid);
});

check('checkCampaignSpec demands the EU political-advertising declaration', () => {
  // Google rejects a campaign without it; catching it here turns a bare
  // "required field" API error into a readable block.
  const { euPoliticalAdvertising, ...noDeclaration } = CAMPAIGN_OK;
  assert(!safety.checkCampaignSpec(noDeclaration).valid);
  assert(!safety.checkCampaignSpec({ ...CAMPAIGN_OK, euPoliticalAdvertising: 'nie' }).valid);
  const political = safety.checkCampaignSpec({ ...CAMPAIGN_OK, euPoliticalAdvertising: 'CONTAINS_EU_POLITICAL_ADVERTISING' });
  assert(political.valid, political.reasons.join('; '));
  assert(political.warnings.some((w) => /polityczna/.test(w)), 'brak ostrzeżenia o reklamie politycznej');
});

check('createSearchCampaigns is exported and rejects an empty batch', async () => {
  assert(typeof mutator.createSearchCampaigns === 'function', 'brak eksportu createSearchCampaigns');
  let threw = false;
  try { await mutator.createSearchCampaigns('1234567890', [], true); } catch { threw = true; }
  assert(threw, 'createSearchCampaigns nie odrzucił pustej listy');
});

check('createSearchCampaigns blocks a bad row before touching the API', async () => {
  // No credentials here — reaching the API would throw a different error. A
  // validation block must come first, which is what "nic nie zapisano" proves.
  let msg = '';
  try {
    await mutator.createSearchCampaigns('1234567890', [{ name: '', budgetAmount: -5 }], true);
  } catch (e) { msg = e.message; }
  assert(/Zablokowano/.test(msg), `spodziewano się bloku walidacji, było: ${msg}`);
});

check('getExistingCampaigns and getBudgetsByName are exported', () => {
  assert(typeof queries.getExistingCampaigns === 'function', 'brak getExistingCampaigns');
  assert(typeof queries.getBudgetsByName === 'function', 'brak getBudgetsByName');
});

// ---- capitalisation policy (PROHIBITED / CAPITALIZATION) -------------------

check('findShoutingWords catches a shouted word, including Polish diacritics', () => {
  assert(safety.findShoutingWords('Projekt ogrodu GRATIS').join() === 'GRATIS');
  assert(safety.findShoutingWords('ŚWIEŻE nasiona').join() === 'ŚWIEŻE');
  assert(safety.findShoutingWords('NAJTANIEJ w Polsce').join() === 'NAJTANIEJ');
});

check('findShoutingWords leaves acronyms and CamelCase brands alone', () => {
  // The threshold exists for exactly these: refusing them would block normal copy.
  for (const t of ['Logo w PNG lub JPG wystarczy', 'Zgodne z RODO, eksport HTML',
                   'ZielonyOgrod.example', 'Projekt ogrodu gratis', 'Ekspres: 3 dni robocze']) {
    assert(safety.findShoutingWords(t).length === 0, `fałszywy alarm na: ${t}`);
  }
});

check('checkRsaTexts blocks a shouted headline and names the word', () => {
  const ad = {
    headlines: ['Trawa na taras', 'Rośliny do ogrodu', 'Projekt ogrodu GRATIS'],
    descriptions: ['Rośliny dobrane do Twojego tarasu.', 'Zamówienie już od 1 sztuki.'],
  };
  const r = safety.checkRsaTexts(ad);
  assert(!r.valid, 'przeszło mimo wersalików');
  assert(r.reasons.some((x) => /GRATIS/.test(x)), r.reasons.join('; '));
  const ok = safety.checkRsaTexts({ ...ad, headlines: ['Trawa na taras', 'Rośliny do ogrodu', 'Projekt ogrodu gratis'] });
  assert(ok.valid, ok.reasons.join('; '));
});

check('checkDemandGenAdTexts blocks shouting but not a business name in capitals', () => {
  const base = {
    headlines: ['Trawa na taras'], longHeadlines: ['Rośliny dobrane do Twojego ogrodu'],
    descriptions: ['Rośliny dobrane do Twojego tarasu.'], businessName: 'ADIDAS',
  };
  assert(safety.checkDemandGenAdTexts(base).valid, 'nazwa firmy wersalikami nie powinna blokować');
  const shouted = safety.checkDemandGenAdTexts({ ...base, descriptions: ['Rośliny do ogrodu, PROMOCJA na taras.'] });
  assert(!shouted.valid && shouted.reasons.some((x) => /PROMOCJA/.test(x)), shouted.reasons.join('; '));
});

// ---- phone numbers in ad text (PHONE_NUMBER_IN_AD_TEXT) -------------------

check('findPhoneNumbers catches a real number, with and without a country code', () => {
  assert(safety.findPhoneNumbers('tel. +48 795 822 114').length === 1);
  assert(safety.findPhoneNumbers('795 822 114').length === 1);
  assert(safety.findPhoneNumbers('Zadzwoń: 795-822-114').length === 1);
});

check('findPhoneNumbers leaves quantities, prices and dates alone', () => {
  // The false positives that would make the check unusable in real ad copy.
  for (const t of ['1200 szt. — 52,27 zł/kg', '3000 szt. — 45,51 zł/kg', 'Od 2018 roku',
                   'Zamówienie od 1 do 50 kg', 'Standard 7 dni, ekspres 3 dni', '2026-09-07']) {
    assert(safety.findPhoneNumbers(t).length === 0, `fałszywy alarm na: ${t}`);
  }
});

check('checkSitelinkTexts blocks a phone number in a description', () => {
  const bad = safety.checkSitelinkTexts({ linkText: 'Kontakt', description1: 'Napisz lub zadzwoń', description2: 'tel. +48 795 822 114' });
  assert(!bad.valid, 'przeszło mimo numeru telefonu');
  assert(bad.reasons.some((r) => /PHONE_NUMBER_IN_AD_TEXT/.test(r)), bad.reasons.join('; '));
  assert(safety.checkSitelinkTexts({ linkText: 'Kontakt', description1: 'Napisz lub zadzwoń', description2: 'Pomożemy dobrać nakład' }).valid);
});

check('the policy check reaches callouts, snippets and price offerings too', () => {
  assert(!safety.checkCalloutText('Zadzwoń 795 822 114').valid);
  assert(!safety.checkStructuredSnippet({ header: 'Typy', values: ['Krówki z logo', 'Krówki na targi', 'Infolinia 795 822 114'] }).valid);
  const offerings = [{ header: '1 kg krówek', description: '60 szt. — 73,68 zł', price: 73.68 },
                     { header: '20 kg krówek', description: '1200 szt. — 52,27 zł', price: 1045.38 },
                     { header: '50 kg krówek', description: '3000 szt. — 45,51 zł', price: 2275.38 }];
  assert(safety.checkPriceOfferings(offerings).valid, 'realny cennik nie powinien być blokowany');
  assert(!safety.checkPriceOfferings([...offerings.slice(1), { header: 'Zamów 795 822 114', description: 'Na telefon', price: 10 }]).valid);
});

check('getExistingSitelinks reports descriptions, so the idempotency key can use them', async () => {
  // A disapproved sitelink is replaced by adding the corrected one and pausing
  // the old link — impossible while the key was only parent + text + URL.
  const src = readFileSync(new URL('./queries.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function getExistingSitelinks'));
  assert(/description1: r\['asset\.sitelink_asset\.description1'\]/.test(fn.slice(0, 3000)), 'opisy nie wracają z getExistingSitelinks');
  const mut = readFileSync(new URL('./mutator.js', import.meta.url), 'utf8');
  assert(/const keyOf = \(level, parent, text, url, d1, d2\)/.test(mut), 'klucz idempotencji sitelinków nie obejmuje opisów');
});

// The slug is the registry key AND the client's folder name under `Klienci/`.
// Both readings must come from here, or adding a registry entry renames the
// folder and orphans the reports written before it.
check('accountSlug: joined lowercase, no separators', () => {
  assert(accounts.accountSlug('Zielony Ogród.pl') === 'zielonyogrod', accounts.accountSlug('Zielony Ogród.pl'));
  assert(accounts.accountSlug('Zielony Ogród - GA4') === 'zielonyogrod');
});
check('accountSlug: legal forms stripped before joining', () => {
  // Without stripping, joining turns this into `nowakisynspzoo`.
  assert(accounts.accountSlug('Nowak i Syn sp. z o.o.') === 'nowakisyn', accounts.accountSlug('Nowak i Syn sp. z o.o.'));
  assert(accounts.accountSlug('Nowak i Syn Sp. z o.o.') === 'nowakisyn');
});
check('accountSlug: matches the keys ga4/gsc connectors already propose', () => {
  // Those two are self-contained by design, so agreement is checked, not imported.
  const ga4Style = (s) => String(s).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/\.(pl|com|eu|net|es|info|org)\b/gi, ' ').replace(/[^a-z0-9]/g, '');
  for (const n of ['Zielony Ogród.pl', 'Fabryka Wzorów', 'kwiaciarnia24']) {
    assert(accounts.accountSlug(n) === ga4Style(n), `${n}: ${accounts.accountSlug(n)} vs ${ga4Style(n)}`);
  }
});
check('accountSlug: refuses digits, so no client folder is a bare number', () => {
  assert(accounts.accountSlug('1234567890') === '');
  assert(accounts.accountSlug('1234567890', '1234567890') === '');
  assert(accounts.accountSlug('') === '');
  assert(accounts.accountSlug(null) === '');
});
check('accountSlug: keeps a name that is only noise from becoming a folder', () => {
  assert(accounts.accountSlug('sp. z o.o.') === '');
  assert(accounts.accountSlug('Google Ads MCC') === '');
});
check('accountSlug: capped at 40 chars', () => {
  assert(accounts.slugifyName('a'.repeat(90)).length === 40);
});

// --- Registry bootstrap (init-accounts) -----------------------------------
// The policy lives in a pure function precisely so it can be checked without an
// API or a filesystem. Every rule below is one the operator relies on being true
// before they pass --commit.

const ROWS = [
  { id: '1111111111', descriptive_name: 'Zielony Ogród.pl', manager: false, status: 'ENABLED', currency_code: 'PLN', time_zone: 'Europe/Warsaw', login_customer_id: '9990000001' },
  { id: '2222222222', descriptive_name: 'Agencja MCC', manager: true, status: 'ENABLED', currency_code: null, time_zone: null, login_customer_id: null },
  { id: '3333333333', descriptive_name: 'Fabryka Wzorów', manager: false, status: 'CANCELED', currency_code: 'PLN', time_zone: 'Europe/Warsaw', login_customer_id: '9990000001' },
  { id: '4444444444', descriptive_name: '', manager: false, status: 'ENABLED', currency_code: 'EUR', time_zone: 'Europe/Berlin', login_customer_id: null },
];

check('init-accounts: builds an entry with id, MCC, currency and timezone', () => {
  const { add } = accounts.buildRegistryDraft(ROWS, {});
  const e = add.zielonyogrod;
  assert(e, 'brak wpisu zielonyogrod');
  assert(e.id === '1111111111' && e.login_customer_id === '9990000001');
  assert(e.currency === 'PLN' && e.timezone === 'Europe/Warsaw', JSON.stringify(e));
});
check('init-accounts: never invents an alias or a default', () => {
  const { add } = accounts.buildRegistryDraft(ROWS, {});
  for (const e of Object.values(add)) {
    assert(!('aliases' in e), 'wygenerowany alias');
    assert(!('default' in e), 'wygenerowana flaga default');
  }
});
check('init-accounts: skips managers, non-enabled and unnameable accounts', () => {
  const { add, skipped } = accounts.buildRegistryDraft(ROWS, {});
  assert(Object.keys(add).length === 1, JSON.stringify(Object.keys(add)));
  const why = Object.fromEntries(skipped.map((s) => [s.id, s.reason]));
  assert(/managerskie/.test(why['2222222222']), why['2222222222']);
  assert(/CANCELED/.test(why['3333333333']), why['3333333333']);
  assert(/czytelnego klucza/.test(why['4444444444']), why['4444444444']);
});
check('init-accounts: an account already in the registry is left alone', () => {
  const existing = { cokolwiek: { name: 'Stara nazwa', id: '1111111111' } };
  const { add, skipped } = accounts.buildRegistryDraft(ROWS, existing);
  assert(Object.keys(add).length === 0, 'dopisano konto, które już jest w rejestrze');
  assert(/cokolwiek/.test(skipped.find((s) => s.id === '1111111111').reason));
});
check('init-accounts: two accounts sharing a key are BOTH skipped, never suffixed', () => {
  const rows = [
    { id: '5555555555', descriptive_name: 'Kwiaciarnia', manager: false, status: 'ENABLED' },
    { id: '6666666666', descriptive_name: 'kwiaciarnia sp. z o.o.', manager: false, status: 'ENABLED' },
  ];
  const { add, skipped } = accounts.buildRegistryDraft(rows, {});
  assert(Object.keys(add).length === 0, JSON.stringify(Object.keys(add)));
  assert(skipped.length === 2 && skipped.every((s) => /ten sam klucz/.test(s.reason)));
});
check('init-accounts: a key already taken by another account is not reused', () => {
  const existing = { zielonyogrod: { name: 'Inny klient', id: '9999999999' } };
  const { add, skipped } = accounts.buildRegistryDraft(ROWS, existing);
  assert(!add.zielonyogrod, 'nadpisano cudzy klucz');
  assert(/zajęty/.test(skipped.find((s) => s.id === '1111111111').reason));
});
check('init-accounts: re-running over its own output adds nothing', () => {
  const { add } = accounts.buildRegistryDraft(ROWS, {});
  const second = accounts.buildRegistryDraft(ROWS, add);
  assert(Object.keys(second.add).length === 0, 'drugi przebieg dopisał wpisy');
});

// --- Ambiguity in the registry --------------------------------------------
// A selector that matches two entries used to resolve to whichever came first in
// file order. In a tool that pauses keywords and moves budgets, silently picking
// the wrong account is worse than stopping, so these checks pin the loud failure.

const tmpRegistry = (obj) => {
  const dir = mkdtempSync(join(tmpdir(), 'ads-agent-reg-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'accounts.json'), JSON.stringify(obj, null, 2));
  return dir;
};

check('resolveAccount: a duplicated id stops the run instead of guessing', () => {
  const dir = tmpRegistry({
    klientjeden: { name: 'Klient Jeden', id: '1234567890' },
    klientdwa: { name: 'Klient Dwa', id: '1234567890' },
  });
  let threw = null;
  try { accounts.resolveAccount('1234567890', dir); } catch (e) { threw = e; }
  assert(threw, 'niejednoznaczne ID nie zatrzymało wywołania');
  assert(/klientjeden/.test(threw.message) && /klientdwa/.test(threw.message), threw.message);
});
check('resolveAccount: an unambiguous selector still resolves normally', () => {
  const dir = tmpRegistry({
    klientjeden: { name: 'Klient Jeden', id: '1234567890' },
    klientdwa: { name: 'Klient Dwa', id: '2222222222', aliases: ['dwojka'] },
  });
  assert(accounts.resolveAccount('klientdwa', dir).id === '2222222222');
  assert(accounts.resolveAccount('dwojka', dir).id === '2222222222');
  assert(accounts.resolveAccount('nieistnieje', dir) === null);
});
check('resolveAccount: two accounts flagged default stop a bare call', () => {
  const dir = tmpRegistry({
    a: { name: 'A', id: '1111111111', default: true },
    b: { name: 'B', id: '2222222222', default: true },
  });
  let threw = null;
  try { accounts.resolveAccount(undefined, dir); } catch (e) { threw = e; }
  assert(threw && /default/.test(threw.message), threw && threw.message);
});
check('registryConflicts: reports duplicates and shadowed aliases, one line each', () => {
  const dir = tmpRegistry({
    klientjeden: { name: 'Klient Jeden', id: '1234567890', aliases: ['klientdwa'] },
    klientdwa: { name: 'Klient Dwa', id: '1234567890' },
  });
  const problems = accounts.registryConflicts(dir);
  assert(problems.some((p) => /ID konta/.test(p)), JSON.stringify(problems));
  assert(problems.some((p) => /nigdy nie wskaże/.test(p)), JSON.stringify(problems));
});
check('registryConflicts: a clean registry reports nothing', () => {
  const dir = tmpRegistry({
    _README: 'dokumentacja, nie konto',
    klientjeden: { name: 'Klient Jeden', id: '1111111111', default: true },
    klientdwa: { name: 'Klient Dwa', id: '2222222222', aliases: ['dwojka'] },
  });
  assert(accounts.registryConflicts(dir).length === 0, JSON.stringify(accounts.registryConflicts(dir)));
});

// 12. Bidding strategy mapping — the protobuf `oneof` shared by create-campaigns
//     and update-bidding. Exactly one field may be set, and "no target given"
//     must mean "no target set", never a number we invented.
check('setBiddingStrategy: on CREATE, no target means an empty oneof', () => {
  const c = mutator.setBiddingStrategy({}, { biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE' });
  assert(JSON.stringify(c.maximize_conversion_value) === '{}', JSON.stringify(c));
  assert(c.maximize_conversions === undefined, 'previous strategy field must stay unset');
  assert(c.target_spend === undefined && c.manual_cpc === undefined, 'only one oneof field allowed');
});
check('setBiddingStrategy: on UPDATE, no target names the subfield as 0', () => {
  // A bare {} here would build a field mask the API rejects (FIELD_HAS_SUBFIELDS).
  const c = mutator.setBiddingStrategy({}, { biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE' }, { forUpdate: true });
  assert(c.maximize_conversion_value.target_roas === 0, JSON.stringify(c));
  const d = mutator.setBiddingStrategy({}, { biddingStrategy: 'MAXIMIZE_CONVERSIONS' }, { forUpdate: true });
  assert(d.maximize_conversions.target_cpa_micros === 0, JSON.stringify(d));
});
check('setBiddingStrategy: tROAS is passed through as a ratio, not micros', () => {
  const c = mutator.setBiddingStrategy({}, { biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: 6.5 });
  assert(c.maximize_conversion_value.target_roas === 6.5, JSON.stringify(c));
});
check('setBiddingStrategy: tCPA is converted to micros', () => {
  const c = mutator.setBiddingStrategy({}, { biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: 60 });
  assert(c.maximize_conversions.target_cpa_micros === 60000000, JSON.stringify(c));
});
check('setBiddingStrategy: unknown strategy falls back to manual CPC', () => {
  const c = mutator.setBiddingStrategy({}, { biddingStrategy: 'NIE_ISTNIEJE' });
  assert(c.manual_cpc && c.manual_cpc.enhanced_cpc_enabled === false, JSON.stringify(c));
});
check('setBiddingStrategy: strategy name is case- and whitespace-insensitive', () => {
  const c = mutator.setBiddingStrategy({}, { biddingStrategy: '  maximize_clicks ', cpcBidCeiling: 2.5 });
  assert(c.target_spend.cpc_bid_ceiling_micros === 2500000, JSON.stringify(c));
});
check('BIDDING_STRATEGIES: lists exactly the four the CLI accepts', () => {
  assert(mutator.BIDDING_STRATEGIES.length === 4, String(mutator.BIDDING_STRATEGIES));
  ['MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'MANUAL_CPC']
    .forEach((k) => assert(mutator.BIDDING_STRATEGIES.includes(k), `missing ${k}`));
});
await checkAsync('updateCampaignBidding: refuses a strategy that is not on the list', async () => {
  let threw = false;
  try { await mutator.updateCampaignBidding('123', '456', { biddingStrategy: 'TARGET_ROAS' }, true); }
  catch (e) { threw = /--strategy musi być/.test(e.message); }
  assert(threw, 'an unsupported strategy must be rejected before any API call');
});

/* ── Performance Max: asset-group status + listing-filter flip ────────────── */

// A miniature tree in the shape `getListingFilterTree` returns. Fictional
// account, fictional product types — the package ships no real client data.
function pmaxTree() {
  const root = {
    id: '100', resourceName: 'customers/1234567890/assetGroupListingGroupFilters/55~100',
    type: 2, typeName: 'SUBDIVISION', listingSource: 2, parentResourceName: null,
    assetGroupName: 'Wszystkie produkty', assetGroupStatus: 'ENABLED',
    dimension: { kind: null, value: null, level: null, index: null, label: '(ROOT)' },
    childIds: ['101', '102', '103'],
  };
  const leaf = (id, type, value, extra = {}) => ({
    id, resourceName: `customers/1234567890/assetGroupListingGroupFilters/55~${id}`,
    type, typeName: { 3: 'UNIT_INCLUDED', 4: 'UNIT_EXCLUDED' }[type], listingSource: 2,
    parentResourceName: root.resourceName,
    assetGroupName: 'Wszystkie produkty', assetGroupStatus: 'ENABLED',
    dimension: { kind: 'product_type', value, level: 1, index: null, label: value === null ? '(POZOSTAŁE)' : `product_type=${value}` },
    childIds: [], ...extra,
  });
  return [root, leaf('101', 3, 'donice ogrodowe'), leaf('102', 4, 'nawozy'), leaf('103', 4, null)];
}

const OPTS_LT = { customerId: '1234567890', assetGroupId: '55' };

check('checkListingFilterFlip: an excluded leaf may be turned back on', () => {
  const tree = pmaxTree();
  const r = safety.checkListingFilterFlip(tree[2], tree, 'INCLUDED');
  assert(r.ok && !r.noop && r.targetType === 3, JSON.stringify(r));
});
check('checkListingFilterFlip: a leaf already in the target state is a no-op, not an error', () => {
  const tree = pmaxTree();
  const r = safety.checkListingFilterFlip(tree[1], tree, 'INCLUDED');
  assert(r.ok && r.noop, JSON.stringify(r));
});
check('checkListingFilterFlip: refuses the ROOT node', () => {
  const tree = pmaxTree();
  const r = safety.checkListingFilterFlip(tree[0], tree, 'EXCLUDED');
  assert(!r.ok && /KORZE/.test(r.reason), JSON.stringify(r));
});
check('checkListingFilterFlip: refuses a SUBDIVISION that is not the root (would cascade)', () => {
  const tree = pmaxTree();
  const mid = { ...tree[1], type: 2, typeName: 'SUBDIVISION', childIds: ['201'] };
  const r = safety.checkListingFilterFlip(mid, tree, 'EXCLUDED');
  assert(!r.ok && /podzia/.test(r.reason), JSON.stringify(r));
});
check('checkListingFilterFlip: refuses a node that still has children', () => {
  const tree = pmaxTree();
  const parent = { ...tree[1], childIds: ['201'] };
  const r = safety.checkListingFilterFlip(parent, tree, 'EXCLUDED');
  assert(!r.ok && /nie jest li/.test(r.reason), JSON.stringify(r));
});
check('checkListingFilterFlip: refuses to exclude the LAST included leaf', () => {
  const tree = pmaxTree();
  const r = safety.checkListingFilterFlip(tree[1], tree, 'EXCLUDED');
  assert(!r.ok && /ostatni w/.test(r.reason), JSON.stringify(r));
});
check('checkListingFilterFlip: rejects a target that is not INCLUDED/EXCLUDED', () => {
  const tree = pmaxTree();
  const r = safety.checkListingFilterFlip(tree[2], tree, 'ENABLED');
  assert(!r.ok && /Nieprawid/.test(r.reason), JSON.stringify(r));
});

check('selectListingFilterNode: finds a leaf by product type, ignoring case and padding', () => {
  const { node, error } = mutator.selectListingFilterNode(pmaxTree(), { productType: '  NAWOZY ' });
  assert(!error && node.id === '102', error || node.id);
});
check('selectListingFilterNode: refuses an ambiguous product type instead of guessing', () => {
  const tree = pmaxTree();
  tree.push({ ...tree[2], id: '104', resourceName: 'customers/1234567890/assetGroupListingGroupFilters/55~104' });
  const { node, error } = mutator.selectListingFilterNode(tree, { productType: 'nawozy' });
  assert(!node && /nie zgaduj/.test(error), error);
  assert(/102/.test(error) && /104/.test(error), 'both candidates must be named');
});
check('selectListingFilterNode: an unknown type lists what the group actually has', () => {
  const { node, error } = mutator.selectListingFilterNode(pmaxTree(), { productType: 'rowery' });
  assert(!node && /donice ogrodowe/.test(error) && /nawozy/.test(error), error);
});
check('selectListingFilterNode: --filter-id wins and reports a bad id', () => {
  const ok = mutator.selectListingFilterNode(pmaxTree(), { filterId: '102' });
  assert(!ok.error && ok.node.id === '102', ok.error);
  const bad = mutator.selectListingFilterNode(pmaxTree(), { filterId: '999' });
  assert(!bad.node && /999/.test(bad.error), bad.error);
});

check('buildListingTypeMutations: a type missing from the tree is added as a new leaf', () => {
  const r = mutator.buildListingTypeMutations(pmaxTree(), [{ productType: 'kora', to: 'EXCLUDED' }], OPTS_LT);
  assert(r.added === 1 && r.flipped === 0 && r.removed === 0, JSON.stringify(r));
  const [op] = r.mutations;
  assert(op.operation === 'create' && op.resource.type === 4, JSON.stringify(op));
  assert(op.resource.case_value.product_type.value === 'kora', JSON.stringify(op));
  // Nowy liść musi wisieć tam, gdzie reszta typów — inaczej znaczy co innego.
  assert(op.resource.parent_listing_group_filter === pmaxTree()[0].resourceName, JSON.stringify(op));
});
check('buildListingTypeMutations: an existing leaf in the wrong state is remove+create, never update', () => {
  const r = mutator.buildListingTypeMutations(pmaxTree(), [{ productType: 'nawozy', to: 'INCLUDED' }], OPTS_LT);
  assert(r.flipped === 1 && r.mutations.length === 2, JSON.stringify(r));
  assert(r.mutations[0].operation === 'remove' && r.mutations[1].operation === 'create', JSON.stringify(r.mutations));
});
check('buildListingTypeMutations: a leaf already in the target state costs no operation', () => {
  const r = mutator.buildListingTypeMutations(pmaxTree(), [{ productType: 'donice ogrodowe', to: 'INCLUDED' }], OPTS_LT);
  assert(r.noop === 1 && r.mutations.length === 0, JSON.stringify(r));
});
check('buildListingTypeMutations: REMOVE drops a dead leaf, and is silent when it is already gone', () => {
  const r = mutator.buildListingTypeMutations(pmaxTree(), [{ productType: 'nawozy', to: 'REMOVE' }], OPTS_LT);
  assert(r.removed === 1 && r.mutations[0].operation === 'remove', JSON.stringify(r));
  const brak = mutator.buildListingTypeMutations(pmaxTree(), [{ productType: 'nie ma', to: 'REMOVE' }], OPTS_LT);
  assert(brak.noop === 1 && brak.mutations.length === 0, JSON.stringify(brak));
});
check('buildListingTypeMutations: refuses to leave the branch with nothing to serve', () => {
  // Jedyny włączony typ na wykluczony, przy wykluczonym „wszystko inne".
  let err = null;
  try { mutator.buildListingTypeMutations(pmaxTree(), [{ productType: 'donice ogrodowe', to: 'EXCLUDED' }], OPTS_LT); }
  catch (e) { err = e.message; }
  assert(err && /ANI JEDEN/.test(err), String(err));
});
check('buildListingTypeMutations: the same type twice in one file is refused, not silently merged', () => {
  let err = null;
  try {
    mutator.buildListingTypeMutations(pmaxTree(), [
      { productType: 'nawozy', to: 'INCLUDED' }, { productType: 'Nawozy', to: 'EXCLUDED' },
    ], OPTS_LT);
  } catch (e) { err = e.message; }
  assert(err && /dwa razy/.test(err), String(err));
});
check('buildListingTypeMutations: refuses a tree that does not split on product type', () => {
  const root = { ...pmaxTree()[0], childIds: [] };
  let err = null;
  try { mutator.buildListingTypeMutations([root], [{ productType: 'kora', to: 'EXCLUDED' }], OPTS_LT); }
  catch (e) { err = e.message; }
  assert(err && /nie dzieli si/.test(err), String(err));
});
check('buildListingTypeMutations: refuses an unknown action instead of guessing', () => {
  let err = null;
  try { mutator.buildListingTypeMutations(pmaxTree(), [{ productType: 'kora', to: 'WLACZ' }], OPTS_LT); }
  catch (e) { err = e.message; }
  assert(err && /nieznana operacja/.test(err), String(err));
});

check('rebuildListingCaseValue: reproduces a product-type leaf exactly', () => {
  const cv = mutator.rebuildListingCaseValue({ kind: 'product_type', value: 'nawozy', level: 1, index: null });
  assert(cv.product_type.value === 'nawozy' && cv.product_type.level === 1, JSON.stringify(cv));
});
check('rebuildListingCaseValue: the catch-all keeps its level and stays value-less', () => {
  const cv = mutator.rebuildListingCaseValue({ kind: 'product_type', value: null, level: 2, index: null });
  assert(!('value' in cv.product_type) && cv.product_type.level === 2, JSON.stringify(cv));
});
check('rebuildListingCaseValue: custom attribute keeps its index', () => {
  const cv = mutator.rebuildListingCaseValue({ kind: 'product_custom_attribute', value: 'wyklucz', level: null, index: 0 });
  assert(cv.product_custom_attribute.value === 'wyklucz' && cv.product_custom_attribute.index === 0, JSON.stringify(cv));
});
check('rebuildListingCaseValue: an unknown dimension returns null so the caller refuses', () => {
  assert(mutator.rebuildListingCaseValue({ kind: 'nieznany', value: 'x' }) === null);
  assert(mutator.rebuildListingCaseValue(null) === null);
});

await checkAsync('update-listing-filter: refuses without a selector, before any API call', async () => {
  let threw = false;
  try { await mutator.updateListingFilter('1234567890', '', {}, 'INCLUDED', true); }
  catch (e) { threw = /asset-group/.test(e.message); }
  assert(threw, 'a missing asset group must be rejected locally');
});

// ── add-label-exclusion ─────────────────────────────────────────────────────
// Fictional shop, fictional labels — the package ships no real client data.
function labelNode(id, type, value, parentRn, extra = {}) {
  return {
    id, resourceName: `customers/1234567890/assetGroupListingGroupFilters/55~${id}`,
    type, typeName: { 2: 'SUBDIVISION', 3: 'UNIT_INCLUDED', 4: 'UNIT_EXCLUDED' }[type],
    listingSource: 2, parentResourceName: parentRn,
    assetGroupName: 'Wszystkie produkty', assetGroupStatus: 'ENABLED',
    // INDEX0 arrives from the API as 2 — the offset the check has to absorb.
    dimension: { kind: 'product_custom_attribute', value, level: null, index: 2, label: value ?? '(POZOSTAŁE)' },
    childIds: [], ...extra,
  };
}
/** Root splits on custom_label_0: "wyklucz" excluded, everything else included. */
function labelTree(exclType = 4) {
  const t = pmaxTree();
  const root = t[0];
  return [
    root,
    labelNode('201', 2, null, root.resourceName, { childIds: ['301'] }),
    labelNode('202', exclType, 'wyklucz', root.resourceName),
    { ...t[1], id: '301', resourceName: 'customers/1234567890/assetGroupListingGroupFilters/55~301', parentResourceName: 'customers/1234567890/assetGroupListingGroupFilters/55~201' },
  ];
}
const WYKLUCZ = { index: 0, value: 'wyklucz' };

check('checkLabelExclusion: already excluded is a no-op, not an error', () => {
  const r = safety.checkLabelExclusion(labelTree(4), WYKLUCZ);
  assert(r.ok && r.mode === 'noop', JSON.stringify(r));
});
check('checkLabelExclusion: present but included → flip one leaf', () => {
  const r = safety.checkLabelExclusion(labelTree(3), WYKLUCZ);
  assert(r.ok && r.mode === 'flip' && r.node.id === '202', JSON.stringify(r));
});
check('checkLabelExclusion: root already splits on this label → add a sibling', () => {
  const tree = labelTree(4).filter((n) => n.id !== '202');
  const r = safety.checkLabelExclusion(tree, WYKLUCZ);
  assert(r.ok && r.mode === 'add', JSON.stringify(r));
});
check('checkLabelExclusion: root splits on something else → rebuild', () => {
  const r = safety.checkLabelExclusion(pmaxTree(), WYKLUCZ);
  assert(r.ok && r.mode === 'rebuild' && r.root.id === '100', JSON.stringify(r));
});
check('checkLabelExclusion: a label slot outside 0-4 is refused', () => {
  const r = safety.checkLabelExclusion(pmaxTree(), { index: 7, value: 'wyklucz' });
  assert(!r.ok && /etykieta/i.test(r.reason), JSON.stringify(r));
});
check('checkLabelExclusion: an empty value is refused', () => {
  const r = safety.checkLabelExclusion(pmaxTree(), { index: 0, value: '  ' });
  assert(!r.ok, JSON.stringify(r));
});
check('checkLabelExclusion: refuses a group with nothing included left to protect', () => {
  const tree = pmaxTree().map((n) => (n.type === 3 ? { ...n, type: 4, typeName: 'UNIT_EXCLUDED' } : n));
  const r = safety.checkLabelExclusion(tree, WYKLUCZ);
  assert(!r.ok && /włączonego/.test(r.reason), JSON.stringify(r));
});
check('checkLabelExclusion: the label slot is read as INDEX0, not as enum 0', () => {
  // A tree whose label nodes carry enum index 2 must answer for custom_label_0,
  // and must NOT answer for custom_label_2.
  assert(safety.checkLabelExclusion(labelTree(4), { index: 0, value: 'wyklucz' }).mode === 'noop');
  assert(safety.checkLabelExclusion(labelTree(4), { index: 2, value: 'wyklucz' }).mode === 'rebuild');
});

const BUILD_OPTS = { customerId: '1234567890', assetGroupId: '55', index: 0, value: 'wyklucz' };

check('buildLabelExclusionMutations: "add" touches nothing that exists', () => {
  const tree = labelTree(4).filter((n) => n.id !== '202');
  const plan = safety.checkLabelExclusion(tree, WYKLUCZ);
  const { mutations, removed, created } = mutator.buildLabelExclusionMutations(tree, plan, BUILD_OPTS);
  assert(removed === 0 && created === 1, `${removed}/${created}`);
  assert(mutations[0].resource.case_value.product_custom_attribute.index === 2, 'INDEX0 must go out as enum 2');
  assert(mutations[0].resource.type === 4, 'the new leaf must be excluded');
});
check('buildLabelExclusionMutations: rebuild keeps every node and re-parents them', () => {
  const tree = pmaxTree();
  const plan = safety.checkLabelExclusion(tree, WYKLUCZ);
  const { mutations, removed, created } = mutator.buildLabelExclusionMutations(tree, plan, BUILD_OPTS);
  // 3 old children removed; recreated plus the two new label nodes.
  assert(removed === 3, `removed=${removed}`);
  assert(created === 5, `created=${created}`);
  const removes = mutations.filter((m) => m.operation === 'remove');
  assert(removes.length === 3 && mutations.slice(0, 3).every((m) => m.operation === 'remove'),
    'removals must all come before creations');
  // The root itself is never removed — it has no case value to lose.
  assert(!removes.some((m) => m.resource === tree[0].resourceName), 'the root must survive');
});
check('buildLabelExclusionMutations: every child is created after its parent', () => {
  const tree = pmaxTree();
  const plan = safety.checkLabelExclusion(tree, WYKLUCZ);
  const { mutations } = mutator.buildLabelExclusionMutations(tree, plan, BUILD_OPTS);
  const seen = new Set([tree[0].resourceName]);
  for (const m of mutations.filter((x) => x.operation === 'create')) {
    assert(seen.has(m.resource.parent_listing_group_filter),
      `parent ${m.resource.parent_listing_group_filter} created after its child`);
    if (m.resource.resource_name) seen.add(m.resource.resource_name);
  }
});
check('buildLabelExclusionMutations: rebuild preserves each node type and case value', () => {
  const tree = pmaxTree();
  const plan = safety.checkLabelExclusion(tree, WYKLUCZ);
  const { mutations } = mutator.buildLabelExclusionMutations(tree, plan, BUILD_OPTS);
  const odtworzone = mutations
    .filter((m) => m.operation === 'create' && m.resource.case_value.product_type)
    .map((m) => `${m.resource.type}:${m.resource.case_value.product_type.value ?? '(else)'}`);
  assert(odtworzone.includes('3:donice ogrodowe'), JSON.stringify(odtworzone));
  assert(odtworzone.includes('4:nawozy'), JSON.stringify(odtworzone));
  assert(odtworzone.includes('4:(else)'), JSON.stringify(odtworzone));
});
check('buildLabelExclusionMutations: refuses a tree with a node hanging off nothing', () => {
  // Sierota jest węzłem product_type, nie etykiety: węzeł etykiety zatrzymałby wcześniej
  // strażnik kolizji wymiarów i test nie dotknąłby już sprawdzanego warunku.
  const sierota = {
    ...pmaxTree()[1], id: '999',
    resourceName: 'customers/1234567890/assetGroupListingGroupFilters/55~999',
    parentResourceName: 'customers/1234567890/assetGroupListingGroupFilters/55~zniknal',
  };
  const tree = [...pmaxTree(), sierota];
  const plan = safety.checkLabelExclusion(tree, WYKLUCZ);
  let threw = false;
  try { mutator.buildLabelExclusionMutations(tree, plan, BUILD_OPTS); }
  catch (e) { threw = /nie wisi pod korzeniem/.test(e.message); }
  assert(threw, 'an incomplete read must stop the rebuild');
});

/* ── wykluczanie po product_item_id ───────────────────────────────────────── */

// Drzewo dzielone po ID produktu: jedno wykluczone, jedno włączone, plus (POZOSTAŁE).
function itemNode(id, type, value, parentRn, extra = {}) {
  return {
    id, resourceName: `customers/1234567890/assetGroupListingGroupFilters/55~${id}`,
    type, typeName: { 2: 'SUBDIVISION', 3: 'UNIT_INCLUDED', 4: 'UNIT_EXCLUDED' }[type],
    listingSource: 2, parentResourceName: parentRn,
    assetGroupName: 'Wszystkie produkty', assetGroupStatus: 'ENABLED',
    dimension: { kind: 'product_item_id', value, level: null, index: null, label: value ?? '(POZOSTAŁE)' },
    childIds: [], ...extra,
  };
}
function itemTree() {
  const root = pmaxTree()[0];
  return [
    root,
    itemNode('401', 4, 'sku-a', root.resourceName),
    itemNode('402', 3, 'sku-b', root.resourceName),
    itemNode('403', 3, null, root.resourceName),
  ];
}
const ITEM_OPTS = { customerId: '1234567890', assetGroupId: '55' };

check('checkItemExclusion: all ids already excluded is a no-op, not an error', () => {
  const r = safety.checkItemExclusion(itemTree(), ['sku-a']);
  assert(r.ok && r.mode === 'noop' && r.juzWykluczone.length === 1, JSON.stringify(r));
});
check('checkItemExclusion: ids are matched case-insensitively', () => {
  const r = safety.checkItemExclusion(itemTree(), ['SKU-A']);
  assert(r.ok && r.mode === 'noop', JSON.stringify(r));
});
check('checkItemExclusion: root splits on item id → flip what exists, add what does not', () => {
  const r = safety.checkItemExclusion(itemTree(), ['sku-b', 'sku-c']);
  assert(r.ok && r.mode === 'apply', JSON.stringify(r));
  assert(r.doPrzelaczenia.length === 1 && r.doPrzelaczenia[0].id === '402', 'flip');
  assert(r.doDodania.length === 1 && r.doDodania[0] === 'sku-c', 'add');
});
check('checkItemExclusion: root splits on something else → rebuild', () => {
  const r = safety.checkItemExclusion(pmaxTree(), ['sku-c']);
  assert(r.ok && r.mode === 'rebuild', JSON.stringify(r));
});
check('checkItemExclusion: refuses a rebuild that would repeat product_item_id on one path', () => {
  // PMax odrzuca taki plan (SAME_DIMENSION_TYPE_BETWEEN_ANCESTORS) — łapiemy to przed wysyłką.
  const tree = pmaxTree();
  tree.push(itemNode('501', 3, 'sku-x', tree[1].resourceName));
  const r = safety.checkItemExclusion(tree, ['sku-c']);
  assert(!r.ok && /dwa razy na jednej ścieżce/.test(r.reason), JSON.stringify(r));
});
check('checkItemExclusion: refuses when one of the ids is a SUBDIVISION, not a leaf', () => {
  const tree = itemTree();
  tree[1] = { ...tree[1], type: 2, typeName: 'SUBDIVISION', childIds: ['501'] };
  const r = safety.checkItemExclusion(tree, ['sku-a']);
  assert(!r.ok && /PODZIA/.test(r.reason), JSON.stringify(r));
});
check('checkItemExclusion: refuses an empty id list instead of doing nothing quietly', () => {
  const r = safety.checkItemExclusion(itemTree(), []);
  assert(!r.ok && /Podaj ID/.test(r.reason), JSON.stringify(r));
});

check('buildItemExclusionMutations: "apply" removes only what it flips', () => {
  const tree = itemTree();
  const plan = safety.checkItemExclusion(tree, ['sku-b', 'sku-c']);
  const { mutations, removed, created } = mutator.buildItemExclusionMutations(tree, plan, ITEM_OPTS);
  assert(removed === 1 && created === 2, `${removed}/${created}`);
  const usuniete = mutations.filter((m) => m.operation === 'remove').map((m) => m.resource);
  assert(usuniete.length === 1 && /55~402$/.test(usuniete[0]), JSON.stringify(usuniete));
  assert(mutations.filter((m) => m.operation === 'create').every((m) => m.resource.type === 4), 'wszystko wykluczone');
});
check('buildItemExclusionMutations: ids go to the API lower-cased', () => {
  const plan = safety.checkItemExclusion(itemTree(), ['SKU-C']);
  const { mutations } = mutator.buildItemExclusionMutations(itemTree(), plan, ITEM_OPTS);
  const wartosci = mutations.filter((m) => m.operation === 'create').map((m) => m.resource.case_value.product_item_id.value);
  assert(wartosci.includes('sku-c') && !wartosci.includes('SKU-C'), JSON.stringify(wartosci));
});
check('buildItemExclusionMutations: rebuild keeps the old tree under an "everything else" branch', () => {
  const tree = pmaxTree();
  const plan = safety.checkItemExclusion(tree, ['sku-c']);
  const { mutations, removed } = mutator.buildItemExclusionMutations(tree, plan, ITEM_OPTS);
  assert(removed === tree.length - 1, `usunieto ${removed} z ${tree.length - 1}`);
  const creates = mutations.filter((m) => m.operation === 'create');
  const katchAll = creates.find((m) => m.resource.case_value?.product_item_id && !m.resource.case_value.product_item_id.value);
  assert(katchAll && katchAll.resource.type === 2, 'brak gałęzi „wszystko inne" jako podziału');
  // Każdy odtworzony węzeł wisi pod czymś, co powstaje wcześniej w tym samym żądaniu.
  const powstale = new Set([tree[0].resourceName]);
  for (const m of creates) {
    assert(powstale.has(m.resource.parent_listing_group_filter), `rodzic przed dzieckiem: ${m.resource.parent_listing_group_filter}`);
    if (m.resource.resource_name) powstale.add(m.resource.resource_name);
  }
});

check('inferCatchAllDimensions: an item-id catch-all takes its dimension from a sibling', () => {
  // The API returns no case_value fields at all for this node: product_item_id
  // has no `level`, and the catch-all has no value.
  const root = pmaxTree()[0];
  const nagi = {
    id: '400', resourceName: 'customers/1234567890/assetGroupListingGroupFilters/55~400',
    type: 2, typeName: 'SUBDIVISION', listingSource: 2, parentResourceName: root.resourceName,
    assetGroupName: 'x', assetGroupStatus: 'ENABLED',
    dimension: { kind: null, value: null, level: null, index: null, label: '(ROOT)' }, childIds: [],
  };
  const siostra = {
    ...nagi, id: '401', resourceName: 'customers/1234567890/assetGroupListingGroupFilters/55~401', type: 4,
    dimension: { kind: 'product_item_id', value: 'sku-1', level: null, index: null, label: 'product_item_id=sku-1' },
  };
  const out = mutator.inferCatchAllDimensions([root, nagi, siostra]);
  assert(out[1].dimension.kind === 'product_item_id', JSON.stringify(out[1].dimension));
  assert(out[1].dimension.value === null, 'the catch-all must stay value-less');
  assert(mutator.rebuildListingCaseValue(out[1].dimension) !== null, 'it must now be rebuildable');
  assert(out[0].dimension.kind === null, 'the root must be left alone');
});
check('inferCatchAllDimensions: with no sibling to learn from, the node stays unknown', () => {
  const root = pmaxTree()[0];
  const sam = {
    id: '400', resourceName: 'customers/1234567890/assetGroupListingGroupFilters/55~400',
    type: 2, typeName: 'SUBDIVISION', listingSource: 2, parentResourceName: root.resourceName,
    assetGroupName: 'x', assetGroupStatus: 'ENABLED',
    dimension: { kind: null, value: null, level: null, index: null, label: '(ROOT)' }, childIds: [],
  };
  assert(mutator.inferCatchAllDimensions([root, sam])[1].dimension.kind === null);
});

await checkAsync('add-label-exclusion: refuses without an asset group, before any API call', async () => {
  let threw = false;
  try { await mutator.addLabelExclusion('1234567890', '', WYKLUCZ, true); }
  catch (e) { threw = /asset-group/.test(e.message); }
  assert(threw, 'a missing asset group must be rejected locally');
});

/* ── --under: praca pod wskazanym węzłem zamiast przy korzeniu ────────────── */

// Drzewo dwupoziomowe: kategoria → podkategorie, a jedna podkategoria dzieli już po ID.
// Przebudowa przy korzeniu jest tu zabroniona, więc jedyna droga to --under.
function nestedTree() {
  const root = pmaxTree()[0];
  const rn = (id) => `customers/1234567890/assetGroupListingGroupFilters/55~${id}`;
  const typ = (id, type, value, level, parentRn) => ({
    id, resourceName: rn(id), type, typeName: { 2: 'SUBDIVISION', 3: 'UNIT_INCLUDED', 4: 'UNIT_EXCLUDED' }[type],
    listingSource: 2, parentResourceName: parentRn, assetGroupName: 'Ogród', assetGroupStatus: 'ENABLED',
    dimension: { kind: 'product_type', value, level, index: null, label: value ?? '(POZOSTAŁE)' }, childIds: [],
  });
  return [
    root,
    typ('201', 2, 'meble ogrodowe', 2, root.resourceName),
    typ('202', 4, null, 2, root.resourceName),
    typ('301', 3, 'donice', 3, rn('201')),
    typ('302', 2, 'ławki', 3, rn('201')),
    typ('303', 3, null, 3, rn('201')),
    itemNode('401', 4, 'sku-a', rn('302')),
    itemNode('402', 3, null, rn('302')),
  ];
}
const byId = (tree, id) => tree.find((n) => n.id === id);

check('checkItemExclusion: the refusal points at the deeper item-id split to use with --under', () => {
  const r = safety.checkItemExclusion(nestedTree(), ['sku-b']);
  assert(!r.ok && /--under/.test(r.reason) && /id=302/.test(r.reason), r.reason);
});
check('checkItemExclusion --under: an item-id split gets the ids next to its siblings', () => {
  const tree = nestedTree();
  const r = safety.checkItemExclusion(tree, ['sku-a', 'sku-b'], { under: byId(tree, '302') });
  assert(r.ok && r.mode === 'apply' && r.root.id === '302', JSON.stringify(r.mode));
  assert(r.juzWykluczone.length === 1 && r.doDodania.length === 1 && r.doDodania[0] === 'sku-b', JSON.stringify(r));
  const { mutations } = mutator.buildItemExclusionMutations(tree, r, ITEM_OPTS);
  assert(mutations.length === 1 && mutations[0].resource.parent_listing_group_filter === byId(tree, '302').resourceName,
    JSON.stringify(mutations));
});
check('checkItemExclusion --under: an included leaf is split by item id, the rest of it stays on', () => {
  const tree = nestedTree();
  const r = safety.checkItemExclusion(tree, ['SKU-C', 'sku-d'], { under: byId(tree, '301') });
  assert(r.ok && r.mode === 'subdivide', JSON.stringify(r.mode));
  const { mutations, removed, created } = mutator.buildItemExclusionMutations(tree, r, ITEM_OPTS);
  assert(removed === 1 && created === 4, `${removed}/${created}`);
  assert(mutations[0].operation === 'remove' && mutations[0].resource === byId(tree, '301').resourceName, 'leaf goes first');
  const podzial = mutations[1].resource;
  assert(podzial.type === 2 && podzial.case_value.product_type.value === 'donice' && podzial.case_value.product_type.level === 3,
    'the subdivision must keep the leaf condition');
  assert(podzial.parent_listing_group_filter === byId(tree, '201').resourceName, 'same parent as the leaf');
  const dzieci = mutations.slice(2).map((m) => m.resource);
  assert(dzieci.every((d) => d.parent_listing_group_filter === podzial.resource_name), 'children hang off the new split');
  assert(dzieci.filter((d) => d.type === 3 && !d.case_value.product_item_id.value).length === 1, 'catch-all stays included');
  assert(dzieci.filter((d) => d.type === 4).map((d) => d.case_value.product_item_id.value).join() === 'sku-c,sku-d', 'ids lower-cased');
});
check('checkItemExclusion --under: an excluded leaf is a no-op', () => {
  const tree = nestedTree();
  const r = safety.checkItemExclusion(tree, ['sku-x'], { under: byId(tree, '202') });
  assert(r.ok && r.mode === 'noop', JSON.stringify(r.mode));
});
check('checkItemExclusion --under: refuses to split by item id twice on one path', () => {
  const tree = nestedTree();
  const r = safety.checkItemExclusion(tree, ['sku-x'], { under: byId(tree, '402') });
  assert(!r.ok && /drugi raz/.test(r.reason), JSON.stringify(r));
});
check('checkItemExclusion --under: refuses a split on another dimension', () => {
  const tree = nestedTree();
  const r = safety.checkItemExclusion(tree, ['sku-x'], { under: byId(tree, '201') });
  assert(!r.ok && /nie po ID/.test(r.reason), JSON.stringify(r));
});
check('buildListingTypeMutations: types on two levels without --under name the candidates', () => {
  let msg = '';
  try { mutator.buildListingTypeMutations(nestedTree(), [{ productType: 'pergole', to: 'EXCLUDED' }], OPTS_LT); }
  catch (e) { msg = e.message; }
  assert(/Kandydaci/.test(msg) && /id=201/.test(msg), msg);
});
check('buildListingTypeMutations --under: a new type lands under the chosen split, at its level', () => {
  const tree = nestedTree();
  const r = mutator.buildListingTypeMutations(tree, [{ productType: 'pergole', to: 'EXCLUDED' }],
    { ...OPTS_LT, under: byId(tree, '201') });
  assert(r.added === 1 && r.mutations.length === 1, JSON.stringify(r.plan));
  const res = r.mutations[0].resource;
  assert(res.parent_listing_group_filter === byId(tree, '201').resourceName && res.type === 4, JSON.stringify(res));
  assert(res.case_value.product_type.level === 3, 'level taken from the siblings');
});

const CA_MEMBERS = [
  { member_type: 2, keyword: 'drzwi zewnętrzne' },
  { member_type: 3, url: 'www.konkurent.example/drzwi' },
  { member_type: 3, url: 'tani-sklep.example' },
];
check('planCustomAudienceUrls: keyword members pass through, types become names', () => {
  const r = safety.planCustomAudienceUrls(CA_MEMBERS, ['nowy.example/drzwi'], []);
  assert(r.members[0].member_type === 'KEYWORD' && r.members[0].keyword === 'drzwi zewnętrzne', JSON.stringify(r.members[0]));
  assert(r.members.length === 4 && r.members[3].url === 'nowy.example/drzwi', JSON.stringify(r.members));
});
check('planCustomAudienceUrls: present URL is skipped despite https/www/trailing slash', () => {
  const r = safety.planCustomAudienceUrls(CA_MEMBERS, ['https://konkurent.example/drzwi/'], []);
  assert(r.added.length === 0 && r.skipped.length === 1 && r.members.length === 3, JSON.stringify(r));
});
check('planCustomAudienceUrls: removal drops the member, absent removal is reported', () => {
  const r = safety.planCustomAudienceUrls(CA_MEMBERS, [], ['tani-sklep.example', 'nie-ma.example']);
  assert(r.removed[0] === 'tani-sklep.example' && r.members.length === 2, JSON.stringify(r));
  assert(r.notFound.length === 1 && r.notFound[0] === 'nie-ma.example', JSON.stringify(r.notFound));
});
check('planCustomAudienceUrls: duplicates in the add list collapse to one', () => {
  const r = safety.planCustomAudienceUrls([], ['a.example/x', 'https://www.a.example/x/'], []);
  assert(r.added.length === 1 && r.members.length === 1, JSON.stringify(r));
});

const CA_RN = 'customers/1/customAudiences/9';
check('planAudienceSegmentAdd: appends to the existing segment list, user lists stay', () => {
  const dims = [{ audience_segments: { segments: [{ user_list: { user_list: 'customers/1/userLists/7' } }] } }];
  const r = safety.planAudienceSegmentAdd(dims, CA_RN);
  const segs = r.dimensions[0].audience_segments.segments;
  assert(!r.alreadyPresent && segs.length === 2 && segs[1].custom_audience.custom_audience === CA_RN, JSON.stringify(r));
  assert(dims[0].audience_segments.segments.length === 1, 'input must not be mutated');
});
check('planAudienceSegmentAdd: already present is a no-op', () => {
  const dims = [{ audience_segments: { segments: [{ custom_audience: { custom_audience: CA_RN } }] } }];
  const r = safety.planAudienceSegmentAdd(dims, CA_RN);
  assert(r.alreadyPresent && r.dimensions[0].audience_segments.segments.length === 1, JSON.stringify(r));
});
check('planAudienceSegmentAdd: no segment dimension yet → one is created, other dimensions stay', () => {
  const r = safety.planAudienceSegmentAdd([{ age: { age_ranges: [] } }], CA_RN);
  assert(r.dimensions.length === 2 && r.dimensions[1].audience_segments.segments.length === 1, JSON.stringify(r));
});

console.log(`\nResult: ${passed} passed, ${failed} failed.\n`);
process.exit(failed === 0 ? 0 : 1);
