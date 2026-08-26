#!/usr/bin/env node
/**
 * Search Console connector CLI — read-only.
 *
 *   node scripts/cli.js --action=<akcja> [--site=<property albo alias>] [opcje]
 *
 * Run without arguments for the full action list.
 */

import fs from 'fs';
import * as gsc from './api.js';
import {
  loadAccounts, accountsFile, listProfiles, tokenPath, registryTarget,
  rememberSite, proposeAlias, likelyExisting, siteHost, isSiteLike, looksLikeBareDomain,
} from './config.js';

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
// notices the rest. Left alone, `--start=2026-07-20` is silently dropped, the
// report quietly falls back to the default window, and the numbers come back
// looking perfectly reasonable for the WRONG period. That is the worst kind of
// failure — not a crash, a plausible lie. So every token on the command line
// has to be accounted for before anything runs.
// ---------------------------------------------------------------------------
const VALUE_FLAGS = new Set([
  'account', 'action', 'as', 'concurrency', 'contains', 'data-state', 'days',
  'dimensions', 'filter', 'from', 'limit', 'output', 'profile', 'property',
  'show', 'site', 'to', 'type', 'url', 'urls-file',
]);
const BOOL_FLAGS = new Set(['help', 'json']);

// Names people reach for that mean something else here. Guessing by edit
// distance would never get `start` -> `from`, and that is the one that bites.
const SYNONIMY = {
  start: 'from', begin: 'from', since: 'from', 'date-from': 'from', startdate: 'from',
  end: 'to', until: 'to', 'date-to': 'to', enddate: 'to',
  domain: 'site', host: 'site', 'site-url': 'site', siteurl: 'site', page: 'url',
  dimension: 'dimensions', dim: 'dimensions', metric: 'dimensions',
  csv: 'output', file: 'output', out: 'output',
  rows: 'limit', top: 'limit', period: 'days', range: 'days',
  urls: 'urls-file', 'url-file': 'urls-file', 'urls_file': 'urls-file',
  datastate: 'data-state', state: 'data-state', fresh: 'data-state',
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

// --account and --property are accepted as synonyms of --site, so all three
// connectors take the same selector: `--account=zielonyogrod` works everywhere.
const siteArg = () => arg('site', arg('account', arg('property')));
// Which Google login to use. Usually unnecessary: the registry's gscProfile
// picks it per client. Pass it explicitly to override, or for actions that
// aren't scoped to a property (sites, test-connection).
const profileArg = () => arg('profile');

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
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const shown = rows.slice(0, limit);
  const fmt = (v) => {
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
    if (Array.isArray(v)) return v.join(', ');
    // null = "wartość nie istnieje" (np. pozycja w dniu bez wyświetleń) — pokazana
    // wprost jako kreska, żeby nie wyglądała jak zero ani jak pusta komórka.
    if (v === null || v === undefined) return '–';
    const s = String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  };
  const widths = cols.map((c) => Math.max(c.length, ...shown.map((r) => fmt(r[c]).length)));
  const numeric = cols.map((c) => shown.every((r) => typeof r[c] === 'number' || r[c] === null || r[c] === undefined));
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

  // A guessed property must be visible — otherwise an empty table reads as
  // "no data" when it really means "asked the wrong property".
  if (!Array.isArray(result) && result.assumed) console.log(`ℹ️  ${result.assumed}\n`);

  // Context line first — a table of numbers without its property and date range
  // lies by omission, and "which property did this actually ask?" is the first
  // question whenever the answer looks wrong.
  if (!Array.isArray(result) && result.site) {
    console.log(
      `Property ${result.site}` +
        (result.dateRange
          ? ` · ${result.dateRange.startDate} → ${result.dateRange.endDate}` +
            ` · dane: ${result.dataState === 'all' ? 'ze świeżymi (niepełne)' : 'ostateczne'}` +
            ` · wierszy: ${result.rowCount}`
          : '')
    );
    console.log('');
  }
  console.log(table(rows));

  // A batch where half the URLs errored still prints a full-looking table —
  // say how many rows are failures, not verdicts.
  if (!Array.isArray(result) && result.failed) {
    console.log(`\n⚠️  ${result.failed} z ${rows.length} adresów zakończyło się błędem (wiersze z verdict=BŁĄD).`);
  }

  // Search Console lags 2–3 days. Silence here is exactly what makes people
  // think the site stopped ranking, so say it before they draw that conclusion.
  if (!Array.isArray(result) && result.dateRange && rows.length === 0) {
    console.log(
      '\nℹ️  Zero wierszy. Zanim uznasz, że ruch zniknął: dane ostateczne w Search Console\n' +
        '   są opóźnione o 2–3 dni, więc świeży zakres bywa pusty. Sprawdź szerszy --days,\n' +
        '   dopisz --data-state=all (dane świeże, niepełne), albo potwierdź property: --action=sites'
    );
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
function readUrlsFile(file) {
  const urls = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!urls.length) throw new Error(`Plik ${file} nie zawiera żadnych adresów (pomijam puste linie i komentarze #).`);
  return urls;
}

/** --contains=X is shorthand for the filter people write most often. */
function filterExpr() {
  const parts = [];
  if (arg('contains')) parts.push(`page=~${arg('contains')}`);
  if (arg('filter')) parts.push(arg('filter'));
  return parts.join(';') || undefined;
}

const ACTIONS = {
  'test-connection': async () => gsc.testConnection(profileArg()),
  sites: async () => gsc.sites(profileArg()),
  profiles: async () => listProfiles().map((p) => ({ profil: p.label, plik: p.file })),

  sitemaps: async () => gsc.sitemaps({ site: siteArg(), profile: profileArg() }),

  query: async () =>
    gsc.searchAnalytics({
      site: siteArg(),
      profile: profileArg(),
      days: arg('days'),
      from: arg('from'),
      to: arg('to'),
      dimensions: list('dimensions', ['page']),
      filter: filterExpr(),
      limit: arg('limit') ? Number(arg('limit')) : undefined,
      type: arg('type'),
      dataState: arg('data-state'),
    }),

  inspect: async () => {
    const res = await gsc.inspect({ site: siteArg(), url: arg('url'), profile: profileArg() });
    const s = gsc.summarizeInspection(res, arg('url'));
    return asJson ? res : { site: res.site, assumed: res.assumed, rows: [s] };
  },

  'inspect-batch': async () => {
    const file = arg('urls-file');
    if (!file) {
      throw new Error(
        'Brak --urls-file=<plik>. Jeden adres na linię, linie z # są pomijane.\n' +
          'Listę adresów do sprawdzenia zbudujesz z ruchu:\n' +
          '  --action=query --dimensions=page --limit=200 --output=strony.csv'
      );
    }
    return gsc.inspectBatch({
      site: siteArg(),
      urls: readUrlsFile(file),
      profile: profileArg(),
      concurrency: Number(arg('concurrency', '5')),
      onProgress: (done, total) => process.stderr.write(`\r  ${done}/${total}   `),
    }).then((r) => {
      process.stderr.write('\n');
      return r;
    });
  },

  diagnose: async () =>
    gsc.diagnose({ site: siteArg(), profile: profileArg(), days: Number(arg('days', '28')) }),

  // The connector's only write. Run it ONLY after the user has confirmed the
  // proposal printed under a report — never as an automatic follow-up.
  remember: async () => {
    const site = siteArg();
    const alias = arg('as');
    if (!alias) {
      throw new Error(
        'Brak --as=<alias>. Alias staje się selektorem dla WSZYSTKICH konektorów\n' +
          '(--account=<alias> w Adsach, --property=<alias> w GA4, --site=<alias> tutaj),\n' +
          'więc podaje go człowiek.\n' +
          'Przykład: --action=remember --site="sc-domain:zielonyogrod.example" --as=zielonyogrod'
      );
    }
    const wynik = rememberSite({ site, alias, name: siteHost(site), profile: profileArg() });
    const opis = {
      dopisane: `Dopisałem nowe konto „${wynik.key}”.`,
      uzupelnione: `Uzupełniłem istniejące konto „${wynik.key}” o gscSite — bez tworzenia duplikatu.`,
      'bez-zmian': wynik.note,
    }[wynik.action];
    return {
      wynik: opis,
      plik: wynik.file,
      sprawdz: `node scripts/cli.js --action=query --site=${wynik.key} --days=28`,
    };
  },
};

/**
 * After a successful `sites` run in a repo with no registry: say how to start one.
 *
 * `sites` is the natural FIRST command in a fresh checkout, and without this the
 * run succeeds silently — the only mention of the registry sits in --help, which
 * nobody reads after a command that worked. Proposal only: the write itself goes
 * through --action=remember and needs the user's word.
 */
function zaproponujRejestr(listaSites) {
  if (accountsFile()) return;
  const pierwsza = listaSites?.[0]?.site;
  const profil = profileArg();
  console.log(`\n💡 Rejestru kont (.claude/accounts.json) jeszcze nie ma — dlatego property`);
  console.log('   trzeba podawać pełnym zapisem. Po założeniu rejestru wystarczy alias,');
  console.log('   wspólny z konektorami Google Ads i GA4 (--site=zielonyogrod).');
  console.log('   Rejestr powstaje przy pierwszym zapisie — po jednej property, za potwierdzeniem:');
  console.log(
    `   node scripts/cli.js --action=remember --site="${pierwsza || 'sc-domain:zielonyogrod.example'}" --as=<alias>` +
      (profil ? ` --profile=${profil}` : '')
  );
  console.log('   Pełny format pól: .claude/skills/gads-connector/references/accounts.example.json');
}

/**
 * After a successful property-scoped run: if the property was given literally
 * and is not in the registry, PROPOSE remembering it. Proposal only — the write
 * needs the user's word. Never allowed to break the command it follows.
 */
function zaproponujZapamietanie() {
  const podane = siteArg();
  if (!podane || !(isSiteLike(podane) || looksLikeBareDomain(podane))) return;

  const site = isSiteLike(podane) ? podane : `sc-domain:${podane.toLowerCase()}`;
  const host = siteHost(site);
  if (loadAccounts().some((a) => a.gscSite && siteHost(a.gscSite) === host)) return;

  const alias = proposeAlias(site);
  if (!alias) return;

  const istnieje = likelyExisting(alias);
  const klucz = istnieje?.key || alias;

  console.log(`\n💡 Property ${site} nie jest w rejestrze.`);
  if (istnieje) {
    console.log(`   W rejestrze jest już konto „${istnieje.key}”${istnieje.name ? ` (${istnieje.name})` : ''} bez przypisanej property GSC.`);
  } else if (!accountsFile()) {
    console.log('   Rejestru jeszcze nie ma — powstanie przy pierwszym zapisie.');
  }
  console.log(`   Zapamiętać jako „${klucz}”, żeby następnym razem wystarczyło --site=${klucz}?`);
  console.log(`   node scripts/cli.js --action=remember --site="${site}" --as=${klucz}`);
}

/**
 * 403/404 on a site-scoped call is almost always the wrong PROPERTY FORM, not a
 * missing permission — so answer the question the error raises: what does this
 * login actually have for that host?
 */
async function podpowiedzProperty(e) {
  if (![403, 404].includes(e.status) || !e.site) return;
  const host = siteHost(e.site);
  const widoczne = await gsc.sites(e.profile);
  const bliskie = widoczne.filter((s) => siteHost(s.site) === host || siteHost(s.site).endsWith(`.${host}`) || host.endsWith(`.${siteHost(s.site)}`));

  if (bliskie.length) {
    console.error('Ten login widzi dla tej domeny:');
    for (const s of bliskie) console.error(`   ${s.site}   (${s.typ}, uprawnienie: ${s.uprawnienie})`);
    console.error('\nUżyj dokładnie tego zapisu w --site=.');
  } else if (widoczne.length) {
    console.error(`Ten login nie widzi żadnej property dla „${host}”. Widzi za to ${widoczne.length}:`);
    for (const s of widoczne.slice(0, 10)) console.error(`   ${s.site}`);
    if (widoczne.length > 10) console.error(`   … i ${widoczne.length - 10} więcej (--action=sites)`);
    console.error('\nJeśli property należy do innego konta Google, wskaż jego profil (--action=profiles).');
  } else {
    console.error('Ten login nie widzi ŻADNEJ property — najpewniej autoryzowałeś nie to konto.');
  }
}

function usage() {
  let registry = '';
  try {
    const accounts = loadAccounts();
    const withGsc = accounts.filter((a) => a.gscSite);
    if (!accounts.length && !accountsFile()) {
      registry =
        `\nREJESTR KONT — jeszcze nie istnieje (${registryTarget()})\n` +
        `  Aliasy nie zadziałają, dopóki nie powstanie. Podawaj property wprost albo\n` +
        `  pozwól konektorowi zaproponować zapis: po zapytaniu z jawną property wypisze\n` +
        `  gotową komendę --action=remember.\n`;
    } else if (accounts.length) {
      registry =
        `\nREJESTR KONT (${accountsFile()})\n` +
        `  z property GSC: ${withGsc.map((a) => a.key || a.name).join(', ') || '(żadne — dopisz "gscSite")'}\n` +
        (withGsc.length < accounts.length
          ? `  bez GSC:        ${accounts.filter((a) => !a.gscSite).map((a) => a.key || a.name).join(', ')}\n`
          : '');
    }
  } catch {
    // A broken registry must not stop --help from printing.
  }
  console.log(`
Search Console connector — tylko odczyt (zakres webmasters.readonly).

  node scripts/cli.js --action=<akcja> --site=<property albo alias konta> [opcje]

PROPERTY — dwa różne obiekty, nie synonimy
  sc-domain:example.com     property domenowa (wszystkie subdomeny, http i https)
  https://example.com/      prefiks URL — musi się zgadzać CO DO ZNAKU, ze slashem
  O nieistniejącą formę Google pyta się 403, nie „nie ma takiej” — dlatego przy
  403/404 konektor sam wypisze, co ten login naprawdę widzi dla tej domeny.

DANE Z WYSZUKIWARKI
  query               kliknięcia/wyświetlenia/CTR/pozycja wg --dimensions
                      (query, page, country, device, date, searchAppearance)
  sitemaps            zgłoszone mapy witryny, ich błędy i daty pobrania

INDEKSOWANIE
  inspect             pojedynczy URL: czy w indeksie, jaki canonical wybrał Google
  inspect-batch       próbka URL-i z pliku (--urls-file=, --concurrency=5)
  diagnose            sitemapy + ruch + werdykt strony głównej w jednym rzucie

DIAGNOSTYKA
  sites               wszystkie property widoczne dla konta — tu sprawdzisz zapis
  test-connection     czy autoryzacja działa
  profiles            które konta Google są autoryzowane

REJESTR — jedyny zapis konektora
  remember            zapamiętaj property pod aliasem: --site=<property> --as=<alias>
                      Uruchamiaj TYLKO po potwierdzeniu użytkownika.

KILKA KONT GOOGLE
  --action=sites pokazuje, co widzi autoryzowany login. Widzi wszystko — profile
  są zbędne. Brakuje property — autoryzuj login, który ją widzi, jako profil
  (osobny plik tokena).
  node scripts/auth.js --step=url --profile=firma2      # autoryzacja drugiego konta
  --profile=firma2                                      # wymuś login w dowolnej akcji
  W rejestrze pole "gscProfile": "firma2" przypisuje login do klienta na stałe.

ZAKRES DAT
  --days=90                ostatnie 90 dni (do wczoraj włącznie)
  --from=2026-01-01 --to=2026-01-31
  Dane ostateczne są opóźnione o 2–3 dni. --data-state=all dokłada świeże,
  niepełne dane (dobre do „czy dziś coś się dzieje”, złe do porównań).
  Wiersz bez wyświetleń (np. dzień dopełniony zerami przy --dimensions=date)
  nie ma pozycji ani CTR — konektor zwraca tam null (w tabeli „–”), bo
  „pozycja 0” nie istnieje i zaniżałaby każdą średnią.

FILTRY (łącz średnikiem = AND; tylko query, page, country, device, searchAppearance)
  --filter="page=~/blog/"            zawiera
  --filter="query!~marka"            NIE zawiera
  --filter="page==https://x.pl/a/"   dokładnie
  --filter="query=/^jak /"           wyrażenie regularne
  --contains=/k/                     skrót na --filter="page=~/k/"

CZEGO API NIE DA — nie obiecuj tego użytkownikowi
  Zbiorczego raportu „Indeksowanie stron” (ile URL-i w „Duplikat, Google wybrał inną
  stronę kanoniczną”) ani statystyk indeksowania. To tylko interfejs GSC. Zamiast
  tego: inspect-batch na reprezentatywnej próbce — te same werdykty, per URL.
  Limity URL Inspection: 2000/dobę, 600/min. Dane starsze niż ~16 miesięcy: brak.

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
  const result = await run();
  emit(result);
  if (action !== 'remember' && !outFile && !asJson) {
    // A proposal must never turn a successful report into a failure.
    try {
      if (action === 'sites') zaproponujRejestr(result);
      else zaproponujZapamietanie();
    } catch {
      /* ignore */
    }
  }
} catch (e) {
  console.error(`\n❌ ${e.message}\n`);
  // The hint needs a second API call; if that fails too, keep the original error.
  await podpowiedzProperty(e).catch(() => {});
  process.exit(1);
}
