#!/usr/bin/env node

import { writeFileSync } from 'fs';
import path from 'path';
import { getApiClient } from './client.js';
import {
  listAccounts,
  listAccessibleAccounts,
  getCampaigns,
  getKeywords,
  getSearchTerms,
  getPmaxSearchTerms,
  getKeywordIdeas,
  getBudgets,
  runRawQuery,
  getAccountTimezone,
} from './queries.js';
import {
  updateCampaignStatus,
  updateCampaignBudget,
  addCampaignNegativeKeywords,
  addAccountNegativePlacements,
} from './mutator.js';
import { resolveAccount, loadAccounts } from './accounts.js';
import { rowsToCsv } from './csv.js';
import { chooseOutputMode, defaultCsvPath, DEFAULT_INLINE_THRESHOLD } from './output.js';
import { DEFAULT_MAX_BUDGET_CHANGE_PCT } from './safety.js';

const PREVIEW_ROWS = 10;

// Parse command line arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  if (arg.startsWith('--')) {
    const [key, ...val] = arg.slice(2).split('=');
    acc[key] = val.length ? val.join('=') : true;
  }
  return acc;
}, {});

/**
 * Resolve the target account. `--account` or `--customer` may be a friendly
 * name/alias/slug from .claude/accounts.json, or a raw 10-digit ID. Returns the
 * customer ID plus the account's login_customer_id and timezone when known.
 */
function resolveTarget() {
  const selector = args.account || args.customer;
  const rec = resolveAccount(selector);
  if (rec) {
    return {
      customerId: rec.id,
      loginCustomerId: args['login-customer-id'] || rec.login_customer_id,
      timezone: rec.timezone,
      name: rec.name,
    };
  }
  return {
    customerId: selector, // may be undefined → falls back to config default
    loginCustomerId: args['login-customer-id'],
    timezone: undefined,
    name: undefined,
  };
}

/** Write rows to a CSV file and print a small JSON summary + preview. */
function writeCsvSummary(rows, file, action) {
  const target = path.resolve(file || defaultCsvPath(action));
  writeFileSync(target, rowsToCsv(rows));
  const columns = rows.length ? Object.keys(rows[0]) : [];
  console.log(JSON.stringify({
    output: target,
    rowCount: rows.length,
    columns,
    preview: rows.slice(0, PREVIEW_ROWS),
  }));
}

/**
 * Emit query results. Precedence:
 *   --json            → always inline JSON (force).
 *   --auto            → row count decides: <= threshold inline JSON, else CSV
 *                       (to --output or a temp file) + a short preview.
 *                       Tune with --max-inline-rows=N (default 500).
 *   --output=FILE     → always CSV to FILE + summary.
 *   (none)            → human-readable table.
 */
function emitRows(rows, prettyFn, action) {
  if (args.json) {
    console.log(JSON.stringify(rows));
    return;
  }
  if (args.auto) {
    const threshold = args['max-inline-rows'] ? Number(args['max-inline-rows']) : DEFAULT_INLINE_THRESHOLD;
    const mode = chooseOutputMode(rows.length, { threshold });
    if (mode === 'json') {
      console.log(JSON.stringify(rows));
    } else {
      writeCsvSummary(rows, args.output, action);
    }
    return;
  }
  if (args.output) {
    writeCsvSummary(rows, args.output, action);
    return;
  }
  prettyFn(rows);
}

