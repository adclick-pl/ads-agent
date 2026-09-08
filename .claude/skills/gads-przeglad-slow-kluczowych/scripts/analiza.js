/**
 * analiza.js — warstwa DANYCH i LOGIKI raportu słów kluczowych.
 *
 * Pobrania z API, benchmarki (średnie kampanii, cele tROAS/tCPA), sygnały kandydatów
 * do wstrzymania, ochrona przez wynik i model do wyrenderowania. Bez HTML — to siedzi
 * w `raport-html.js`.
 */

import { runRawQuery } from './connector.js';
import { fmt, fmtMoney, CHANNEL_MAP } from './format.js';

// ============================================================
// STAŁE
// ============================================================

// Ile wierszy pokazujemy w długich tabelach (reszta zwijana do informacji o pominięciu).
export const MAX_ROWS = 100;
// Poniżej tylu kliknięć w 30 dniach sygnał 30-dniowy jest zbyt cienki na decyzję.
export const MIN_KLIKNIEC_30 = 5;
// Klucz pseudo-kampanii trzymającej agregat całego konta (fallback benchmarków).
export const KONTO = '(całe konto)';

// Konwersje poniżej PROG_KONWERSJI traktujemy jak zero. Google atrybuuje ułamki, więc
// słowo z setną częścią konwersji pokazywało „0,0 konw." obok pięciocyfrowego kosztu
// konwersji — liczba formalnie poprawna, w tabeli czytana jak błąd skryptu. Zerowanie
// odpala właściwy sygnał („rok bez konwersji") zamiast wariantu z absurdalną poprzeczką.
// Wartość konwersji zostaje nietknięta: to realny przychód i jego sumy mają się zgadzać
// z interfejsem Google Ads.
export const PROG_KONWERSJI = 0.1;

// Numeryczne enumy z API (Google Ads zwraca liczby, nie stringi).
export const MATCH_TYPE = { 2: 'Ścisłe', 3: 'Do wyrażenia', 4: 'Przybliżone' };
export const CRITERION_STATUS = { 2: 'ENABLED', 3: 'PAUSED', 4: 'REMOVED' };

const query = (account, gaql) =>
    runRawQuery(account.id, gaql, { loginCustomerId: account.login_customer_id });

// ============================================================
// POBIERANIE DANYCH
// ============================================================

// Lista słów kluczowych jest brana z `ad_group_criterion`, a NIE z `keyword_view`.
//
// Powód: `keyword_view` zwraca RÓWNIEŻ WYKLUCZAJĄCE słowa kluczowe, a te mają zero
// wyświetleń z definicji. Gdyby lista szła stamtąd, każdy negatyw wylądowałby w panelu
// „martwe słowa" — na koncie aktywnie wykluczającym negatywy potrafi to być znacząca
// część listy. Dlatego źródłem prawdy jest `ad_group_criterion` z `negative = FALSE`,
// a keyword_view służy wyłącznie do dołożenia metryk (join po adGroupId~criterionId).
//
// Słowa z kampanii i grup wstrzymanych POBIERAMY, ale oznaczamy `aktywne = false`.
// Dwie różne role: ich historia roczna jest prawdziwym kosztem konta i ma się liczyć
// do średnich kampanii, natomiast wyświetlić się już nie mogą, więc nie mogą trafić
// na żadną listę proponującą działanie.
export async function fetchKeywordList(account) {
    const rows = await query(account, `
        SELECT
            campaign.id,
            campaign.name,
            campaign.status,
            campaign.advertising_channel_type,
            ad_group.id,
            ad_group.name,
            ad_group.status,
            ad_group_criterion.criterion_id,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type,
            ad_group_criterion.status
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = FALSE
          AND ad_group_criterion.status != 'REMOVED'
    `);
    const map = new Map();
    rows.forEach(r => {
        const text = r['ad_group_criterion.keyword.text'];
        if (!text) return;
        const key = `${r['ad_group.id']}~${r['ad_group_criterion.criterion_id']}`;
        const campaignStatus = CRITERION_STATUS[r['campaign.status']] || 'UNKNOWN';
        const adGroupStatus = CRITERION_STATUS[r['ad_group.status']] || 'UNKNOWN';
        const status = CRITERION_STATUS[r['ad_group_criterion.status']] || 'UNKNOWN';
        map.set(key, {
            key,
            campaignId: String(r['campaign.id'] ?? ''),
            campaign: r['campaign.name'] || '(bez nazwy)',
            campaignStatus,
            campaignType: CHANNEL_MAP[r['campaign.advertising_channel_type']] || '—',
            adGroup: r['ad_group.name'] || '(bez nazwy)',
            adGroupStatus,
            text,
            matchType: MATCH_TYPE[r['ad_group_criterion.keyword.match_type']] || '—',
            matchTypeRaw: r['ad_group_criterion.keyword.match_type'],
            status,
            // Jedyna bramka paneli proponujących działanie: słowo może się dziś wyświetlić.
            // Wymaga ENABLED na wszystkich trzech poziomach — samo ENABLED na słowie nic
            // nie znaczy, gdy jego kampania stoi.
            aktywne: status === 'ENABLED' && campaignStatus === 'ENABLED' && adGroupStatus === 'ENABLED',
            d30: emptyMetrics(), rok: emptyMetrics(),
            is: null, lostRank: null, lostBudget: null, topIs: null,
        });
    });
    return map;
}

