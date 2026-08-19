#!/usr/bin/env node
/**
 * GA4 connector CLI — read-only.
 *
 *   node scripts/cli.js --action=<akcja> [--property=ID] [opcje] [--json|--output=plik.csv]
 *
 * Run without arguments for the full action list.
 */

import fs from 'fs';
import * as ga4 from './api.js';
import {
  loadAccounts, accountsFile, listProfiles, tokenPath,
  rememberProperty, proposeAlias, likelyExisting, cleanDisplayName, registryTarget,
} from './config.js';
import { parseCompareRange, assertNoTimeDimension, mergeCompare, daysInRange } from './compare.js';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const list = (name, fallback) => {
  const v = arg(name);
  if (v === undefined) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

// ---------------------------------------------------------------------------
// Flag validation — the whole flag surface, declared once.
//
// The parser above is a "pull" parser: it looks for what it wants and never
// notices the rest. Left alone, `--start=2025-07-20` is silently dropped, the
// report quietly falls back to the default window, and the numbers come back
// looking perfectly reasonable for the WRONG period. In an analytics tool that
// is the worst possible failure: not a crash, a plausible lie. So every token
// on the command line has to be accounted for before anything runs.
// ---------------------------------------------------------------------------
const VALUE_FLAGS = new Set([
  'account', 'action', 'by', 'cohorts', 'compare', 'days', 'dimensions', 'filter',
  'from', 'limit', 'metric-filter', 'metrics', 'only', 'order', 'output', 'profile',
  'property', 'show', 'to', 'as',
]);
const BOOL_FLAGS = new Set(['custom', 'help', 'include-today', 'json', 'keep-empty-rows']);

// Names people reach for that mean something else here. Guessing by edit distance
// would never get `start` -> `from`, and that is the one that actually bit us.
const SYNONIMY = {
  start: 'from', begin: 'from', since: 'from', 'date-from': 'from', startdate: 'from',
  end: 'to', until: 'to', 'date-to': 'to', enddate: 'to',
  prop: 'property', 'property-id': 'property', propertyid: 'property',
  metric: 'metrics', dimension: 'dimensions', dim: 'dimensions',
  csv: 'output', file: 'output', out: 'output',
  rows: 'limit', top: 'limit', sort: 'order',
  period: 'days', range: 'days', 'compare-to': 'compare',
};

function odleglosc(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function podpowiedz(nazwa) {
  const n = nazwa.toLowerCase().replace(/[^a-z-]/g, '');
  if (SYNONIMY[n]) return SYNONIMY[n];
  const wszystkie = [...VALUE_FLAGS, ...BOOL_FLAGS];
  const [best] = wszystkie
    .map((k) => ({ k, d: odleglosc(n, k) }))
    .sort((a, b) => a.d - b.d);
  return best && best.d <= 3 ? best.k : null;
}

function sprawdzArgumenty() {
  const bledy = [];
  for (const token of process.argv.slice(2)) {
    if (!token.startsWith('--')) {
      bledy.push(`Nieoczekiwany argument „${token}”. Wszystkie opcje mają postać --nazwa=wartość.`);
      continue;
    }
    const [nazwa] = token.slice(2).split('=');
    const zWartoscia = token.includes('=');

    if (VALUE_FLAGS.has(nazwa)) {
      if (!zWartoscia) {
        bledy.push(`--${nazwa} wymaga wartości po znaku równości: --${nazwa}=<wartość> (spacja nie zadziała).`);
      }
      continue;
    }
    if (BOOL_FLAGS.has(nazwa)) {
      if (zWartoscia) bledy.push(`--${nazwa} nie przyjmuje wartości — użyj samego --${nazwa}.`);
      continue;
    }
    const moze = podpowiedz(nazwa);
    bledy.push(`Nieznana opcja --${nazwa}${moze ? ` — czy chodziło o --${moze}?` : ''}`);
  }

  if (bledy.length) {
    console.error('\n❌ Nie uruchomiłem zapytania — argumenty są niepoprawne:\n');
    for (const b of bledy) console.error(`   ${b}`);
    console.error(
      '\nPrzerywam celowo. Zignorowanie nieznanej opcji dałoby wynik dla innego okresu\n' +
        'albo innego zakresu danych niż zamierzony — a taka pomyłka wygląda jak poprawne dane.\n' +
        'Pełna lista opcji: --help\n'
    );
    process.exit(1);
  }
}

sprawdzArgumenty();

const action = arg('action');
const asJson = flag('json');
const outFile = arg('output');
const showArg = arg('show', '25');
const showRows = showArg === 'all' ? Infinity : Number(showArg);

// --account is accepted as a synonym of --property so both connectors take the
// same selector: `--account=zielonyogrod` works for Ads and for GA4 alike.
const propertyArg = () => arg('property', arg('account'));
// Which Google login to use. Usually unnecessary: the registry's ga4Profile
// picks it per client. Pass it explicitly to override, or for actions that
// aren't scoped to a property (properties, test-connection).
const profileArg = () => arg('profile');

// ---------------------------------------------------------------------------
// presets — the reports we actually keep asking for
// ---------------------------------------------------------------------------
const PRESETS = {
  traffic: {
    dimensions: ['sessionDefaultChannelGroup'],
    metrics: ['sessions', 'totalUsers', 'engagedSessions', 'keyEvents', 'totalRevenue'],
    order: '-sessions',
  },
  sources: {
    dimensions: ['sessionSourceMedium'],
    metrics: ['sessions', 'engagedSessions', 'keyEvents', 'totalRevenue'],
    order: '-sessions',
  },
  campaigns: {
    dimensions: ['sessionCampaignName', 'sessionSourceMedium'],
    metrics: ['sessions', 'keyEvents', 'totalRevenue'],
    order: '-sessions',
  },
  'landing-pages': {
    dimensions: ['landingPagePlusQueryString'],
    metrics: ['sessions', 'engagedSessions', 'keyEvents', 'totalRevenue'],
    order: '-sessions',
  },
  ecommerce: {
    dimensions: ['itemName'],
    metrics: ['itemRevenue', 'itemsPurchased'],
    order: '-itemRevenue',
  },
};

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function writeCsv(rows, file) {
  if (!rows.length) {
    fs.writeFileSync(file, '');
    console.log(`Zapisano 0 wierszy → ${file}`);
    return;
  }
  const cols = Object.keys(rows[0]);
  const body = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
  fs.writeFileSync(file, body.join('\n') + '\n');
  console.log(`Zapisano ${rows.length} wierszy → ${file}`);
}

function table(rows, limit = showRows) {
  if (!rows.length) return '(brak wierszy)';
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, limit);
  const fmt = (v) => {
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
    const s = v === null || v === undefined ? '' : String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  };
  const widths = cols.map((c) => Math.max(c.length, ...shown.map((r) => fmt(r[c]).length)));
  const numeric = cols.map((c) => shown.every((r) => typeof r[c] === 'number'));
  const line = (cells) =>
    cells.map((cell, i) => (numeric[i] ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ');

  const out = [line(cols), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of shown) out.push(line(cols.map((c) => fmt(r[c]))));
  if (rows.length > shown.length) {
    out.push(`… ${rows.length - shown.length} więcej (--show=N albo --output=plik.csv)`);
  }
  return out.join('\n');
}

function emit(result, rowsKey = 'rows') {
  const rows = Array.isArray(result) ? result : result?.[rowsKey];

  if (outFile) {
    if (!Array.isArray(rows)) {
      console.error('--output=CSV działa tylko dla akcji zwracających wiersze.');
      process.exit(1);
    }
    writeCsv(rows, outFile);
    return;
  }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!Array.isArray(rows)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Context line first — a table of numbers without its date range lies by omission.
  if (!Array.isArray(result) && result.dateRange) {
    const q = result.quota?.tokensPerDay;
    console.log(
      `Usługa ${result.property} · ${result.dateRange.startDate} → ${result.dateRange.endDate}` +
        (result.timeZone ? ` · ${result.timeZone}` : '') +
        (result.currency ? ` · ${result.currency}` : '') +
        // With --limit the API still reports the full match count; say both, so
        // "wierszy: 8" is never mistaken for "tyle ich w ogóle jest".
        ` · wierszy: ${rows.length}${result.rowCount > rows.length ? ` z ${result.rowCount}` : ''}` +
        (q ? ` · limit dobowy: ${q.remaining}/${q.consumed + q.remaining}` : '')
    );
    if (result.compareRange) {
      console.log(
        `Odniesienie (_ref): ${result.compareRange.startDate} → ${result.compareRange.endDate}` +
          ` · dni: ${result.days.badany} vs ${result.days.odniesienia}` +
          (result.perDay
            ? ' · ⚠️  okna różnej długości → wartości i zmiany liczone NA DZIEŃ (wskaźniki bez zmian)'
            : ' · zmiany liczone na sumach')
      );
    }
    if (result.thresholded) {
      console.log('⚠️  Część wierszy ukryta przez próg danych GA4 (Google Signals) — sumy będą zaniżone.');
    }
    console.log('');
  }
  console.log(table(rows));
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
const reportOpts = () => ({
  property: propertyArg(),
  profile: profileArg(),
  days: arg('days'),
  from: arg('from'),
  to: arg('to'),
  includeToday: flag('include-today'),
  filter: arg('filter'),
  metricFilter: arg('metric-filter'),
  limit: arg('limit') ? Number(arg('limit')) : undefined,
  keepEmptyRows: flag('keep-empty-rows'),
});

/**
 * Raport z opcjonalnym okresem odniesienia (`--compare=od:do`).
 *
 * Bez `--compare` zachowuje się dokładnie jak `ga4.report`. Z `--compare`
 * odpytuje GA4 dwa razy (każde okno osobno — dzięki temu wskaźniki liczy Google,
 * a nie my) i zestawia wiersze po wymiarach.
 */
async function reportMaybeCompare({ dimensions, metrics, order }) {
  const base = { ...reportOpts(), dimensions, metrics, order };
  const spec = arg('compare');
  if (!spec) return ga4.report(base);

  assertNoTimeDimension(dimensions);
  const ref = parseCompareRange(spec);

  // --limit NIE może iść do API przy porównaniu. GA4 przycina każde okno OSOBNO,
  // a scalenie jest później: wiersz mieszczący się w top-N okna bieżącego, który
  // w oknie odniesienia jest N+1, w ogóle nie zostałby pobrany i wyrenderowałby
  // się jako 0 — nie do odróżnienia od prawdziwego zera. Oba okna pobieramy więc
  // w całości, a limit stosujemy dopiero po scaleniu.
  const { limit, ...pelneOkna } = base;

  const [a, b] = await Promise.all([
    ga4.report(pelneOkna),
    // Okno odniesienia zawsze jako jawny zakres — `days`/`include-today` z
    // głównego zapytania nie mogą go przesunąć.
    ga4.report({ ...pelneOkna, days: undefined, includeToday: false, from: ref.startDate, to: ref.endDate }),
  ]);

  const baseDays = daysInRange(a.dateRange.startDate, a.dateRange.endDate);
  const refDays = daysInRange(b.dateRange.startDate, b.dateRange.endDate);
  const { rows, perDay } = mergeCompare({
    baseRows: a.rows, refRows: b.rows, dimensions, metrics, baseDays, refDays,
  });

  // Dopiero teraz przycinamy — na scalonym, kompletnym zestawie. rowCount zostaje
  // pełny, więc nagłówek pokazuje „wierszy: 4 z 17" i widać, że coś odcięto.
  const przyciete = limit ? rows.slice(0, limit) : rows;

  return {
    ...a,
    rows: przyciete,
    rowCount: rows.length,
    compareRange: b.dateRange,
    days: { badany: baseDays, odniesienia: refDays },
    perDay,
    thresholded: a.thresholded || b.thresholded,
  };
}

async function preset(name) {
  const p = PRESETS[name];
  return reportMaybeCompare({
    dimensions: list('dimensions', p.dimensions),
    metrics: list('metrics', p.metrics),
    order: arg('order', p.order),
  });
}

/**
 * One-shot health check for "GA4 nie zgadza się z Ads": is a stream collecting,
 * is the property linked to Ads, what attribution is set, how much traffic falls
 * into direct/none (the classic symptom of a broken consent or tagging setup).
 */
async function diagnose() {
  const property = propertyArg();
  const profile = profileArg();
  const [streams, links, attribution, channels] = await Promise.all([
    ga4.streams({ property, profile }),
    ga4.adsLinks({ property, profile }),
    ga4.attribution({ property, profile }),
    ga4.report({
      property,
      profile,
      days: arg('days', '30'),
      dimensions: ['sessionDefaultChannelGroup'],
      metrics: ['sessions'],
      order: '-sessions',
    }),
  ]);

  const total = channels.rows.reduce((s, r) => s + (r.sessions || 0), 0);
  const direct = channels.rows.find((r) => r.sessionDefaultChannelGroup === 'Direct')?.sessions || 0;
  const paid = channels.rows
    .filter((r) => /Paid|Cross-network/i.test(r.sessionDefaultChannelGroup))
    .reduce((s, r) => s + r.sessions, 0);

  return {
    property: channels.property,
    okres: `${channels.dateRange.startDate} → ${channels.dateRange.endDate}`,
    strumienie: streams,
    polaczenieZAds: links.length ? links : '⚠️  BRAK połączenia z Google Ads',
    atrybucja: attribution,
    udzialDirect: total ? `${((100 * direct) / total).toFixed(1)}%` : 'brak danych',
    udzialPlatnych: total ? `${((100 * paid) / total).toFixed(1)}%` : 'brak danych',
    kanaly: channels.rows,
    uwagi: [
      streams.length === 0 && 'Brak strumieni danych — usługa nic nie zbiera.',
      !links.length && 'Brak połączenia GA4 ↔ Google Ads: konwersje i listy odbiorców nie przepłyną.',
      total && direct / total > 0.5 && 'Direct > 50% — typowe dla zepsutego consent mode albo utraty parametrów przy przekierowaniach.',
      total === 0 && 'Zero sesji w okresie — sprawdź, czy to na pewno właściwa usługa.',
    ].filter(Boolean),
  };
}

const ACTIONS = {
  'test-connection': async () => ga4.testConnection(profileArg()),
  properties: async () => ga4.properties(profileArg()),
  profiles: async () => listProfiles().map((p) => ({ profil: p.label, plik: p.file })),
  report: async () =>
    reportMaybeCompare({
      dimensions: list('dimensions', []),
      metrics: list('metrics', ['sessions']),
      order: arg('order'),
    }),
  traffic: () => preset('traffic'),
  sources: () => preset('sources'),
  campaigns: () => preset('campaigns'),
  'landing-pages': () => preset('landing-pages'),
  ecommerce: () => preset('ecommerce'),
  realtime: async () =>
    ga4.realtime({
      property: propertyArg(),
      profile: profileArg(),
      dimensions: list('dimensions', ['unifiedScreenName']),
      metrics: list('metrics', ['activeUsers']),
      limit: Number(arg('limit', '50')),
    }),
  metadata: async () => {
    const m = await ga4.metadata({ property: propertyArg(), profile: profileArg() });
    const only = arg('only'); // dimensions | metrics
    const custom = flag('custom');
    const pick = (a) => (custom ? a.filter((x) => x.custom) : a);
    if (only === 'dimensions') return { property: m.property, rows: pick(m.dimensions) };
    if (only === 'metrics') return { property: m.property, rows: pick(m.metrics) };
    return { property: m.property, dimensions: pick(m.dimensions), metrics: pick(m.metrics) };
  },
  cohort: async () =>
    ga4.cohort({
      property: propertyArg(),
      profile: profileArg(),
      cohorts: Number(arg('cohorts', '12')),
      extraDimension: arg('by'),
      metrics: list('metrics', undefined),
    }),
  streams: async () => ga4.streams({ property: propertyArg(), profile: profileArg() }),
  'key-events': async () => ga4.keyEvents({ property: propertyArg(), profile: profileArg() }),
  'custom-dimensions': async () => ga4.customDimensions({ property: propertyArg(), profile: profileArg() }),
  attribution: async () => ga4.attribution({ property: propertyArg(), profile: profileArg() }),
  'ads-links': async () => ga4.adsLinks({ property: propertyArg(), profile: profileArg() }),
  diagnose,

  // The connector's only write. Run it ONLY after the user has confirmed the
  // proposal printed under a report — never as an automatic follow-up.
  remember: async () => {
    const id = propertyArg();
    const alias = arg('as');
    if (!alias) {
      throw new Error(
        'Brak --as=<alias>. Alias staje się selektorem dla OBU konektorów\n' +
          '(--account=<alias> w Adsach, --property=<alias> w GA4), więc podaje go człowiek.\n' +
          'Przykład: --action=remember --property=123456789 --as=zielonyogrod'
      );
    }
    const lista = await ga4.properties(profileArg()).catch(() => []);
    const znaleziona = lista.find((p) => String(p.propertyId) === String(id).replace(/^properties\//, ''));
    const wynik = rememberProperty({
      propertyId: id,
      alias,
      name: cleanDisplayName(znaleziona?.property),
      profile: profileArg(),
    });
    const opis = {
      dopisane: `Dopisałem nowe konto „${wynik.key}”.`,
      uzupelnione: `Uzupełniłem istniejące konto „${wynik.key}” o ga4PropertyId — bez tworzenia duplikatu.`,
      'bez-zmian': wynik.note,
    }[wynik.action];
    return {
      wynik: opis,
      plik: wynik.file,
      sprawdz: `node scripts/cli.js --action=traffic --property=${wynik.key} --days=7`,
    };
  },
};

/**
 * After a successful property-scoped run: if the property was given as a raw id
 * and is not in the registry, PROPOSE remembering it. Proposal only — the write
 * needs the user's word. Never allowed to break the command it follows.
 */
async function zaproponujZapamietanie() {
  const podane = propertyArg();
  if (!podane || !/^\d+$/.test(String(podane).replace(/^properties\//, ''))) return;
  const id = String(podane).replace(/^properties\//, '');
  if (loadAccounts().some((a) => a.ga4PropertyId === id)) return;

  const lista = await ga4.properties(profileArg());
  const nazwa = lista.find((p) => String(p.propertyId) === id)?.property;
  const alias = proposeAlias(nazwa);
  if (!alias) return;

  const istnieje = likelyExisting(alias);
  const klucz = istnieje?.key || alias;
  const gdzie = accountsFile();

  console.log(`\n💡 Usługa ${id}${nazwa ? ` („${nazwa}")` : ''} nie jest w rejestrze.`);
  if (istnieje) {
    console.log(`   W rejestrze jest już konto „${istnieje.key}”${istnieje.name ? ` (${istnieje.name})` : ''} bez przypisanej usługi GA4.`);
  } else if (!gdzie) {
    console.log(`   Rejestru jeszcze nie ma — powstanie przy pierwszym zapisie.`);
  }
  console.log(`   Zapamiętać jako „${klucz}”, żeby następnym razem wystarczyło --property=${klucz}?`);
  console.log(`   node scripts/cli.js --action=remember --property=${id} --as=${klucz}`);
}

function usage() {
  let registry = '';
  try {
    const accounts = loadAccounts();
    const withGa4 = accounts.filter((a) => a.ga4PropertyId);
    if (!accounts.length && !accountsFile()) {
      registry =
        `\nREJESTR KONT — jeszcze nie istnieje (${registryTarget()})\n` +
        `  Aliasy nie zadziałają, dopóki nie powstanie. Podawaj numeryczne ID albo\n` +
        `  pozwól konektorowi zaproponować zapis: po raporcie z surowym ID wypisze\n` +
        `  gotową komendę --action=remember.\n`;
    } else if (accounts.length) {
      registry =
        `\nREJESTR KONT (${accountsFile()})\n` +
        `  z usługą GA4:  ${withGa4.map((a) => a.key || a.name).join(', ') || '(żadne — dopisz "ga4PropertyId")'}\n` +
        (withGa4.length < accounts.length
          ? `  bez GA4:       ${accounts.filter((a) => !a.ga4PropertyId).map((a) => a.key || a.name).join(', ')}\n`
          : '');
    }
  } catch {
    // A broken registry must not stop --help from printing.
  }
  console.log(`
GA4 connector — tylko odczyt (zakres analytics.readonly).

  node scripts/cli.js --action=<akcja> --property=<ID albo alias konta> [opcje]

RAPORTY
  report              dowolne zapytanie: --dimensions=, --metrics=, --order=
  traffic             sesje wg grupy kanałów
  sources             sesje wg źródło/medium
  campaigns           sesje wg kampanii (do zestawienia z Google Ads)
  landing-pages       strony docelowe
  ecommerce           produkty: itemRevenue, itemsPurchased
  cohort              kohorty miesięczne (--cohorts=12, --by=firstUserSourceMedium)
  realtime            ostatnie 30 minut — czy tag w ogóle zbiera

KONFIGURACJA USŁUGI (Admin API, też tylko odczyt)
  properties          wszystkie usługi widoczne dla konta — tu znajdziesz ID
  streams             strumienie danych + measurement ID
  key-events          kluczowe zdarzenia
  custom-dimensions   wymiary niestandardowe
  attribution         model atrybucji i okna konwersji
  ads-links           czy usługa jest połączona z Google Ads
  metadata            wszystkie dostępne wymiary/metryki (--only=, --custom)

DIAGNOSTYKA
  diagnose            strumienie + Ads + atrybucja + udział Direct w jednym rzucie
  test-connection     czy autoryzacja działa
  profiles            które konta Google są autoryzowane

REJESTR — jedyny zapis konektora
  remember            zapamiętaj usługę pod aliasem: --property=<ID> --as=<alias>
                      Uruchamiaj TYLKO po potwierdzeniu użytkownika. Po raporcie
                      z surowym ID konektor sam wypisze gotową propozycję.

KILKA KONT GOOGLE
  Jeden login rzadko widzi wszystkie usługi klientów. Profil = osobny plik tokena.
  node scripts/auth.js --step=url --profile=firma2      # autoryzacja drugiego konta
  --profile=firma2                                      # wymuś login w dowolnej akcji
  W rejestrze kont pole "ga4Profile": "firma2" przypisuje login do klienta na stałe,
  więc przy --property=<alias> nie musisz o nim pamiętać.

ZAKRES DAT
  --days=30                ostatnie 30 PEŁNYCH dni (do wczoraj włącznie)
  --from=2026-01-01 --to=2026-01-31
  --include-today          dopisz dzisiejszy, niepełny dzień

PORÓWNANIE OKRESÓW ("przed vs po")
  --compare=2026-06-20:2026-07-09
      Dokłada okres odniesienia. Każda metryka dostaje trzy kolumny:
      <metryka>, <metryka>_ref (odniesienie), <metryka>_Δ%.
      Oba okna liczy GA4 osobno, więc wskaźniki (bounceRate, engagementRate,
      averageSessionDuration) są poprawnie zważone — nie uśredniamy ich lokalnie.
      Gdy okna mają różną długość, wartości i zmiany są liczone NA DZIEŃ
      (wskaźników się nie dzieli). Nie łączy się z wymiarem czasu (date itp.).
      Wiersze obecne tylko w okresie odniesienia też są pokazane.

      node scripts/cli.js --action=report --property=<ID> \\
        --dimensions=landingPage --metrics=sessions,engagedSessions \\
        --from=2026-08-04 --to=2026-08-17 --compare=2026-06-20:2026-07-09

FILTRY (łącz średnikiem = AND)
  --filter="sessionSource=~google"        zawiera
  --filter="sessionSource!~spam"          NIE zawiera
  --filter="itemName==Sofa Nord"          dokładnie
  --filter="hostName=@a.pl|b.pl"          z listy
  --metric-filter="sessions>100"          próg liczbowy

WYJŚCIE
  (domyślnie) tabela   --show=N     --show=all     --json     --output=plik.csv
${registry}
Token: ${tokenPath()}
`);
}

// ---------------------------------------------------------------------------
if (!action || flag('help')) {
  usage();
  process.exit(action ? 0 : 1);
}

const run = ACTIONS[action];
if (!run) {
  console.error(`Nieznana akcja „${action}”.\n`);
  usage();
  process.exit(1);
}

try {
  emit(await run());
  if (action !== 'remember' && !outFile && !asJson) {
    // A proposal must never turn a successful report into a failure.
    await zaproponujZapamietanie().catch(() => {});
  }
} catch (e) {
  console.error(`\n❌ ${e.message}\n`);
  process.exit(1);
}
