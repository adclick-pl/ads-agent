/**
 * raport-html.js — warstwa prezentacji raportu wykluczeń.
 *
 * Struktura: podsumowanie konta, a pod nim sekcja PER KAMPANIA (zwijana) z dokładnie
 * dwiema tabelami: „Pewne — do wykluczenia" i „Do sprawdzenia". Nie ma tu przeglądu
 * haseł konta, TOP-ów ani motywów — od tego są inne narzędzia.
 *
 * Podział na kampanie jest tu, a nie tylko w analizie, bo wykluczające dodaje się
 * w koncie per kampania (albo per lista) — scalona lista zmuszałaby operatora do
 * ręcznego rozdzielania haseł z powrotem. Benchmarki też są lokalne dla kampanii,
 * więc „drogo" w jednej znaczy co innego niż w drugiej.
 */

import { fmt, fmtMoney, fmtPeriod } from './format.js';
import { yearOf, poziomSygnalu } from './analiza.js';

// Ile wierszy pokazujemy w jednej tabeli. Listy bywają ogromne (samo PMax potrafi
// dać ponad tysiąc kandydatów), a są posortowane wg kosztu — poniżej progu mowa
// o ogonie za grosze. Ucięcie jest ZAWSZE opisane, żeby nie wyglądało na komplet.
export const MAX_WIERSZY = 100;

const PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root, [data-theme="light"] {
    --bg: #f0f2f5; --surface: #ffffff; --surface2: #f8faff;
    --border: #e8edf5; --border2: #f0f2f5;
    --text: #1a1a1a; --text2: #6b7280; --text3: #9ca3af;
    --header-bg: #1a1a2e; --header-sub: #94a3b8;
    --hover: #fafbff; --th-bg: #f8faff; --kpi-bg: #f8faff;
    --shadow: 0 1px 4px rgba(0,0,0,0.08);
    --toggle-bg: #e2e8f0; --toggle-text: #374151;
  }
  [data-theme="dark"] {
    --bg: #0f1117; --surface: #1a1d27; --surface2: #222537;
    --border: #2d3148; --border2: #252840;
    --text: #e2e8f0; --text2: #94a3b8; --text3: #64748b;
    --header-bg: #0d0f1a; --header-sub: #64748b;
    --hover: #1e2236; --th-bg: #1e2236; --kpi-bg: #1e2236;
    --shadow: 0 1px 4px rgba(0,0,0,0.4);
    --toggle-bg: #2d3148; --toggle-text: #94a3b8;
  }

  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); padding: 24px; font-size: 14px; }
  .header { background: var(--header-bg); color: white; border-radius: 12px; padding: 24px 28px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; gap: 24px; flex-wrap: wrap; }
  .header-left h1 { font-size: 1.4em; font-weight: 600; }
  .header-left .subtitle { color: var(--header-sub); margin-top: 4px; font-size: 0.9em; }
  .header-right { text-align: right; color: var(--header-sub); font-size: 0.85em; line-height: 1.6; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .badge { display: inline-block; background: #4285f4; color: white; border-radius: 6px; padding: 2px 8px; font-size: 0.75em; font-weight: 600; margin-left: 8px; }
  .theme-toggle { background: var(--toggle-bg); color: var(--toggle-text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; font-size: 0.8em; cursor: pointer; font-family: inherit; }
  .theme-toggle:hover { opacity: 0.85; }

  .section { background: var(--surface); border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; box-shadow: var(--shadow); border: 1px solid var(--border); }
  .section-title { font-size: 0.8em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text2); margin-bottom: 16px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .kpi { background: var(--kpi-bg); border-radius: 10px; padding: 14px 16px; border: 1px solid var(--border); }
  .kpi-label { font-size: 0.75em; color: var(--text2); font-weight: 500; margin-bottom: 6px; }
  .kpi-value { font-size: 1.5em; font-weight: 700; line-height: 1.1; }
  .kpi-sub { color: var(--text3); font-size: 0.75em; margin-top: 4px; }
  .kpi-red .kpi-value { color: #dc2626; }
  .kpi-amber .kpi-value { color: #a16207; }
  [data-theme="dark"] .kpi-red .kpi-value { color: #f87171; }
  [data-theme="dark"] .kpi-amber .kpi-value { color: #fbbf24; }

  .st-table-wrap { overflow-x: auto; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 8px; }
  .st-table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  .st-table th { background: var(--th-bg); padding: 7px 8px; font-size: 0.75em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text2); border-bottom: 2px solid var(--border); text-align: left; }
  .st-table td { padding: 7px 8px; border-bottom: 1px solid var(--border2); color: var(--text); vertical-align: top; }
  .st-table tr:last-child td { border-bottom: none; }
  .st-table tr:hover td { background: var(--hover); }
  .right { text-align: right; }
  .term-col { max-width: 260px; word-break: break-word; font-weight: 600; }
  .camp-col { max-width: 160px; font-size: 0.9em; color: var(--text2); }
  .reason-col { max-width: 420px; }
  .yr-col { background: var(--surface2); }
  .st-table th.yr-col { filter: brightness(1.06); }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; vertical-align: middle; }
  .st-red { background: rgba(239,68,68,0.10); }
  .st-yellow { background: rgba(234,179,8,0.10); }

  .reason-tag { display: inline-block; font-size: 0.78em; background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; padding: 2px 7px; margin: 2px 3px 2px 0; color: var(--text2); line-height: 1.5; }
  .tag-bad { background: rgba(239,68,68,0.10); border-color: rgba(239,68,68,0.30); color: #dc2626; }
  [data-theme="dark"] .tag-bad { color: #f87171; }

  /* Kampania jako <details>: kliknięcie w nagłówek zwija/rozwija tabele. */
  .camp-section { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
  .camp-header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; background: var(--surface2); cursor: pointer; user-select: none; list-style: none; flex-wrap: wrap; }
  .camp-header::-webkit-details-marker { display: none; }
  .camp-header:hover { filter: brightness(1.04); }
  .camp-header::before { content: '▸'; color: var(--text3); font-size: 0.9em; transition: transform 0.15s; }
  .camp-section[open] > .camp-header { border-bottom: 1px solid var(--border); }
  .camp-section[open] > .camp-header::before { transform: rotate(90deg); }
  .camp-name { font-weight: 600; font-size: 0.95em; }
  .camp-meta { font-size: 0.8em; color: var(--text2); }
  .camp-typ { font-size: 0.7em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; background: var(--border); color: var(--text2); }
  .camp-badge { margin-left: auto; font-size: 0.78em; padding: 2px 8px; border-radius: 4px; background: var(--border); color: var(--text2); white-space: nowrap; }
  .camp-badge.ma-pewne { background: rgba(239,68,68,0.14); color: #dc2626; font-weight: 700; }
  [data-theme="dark"] .camp-badge.ma-pewne { color: #f87171; }
  .camp-body { padding: 4px 18px 18px; }
  .camp-toggle-all { font-size: 0.78em; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text2); cursor: pointer; font-family: inherit; }
  .camp-toggle-all:hover { filter: brightness(1.08); }
  .bez-kandydatow { color: var(--text3); font-size: 0.8em; line-height: 1.6; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
  .panel-label { font-size: 0.8em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text2); padding: 12px 0 4px; }
  .panel-desc { color: var(--text3); font-size: 0.8em; margin: 0 0 10px; line-height: 1.5; }
  .empty { color: var(--text3); font-size: 0.85em; padding: 12px 0; }
  .copy-box { position: relative; margin-top: 8px; }
  .copy-box textarea { width: 100%; font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; padding: 12px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); resize: vertical; line-height: 1.7; }
  .copy-box button { position: absolute; top: 8px; right: 8px; padding: 4px 12px; font-size: 0.78em; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; color: var(--text2); font-family: inherit; }
  .footer { text-align: center; color: var(--text3); font-size: 0.78em; margin-top: 20px; line-height: 1.7; }
`;

const THEME_SCRIPT = `
<script>
function toggleTheme() {
  const html = document.documentElement;
  const dark = html.getAttribute('data-theme') !== 'dark';
  html.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.getElementById('themeBtn').textContent = dark ? '☀️ Light mode' : '🌙 Dark mode';
  localStorage.setItem('wykluczenia-theme', dark ? 'dark' : 'light');
}
function copyBox(btn, id) {
  const t = document.getElementById(id);
  t.select();
  document.execCommand('copy');
  btn.textContent = '✓ Skopiowano';
  setTimeout(() => { btn.textContent = 'Kopiuj'; }, 2000);
}
function toggleAllCamps(btn) {
  const sections = document.querySelectorAll('.camp-section');
  const rozwin = [...sections].some(d => !d.open);
  sections.forEach(d => { d.open = rozwin; });
  btn.textContent = rozwin ? 'Zwiń wszystkie' : 'Rozwiń wszystkie';
}
(function () {
  const saved = localStorage.getItem('wykluczenia-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeBtn').textContent = saved === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
})();
</script>`;

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const tag = (text, bad = false) => `<span class="reason-tag${bad ? ' tag-bad' : ''}">${esc(text)}</span>`;

// ============================================================
// TABELA KANDYDATÓW
// ============================================================

// Nagłówek dwupoziomowy — bez niego kolumny „Konw." z dwóch okien byłyby nie do odróżnienia.
// Kolumny „Kampania" nie ma: tabela żyje wewnątrz sekcji swojej kampanii.
function tableHeader(isEcom) {
    const cur = isEcom ? 8 : 7;
    const grp = 'font-size:0.68em;letter-spacing:0.08em;border-bottom:1px solid var(--border)';
    const wynikowe30 = isEcom
        ? '<th class="right">Wart. konw.</th><th class="right">ROAS</th><th class="right">Wsp. konw.</th>'
        : '<th class="right">Koszt konw.</th><th class="right">Wsp. konw.</th>';
    const wynikoweRok = '<th class="right yr-col">Konw.</th>'
        + (isEcom ? '<th class="right yr-col">ROAS</th>' : '<th class="right yr-col">Koszt konw.</th>')
        + '<th class="right yr-col">Wsp. konw.</th>';
    return `<tr>
        <th colspan="2"></th>
        <th colspan="${cur}" class="right" style="${grp}">OSTATNIE 30 DNI</th>
        <th colspan="3" class="right yr-col" style="${grp}">OSTATNI ROK (365 DNI)</th>
        <th></th>
      </tr>
      <tr>
        <th style="width:16px"></th><th>Hasło</th>
        <th class="right">Wyśw.</th><th class="right">Kliknięcia</th><th class="right">Koszt</th>
        <th class="right">CTR</th><th class="right">Konw.</th>${wynikowe30}
        ${wynikoweRok}
        <th>Uwagi</th>
      </tr>`;
}

function yearCells(y, isEcom) {
    const dash = '<td class="right yr-col"><span style="color:var(--text3)">–</span></td>';
    if (!y) return dash.repeat(3);
    const conv = `<td class="right yr-col">${fmt(y.conversions, 1)}</td>`;
    const cvr = `<td class="right yr-col">${fmt(y.clicks > 0 ? (y.conversions / y.clicks * 100) : 0, 1)}%</td>`;
    if (isEcom) {
        const roas = y.cost > 0 ? y.value / y.cost : null;
        return conv + `<td class="right yr-col">${roas !== null ? fmt(roas, 2) : '–'}</td>` + cvr;
    }
    const cpa = y.conversions > 0 ? y.cost / y.conversions : null;
    return conv + `<td class="right yr-col">${cpa !== null ? fmtMoney(cpa) : '–'}</td>` + cvr;
}

function candidateRow(c, isEcom, yearMap, pewny) {
    const t = c.row;
    const y = yearOf(yearMap, t);
    const ctr = t.impressions > 0 ? (t.clicks / t.impressions * 100) : 0;
    const cvr = t.clicks > 0 ? (t.conversions / t.clicks * 100) : 0;
    const wynikowe = isEcom
        ? `<td class="right">${fmtMoney(t.value)}</td>
           <td class="right">${t.cost > 0 ? fmt(t.value / t.cost, 2) : '–'}</td>
           <td class="right">${fmt(cvr, 1)}%</td>`
        : `<td class="right">${t.conversions > 0 ? fmtMoney(t.cost / t.conversions) : '–'}</td>
           <td class="right">${fmt(cvr, 1)}%</td>`;
    const uwagi = c.reasons.map(r => tag(r.text, poziomSygnalu(r, y) === 'pewny')).join('');
    return `<tr class="${pewny ? 'st-red' : 'st-yellow'}">
        <td style="width:16px;padding-right:0"><span class="dot" style="background:${pewny ? '#ef4444' : '#eab308'}"></span></td>
        <td class="term-col">${esc(t.term)}</td>
        <td class="right">${fmt(t.impressions)}</td>
        <td class="right">${fmt(t.clicks)}</td>
        <td class="right"><strong>${fmtMoney(t.cost)}</strong></td>
        <td class="right">${fmt(ctr, 2)}%</td>
        <td class="right">${fmt(t.conversions, 1)}</td>
        ${wynikowe}
        ${yearCells(y, isEcom)}
        <td class="reason-col">${uwagi}</td>
      </tr>`;
}

function candidateTable(list, isEcom, yearMap, pewny) {
    const widoczne = list.slice(0, MAX_WIERSZY);
    const ucieto = list.length - widoczne.length;
    const notka = ucieto > 0
        ? `<div class="panel-desc"><strong>Pokazano ${widoczne.length} z ${list.length}</strong> (wg kosztu malejąco) — pominięte ${ucieto} kosztowały mniej niż ${fmtMoney(widoczne[widoczne.length - 1].row.cost)} w 30 dniach.</div>`
        : '';
    return notka + `
      <div class="st-table-wrap">
        <table class="st-table">
          <thead>${tableHeader(isEcom)}</thead>
          <tbody>${widoczne.map(c => candidateRow(c, isEcom, yearMap, pewny)).join('')}</tbody>
        </table>
      </div>`;
}

// Lista gotowa do wklejenia w Google Ads. Dopasowanie ŚCISŁE (`[hasło]`), bo
// wykluczamy konkretne zapytanie, które padło — szersze dopasowanie wycięłoby
// przy okazji warianty, których nikt nie oceniał.
function copyBox(list, id, label, opis) {
    if (!list.length) return '';
    const terms = [...new Set(list.map(c => c.row.term))];
    return `
      <div class="panel-label">${esc(label)} (${terms.length})</div>
      <div class="panel-desc">${opis}</div>
      <div class="copy-box">
        <textarea id="${id}" readonly rows="${Math.min(terms.length, 12)}">${terms.map(t => `[${esc(t)}]`).join('\n')}</textarea>
        <button onclick="copyBox(this, '${id}')">Kopiuj</button>
      </div>`;
}

const OPIS_KOPIOWANIA = 'Wklej w Google Ads jako <strong>wykluczające słowa kluczowe</strong>. Nawiasy kwadratowe oznaczają dopasowanie ścisłe — wycinają dokładnie te zapytania, a nie ich szersze warianty.';

// ============================================================
// SEKCJA KAMPANII
// ============================================================

// Sekcja z pewnymi kandydatami startuje ROZWINIĘTA — to jest to, po co ktoś otwiera
// ten raport. Reszta zwinięta, żeby konto z 30 kampaniami dało się przejrzeć.
// `rozwin` wymusza rozwinięcie także bez pewnych: gdy na całym koncie nie ma ani
// jednego pewnego hasła, raport otwierałby się w całości zwinięty i wyglądał na pusty.
function campSection(k, isEcom, yearMap, idx, rozwin = false) {
    const maPewne = k.pewne.length > 0;
    const kosztKandydatow = [...k.pewne, ...k.doSprawdzenia].reduce((s, c) => s + c.row.cost, 0);

    const badge = maPewne
        ? `⚠ ${k.pewne.length} pewnych${k.doSprawdzenia.length ? ` · ${k.doSprawdzenia.length} do sprawdzenia` : ''}`
        : (k.doSprawdzenia.length ? `${k.doSprawdzenia.length} do sprawdzenia` : '✓ brak kandydatów');

    const progNotka = k.minKlikniec
        ? `<div class="panel-desc">Kampania produktowa — pod uwagę brane tylko hasła z min. ${k.minKlikniec} kliknięciami w 30 dniach.</div>`
        : '';

    return `
    <details class="camp-section"${maPewne || rozwin ? ' open' : ''}>
      <summary class="camp-header">
        <span class="camp-name">${esc(k.camp)}</span>
        ${k.typ ? `<span class="camp-typ">${esc(k.typ)}</span>` : ''}
        <span class="camp-meta">${fmt(k.totals.terms)} haseł · ${fmtMoney(k.totals.cost)} / 30 dni${kosztKandydatow > 0 ? ` · kandydaci: ${fmtMoney(kosztKandydatow)}` : ''}</span>
        <span class="camp-badge${maPewne ? ' ma-pewne' : ''}">${badge}</span>
      </summary>
      <div class="camp-body">
        ${progNotka}
        <div class="panel-label">Pewne — do wykluczenia (${k.pewne.length})</div>
        <div class="panel-desc">Sygnał potwierdzony danymi: rok kosztów bez konwersji albo ocena AI z wysoką pewnością. Te można dodać do wykluczeń bez dalszej weryfikacji.</div>
        ${k.pewne.length ? candidateTable(k.pewne, isEcom, yearMap, true) : '<div class="empty">✓ Brak haseł z pewnym sygnałem do wykluczenia.</div>'}

        <div class="panel-label">Do sprawdzenia — decyduje człowiek (${k.doSprawdzenia.length})</div>
        <div class="panel-desc">Sygnał sugerujący problem, ale niepotwierdzony: dopasowanie semantyczne nie zna specyfiki tematu, a wydajność bez pokrycia w danych rocznych opiera się na 30 dniach. Przejrzyj przed wykluczeniem.</div>
        ${k.doSprawdzenia.length ? candidateTable(k.doSprawdzenia, isEcom, yearMap, false) : '<div class="empty">✓ Brak haseł do ręcznego sprawdzenia.</div>'}

        ${copyBox(k.pewne, `copy-camp-${idx}`, 'Do skopiowania — pewne z tej kampanii', `${OPIS_KOPIOWANIA} Dodaj je w kampanii <strong>${esc(k.camp)}</strong>.`)}
      </div>
    </details>`;
}

// ============================================================
// RAPORT
// ============================================================

const kpi = (label, value, sub = '', cls = '') =>
    `<div class="kpi ${cls}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;

export function buildReport({
    accountName, isEcom, industry, dates, benchOpis,
    kampanie, yearMap,
    hasel, kosztCalosc, ocenionychAI, niepewnychDoOceny
}) {
    const wszystkie = (pole) => kampanie.flatMap(k => k[pole]);
    const pewne = wszystkie('pewne');
    const doSprawdzenia = wszystkie('doSprawdzenia');
    const bronione = wszystkie('bronione');

    const kosztPewne = pewne.reduce((s, c) => s + c.row.cost, 0);
    const kosztSprawdz = doSprawdzenia.reduce((s, c) => s + c.row.cost, 0);
    const udzial = kosztCalosc > 0 ? ((kosztPewne + kosztSprawdz) / kosztCalosc * 100) : 0;

    const zKandydatami = kampanie.filter(k => k.pewne.length || k.doSprawdzenia.length);
    const bezKandydatow = kampanie.filter(k => !k.pewne.length && !k.doSprawdzenia.length);

    const ocenaAI = ocenionychAI > 0
        ? kpi('Ocena AI (warstwa 3b)', fmt(ocenionychAI), 'haseł ocenionych z kontekstem oferty')
        : kpi('Ocena AI (warstwa 3b)', '–', niepewnychDoOceny > 0
            ? `${fmt(niepewnychDoOceny)} haseł czeka na ocenę — uruchom drugi przebieg`
            : 'brak haseł wymagających oceny');

    const bodyHtml = `
<div class="header">
  <div class="header-left">
    <h1>${esc(accountName)} <span class="badge">${isEcom ? 'ecommerce' : 'leadgen'}</span></h1>
    <div class="subtitle">Wykluczające słowa kluczowe — kandydaci${industry ? ` · ${esc(industry)}` : ''}</div>
  </div>
  <div class="header-right">
    <button class="theme-toggle" onclick="toggleTheme()" id="themeBtn">☀️ Light mode</button>
    <div><strong>Okres oceny:</strong> ${fmtPeriod(dates.days30.start, dates.days30.end)}</div>
    <div style="font-size:0.9em">Kontekst roczny: ${fmtPeriod(dates.days365.start, dates.days365.end)}</div>
    <div style="font-size:0.9em">Wygenerowano: ${new Date().toLocaleDateString('pl-PL')}</div>
  </div>
</div>

<div class="section">
  <div class="section-title">Podsumowanie</div>
  <div class="kpi-grid">
    ${kpi('Haseł przeanalizowanych', fmt(hasel), `koszt ${fmtMoney(kosztCalosc)} / 30 dni`)}
    ${kpi('Pewne — do wykluczenia', fmt(pewne.length), `${fmtMoney(kosztPewne)} / 30 dni`, 'kpi-red')}
    ${kpi('Do sprawdzenia', fmt(doSprawdzenia.length), `${fmtMoney(kosztSprawdz)} / 30 dni`, 'kpi-amber')}
    ${kpi('Udział w koszcie konta', `${fmt(udzial, 1)}%`, 'tyle budżetu dotyczą obie listy')}
    ${kpi('Obronione wynikiem rocznym', fmt(bronione.length), 'słabe w 30 dniach, ale rok trzyma cel')}
    ${ocenaAI}
  </div>
  <div class="panel-desc" style="margin-top:14px">
    Punkt odniesienia przy ocenie: <strong style="color:var(--text2)">${esc(benchOpis)}</strong>.
    Sygnały liczone są per kampania, bo „drogo" w jednej kampanii znaczy co innego niż w drugiej — dlatego listy są poniżej rozbite na kampanie, tak jak dodaje się wykluczające w koncie.
    Hasła słabe w ostatnich 30 dniach, ale trzymające cel w skali roku, zostały z list <strong style="color:var(--text2)">usunięte</strong> — rok ma więcej danych niż miesiąc.
  </div>
</div>

<div class="section">
  <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:14px">
    <span class="section-title" style="margin:0">Hasła do wykluczenia — per kampania</span>
    <span style="font-size:0.75em; color:var(--text3)">kliknij nazwę kampanii, żeby zwinąć lub rozwinąć</span>
    <button class="camp-toggle-all" onclick="toggleAllCamps(this)">Rozwiń wszystkie</button>
  </div>

  ${zKandydatami.length
        ? zKandydatami.map((k, i) => campSection(k, isEcom, yearMap, i, pewne.length === 0)).join('')
        : '<div class="empty">✓ Żadna kampania nie ma kandydatów do wykluczenia.</div>'}

  ${bezKandydatow.length
        ? `<div class="bez-kandydatow"><strong>Bez kandydatów (${bezKandydatow.length}):</strong> ${bezKandydatow.map(k => esc(k.camp)).join(' · ')}</div>`
        : ''}
</div>

${pewne.length && zKandydatami.length > 1 ? `
<div class="section">
  <div class="section-title">Wszystkie pewne razem</div>
  ${copyBox(pewne, 'copy-pewne', 'Do skopiowania — pewne ze wszystkich kampanii',
        `${OPIS_KOPIOWANIA} Ta lista łączy kampanie — użyj jej tylko, jeśli dodajesz wykluczenia do <strong>wspólnej listy</strong> na poziomie konta. Do pojedynczych kampanii bierz listy z sekcji wyżej.`)}
</div>` : ''}

<div class="footer">
  Kandydaci do wykluczenia · ${esc(accountName)} · ${new Date().toLocaleDateString('pl-PL')}<br>
  Dokument roboczy. Wykluczenia dodajesz sam w Google Ads — raport niczego nie zmienia na koncie.
</div>`;

    return `<!DOCTYPE html>
<html lang="pl" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wykluczenia haseł — ${esc(accountName)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
${bodyHtml}
${THEME_SCRIPT}
</body>
</html>`;
}
