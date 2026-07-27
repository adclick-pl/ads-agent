/**
 * format.js — formatery liczb i dat (pl-PL) wspólne dla analizy i raportu.
 *
 * Waluta jest stanem modułu, nie parametrem każdej funkcji: skrypt jest
 * jednorazowym CLI dla JEDNEGO konta, więc waluta jest ustalona raz na starcie
 * (`setCurrency` z `customer.currency_code`), a przewlekanie jej przez kilkanaście
 * sygnatur tylko zaciemniałoby kod analizy.
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

// Kwota w walucie konta. `Intl` sam dobiera symbol i jego pozycję, więc konto
// w EUR/GBP nie dostanie doklejonego „zł".
export function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return '–';
    return n.toLocaleString('pl-PL', {
        style: 'currency', currency: CURRENCY,
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });
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
export function getDates() {
    const end = new Date();
    end.setDate(end.getDate() - 1);

    const days30Start = new Date(end);
    days30Start.setDate(days30Start.getDate() - 29);

    const days365Start = new Date(end);
    days365Start.setDate(days365Start.getDate() - 364);

    return {
        days30: { start: formatDate(days30Start), end: formatDate(end) },
        days365: { start: formatDate(days365Start), end: formatDate(end) }
    };
}
