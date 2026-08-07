/**
 * analiza.js — logika wykrywania haseł do wykluczenia. Czyste funkcje, zero I/O
 * i zero HTML: dzięki temu da się ją przetestować offline (`smoke-test.js`).
 *
 * Sygnały (każdy ma poziom: „pewny" albo „do sprawdzenia"):
 *   1. Wydajność 30 dni       — koszt bez konwersji / ROAS poniżej celu
 *   2. Wydajność roczna       — cały rok kosztów bez konwersji (albo wynik roczny pod celem)
 *   3. Dopasowanie semantyczne — hasło daleko od słów kluczowych grupy reklam
 *   4. Ocena AI (warstwa 3b)  — hasła niepewne ocenione z kontekstem oferty klienta
 *
 * Reguł słownikowych („praca", „za darmo", „jak…") świadomie NIE MA: listy pisane
 * pod ogół zderzają się z branżą konkretnego klienta i mylą się częściej, niż
 * trafiają — u sklepu ogrodniczego „stanowisko" to miejsce nasadzenia, nie oferta
 * pracy. Ocenę intencji robi wyłącznie warstwa 3b, która zna ofertę.
 */

import { fmt, fmtMoney } from './format.js';

// ============================================================
// TOKENIZACJA I PODOBIEŃSTWO
// ============================================================

const STOPWORDS = new Set(['dla', 'jak', 'co', 'czy', 'na', 'do', 'się', 'nie', 'po', 'przez', 'i', 'w', 'z', 'to', 'ze', 'od', 'ile', 'lub', 'oraz', 'jest', 'są', 'tego', 'tej', 'ten', 'ta', 'przy', 'bez', 'jego', 'jej']);