export function emptyMetrics() {
    return { imp: 0, clicks: 0, cost: 0, conv: 0, value: 0 };
}

export function readMetrics(r) {
    const conv = r['metrics.conversions'] || 0;
    return {
        imp: r['metrics.impressions'] || 0,
        clicks: r['metrics.clicks'] || 0,
        cost: (r['metrics.cost_micros'] || 0) / 1e6,
        conv: conv < PROG_KONWERSJI ? 0 : conv,
        value: r['metrics.conversions_value'] || 0,
    };
}

// Metryki 30-dniowe + udział wyświetleń.
//
// UWAGA — `search_budget_lost_impression_share` NIE ISTNIEJE na poziomie słowa kluczowego
// (API odrzuca zapytanie). Utratę przez budżet liczymy jako resztę:
// `1 − search_impression_share − search_rank_lost_impression_share`.
export async function fetchMetrics30(account, range) {
    return query(account, `
        SELECT
            ad_group.id,
            ad_group_criterion.criterion_id,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value,
            metrics.search_impression_share,
            metrics.search_rank_lost_impression_share,
            metrics.search_top_impression_share
        FROM keyword_view
        WHERE segments.date BETWEEN '${range.start}' AND '${range.end}'
          AND ad_group_criterion.status != 'REMOVED'
    `);
}

export async function fetchMetricsYear(account, range) {
    return query(account, `
        SELECT
            ad_group.id,
            ad_group_criterion.criterion_id,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value
        FROM keyword_view
        WHERE segments.date BETWEEN '${range.start}' AND '${range.end}'
          AND ad_group_criterion.status != 'REMOVED'
    `);
}

// Cel ustawiony W SAMEJ KAMPANII (tROAS / tCPA ze strategii licytacji). To najlepszy
// dostępny punkt odniesienia: mówi, czego od tej kampanii oczekujemy, a nie co średnio
// wychodzi. Konto potrafi mieć jeden cel dla całości, gdy kampanie mają własne, niższe —
// porównywanie słabszej kategorii do celu konta produkuje listę „do sprawdzenia" złożoną
// z całej tej kategorii, a to problem struktury konta, nie audytu pojedynczych słów.
// Kluczowane po `campaign.id`, nie po nazwie: nazwa kampanii NIE JEST unikalna w koncie,
// więc dwie kampanie o tej samej nazwie nadpisywałyby sobie cele, a jedna z nich zostawała
// bez celu na etapie oceny (`benchmarkFor` szuka po tym kluczu).
export async function fetchCampaignTargets(account) {
    const rows = await query(account, `
        SELECT
            campaign.id,
            campaign.name,
            campaign.maximize_conversion_value.target_roas,
            campaign.target_roas.target_roas,
            campaign.maximize_conversions.target_cpa_micros,
            campaign.target_cpa.target_cpa_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
    `);
    const cele = {};
    rows.forEach(r => {
        const roas = r['campaign.maximize_conversion_value.target_roas'] ?? r['campaign.target_roas.target_roas'] ?? null;
        const cpaMicros = r['campaign.maximize_conversions.target_cpa_micros'] ?? r['campaign.target_cpa.target_cpa_micros'] ?? null;
        cele[String(r['campaign.id'])] = { name: r['campaign.name'], roas, cpa: cpaMicros ? cpaMicros / 1e6 : null };
    });
    return cele;
}

export function mergeMetrics(map, rows, okno) {
    let dopasowane = 0;
    rows.forEach(r => {
        const key = `${r['ad_group.id']}~${r['ad_group_criterion.criterion_id']}`;
        const kw = map.get(key);
        if (!kw) return;
        dopasowane++;
        kw[okno] = readMetrics(r);
        if (okno === 'd30') {
            const is = r['metrics.search_impression_share'];
            if (is !== null && is !== undefined) {
                kw.is = is;
                kw.lostRank = r['metrics.search_rank_lost_impression_share'] || 0;
                kw.lostBudget = Math.max(0, 1 - is - kw.lostRank);
                kw.topIs = r['metrics.search_top_impression_share'] ?? null;
            }
        }
    });
    return dopasowane;
}

