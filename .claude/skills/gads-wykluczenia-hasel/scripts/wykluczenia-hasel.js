#!/usr/bin/env node

/**
 * wykluczenia-hasel.js — kandydaci do wykluczenia z wyszukiwanych haseł Google Ads.
 *
 * Raport HTML z dokładnie dwiema listami: „Pewne — do wykluczenia" i „Do sprawdzenia".
 * Bez przeglądu haseł, bez TOP-ów, bez miejsc docelowych — jedno zadanie: powiedzieć,
 * na czym konto przepala budżet i co da się z tym zrobić.
 *
 * Przepływ jest DWUPRZEBIEGOWY (ocena AI, warstwa 3b):
 *   1. przebieg → raport z sygnałów liczbowych + plik `{data}-wykluczenia-uncertain.json`
 *                 z hasłami, o których liczby nic nie mówią
 *   2. agent (Claude Code) ocenia je znając ofertę klienta i zapisuje
 *      `{data}-wykluczenia-negatives.json`
 *   3. przebieg → raport wzbogacony o ocenę AI
 *
 * Skrypt niczego nie zmienia na koncie — tylko czyta.
 *
 * Użycie:
 *   node wykluczenia-hasel.js --account={alias|ID} [--out=<folder>] [--kontekst=<plik>] [--open]
 *
 * Opcje:
 *   --account       alias z `.claude/accounts.json` albo 10-cyfrowy customer ID (wymagane)
 *   --accounts-dir  katalog, od którego szukamy `.claude/accounts.json` (domyślnie: bieżący)
 *   --out           folder raportu (domyślnie: Klienci/{alias}/Optymalizacja)
 *   --kontekst      ścieżka do kontekst.md (domyślnie: Klienci/{alias}/Kontekst/kontekst.md)
 *   --typ           ecom | leadgen — nadpisuje config.json i wykrywanie automatyczne
 *   --cel-roas      docelowy ROAS (ecom) — nadpisuje targetRoas z config.json
 *   --open          otwórz raport po wygenerowaniu (macOS)
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { execSync } from 'child_process';

import { runRawQuery, getSearchTerms, resolveAccount } from './connector.js';
import { fmt, fmtMoney, setCurrency, getDates, formatDate } from './format.js';
import {
    collectUncertainTerms, buildCampExclusionCandidates, withYearSignal, splitCandidatesByYear,
    keywordsByCampaign,
    buildYearBenchmarks, campStatsFromRows, averagesFromCampStats,
    knownTopicsFromStatus, isKnownTopic, progKlikniec, yearKey, AI_PEWNOSC_PROG,
} from './analiza.js';
import { buildReport } from './raport-html.js';

// ============================================================
// ARGUMENTY
// ============================================================

const args = process.argv.slice(2).reduce((acc, arg) => {
    if (arg.startsWith('--')) {
        const [key, ...val] = arg.slice(2).split('=');
        acc[key] = val.length ? val.join('=') : true;
    }
    return acc;
}, {});

if (!args.account) {
    console.error('Użycie: node wykluczenia-hasel.js --account={alias|ID} [--out=<folder>] [--kontekst=<plik>] [--open]');
    process.exit(1);
}

// Numeryczne enumy advertising_channel_type → czytelny typ kampanii.
// UWAGA: 10 to PMax, a NIE DemGen (14) — częsty błąd.
const CHANNEL_MAP = {
    2: 'Search', 3: 'Display', 4: 'Shopping', 5: 'Hotel', 6: 'Video',
    7: 'Multi-channel', 8: 'Local', 9: 'Smart', 10: 'PMax',
    11: 'Local Services', 13: 'Travel', 14: 'DemGen'
};

// ============================================================
// KONTO
// ============================================================

// Alias z `.claude/accounts.json` albo surowy customer ID. Nazwę i walutę dociągamy
// z API, gdy rejestr ich nie zna — nagłówek raportu i formatowanie kwot mają być
// poprawne także dla konta podanego samym numerem.
async function ustalKonto(selector, accountsDir) {
    const cyfry = String(selector).replace(/\D/g, '');
    const czyId = /^\d{10}$/.test(cyfry);
    const zRejestru = czyId ? null : resolveAccount(selector, accountsDir);

    if (!zRejestru && !czyId) {
        console.error(`Konto „${selector}" nie znalezione w .claude/accounts.json (szukano od: ${accountsDir}).`);
        console.error('Podaj alias z rejestru albo 10-cyfrowy customer ID.');
        process.exit(1);
    }

    const konto = {
        id: zRejestru ? zRejestru.id : cyfry,
        login_customer_id: zRejestru ? zRejestru.login_customer_id : undefined,
        name: zRejestru?.name,
        currency: zRejestru?.currency,
        key: zRejestru?.key || cyfry
    };

    if (!konto.name || !konto.currency) {
        try {
            const [r] = await query(konto, 'SELECT customer.descriptive_name, customer.currency_code FROM customer');
            konto.name ||= r?.['customer.descriptive_name'];
            konto.currency ||= r?.['customer.currency_code'];
        } catch (e) {
            console.log(`   ⚠ Nie udało się pobrać danych konta z API (${e.message}).`);
        }
    }
    konto.name ||= konto.id;
    return konto;
}

const query = (account, gaql) =>
    runRawQuery(account.id, gaql, { loginCustomerId: account.login_customer_id });

// ============================================================
// POBIERANIE DANYCH
// ============================================================

// Hasła składamy z TRZECH źródeł, bo żadne nie pokrywa wszystkich typów kampanii:
//  1. `search_term_view` Z segmentem słowa kluczowego — Search oparty o słowa kluczowe.
//     UWAGA: ten segment WYCINA kampanie, których hasła nie mają słowa wyzwalającego
//     (DSA, AI Max, Shopping) — zwracają wtedy zero wierszy.
//  2. `search_term_view` BEZ segmentu — właśnie te kampanie. Dokładamy z niego tylko
//     kampanie nieobecne w (1), żeby nie liczyć metryk podwójnie.
//  3. `campaign_search_term_view` — Performance Max, którego w `search_term_view` nie ma
//     w ogóle. Filtr `clicks > 0` ucina ogon wyświetleń bez kliknięć (na dużym koncie
//     605 tys. → 70 tys. wierszy przy IDENTYCZNYM koszcie całkowitym).
function mapStandardRow(r) {
    return {
        term: r['search_term_view.search_term'] || '',
        campaign: r['campaign.name'] || '',
        adGroup: r['ad_group.name'] || '',
        impressions: r['metrics.impressions'] || 0,
        clicks: r['metrics.clicks'] || 0,
        cost: r['metrics.cost'] || 0,
        conversions: r['metrics.conversions'] || 0,
        value: r['metrics.conversions_value'] || 0
    };
}

async function fetchStandardTerms(account, range, includeKeyword) {
    const rows = await getSearchTerms(account.id, 0, 0, {
        loginCustomerId: account.login_customer_id,
        range, includeKeyword
    });
    return rows.map(mapStandardRow).filter(r => r.term);
}

async function fetchPmaxTerms(account, range) {
    try {
        const rows = await query(account, `
            SELECT
                campaign.name,
                campaign_search_term_view.search_term,
                metrics.impressions,
                metrics.clicks,
                metrics.cost_micros,
                metrics.conversions,
                metrics.conversions_value
            FROM campaign_search_term_view
            WHERE segments.date BETWEEN '${range.start}' AND '${range.end}'
              AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
              AND metrics.clicks > 0
        `);
        return rows.map(r => ({
            term: r['campaign_search_term_view.search_term'] || '',
            campaign: r['campaign.name'] || '',
            adGroup: '–',            // PMax nie ma grup reklam ani słów kluczowych
            impressions: r['metrics.impressions'] || 0,
            clicks: r['metrics.clicks'] || 0,
            cost: r['metrics.cost'] || 0,
            conversions: r['metrics.conversions'] || 0,
            value: r['metrics.conversions_value'] || 0
        })).filter(r => r.term);
    } catch (e) {
        console.log(`   ⚠ Brak haseł PMax: ${e.message}`);
        return [];
    }
}

async function fetchSearchTerms(account, range) {
    const [zeSlowem, bezSlowa, pmax] = await Promise.all([
        fetchStandardTerms(account, range, true),
        fetchStandardTerms(account, range, false),
        fetchPmaxTerms(account, range)
    ]);
    const zKampanii = new Set(zeSlowem.map(r => r.campaign));
    return [...zeSlowem, ...bezSlowa.filter(r => !zKampanii.has(r.campaign)), ...pmax];
}

async function fetchAdGroupKeywords(account) {
    try {
        const rows = await query(account, `
            SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text
            FROM ad_group_criterion
            WHERE ad_group_criterion.type = 'KEYWORD'
              AND ad_group_criterion.status != 'REMOVED'
              AND ad_group_criterion.negative = FALSE
        `);
        const byAdGroup = {};
        rows.forEach(r => {
            const text = r['ad_group_criterion.keyword.text'];
            if (!text) return;
            const key = `${r['campaign.name'] || ''}|||${r['ad_group.name'] || ''}`;
            (byAdGroup[key] ||= []).push(text);
        });
        return byAdGroup;
    } catch (e) {
        console.log(`   ⚠ Brak słów kluczowych (sygnał semantyczny wyłączony): ${e.message}`);
        return {};
    }
}

async function fetchCampaignTypes(account) {
    const map = {};
    try {
        const rows = await query(account, `
            SELECT campaign.name, campaign.advertising_channel_type
            FROM campaign
            WHERE campaign.status != 'REMOVED'
        `);
        rows.forEach(r => {
            const n = r['campaign.name'];
            if (n) map[n] = CHANNEL_MAP[r['campaign.advertising_channel_type']] || '';
        });
    } catch { /* typ kampanii steruje tylko progiem kliknięć — brak nie blokuje raportu */ }
    return map;
}