export function getWordTokens(text) {
    return String(text || '').toLowerCase()
        .split(/[\s\-_/.,;:!?()\[\]]+/)
        .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

// Podobieństwo 3-gramowe (Jaccard na znakach) — bez stemmingu, więc działa dla
// polskiej fleksji: „montaż" vs „montażu" → 0,80; „praca" vs „pracownik" → 0,25
// (celowo nisko — to różne słowa, nie odmiana tego samego).
function char3grams(word) {
    const grams = new Set();
    for (let i = 0; i <= word.length - 3; i++) grams.add(word.substring(i, i + 3));
    return grams;
}

export function jaccardSim(a, b) {
    if (a === b) return 1;
    const g1 = char3grams(a);
    const g2 = char3grams(b);
    if (g1.size === 0 || g2.size === 0) return 0;
    let inter = 0;
    g1.forEach(g => { if (g2.has(g)) inter++; });
    return inter / (g1.size + g2.size - inter);
}

// Pokrycie WPRZÓD: czy hasło dokłada słowa obce wobec słów kluczowych grupy.
export function calcSemanticOverlap(searchTerm, keywords) {
    const termWords = getWordTokens(searchTerm);
    if (termWords.length === 0) return 1;
    const kwWords = keywords.flatMap(kw => getWordTokens(kw));
    if (kwWords.length === 0) return 0;
    let total = 0;
    termWords.forEach(tw => {
        let best = 0;
        kwWords.forEach(kw => { best = Math.max(best, jaccardSim(tw, kw)); });
        total += best;
    });
    return total / termWords.length;
}

// Pokrycie WSTECZ: ile słów najlepiej pasującego słowa kluczowego ma odpowiednik
// w haśle. Liczone per słowo kluczowe, bo pytanie brzmi „czy hasło niesie wszystko,
// co niesie TO słowo kluczowe", a nie „czy grupa gdziekolwiek ma te słowa".
//
// Po co osobno: overlap wykrywa hasła DOKŁADAJĄCE obce słowa, ale jest ślepy na te,
// które POMIJAJĄ kwalifikator decydujący o biznesie. „serwis rowerów" wobec słowa
// kluczowego `mobilny serwis rowerów kraków` ma pokrycie wprzód 100%, a wstecz 0,50 —
// brakuje „mobilnego" (całego modelu usługi) i miasta.
//
// Uwaga na czułość: liczy się UŁAMEK słów słowa kluczowego, więc im dłuższe słowo
// kluczowe, tym mniej boli brak jednego członu. Przy 4-wyrazowym słowie kluczowym
// brak jednego słowa daje dokładnie 0,75 — poniżej progu, czyli hasło idzie do oceny
// (zob. MIN_POKRYCIE_SLOWA_KLUCZOWEGO). Przy 5-wyrazowym to już 0,80 i uchodzi za
// trafione — dla najdłuższych słów kluczowych sygnał łapie realne rozjazdy, a nie
// pojedyncze przymiotniki.
export function calcKeywordCoverage(searchTerm, keywords) {
    const termWords = getWordTokens(searchTerm);
    if (termWords.length === 0) return 0;
    let best = 0;
    for (const kw of keywords) {
        const kwWords = getWordTokens(kw);
        if (kwWords.length === 0) continue;
        const score = kwWords.reduce(
            (s, w) => s + termWords.reduce((m, t) => Math.max(m, jaccardSim(w, t)), 0), 0
        ) / kwWords.length;
        if (score > best) best = score;
    }
    return best;
}

// Poniżej tego pokrycia uznajemy, że hasło gubi kwalifikator — i posyłamy je do
// oceny AI zamiast uznać za trafione. Samo w sobie NIE jest powodem wykluczenia:
// czy brakujące słowo jest istotne, wie tylko ocena znająca ofertę
// („mobilny" u serwisu mobilnego jest, „ogrodowy" przy haśle „bambus" nie).
//
// 0,80, nie 0,75: przy 4-wyrazowym słowie kluczowym brak jednego członu daje dokładnie
// 0,75, więc przy progu 0,75 „serwis rowerów kraków" wobec `mobilny serwis rowerów
// kraków` uchodził za trafiony i NIE trafiał do oceny — a brakujące słowo bywa całym
// modelem biznesowym. Asymetria błędu jest po tej stronie: ocena niepotrzebnego hasła
// kosztuje tokeny, przeoczenie — budżet klienta. Wyżej niż 0,80 nie warto: zaczyna
// wpuszczać do oceny hasła różniące się jednym przymiotnikiem.
export const MIN_POKRYCIE_SLOWA_KLUCZOWEGO = 0.80;

// ============================================================
// KAMPANIE — pomocnicze
// ============================================================

export const isBrandCampaign = (name) => /brand/i.test(String(name || ''));

// Kampanie produktowe nie mają słów kluczowych, generują dziesiątki tysięcy haseł
// z długim ogonem i wyklucza się w nich rzadko — tylko to, co wyraźnie szkodzi.
// Dlatego kandydatem może być wyłącznie hasło z realnym ruchem.
export const PRODUKTOWE = new Set(['PMax', 'Shopping']);
export const MIN_KLIKNIEC_PRODUKTOWE = 5;
export const progKlikniec = (typKampanii) => PRODUKTOWE.has(typKampanii) ? MIN_KLIKNIEC_PRODUKTOWE : 0;

export function averagesFromCampStats(stats) {
    const cpa = {};
    const roas = {};
    Object.entries(stats).forEach(([name, d]) => {
        cpa[name] = d.conversions > 0 ? d.cost / d.conversions : null;
        roas[name] = d.cost > 0 ? d.value / d.cost : null;
    });
    return { cpa, roas };
}

// Statystyki kampanii z wierszy haseł (okno 30-dniowe).
export function campStatsFromRows(rows) {
    const stats = {};
    rows.forEach(t => {
        if (!stats[t.campaign]) stats[t.campaign] = { cost: 0, conversions: 0, value: 0 };
        stats[t.campaign].cost += t.cost;
        stats[t.campaign].conversions += t.conversions;
        stats[t.campaign].value += (t.value || 0);
    });
    return stats;
}

// Średnie roczne kampanii — punkt odniesienia dla sygnału rocznego i dla obrony rokiem.
// Krytyczne, żeby to był TEN SAM rok: porównywanie roku hasła do średniej z 30 dni
// jest błędem systematycznym — po dobrym miesiącu poprzeczka rośnie i produkuje
// fałszywe „pewne" wykluczenia, po słabym wszystko ląduje w „bronione".
export function buildYearBenchmarks(campYearStats) {
    return averagesFromCampStats(campYearStats);
}

// ============================================================
// HASŁA NIEPEWNE — materiał dla oceny AI (warstwa 3b)
// ============================================================

// Hasła bez konwersji i bez wyraźnego sygnału liczbowego, czyli te, o których
// same liczby nic nie mówią. Metryki SUMUJEMY po wszystkich wierszach hasła
// (to samo zapytanie bywa obsługiwane przez kilka kampanii/grup) — to koszt
// decyduje o sortowaniu i o przydziale budżetu sprawdzeń SERP.
export function collectUncertainTerms(st, adGroupKeywords) {
    const byTerm = new Map();
    st.forEach(t => {
        if (t.conversions > 0 || t.impressions < 3) return;
        // Hasło uznajemy za trafione tematycznie — i pomijamy — dopiero gdy zgadza się
        // w OBIE strony: nie dokłada obcych słów i nie gubi kwalifikatora.
        const agKws = adGroupKeywords[`${t.campaign}|||${t.adGroup}`] || [];
        if (agKws.length > 0
            && calcSemanticOverlap(t.term, agKws) > 0.6
            && calcKeywordCoverage(t.term, agKws) >= MIN_POKRYCIE_SLOWA_KLUCZOWEGO) return;
        const cur = byTerm.get(t.term)
            || { term: t.term, impressions: 0, clicks: 0, cost: 0, kampanie: new Set() };
        cur.impressions += t.impressions;
        cur.clicks += t.clicks;
        cur.cost += t.cost;
        if (t.campaign) cur.kampanie.add(t.campaign);
        byTerm.set(t.term, cur);
    });
    return [...byTerm.values()].map(t => ({ ...t, kampanie: [...t.kampanie] }));
}

// ============================================================
// PAMIĘĆ MIĘDZY RUNDAMI — tematy już zbadane
// ============================================================

// Hasła w `grawisach` z wpisów listy pliku status. Czytamy TYLKO wpisy listy
// (linie od `-`), żeby nie łapać nazw plików z akapitów instruktażowych szablonu.
// Zwracamy TOKENY, nie całe napisy: dopasowanie 1:1 sprawiało, że wpis
// `fotel biurowy` nie chronił „fotele biurowe" i budżet sprawdzeń co rundę
// schodził na warianty tego samego, rozstrzygniętego tematu.
export function knownTopicsFromStatus(text) {
    const topics = [];
    for (const line of String(text || '').split('\n')) {
        if (!/^\s*[-*]\s/.test(line)) continue;
        for (const m of line.matchAll(/`([^`]{2,120})`/g)) {
            const tokens = getWordTokens(m[1]);
            if (tokens.length) topics.push(tokens);
        }
    }
    return topics;
}

// Dopasowanie słowa wpisu do słów hasła jest ROZMYTE, nie dosłowne — inaczej wpis
// `fotel biurowy` nie pokrywałby „fotele biurowe opinie" i budżet sprawdzeń co rundę
// schodziłby na odmiany tego samego, rozstrzygniętego tematu (polska fleksja zmienia
// końcówkę prawie każdego rzeczownika). Próg 0,6: „fotel"/„fotele" = 0,75,
// „biurowy"/„biurowe" = 0,67, a „praca"/„pracownik" = 0,25, czyli różne słowa nadal
// się nie sklejają. Ograniczenie: przy słowach 4–5-literowych 3-gramy są za krótkie
// („okno"/„oknem" = 0,25) — takie tematy zapisuj w statusie w formie występującej
// w haśle.
const TOKEN_SIM_PROG = 0.6;
const maSlowo = (tok, w) => tok.some(t => jaccardSim(t, w) >= TOKEN_SIM_PROG);

// Hasło należy do zbadanego tematu, gdy zawiera WSZYSTKIE znaczące słowa wpisu.
// Wpis JEDNOWYRAZOWY musi trafić w całe hasło — inaczej `serwis` z listy ustaleń
// oznaczałby jako zbadane praktycznie każde hasło na koncie usługowym.
// Wpis może mieć WIELOZNACZNIK w klamrach: `serwis {miejscowość}` pokrywa
// „serwis kraków" i „serwis laptopów gdańsk", ale nie samo „serwis".
export function isKnownTopic(term, topics) {
    const tok = getWordTokens(term);
    return topics.some(words => {
        const stale = words.filter(w => !w.startsWith('{'));
        if (!stale.length) return false;
        if (stale.length < words.length) return stale.every(w => maSlowo(tok, w)) && tok.length > stale.length;
        return words.length === 1
            ? (tok.length === 1 && jaccardSim(tok[0], words[0]) >= TOKEN_SIM_PROG)
            : words.every(w => maSlowo(tok, w));
    });
}

// ============================================================
// OCHRONA — hasło kupowane świadomie
// ============================================================

// Słowa kluczowe całej KAMPANII, nie grupy reklam: wykluczające dodaje się per
// kampania, więc negatyw zabije słowo kluczowe niezależnie od tego, w której
// grupie ono siedzi.
export function keywordsByCampaign(adGroupKeywords) {
    const byCamp = {};
    Object.entries(adGroupKeywords || {}).forEach(([key, kws]) => {
        const camp = String(key).split('|||')[0];
        (byCamp[camp] ||= []).push(...kws);
    });
    return byCamp;
}

// Czy hasło JEST słowem kluczowym kampanii — te same znaczące słowa, z tolerancją
// polskiej fleksji (ten sam próg podobieństwa co przy tematach ze statusu).
//
// Świadomie tożsamość, a NIE „objęte dopasowaniem": słowo kluczowe do wyrażenia
// `skup samochodów` pokrywa też „skup samochodów warszawa", które chcemy móc
// wyciąć. Równość liczby słów załatwia obie strony naraz — hasło ani nie dokłada
// obcego członu, ani nie gubi kwalifikatora.
export function isSameAsKeyword(term, keywords) {
    const t = getWordTokens(term);
    if (!t.length || !keywords || !keywords.length) return false;
    return keywords.some(kw => {
        const k = getWordTokens(kw);
        return k.length === t.length && k.every(w => maSlowo(t, w)) && t.every(w => maSlowo(k, w));
    });
}

// ============================================================
// SYGNAŁY
// ============================================================

// Próg pewności oceny AI, powyżej którego sygnał uznajemy za pewny.
export const AI_PEWNOSC_PROG = 80;

// Powody wykluczenia dla POJEDYNCZEGO wiersza hasła (warstwy 1, 3 i 3b).
// `avg` — miernik kampanii: ecom → ROAS (cel z kontekstu albo średnia), leadgen → CPA.
// `avgCostPerConv` — średni koszt konwersji kampanii; próg kosztowy dla ecom.
export function computeExclusionReasons(t, adGroupKeywords, avg, aiNegatives, isEcom = false,
                                        { avgCostPerConv = null, benchLabel = '' } = {}) {
    const reasons = [];

    // Warstwa 1 — wydajność z 30 dni
    if (isEcom) {
        // Sam ROAS to za mało: przy konwersji co 30–50 kliknięć większość zdrowych
        // haseł ma w oknie 5 kliknięć ROAS 0, więc bez progu kosztowego kandydatem
        // zostawało hasło, które wydało 2 zł.
        const progKosztu = avgCostPerConv !== null && avgCostPerConv > 0 ? avgCostPerConv * 2 : null;
        if (t.clicks >= 5 && avg !== null && avg > 0 && t.cost > 0 && progKosztu !== null && t.cost >= progKosztu) {
            const roas = t.value / t.cost;
            if (roas < avg * 0.5) {
                const opis = benchLabel || `śr. ROAS kampanii (${fmt(avg, 2)})`;
                reasons.push({
                    kind: 'wydajnosc',
                    text: `Niski ROAS (${fmt(roas, 2)}) przy koszcie ${fmtMoney(t.cost)} / 30 dni — poniżej 50% ${opis} i ponad 2× śr. koszt konwersji (${fmtMoney(avgCostPerConv)})`
                });
            }
        }
    } else {
        if (t.clicks >= 5 && t.conversions === 0 && avg !== null && avg > 0 && t.cost >= avg * 2) {
            reasons.push({
                kind: 'wydajnosc',
                text: `Wysoki koszt (${fmtMoney(t.cost)} / 30 dni), 0 konwersji — powyżej 2× CPA kampanii (${fmtMoney(avg)})`
            });
        }
    }

    // Warstwa 3 — dystans semantyczny od słów kluczowych grupy reklam
    if (t.impressions >= 5) {
        const agKws = adGroupKeywords[`${t.campaign}|||${t.adGroup}`] || [];
        if (agKws.length > 0) {
            const overlap = calcSemanticOverlap(t.term, agKws);
            if (overlap < 0.25) {
                reasons.push({
                    kind: 'semantyka',
                    text: `Słabe dopasowanie do grupy „${t.adGroup}" (pokrycie: ${Math.round(overlap * 100)}%)`
                });
            }
        }
    }

    // Warstwa 3b — ocena AI haseł niepewnych
    const verdict = aiNegatives.get(t.term.toLowerCase());
    if (t.conversions === 0 && verdict) {
        const zrodlo = verdict.serp ? 'ocena AI + SERP' : 'ocena AI';
        const podpis = verdict.pewnosc !== null ? `${zrodlo}, pewność ${verdict.pewnosc}%` : zrodlo;
        reasons.push({
            kind: 'ai',
            pewnosc: verdict.pewnosc,
            text: `${verdict.powod || 'Niezwiązane z ofertą'} (${podpis})`
        });
    }

    return reasons;
}