// ============================================================
// BENCHMARKI
// ============================================================

// Średnie liczone są z samych słów kluczowych danej kampanii, a nie z całej kampanii —
// mieszanie do tego ruchu z DSA czy z odbiorców zaburzyłoby punkt odniesienia.
//
// Klucz agregatu to `campaign.id`, nie nazwa: dwie kampanie o identycznej nazwie
// (możliwe w Google Ads) miały wspólny agregat, a każde słowo z nich dostawało jego
// średnią zamiast średniej własnej kampanii.
export function campaignAverages(keywords, okno) {
    const agg = { [KONTO]: emptyMetrics() };
    keywords.forEach(kw => {
        const m = kw[okno];
        const a = agg[kw.campaignId] || (agg[kw.campaignId] = emptyMetrics());
        [a, agg[KONTO]].forEach(t => {
            t.imp += m.imp; t.clicks += m.clicks; t.cost += m.cost; t.conv += m.conv; t.value += m.value;
        });
    });
    Object.values(agg).forEach(a => {
        a.cpa = a.conv > 0 ? a.cost / a.conv : null;
        a.roas = a.cost > 0 ? a.value / a.cost : null;
    });
    return agg;
}

// Kampania bez ani jednej konwersji nie ma własnego kosztu konwersji — a to właśnie
// kampanie, które przepalają budżet w całości. Bez fallbacku żaden sygnał by się w nich
// nie odpalił.
export function kosztKonwersji(avg, campaignId) {
    return avg[campaignId]?.cpa ?? avg[KONTO]?.cpa ?? null;
}

// Poprzeczka — hierarchia od najbardziej konkretnej do najbardziej ogólnej:
//   1. cel USTAWIONY W KAMPANII (tROAS / tCPA ze strategii licytacji);
//   2. cel konta z config klienta;
//   3. średnia roczna kampanii, a na końcu średnia roczna konta.
//
// Cel kampanii bije cel konta, bo konto z jednym celem 12 przy kampaniach mających 8–10
// generowało listę „do sprawdzenia" złożoną z całej słabszej kategorii zamiast
// z odstających słów.
// `campaignId` (nie nazwa) — nazwa nie jest w Google Ads unikalna.
export function benchmarkFor(campaignId, avgRok, cele, isEcom, celeKampanii = {}) {
    const cel = celeKampanii[campaignId] || {};
    const a = avgRok[campaignId] || {};
    if (isEcom) {
        if (cel.roas) return { roas: cel.roas, cpa: null, zrodlo: 'cel kampanii' };
        if (cele.roas) return { roas: cele.roas, cpa: null, zrodlo: 'cel konta' };
        const roas = a.roas ?? avgRok[KONTO]?.roas ?? null;
        return { roas, cpa: null, zrodlo: a.roas ? 'śr. roczna kampanii' : 'śr. roczna konta' };
    }
    if (cel.cpa) return { roas: null, cpa: cel.cpa, zrodlo: 'cel kampanii' };
    if (cele.cpa) return { roas: null, cpa: cele.cpa, zrodlo: 'cel konta' };
    const cpa = a.cpa ?? avgRok[KONTO]?.cpa ?? null;
    return { roas: null, cpa, zrodlo: a.cpa ? 'śr. roczna kampanii' : 'śr. roczna konta' };
}

// ============================================================
// SYGNAŁY KANDYDATÓW
// ============================================================

