#!/usr/bin/env node

import { writeFileSync, readFileSync } from 'fs';
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
  getChangeHistory,
  runRawQuery,
  getAccountTimezone,
  getConversionActions,
  getConversionActionActivity,
  getConversionTrackingSetting,
} from './queries.js';
import {
  updateCampaignStatus,
  updateAdStatus,
  updateAdGroupStatus,
  updateKeywordStatus,
  updateCampaignBudget,
  addCampaignNegativeKeywords,
  addAccountNegativePlacements,
  addAccountNegativeYouTubeChannels,
  updateFinalUrls,
  clearKeywordFinalUrls,
  buildFinalUrlResourceName,
  swapSitelinkFinalUrls,
  addSitelinks,
  pauseSitelinkLinks,
  createSearchCampaigns,
  createAdGroups,
  addKeywords,
  addAds,
  updateAdAssets,
  addCallouts,
  addPromotionAssets,
  pauseCallouts,
  pauseAssetLinks,
  addStructuredSnippets,
  addPriceAssets,
  addYoutubeAssets,
  createDemandGenAdGroups,
  copyAdGroupTargeting,
  addDemandGenAds,
  addListingGroups,
  createConversionActions,
  updateConversionActions,
} from './mutator.js';
import { resolveAccount, loadAccounts } from './accounts.js';
import { rowsToCsv, parseCsv } from './csv.js';
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

/**
 * Build the list of Final-URL updates for update-ad-url / update-keyword-url,
 * from either a batch CSV (`--input`) or single-item flags.
 *
 * CSV columns (case-insensitive, first match wins):
 *   id | resource_name | ad_id | criterion   → the entity ID or full resource name
 *   final_url | new_url | url                 → the new Final URL
 *   label | grupa | ad_group | campaign       → optional human label for output
 *
 * @param {'ad'|'keyword'} entity
 * @param {string} customerId
 * @returns {Array<{resourceName: string, finalUrl: string, label: string}>}
 */
function loadFinalUrlItems(entity, customerId) {
  const pick = (obj, keys) => { for (const k of keys) if (obj[k] !== undefined && obj[k] !== '') return obj[k]; return undefined; };

  if (args.input) {
    const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
    if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
    return rows.map((r, i) => {
      const id = pick(r, ['id', 'resource_name', 'ad_id', 'criterion', 'criterion_id']);
      const url = pick(r, ['final_url', 'new_url', 'url']);
      const label = pick(r, ['label', 'grupa', 'ad_group', 'campaign']) || String(id ?? `wiersz ${i + 2}`);
      if (!id) throw new Error(`Wiersz ${i + 2}: brak kolumny id/resource_name.`);
      if (!url) throw new Error(`Wiersz ${i + 2} (${label}): brak kolumny final_url.`);
      return { resourceName: buildFinalUrlResourceName(customerId, entity, id), finalUrl: url, label };
    });
  }

  // Single-item mode
  const singleId = entity === 'ad' ? (args.ad || args.id) : (args.criterion || args.id);
  const url = args.url;
  const flag = entity === 'ad' ? '--ad=<adId>' : '--criterion=<adGroupId~criterionId>';
  if (!singleId || !url) {
    throw new Error(`${entity === 'ad' ? 'update-ad-url' : 'update-keyword-url'} wymaga ${flag} i --url=<https://...>, albo --input=mapa.csv`);
  }
  return [{ resourceName: buildFinalUrlResourceName(customerId, entity, singleId), finalUrl: url, label: String(singleId) }];
}

/**
 * Build the list of sitelink URL swaps for update-sitelink-url. A sitelink item
 * needs the FULL link resource name (e.g. .../campaignAssets/111~222~SITELINK) —
 * it can't be built from a bare ID — plus the new Final URL.
 *
 * CSV columns: link_resource_name | resource_name | id → the full link resource
 * name; final_url | new_url | url → new URL; label | grupa | campaign → optional.
 *
 * @returns {Array<{linkResourceName: string, finalUrl: string, label: string}>}
 */
