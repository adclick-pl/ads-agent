#!/usr/bin/env node
/**
 * Zgłoszenie błędu albo pomysłu do autorów Ads-Agent. Uruchamiany z korzenia projektu.
 *
 *   node .claude/skills/feedback/scripts/feedback.js --action=podglad < zgloszenie.json
 *   node .claude/skills/feedback/scripts/feedback.js --action=wyslij --plik=<ścieżka z podglądu>
 *
 * `podglad` czyta ze standardowego wejścia JSON { rodzaj, skill, opis, kontekst, mail },
 * sprawdza go, dokłada wersję paczki, system i Node, zapisuje gotowe zgłoszenie w folderze
 * tymczasowym i wypisuje je w całości — to dokładnie to, co poleci. `wyslij` wysyła ten plik
 * bez zmian i go usuwa. Nic nie wychodzi z komputera przed `wyslij`.
 *
 * Adsagent Pro: klucz ADS_AGENT_PRO_KEY z `.env` idzie w nagłówku Authorization (serwer
 * rozpoznaje po nim kupującego), więc mail do odpowiedzi nie jest potrzebny i nie jest wysyłany.
 * Klucza skrypt nie wypisuje. Wynik zawsze jako JSON na stdout.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const URL_FEEDBACK = 'https://adsagent.pl/pro-api/feedback.php';
// Te same limity sprawdza serwer — tu tylko po to, żeby powiedzieć o nich przed wysłaniem.
const LIMITY = { skill: 80, opis: 5000, kontekst: 12000, mail: 200 };
const MAKS_BAJTOW = 20 * 1024;
const RODZAJE = ['blad', 'pomysl'];

const argumenty = Object.fromEntries(
  process.argv.slice(2).map((x) => x.match(/^--([^=]+)(?:=(.*))?$/s)).filter(Boolean).map((m) => [m[1], m[2] ?? true]),
);
const wypisz = (dane) => console.log(JSON.stringify(dane, null, 2));
const root = process.cwd();

function czytajPlik(sciezka) {
  try {
    return fs.readFileSync(path.join(root, sciezka), 'utf8');
  } catch {
    return null;
  }
}

function kluczPro() {
  const m = (czytajPlik('.env') || '').match(/^\s*ADS_AGENT_PRO_KEY\s*=\s*["']?([^"'\s#]+)/m);
  return m ? m[1] : null;
}

function wersjaPaczki() {
  let wersja = 'nieznana';
  try {
    wersja = JSON.parse(czytajPlik('package.json')).version || wersja;
  } catch {}
  try {
    // Pro: wersja z PAKIET.json zainstalowanej paczki (wersja Free + skrót treści).
    const pro = JSON.parse(czytajPlik('.adsagent-pro/pakiet.json'));
    if (pro.wersja) return `${pro.wersja} (Pro)`;
  } catch {}
  return wersja;
}


/** Zwraca gotowe zgłoszenie albo rzuca błąd z komunikatem dla użytkownika. */
export function zbudujZgloszenie(wejscie, { pro }) {
  if (!wejscie || typeof wejscie !== 'object' || Array.isArray(wejscie)) throw new Error('Wejście musi być obiektem JSON.');
  const tekst = (v) => (v == null ? '' : String(v).replace(/\r\n?/g, '\n').trim());
  const z = {
    rodzaj: tekst(wejscie.rodzaj),
    skill: tekst(wejscie.skill),
    opis: tekst(wejscie.opis),
    kontekst: tekst(wejscie.kontekst),
    wersja: wersjaPaczki(),
    system: `${process.platform} ${os.release()} ${process.arch}`, // darwin = macOS, win32 = Windows
    node: process.version,
  };
  if (!RODZAJE.includes(z.rodzaj)) throw new Error('Pole "rodzaj" musi mieć wartość "blad" albo "pomysl".');
  if (!z.opis) throw new Error('Pole "opis" jest puste.');
  if (z.skill && !/^[a-z0-9-]+$/.test(z.skill)) throw new Error('Pole "skill" to sama nazwa skilla, np. gads-connector.');
  // Mail tylko w wersji darmowej — kupującego Pro serwer rozpoznaje po kluczu.
  const mail = tekst(wejscie.mail);
  if (mail && !pro) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('Adres e-mail wygląda na błędny.');
    z.mail = mail;
  }
  for (const [pole, maks] of Object.entries(LIMITY)) {
    if ((z[pole] || '').length > maks) throw new Error(`Pole "${pole}" jest za długie (${z[pole].length} znaków, limit ${maks}). Skróć je.`);
  }
  if (Buffer.byteLength(JSON.stringify(z)) > MAKS_BAJTOW) throw new Error('Zgłoszenie jest za duże (limit 20 KB). Skróć opis albo kontekst.');
  return z;
}

async function podglad() {
  let dane = '';
  for await (const kawalek of process.stdin) dane += kawalek;
  let wejscie;
  try {
    wejscie = JSON.parse(dane);
  } catch {
    return wypisz({ stan: 'blad', komunikat: 'Na wejściu nie ma poprawnego JSON-a.' });
  }
  const pro = Boolean(kluczPro());
  let zgloszenie;
  try {
    zgloszenie = zbudujZgloszenie(wejscie, { pro });
  } catch (e) {
    return wypisz({ stan: 'blad', komunikat: e.message });
  }
  const plik = path.join(os.tmpdir(), `adsagent-feedback-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(plik, JSON.stringify(zgloszenie, null, 2));
  wypisz({ stan: 'podglad', pro, plik, zgloszenie });
}

async function wyslij() {
  const plik = argumenty.plik;
  if (!plik || !fs.existsSync(plik)) return wypisz({ stan: 'blad', komunikat: 'Brak pliku z podglądu — zrób najpierw --action=podglad.' });
  const tresc = fs.readFileSync(plik, 'utf8');
  const klucz = kluczPro();
  const naglowki = { 'Content-Type': 'application/json' };
  if (klucz) naglowki.Authorization = `Bearer ${klucz}`;
  let odp;
  try {
    odp = await fetch(URL_FEEDBACK, { method: 'POST', headers: naglowki, body: tresc });
  } catch (e) {
    return wypisz({ stan: 'blad-sieci', komunikat: `Nie udało się połączyć z serwerem (${e.cause?.code || e.message}). Spróbuj za kilka minut.` });
  }
  let wynik = {};
  try {
    wynik = await odp.json();
  } catch {}
  if (!odp.ok) return wypisz({ stan: 'blad-serwera', kod: odp.status, komunikat: wynik.komunikat || `HTTP ${odp.status}` });
  fs.rmSync(plik, { force: true });
  wypisz({ stan: 'wyslane', numer: wynik.numer });
}

// Uruchomiony jako skrypt (test importuje tylko zbudujZgloszenie).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const akcje = { podglad, wyslij };
  const akcja = akcje[argumenty.action];
  if (!akcja) {
    wypisz({ stan: 'blad', komunikat: 'Użycie: --action=podglad (JSON na wejściu) albo --action=wyslij --plik=<ścieżka>.' });
    process.exitCode = 1;
  } else {
    await akcja();
  }
}