// Roczne statystyki kampanii — benchmark sygnału rocznego i obrony rokiem.
// Jedno zapytanie agregujące (bez segmentu daty), więc kosztuje ułamek sekundy.
async function fetchCampaignYearStats(account, range) {
    const stats = {};
    try {
        const rows = await query(account, `
            SELECT campaign.name, metrics.cost_micros, metrics.conversions, metrics.conversions_value
            FROM campaign
            WHERE segments.date BETWEEN '${range.start}' AND '${range.end}'
        `);
        rows.forEach(r => {
            const n = r['campaign.name'];
            if (!n) return;
            stats[n] ||= { cost: 0, conversions: 0, value: 0 };
            stats[n].cost += r['metrics.cost'] || 0;
            stats[n].conversions += r['metrics.conversions'] || 0;
            stats[n].value += r['metrics.conversions_value'] || 0;
        });
    } catch (e) {
        console.log(`   ⚠ Brak rocznych statystyk kampanii (benchmark cofnie się do 30 dni): ${e.message}`);
    }
    return stats;
}

// Dane roczne pobieramy WYŁĄCZNIE dla haseł, które faktycznie trafiają do analizy —
// duże konto ma kilkadziesiąt tysięcy haseł w 30 dniach, a ocenianych jest ~1000.
// Filtr `IN` po stronie GAQL, w paczkach.
const YEAR_CHUNK = 1000;
const escGaql = (t) => `'${String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function fetchYearStats(account, range, terms) {
    const yearMap = new Map();
    if (!terms.length) return yearMap;

    const dodaj = (camp, term, r) => {
        const key = yearKey(camp, term);
        const cur = yearMap.get(key) || { clicks: 0, cost: 0, conversions: 0, value: 0 };
        cur.clicks += r['metrics.clicks'] || 0;
        cur.cost += r['metrics.cost'] || 0;
        cur.conversions += r['metrics.conversions'] || 0;
        cur.value += r['metrics.conversions_value'] || 0;
        yearMap.set(key, cur);
    };

    const METRYKI = 'metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';

    for (let i = 0; i < terms.length; i += YEAR_CHUNK) {
        const lista = terms.slice(i, i + YEAR_CHUNK).map(escGaql).join(',');
        const paczka = Math.floor(i / YEAR_CHUNK) + 1;

        try {
            const rows = await query(account, `
                SELECT campaign.name, search_term_view.search_term, ${METRYKI}
                FROM search_term_view
                WHERE segments.date BETWEEN '${range.start}' AND '${range.end}'
                  AND search_term_view.search_term IN (${lista})
            `);
            rows.forEach(r => dodaj(r['campaign.name'] || '', r['search_term_view.search_term'], r));
        } catch (e) {
            console.log(`   ⚠ Dane roczne (search_term_view) — paczka ${paczka}: ${e.message}`);
        }

        // Tylko PMax — w `search_term_view` go nie ma, a bez tego ograniczenia
        // policzylibyśmy kampanie Search dwa razy.
        try {
            const rows = await query(account, `
                SELECT campaign.name, campaign_search_term_view.search_term, ${METRYKI}
                FROM campaign_search_term_view
                WHERE segments.date BETWEEN '${range.start}' AND '${range.end}'
                  AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
                  AND campaign_search_term_view.search_term IN (${lista})
            `);
            rows.forEach(r => dodaj(r['campaign.name'] || '', r['campaign_search_term_view.search_term'], r));
        } catch (e) {
            console.log(`   ⚠ Dane roczne (PMax) — paczka ${paczka}: ${e.message}`);
        }
    }
    return yearMap;
}

// ============================================================
// KONTEKST KLIENTA — czym jest oferta (plik kontekst.md)
// ============================================================
// Bez opisu oferty ocena AI (warstwa 3b) jest zgadywaniem z nazwy konta. Plik żyje
// w folderze raportu, więc jest jeden na konto i przechodzi między rundami.

const KONTEKST_FILE = 'kontekst.md';

function kontekstTemplate(accountName) {
    return `---