// Warstwa 2 — sygnał z danych ROCZNYCH. Łapie przypadek, którego okno 30-dniowe
// nie zgłosi: za mało kliknięć w miesiącu, żeby cokolwiek twierdzić, ale rok
// pokazuje, że hasło systematycznie przepala budżet.
//   0 konwersji przez rok, koszt ≥ 3× roczny koszt konwersji kampanii → pewny
//   0 konwersji przez rok, koszt ≥ 2×                                 → do sprawdzenia
//   są konwersje, ale wynik roczny mocno pod celem                    → do sprawdzenia
export function yearPerformanceReason(y, avgCPA, avgROAS, isEcom, benchLabel = '') {
    if (!y || !(y.cost > 0)) return null;

    if (y.conversions === 0) {
        if (avgCPA === null || !(avgCPA > 0)) return null;
        // Między 2× a 3× decyduje człowiek: przy niskim CPA taki koszt uzbiera się
        // w rok z samej wariancji, także na haśle z rdzenia oferty.
        const krotnosc = y.cost / avgCPA;
        if (krotnosc >= 3) return {
            kind: 'wydajnosc-rok', level: 'pewny',
            text: `Rok bez konwersji przy koszcie ${fmtMoney(y.cost)} — ponad 3× roczny koszt konwersji kampanii (${fmtMoney(avgCPA)})`
        };
        if (krotnosc >= 2) return {
            kind: 'wydajnosc-rok', level: 'sprawdz',
            text: `Rok bez konwersji przy koszcie ${fmtMoney(y.cost)} — ponad 2× roczny koszt konwersji kampanii (${fmtMoney(avgCPA)})`
        };
        return null;
    }

    if (isEcom) {
        if (avgROAS !== null && avgROAS > 0) {
            const roas = y.value / y.cost;
            if (roas < avgROAS * 0.5) return {
                kind: 'wydajnosc-rok', level: 'sprawdz',
                text: `ROAS roczny ${fmt(roas, 2)} przy koszcie ${fmtMoney(y.cost)} — poniżej 50% ${benchLabel || `śr. rocznego ROAS kampanii (${fmt(avgROAS, 2)})`}`
            };
        }
        return null;
    }

    if (avgCPA !== null && avgCPA > 0) {
        const cpa = y.cost / y.conversions;
        if (cpa > avgCPA * 2) return {
            kind: 'wydajnosc-rok', level: 'sprawdz',
            text: `Koszt konwersji w skali roku ${fmtMoney(cpa)} — ponad 2× roczny CPA kampanii (${fmtMoney(avgCPA)})`
        };
    }
    return null;
}

