#!/usr/bin/env node

/**
 * przeglad-slow-kluczowych.js — Audyt słów kluczowych DODANYCH DO KONTA Google Ads.
 *
 * Obiektem analizy jest słowo kluczowe wpisane do konta, nie hasło, które je wywołało.
 * Założenie: skoro ktoś dodał słowo kluczowe, jest ono zgodne z ofertą — dlatego skrypt
 * NIE ocenia dopasowania tematycznego i nie korzysta z modelu językowego. Ocenia
 * wyłącznie liczby: co przepala, gdzie jest sygnał do wstrzymania, gdzie do sprawdzenia.
 *
 * Słowa kluczowe istnieją tylko w kampaniach Search (i Display z kierowaniem na hasła);
 * PMax, Shopping i DSA nie mają czego audytować.
 *
 * Skrypt niczego nie zmienia na koncie — tylko czyta. Wstrzymania wykonuje osobno
 * konektor `gads-connector` (`--action=update-keyword-status`), po potwierdzeniu.
 *
 * Użycie:
 *   node przeglad-slow-kluczowych.js --account={alias|ID} [--out=<folder>] [--open]
 *
 * Opcje:
 *   --account       alias z .claude/accounts.json albo 10-cyfrowy customer ID (wymagane)
 *   --accounts-dir  katalog, od którego szukamy .claude/accounts.json (domyślnie: bieżący)
 *   --out           folder raportu (domyślnie: Klienci/{alias}/Optymalizacja)
 *   --typ           ecom | leadgen — nadpisuje config.json i wykrywanie automatyczne
 *   --cel-roas      docelowy ROAS (ecom) — nadpisuje targetRoas z config.json
 *   --cel-cpa       docelowy koszt konwersji (leadgen) — nadpisuje targetCpa z config.json
 *   --open          otwórz raport po wygenerowaniu (macOS)
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { execFileSync } from 'child_process';

import { runRawQuery, resolveAccount, getAccountTimezone } from './connector.js';
import { setCurrency, getDates, formatDate, fmt, fmtMoney } from './format.js';
import {
    fetchKeywordList, fetchMetrics30, fetchMetricsYear, fetchCampaignTargets,
    mergeMetrics, campaignAverages, buildPauseModel, buildCandidatesCsv,
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
    console.error('Użycie: node przeglad-slow-kluczowych.js --account={alias|ID} [--out=<folder>] [--open]');
    process.exit(1);
}

// ============================================================
// KONTO
// ============================================================

// Alias z .claude/accounts.json albo surowy customer ID. Nazwę i walutę dociągamy z API,
// gdy rejestr ich nie zna — nagłówek raportu i formatowanie kwot mają być poprawne także
// dla konta podanego samym numerem.
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
        // `timezone` w formacie IANA (np. `Europe/Warsaw`) — używana do liczenia okien
        // dat tak, jak liczy je Google Ads (unika off-by-one, gdy operator jest w innej
        // strefie niż konto).
        timezone: zRejestru?.timezone,
        key: zRejestru?.key || cyfry,
    };

    if (!konto.name || !konto.currency) {
        try {
            const [r] = await runRawQuery(konto.id, 'SELECT customer.descriptive_name, customer.currency_code FROM customer', { loginCustomerId: konto.login_customer_id });
            konto.name ||= r?.['customer.descriptive_name'];
            konto.currency ||= r?.['customer.currency_code'];
        } catch (e) {
            console.log(`   ⚠ Nie udało się pobrać danych konta z API (${e.message}).`);
        }
    }
    if (!konto.timezone) {
        // Rejestr nie miał strefy — dociągamy z API. Fallback do strefy lokalnej,
        // gdyby zapytanie padło (nie chcemy blokować raportu z powodu jednego pola).
        konto.timezone = await getAccountTimezone(konto.id, konto.login_customer_id);
    }
    konto.name ||= konto.id;
    return konto;
}

// ============================================================
// KONFIG KLIENTA
// ============================================================

// Cele i typ konta z `Klienci/<alias>/config.json`. Brak pliku albo błąd składni daje
// pusty obiekt — config jest wygodą, nie warunkiem uruchomienia. Bez configu skrypt
// wykryje typ konta automatycznie (po wartości konwersji), a poprzeczką będą średnie
// roczne kampanii.
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

// ============================================================
// MAIN
// ============================================================

async function main() {
    const accountsDir = args['accounts-dir'] || process.cwd();
    const account = await ustalKonto(args.account, accountsDir);
    setCurrency(account.currency);
    // Daty liczone w strefie konta (zwykle dopiero po `ustalKonto`, bo tam ją dociągamy).
    const dates = getDates(account.timezone);

    // Folder klienta wg konwencji pakietu: Klienci/<alias>/Optymalizacja/…
    const clientDir = resolve(process.cwd(), 'Klienci', String(account.key).toLowerCase());
    const outputDir = args.out
        ? (isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out))
        : join(clientDir, 'Optymalizacja');
    mkdirSync(outputDir, { recursive: true });

    const cfg = loadClientConfig(clientDir);

    // Cele: flaga CLI > config.json > (automatyczne wykrycie typu po wartości konwersji).
    const targetRoas = args['cel-roas'] != null ? Number(args['cel-roas']) : (cfg.targetRoas ?? null);
    const targetCpa = args['cel-cpa'] != null ? Number(args['cel-cpa']) : (cfg.targetCpa ?? null);
    const cele = { roas: targetRoas, cpa: targetCpa };
    const industry = cfg.industry || '';

    console.log(`\n🔑 Przegląd słów kluczowych — ${account.name}`);
    console.log(`   30 dni: ${dates.days30.start} → ${dates.days30.end} | rok: ${dates.days365.start} → ${dates.days365.end}\n`);

    console.log('   Pobieram listę słów kluczowych...');
    const map = await fetchKeywordList(account);
    if (map.size === 0) {
        console.log('\n⚠️  Konto nie ma żadnych słów kluczowych (same PMax / Shopping / DSA?) — nie ma czego audytować.');
        return;
    }

    console.log('   Pobieram metryki 30 dni (+ udział wyświetleń)...');
    const m30 = await fetchMetrics30(account, dates.days30);
    const dop30 = mergeMetrics(map, m30, 'd30');

    console.log('   Pobieram metryki roczne...');
    const mRok = await fetchMetricsYear(account, dates.days365);
    mergeMetrics(map, mRok, 'rok');

    console.log('   Pobieram cele kampanii (tROAS / tCPA)...');
    const celeKampanii = await fetchCampaignTargets(account);

    const keywords = [...map.values()];
    const avg30 = campaignAverages(keywords, 'd30');
    const avgRok = campaignAverages(keywords, 'rok');

    // Typ konta: flaga CLI > config > wykrycie automatyczne. Automat: konto raportujące
    // wartość konwersji traktujemy jak ecommerce — tylko tam ROAS jest sensowną miarą.
    const wartoscRoczna = keywords.reduce((s, kw) => s + (kw.rok.value || 0), 0);
    const typ = String(args.typ || cfg.businessType || '').toLowerCase();
    const isEcom = typ ? ['ecom', 'ecommerce'].includes(typ) : wartoscRoczna > 0;
    console.log(`   Tryb: ${isEcom ? 'e-commerce (ROAS)' : 'lead gen (koszt konwersji)'}`
        + `${typ ? '' : ' — wykryty automatycznie'}`
        + `${isEcom && targetRoas ? ` · cel ROAS ${targetRoas}` : ''}`
        + `${!isEcom && targetCpa ? ` · cel koszt konw. ${fmtMoney(targetCpa)}` : ''}`);

    const pause = buildPauseModel(keywords, avg30, avgRok, cele, isEcom, celeKampanii);

    const model = { keywords, avg30, avgRok };
    const aktywneKw = keywords.filter(kw => kw.aktywne);

    const zCelem = Object.values(celeKampanii).filter(c => c.roas || c.cpa).length;
    console.log(`\n   ✓ Słów kluczowych: ${keywords.length} (aktywnych: ${aktywneKw.length}) · z metrykami 30 dni: ${dop30}`);
    console.log(`   ✓ Kampanii z własnym celem (tROAS/tCPA): ${zCelem}/${Object.keys(celeKampanii).length}`);
    console.log(`   ✓ Do wstrzymania: pewne ${pause.pewne.length} · do sprawdzenia ${pause.sprawdz.length} · bronione wynikiem ${pause.bronione}`);

    const html = buildReport({
        accountName: account.name, dates, industry, isEcom, model, pause, targetRoas, targetCpa,
    });

    const dateStr = formatDate(new Date());
    const outputPath = join(outputDir, `${dateStr}-slowa-kluczowe.html`);
    writeFileSync(outputPath, html, 'utf8');
    console.log(`\n✅ Raport zapisany: ${outputPath}`);

    // Klucze kryteriów — jedyne, czego nie da się odczytać z HTML, a bez czego konektor
    // nie zidentyfikuje słowa przy wstrzymywaniu.
    const csvPath = join(outputDir, `${dateStr}-slowa-kluczowe-kandydaci.csv`);
    writeFileSync(csvPath, buildCandidatesCsv(pause, isEcom), 'utf8');
    console.log(`   Kandydaci (klucze kryteriów): ${csvPath}`);

    if (args.open) {
        // execFileSync, nie execSync — ścieżka trafia jako argument, nie w łańcuch shellowy,
        // więc znaki specjalne (spacje, cudzysłowy) nie są interpretowane.
        try { execFileSync('open', [outputPath]); } catch { /* nie-macOS albo brak GUI */ }
    }
}

main().catch(err => {
    console.error('\n❌ Błąd:', err.message);
    process.exit(1);
});
