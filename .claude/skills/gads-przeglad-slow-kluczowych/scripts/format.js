/**
 * format.js — formatery liczb, dat i etykiet (pl-PL).
 *
 * Waluta jest stanem modułu, nie parametrem każdej funkcji: skrypt jest jednorazowym CLI
 * dla JEDNEGO konta, więc waluta jest ustalona raz na starcie (`setCurrency`
 * z `customer.currency_code`), a przewlekanie jej przez kilkanaście sygnatur tylko
 * zaciemniałoby kod analizy.
 */

let CURRENCY = 'PLN';

export function setCurrency(code) {
    if (code && typeof code === 'string') CURRENCY = code.toUpperCase();
}

export const getCurrency = () => CURRENCY;

export function fmt(n, dec = 0) {
    if (n === null || n === undefined || isNaN(n)) return '–';
    return n.toLocaleString('pl-PL', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// Kwota w walucie konta. `Intl` sam dobiera symbol i jego pozycję, więc konto w EUR/GBP
// nie dostanie doklejonego „zł".
export function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return '–';
    return n.toLocaleString('pl-PL', {
        style: 'currency', currency: CURRENCY,
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });
}

export function pct(x, dec = 0) {
    if (x === null || x === undefined || isNaN(x)) return '–';
    return fmt(x * 100, dec) + '%';
}

export const PL_MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

// Lokalne części daty — `toISOString()` potrafi przesunąć dzień przez UTC.
export function formatDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtPeriod(start, end) {
    const s = new Date(start + 'T12:00:00');
    const e = new Date(end + 'T12:00:00');
    return `${s.getDate()} ${PL_MONTHS[s.getMonth()]} ${s.getFullYear()} – ${e.getDate()} ${PL_MONTHS[e.getMonth()]} ${e.getFullYear()}`;
}

// Okna czasowe raportu: 30 dni (ocena) + 365 dni (kontekst historyczny), oba do wczoraj.
// Wczoraj, nie dziś — dzisiejszy dzień jest niepełny i zaniżałby każdą metrykę.
//
// Data „wczoraj" liczona jest w STREFIE CZASOWEJ KONTA, nie maszyny operatora — to
// dokładnie ten sam moment, który Google Ads pokazuje w interfejsie. Bez tego konto
// w innej strefie niż operator dostaje w raporcie inną datę końcową niż w GA
// (widoczne szczególnie koło północy). `timezone` w formacie IANA (np. `Europe/Warsaw`);
// gdy pominięte, spadamy do strefy lokalnej.
export function getDates(timezone) {
    // Wczoraj w strefie konta — parsujemy YYYY-MM-DD wypluty przez formatInTimeZone
    // i cofamy w UTC, żeby arytmetyka dat była niezależna od DST.
    const todayInAcct = formatInAcctTz(new Date(), timezone);
    const [y, m, d] = todayInAcct.split('-').map(Number);
    const anchor = new Date(Date.UTC(y, m - 1, d));

    const end = new Date(anchor);
    end.setUTCDate(end.getUTCDate() - 1);

    const days30Start = new Date(end);
    days30Start.setUTCDate(days30Start.getUTCDate() - 29);

    const days365Start = new Date(end);
    days365Start.setUTCDate(days365Start.getUTCDate() - 364);

    const iso = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;

    return {
        days30: { start: iso(days30Start), end: iso(end) },
        days365: { start: iso(days365Start), end: iso(end) }
    };
}

// Wewnętrzne: YYYY-MM-DD dla „teraz" w podanej strefie IANA. Bez zależności — Intl
// wystarczy, a niewłaściwa strefa (literówka) automatycznie spada do lokalnej.
function formatInAcctTz(date, timezone) {
    if (!timezone) return formatDate(date);
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(date);
    } catch { return formatDate(date); }
}

// Numeryczne enumy advertising_channel_type → czytelna nazwa typu kampanii.
// UWAGA: 10 to PMax, a NIE DemGen (14) — częsty błąd.
export const CHANNEL_MAP = {
    2: 'Search', 3: 'Display', 4: 'Shopping', 5: 'Hotel', 6: 'Video',
    7: 'Multi-channel', 8: 'Local', 9: 'Smart', 10: 'PMax',
    11: 'Local Services', 13: 'Travel', 14: 'DemGen'
};
