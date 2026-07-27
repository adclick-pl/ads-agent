#!/usr/bin/env node

/**
 * smoke-test.js — offline test logiki wykluczeń. Bez API, bez sieci, bez sekretów.
 *
 *   node smoke-test.js
 *
 * Sprawdza to, co decyduje o tym, czy hasło wyleci z konta: progi sygnałów, poziomy
 * pewności, obronę wynikiem rocznym, rozpoznawanie zbadanych tematów i to, że raport
 * w ogóle się renderuje. Progi są tu zapisane wprost — jeśli któryś zmienisz w
 * `analiza.js`, ten plik ma o tym głośno powiedzieć.
 */

import {
    getWordTokens, jaccardSim, calcSemanticOverlap, calcKeywordCoverage, MIN_POKRYCIE_SLOWA_KLUCZOWEGO,
    collectUncertainTerms, computeExclusionReasons, yearPerformanceReason,
    poziomSygnalu, poziomHasla, isDefendedByYear, isKnownTopic, knownTopicsFromStatus,
    buildCampExclusionCandidates, withYearSignal, splitCandidatesByYear, progKlikniec,
    yearKey, campStatsFromRows, averagesFromCampStats,
} from './analiza.js';
import { buildReport } from './raport-html.js';
import { setCurrency, getDates } from './format.js';

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const eq = (name, actual, expected) =>
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), `oczekiwano ${JSON.stringify(expected)}, jest ${JSON.stringify(actual)}`);

const term = (o = {}) => ({
    term: 'hasło', campaign: 'Kampania', adGroup: 'Grupa',
    impressions: 100, clicks: 10, cost: 100, conversions: 0, value: 0, ...o
});

setCurrency('PLN');

console.log('\n🧪 Wykluczenia haseł — smoke test\n');

// ── Tokenizacja i podobieństwo ────────────────────────────────
console.log('Tokenizacja i podobieństwo');
eq('stopwordy i krótkie słowa wypadają', getWordTokens('serwis rowerów w krakowie na już'), ['serwis', 'rowerów', 'krakowie', 'już']);
ok('odmiana tego samego słowa jest podobna', jaccardSim('montaż', 'montażu') > 0.6);
ok('różne słowa o wspólnym rdzeniu nie są podobne', jaccardSim('praca', 'pracownik') < 0.4);
ok('hasło z obcym słowem ma niski overlap',
    calcSemanticOverlap('praca w serwisie rowerowym', ['naprawa rowerów']) < 0.6);
ok('hasło gubiące kwalifikator ma niskie pokrycie wsteczne',
    calcKeywordCoverage('serwis rowerów', ['mobilny serwis rowerów kraków']) < 0.75);
// Granica czułości: brak JEDNEGO słowa z 4-wyrazowego słowa kluczowego daje dokładnie
// 0,75 — poniżej progu, więc hasło idzie do oceny. Test pilnuje, żeby zmiana progu albo
// tokenizacji nie przesunęła tej granicy po cichu (przy progu 0,75 taki przypadek uchodził
// za trafiony i nigdy nie był oceniany).
ok('brak jednego słowa z długiego słowa kluczowego daje dokładnie 0,75',
    calcKeywordCoverage('serwis rowerów kraków', ['mobilny serwis rowerów kraków']) === 0.75);
ok('…i trafia poniżej progu, czyli do oceny',
    calcKeywordCoverage('serwis rowerów kraków', ['mobilny serwis rowerów kraków']) < MIN_POKRYCIE_SLOWA_KLUCZOWEGO);
ok('hasło pokrywające całe słowo kluczowe ma wysokie pokrycie wsteczne',
    calcKeywordCoverage('mobilny serwis rowerów kraków tanio', ['mobilny serwis rowerów kraków']) >= 0.75);

