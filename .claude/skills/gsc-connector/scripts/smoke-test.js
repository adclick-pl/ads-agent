#!/usr/bin/env node
/**
 * Offline self-test — no credentials, no network. Checks the pure logic:
 * property normalisation, selector resolution, filter parsing, date maths,
 * inspection shaping and registry writes (against a throwaway registry).
 *
 *   node scripts/smoke-test.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseFilter, dateRange, summarizeInspection, isoDay, assertQueryShape } from './api.js';
import {
  normalizeSite, looksLikeBareDomain, isSiteLike, siteHost, resolveTarget,
  proposeAlias, assertProfileName, rememberSite, loadAccounts, tokenPath,
} from './config.js';

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};
const eq = (got, want, label = '') => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${label}\n      oczekiwano: ${b}\n      otrzymano:  ${a}`);
};
const throws = (fn, re) => {
  try {
    fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`inny błąd niż oczekiwany: ${e.message}`);
    return;
  }
  throw new Error('oczekiwano wyjątku, nie było');
};

console.log('\nSearch Console connector — test offline\n');

// ---------------------------------------------------------------------------
console.log('Property (domenowa vs prefiks URL):');
check('property domenowa — małe litery, bez końcowego slasha', () =>
  eq(normalizeSite('sc-domain:Zielonyogrod.Example/'), 'sc-domain:zielonyogrod.example')
);
check('prefiks URL zawsze kończy się slashem', () =>
  eq(normalizeSite('https://zielonyogrod.example'), 'https://zielonyogrod.example/')
);
check('host małymi literami, ale ŚCIEŻKA zachowuje wielkość znaków', () =>
  eq(normalizeSite('https://Zielonyogrod.Example/Sklep'), 'https://zielonyogrod.example/Sklep/')
);
check('domenowa i prefiks URL to dwa RÓŻNE obiekty', () => {
  if (normalizeSite('sc-domain:zielonyogrod.example') === normalizeSite('https://zielonyogrod.example/')) {
    throw new Error('zlały się w jedno — 403 z GSC byłby nie do wyjaśnienia');
  }
});
check('rozpoznawanie zapisu property', () => {
  eq([isSiteLike('sc-domain:a.example'), isSiteLike('https://a.example/'), isSiteLike('zielonyogrod')], [true, true, false]);
});
check('goła domena to domena, alias to nie domena', () =>
  eq([looksLikeBareDomain('zielonyogrod.example'), looksLikeBareDomain('zielonyogrod'), looksLikeBareDomain('sc-domain:a.example')], [true, false, false])
);
check('siteHost obcina www i schemat', () =>
  eq([siteHost('https://www.zielonyogrod.example/'), siteHost('sc-domain:zielonyogrod.example')], ['zielonyogrod.example', 'zielonyogrod.example'])
);

// ---------------------------------------------------------------------------
console.log('\nFiltry:');
check('zawiera', () =>
  eq(parseFilter('page=~/blog/'), [{ dimension: 'page', operator: 'contains', expression: '/blog/' }])
);
check('NIE zawiera', () =>
  eq(parseFilter('query!~marka'), [{ dimension: 'query', operator: 'notContains', expression: 'marka' }])
);
check('dokładnie', () =>
  eq(parseFilter('query==buty'), [{ dimension: 'query', operator: 'equals', expression: 'buty' }])
);
check('NIE dokładnie', () =>
  eq(parseFilter('query!=buty'), [{ dimension: 'query', operator: 'notEquals', expression: 'buty' }])
);
check('wyrażenie regularne', () =>
  eq(parseFilter('query=/^jak '), [{ dimension: 'query', operator: 'includingRegex', expression: '^jak' }])
);
check('dwa warunki łączone średnikiem (AND)', () =>
  eq(parseFilter('page=~/k/;query!~marka'), [
    { dimension: 'page', operator: 'contains', expression: '/k/' },
    { dimension: 'query', operator: 'notContains', expression: 'marka' },
  ])
);
check('filtr po dacie odrzucony z podpowiedzią (GSC tego nie ma)', () =>
  throws(() => parseFilter('date==2026-01-01'), /--days|--from/)
);
check('nieznany wymiar odrzucony', () => throws(() => parseFilter('landingPage=~/a/'), /Search Console pozwala/));
check('warunek bez operatora odrzucony', () => throws(() => parseFilter('page'), /Nie rozumiem/));
check('pusty filtr = brak filtra', () => eq(parseFilter(''), undefined));

// ---------------------------------------------------------------------------
console.log('\nKształt zapytania (rzeczy, które Google przemilcza):');
check('poprawne wymiary przechodzą', () =>
  assertQueryShape({ dimensions: ['query', 'page', 'date'], type: 'web', dataState: 'all' })
);
check('literówka w wymiarze odrzucona', () =>
  throws(() => assertQueryShape({ dimensions: ['pages'] }), /Nieznany wymiar/)
);
check('błędny --data-state odrzucony (Google po cichu dałby dane ostateczne)', () =>
  throws(() => assertQueryShape({ dataState: 'fresh' }), /po cichu|Dozwolone/)
);
check('błędny --type odrzucony', () => throws(() => assertQueryShape({ type: 'organic' }), /Nieznany --type/));
check('brak opcjonalnych pól nie jest błędem', () => assertQueryShape({ dimensions: ['page'] }));

// ---------------------------------------------------------------------------
console.log('\nZakres dat:');
const NOW = Date.parse('2026-08-26T12:00:00Z');
check('--days=7 kończy się WCZORAJ, nie dziś', () =>
  eq(dateRange({ days: 7, now: NOW }), { startDate: '2026-08-19', endDate: '2026-08-25' })
);
check('domyślnie 90 dni', () =>
  eq(dateRange({ now: NOW }), { startDate: '2026-05-28', endDate: '2026-08-25' })
);
check('--from/--to mają pierwszeństwo', () =>
  eq(dateRange({ days: 7, from: '2026-01-01', to: '2026-01-31', now: NOW }), {
    startDate: '2026-01-01',
    endDate: '2026-01-31',
  })
);
check('sam --from: koniec nadal wczoraj', () =>
  eq(dateRange({ from: '2026-08-01', now: NOW }), { startDate: '2026-08-01', endDate: '2026-08-25' })
);
check('isoDay tnie do dnia', () => eq(isoDay(NOW), '2026-08-26'));

// ---------------------------------------------------------------------------
console.log('\nInspekcja URL:');
check('rozjazd canonical wykryty', () => {
  const s = summarizeInspection(
    {
      inspectionResult: {
        indexStatusResult: {
          verdict: 'PASS',
          coverageState: 'Przesłano i zaindeksowano',
          googleCanonical: 'https://zielonyogrod.example/a/',
          userCanonical: 'https://zielonyogrod.example/b/',
          referringUrls: ['https://zielonyogrod.example/'],
        },
      },
    },
    'https://zielonyogrod.example/b/'
  );
  eq([s.verdict, s.canonicalMismatch, s.referringUrls.length], ['PASS', true, 1]);
});
check('brak canonical to NIE rozjazd', () => {
  const s = summarizeInspection({ inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL' } } }, 'https://x.example/');
  eq([s.verdict, s.canonicalMismatch, s.coverageState], ['NEUTRAL', false, null]);
});
check('pusta odpowiedź nie wywraca podsumowania', () => {
  const s = summarizeInspection({}, 'https://x.example/');
  eq([s.url, s.verdict, s.sitemaps.length], ['https://x.example/', null, 0]);
});

// ---------------------------------------------------------------------------
console.log('\nProfile:');
check('poprawna nazwa przechodzi', () => eq(assertProfileName('firma2'), 'firma2'));
check('pusta nazwa = profil domyślny', () => eq(assertProfileName(''), undefined));
check('nazwa ze slashem odrzucona (trafia do nazwy pliku)', () =>
  throws(() => assertProfileName('../etc/passwd'), /Niedozwolona/)
);
check('token profilu w osobnym pliku', () => {
  if (tokenPath('firma2') === tokenPath()) throw new Error('profil nadpisałby token domyślny');
});

// ---------------------------------------------------------------------------
console.log('\nRejestr kont (na kopii jednorazowej):');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-smoke-'));
const tmpRejestr = path.join(tmpDir, 'accounts.json');
process.env.GSC_ACCOUNTS_PATH = tmpRejestr;
fs.writeFileSync(
  tmpRejestr,
  JSON.stringify(
    {
      _README: 'plik testowy',
      zielonyogrod: {
        name: 'Zielony Ogród',
        id: '1234567890',
        gscSite: 'sc-domain:zielonyogrod.example',
        gscProfile: 'firma2',
        aliases: ['ogrod'],
      },
      bezgsc: { name: 'Bez GSC', id: '2233445566' },
    },
    null,
    2
  )
);

check('alias → property + login z rejestru', () =>
  eq(resolveTarget('zielonyogrod'), { site: 'sc-domain:zielonyogrod.example', profile: 'firma2' })
);
check('alias poboczny działa tak samo', () =>
  eq(resolveTarget('ogrod'), { site: 'sc-domain:zielonyogrod.example', profile: 'firma2' })
);
check('jawny --profile bije gscProfile z rejestru', () =>
  eq(resolveTarget('zielonyogrod', 'inny').profile, 'inny')
);
check('property podana wprost dziedziczy login z rejestru', () =>
  eq(resolveTarget('sc-domain:zielonyogrod.example').profile, 'firma2')
);
check('prefiks URL tej samej domeny NIE dziedziczy loginu (to inna property)', () =>
  eq(resolveTarget('https://zielonyogrod.example/'), { site: 'https://zielonyogrod.example/', profile: undefined })
);
check('konto bez gscSite → błąd mówi, co dopisać', () =>
  throws(() => resolveTarget('bezgsc'), /gscSite/)
);
check('nieznany selektor wymienia, co jest w rejestrze', () =>
  throws(() => resolveTarget('nieznane'), /Nie rozpoznaję|rejestr/i)
);
check('goła domena = ZGADYWANA property domenowa, oznaczona jako założenie', () => {
  const r = resolveTarget('cos.example');
  eq(r.site, 'sc-domain:cos.example');
  if (!r.assumed) throw new Error('brak ostrzeżenia — puste wyniki wyglądałyby jak brak ruchu');
});

check('remember: uzupełnia istniejące konto zamiast tworzyć duplikat', () => {
  const r = rememberSite({ site: 'sc-domain:bezgsc.example', alias: 'bezgsc' });
  eq(r.action, 'uzupelnione');
  const wpis = loadAccounts().find((a) => a.key === 'bezgsc');
  eq(wpis.gscSite, 'sc-domain:bezgsc.example');
  eq(wpis.adsId, '2233445566', 'ID Ads musi przetrwać dopisanie GSC');
});
check('remember: druga próba tej samej property nic nie zmienia', () =>
  eq(rememberSite({ site: 'sc-domain:bezgsc.example', alias: 'inny-klucz' }).action, 'bez-zmian')
);
check('remember: nowe konto dopisane z profilem', () => {
  const r = rememberSite({ site: 'https://nowy.example/', alias: 'nowy', profile: 'firma2' });
  eq(r.action, 'dopisane');
  const wpis = loadAccounts().find((a) => a.key === 'nowy');
  eq([wpis.gscSite, wpis.gscProfile], ['https://nowy.example/', 'firma2']);
});
check('remember: property w złym formacie odrzucona', () =>
  throws(() => rememberSite({ site: 'zielonyogrod.example', alias: 'x' }), /sc-domain|https/)
);
check('remember: alias ze spacją odrzucony', () =>
  throws(() => rememberSite({ site: 'sc-domain:x.example', alias: 'zły alias' }), /Alias/)
);
check('rejestr nadal jest poprawnym JSON-em po zapisach', () => {
  JSON.parse(fs.readFileSync(tmpRejestr, 'utf8'));
});

check('proposeAlias z property domenowej', () =>
  eq(proposeAlias('sc-domain:zielony-ogrod.example'), 'zielonyogrod')
);
check('proposeAlias z prefiksu URL z www', () =>
  eq(proposeAlias('https://www.zielonyogrod.example/'), 'zielonyogrod')
);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failed ? `\n❌ Nieudanych: ${failed}\n` : '\n✓ Wszystko przeszło. Logika działa bez sieci i bez credentiali.\n');
process.exit(failed ? 1 : 0);
