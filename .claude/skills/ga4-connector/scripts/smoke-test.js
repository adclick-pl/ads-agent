#!/usr/bin/env node
/**
 * Offline self-test — no credentials, no network. Checks the pure logic:
 * filter parsing, date maths, property resolution.
 *
 *   node scripts/smoke-test.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseFilter, dateRange } from './api.js';
import { resolveProperty, resolveTarget, tokenPath } from './config.js';
import { parseCompareRange, daysInRange, isRatioMetric, assertNoTimeDimension, mergeCompare } from './compare.js';

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

console.log('\nGA4 connector — test offline\n');

console.log('Filtry:');
check('zawiera', () =>
  eq(parseFilter('sessionSource=~google'), {
    filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'CONTAINS', value: 'google', caseSensitive: false } },
  })
);
check('NIE zawiera zawija się w notExpression', () =>
  eq(parseFilter('sessionSource!~spam'), {
    notExpression: {
      filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'CONTAINS', value: 'spam', caseSensitive: false } },
    },
  })
);
check('lista wartości', () =>
  eq(parseFilter('hostName=@a.pl|b.pl'), {
    filter: { fieldName: 'hostName', inListFilter: { values: ['a.pl', 'b.pl'], caseSensitive: false } },
  })
);
check('próg liczbowy', () =>
  eq(parseFilter('sessions>100'), {
    filter: { fieldName: 'sessions', numericFilter: { operation: 'GREATER_THAN', value: { int64Value: '100' } } },
  })
);
check('dwa warunki = andGroup', () => {
  const f = parseFilter('sessionSource!~spam;sessionSource!~bot');
  if (!f.andGroup || f.andGroup.expressions.length !== 2) throw new Error('brak andGroup z 2 warunkami');
});
check('pusty filtr = undefined', () => eq(parseFilter(''), undefined));
check('śmieciowy warunek rzuca czytelny błąd', () => throws(() => parseFilter('coś tam'), /Nie rozumiem warunku/));

console.log('\nZakres dat:');
check('--days=30 kończy się na wczoraj', () => eq(dateRange({ days: 30 }), { startDate: '30daysAgo', endDate: 'yesterday' }));
check('--include-today przesuwa okno', () =>
  eq(dateRange({ days: 30, includeToday: true }), { startDate: '29daysAgo', endDate: 'today' })
);
check('jawne daty wygrywają', () =>
  eq(dateRange({ days: 30, from: '2026-01-01', to: '2026-01-31' }), { startDate: '2026-01-01', endDate: '2026-01-31' })
);
check('sam --from domyka się na wczoraj', () =>
  eq(dateRange({ from: '2026-01-01' }), { startDate: '2026-01-01', endDate: 'yesterday' })
);

console.log('\nUsługa:');
check('goły numer', () => eq(resolveProperty('123456789'), '123456789'));
check('prefiks properties/', () => eq(resolveProperty('properties/123456789'), '123456789'));
check('brak wartości = podpowiedź', () => throws(() => resolveProperty(''), /--action=properties/));
check('nieznany alias = podpowiedź', () => throws(() => resolveProperty('Nie Ma Takiego'), /Nie rozpoznaję property/));

// Registry resolution against a throwaway .claude/accounts.json.
console.log('\nRejestr .claude/accounts.json:');
const fixture = path.join(os.tmpdir(), `ga4-accounts-test-${process.pid}.json`);
fs.writeFileSync(
  fixture,
  JSON.stringify({
    _README: 'plik testowy',
    zielonyogrod: { name: 'Zielony Ogród', id: '123-456-7890', ga4PropertyId: '123456789', aliases: ['ogrod'], default: true },
    bezga4: { name: 'Klient Bez GA4', id: '2233445566' },
    zprefiksem: { name: 'Z Prefiksem', id: '9999999999', ga4PropertyId: 'properties/555000111' },
    drugiefirma: { name: 'Druga Firma', id: '4444444444', ga4PropertyId: '444555666', ga4Profile: 'firma2' },
  })
);
process.env.GA4_ACCOUNTS_PATH = fixture;

try {
  check('po kluczu', () => eq(resolveProperty('zielonyogrod'), '123456789'));
  check('po aliasie', () => eq(resolveProperty('ogrod'), '123456789'));
  check('po nazwie, bez względu na wielkość liter', () => eq(resolveProperty('zielony ogród'), '123456789'));
  check('prefiks properties/ w rejestrze jest obcinany', () => eq(resolveProperty('zprefiksem'), '555000111'));
  check('numeryczne ID wygrywa z rejestrem', () => eq(resolveProperty('777777777'), '777777777'));
  check('konto default, gdy nic nie podano', () => eq(resolveProperty(undefined), '123456789'));
  check('konto bez ga4PropertyId = instrukcja co dopisać', () =>
    throws(() => resolveProperty('bezga4'), /nie ma pola ga4PropertyId/)
  );
  check('nieznany selektor wypisuje konta z rejestru', () =>
    throws(() => resolveProperty('nieistnieje'), /Konta w rejestrze: zielonyogrod, bezga4, zprefiksem, drugiefirma/)
  );
  check('wpisy z _ nie są kontami', () => throws(() => resolveProperty('_README'), /Nie rozpoznaję property/));

  console.log('\nProfile (kilka kont Google):');
  check('brak ga4Profile = profil domyślny', () => eq(resolveTarget('zielonyogrod').profile, undefined));
  check('ga4Profile z rejestru jest brany', () => eq(resolveTarget('drugiefirma').profile, 'firma2'));
  check('--profile nadpisuje rejestr', () => eq(resolveTarget('drugiefirma', 'inny').profile, 'inny'));
  check('numeryczne ID też dziedziczy profil z rejestru', () =>
    eq(resolveTarget('444555666').profile, 'firma2')
  );
  check('profil dokleja się do nazwy pliku', () =>
    eq(tokenPath('firma2').endsWith('ga4-token-firma2.json'), true)
  );
  check('brak profilu = domyślny plik', () => eq(tokenPath().endsWith('ga4-token.json'), true));
  check('nazwa profilu ze slashem odrzucona', () =>
    throws(() => tokenPath('../../etc/passwd'), /Niedozwolona nazwa profilu/)
  );
} finally {
  fs.unlinkSync(fixture);
  delete process.env.GA4_ACCOUNTS_PATH;
}

// --- porównanie okresów (--compare) ---------------------------------------
check('parseCompareRange czyta poprawny zapis', () =>
  eq(parseCompareRange('2026-06-20:2026-07-09'), { startDate: '2026-06-20', endDate: '2026-07-09' })
);
check('parseCompareRange odrzuca śmieci i odwrócony zakres', () => {
  throws(() => parseCompareRange('20.06-09.07'), /Niepoprawny --compare/);
  throws(() => parseCompareRange('2026-07-09:2026-06-20'), /jest po końcu/);
});
check('daysInRange liczy oba końce włącznie', () => {
  eq(daysInRange('2026-06-20', '2026-07-09'), 20);
  eq(daysInRange('2026-08-04', '2026-08-17'), 14);
  eq(daysInRange('2026-08-04', '2026-08-04'), 1);
});
check('isRatioMetric rozpoznaje wskaźniki', () => {
  eq([ 'bounceRate', 'engagementRate', 'averageSessionDuration', 'screenPageViewsPerSession' ].map(isRatioMetric), [true, true, true, true]);
  eq([ 'sessions', 'engagedSessions', 'screenPageViews', 'keyEvents' ].map(isRatioMetric), [false, false, false, false]);
});
check('assertNoTimeDimension blokuje wymiar czasu', () => {
  throws(() => assertNoTimeDimension(['date', 'landingPage']), /nie działa z wymiarem czasu/);
  assertNoTimeDimension(['landingPage', 'deviceCategory']); // nie rzuca
});
check('mergeCompare: równe okna → porównanie na sumach', () => {
  const r = mergeCompare({
    baseRows: [{ landingPage: '/a', sessions: 100 }],
    refRows: [{ landingPage: '/a', sessions: 80 }],
    dimensions: ['landingPage'], metrics: ['sessions'], baseDays: 20, refDays: 20,
  });
  eq(r.perDay, false);
  eq(r.rows[0].sessions, 100);
  eq(r.rows[0].sessions_ref, 80);
  eq(r.rows[0]['sessions_Δ%'], 25);
});
check('mergeCompare: różne okna → NA DZIEŃ (inaczej krótsze okno kłamie)', () => {
  // 140 w 14 dni = 10/dzień, 200 w 20 dni = 10/dzień → realnie bez zmian
  const r = mergeCompare({
    baseRows: [{ landingPage: '/a', sessions: 140 }],
    refRows: [{ landingPage: '/a', sessions: 200 }],
    dimensions: ['landingPage'], metrics: ['sessions'], baseDays: 14, refDays: 20,
  });
  eq(r.perDay, true);
  eq(r.rows[0].sessions, 10);
  eq(r.rows[0].sessions_ref, 10);
  eq(r.rows[0]['sessions_Δ%'], 0);
});
check('mergeCompare: wskaźnika NIE dzieli przez dni', () => {
  const r = mergeCompare({
    baseRows: [{ landingPage: '/a', bounceRate: 40 }],
    refRows: [{ landingPage: '/a', bounceRate: 35 }],
    dimensions: ['landingPage'], metrics: ['bounceRate'], baseDays: 14, refDays: 20,
  });
  eq(r.rows[0].bounceRate, 40);
  eq(r.rows[0].bounceRate_ref, 35);
});
check('mergeCompare: wiersz tylko w odniesieniu nie ginie (strona po migracji zniknęła)', () => {
  const r = mergeCompare({
    baseRows: [{ landingPage: '/nowa', sessions: 10 }],
    refRows: [{ landingPage: '/stara', sessions: 50 }],
    dimensions: ['landingPage'], metrics: ['sessions'], baseDays: 20, refDays: 20,
  });
  eq(r.rows.length, 2);
  const stara = r.rows.find((x) => x.landingPage === '/stara');
  eq([stara.sessions, stara.sessions_ref, stara['sessions_Δ%']], [0, 50, -100]);
});
check('mergeCompare: brak odniesienia = null (a nie mylące +100%)', () => {
  const r = mergeCompare({
    baseRows: [{ landingPage: '/nowa', sessions: 10 }],
    refRows: [], dimensions: ['landingPage'], metrics: ['sessions'], baseDays: 20, refDays: 20,
  });
  eq(r.rows[0]['sessions_Δ%'], null);
});

console.log(failed ? `\n❌ Nieudanych: ${failed}\n` : '\n✓ Wszystko przeszło. Logika działa bez sieci i bez credentiali.\n');
process.exit(failed ? 1 : 0);