// ── Hasła niepewne ────────────────────────────────────────────
console.log('\nHasła niepewne (materiał dla oceny AI)');
{
    const st = [
        term({ term: 'bambus', campaign: 'A', impressions: 50, clicks: 5, cost: 30 }),
        term({ term: 'bambus', campaign: 'B', impressions: 20, clicks: 2, cost: 20 }),
        term({ term: 'konwertujące', conversions: 2 }),
        term({ term: 'szum', impressions: 1 }),
    ];
    const u = collectUncertainTerms(st, {});
    eq('hasło z dwóch kampanii występuje raz', u.length, 1);
    eq('koszt zsumowany po kampaniach', u[0].cost, 50);
    eq('obie kampanie zapamiętane', u[0].kampanie.sort(), ['A', 'B']);
}
{
    const st = [term({ term: 'naprawa rowerów kraków' })];
    const kws = { 'Kampania|||Grupa': ['naprawa rowerów kraków'] };
    eq('hasło trafione tematycznie nie idzie do oceny', collectUncertainTerms(st, kws).length, 0);
}

// ── Sygnał wydajnościowy z 30 dni ─────────────────────────────
console.log('\nSygnał wydajnościowy (30 dni)');
{
    const pusto = new Map();
    const r = computeExclusionReasons(term({ cost: 300, clicks: 10 }), {}, 100, pusto, false);
    ok('leadgen: koszt ponad 2× CPA bez konwersji → sygnał', r.some(x => x.kind === 'wydajnosc'));

    const r2 = computeExclusionReasons(term({ cost: 150, clicks: 10 }), {}, 100, pusto, false);
    ok('leadgen: koszt poniżej 2× CPA → brak sygnału', !r2.some(x => x.kind === 'wydajnosc'));

    const r3 = computeExclusionReasons(term({ cost: 300, clicks: 4 }), {}, 100, pusto, false);
    ok('leadgen: poniżej 5 kliknięć → brak sygnału (za mało danych)', !r3.some(x => x.kind === 'wydajnosc'));

    const rEcom = computeExclusionReasons(term({ cost: 300, clicks: 10, value: 100 }), {}, 4, pusto, true, { avgCostPerConv: 100 });
    ok('ecom: ROAS 0,33 przy koszcie 3× CPA → sygnał', rEcom.some(x => x.kind === 'wydajnosc'));

    const rTanie = computeExclusionReasons(term({ cost: 20, clicks: 10, value: 0 }), {}, 4, pusto, true, { avgCostPerConv: 100 });
    ok('ecom: tanie hasło bez konwersji → brak sygnału (próg kosztowy)', !rTanie.some(x => x.kind === 'wydajnosc'));

    const rAI = computeExclusionReasons(term(), {}, null, new Map([['hasło', { powod: 'inna branża', serp: true, pewnosc: 90 }]]), false);
    ok('ocena AI trafia do powodów', rAI.some(x => x.kind === 'ai'));
    eq('ocena AI z pewnością ≥ 80 jest pewna', poziomSygnalu(rAI.find(x => x.kind === 'ai'), null), 'pewny');

    const rAI2 = computeExclusionReasons(term(), {}, null, new Map([['hasło', { powod: 'raczej nie', serp: false, pewnosc: 60 }]]), false);
    eq('ocena AI z pewnością < 80 idzie do sprawdzenia', poziomSygnalu(rAI2.find(x => x.kind === 'ai'), null), 'sprawdz');
}

// ── Sygnał roczny ─────────────────────────────────────────────
console.log('\nSygnał roczny');
{
    const rok = (o) => ({ clicks: 50, cost: 0, conversions: 0, value: 0, ...o });
    eq('rok bez konwersji, koszt ≥ 3× CPA → pewny',
        yearPerformanceReason(rok({ cost: 350 }), 100, null, false)?.level, 'pewny');
    eq('rok bez konwersji, koszt 2–3× CPA → do sprawdzenia',
        yearPerformanceReason(rok({ cost: 250 }), 100, null, false)?.level, 'sprawdz');
    eq('rok bez konwersji, koszt < 2× CPA → brak sygnału',
        yearPerformanceReason(rok({ cost: 150 }), 100, null, false), null);
    eq('leadgen: roczny CPA ponad 2× średniej → do sprawdzenia',
        yearPerformanceReason(rok({ cost: 500, conversions: 2 }), 100, null, false)?.level, 'sprawdz');
    eq('ecom: roczny ROAS poniżej 50% celu → do sprawdzenia',
        yearPerformanceReason(rok({ cost: 500, conversions: 2, value: 500 }), 100, 4, true)?.level, 'sprawdz');
}