function loadSitelinkItems() {
  const pick = (obj, keys) => { for (const k of keys) if (obj[k] !== undefined && obj[k] !== '') return obj[k]; return undefined; };

  if (args.input) {
    const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
    if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
    return rows.map((r, i) => {
      const rn = pick(r, ['link_resource_name', 'resource_name', 'id']);
      const url = pick(r, ['final_url', 'new_url', 'url']);
      const label = pick(r, ['label', 'grupa', 'campaign']) || rn;
      if (!rn) throw new Error(`Wiersz ${i + 2}: brak kolumny link_resource_name/resource_name.`);
      if (!String(rn).includes('/')) throw new Error(`Wiersz ${i + 2} (${label}): sitelink wymaga PEŁNEGO resource_name linku (np. .../campaignAssets/111~222~SITELINK), nie samego ID.`);
      if (!url) throw new Error(`Wiersz ${i + 2} (${label}): brak kolumny final_url.`);
      return { linkResourceName: String(rn), finalUrl: url, label };
    });
  }

  const rn = args.sitelink;
  const url = args.url;
  if (!rn || !url) throw new Error('update-sitelink-url wymaga --sitelink=<pełny resource_name linku> i --url=<https://...>, albo --input=mapa.csv');
  if (!String(rn).includes('/')) throw new Error('--sitelink musi być PEŁNYM resource_name linku (np. customers/ID/campaignAssets/111~222~SITELINK).');
  return [{ linkResourceName: String(rn), finalUrl: url, label: String(rn) }];
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
  get-change-history      Kto co zmienił na koncie (change_event; maks. 29 dni wstecz,
                          --user=email[,email] opcjonalny filtr; teksty wykluczeń
                          rozwiązywane dla poziomu grupy i kampanii).
  raw-query               Własne zapytanie GAQL (wymaga --query).

Akcje zapisu (domyślnie SYMULACJA — zapis dopiero z --commit):
  update-status           Zmiana statusu kampanii (--campaign, --status).
  update-ad-status        Wstrzymanie/wznowienie REKLAM po ID reklamy (tym z UI).
                          Pojedynczo/lista: --ad=<ID[,ID]> --status=<ENABLED|PAUSED>;
                          wsadowo: --input=mapa.csv (kolumny: ad_id,status).
                          Zwalnia slot, gdy grupa ma limit 3 aktywnych RSA.
  update-keyword-status   Wstrzymanie/wznowienie SŁÓW KLUCZOWYCH.
                          --criterion=<adGroupId~criterionId[,...]> --status=<...>;
                          wsadowo: --input=mapa.csv (kolumny: criterion,status).
                          Odwracalna emerytura dla słowa — historia zostaje.
  update-ad-group-status  Wstrzymanie/wznowienie GRUP REKLAM po ID grupy.
                          Pojedynczo/lista: --ad-group=<ID[,ID]> --status=<...>;
                          wsadowo: --input=mapa.csv (kolumny: ad_group_id,status).
                          Tym wznawiasz grupę, której create-ad-groups nie ruszy
                          (jest idempotentne i pomija istniejące).
  update-budget           Zmiana budżetu dziennego (--budget-id, --amount).
                          SafetyLimits blokuje skok > ${DEFAULT_MAX_BUDGET_CHANGE_PCT}% — użyj --force, by wymusić.
  add-negatives           Negatywne słowa kluczowe (--campaign, --keywords, --match-type).
  add-negative-placements Wykluczenia miejsc docelowych — domeny (--domains).
  add-negative-youtube-channels  Wykluczenia kanałów YouTube na poziomie konta (--channels).
  update-ad-url           Zmiana Final URL reklamy (RSA). Pojedynczo: --ad=<adId> --url=<...>;
                          wsadowo: --input=mapa.csv (kolumny: id,final_url).
  update-keyword-url      Zmiana Final URL słowa kluczowego (override). Pojedynczo:
                          --criterion=<adGroupId~criterionId> --url=<...>; wsadowo: --input=mapa.csv.
  clear-keyword-url       Czyści override Final URL słowa (final_urls=[]) → słowo dziedziczy URL
                          reklamy. Tylko --input=mapa.csv (kolumna id lub resource_name).
  update-sitelink-url     Zmiana Final URL sitelinka bez utraty danych: klonuje asset z nowym
                          URL, podpina (ENABLED) i wstrzymuje stary link (PAUSED). Pojedynczo:
                          --sitelink=<pełny resource_name linku> --url=<...>; wsadowo: --input=mapa.csv.
  add-sitelinks           Tworzy NOWE sitelinki (asset + link) na poziomie konta lub kampanii,
                          atomowo. Tylko --input=mapa.csv (kolumny: level=customer|campaign,
                          campaign_id,link_text,description1,description2,final_url).
  pause-sitelinks         Wstrzymuje (PAUSED) istniejące linki sitelink — dane zostają.
                          --input=mapa.csv (kolumna link_resource_name) lub --links="rn1,rn2".
  create-campaigns        Tworzy KAMPANIE Search wraz z budżetem dziennym. Domyślnie powstają
                          jako PAUSED (kampania ENABLED zaczyna wydawać od razu). Idempotentne
                          po nazwie kampanii; budżet o istniejącej nazwie jest ponownie użyty,
                          a nie duplikowany (kwoty nie zmienia — od tego jest update-budget).
                          Tylko --input=mapa.csv (kolumny: campaign_name,budget_amount
                          [,budget_name,status,bidding_strategy,cpc_bid_ceiling,target_cpa,
                          target_roas,enhanced_cpc,geo_targets,languages,geo_target_type,
                          search_partners,content_network,eu_political_advertising,
                          start_date,end_date]).
                          bidding_strategy: MAXIMIZE_CLICKS (domyślnie) | MAXIMIZE_CONVERSIONS |
                          MAXIMIZE_CONVERSION_VALUE | MANUAL_CPC. Domyślnie Polska (2616),
                          polski (1030), obecność w lokalizacji, bez partnerów i sieci reklamowej.
  create-ad-groups        Tworzy grupy reklam w istniejących kampaniach Search. Idempotentne:
                          pomija grupę, której nazwa już jest w kampanii. Tylko --input=mapa.csv
                          (kolumny: campaign_id,ad_group_name[,status]).
  add-keywords            Dodaje POZYTYWNE słowa kluczowe do grup reklam. Idempotentne: pomija
                          duplikaty (tekst + typ dopasowania). Grupę wskazujesz przez ad_group_id
                          albo campaign_id + ad_group_name. Tylko --input=mapa.csv
                          (kolumny: [ad_group_id|campaign_id+ad_group_name],keyword,match_type[,final_url]).
  add-callouts            Dodaje objaśnienia (callouts) na poziomie konta/kampanii/grupy.
                          Idempotentne. --input=mapa.csv (kolumny: level,campaign_id,
                          ad_group_name|ad_group_id,text).
  pause-callouts          Wstrzymuje objaśnienia — dane zostają. Callout jest niezmienialny,
                          więc "edycja" = add-callouts nowego + pause-callouts starego.
                          --input=mapa.csv (kolumna link_resource_name) lub --links="rn1,rn2".
  pause-assets            To samo dla DOWOLNEGO rozszerzenia (fragment, cennik, obraz,
                          sitelink, callout) — wstrzymuje link, zasób zostaje.
                          --input=mapa.csv (kolumna link_resource_name) lub --links="rn1,rn2".
  add-structured-snippets Dodaje fragmenty strukturalne na poziomie konta/kampanii/grupy.
                          Idempotentne po NAGŁÓWKU na danym poziomie. --input=mapa.csv
                          (kolumny: level,campaign_id|ad_group_id|ad_group_name,header,
                          value1..value10 albo values="a|b|c"). Nagłówek musi być z listy
                          Google dla języka konta (PL: Typy, Usługi, Marki, Style, Modele...).
  add-price-assets        Dodaje rozszerzenia cenowe. Jeden wiersz CSV = jedna pozycja
                          cennika; wiersze z tym samym "group" tworzą jedno rozszerzenie
                          (3-8 pozycji). Ceny w walucie standardowej, NIE w mikro.
                          Idempotentne po TYPIE cennika na danym poziomie. --input=mapa.csv
                          (kolumny: group,level,campaign_id,price_type,price_qualifier,
                          language,unit,currency,header,description,price,final_url).
  add-ads                 Dodaje reklamy RSA do grup reklam. Idempotentne po TREŚCI: pomija
                          reklamę o tym samym zestawie nagłówków/tekstów i Final URL. Tylko
                          --input=mapa.csv (kolumny: [ad_group_id|campaign_id+ad_group_name],
                          final_url,headline1..15,description1..4[,path1,path2]).
                          Przypięcie nagłówka: dopisz "|H1", "|H2" albo "|H3" na końcu
                          komórki (np. "Krówki z logo|H1"). Marker nie liczy się do
                          limitu 30 znaków. Bez markera nagłówek rotuje swobodnie.
  --- Demand Gen (kampanie DemGen; kolejność jak niżej) ---
  add-youtube-assets      1/5. Dodaje film YouTube jako ZASÓB konta. Idempotentne po ID filmu
                          (Google NIE deduplikuje — dwa wywołania = dwa zasoby na ten sam film,
                          a zasobów nie da się usunąć). Przyjmuje ID albo dowolny URL
                          (watch?v=, youtu.be, /shorts/, /embed/). Zwraca asset_id do kroku 4.
                          --input=mapa.csv (kolumny: video[,name]).
  create-demand-gen-ad-groups
                          2/5. Tworzy grupy reklam w istniejących kampaniach DEMAND GEN.
                          Odmawia, gdy kampania nie jest DemGen. Idempotentne po nazwie.
                          Kanały ustawiasz JEDNYM z dwóch pól (to oneof w API):
                            channel_strategy=ALL_CHANNELS | ALL_OWNED_AND_OPERATED_CHANNELS
                            channels=youtube_shorts|youtube_in_feed|youtube_in_stream|discover|gmail|display
                          Puste oba = grupa dziedziczy domyślne kampanii.
                          --input=mapa.csv (kolumny: campaign_id,ad_group_name[,status]
                          [,channel_strategy|channels]).
  copy-ad-group-targeting 3/5. Klonuje targetowanie z istniejącej grupy na nową. Zachowanie
                          zależy od trybu grupy DOCELOWEJ (pole "audienceGrouped" w wyniku):
                            • audience grouped (typowe dla DemGen) — całe targetowanie, RAZEM
                              z demografią, siedzi w zasobie Audience; kopiowane jest wyłącznie
                              to jedno przypisanie odbiorców, reszta trafia do "notCopied".
                            • bez grupowania — wiek, płeć, dochód, status rodzicielski,
                              zainteresowania, odbiorcy własni/łączeni i listy pojedynczo.
                          Pomija wartości UNKNOWN/UNSPECIFIED (Google ich nie przyjmuje).
                          Niczego nie gubi po cichu — ZAWSZE czytaj "notCopied".
                          Idempotentne (pomija kryteria już obecne na celu).
                          --input=mapa.csv (kolumny: source_ad_group_id,target_ad_group_id).
  add-demand-gen-ads      4/5. Tworzy reklamy wideo responsywne Demand Gen. Film musi już być
                          zasobem konta (krok 1) — ta akcja go NIE tworzy. API wymaga filmu,
                          logo i nazwy firmy. CTA jest zasobem, nie enumem: brakujące zasoby CTA
                          tworzy sama i współdzieli między wierszami. Idempotentne po
                          (grupa + film + Final URL). --input=mapa.csv (kolumny: ad_group_id,
                          final_url,video,logo_asset_id,business_name,headline1..5,
                          long_headline1..5,description1..5[,cta,status,name]).
  add-listing-groups      5/5. Podpina kanał produktowy do grupy DemGen, zawężony do wskazanych
                          produktów — buduje drzewo: korzeń + po jednym węźle na produkt +
                          węzeł "wszystko inne" jako WYKLUCZONY (bez niego poszedłby cały
                          katalog). Odmawia, gdy grupa ma już kanał produktowy — przebudowa
                          wymaga usuwania kryteriów, a konektor nie usuwa (zrób to w UI).
                          --input=mapa.csv (kolumny: ad_group_id,product_item_ids — ID rozdziel
                          | ; lub przecinkiem, albo jeden wiersz na produkt).

  update-ad-assets        Podmienia nagłówki/teksty ISTNIEJĄCEJ reklamy RSA (to samo ID reklamy,
                          nic nie jest wstrzymywane). Grupa musi mieć dokładnie jedną RSA albo
                          podaj ad_id. --input=mapa.csv (kolumny jak w add-ads, bez final_url).

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
  --commit                    ZATWIERDŹ mutację (zapis na koncie). Bez tej flagi każda
                              akcja zapisu jest tylko symulacją — zapomnienie flagi nigdy
                              nie zmienia konta.
  --dry-run                   Wymuś symulację (nadpisuje --commit). Domyślne dla akcji zapisu,
                              więc zwykle zbędne — zostawione dla starych komend.
  --force                     Wymuś mutację mimo blokady SafetyLimits (skok budżetu > ${DEFAULT_MAX_BUDGET_CHANGE_PCT}%).
  --ad=<adId>                 ID reklamy dla update-ad-url (pojedynczo).
  --criterion=<agId~critId>   Zasób słowa kluczowego dla update-keyword-url (pojedynczo).
  --sitelink=<resource_name>  Pełny resource_name linku sitelink dla update-sitelink-url (pojedynczo).
  --input=<mapa.csv>          Plik wsadowy dla update-*-url (kolumny: id/resource_name,final_url).
  --domain=<zielonyogrod.example>     Blokada domeny: odrzuć Final URL spoza tej domeny (guardrail).

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
  node scripts/cli.js --action=update-budget --customer=1234567890 --budget-id=111222333 --amount=150.00
  node scripts/cli.js --action=update-budget --customer=1234567890 --budget-id=111222333 --amount=150.00 --commit

  Konwersje (wdrożenie śledzenia — Google Ads, potem GTM):
  node scripts/cli.js --action=list-conversions --account=zielonyogrod --days=30
  node scripts/cli.js --action=list-conversions --account=zielonyogrod --with-snippets
  node scripts/cli.js --action=create-conversions --account=zielonyogrod --input=konwersje.csv
  node scripts/cli.js --action=create-conversions --account=zielonyogrod --input=konwersje.csv --commit
  node scripts/cli.js --action=update-conversions --account=zielonyogrod --id=987654321 --primary=true --commit
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

  // Writes are opt-in, reads are free. The read-only actions are a closed set;
  // ANYTHING else — including an action added later — counts as a mutation and
  // runs as a simulation unless `--commit` is passed. That way a forgotten flag
  // can only ever produce a dry-run, never a live change, and committing has to
  // be a deliberate act. `--dry-run` stays valid (and wins over `--commit`).
  const READ_ONLY_ACTIONS = new Set([
    'test-connection', 'list-accessible', 'list-accounts', 'get-campaigns', 'get-keywords',
    'get-search-terms', 'get-pmax-search-terms', 'keyword-ideas', 'get-budgets',
    'get-change-history', 'raw-query', 'list-conversions',
  ]);
  const isMutation = !READ_ONLY_ACTIONS.has(action);
  const dryRun = isMutation && (!args.commit || !!args['dry-run']);
  const jsonMode = !!args.json;

  // Resolve the timezone for --days date ranges. Prefer the value from
  // accounts.json; if unknown and this action computes a range, fall back to
  // fetching the account's timezone from the API (one extra query). For raw GAQL
  // without --days, Google evaluates DURING macros in the account timezone anyway.
  const dateBasedActions = new Set(['get-campaigns', 'get-keywords', 'get-search-terms', 'get-pmax-search-terms', 'get-change-history', 'list-conversions']);
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

    else if (action === 'get-change-history') {
      if (days > 29) {
        console.error('⚠️  Google Ads API przechowuje change_event tylko 30 dni — zakres przycięty do 29 dni.');
      }
      const effDays = Math.min(days, 29);
      const changes = await getChangeHistory(customerId, effDays, { ...readOpts, user: args.user });
      emitRows(changes, (rows) => {
        console.log(`\n📋 Historia zmian (${effDays} dni${args.user ? `, user: ${args.user}` : ''}):`);
        console.table(rows.slice(0, 50).map((c) => ({
          Data: (c.datetime || '').substring(0, 16),
          Kto: c.user,
          Operacja: c.operation,
          Typ: c.resourceType,
          Kampania: (c.campaign || '').substring(0, 28),
          Szczegóły: (c.detail || '').substring(0, 50),
        })));
        if (rows.length > 50) console.log(`\n  * 50 z ${rows.length}. Użyj --auto / --output / --json po całość.`);
      }, 'get-change-history');
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

    else if (action === 'update-ad-status' || action === 'update-ad-group-status') {
      const isAd = action === 'update-ad-status';
      const idKey = isAd ? 'adId' : 'adGroupId';
      const flag = isAd ? 'ad' : 'ad-group';
      const csvCols = isAd ? 'ad_id,status' : 'ad_group_id,status';
      let items = [];
      if (args.input) {
        const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
        items = rows.map((r) => ({
          [idKey]: r[isAd ? 'ad_id' : 'ad_group_id'] || r.id || '',
          status: r.status || args.status || '',
        }));
      } else if (args[flag]) {
        items = String(args[flag]).split(',').map((id) => ({ [idKey]: id.trim(), status: args.status || '' }));
      }
      if (items.length === 0) {
        throw new Error(`${action} wymaga --${flag}=<ID[,ID]> --status=<ENABLED|PAUSED> albo --input=mapa.csv (kolumny: ${csvCols})`);
      }
      const result = isAd
        ? await updateAdStatus(customerId, items, dryRun, loginCustomerId)
        : await updateAdGroupStatus(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'update-keyword-status') {
      let items = [];
      if (args.input) {
        const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
        items = rows.map((r) => ({
          criterion: r.criterion || r.id || r.criterion_id || '',
          status: r.status || args.status || '',
        }));
      } else if (args.criterion) {
        items = String(args.criterion).split(',').map((c) => ({ criterion: c.trim(), status: args.status || '' }));
      }
      if (items.length === 0) {
        throw new Error('update-keyword-status wymaga --criterion=<adGroupId~criterionId[,...]> --status=<ENABLED|PAUSED> albo --input=mapa.csv (kolumny: criterion,status)');
      }
      const bad = items.filter((i) => !String(i.criterion).includes('~'));
      if (bad.length) {
        throw new Error(`🛑 ${bad.length} pozycji bez formatu adGroupId~criterionId (np. 158815334092~300772940111). Samo ID kryterium nie identyfikuje słowa jednoznacznie.`);
      }
      const result = await updateKeywordStatus(customerId, items, dryRun, loginCustomerId);
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

    else if (action === 'add-negative-youtube-channels') {
      const channelsString = args.channels;
      if (!channelsString) throw new Error('add-negative-youtube-channels requires --channels="UCxxx,UCyyy" (channel ids or full channel URLs)');
      const channels = channelsString.split(',').map((c) => c.trim()).filter(Boolean);
      const result = await addAccountNegativeYouTubeChannels(customerId, channels, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'update-ad-url' || action === 'update-keyword-url') {
      const entity = action === 'update-ad-url' ? 'ad' : 'keyword';
      const items = loadFinalUrlItems(entity, customerId);
      const result = await updateFinalUrls(customerId, entity, items, dryRun, loginCustomerId, { domain: args.domain });
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'clear-keyword-url') {
      // Batch-only: clearing overrides one at a time is rarely useful.
      if (!args.input) throw new Error('clear-keyword-url wymaga --input=mapa.csv (kolumna: id lub resource_name słowa kluczowego)');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => {
        const id = r.id || r.resource_name || r.criterion;
        if (!id) throw new Error(`Wiersz ${i + 2}: brak kolumny id/resource_name.`);
        const resourceName = buildFinalUrlResourceName(customerId, 'keyword', id);
        return { resourceName, label: r.label || r.grupa || id };
      });
      const result = await clearKeywordFinalUrls(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'update-sitelink-url') {
      const items = loadSitelinkItems();
      const result = await swapSitelinkFinalUrls(customerId, items, dryRun, loginCustomerId, { domain: args.domain });
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-sitelinks') {
      // Batch-only: creating a sitelink set one flag at a time is error-prone.
      if (!args.input) throw new Error('add-sitelinks wymaga --input=mapa.csv (kolumny: level=customer|campaign|ad_group,campaign_id,ad_group_name|ad_group_id,link_text,description1,description2,final_url)');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        level: r.level,
        campaignId: r.campaign_id || r.campaign,
        adGroupId: r.ad_group_id || '',
        adGroupName: r.ad_group_name || r.ad_group || '',
        linkText: r.link_text,
        description1: r.description1 || r.desc1 || '',
        description2: r.description2 || r.desc2 || '',
        finalUrl: r.final_url || r.url,
        label: r.label || `${r.link_text} (wiersz ${i + 2})`,
      }));
      const result = await addSitelinks(customerId, items, dryRun, loginCustomerId, { domain: args.domain });
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'pause-sitelinks') {
      let names = [];
      if (args.input) {
        const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
        names = rows.map((r) => r.link_resource_name || r.resource_name || r.id).filter(Boolean);
      } else if (args.links) {
        names = String(args.links).split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (names.length === 0) throw new Error('pause-sitelinks wymaga --input=mapa.csv (kolumna: link_resource_name) albo --links="rn1,rn2"');
      const result = await pauseSitelinkLinks(customerId, names, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'create-campaigns') {
      // Batch-only, like every other build-out action: a campaign typed one flag
      // at a time is a campaign nobody reviewed, and under the no-delete policy a
      // wrong one can only be paused.
      if (!args.input) throw new Error('create-campaigns wymaga --input=mapa.csv (kolumny: campaign_name,budget_amount[,status,bidding_strategy,cpc_bid_ceiling,target_cpa,target_roas,geo_targets,languages,...])');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        name: r.campaign_name || r.campaign || r.name,
        budgetName: r.budget_name || '',
        budgetAmount: r.budget_amount || r.budget || '',
        status: r.status || 'PAUSED',
        biddingStrategy: r.bidding_strategy || r.strategy || 'MAXIMIZE_CLICKS',
        cpcBidCeiling: r.cpc_bid_ceiling || '',
        targetCpa: r.target_cpa || '',
        targetRoas: r.target_roas || '',
        enhancedCpc: r.enhanced_cpc || '',
        geoTargets: r.geo_targets || r.geo || '',
        languages: r.languages || r.language || '',
        geoTargetType: r.geo_target_type || 'PRESENCE',
        euPoliticalAdvertising: r.eu_political_advertising || 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        searchPartners: r.search_partners || '',
        contentNetwork: r.content_network || '',
        startDate: r.start_date || '',
        endDate: r.end_date || '',
        label: `${r.campaign_name || r.campaign || r.name} (wiersz ${i + 2})`,
      }));
      const result = await createSearchCampaigns(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'create-ad-groups') {
      // Batch-only: building a group set one flag at a time invites typos in names
      // that then have to be un-made by hand (no-delete policy).
      if (!args.input) throw new Error('create-ad-groups wymaga --input=mapa.csv (kolumny: campaign_id,ad_group_name[,status])');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        campaignId: r.campaign_id || r.campaign,
        name: r.ad_group_name || r.ad_group || r.name,
        status: r.status || 'ENABLED',
        label: `${r.ad_group_name || r.ad_group || r.name} (wiersz ${i + 2})`,
      }));
      const result = await createAdGroups(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-keywords') {
      if (!args.input) throw new Error('add-keywords wymaga --input=mapa.csv (kolumny: [ad_group_id|campaign_id+ad_group_name],keyword,match_type[,final_url])');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        adGroupId: r.ad_group_id || '',
        campaignId: r.campaign_id || r.campaign || '',
        adGroupName: r.ad_group_name || r.ad_group || '',
        text: r.keyword || r.text,
        matchType: r.match_type || r.matchtype || args['match-type'] || '',
        finalUrl: r.final_url || '',
        label: `${r.keyword || r.text} (wiersz ${i + 2})`,
      }));
      const result = await addKeywords(customerId, items, dryRun, loginCustomerId, { domain: args.domain });
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-callouts') {
      if (!args.input) throw new Error('add-callouts wymaga --input=mapa.csv (kolumny: level,campaign_id,ad_group_name|ad_group_id,text)');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        level: r.level,
        campaignId: r.campaign_id || r.campaign || '',
        adGroupId: r.ad_group_id || '',
        adGroupName: r.ad_group_name || r.ad_group || '',
        text: r.text || r.callout_text,
        label: `${r.text || r.callout_text} (wiersz ${i + 2})`,
      }));
      const result = await addCallouts(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'pause-callouts') {
      let names = [];
      if (args.input) {
        const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
        names = rows.map((r) => r.link_resource_name || r.resource_name || r.id).filter(Boolean);
      } else if (args.links) {
        names = String(args.links).split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (names.length === 0) throw new Error('pause-callouts wymaga --input=mapa.csv (kolumna link_resource_name) albo --links="rn1,rn2"');
      const result = await pauseCallouts(customerId, names, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'pause-assets') {
      let names = [];
      if (args.input) {
        const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
        names = rows.map((r) => r.link_resource_name || r.resource_name || r.id).filter(Boolean);
      } else if (args.links) {
        names = String(args.links).split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (names.length === 0) throw new Error('pause-assets wymaga --input=mapa.csv (kolumna link_resource_name) albo --links="rn1,rn2"');
      const result = await pauseAssetLinks(customerId, names, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-structured-snippets') {
      if (!args.input) throw new Error('add-structured-snippets wymaga --input=mapa.csv (kolumny: level,campaign_id,ad_group_name|ad_group_id,header,value1..10)');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => {
        // Values arrive either as value1..value10 columns or one `values` cell
        // separated by "|" — a CSV cell cannot hold commas without quoting, and
        // the pipe form is what a person actually types by hand.
        const numbered = Array.from({ length: 10 }, (_, k) => r[`value${k + 1}`]).filter((v) => v && v.trim());
        const packed = String(r.values ?? '').split('|').map((s) => s.trim()).filter(Boolean);
        return {
          level: r.level,
          campaignId: r.campaign_id || r.campaign || '',
          adGroupId: r.ad_group_id || '',
          adGroupName: r.ad_group_name || r.ad_group || '',
          header: r.header,
          values: numbered.length ? numbered : packed,
          label: `${r.header} (wiersz ${i + 2})`,
        };
      });
      const result = await addStructuredSnippets(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-price-assets') {
      if (!args.input) throw new Error('add-price-assets wymaga --input=mapa.csv (kolumny: group,level,campaign_id,price_type,price_qualifier,language,unit,currency,header,description,price,final_url)');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      // One CSV row = one offering; rows sharing `group` become one price
      // extension. Without a `group` column every row for the same parent+type
      // is folded into a single extension, which is what a plain file means.
      const byGroup = new Map();
      rows.forEach((r, i) => {
        const key = r.group || `${r.level}|${r.campaign_id || ''}|${r.ad_group_id || r.ad_group_name || ''}|${r.price_type || 'PRODUCT_TIERS'}`;
        if (!byGroup.has(key)) {
          byGroup.set(key, {
            level: r.level,
            campaignId: r.campaign_id || r.campaign || '',
            adGroupId: r.ad_group_id || '',
            adGroupName: r.ad_group_name || r.ad_group || '',
            priceType: r.price_type || '',
            priceQualifier: r.price_qualifier || '',
            language: r.language || '',
            unit: r.unit || '',
            currency: r.currency || '',
            offerings: [],
            label: `cennik "${key}" (od wiersza ${i + 2})`,
          });
        }
        byGroup.get(key).offerings.push({
          header: r.header,
          description: r.description,
          price: r.price,
          currency: r.currency || '',
          unit: r.unit || '',
          finalUrl: r.final_url || r.url,
        });
      });
      const result = await addPriceAssets(customerId, [...byGroup.values()], dryRun, loginCustomerId, { domain: args.domain });
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-promotion-assets') {
      if (!args.input) throw new Error('add-promotion-assets wymaga --input=mapa.csv (kolumny: level,campaign_id|ad_group_id|ad_group_name,promotion_target,percent_off|money_amount_off,currency,orders_over_amount,discount_modifier,occasion,language,final_url,start_date,end_date)');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        level: r.level,
        campaignId: r.campaign_id || r.campaign || '',
        adGroupId: r.ad_group_id || '',
        adGroupName: r.ad_group_name || r.ad_group || '',
        promotionTarget: r.promotion_target || r.target,
        percentOff: r.percent_off,
        moneyAmountOff: r.money_amount_off,
        currency: r.currency,
        ordersOverAmount: r.orders_over_amount,
        discountModifier: r.discount_modifier,
        occasion: r.occasion,
        language: r.language,
        finalUrl: r.final_url || r.url,
        startDate: r.start_date,
        endDate: r.end_date,
        label: `${r.promotion_target || r.target || 'promocja'} (wiersz ${i + 2})`,
      }));
      const result = await addPromotionAssets(customerId, items, dryRun, loginCustomerId, { domain: args.domain });
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-ads') {
      if (!args.input) throw new Error('add-ads wymaga --input=mapa.csv (kolumny: [ad_group_id|campaign_id+ad_group_name],final_url,headline1..15,description1..4)');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => {
        const pick = (prefix, n) => Array.from({ length: n }, (_, k) => r[`${prefix}${k + 1}`]).filter((v) => v && v.trim());
        return {
          adGroupId: r.ad_group_id || '',
          campaignId: r.campaign_id || r.campaign || '',
          adGroupName: r.ad_group_name || r.ad_group || '',
          headlines: pick('headline', 15),
          descriptions: pick('description', 4),
          finalUrl: r.final_url || r.url,
          path1: r.path1 || '',
          path2: r.path2 || '',
          label: `${r.ad_group_name || r.ad_group_id} (wiersz ${i + 2})`,
        };
      });
      const result = await addAds(customerId, items, dryRun, loginCustomerId, { domain: args.domain });
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'update-ad-assets') {
      if (!args.input) throw new Error('update-ad-assets wymaga --input=mapa.csv (kolumny: [ad_id|ad_group_id|campaign_id+ad_group_name],headline1..15,description1..4)');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => {
        const pick = (prefix, n) => Array.from({ length: n }, (_, k) => r[`${prefix}${k + 1}`]).filter((v) => v && v.trim());
        return {
          adId: r.ad_id || '',
          adGroupId: r.ad_group_id || '',
          campaignId: r.campaign_id || r.campaign || '',
          adGroupName: r.ad_group_name || r.ad_group || '',
          headlines: pick('headline', 15),
          descriptions: pick('description', 4),
          path1: r.path1 || '',
          path2: r.path2 || '',
          label: `${r.ad_group_name || r.ad_id} (wiersz ${i + 2})`,
        };
      });
      const result = await updateAdAssets(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-youtube-assets') {
      if (!args.input) throw new Error('add-youtube-assets wymaga --input=mapa.csv (kolumny: video[,name])');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        video: r.video || r.video_id || r.url || r.youtube_video_id,
        name: r.name || '',
        label: `${r.video || r.video_id || r.url || ''} (wiersz ${i + 2})`,
      }));
      const result = await addYoutubeAssets(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'create-demand-gen-ad-groups') {
      if (!args.input) throw new Error('create-demand-gen-ad-groups wymaga --input=mapa.csv (kolumny: campaign_id,ad_group_name[,status][,channel_strategy|channels])');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        campaignId: r.campaign_id || r.campaign,
        name: r.ad_group_name || r.ad_group || r.name,
        status: r.status || 'ENABLED',
        strategy: r.channel_strategy || '',
        // "shorts|in_feed" or "shorts,in_feed" — both read naturally in a CSV cell.
        channels: String(r.channels || '').split(/[|;,]/).map((c) => c.trim()).filter(Boolean),
        label: `${r.ad_group_name || r.ad_group || r.name} (wiersz ${i + 2})`,
      }));
      const result = await createDemandGenAdGroups(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'copy-ad-group-targeting') {
      if (!args.input) throw new Error('copy-ad-group-targeting wymaga --input=mapa.csv (kolumny: source_ad_group_id,target_ad_group_id)');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        sourceAdGroupId: r.source_ad_group_id || r.source,
        targetAdGroupId: r.target_ad_group_id || r.target,
        label: `${r.source_ad_group_id || r.source} → ${r.target_ad_group_id || r.target} (wiersz ${i + 2})`,
      }));
      const result = await copyAdGroupTargeting(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-demand-gen-ads') {
      if (!args.input) throw new Error('add-demand-gen-ads wymaga --input=mapa.csv (kolumny: ad_group_id,final_url,video,logo_asset_id,business_name,headline1..5,long_headline1..5,description1..5[,cta,status,name])');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const pick = (r, prefix, n) => Array.from({ length: n }, (_, k) => r[`${prefix}${k + 1}`]).filter((v) => v !== undefined && String(v).trim() !== '');
      const items = rows.map((r, i) => ({
        adGroupId: r.ad_group_id,
        finalUrl: r.final_url,
        video: r.video || r.video_id || r.url,
        logoAssetId: r.logo_asset_id,
        businessName: r.business_name,
        headlines: pick(r, 'headline', 5),
        longHeadlines: pick(r, 'long_headline', 5),
        descriptions: pick(r, 'description', 5),
        cta: r.cta || '',
        status: r.status || 'ENABLED',
        name: r.name || '',
        label: `grupa ${r.ad_group_id} (wiersz ${i + 2})`,
      }));
      const result = await addDemandGenAds(customerId, items, dryRun, loginCustomerId, { domain: args.domain });
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'list-conversions') {
      // The inventory you read BEFORE deploying anything, and the source of the
      // two values GTM needs afterwards (AW-… + label).
      const [tracking, actions] = await Promise.all([
        getConversionTrackingSetting(customerId, readOpts).catch(() => null),
        getConversionActions(customerId, { loginCustomerId, withSnippets: !!args['with-snippets'], all: !!args.all }),
      ]);

      // Activity is best-effort: a brand-new account has no history to report and
      // that must not fail the listing.
      let rows = actions;
      if (args.days) {
        try {
          const activity = await getConversionActionActivity(customerId, days, readOpts);
          rows = actions.map((a) => {
            const m = activity.get(a.id) || { conversions: 0, value: 0, lastConversionDate: null };
            return { ...a, conversions: Number(m.conversions.toFixed(2)), conversionValue: Number(m.value.toFixed(2)), lastConversionDate: m.lastConversionDate };
          });
        } catch (e) {
          rows = actions.map((a) => ({ ...a, conversions: null, conversionValue: null, lastConversionDate: null }));
          if (!jsonMode) console.error(`⚠️  Nie udało się pobrać aktywności konwersji: ${e.message}`);
        }
      }

      if (jsonMode) {
        console.log(JSON.stringify({ tracking, actions: rows }));
      } else if (args.output) {
        writeCsvSummary(rows.map(({ eventSnippet, globalSiteTag, ...r }) => r), args.output, action);
      } else {
        if (tracking) {
          console.log(`\n🎯 Śledzenie konwersji — ${tracking.accountName || customerId}`);
          console.log(`   ID konwersji do GTM: ${tracking.gtmConversionId || '— (konto nie ma jeszcze śledzenia konwersji)'}`);
          console.log(`   Zarządzanie: ${tracking.managedBy}${tracking.crossAccountConversionTrackingId ? ' (ID z konta managera — w GTM użyj właśnie tego)' : ''}`);
          console.log(`   Dane klienta zaakceptowane: ${tracking.acceptedCustomerDataTerms ? 'tak' : 'nie'} | Konwersje rozszerzone dla leadów: ${tracking.enhancedConversionsForLeads ? 'włączone' : 'wyłączone'}`);
        }
        console.log(`\n📋 Konwersje w koncie (${rows.length}):`);
        console.table(rows.map((a) => ({
          ID: a.id,
          Nazwa: a.name,
          Typ: a.type,
          Kategoria: a.category,
          Status: a.status,
          Główna: a.primaryForGoal ? '✓' : '',
          Zliczanie: a.countingType,
          Wartość: a.alwaysUseDefaultValue ? `${a.defaultValue ?? 0} ${a.currency || ''} (zawsze)` : (a.defaultValue ? `${a.defaultValue} ${a.currency || ''} (dom.)` : '—'),
          'Okno klik.': a.clickLookbackDays ?? '—',
          'AW / etykieta': a.conversionId ? `${a.conversionId} / ${a.label || '—'}` : '—',
          ...(args.days ? { [`Konw. ${days}d`]: a.conversions ?? '—', Ostatnia: a.lastConversionDate || '—' } : {}),
        })));
        if (args['with-snippets']) {
          for (const a of rows.filter((x) => x.eventSnippet)) {
            console.log(`\n--- ${a.name} (${a.conversionId || '?'} / ${a.label || '?'}) ---\n${a.eventSnippet}`);
          }
        }
      }
    }

    else if (action === 'create-conversions') {
      // Batch-only on purpose: a conversion action created by a typo cannot be
      // deleted by this connector (no-delete policy), only hidden.
      if (!args.input) throw new Error('create-conversions wymaga --input=konwersje.csv (kolumny: name,type,category[,primary_for_goal,counting_type,default_value,currency,always_use_default_value,click_lookback_days,view_lookback_days,attribution_model,status])');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        name: r.name || r.nazwa,
        type: r.type || r.typ || 'WEBPAGE',
        category: r.category || r.kategoria,
        status: r.status,
        primaryForGoal: r.primary_for_goal ?? r.primary ?? r.glowna,
        countingType: r.counting_type || r.counting,
        defaultValue: r.default_value ?? r.value ?? r.wartosc,
        currency: r.currency || r.waluta,
        alwaysUseDefaultValue: r.always_use_default_value ?? r.always_use_value,
        clickLookbackDays: r.click_lookback_days ?? r.click_lookback,
        viewLookbackDays: r.view_lookback_days ?? r.view_lookback,
        attributionModel: r.attribution_model || r.attribution,
        label: `${r.name || r.nazwa} (wiersz ${i + 2})`,
      }));
      const result = await createConversionActions(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'update-conversions') {
      // Single-item flags are allowed here (unlike create): promoting one action
      // to primary after its tag is verified is the everyday case.
      let items = [];
      if (args.input) {
        const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
        if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
        items = rows.map((r, i) => ({
          id: r.id || r.conversion_action_id,
          resourceName: r.resource_name,
          name: r.name,
          // Passed through only so the mutator can say "type is immutable" instead
          // of the misleading "this row changes nothing".
          type: r.type,
          category: r.category,
          status: r.status,
          primaryForGoal: r.primary_for_goal ?? r.primary,
          countingType: r.counting_type || r.counting,
          defaultValue: r.default_value ?? r.value,
          currency: r.currency,
          alwaysUseDefaultValue: r.always_use_default_value,
          clickLookbackDays: r.click_lookback_days ?? r.click_lookback,
          viewLookbackDays: r.view_lookback_days ?? r.view_lookback,
          attributionModel: r.attribution_model || r.attribution,
          label: `${r.name || r.id} (wiersz ${i + 2})`,
        }));
      } else if (args.id) {
        items = [{
          id: args.id,
          name: args.name,
          type: args.type,
          category: args.category,
          status: args.status,
          primaryForGoal: args.primary,
          countingType: args.counting,
          defaultValue: args.value,
          currency: args.currency,
          alwaysUseDefaultValue: args['always-use-value'],
          clickLookbackDays: args['click-lookback'],
          viewLookbackDays: args['view-lookback'],
          attributionModel: args.attribution,
          label: `konwersja ${args.id}`,
        }];
      }
      if (items.length === 0) throw new Error('update-conversions wymaga --input=zmiany.csv (kolumna id + zmieniane pola) albo --id=123 z flagami (np. --primary=true, --status=HIDDEN, --value=150 --currency=PLN)');
      const result = await updateConversionActions(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else if (action === 'add-listing-groups') {
      if (!args.input) throw new Error('add-listing-groups wymaga --input=mapa.csv (kolumny: ad_group_id,product_item_ids) — ID rozdziel | ; lub przecinkiem, albo daj jeden wiersz na produkt');
      const rows = parseCsv(readFileSync(path.resolve(args.input), 'utf8'));
      if (rows.length === 0) throw new Error(`Plik --input jest pusty lub bez wierszy danych: ${args.input}`);
      const items = rows.map((r, i) => ({
        adGroupId: r.ad_group_id,
        itemIds: String(r.product_item_ids || r.product_item_id || r.item_id || '')
          .split(/[|;,]/).map((v) => v.trim()).filter(Boolean),
        label: `grupa ${r.ad_group_id} (wiersz ${i + 2})`,
      }));
      const result = await addListingGroups(customerId, items, dryRun, loginCustomerId);
      console.log(JSON.stringify(result, null, 2));
    }

    else {
      console.error(`❌ Nieznana akcja: ${action}`);
      printHelp();
      process.exit(1);
    }

    // Make the simulation impossible to mistake for a completed change.
    if (isMutation && dryRun) {
      console.log(`\n🔒 SYMULACJA — nic nie zapisano na koncie ${name || customerId}.`);
      console.log(`   Aby zatwierdzić, powtórz tę samą komendę z flagą --commit (bez --dry-run).`);
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