// Każdy sygnał ma poziom: „pewny" albo „do sprawdzenia". Słowo trafia do pewnych, gdy
// ma CHOĆ JEDEN pewny sygnał — trzy niepewne sygnały to nadal niepewność, więc nie
// sumujemy heurystyk.
export function exclusionSignals(kw, avg30, avgRok, bench, isEcom) {
    const sygnaly = [];
    const kosztKonw30 = kosztKonwersji(avg30, kw.campaignId);
    const kosztKonwRok = kosztKonwersji(avgRok, kw.campaignId);

    // Sygnał 30-dniowy: wydaje i nie konwertuje. Sam w sobie jest cienki (miesiąc to
    // mało danych), więc awansuje do „pewnego" dopiero, gdy rok mówi to samo.
    if (kw.d30.conv === 0 && kw.d30.clicks >= MIN_KLIKNIEC_30 && kosztKonw30 && kw.d30.cost >= 1.5 * kosztKonw30) {
        const potwierdzaRok = kw.rok.conv === 0 && kw.rok.imp > 0;
        const kontekstRoku = potwierdzaRok
            ? ' — rok potwierdza: też zero konwersji'
            : kw.rok.conv > 0
                ? ` — ale rok nie potwierdza: ${fmt(kw.rok.conv, 1)} konw. przy koszcie ${fmtMoney(kw.rok.cost)} (${fmtMoney(kw.rok.cost / kw.rok.conv)}/konw.)`
                : ' — rok bez danych, więc bez potwierdzenia';
        sygnaly.push({
            poziom: potwierdzaRok ? 'pewny' : 'sprawdz',
            opis: `30 dni bez konwersji przy koszcie ${fmtMoney(kw.d30.cost)} (${fmt(kw.d30.cost / kosztKonw30, 1)}× koszt konwersji kampanii)`
                + kontekstRoku,
        });
    }

    // Sygnał roczny — osobny, bo łapie słowa, których 30 dni nie zgłosi (za mało
    // kliknięć), a które systematycznie przepalają budżet małymi kwotami.
    if (kw.rok.conv === 0 && kw.rok.imp > 0 && kosztKonwRok && kw.rok.cost >= 2 * kosztKonwRok) {
        const krotnosc = kw.rok.cost / kosztKonwRok;
        sygnaly.push({
            poziom: krotnosc >= 3 ? 'pewny' : 'sprawdz',
            opis: `rok bez konwersji przy koszcie ${fmtMoney(kw.rok.cost)} (${fmt(krotnosc, 1)}× roczny koszt konwersji kampanii)`,
        });
    }

    // Konwersje są, ale wynik roczny mocno poniżej celu. Próg wejścia: koszt roczny
    // ≥ 2× DOCELOWY koszt konwersji — przy zakładanej skuteczności powinno było zebrać
    // dwie konwersje. Poniżej tego progu koszt konwersji jest policzony z jednej
    // konwersji albo z jej ułamka i nie niesie informacji.
    const progKosztu = (!isEcom && bench.cpa) ? bench.cpa : kosztKonwRok;
    if (kw.rok.conv > 0 && progKosztu && kw.rok.cost >= 2 * progKosztu) {
        if (isEcom && bench.roas) {
            const roas = kw.rok.cost > 0 ? kw.rok.value / kw.rok.cost : 0;
            if (roas < 0.5 * bench.roas) {
                sygnaly.push({ poziom: 'sprawdz', opis: `roczny ROAS ${fmt(roas, 2)} to poniżej połowy poprzeczki ${fmt(bench.roas, 2)} (${bench.zrodlo})` });
            }
        } else if (!isEcom && bench.cpa) {
            const cpa = kw.rok.cost / kw.rok.conv;
            if (cpa > 2 * bench.cpa) {
                sygnaly.push({
                    poziom: 'sprawdz',
                    opis: `roczny koszt konwersji ${fmtMoney(cpa)} to ponad 2× poprzeczka ${fmtMoney(bench.cpa)} (${bench.zrodlo})`,
                });
            }
        }
    }

    return sygnaly;
}

// Ochrona przez wynik — słowo wypada z listy do wstrzymania, gdy KTÓRYKOLWIEK z okresów
// trzyma cel. Obrona jest symetryczna w czasie:
//  • Rok broni słowa słabego w miesiącu — próbka duża, próg łagodny (75%/1,5×).
//  • 30 dni broni słowa słabego w roku — próbka mała, próg PEŁNY i wymagana min. 1
//    pełna konwersja, żeby jedna szczęśliwa sprzedaż nie broniła słowa.
export function obronaWynikiem(kw, bench, isEcom) {
    if (kw.d30.conv >= 1 && kw.d30.cost > 0) {
        if (isEcom && bench.roas) {
            const roas = kw.d30.value / kw.d30.cost;
            if (roas >= bench.roas) return `ROAS 30 dni ${fmt(roas, 2)} przy poprzeczce ${fmt(bench.roas, 2)} — dziś dowozi`;
        }
        if (!isEcom && bench.cpa) {
            const cpa = kw.d30.cost / kw.d30.conv;
            if (cpa <= bench.cpa) return `koszt konwersji 30 dni ${fmtMoney(cpa)} przy poprzeczce ${fmtMoney(bench.cpa)} — dziś dowozi`;
        }
    }
    if (kw.rok.conv <= 0 || kw.rok.cost <= 0) return null;
    if (isEcom && bench.roas) {
        const roas = kw.rok.value / kw.rok.cost;
        if (roas >= 0.75 * bench.roas) return `roczny ROAS ${fmt(roas, 2)} przy poprzeczce ${fmt(bench.roas, 2)}`;
    }
    if (!isEcom && bench.cpa) {
        const cpa = kw.rok.cost / kw.rok.conv;
        if (cpa <= 1.5 * bench.cpa) return `roczny koszt konwersji ${fmtMoney(cpa)} przy poprzeczce ${fmtMoney(bench.cpa)}`;
    }
    return null;
}