typ:                # ecom | leadgen — puste = wykryj automatycznie (po wartości konwersji)
celRoas:            # tylko ecom, np. 3.5 — punkt odniesienia zamiast średniej kampanii
branza:             # np. sklep ogrodniczy, kancelaria prawna, serwis rowerowy
---

# Kontekst — ${accountName}

Opis oferty, na podstawie którego oceniane są hasła wyszukiwania. Im konkretniej,
tym mniej dobrych haseł wyleci i tym więcej złych zostanie złapanych.

## Co klient sprzedaje / oferuje

_Konkretne kategorie, marki, usługi. Wypisz też to, czego łatwo się domyślić błędnie._

## Czego NIE robi

_Czego nie ma w ofercie, choć branża sugeruje, że mogłoby być (np. „nie montujemy",
„nie wysyłamy za granicę", „nie obsługujemy klientów indywidualnych")._

## Zasięg i grupa docelowa

_Geografia, B2B/B2C, przedział cenowy._

## Uwagi do kierowania

_Rzeczy zmieniające ocenę: „celowo licytujemy marki konkurencji", „wchodzimy w nową
kategorię, nie wycinaj jej", „mamy raty 0%"._
`;
}

// Frontmatter: proste `klucz: wartość` między liniami `---`. Świadomie bez YAML-a —
// nie chcemy zależności npm dla trzech pól, a błąd składni ma być nieszkodliwy.
function parseFrontmatter(md) {
    const m = String(md || '').match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split('\n')) {
        const mm = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
        if (mm && mm[2] !== '') out[mm[1]] = mm[2];
    }
    return out;
}

// Cele i typ konta z `Klienci/<alias>/config.json`. Brak pliku albo błąd składni daje
// pusty obiekt — config jest wygodą, nie warunkiem uruchomienia.
function loadClientConfig(clientDir) {
    const p = join(clientDir, 'config.json');
    if (!existsSync(p)) return {};
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
        console.log(`   ⚠ ${p} nie jest poprawnym JSON-em — pomijam.`);
        return {};
    }
}

function ensureKontekst(kontekstDir, accountName, sciezkaZFlagi) {
    if (sciezkaZFlagi) {
        const p = isAbsolute(sciezkaZFlagi) ? sciezkaZFlagi : resolve(process.cwd(), sciezkaZFlagi);
        if (!existsSync(p)) {
            console.log(`   ⚠ Nie ma pliku ${p} — hasła będą oceniane bez opisu oferty.`);
            return { text: '', path: p, created: false };
        }
        return { text: readFileSync(p, 'utf8'), path: p, created: false };
    }
    const p = join(kontekstDir, KONTEKST_FILE);
    if (!existsSync(p)) {
        writeFileSync(p, kontekstTemplate(accountName), 'utf8');
        return { text: '', path: p, created: true };   // szablon = brak realnego kontekstu
    }
    const text = readFileSync(p, 'utf8');
    // Nietknięty szablon traktujemy jak brak kontekstu — inaczej ocena dostawałaby
    // instrukcję „opis oferty jest" i nie zapaliłaby ostrzeżenia. Porównujemy z całym
    // szablonem, a nie zgadujemy po treści: szablon ma własną prozę (nagłówki, podpowiedzi
    // w kursywie), więc każda heurystyka „czy są linie treści" uznawała go za wypełniony.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const wypelniony = norm(text) !== norm(kontekstTemplate(accountName));
    return { text: wypelniony ? text : '', path: p, created: false };
}

// ============================================================
// PAMIĘĆ MIĘDZY RUNDAMI — status-kierowanie.md
// ============================================================

const STATUS_FILE = 'status-kierowanie.md';

function statusTemplate(accountName) {
    return `# Status kierowania — ${accountName}