// ── Poziom hasła i obrona rokiem ──────────────────────────────
console.log('\nPoziom hasła i obrona rokiem');
{
    const semantyka = { kind: 'semantyka', text: '' };
    eq('sama semantyka nigdy nie jest pewna', poziomSygnalu(semantyka, null), 'sprawdz');
    eq('trzy niepewne sygnały to nadal niepewność',
        poziomHasla([semantyka, semantyka, { kind: 'ai', pewnosc: 50 }], null), 'sprawdz');
    eq('wydajność potwierdzona rokiem bez konwersji jest pewna',
        poziomSygnalu({ kind: 'wydajnosc' }, { cost: 500, conversions: 0 }), 'pewny');

    ok('leadgen: roczny CPA w celu broni hasła',
        isDefendedByYear({ cost: 120, conversions: 1, value: 0 }, 100, false));
    ok('leadgen: roczny CPA 2× ponad cel nie broni',
        !isDefendedByYear({ cost: 250, conversions: 1, value: 0 }, 100, false));
    ok('ecom: roczny ROAS ≥ 75% celu broni hasła',
        isDefendedByYear({ cost: 100, conversions: 1, value: 320 }, 4, true));
    ok('sama stara konwersja bez wyniku nie broni',
        !isDefendedByYear({ cost: 1000, conversions: 1, value: 10 }, 4, true));
}

// ── Pamięć między rundami ─────────────────────────────────────
console.log('\nPamięć między rundami (status-kierowanie.md)');
{
    const status = `
## Hasła sprawdzone — zostawiamy
- \`fotel biurowy\` — pasuje do oferty (2026-07-01)
- \`serwis {miejscowość}\` — klaster geo, obsługujemy całą Polskę
- \`nazwamarki\` — nasza marka

Akapit z \`nazwą pliku\` nie jest wpisem listy.
`;
    const topics = knownTopicsFromStatus(status);
    eq('grawisy z akapitów są pomijane', topics.length, 3);
    ok('wpis wielowyrazowy łapie odmianę', isKnownTopic('fotele biurowe opinie', topics));
    ok('wpis wielowyrazowy nie łapie innego tematu', !isKnownTopic('fotel samochodowy', topics));
    ok('wieloznacznik łapie cały klaster', isKnownTopic('serwis laptopów gdańsk', topics));
    ok('wieloznacznik nie łapie samego rdzenia', !isKnownTopic('serwis', topics));
    ok('wpis jednowyrazowy musi trafić w całe hasło', !isKnownTopic('nazwamarki opinie', topics));
    ok('wpis jednowyrazowy łapie samo siebie', isKnownTopic('nazwamarki', topics));
}

