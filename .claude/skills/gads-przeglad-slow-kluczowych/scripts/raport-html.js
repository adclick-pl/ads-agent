/**
 * raport-html.js — pełny raport HTML: motyw dark/light, CSS, rendery paneli.
 *
 * Skrypt jest liczbowy (bez LLM), więc raport też jest liczbowy — bez wykresów, bez
 * Chart.js. Motyw dark/light zachowany, żeby pracowało się przy nim wygodnie.
 */

import { fmt, fmtMoney, pct, fmtPeriod } from './format.js';
import {
    MAX_ROWS, KONTO, grupujPoKampanii, emptyMetrics,
} from './analiza.js';

// ============================================================
// CSS + MOTYW
// ============================================================

// Poziomy tła są dobierane krokiem jasności percepcyjnej L*, nie „na oko" ani przez
// kontrast WCAG — przy ciemnych tłach stała +0,05 we wzorze na kontrast zjada różnicę
// i każdy odcień wychodzi ~1,1:1, mimo że oko widzi je jako różne. Cel: Δ ≈ 5 L*
// między sąsiednimi poziomami (bg → karta → nagłówek tabeli → sekcja → obramowanie).
const PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root, [data-theme="light"] {
    --bg: #f0f2f5;
    --surface: #ffffff;
    --surface2: #f8faff;
    --border: #e8edf5;
    --border2: #f0f2f5;
    --text: #1a1a1a;
    --text2: #6b7280;
    --text3: #8a919e;
    --header-bg: #1a1a2e;
    --header-sub: #94a3b8;
    --hover: #fafbff;
    --th-bg: #f8faff;
    --th-bg2: #eef2fa;
    --kpi-bg: #f8faff;
    --shadow: 0 1px 4px rgba(0,0,0,0.08);
    --toggle-bg: #e2e8f0;
    --toggle-text: #374151;
    /* Nakładka podświetlenia — zastępuje filter: brightness(), który działał tylko
       w jedną stronę: 0.97 przyciemniało wiersz w OBU motywach, więc w ciemnym
       podświetlenie gasło zamiast rozjaśniać. */
    --overlay: rgba(0,0,0,0.035);
  }

  [data-theme="dark"] {
    --bg: #0b0e15;
    --surface: #161a24;
    --surface2: #232838;
    --border: #39405a;
    --border2: #2a3044;
    --text: #e2e8f0;
    --text2: #94a3b8;
    --text3: #8b97ab;
    --header-bg: #272f45;
    --header-sub: #a3b1c9;
    --hover: #212736;
    --th-bg: #1e2330;
    --th-bg2: #2b3141;
    --kpi-bg: #1e2330;
    --shadow: 0 1px 4px rgba(0,0,0,0.4);
    --toggle-bg: #2d3148;
    --toggle-text: #94a3b8;
    --overlay: rgba(255,255,255,0.055);
  }

  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); padding: 24px; font-size: 14px; transition: background 0.2s, color 0.2s; }
  .header { background: var(--header-bg); color: white; border-radius: 12px; padding: 24px 28px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
  .header-left h1 { font-size: 1.4em; font-weight: 600; }
  .header-left .subtitle { color: var(--header-sub); margin-top: 4px; font-size: 0.9em; }
  .header-right { text-align: right; color: var(--header-sub); font-size: 0.85em; line-height: 1.6; }
  .badge { display: inline-block; background: #4285f4; color: white; border-radius: 6px; padding: 2px 8px; font-size: 0.75em; font-weight: 600; margin-left: 8px; }

  .theme-toggle { background: var(--toggle-bg); color: var(--toggle-text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; font-size: 0.8em; cursor: pointer; font-family: inherit; transition: all 0.15s; display: flex; align-items: center; gap: 6px; }
  .theme-toggle:hover { opacity: 0.8; }

  .section { background: var(--surface); border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; box-shadow: var(--shadow); border: 1px solid var(--border); }
  .kpi-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
  .kpi { background: var(--kpi-bg); border-radius: 10px; padding: 14px 16px; border: 1px solid var(--border); }
  .kpi-label { font-size: 0.75em; color: var(--text2); font-weight: 500; margin-bottom: 6px; }
  .kpi-value { font-size: 1.5em; font-weight: 700; color: var(--text); line-height: 1.1; }
  .kpi-prev { color: var(--text3); font-size: 0.75em; margin-top: 2px; }
  .up { color: #22c55e; font-weight: 600; }
  .down { color: #f87171; font-weight: 600; }
  .neutral { color: var(--text2); }
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  th { padding: 8px 10px; text-align: left; background: var(--th-bg); font-weight: 600; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text2); border-bottom: 2px solid var(--border); }
  td { padding: 10px 10px; border-bottom: 1px solid var(--border2); vertical-align: middle; color: var(--text); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--hover); }
  .right { text-align: right; }
  .center { text-align: center; }
  .footer { text-align: center; color: var(--text3); font-size: 0.78em; margin-top: 20px; }

  .st-table-wrap { overflow-x: auto; margin-bottom: 16px; border: 1px solid var(--border); border-radius: 8px; }
  .st-table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  .st-table th { background: var(--th-bg); padding: 7px 8px; font-size: 0.75em; }
  .st-table td { padding: 7px 8px; border-bottom: 1px solid var(--border2); }
  .st-table tr:last-child td { border-bottom: none; }
  .st-table tr:hover td { box-shadow: inset 0 0 0 9999px var(--overlay); }
  .term-col { max-width: 260px; word-break: break-word; }

  /* Kampania jako <details>: kliknięcie w nagłówek zwija/rozwija panele. */
  .camp-section { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 16px; overflow: hidden; background: var(--surface); }
  .camp-header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; background: var(--surface2); cursor: pointer; user-select: none; list-style: none; }
  .camp-header::-webkit-details-marker { display: none; }
  .camp-header:hover { box-shadow: inset 0 0 0 9999px var(--overlay); }
  .camp-header::before { content: '▸'; color: var(--text3); font-size: 0.9em; transition: transform 0.15s; }
  .camp-section[open] > .camp-header { border-bottom: 1px solid var(--border); }
  .camp-section[open] > .camp-header::before { transform: rotate(90deg); }
  .camp-name { font-weight: 600; font-size: 0.95em; }
  .camp-meta { font-size: 0.8em; color: var(--text2); }
  .panels-wrap { padding: 16px 18px; display: flex; flex-direction: column; gap: 16px; }

  .part-title { font-size: 0.78em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text2); margin: 24px 0 10px 4px; }
  /* Nawigacja — zwykły element na górze dokumentu, ODJEŻDŻA przy scrollowaniu. */
  .nav-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
             background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 16px; margin-bottom: 4px; box-shadow: var(--shadow); }
  .nav-bar a { font-size: 0.82em; color: var(--text2); text-decoration: none; padding: 3px 8px; border-radius: 6px; white-space: nowrap; }
  .nav-bar a:hover { background: var(--hover); color: var(--text); }
  .nav-bar a b { color: var(--text); font-weight: 700; margin-left: 3px; }
  .nav-sep { color: var(--border); }

  /* Nagłówek sekcji (Pewne / Do sprawdzenia) — NADRZĘDNY wobec nagłówka kampanii w środku. */
  .panel-label { font-size: 1.05em; color: var(--text); padding: 22px 0 10px; letter-spacing: 0.08em; font-weight: 700; text-transform: uppercase; }
  .panel-intro + .panel-label, .panel-note + .panel-label { padding-top: 6px; }
  .panel-intro { font-size: 0.85em; color: var(--text2); line-height: 1.55; margin-bottom: 12px; }
  .panel-label.label-red { color: #dc2626; }
  .panel-label.label-green { color: #16a34a; }
  [data-theme="dark"] .panel-label.label-red { color: #f87171; }
  [data-theme="dark"] .panel-label.label-green { color: #4ade80; }

  .licznik { font-weight: 600; color: var(--text3); }
  .licznik-kamp { font-weight: 400; color: var(--text3); text-transform: none; letter-spacing: 0; }
  .camp-group { margin-bottom: 16px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .camp-group-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; padding: 9px 14px; background: var(--surface2); border-bottom: 1px solid var(--border); }
  .camp-group-name { font-weight: 600; font-size: 0.9em; }
  .camp-group-meta { font-size: 0.8em; color: var(--text2); }
  .camp-group .st-table-wrap { margin-bottom: 0; border: none; border-radius: 0; }
  .mt-tag { font-size: 0.72em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; padding: 1px 6px; border-radius: 4px; background: var(--border); color: var(--text2); }
  .tag-brand { background: rgba(66,133,244,0.18); color: #4285f4; }
  .kw-path { font-size: 0.78em; color: var(--text3); margin-top: 3px; }
  .period-head { background: var(--th-bg2); font-size: 0.72em; letter-spacing: 0.06em; }
  .yr-col { background: var(--surface2); }
  th.yr-col { background: var(--th-bg2); }
  .reason-col { max-width: 420px; }
  .reason-tag { display: inline-block; font-size: 0.78em; background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; padding: 2px 7px; margin: 2px 3px 2px 0; color: var(--text2); line-height: 1.5; }
  .reason-tag.reason-red { border-color: rgba(239,68,68,0.4); color: #dc2626; }
  .reason-tag.reason-ok { border-color: rgba(34,197,94,0.4); color: #16a34a; }
  [data-theme="dark"] .reason-tag.reason-red { color: #f87171; }
  [data-theme="dark"] .reason-tag.reason-ok { color: #4ade80; }

  /* Kolor wyniku względem poprzeczki kampanii: ≥cel / 50-100% / <50%. */
  .cel-ok  { background: rgba(34,197,94,0.13);  color: #16a34a; font-weight: 600; }
  .cel-mid { background: rgba(234,179,8,0.13);  color: #a16207; font-weight: 600; }
  .cel-bad { background: rgba(239,68,68,0.13);  color: #dc2626; font-weight: 600; }
  [data-theme="dark"] .cel-ok  { color: #4ade80; }
  [data-theme="dark"] .cel-mid { color: #fbbf24; }
  [data-theme="dark"] .cel-bad { color: #f87171; }

  /* Pasek skali przy koszcie — priorytet widać bez czytania kwot. */
  .nowrap { white-space: nowrap; }
  .skala { display: inline-block; width: 34px; height: 5px; background: var(--border2); border-radius: 3px; vertical-align: middle; margin-right: 6px; overflow: hidden; }
  .skala > i { display: block; height: 5px; background: var(--text3); border-radius: 3px; }

  .row-total td { border-top: 2px solid var(--border); background: var(--surface2); font-weight: 600; }
  .row-total td:first-child { font-weight: 700; }
  .excl-empty, .pusty { color: var(--text3); font-size: 0.85em; padding: 12px 0; }
  .limit-note { font-size: 0.8em; color: var(--text3); margin: 6px 0 12px; }
`;

function themeToggleScript(storageKey = 'przeglad-slow-kluczowych-theme') {
    return `
<script>
function toggleTheme() {
  const html = document.documentElement;
  const dark = html.getAttribute('data-theme') !== 'dark';
  html.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.getElementById('themeBtn').textContent = dark ? '☀️ Light mode' : '🌙 Dark mode';
  localStorage.setItem('${storageKey}', dark ? 'dark' : 'light');
}

(function() {
  const saved = localStorage.getItem('${storageKey}') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeBtn').textContent = saved === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
})();
</script>`;
}

// ============================================================
// HELPERY PREZENTACYJNE
// ============================================================

export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Kampania brandowa rozpoznawana po nazwie.
export function isBrand(campaign) {
    return /brand/i.test(campaign);
}

function odmien(n, poj, mnogi, dopelniacz) {
    const setki = n % 100;
    if (n === 1) return poj;
    if (setki >= 12 && setki <= 14) return dopelniacz;
    return (n % 10 >= 2 && n % 10 <= 4) ? mnogi : dopelniacz;
}

function skalaBar(v, max) {
    if (!max || max <= 0) return '';
    return `<span class="skala"><i style="width:${Math.min(100, v / max * 100).toFixed(1)}%"></i></span>`;
}

function limitInfo(lista, sortLabel) {
    if (lista.length <= MAX_ROWS) return '';
    return `<div class="limit-note">Pokazano ${MAX_ROWS} z ${fmt(lista.length)} — pominięte mają niższy ${sortLabel}.</div>`;
}

function pusty(tekst) {
    return `<div class="excl-empty">${tekst}</div>`;
}

function intro(tekst) {
    return `<div class="panel-intro">${tekst}</div>`;
}

function kwCell(kw) {
    return `<td class="term-col"><strong>${esc(kw.text)}</strong> <span class="mt-tag">${kw.matchType}</span>`
        + `${isBrand(kw.campaign) ? ' <span class="mt-tag tag-brand">brand</span>' : ''}`
        + `${kw.status === 'PAUSED' ? ' <span class="mt-tag">⏸</span>' : ''}`
        + `<div class="kw-path">${esc(kw.campaign)} › ${esc(kw.adGroup)}</div></td>`;
}

// Kolor komórki wyniku względem poprzeczki TEJ kampanii. Bez tego ROAS 1,50 i ROAS 9,99
// wyglądają w tabeli identycznie, choć pierwszy to 19% celu, a drugi 125%.
function celKlasa(m, bench, isEcom) {
    if (!bench) return '';
    if (isEcom) {
        if (!bench.roas || m.cost <= 0) return '';
        const r = (m.value / m.cost) / bench.roas;
        return r >= 1 ? 'cel-ok' : (r >= 0.5 ? 'cel-mid' : 'cel-bad');
    }
    if (!bench.cpa) return '';
    if (m.conv <= 0) return m.cost > 0 ? 'cel-bad' : '';
    const r = bench.cpa / (m.cost / m.conv);
    return r >= 1 ? 'cel-ok' : (r >= 0.5 ? 'cel-mid' : 'cel-bad');
}

// Wspólny zestaw kolumn wynikowych — ta sama kolejność we wszystkich tabelach raportu.
function metricCells(m, isEcom, opts = {}) {
    const { bench = null, kosztMax = 0 } = opts;
    const ctr = m.imp > 0 ? m.clicks / m.imp : null;
    const cpa = m.conv > 0 ? m.cost / m.conv : null;
    const roas = m.cost > 0 ? m.value / m.cost : null;
    const cel = celKlasa(m, bench, isEcom);
    return `<td class="right">${fmt(m.imp)}</td>`
        + `<td class="right">${fmt(m.clicks)}</td>`
        + `<td class="right nowrap">${skalaBar(m.cost, kosztMax)}${fmtMoney(m.cost)}</td>`
        + `<td class="right">${ctr === null ? '–' : pct(ctr, 1)}</td>`
        + `<td class="right">${fmt(m.conv, 1)}</td>`
        + (isEcom
            ? `<td class="right">${fmtMoney(m.value)}</td><td class="right ${cel}">${roas === null ? '–' : fmt(roas, 2)}</td>`
            : `<td class="right ${cel}">${cpa === null ? '–' : fmtMoney(cpa)}</td>`);
}

function metricHeaders(isEcom, prefix = '') {
    return `<th class="right">${prefix}Wyśw.</th><th class="right">${prefix}Kliknięcia</th>`
        + `<th class="right">${prefix}Koszt</th><th class="right">${prefix}CTR</th><th class="right">${prefix}Konw.</th>`
        + (isEcom ? `<th class="right">${prefix}Wart. konw.</th><th class="right">${prefix}ROAS</th>`
            : `<th class="right">${prefix}Koszt konw.</th>`);
}

function panel(id, tytul, podtytul, tresc, otwarty = false) {
    return `<details class="camp-section"${otwarty ? ' open' : ''} id="${id}">
  <summary class="camp-header">
    <span class="camp-name">${tytul}</span>
    <span class="camp-meta">${podtytul}</span>
  </summary>
  <div class="panels-wrap">${tresc}</div>
</details>`;
}

// ============================================================
// PANELE
// ============================================================

function kpiBox(label, value, sub) {
    return `<div class="kpi"><div class="kpi-label">${label}</div>`
        + `<div class="kpi-value">${value}</div>${sub ? `<div class="kpi-prev">${sub}</div>` : ''}</div>`;
}

// Kafelek celu i kafelek wyniku rocznego stoją obok siebie, bo dopiero razem coś znaczą:
// cel bez wyniku to deklaracja, wynik bez celu to liczba bez oceny.
function kpiCel(cele, isEcom) {
    const cel = isEcom ? cele?.roas : cele?.cpa;
    return kpiBox(
        isEcom ? 'Cel ROAS' : 'Cel koszt konw.',
        cel ? (isEcom ? fmt(cel, 2) : fmtMoney(cel)) : 'nie ustawiony',
        cel ? 'z config.json klienta' : 'brak w config — poprzeczką są średnie roczne',
    );
}

// Wynik ROCZNY, liczony ZE SŁÓW KLUCZOWYCH — dokładnie ta liczba, która staje się
// poprzeczką, gdy klient nie ma celu w configu. Konto potrafi mieć wielokrotnie więcej
// konwersji (PMax, DSA), więc podtytuł podaje wolumen, z którego średnia jest policzona.
function kpiRok(avgRok, isEcom) {
    const rok = avgRok?.[KONTO] || emptyMetrics();
    const wynik = isEcom
        ? (rok.roas ? fmt(rok.roas, 2) : '–')
        : (rok.cpa ? fmtMoney(rok.cpa) : '–');
    return kpiBox(
        isEcom ? 'ROAS — rok (słowa kluczowe)' : 'Koszt konw. — rok (słowa kluczowe)',
        wynik,
        `${fmt(rok.conv, 1)} konw. · ${fmtMoney(rok.cost)} kosztu`,
    );
}

function renderSummary(model, isEcom, cele) {
    const { keywords, avgRok } = model;
    const aktywne = keywords.filter(kw => kw.aktywne);
    const total = aktywne.reduce((s, kw) => ({
        imp: s.imp + kw.d30.imp, clicks: s.clicks + kw.d30.clicks, cost: s.cost + kw.d30.cost,
        conv: s.conv + kw.d30.conv, value: s.value + kw.d30.value,
    }), emptyMetrics());

    const kosztBezKonw = aktywne.filter(kw => kw.d30.conv === 0).reduce((s, kw) => s + kw.d30.cost, 0);

    const kpis = `<div class="kpi-grid">
${kpiBox('Aktywne słowa kluczowe', fmt(aktywne.length), `${fmt(keywords.length - aktywne.length)} wstrzymanych`)}
${kpiBox('Koszt 30 dni', fmtMoney(total.cost), `${fmt(total.clicks)} kliknięć`)}
${kpiBox(isEcom ? 'Wartość konw. 30 dni' : 'Konwersje 30 dni', isEcom ? fmtMoney(total.value) : fmt(total.conv, 1),
        isEcom ? `ROAS ${total.cost > 0 ? fmt(total.value / total.cost, 2) : '–'}` : `Koszt konw. ${total.conv > 0 ? fmtMoney(total.cost / total.conv) : '–'}`)}
${kpiBox('Koszt bez konwersji (30 dni)', fmtMoney(kosztBezKonw), `${pct(total.cost > 0 ? kosztBezKonw / total.cost : 0)} wydatku`)}
${kpiCel(cele, isEcom)}
${kpiRok(avgRok, isEcom)}
</div>`;

    // Rozkład typów dopasowania — BEZ KAMPANII BRANDOWYCH. Brand siedzi prawie w całości
    // w dopasowaniu ścisłym i ma nieporównywalnie wysoki wynik, więc wciągnięty do tej
    // tabeli zawyżał ścisłe i psuł jedyne pytanie, na które ona odpowiada: czy szersze
    // dopasowania zarabiają na siebie na ruchu niebrandowym.
    const nieBrand = aktywne.filter(kw => !isBrand(kw.campaign));
    const brandKw = aktywne.length - nieBrand.length;
    const totalNieBrand = nieBrand.reduce((s, kw) => ({
        imp: s.imp + kw.d30.imp, clicks: s.clicks + kw.d30.clicks, cost: s.cost + kw.d30.cost,
        conv: s.conv + kw.d30.conv, value: s.value + kw.d30.value,
    }), emptyMetrics());

    const wgTypu = {};
    nieBrand.forEach(kw => {
        const t = wgTypu[kw.matchType] || (wgTypu[kw.matchType] = { n: 0, ...emptyMetrics() });
        t.n++; t.imp += kw.d30.imp; t.clicks += kw.d30.clicks; t.cost += kw.d30.cost;
        t.conv += kw.d30.conv; t.value += kw.d30.value;
    });
    const wiersze = Object.entries(wgTypu).sort((a, b) => b[1].cost - a[1].cost).map(([typ, t]) => `<tr>
  <td><strong>${typ}</strong></td>
  <td class="right">${fmt(t.n)}</td>
  <td class="right nowrap">${skalaBar(t.cost, totalNieBrand.cost)}${pct(totalNieBrand.cost > 0 ? t.cost / totalNieBrand.cost : 0)}</td>
  ${metricCells(t, isEcom)}
</tr>`).join('');

    const tabela = `<div class="panel-label">Rozkład typów dopasowania (30 dni) <span class="licznik-kamp">bez kampanii brandowych</span></div>
${brandKw ? '' : intro('Nie wykryto kampanii brandowych (po słowie „brand" w nazwie) — tabela obejmuje całe konto.')}
<div class="st-table-wrap"><table class="st-table">
<thead><tr><th>Typ dopasowania</th><th class="right">Słów</th><th class="right">Udział kosztu</th>${metricHeaders(isEcom)}</tr></thead>
<tbody>${wiersze}</tbody>
<tfoot><tr class="row-total">
  <td><strong>Razem bez brandu</strong></td>
  <td class="right">${fmt(nieBrand.length)}</td>
  <td class="right">100%</td>
  ${metricCells(totalNieBrand, isEcom)}
</tr></tfoot>
</table></div>`;

    return kpis + tabela;
}

function renderCore(keywords, isEcom) {
    // Tylko słowa AKTYWNE (ENABLED na 3 poziomach) i bez brandu. Brand zawsze wygrywa
    // ranking wyniku — wypełniłby listę i przykrył to, które słowa realnie POZYSKUJĄ
    // nowych klientów. Filtr `aktywne` chroni przed pokazaniem top-performera z kampanii
    // wstrzymanej, którego dziś ani grosza nie zarabia.
    const nieBrand = keywords.filter(kw => kw.aktywne && !isBrand(kw.campaign));
    const top = nieBrand
        .filter(kw => kw.d30.conv > 0)
        .sort((a, b) => (isEcom ? b.d30.value - a.d30.value : b.d30.conv - a.d30.conv))
        .slice(0, 10);
    if (!top.length) return pusty('Żadne niebrandowe słowo kluczowe nie zanotowało konwersji w ostatnich 30 dniach.');
    const wiersze = top.map(kw => `<tr>${kwCell(kw)}${metricCells(kw.d30, isEcom)}${metricCells(kw.rok, isEcom)}</tr>`).join('');
    return `<div class="st-table-wrap"><table class="st-table">
<thead>
<tr><th></th><th class="right period-head" colspan="${isEcom ? 7 : 6}">OSTATNIE 30 DNI</th><th class="right period-head yr-col" colspan="${isEcom ? 7 : 6}">OSTATNI ROK</th></tr>
<tr><th>Słowo kluczowe</th>${metricHeaders(isEcom)}${metricHeaders(isEcom)}</tr>
</thead>
<tbody>${wiersze}</tbody></table></div>`;
}

function renderPause(pause, isEcom) {
    // Kolumna wyniku kolorowana poprzeczką kampanii, koszt roczny dostaje pasek skali
    // względem najdroższego słowa na liście — priorytet widać bez czytania kwot.
    const wiersz = (bench, kosztMax) => ({ kw, sygnaly, powod }) => {
        const uwagi = powod
            ? `<span class="reason-tag reason-ok">${powod}</span>`
            : sygnaly.map(s => `<span class="reason-tag ${s.poziom === 'pewny' ? 'reason-red' : ''}">${s.opis}</span>`).join(' ');
        return `<tr>${kwCell(kw)}${metricCells(kw.d30, isEcom, { bench })}${metricCells(kw.rok, isEcom, { bench, kosztMax })}<td class="reason-col">${uwagi}</td></tr>`;
    };

    const tabelaHtml = (wpisy, bench, kosztMax) => `<div class="st-table-wrap"><table class="st-table">
<thead>
<tr><th></th><th class="right period-head" colspan="${isEcom ? 7 : 6}">OSTATNIE 30 DNI</th><th class="right period-head yr-col" colspan="${isEcom ? 7 : 6}">OSTATNI ROK</th><th></th></tr>
<tr><th>Słowo kluczowe</th>${metricHeaders(isEcom)}${metricHeaders(isEcom)}<th>Uwagi</th></tr>
</thead>
<tbody>${wpisy.slice(0, MAX_ROWS).map(wiersz(bench, kosztMax)).join('')}</tbody></table></div>${limitInfo(wpisy, 'koszt roczny')}`;

    // Poprzeczka jest liczona per kampania, więc nagłówek sekcji ją pokazuje.
    const poprzeczka = (bench) => {
        if (isEcom && bench?.roas) return `poprzeczka ROAS ${fmt(bench.roas, 2)} (${bench.zrodlo})`;
        if (!isEcom && bench?.cpa) return `poprzeczka koszt konw. ${fmtMoney(bench.cpa)} (${bench.zrodlo})`;
        return 'brak poprzeczki — za mało danych';
    };

    const sekcja = (lista, naglowek, opis, klasa) => {
        if (!lista.length) return `<div class="panel-label ${klasa}">${naglowek}</div>${pusty('Brak.')}`;
        const grupy = grupujPoKampanii(lista);
        // Skala paska liczona z CAŁEJ sekcji, nie z pojedynczej kampanii — inaczej
        // najdroższe słowo w drobnej kampanii miałoby pasek tak samo długi jak
        // najdroższe słowo w kampanii kilkanaście razy większej.
        const kosztMax = Math.max(...lista.map(w => w.kw.rok.cost), 0);
        const bloki = grupy.map(g => `<div class="camp-group">
  <div class="camp-group-head">
    <span class="camp-group-name">${esc(g.campaign)}</span>
    <span class="camp-group-meta">${poprzeczka(g.bench)}</span>
  </div>
  ${tabelaHtml(g.wpisy, g.bench, kosztMax)}
</div>`).join('');
        return `<div class="panel-label ${klasa}">${naglowek} <span class="licznik">${fmt(lista.length)}</span>`
            + ` <span class="licznik-kamp">w ${fmt(grupy.length)} ${odmien(grupy.length, 'kampanii', 'kampaniach', 'kampaniach')}</span></div>
${opis ? intro(opis) : ''}${bloki}`;
    };

    return `${sekcja(pause.pewne, 'Pewne — do wstrzymania', '', 'label-red')}
${sekcja(pause.sprawdz, 'Do sprawdzenia', '', '')}
`;
}

// ============================================================
// SKŁADANIE PEŁNEGO DOKUMENTU
// ============================================================

export function buildReport({ accountName, dates, industry, isEcom, model, pause, targetRoas, targetCpa }) {
    const body = `
<div class="header">
  <div class="header-left">
    <h1>Przegląd słów kluczowych — ${esc(accountName)}<span class="badge">${isEcom ? 'E-COMMERCE' : 'LEAD GEN'}</span></h1>
    <div class="subtitle">Audyt słów kluczowych w koncie · 30 dni: ${fmtPeriod(dates.days30.start, dates.days30.end)}</div>
  </div>
  <div class="header-right">
    <button class="theme-toggle" id="themeBtn" onclick="toggleTheme()">🌙 Dark mode</button>
    <div style="margin-top:8px">${industry ? esc(industry) : ''}</div>
  </div>
</div>

<nav class="nav-bar">
  <a href="#p1">1. Podsumowanie</a>
  <a href="#p2">2. Główne źródła</a>
  <span class="nav-sep">·</span>
  <a href="#p3">3. Do wstrzymania <b>${fmt(pause.pewne.length + pause.sprawdz.length)}</b></a>
</nav>

<div class="part-title">Obraz konta</div>
${panel('p1', '1. Podsumowanie konta', '', renderSummary(model, isEcom, { roas: targetRoas, cpa: targetCpa }), true)}
${panel('p2', '2. Główne źródła konwersji', 'top 10 słów o największym udziale w wyniku — bez kampanii brandowych', renderCore(model.keywords, isEcom), true)}

<div class="part-title">Co ciąć</div>
${panel('p3', '3. Kandydaci do wstrzymania', `pewne: ${fmt(pause.pewne.length)} · do sprawdzenia: ${fmt(pause.sprawdz.length)}`, renderPause(pause, isEcom), true)}

<div class="footer">Wygenerowano ${new Date().toLocaleString('pl-PL')} · skill <code>gads-przeglad-slow-kluczowych</code> · dane: Google Ads API (<code>keyword_view</code> + <code>ad_group_criterion</code>)</div>`;

    // Kliknięcie w nawigację musi też ROZWINĄĆ panel — inaczej link prowadzi do zwiniętego
    // nagłówka i wygląda, jakby nic się nie stało.
    const scripts = `<script>
document.querySelectorAll('.nav-bar a').forEach(a => {
  a.addEventListener('click', () => {
    const cel = document.querySelector(a.getAttribute('href'));
    if (cel) cel.open = true;
  });
});
</script>`;

    return `<!DOCTYPE html>
<html lang="pl" data-theme="dark">
<head>
<meta charset="UTF-8">
<title>Słowa kluczowe — ${esc(accountName)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
${body}
${scripts}
${themeToggleScript()}
</body>
</html>`;
}