Pamięć MIĘDZY rundami przeglądu wykluczeń. Agent czyta ten plik przed oceną haseł
i aktualizuje go po rundzie. Hasła zapisuj w \`grawisach\`, jako wpisy listy (linia
zaczynająca się od \`-\`) — skrypt po nich rozpoznaje, że temat jest już zbadany,
i nie marnuje na niego sprawdzenia SERP w kolejnych rundach.

Rozpoznawanie działa na słowach, nie na całym napisie: wpis \`fotel biurowy\` pokrywa
też „fotele biurowe opinie". Cały klaster zapisuj jednym wpisem z wieloznacznikiem
w klamrach — \`serwis {miejscowość}\` pokrywa „serwis kraków" i „serwis laptopów
gdańsk", ale nie samo „serwis". Wpis jednowyrazowy (\`nazwa-marki\`) musi trafić
w całe hasło.

## Ustalenia o ofercie i kierowaniu

_Trwałe fakty zmieniające ocenę haseł. Jedna linia na ustalenie._

## Hasła sprawdzone — zostawiamy

_Fałszywe alarmy: wyglądało na do wykluczenia, ale weryfikacja mówi „zostaw".
Format: \`hasło\` — dlaczego zostaje (źródło, data)._

## Zarekomendowane do wykluczenia

_Co poszło do operatora. Format: \`hasło\` — powód (data)._

## Wdrożone wykluczenia

## Historia rund

_Format: RRRR-MM-DD — ile haseł ocenionych, ile wykluczonych, ile po SERP._
`;
}

function ensureStatusFile(outputDir, accountName) {
    const p = join(outputDir, STATUS_FILE);
    if (!existsSync(p)) {
        const tpl = statusTemplate(accountName);
        writeFileSync(p, tpl, 'utf8');
        return { text: tpl, path: p, created: true };
    }
    return { text: readFileSync(p, 'utf8'), path: p, created: false };
}