export function buildPauseModel(keywords, avg30, avgRok, cele, isEcom, celeKampanii) {
    const pewne = [], sprawdz = [];
    let bronione = 0;
    keywords.forEach(kw => {
        if (!kw.aktywne) return;
        const bench = benchmarkFor(kw.campaignId, avgRok, cele, isEcom, celeKampanii);
        const sygnaly = exclusionSignals(kw, avg30, avgRok, bench, isEcom);
        if (!sygnaly.length) return;
        const obrona = obronaWynikiem(kw, bench, isEcom);
        // Obrona jest FILTREM, nie sekcją raportu. Licznik zostaje w logu, żeby widać
        // było, ile słów mechanizm wyciął.
        if (obrona) { bronione++; return; }
        const wpis = { kw, bench, sygnaly };
        if (sygnaly.some(s => s.poziom === 'pewny')) pewne.push(wpis); else sprawdz.push(wpis);
    });
    const wgKosztu = (a, b) => b.kw.rok.cost - a.kw.rok.cost;
    return { pewne: pewne.sort(wgKosztu), sprawdz: sprawdz.sort(wgKosztu), bronione };
}

// Kandydaci do wstrzymania w formie nadającej się do `gads-connector`
// (`--action=update-keyword-status --criterion=adGroupId~criterionId`).
// Świadomie BEZ kolumny `status`: plik z gotowym `PAUSED` w każdym wierszu dałoby się
// podać wprost do `--input`, co wstrzymałoby także „do sprawdzenia". Wybór zostaje
// przy operatorze — konektor dostaje listę kryteriów dopiero po potwierdzeniu.
export function buildCandidatesCsv(pause, isEcom) {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    // Notacja Google Ads zamiast surowego enuma z API: kolumna ma się nadawać do
    // wklejenia i do grepu, a to samo słowo w dwóch dopasowaniach to dwie decyzje.
    const notacja = kw => kw.matchTypeRaw === 2 ? `[${kw.text}]`
        : kw.matchTypeRaw === 3 ? `"${kw.text}"` : kw.text;
    const wiersz = (w, poziom) => [
        w.kw.key, q(notacja(w.kw)), q(w.kw.matchType), q(w.kw.campaign), q(w.kw.adGroup), poziom,
        w.kw.rok.clicks, w.kw.rok.cost.toFixed(2), w.kw.rok.conv.toFixed(1),
        isEcom ? (w.kw.rok.cost > 0 ? (w.kw.rok.value / w.kw.rok.cost).toFixed(2) : '')
               : (w.kw.rok.conv > 0 ? (w.kw.rok.cost / w.kw.rok.conv).toFixed(2) : ''),
        q(w.sygnaly.map(s => s.opis).join(' | ')),
    ].join(',');
    return ['criterion,slowo,dopasowanie,kampania,grupa,poziom,klikniecia_rok,koszt_rok,konw_rok,wynik_rok,powod',
        ...pause.pewne.map(w => wiersz(w, 'pewny')),
        ...pause.sprawdz.map(w => wiersz(w, 'sprawdz'))].join('\n') + '\n';
}

// Grupowanie kandydatów po kampanii — decyzję o wstrzymaniu podejmuje się w kontekście
// jednej kampanii (ma własny cel, własny budżet i własną rolę). Kampanie idą wg sumy
// kosztu rocznego malejąco.
// Grupujemy po `campaignId`, nie po nazwie — dwie kampanie o identycznej nazwie
// (dozwolone w Google Ads) muszą wychodzić jako dwie osobne sekcje, żeby operator
// zobaczył, że są dwa różne cele/budżety do rozważenia.
export function grupujPoKampanii(lista) {
    const grupy = new Map();
    lista.forEach(w => {
        const id = w.kw.campaignId;
        if (!grupy.has(id)) grupy.set(id, []);
        grupy.get(id).push(w);
    });
    return [...grupy.entries()]
        .map(([campaignId, wpisy]) => ({
            campaignId,
            campaign: wpisy[0].kw.campaign, // nazwa do wyświetlenia
            wpisy,
            koszt: wpisy.reduce((s, w) => s + w.kw.rok.cost, 0),
            bench: wpisy[0].bench,
        }))
        .sort((a, b) => b.koszt - a.koszt);
}