// Poziom pojedynczego sygnału.
//  - wydajność 30 dni → pewna dopiero, gdy potwierdza ją rok (rok kosztów bez konwersji);
//                       sama z siebie to 30 dni przy progu 5 kliknięć — za cienko.
//  - semantyka        → ZAWSZE do sprawdzenia: próg podobieństwa nie zna specyfiki tematu.
//  - ocena AI         → wg zadeklarowanej pewności; brak deklaracji = niepewna.
export function poziomSygnalu(reason, y) {
    if (reason.level) return reason.level;
    if (reason.kind === 'wydajnosc') return (y && y.cost > 0 && y.conversions === 0) ? 'pewny' : 'sprawdz';
    if (reason.kind === 'ai') return (reason.pewnosc !== null && reason.pewnosc >= AI_PEWNOSC_PROG) ? 'pewny' : 'sprawdz';
    return 'sprawdz';
}

// Hasło jest „pewne", gdy ma CHOĆ JEDEN pewny sygnał. Nie promujemy haseł przez
// sumowanie samych heurystyk — trzy niepewne sygnały to nadal niepewność.
//
// Hasło, które JEST słowem kluczowym kampanii, nigdy nie dostaje „pewnego" — schodzi
// do „do sprawdzenia". Nie dlatego, że sygnał się myli: rok bez konwersji przy 3×
// koszcie konwersji to realny sygnał także tutaj. Zmienia się koszt błędu. Wycięcie
// hasła z długiego ogona kosztuje kilka złotych, a wykluczenie własnego słowa
// kluczowego zabija je w koncie (negatyw ma pierwszeństwo) i wyłącza cały segment,
// który operator kupił świadomie. Taką decyzję podejmuje człowiek.
export const poziomHasla = (reasons, y, jestSlowemKluczowym = false) =>
    (!jestSlowemKluczowym && reasons.some(r => poziomSygnalu(r, y) === 'pewny')) ? 'pewny' : 'sprawdz';