// ============================================================
// WARSTWA 3b — pliki wymiany z agentem
// ============================================================
// Skrypt nie woła żadnego płatnego API. Zapisuje hasła niepewne do
// `-uncertain.json`, ocenia je agent prowadzący przegląd (Claude Code), a drugi
// przebieg wczytuje `-negatives.json`.

// Ile najdroższych haseł dostaje flagę „sprawdź SERP". 50, nie 10: WebSearch nie ma
// limitu zapytań, więc budżet ograniczał tylko czas — a ten rozwiązuje równoległość
// (5 subagentów × 10 haseł). Przy 10 pokrycie było iluzoryczne: na dużym koncie top 10
// to kilkanaście procent kosztu haseł niepewnych.
const SERP_CHECK_COUNT = 50;
const MAX_TERMS_DO_OCENY = 150;

function writeUncertainTerms(outputDir, dateStr, uncertainTerms, meta) {
    const known = knownTopicsFromStatus(meta.statusMd);
    const sorted = [...uncertainTerms].sort((a, b) => b.cost - a.cost).slice(0, MAX_TERMS_DO_OCENY);

    // Budżet SERP idzie najpierw na najdroższe hasła SPOZA zbadanych tematów. Gdy po
    // tym zostaje (status opisuje już prawie wszystko), dobijamy go najdroższymi
    // znanymi — odświeżenie najkosztowniejszego założenia jest warte więcej niż
    // niewykorzystane sprawdzenia.
    const znane = sorted.map(t => isKnownTopic(t.term, known));
    const serp = new Array(sorted.length).fill(false);
    let left = SERP_CHECK_COUNT;
    for (let i = 0; i < sorted.length && left > 0; i++) if (!znane[i]) { serp[i] = true; left--; }
    for (let i = 0; i < sorted.length && left > 0; i++) if (!serp[i]) { serp[i] = true; left--; }

    const brakKontekstu = !meta.kontekstMd;
    const payload = {
        generatedAt: dateStr,
        konto: meta.accountName,
        typ: meta.isEcom ? 'ecom' : 'leadgen',
        branza: meta.branza || '',
        celRoas: meta.celRoas ?? null,
        kontekst: meta.kontekstMd || '',
        kontekstPlik: meta.kontekstPath,
        statusKierowania: meta.statusMd || '',
        statusPlik: meta.statusPath,
        brakKontekstu,
        serpCheckCount: SERP_CHECK_COUNT,
        instrukcja: [
            'Oceń, które z poniższych haseł NIE PASUJĄ do oferty klienta (inna intencja niż zakup/kontakt,',
            'inna branża, coś czego klient nie oferuje). Przy wątpliwościach ZOSTAW — wykluczenie dobrego',
            'hasła kosztuje po cichu więcej niż zostawienie słabego.',
            'Pole "kampanie" mówi, w których kampaniach hasło się pokazało (metryki są zsumowane po nich).',
            'Jeśli "kontekst" albo "statusKierowania" opisuje cel danej kampanii, uwzględnij go: hasło trafione',
            'dla całej oferty potrafi być nietrafione dla kampanii o wąskim celu i odwrotnie.',
            'Hasła z "serpCheck": true wymagają sprawdzenia wyników wyszukiwania PRZED decyzją. Tego sprawdzenia',
            'nie rób sam — zleć je subagentom (wyniki WebSearch to kilkadziesiąt tysięcy tokenów jednorazowego',
            'materiału). Podziel je na paczki po 10 haseł i uruchom subagentów RÓWNOLEGLE, w jednej wiadomości.',
            'Każdy ma zwrócić dla swoich haseł: dominującą intencję wyników, jakie oferty się wyświetlają i czy',
            'pasują do oferty klienta — a NIE werdykt o wykluczeniu. Decyzję podejmujesz Ty, łącząc ich',
            'streszczenia z kontekstem. To wyniki organiczne, nie reklamy — sygnał pomocniczy, nie dowód.',
            'Resztę haseł oceń z samego kontekstu.',
            brakKontekstu
                ? 'UWAGA: nie ma opisu oferty (kontekst.md pusty lub niewypełniony) — wykluczaj tylko przy oczywistym nietrafieniu, albo najpierw uzupełnij ten plik.'
                : '',
            'Pole "statusKierowania" to pamięć z poprzednich rund (plik pod "statusPlik"). Przeczytaj ją przed oceną,',
            'a po ocenie dopisz do pliku: nowe ustalenia o ofercie, sprawdzone hasła które zostawiasz (z powodem',
            'i datą), rekomendowane wykluczenia i linię w „Historia rund". Hasła zapisuj w grawisach, jako wpisy listy.',
            `Wynik zapisz do pliku ${dateStr}-wykluczenia-negatives.json w formacie:`,
            '{"negative": [{"term": "…", "powod": "krótko dlaczego", "serp": true|false, "pewnosc": 0-100}]}.',
            '"serp" ustawiaj na true WYŁĄCZNIE dla haseł, dla których masz wynik sprawdzenia SERP od subagenta.',
            `"pewnosc" to Twoja pewność, że hasło nie pasuje do oferty: ${AI_PEWNOSC_PROG} i więcej oznacza, że hasło trafi na`,
            'listę „pewne" bez weryfikacji człowieka, poniżej — do ręcznego sprawdzenia. Nie zawyżaj.',
            'Oceniaj tylko hasła z tej listy.'
        ].filter(Boolean).join(' '),
        terms: sorted.map((t, i) => ({
            term: t.term,
            kampanie: t.kampanie || [],
            impressions: t.impressions,
            clicks: t.clicks,
            cost: Math.round(t.cost * 100) / 100,
            serpCheck: serp[i],
            ...(znane[i] ? { znaneZeStatusu: true } : {})
        }))
    };

    const p = join(outputDir, `${dateStr}-wykluczenia-uncertain.json`);
    writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
    return { path: p, count: payload.terms.length, serp: Math.min(payload.terms.length, SERP_CHECK_COUNT) };
}

