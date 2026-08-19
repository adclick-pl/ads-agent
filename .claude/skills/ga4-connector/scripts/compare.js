/**
 * Porównanie dwóch okresów ("przed vs po") — czysta logika, bez wywołań API,
 * żeby dało się ją testować offline.
 *
 * Dlaczego to siedzi w konektorze, a nie w skrypcie analizy: przy każdej
 * migracji, awarii pomiaru czy podejrzeniu anomalii pierwsze pytanie brzmi
 * "jak było przedtem". Liczenie tego ręcznie za każdym razem kończy się dwoma
 * błędami, które nic nie sygnalizuje:
 *
 *  1. Uśrednianie wskaźników. `bounceRate` czy `engagementRate` zsumowane po
 *     dniach i podzielone przez liczbę dni daje średnią NIEWAŻONĄ — cicho zły
 *     wynik. Tu w ogóle nie agregujemy lokalnie: każde okno liczy GA4, więc
 *     wskaźniki przychodzą już poprawnie zważone.
 *  2. Okna różnej długości. 20 dni vs 14 dni porównane "sumami" zaniża drugi
 *     okres o 30%. Gdy długości się różnią, zmiany liczymy NA DZIEŃ — ale
 *     tylko dla metryk addytywnych, bo dzielenie wskaźnika przez dni nie ma
 *     sensu.
 */

/** Metryki, których NIE wolno dzielić przez liczbę dni (to już są wskaźniki). */
const RATIO_METRIC = /(rate|percentage)$|^average|peruser$|persession$|perminute$|^bounce|^engagementrate/i;

/**
 * @param {string} name - nazwa metryki GA4
 * @returns {boolean} czy metryka jest wskaźnikiem (nie sumuje się po dniach)
 */
export function isRatioMetric(name) {
  return RATIO_METRIC.test(String(name || ''));
}

/** Wymiary czasu — z nimi porównanie okresów nie ma sensu (patrz assert niżej). */
const TIME_DIMENSION = /^(date|dateHour|dateHourMinute|year|yearMonth|yearWeek|month|week|day|hour|minute|nthDay|nthWeek|nthMonth|nthYear)$/i;

/**
 * Wymiar czasu w zestawieniu dwóch okresów daje wiersze, których nie da się
 * sparować (20-06 nie ma odpowiednika w drugim oknie). Lepiej odmówić z
 * wyjaśnieniem niż zwrócić tabelę pełną "n/d".
 * @param {Array<string>} dimensions
 */
export function assertNoTimeDimension(dimensions) {
  const hit = (dimensions || []).find((d) => TIME_DIMENSION.test(d));
  if (hit) {
    throw new Error(
      `--compare nie działa z wymiarem czasu ("${hit}"). Porównanie zestawia dwa OKRESY, ` +
        `więc wiersze muszą być po czymś innym (np. --dimensions=landingPage). ` +
        `Usuń "${hit}" z --dimensions.`
    );
  }
}

/**
 * Zakres porównawczy z zapisu `YYYY-MM-DD:YYYY-MM-DD`.
 * @param {string} spec
 * @returns {{startDate: string, endDate: string}}
 */
export function parseCompareRange(spec) {
  const raw = String(spec || '').trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s*[:.]{1,2}\s*(\d{4}-\d{2}-\d{2})$/);
  if (!m) {
    throw new Error(`Niepoprawny --compare: "${raw}". Oczekiwany format: --compare=2026-06-20:2026-07-09`);
  }
  const [, startDate, endDate] = m;
  if (startDate > endDate) {
    throw new Error(`Niepoprawny --compare: początek (${startDate}) jest po końcu (${endDate}).`);
  }
  return { startDate, endDate };
}

/**
 * Liczba dni w zakresie, włącznie z oboma końcami.
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {number}
 */
export function daysInRange(startDate, endDate) {
  const a = Date.parse(`${startDate}T00:00:00Z`);
  const b = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * Zestawia wiersze dwóch okresów po wartościach wymiarów.
 *
 * @param {object} p
 * @param {Array<object>} p.baseRows - wiersze okresu badanego
 * @param {Array<object>} p.refRows - wiersze okresu odniesienia (--compare)
 * @param {Array<string>} p.dimensions
 * @param {Array<string>} p.metrics
 * @param {number} p.baseDays
 * @param {number} p.refDays
 * @returns {{rows: Array<object>, perDay: boolean}} perDay = czy zmiany liczone na dzień
 */
export function mergeCompare({ baseRows, refRows, dimensions, metrics, baseDays, refDays }) {
  const dims = dimensions || [];
  const mets = metrics || [];
  // Okna równej długości → porównujemy sumy (czytelniej). Różnej → na dzień,
  // inaczej krótsze okno zawsze "wypada gorzej".
  const perDay = baseDays > 0 && refDays > 0 && baseDays !== refDays;

  const keyOf = (r) => dims.map((d) => String(r[d] ?? '')).join('␟');
  const refByKey = new Map((refRows || []).map((r) => [keyOf(r), r]));
  const seen = new Set();
  const out = [];

  const scale = (metric, value, days) => {
    const v = Number(value || 0);
    if (!perDay || isRatioMetric(metric)) return v;
    return days > 0 ? v / days : 0;
  };

  const build = (baseRow, refRow) => {
    const row = {};
    for (const d of dims) row[d] = (baseRow ?? refRow)[d] ?? '';
    for (const m of mets) {
      const b = baseRow ? scale(m, baseRow[m], baseDays) : 0;
      const r = refRow ? scale(m, refRow[m], refDays) : 0;
      const round = (x) => (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100);
      row[m] = round(b);
      row[`${m}_ref`] = round(r);
      row[`${m}_Δ%`] = r ? Math.round(((b - r) / r) * 1000) / 10 : (b ? null : 0);
    }
    return row;
  };

  for (const br of baseRows || []) {
    const k = keyOf(br);
    seen.add(k);
    out.push(build(br, refByKey.get(k)));
  }
  // Wiersze, które istniały TYLKO w okresie odniesienia — to często najciekawsze
  // (strona, która zniknęła po migracji), więc nie wolno ich pominąć.
  for (const rr of refRows || []) {
    const k = keyOf(rr);
    if (!seen.has(k)) out.push(build(null, rr));
  }

  const sortKey = mets[0];
  if (sortKey) out.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
  return { rows: out, perDay };
}