// ============================================================
// DANE ROCZNE — obrona i klucz mapy
// ============================================================

// Klucz mapy rocznej to para (kampania, hasło): to samo zapytanie bywa obsługiwane
// przez kilka kampanii i rok jednej podszywałby się pod drugą.
export const yearKey = (campaign, term) => `${campaign}|||${String(term || '').toLowerCase()}`;
export const yearOf = (yearMap, row) => yearMap.get(yearKey(row.campaign, row.term)) || null;

// „Rok broni hasła" = wynik na poziomie celu kampanii. Świadomie TYLKO wynik —
// pojedyncza stara konwersja nie chroni hasła.
//   ecom    → ROAS roczny ≥ 75% benchmarku rocznego
//   leadgen → CPA roczny ≤ 1,5× rocznego CPA kampanii
export function isDefendedByYear(y, avg, isEcom) {
    if (!y || y.conversions <= 0 || avg === null || !(avg > 0)) return false;
    if (isEcom) {
        if (!(y.cost > 0)) return false;
        return (y.value / y.cost) >= avg * 0.75;
    }
    return (y.cost / y.conversions) <= avg * 1.5;
}

// ============================================================
// KANDYDACI
// ============================================================

export function buildCampExclusionCandidates(campTerms, adGroupKeywords, avg, aiNegatives, isEcom = false,
                                             minKlikniec = 0, avgCostPerConv = null, benchLabel = '') {
    const candidates = new Map();
    campTerms.forEach(t => {
        const reasons = computeExclusionReasons(t, adGroupKeywords, avg, aiNegatives, isEcom, { avgCostPerConv, benchLabel });
        if (!reasons.length || candidates.has(t.term)) return;
        // Próg kliknięć broni sygnałów WYDAJNOŚCIOWYCH: przy jednym kliknięciu nie da się
        // twierdzić, że hasło jest drogie. Ocena AI mówi o czymś zupełnie innym — czy hasło
        // w ogóle pasuje do oferty — a to nie zależy od wolumenu: „przebranie lwa" jest
        // spoza oferty przy jednym kliknięciu tak samo jak przy pięćdziesięciu.
        // Bez tego wyjątku kampania PMax wyrzucała 7 z 8 ocenionych haseł (realny przypadek),
        // czyli praca oceny szła do kosza, a hasła i tak wracały do oceny w następnej rundzie.
        if (t.clicks < minKlikniec && !reasons.some(r => r.kind === 'ai')) return;
        candidates.set(t.term, { term: t.term, row: t, reasons });
    });
    return [...candidates.values()].sort((a, b) => b.row.cost - a.row.cost);
}