// ── Kandydaci i kubełki ───────────────────────────────────────
console.log('\nKandydaci i podział na kubełki');
{
    eq('kampania produktowa ma próg 5 kliknięć', progKlikniec('PMax'), 5);
    eq('kampania Search nie ma progu kliknięć', progKlikniec('Search'), 0);

    const terms = [
        term({ term: 'drogie bez konwersji', cost: 400, clicks: 20 }),
        term({ term: 'tanie', cost: 10, clicks: 6 }),
        term({ term: 'ledwie klikane', cost: 400, clicks: 3 }),
    ];
    const kand = buildCampExclusionCandidates(terms, {}, 100, new Map(), false, 5);
    eq('kandydatem jest tylko hasło z sygnałem i ponad progiem', kand.map(k => k.term), ['drogie bez konwersji']);

    // Próg kliknięć broni sygnałów wydajnościowych, nie oceny AI: „czy hasło pasuje do
    // oferty" nie zależy od wolumenu. Bez tego wyjątku ocena 150 haseł w kampanii PMax
    // szła do kosza — kandydatem mogło zostać tylko hasło z 5+ kliknięciami.
    const ocenione = new Map([['niszowe spoza oferty', { powod: 'inna kategoria', serp: false, pewnosc: 90 }]]);
    const kandAI = buildCampExclusionCandidates(
        [term({ term: 'niszowe spoza oferty', clicks: 1, cost: 3 })], {}, 100, ocenione, false, 5
    );
    eq('ocena AI przechodzi mimo progu kliknięć kampanii produktowej', kandAI.map(k => k.term), ['niszowe spoza oferty']);
    eq('…i zostaje sygnałem pewnym', poziomHasla(kandAI[0].reasons, null), 'pewny');
    ok('samo słabe dopasowanie poniżej progu nadal odpada',
        buildCampExclusionCandidates(
            [term({ term: 'obce hasło', clicks: 1, impressions: 50 })],
            { 'Kampania|||Grupa': ['zupełnie inne słowo kluczowe'] }, 100, new Map(), false, 5
        ).length === 0);

    const yearMap = new Map([
        [yearKey('Kampania', 'drogie bez konwersji'), { clicks: 200, cost: 1200, conversions: 0, value: 0 }],
        [yearKey('Kampania', 'cichy przepalacz'), { clicks: 60, cost: 350, conversions: 0, value: 0 }],
        [yearKey('Kampania', 'sezonowe'), { clicks: 300, cost: 400, conversions: 5, value: 0 }],
    ]);
    const skan = [...terms, term({ term: 'cichy przepalacz', cost: 40, clicks: 6 })];
    const zRokiem = withYearSignal(kand, skan, 100, null, false, yearMap, 5);
    ok('sygnał roczny tworzy nowego kandydata z cichego przepalacza',
        zRokiem.some(c => c.term === 'cichy przepalacz'));

    const kandZSezonem = buildCampExclusionCandidates(
        [term({ term: 'sezonowe', cost: 400, clicks: 20 })], {}, 100, new Map(), false, 0
    );
    const split = splitCandidatesByYear([...zRokiem, ...kandZSezonem], 100, false, yearMap);
    ok('hasło z rokiem kosztów bez konwersji jest pewne',
        split.pewne.some(c => c.term === 'drogie bez konwersji'));
    ok('hasło trzymające roczny cel jest bronione, nie wykluczane',
        split.bronione.some(c => c.term === 'sezonowe'));
    ok('bronione nie trafia jednocześnie do wykluczeń',
        !split.pewne.concat(split.doSprawdzenia).some(c => c.term === 'sezonowe'));
}

// ── Średnie kampanii ──────────────────────────────────────────
console.log('\nŚrednie kampanii');
{
    const stats = campStatsFromRows([
        term({ campaign: 'A', cost: 100, conversions: 2, value: 400 }),
        term({ campaign: 'A', cost: 100, conversions: 0, value: 0 }),
        term({ campaign: 'B', cost: 50, conversions: 0, value: 0 }),
    ]);
    const { cpa, roas } = averagesFromCampStats(stats);
    eq('CPA kampanii liczony z sumy', cpa.A, 100);
    eq('ROAS kampanii liczony z sumy', roas.A, 2);
    eq('kampania bez konwersji nie ma CPA', cpa.B, null);
}

