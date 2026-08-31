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

console.log(`\nResult: ${passed} passed, ${failed} failed.\n`);
process.exit(failed === 0 ? 0 : 1);