// Akceptuje oba formaty: ["hasło"] oraz [{term, powod, serp, pewnosc}].
function loadAgentNegatives(outputDir, dateStr) {
    const p = join(outputDir, `${dateStr}-wykluczenia-negatives.json`);
    if (!existsSync(p)) return new Map();
    try {
        const json = JSON.parse(readFileSync(p, 'utf8'));
        const map = new Map();
        (json.negative || []).forEach(entry => {
            if (typeof entry === 'string') {
                map.set(entry.toLowerCase().trim(), { powod: '', serp: false, pewnosc: null });
            } else if (entry && entry.term) {
                map.set(String(entry.term).toLowerCase().trim(), {
                    powod: String(entry.powod || '').trim(),
                    serp: !!entry.serp,
                    pewnosc: Number.isFinite(Number(entry.pewnosc)) ? Number(entry.pewnosc) : null
                });
            }
        });
        const serpCount = [...map.values()].filter(v => v.serp).length;
        console.log(`   ✓ Ocena AI: wczytano ${map.size} haseł (${serpCount} po sprawdzeniu SERP)`);
        return map;
    } catch (e) {
        console.warn(`   ⚠ Nie udało się wczytać ${dateStr}-wykluczenia-negatives.json: ${e.message}`);
        return new Map();
    }
}

// ============================================================
// ANALIZA — per kampania, prezentacja zmergowana
// ============================================================

// Ilu kandydatów per kampania obejmujemy analizą roczną (są posortowani wg kosztu).
const YEAR_KANDYDATOW_NA_KAMPANIE = 150;

function przygotujKampanie(st30, adGroupKeywords, aiNegatives, isEcom, campTypes, celRoas) {
    const campStats = campStatsFromRows(st30);
    const { cpa: campAvgCPA, roas: campAvgROAS } = averagesFromCampStats(campStats);

    const maCel = isEcom && Number.isFinite(Number(celRoas)) && Number(celRoas) > 0;
    const cel = maCel ? Number(celRoas) : null;
    // Cel z kontekstu wygrywa ze średnią WŁASNEJ kampanii: przy porównaniu do własnej
    // średniej połowa haseł jest poniżej niej z definicji, więc w kampanii brandowej
    // sygnał nic nie znaczy — hasło z ROAS 6,3 przy celu 3,5 lądowało wśród kandydatów
    // tylko dlatego, że kampania ma średnią 9.
    const benchROAS = (srednia) => maCel ? cel : srednia;
    const benchLabel = maCel ? `celu ROAS z kontekstu (${fmt(cel, 2)})` : '';

    const byCamp = {};
    st30.forEach(t => { (byCamp[t.campaign] ||= []).push(t); });

    const camps = Object.entries(byCamp).map(([camp, terms]) => {
        const avgCPA = campAvgCPA[camp] ?? null;
        const avgROAS = campAvgROAS[camp] ?? null;
        const avgMetric = isEcom ? benchROAS(avgROAS) : avgCPA;
        const minKlikniec = progKlikniec(campTypes[camp]);

        const kandydaci = buildCampExclusionCandidates(
            terms, adGroupKeywords, avgMetric, aiNegatives, isEcom, minKlikniec, avgCPA, benchLabel
        );

        // Skan roczny — źródło sygnału rocznego. Poza topem wg wyświetleń bierze też
        // top wg KOSZTU: hasło z drogim CPC i małym wolumenem to profil cichego
        // przepalacza, a właśnie jego top wg wyświetleń potrafi nie pokazać.
        const zRuchem = terms.filter(t => t.impressions >= 2);
        const topWysw = [...zRuchem].sort((a, b) => b.impressions - a.impressions).slice(0, 30);
        const topKoszt = [...zRuchem].sort((a, b) => b.cost - a.cost).slice(0, 30);
        const rocznySkan = [...new Map([...topWysw, ...topKoszt].map(t => [t.term, t])).values()];

        return {
            camp, typ: campTypes[camp] || '', avgCPA, avgROAS, avgMetric, minKlikniec,
            kandydaci, rocznySkan,
            totals: {
                terms: new Set(terms.map(t => t.term)).size,
                cost: terms.reduce((s, t) => s + t.cost, 0)
            }
        };
    });

    return { camps, maCel, cel, benchROAS, benchLabel };
}