// ── Render raportu ────────────────────────────────────────────
console.log('\nRender raportu');
{
    const yearMap = new Map([
        [yearKey('Search Brand', 'hasło'), { clicks: 100, cost: 500, conversions: 0, value: 0 }],
        [yearKey('Search Ogólna', 'inne hasło'), { clicks: 40, cost: 200, conversions: 0, value: 0 }],
    ]);
    const kand = (t, camp) => ({
        term: t, row: term({ term: t, campaign: camp, cost: 400, clicks: 20 }),
        reasons: [{ kind: 'wydajnosc', text: 'Wysoki koszt' }]
    });
    const kampanie = [
        { camp: 'Search Brand', typ: 'Search', minKlikniec: 0, totals: { terms: 80, cost: 3000 },
          pewne: [kand('hasło', 'Search Brand')], doSprawdzenia: [], bronione: [] },
        { camp: 'Pmax Sklep', typ: 'PMax', minKlikniec: 5, totals: { terms: 900, cost: 1500 },
          pewne: [], doSprawdzenia: [kand('inne hasło', 'Search Ogólna')], bronione: [] },
        { camp: 'Search Czysta', typ: 'Search', minKlikniec: 0, totals: { terms: 10, cost: 500 },
          pewne: [], doSprawdzenia: [], bronione: [] },
    ];
    const html = buildReport({
        accountName: 'Konto <testowe>', isEcom: false, industry: '', dates: getDates(),
        benchOpis: 'średni koszt konwersji każdej kampanii',
        kampanie, yearMap,
        hasel: 990, kosztCalosc: 5000, ocenionychAI: 0, niepewnychDoOceny: 12
    });
    ok('każda kampania z kandydatami ma własną sekcję',
        (html.match(/class="camp-section"/g) || []).length === 2);
    ok('kampania bez kandydatów nie dostaje sekcji, tylko wzmiankę',
        !html.includes('>Search Czysta<') && html.includes('Search Czysta'));
    ok('sekcja z pewnymi startuje rozwinięta, pozostałe zwinięte',
        html.includes('<details class="camp-section" open>') &&
        (html.match(/<details class="camp-section">/g) || []).length === 1);
    ok('każda sekcja ma obie listy',
        (html.match(/Pewne — do wykluczenia/g) || []).length >= 2 &&
        (html.match(/Do sprawdzenia — decyduje człowiek/g) || []).length >= 2);
    ok('kampania produktowa informuje o progu kliknięć', html.includes('min. 5 kliknięciami'));
    ok('typ kampanii jest widoczny', html.includes('>PMax<'));
    ok('lista do skopiowania jest per kampania, w dopasowaniu ścisłym',
        html.includes('copy-camp-0') && html.includes('[hasło]'));
    ok('przy wielu kampaniach jest też lista zbiorcza', html.includes('copy-pewne'));
    ok('podsumowanie sumuje kubełki ze wszystkich kampanii',
        html.includes('Pewne — do wykluczenia</div><div class="kpi-value">1</div>') &&
        html.includes('Do sprawdzenia</div><div class="kpi-value">1</div>'));
    ok('nazwa konta jest escapowana', html.includes('Konto &lt;testowe&gt;'));
    ok('raport nie zawiera miejsc docelowych ani TOP-ów',
        !/miejsca docelowe/i.test(html) && !/TOP 15/i.test(html));
    ok('raport informuje o czekającej ocenie AI', html.includes('czeka na ocenę'));
}

// Konto z jedną kampanią nie potrzebuje listy zbiorczej — byłaby kopią tej z sekcji.
{
    const yearMap = new Map();
    const kampanie = [{
        camp: 'Jedyna', typ: 'Search', minKlikniec: 0, totals: { terms: 20, cost: 500 },
        pewne: [{ term: 'x', row: term({ term: 'x' }), reasons: [{ kind: 'ai', pewnosc: 90, text: 'nie pasuje' }] }],
        doSprawdzenia: [], bronione: []
    }];
    const html = buildReport({
        accountName: 'Jedno konto', isEcom: true, industry: 'sklep', dates: getDates(),
        benchOpis: 'cel ROAS 3,50', kampanie, yearMap,
        hasel: 20, kosztCalosc: 500, ocenionychAI: 3, niepewnychDoOceny: 0
    });
    ok('przy jednej kampanii nie ma zbiorczej listy', !html.includes('Wszystkie pewne razem'));
    ok('tryb ecom zmienia zestaw kolumn', html.includes('>ROAS<') && !html.includes('Koszt konw.'));
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} przeszło, ${failed} nie przeszło\n`);
process.exit(failed === 0 ? 0 : 1);