// Dokłada sygnał roczny: wzbogaca istniejących kandydatów i tworzy nowych z haseł,
// które w 30 dniach nie przekroczyły progów, ale rok pokazuje przepalanie.
// Źródłem jest `skan` (top wg wyświetleń + top wg kosztu) — tylko dla nich mamy rok.
export function withYearSignal(candidates, skan, avgCPA, avgROAS, isEcom, yearMap, minKlikniec = 0, benchLabel = '') {
    const byTerm = new Map(candidates.map(c => [c.term, { ...c, reasons: [...c.reasons] }]));

    skan.filter(t => t.clicks >= minKlikniec).forEach(t => {
        const reason = yearPerformanceReason(yearOf(yearMap, t), avgCPA, avgROAS, isEcom, benchLabel);
        if (!reason) return;
        const existing = byTerm.get(t.term);
        if (existing) {
            if (!existing.reasons.some(r => r.kind === 'wydajnosc-rok')) existing.reasons.push(reason);
        } else {
            byTerm.set(t.term, { term: t.term, row: t, reasons: [reason] });
        }
    });

    return [...byTerm.values()].sort((a, b) => b.row.cost - a.row.cost);
}

// Trzy kubełki. „Bronione" nie trafiają do raportu jako tabela — wypadają z listy
// wykluczeń i zostaje po nich licznik w podsumowaniu.
export function splitCandidatesByYear(candidates, avgYear, isEcom, yearMap, campKeywords = []) {
    const pewne = [];
    const doSprawdzenia = [];
    const bronione = [];
    candidates.forEach(c => {
        const y = yearOf(yearMap, c.row);
        if (isDefendedByYear(y, avgYear, isEcom)) { bronione.push(c); return; }
        const jestSK = isSameAsKeyword(c.term, campKeywords);
        const kandydat = jestSK ? { ...c, jestSlowemKluczowym: true } : c;
        (poziomHasla(c.reasons, y, jestSK) === 'pewny' ? pewne : doSprawdzenia).push(kandydat);
    });
    return { pewne, doSprawdzenia, bronione };
}