function printHelp() {
  console.log(`
🚀 --- Google Ads Connector CLI --- 🚀

Sposób użycia:
  node scripts/cli.js --action=<action> [opcje]
  node scripts/cli.js --list-accounts            (konta z .claude/accounts.json)

Akcje odczytu:
  test-connection         Test połączenia z API.
  list-accessible         WSZYSTKIE konta dostępne dla użytkownika: bezpośrednio
                          udostępnione (np. konto klienta spoza MCC) + dzieci
                          każdego MCC. Pokazuje, jaki --login-customer-id użyć.
  list-accounts           Konta klientów pod JEDNYM MCC (z API).
  get-campaigns           Kampanie i statystyki.
  get-keywords            Słowa kluczowe i Quality Score.
  get-search-terms        Hasła wyszukiwania Search (do negatywów).
  get-pmax-search-terms   Hasła wyszukiwania dla Performance Max (--campaign opcjonalnie).
  keyword-ideas           Research słów kluczowych w Keyword Planner (--keywords i/lub --url).
  get-budgets             Aktywne budżety.
  raw-query               Własne zapytanie GAQL (wymaga --query).

Akcje zapisu (zawsze najpierw --dry-run!):
  update-status           Zmiana statusu kampanii (--campaign, --status).
  update-budget           Zmiana budżetu dziennego (--budget-id, --amount).
                          SafetyLimits blokuje skok > ${DEFAULT_MAX_BUDGET_CHANGE_PCT}% — użyj --force, by wymusić.
  add-negatives           Negatywne słowa kluczowe (--campaign, --keywords, --match-type).
  add-negative-placements Wykluczenia miejsc docelowych (--domains).

Opcje:
  --account=<nazwa|alias|ID>  Konto z accounts.json (nazwa/alias) LUB 10-cyfrowe ID.
  --customer=<ID|nazwa>       To samo co --account.
  --login-customer-id=<ID>    MCC nadrzędny (nadpisuje accounts.json / config).
  --days=<n>                  Zakres dni (domyślnie 30; liczony w strefie konta).
  --min-cost=<x>              Minimalny koszt dla get-search-terms.
  --query="<GAQL>"            Zapytanie GAQL (dla raw-query).
  --keywords="a,b"            Słowa-zalążki dla keyword-ideas; lub frazy do add-negatives (po przecinku).
  --match-type=<typ>          OBOWIĄZKOWE dla add-negatives: EXACT | PHRASE | BROAD (wybierz świadomie).
  --url=<https://...>         Strona-zalążek dla keyword-ideas (zamiast/oprócz --keywords).
  --geo=<ID>                  geoTargetConstant dla keyword-ideas (domyślnie 2616 = Polska).
  --language=<ID>             languageConstant dla keyword-ideas (domyślnie 1030 = polski).
  --network=<sieć>            GOOGLE_SEARCH (domyślnie) lub GOOGLE_SEARCH_AND_PARTNERS.
  --page-size=<n>             Limit pomysłów dla keyword-ideas (domyślnie 1000).
  --auto                      Inteligentny output: wynik <= progu → JSON inline;
                              powyżej → CSV (do --output albo pliku tymczasowego) + podgląd.
  --max-inline-rows=<n>       Próg dla --auto (domyślnie ${DEFAULT_INLINE_THRESHOLD}).
  --output=<plik.csv>         WYMUŚ zapis do CSV (omija context window) — zwraca ścieżkę + liczbę wierszy.
  --json                      WYMUŚ czysty JSON na stdout (niezależnie od liczby wierszy).
  --dry-run                   Symulacja mutacji (bez zmian na koncie).
  --force                     Wymuś mutację mimo blokady SafetyLimits (skok budżetu > ${DEFAULT_MAX_BUDGET_CHANGE_PCT}%).

Przykłady:
  node scripts/cli.js --action=list-accessible --auto
  node scripts/cli.js --list-accounts
  node scripts/cli.js --action=get-campaigns --account="Example Client One" --days=30 --auto
  node scripts/cli.js --action=get-search-terms --customer=1234567890 --days=90 --auto --max-inline-rows=1000
  node scripts/cli.js --action=get-pmax-search-terms --customer=1234567890 --days=30 --campaign=987654321 --auto
  node scripts/cli.js --action=keyword-ideas --customer=1234567890 --keywords="buty trekkingowe,buty górskie" --auto
  node scripts/cli.js --action=keyword-ideas --customer=1234567890 --url="https://example.com/sklep" --geo=2616 --language=1030 --auto
  node scripts/cli.js --action=get-campaigns --customer=1234567890 --days=30 --json
  node scripts/cli.js --action=raw-query --account=client-one --query="SELECT campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS" --json
  node scripts/cli.js --action=update-budget --customer=1234567890 --budget-id=111222333 --amount=150.00 --dry-run
`);
}

