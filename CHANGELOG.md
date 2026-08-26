# Changelog

Zmiany w pakiecie Ads-Agent. Najnowsze na górze.

Po `git pull` **zrestartuj Claude Code** — nowe skille pojawiają się dopiero po
restarcie sesji. Szczegóły każdego skilla: `.claude/skills/<skill>/SKILL.md`.

---

## 2026-08-26

### Dodane

- **Nowy skill `gsc-connector`** — dane z Google Search Console, **tylko do odczytu**.
  Zakres OAuth to `webmasters.readonly`, więc konektor nie jest w stanie zgłosić
  sitemapy, poprosić o indeksowanie ani niczego zmienić w property klienta.

  Dane z wyszukiwarki: `query` — kliknięcia, wyświetlenia, CTR i pozycja w dowolnym
  przekroju (fraza, strona, kraj, urządzenie, data, wygląd w wynikach), z filtrami
  i eksportem do CSV. Indeksowanie: `inspect` (pojedynczy URL — czy w indeksie, jaki
  canonical wybrał Google, skąd zna ten adres), `inspect-batch` (próbka URL-i z pliku)
  oraz `sitemaps`. Do tego `diagnose` — sitemapy, ruch i werdykt strony głównej w jednym
  wywołaniu, i `sites`, które wypisuje wszystkie property widoczne dla loginu.

  ```bash
  npm run gsc:auth                                  # autoryzacja (patrz ONBOARDING krok 7)
  node ".claude/skills/gsc-connector/scripts/cli.js" --action=sites
  node ".claude/skills/gsc-connector/scripts/cli.js" --action=query --site=zielonyogrod --days=90 --dimensions=page
  ```

  **Bez zależności npm** — działa na wbudowanym `fetch` (Node 18+). Klienta OAuth bierze
  z konektora Google Ads, więc cała konfiguracja to włączenie **jednego** API w tym samym
  projekcie GCP i jedna zgoda. Token trzyma osobno (`~/.ads-agent/gsc-token.json`).

  Dwie rzeczy, które konektor robi za Ciebie, bo bez nich Search Console myli:

  - **`sc-domain:example.com` i `https://example.com/` to dwa różne obiekty.** O formę,
    której konto nie posiada, Google pyta się **403** — jak o brak uprawnień. Przy 403/404
    konektor dopytuje API i wypisuje, co ten login naprawdę ma dla tej domeny.
  - **Dane ostateczne są opóźnione o 2–3 dni.** Świeży zakres bywa pusty i wygląda jak
    spadek ruchu; przy zerze wierszy konektor mówi to wprost i podpowiada `--data-state=all`.

  Property wskazujesz aliasem konta z `.claude/accounts.json` (nowe pola `gscSite`
  i `gscProfile`), więc `--site=zielonyogrod` celuje w tego samego klienta co
  `--account=zielonyogrod` w Adsach i `--property=zielonyogrod` w GA4. Obsługuje kilka
  loginów Google obok siebie przez profile tokenów — w Search Console to reguła, nie
  wyjątek, bo dostęp nadaje właściciel strony.

---

## 2026-08-18

### Dodane

- **Nowy skill `ga4-connector`** — dane z Google Analytics 4 i konfiguracja usługi,
  **tylko do odczytu**. Zakres OAuth to `analytics.readonly`, więc konektor nie jest
  w stanie niczego zmienić w usłudze klienta.

  Raporty: `traffic` (kanały), `sources`, `campaigns`, `landing-pages`, `ecommerce`
  (produkty), `cohort` (kohorty miesięczne), `realtime` (ostatnie 30 minut) oraz
  `report` — dowolne zestawienie wymiarów i metryk z filtrami i sortowaniem.

  Konfiguracja usługi: `properties` (wszystkie usługi widoczne dla konta razem z ID),
  `streams` (strumienie + measurement ID), `key-events`, `custom-dimensions`,
  `attribution` (model i okna konwersji), `ads-links` (czy usługa jest spięta z kontem
  Google Ads), `metadata`. Do tego `diagnose` — strumienie, połączenie z Ads, atrybucja
  i udział ruchu Direct w jednym wywołaniu, pod pytanie „dlaczego GA4 nie zgadza się
  z Adsami".

  ```bash
  npm run ga4:auth                                  # autoryzacja (patrz ONBOARDING krok 6)
  node ".claude/skills/ga4-connector/scripts/cli.js" --action=properties
  node ".claude/skills/ga4-connector/scripts/cli.js" --action=traffic --property=123456789 --days=30
  ```

  **Bez zależności npm** — działa na wbudowanym `fetch` (Node 18+), `npm install` nie jest
  potrzebny. Klienta OAuth bierze z konektora Google Ads (`~/google-ads.yaml`), więc cała
  konfiguracja to włączenie dwóch API w tym samym projekcie GCP i jedna zgoda. Token trzyma
  osobno (`~/.ads-agent/ga4-token.json`) — zakresy Adsów i GA4 są różne i nie wolno ich
  mieszać.

- **Kilka kont Google jednocześnie.** Jeden login rzadko widzi wszystkie usługi klientów.
  Profil = nazwany plik tokena, więc loginy nie nadpisują się nawzajem:

  ```bash
  node ".claude/skills/ga4-connector/scripts/auth.js" --step=url --profile=firma2
  node ".claude/skills/ga4-connector/scripts/cli.js" --action=profiles
  ```

  Autoryzacja bez `--profile` ostrzega, zanim nadpisze token domyślny.

- **Rejestr kont obsługuje GA4.** W `.claude/accounts.json` doszły dwa opcjonalne pola:
  `ga4PropertyId` (usługa GA4 klienta) i `ga4Profile` (login, który ją widzi). Dzięki temu
  `--property=<alias>` w GA4 wskazuje tego samego klienta co `--account=<alias>` w Adsach,
  a właściwy token dobiera się sam. **Istniejące rejestry działają bez zmian** — oba pola
  są opcjonalne, a `gads-connector` je ignoruje.

### Zmienione

- `references/accounts.example.json` (`gads-connector`) — opis nowych pól `ga4PropertyId`
  i `ga4Profile`.

---

## 2026-07-27

### Dodane

- **Nowy skill `gads-wykluczenia-hasel`** — znajduje wyszukiwane hasła przepalające
  budżet i generuje raport HTML z dwiema listami per kampania („Pewne — do wykluczenia"
  i „Do sprawdzenia") oraz listami gotowymi do wklejenia w Google Ads. Łączy cztery
  sygnały: wydajność z 30 dni, rok bez konwersji, dopasowanie do słów kluczowych
  i ocenę AI znającą ofertę klienta. Obejmuje Search, DSA, AI Max, Shopping i PMax.
  Tylko odczyt — niczego nie zmienia na koncie. Wymaga skonfigurowanego `gads-connector`.

  ```bash
  node ".claude/skills/gads-wykluczenia-hasel/scripts/wykluczenia-hasel.js" --account=1234567890 --open
  ```

  Przepływ jest **dwuprzebiegowy**: pierwszy przebieg zapisuje hasła do oceny, Claude je
  ocenia znając ofertę, drugi przebieg wciąga werdykty. W folderze raportu powstają
  `kontekst.md` (opis oferty — wypełnij, to najmocniej podnosi jakość) i
  `status-kierowanie.md` (pamięć między rundami). Test offline, bez API:
  `node ".claude/skills/gads-wykluczenia-hasel/scripts/smoke-test.js"`.

- **`CHANGELOG.md`** — ten plik.

### Zmienione

- `README.md` — skill dopisany do drzewa katalogów i tabeli Skills.