// Hasła, dla których dociągamy rok: kandydaci + skan roczny. Nic więcej nie trafia
// do raportu, więc nic więcej nie potrzebuje danych rocznych.
function terminyDoRoku(camps) {
    const set = new Set();
    camps.forEach(c => {
        c.kandydaci.slice(0, YEAR_KANDYDATOW_NA_KAMPANIE).forEach(k => set.add(k.term));
        c.rocznySkan.forEach(t => set.add(t.term));
    });
    return [...set].filter(Boolean);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    const dates = getDates();
    const accountsDir = args['accounts-dir'] || process.cwd();
    const account = await ustalKonto(args.account, accountsDir);
    setCurrency(account.currency);

    console.log(`\n🚫 Wykluczenia haseł — ${account.name}`);
    console.log(`   Okres oceny: ${dates.days30.start} → ${dates.days30.end} (kontekst roczny od ${dates.days365.start})\n`);

    console.log('   Pobieram wyszukiwane hasła (30 dni)...');
    const st30 = await fetchSearchTerms(account, dates.days30);

    console.log('   Pobieram słowa kluczowe, typy kampanii i roczne średnie...');
    const [adGroupKeywords, campTypes, campYearStats] = await Promise.all([
        fetchAdGroupKeywords(account),
        fetchCampaignTypes(account),
        fetchCampaignYearStats(account, dates.days365)
    ]);
    const rok = buildYearBenchmarks(campYearStats);

    const unikalnych = new Set(st30.map(t => t.term)).size;
    const kosztCalosc = st30.reduce((s, t) => s + t.cost, 0);
    console.log(`\n   ✓ Haseł: ${st30.length} wierszy / ${unikalnych} unikalnych · koszt ${fmtMoney(kosztCalosc)}`);
    console.log(`   ✓ Grup reklam ze słowami kluczowymi: ${Object.keys(adGroupKeywords).length}`);
    console.log(`   ✓ Roczne średnie: ${Object.keys(campYearStats).length} kampanii`);

    if (!st30.length) {
        console.log('\n⚠ Konto nie ma wyszukiwanych haseł w ostatnich 30 dniach — nie ma czego analizować.');
        return;
    }

    // Folder klienta: raporty w `Optymalizacja/`, opis oferty w `Kontekst/`. Obie flagi
    // działają niezależnie — `--out` gdzie indziej nie przenosi kontekstu i odwrotnie.
    const clientDir = resolve(process.cwd(), 'Klienci', String(account.key).toLowerCase());
    const outputDir = args.out
        ? (isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out))
        : join(clientDir, 'Optymalizacja');
    mkdirSync(outputDir, { recursive: true });
    const kontekstDir = join(clientDir, 'Kontekst');
    if (!args.kontekst) mkdirSync(kontekstDir, { recursive: true });
    const dateStr = formatDate(new Date());

    const kontekst = ensureKontekst(kontekstDir, account.name, args.kontekst);
    if (kontekst.created) console.log(`\n   ✓ Utworzono ${KONTEKST_FILE} — uzupełnij opis oferty, to najmocniej poprawia jakość oceny`);
    else if (!kontekst.text) console.log(`\n   ⚠ ${KONTEKST_FILE} jest pusty — ocena AI będzie zgadywaniem z nazwy konta`);
    const status = ensureStatusFile(outputDir, account.name);
    if (status.created) console.log(`   ✓ Utworzono ${STATUS_FILE} (pamięć między rundami)`);

    // Typ konta i cel: flaga CLI > config.json > frontmatter kontekstu > wykrycie automatyczne.
    // Automat: konto raportujące wartość konwersji traktujemy jak ecommerce, bo tylko
    // tam ROAS jest sensowną miarą.
    const cfg = loadClientConfig(clientDir);
    const fm = parseFrontmatter(kontekst.text || (existsSync(kontekst.path) ? readFileSync(kontekst.path, 'utf8') : ''));
    const wartoscKonwersji = st30.reduce((s, t) => s + (t.value || 0), 0);
    const typ = String(args.typ || cfg.businessType || fm.typ || '').toLowerCase();
    const isEcom = typ ? ['ecom', 'ecommerce'].includes(typ) : wartoscKonwersji > 0;
    const celRoas = args['cel-roas'] ?? cfg.targetRoas ?? fm.celRoas ?? null;
    const branza = cfg.industry || fm.branza || '';
    console.log(`   Tryb oceny: ${isEcom ? 'ecommerce (ROAS)' : 'leadgen (koszt konwersji)'}${typ ? '' : ' — wykryty automatycznie'}`);

    // Warstwa 3b: hasła niepewne → plik do oceny; negatywy z poprzedniego przebiegu → analiza
    const uncertainTerms = collectUncertainTerms(st30, adGroupKeywords);
    const aiNegatives = loadAgentNegatives(outputDir, dateStr);
    const uncertain = writeUncertainTerms(outputDir, dateStr, uncertainTerms, {
        accountName: account.name, isEcom, celRoas, branza,
        kontekstMd: kontekst.text, kontekstPath: kontekst.path,
        statusMd: status.text, statusPath: status.path
    });
    console.log(`   Warstwa 3b: ${uncertainTerms.length} haseł niepewnych (${uncertain.count} zapisanych do oceny, ${uncertain.serp} z flagą SERP)`);

    // Analiza per kampania → rok tylko dla tego, co trafia do raportu → podział na kubełki
    const { camps, maCel, cel, benchROAS, benchLabel } =
        przygotujKampanie(st30, adGroupKeywords, aiNegatives, isEcom, campTypes, celRoas);

    const doRoku = terminyDoRoku(camps);
    console.log(`   Pobieram dane roczne dla ${doRoku.length} haseł...`);
    const yearMap = await fetchYearStats(account, dates.days365, doRoku);
    console.log(`   ✓ Historia roczna: ${yearMap.size} par (kampania + hasło)`);

    // Podział na kubełki zostaje PER KAMPANIA — tak jak liczone są benchmarki, i tak
    // samo dodaje się wykluczające w koncie (kampania po kampanii, nie hurtem).
    const campKeywords = keywordsByCampaign(adGroupKeywords);
    const wgKosztu = (a, b) => b.row.cost - a.row.cost;
    const kampanie = camps.map(c => {
        // Miernik sygnału rocznego to średnia kampanii z TEGO SAMEGO ROKU (fallback do
        // 30 dni, gdy roku nie udało się pobrać) — inaczej po dobrym miesiącu poprzeczka
        // rośnie i produkuje fałszywe „pewne", a po słabym wszystko ląduje w „bronione".
        const rokCPA = rok.cpa[c.camp] ?? c.avgCPA;
        const rokROAS = benchROAS(rok.roas[c.camp] ?? c.avgROAS);
        const rokMetric = isEcom ? rokROAS : rokCPA;

        const zRokiem = withYearSignal(c.kandydaci, c.rocznySkan, rokCPA, rokROAS, isEcom, yearMap, c.minKlikniec, benchLabel);
        const split = splitCandidatesByYear(zRokiem, rokMetric, isEcom, yearMap, campKeywords[c.camp] || []);
        return {
            camp: c.camp, typ: c.typ, minKlikniec: c.minKlikniec, totals: c.totals,
            pewne: [...split.pewne].sort(wgKosztu),
            doSprawdzenia: [...split.doSprawdzenia].sort(wgKosztu),
            bronione: split.bronione
        };
    // Kampanie z największym kosztem kandydatów na górze — tam jest najwięcej do odzyskania.
    }).sort((a, b) =>
        b.pewne.concat(b.doSprawdzenia).reduce((s, c) => s + c.row.cost, 0)
        - a.pewne.concat(a.doSprawdzenia).reduce((s, c) => s + c.row.cost, 0)
    );

    const suma = (pole) => kampanie.reduce((s, k) => s + k[pole].length, 0);
    console.log(`\n   ✓ Pewne: ${suma('pewne')} · Do sprawdzenia: ${suma('doSprawdzenia')} · Obronione rokiem: ${suma('bronione')} · Kampanii z kandydatami: ${kampanie.filter(k => k.pewne.length || k.doSprawdzenia.length).length}`);

    const html = buildReport({
        accountName: account.name,
        isEcom,
        industry: branza,
        dates,
        benchOpis: maCel
            ? `cel ROAS ${fmt(cel, 2)} (z kontekstu)`
            : (isEcom ? 'średni ROAS każdej kampanii' : 'średni koszt konwersji każdej kampanii'),
        kampanie, yearMap,
        hasel: unikalnych,
        kosztCalosc,
        ocenionychAI: aiNegatives.size,
        niepewnychDoOceny: uncertain.count
    });

    const outputPath = join(outputDir, `${dateStr}-wykluczenia.html`);
    writeFileSync(outputPath, html, 'utf8');
    console.log(`\n✅ Raport zapisany: ${outputPath}`);

    if (uncertain.count > 0 && aiNegatives.size === 0) {
        console.log(`\n   ℹ Ocena AI jeszcze nie doszła. Przeczytaj ${uncertain.path},`);
        console.log(`     oceń hasła (SERP-check najdroższych zleć subagentom), zapisz`);
        console.log(`     ${dateStr}-wykluczenia-negatives.json i uruchom skrypt ponownie.`);
    }

    if (args.open) {
        try { execSync(`open "${outputPath}"`); } catch { /* nie-macOS albo brak GUI */ }
    }
}

main().catch(err => {
    console.error('Błąd:', err.message);
    process.exit(1);
});