function printLocalAccounts() {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.log('Brak .claude/accounts.json (lub pusty). Użyj surowych 10-cyfrowych ID przez --customer.');
    return;
  }
  if (args.json) {
    console.log(JSON.stringify(accounts.map(({ _file, ...a }) => a)));
    return;
  }
  console.log(`\n👥 Konta z accounts.json (${accounts.length}):`);
  console.table(accounts.map((a) => ({
    Nazwa: a.name || a.key,
    ID: a.id,
    MCC: a.login_customer_id || '-',
    Waluta: a.currency || '-',
    Strefa: a.timezone || '-',
    Domyślne: a.default ? '✓' : '',
    Aliasy: (a.aliases || []).join(', '),
  })));
}

async function main() {
  const action = args.action;

  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  // --list-accounts as a standalone flag lists the local registry.
  if (args['list-accounts'] && !action) {
    printLocalAccounts();
    process.exit(0);
  }

  if (!action) {
    printHelp();
    process.exit(0);
  }

  const { customerId, loginCustomerId, timezone, name } = resolveTarget();
  const days = args.days ? Number(args.days) : 30;
  const dryRun = !!args['dry-run'];
  const jsonMode = !!args.json;

  // Resolve the timezone for --days date ranges. Prefer the value from
  // accounts.json; if unknown and this action computes a range, fall back to
  // fetching the account's timezone from the API (one extra query). For raw GAQL
  // without --days, Google evaluates DURING macros in the account timezone anyway.
  const dateBasedActions = new Set(['get-campaigns', 'get-keywords', 'get-search-terms', 'get-pmax-search-terms']);
  const usesDateRange = dateBasedActions.has(action) || (action === 'raw-query' && !!args.days);
  let effectiveTimezone = timezone;
  if (usesDateRange && !effectiveTimezone) {
    effectiveTimezone = await getAccountTimezone(customerId, loginCustomerId);
  }
  const readOpts = { loginCustomerId, timezone: effectiveTimezone };

  try {
    if (action === 'test-connection') {
      if (!jsonMode) console.log('\n🔍 Testowanie połączenia z Google Ads API...\n');
      const { config } = getApiClient();
      const targetId = customerId || config.default_customer_id;
      const accounts = await listAccounts(targetId, readOpts);

      if (jsonMode) {
        console.log(JSON.stringify({ success: true, accountsCount: accounts.length }));
      } else {
        console.log(`✅ Połączenie udane!`);
        console.log(`📊 Customer ID: ${targetId}${name ? ` (${name})` : ''}`);
        console.log(`👥 Kont podpiętych pod login/MCC: ${accounts.length}`);
        accounts.slice(0, 5).forEach((acc) => {
          console.log(`  • [${acc['customer_client.id']}] ${acc['customer_client.descriptive_name'] || 'Brak nazwy'} (Manager: ${acc['customer_client.manager']})`);
        });
      }
    }

    else if (action === 'list-accessible') {
      const accounts = await listAccessibleAccounts();
      emitRows(accounts, (rows) => {
        console.log(`\n👤 Wszystkie konta dostępne dla użytkownika (${rows.length}):`);
        console.table(rows.map((a) => ({
          'ID Konta': a.id,
          'Nazwa Konta': a.descriptive_name || 'Brak nazwy',
          'Typ': a.manager ? 'MCC Manager' : 'Klient Ads',
          Status: a.status,
          'Login (MCC)': a.login_customer_id || '— bezpośrednio —',
        })));
      }, 'list-accessible');
    }

    else if (action === 'list-accounts') {
      const accounts = await listAccounts(customerId, readOpts);
      emitRows(accounts, (rows) => {
        console.log(`\n👥 Lista kont klientów (${rows.length}):`);
        console.table(rows.map((acc) => ({
          'ID Konta': acc['customer_client.id'],
          'Nazwa Konta': acc['customer_client.descriptive_name'] || 'Brak nazwy',
          'Typ konta': acc['customer_client.manager'] ? 'MCC Manager' : 'Klient Ads',
          Status: acc['customer_client.status'],
        })));
      }, 'list-accounts');
    }

    else if (action === 'get-campaigns') {
      const campaigns = await getCampaigns(customerId, days, readOpts);
      emitRows(campaigns, (rows) => {
        console.log(`\n📊 Kampanie i statystyki (${days} dni):`);
        console.table(rows.map((c) => ({
          Nazwa: c.name,
          ID: c.id,
          Status: c.status,
          Typ: c.type,
          Budżet: c.budget.toFixed(2),
          Kliknięcia: c.clicks,
          Wyświetlenia: c.impressions,
          Koszt: c.cost.toFixed(2),
          Konwersje: c.conversions.toFixed(2),
          Wartość: c.conversion_value.toFixed(2),
          ROAS: c.roas.toFixed(2),
        })));
      }, 'get-campaigns');
    }

    else if (action === 'get-keywords') {
      const keywords = await getKeywords(customerId, days, readOpts);
      emitRows(keywords, (rows) => {
        console.log(`\n🔑 Słowa kluczowe (${days} dni):`);
        console.table(rows.slice(0, 50).map((k) => ({
          Kampania: k['campaign.name'],
          Grupa: k['ad_group.name'],
          Słowo: k['ad_group_criterion.keyword.text'],
          Dopasowanie: k['ad_group_criterion.keyword.match_type'],
          QS: k['ad_group_criterion.quality_info.quality_score'] || '-',
          Koszt: (k['metrics.cost'] || 0).toFixed(2),
          Konwersje: (k['metrics.conversions'] || 0).toFixed(1),
        })));
        if (rows.length > 50) console.log(`\n  * 50 z ${rows.length}. Użyj --auto / --output / --json po całość.`);
      }, 'get-keywords');
    }

    else if (action === 'get-search-terms') {
      const minCost = args['min-cost'] ? Number(args['min-cost']) : 0;
      const searchTerms = await getSearchTerms(customerId, days, minCost, readOpts);
      emitRows(searchTerms, (rows) => {
        console.log(`\n🔎 Hasła wyszukiwania (${days} dni, min. koszt: ${minCost}):`);
        console.table(rows.slice(0, 50).map((st) => ({
          Kampania: st['campaign.name'],
          Hasło: st['search_term_view.search_term'],
          Kliknięcia: st['metrics.clicks'],
          Koszt: (st['metrics.cost'] || 0).toFixed(2),
          Konwersje: (st['metrics.conversions'] || 0).toFixed(1),
        })));
        if (rows.length > 50) console.log(`\n  * 50 z ${rows.length}. Użyj --auto / --output / --json po całość.`);
      }, 'get-search-terms');
    }

    else if (action === 'get-pmax-search-terms') {
      const searchTerms = await getPmaxSearchTerms(customerId, days, { ...readOpts, campaignId: args.campaign });
      emitRows(searchTerms, (rows) => {
        console.log(`\n🔎 Hasła wyszukiwania PMax (${days} dni):`);
        console.table(rows.slice(0, 50).map((st) => ({
          Kampania: st['campaign.name'],
          Hasło: st['campaign_search_term_view.search_term'],
          Wyświetlenia: st['metrics.impressions'],
          Kliknięcia: st['metrics.clicks'],
          Koszt: (st['metrics.cost'] || 0).toFixed(2),
          Konwersje: (st['metrics.conversions'] || 0).toFixed(1),
        })));
        if (rows.length > 50) console.log(`\n  * 50 z ${rows.length}. Użyj --auto / --output / --json po całość.`);
      }, 'get-pmax-search-terms');
    }

    else if (action === 'keyword-ideas') {
      const keywords = args.keywords ? String(args.keywords).split(',').map((k) => k.trim()).filter(Boolean) : [];
      const ideas = await getKeywordIdeas(customerId, {
        loginCustomerId,
        keywords,
        url: args.url,
        geoTargetId: args.geo,
        languageId: args.language,
        network: args.network,
        pageSize: args['page-size'] ? Number(args['page-size']) : undefined,
      });
      emitRows(ideas, (rows) => {
        console.log(`\n💡 Pomysły na słowa kluczowe (Keyword Planner) — ${rows.length} wyników:`);
        console.table(rows.slice(0, 50).map((k) => ({
          Słowo: k.keyword,
          'Śr. mies. wyszukiwań': k.avg_monthly_searches,
          Konkurencja: k.competition,
          Indeks: k.competition_index,
          'Stawka min.': k.low_top_of_page_bid.toFixed(2),
          'Stawka maks.': k.high_top_of_page_bid.toFixed(2),
        })));
        if (rows.length > 50) console.log(`\n  * 50 z ${rows.length}. Użyj --auto / --output / --json po całość.`);
      }, 'keyword-ideas');
    }

    else if (action === 'get-budgets') {
      const budgets = await getBudgets(customerId, readOpts);
      emitRows(budgets, (rows) => {
        console.log(`\n💰 Aktywne Budżety:`);
        console.table(rows.map((b) => ({
          'ID Budżetu': b['campaign_budget.id'],
          Nazwa: b['campaign_budget.name'],
          'Kwota Dzienna': (b['campaign_budget.amount'] || 0).toFixed(2),
          Status: b['campaign_budget.status'],
        })));
      }, 'get-budgets');
    }

    else if (action === 'raw-query') {
      const query = args.query;
      if (!query) throw new Error('Action raw-query requires parameter --query="..."');
      const results = await runRawQuery(customerId, query, { loginCustomerId, timezone: effectiveTimezone, days: args.days ? days : undefined });
      emitRows(results, (rows) => {
        console.log(`\n📊 Wyniki GAQL (${rows.length} wierszy):`);
        console.log(JSON.stringify(rows.slice(0, 10), null, 2));
        if (rows.length > 10) console.log(`\n  * 10 z ${rows.length}. Użyj --auto / --output / --json po całość.`);
      }, 'raw-query');
    }

    else if (action === 'update-status') {
      const campaignId = args.campaign;
      const status = args.status;
      if (!campaignId || !status) throw new Error('update-status requires --campaign=<ID> and --status=<ENABLED|PAUSED>');
      const result = await updateCampaignStatus(customerId, campaignId, status, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'update-budget') {
      const budgetId = args['budget-id'];
      const amount = args.amount;
      if (!budgetId || amount === undefined) throw new Error('update-budget requires --budget-id=<ID> and --amount=<StandardFloat>');
      const result = await updateCampaignBudget(customerId, budgetId, Number(amount), dryRun, loginCustomerId, { force: !!args.force });
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-negatives') {
      const campaignId = args.campaign;
      const keywordsString = args.keywords;
      if (!campaignId || !keywordsString) throw new Error('add-negatives requires --campaign=<ID> and --keywords="fraza1,fraza 2"');
      // Match type is mandatory — choosing EXACT vs PHRASE vs BROAD must always be a conscious decision.
      const matchType = String(args['match-type'] || '').trim().toUpperCase();
      if (!['EXACT', 'PHRASE', 'BROAD'].includes(matchType)) {
        throw new Error('add-negatives requires --match-type=EXACT|PHRASE|BROAD (mandatory — choose deliberately; for search-term exclusions EXACT is usually correct)');
      }
      const keywords = keywordsString.split(',').map((k) => ({ text: k.trim(), matchType })).filter((k) => k.text);
      const result = await addCampaignNegativeKeywords(customerId, campaignId, keywords, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-negative-placements') {
      const domainsString = args.domains;
      if (!domainsString) throw new Error('add-negative-placements requires --domains="domena1.com,domena2.pl"');
      const domains = domainsString.split(',').map((d) => d.trim()).filter(Boolean);
      const result = await addAccountNegativePlacements(customerId, domains, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else {
      console.error(`❌ Nieznana akcja: ${action}`);
      printHelp();
      process.exit(1);
    }
  } catch (error) {
    if (jsonMode) {
      console.error(JSON.stringify({ error: error.message }));
    } else {
      console.error(`\n❌ Błąd:\n${error.message}`);
    }
    process.exit(1);
  }
}

main();
