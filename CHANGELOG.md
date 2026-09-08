# Changelog

Zmiany w pakiecie Ads-Agent. Najnowsze na górze.

Po `git pull` **zrestartuj Claude Code** — nowe skille pojawiają się dopiero po
restarcie sesji. Szczegóły każdego skilla: `.claude/skills/<skill>/SKILL.md`.

---

## 2026-09-08

### Dodane

- **Nowy skill `gads-przeglad-slow-kluczowych`** — audyt **słów kluczowych dodanych
  do konta** (nie wyszukiwanych haseł — od tego jest `gads-wykluczenia-hasel`). Raport
  HTML z kandydatami do wstrzymania, rozbitymi na kampanie, w dwóch listach: „pewne"
  (rok bez konwersji przy koszcie ≥ 3× rocznego kosztu konwersji kampanii, albo słaby
  miesiąc potwierdzony słabym rokiem) i „do sprawdzenia" (konwersje są, ale wynik
  wyraźnie poniżej celu). Przy każdym słowie liczby z 30 dni i z roku, powód oraz
  poprzeczka, do której zostało porównane. Same liczby, bez modelu językowego —
  jeden przebieg trwa kilkanaście–kilkadziesiąt sekund.

  ```bash
  node ".claude/skills/gads-przeglad-slow-kluczowych/scripts/przeglad-slow-kluczowych.js" --account=zielonyogrod --open
  ```

  Poprzeczka od najbardziej konkretnej: cel ustawiony w kampanii (tROAS/tCPA ze
  strategii licytacji) → cel konta z `Klienci/<alias>/config.json` → średnia roczna
  kampanii → średnia roczna konta. **Ochrona przez wynik działa w obie strony**: słowo
  trzymające cel w skali roku nie trafia na listę mimo słabego miesiąca, a słowo, które
  w ostatnich 30 dniach zaczęło dowozić (min. 1 pełna konwersja, pełna poprzeczka), jest
  chronione mimo słabego roku. Przed listami do cięcia raport pokazuje obraz konta
  (udział wydatku w słowa bez konwersji, rozkład typów dopasowania bez brandu, cel obok
  wyniku rocznego) i 10 głównych źródeł konwersji poza kampaniami brandowymi.

  Sam skrypt niczego nie zmienia na koncie. Obok raportu powstaje
  `…-kandydaci.csv` z kluczami kryteriów — Claude proponuje wstrzymanie listy „pewnych",
  o „do sprawdzenia" pyta osobno i wstrzymuje tylko potwierdzone, przez
  `update-keyword-status` w konektorze (`PAUSED`, odwracalne — nigdy usunięcie).
  Wstrzymane słowa zapisuje w `Klienci/<alias>/Optymalizacja/status-slowa-kluczowe.md`.
  Wymaga skonfigurowanego `gads-connector`.

- **Typ konta (ecom / leadgen) ustalany przez Claude'a, nie zgadywany z danych.**
  Od typu zależy cała ocena (ROAS vs koszt konwersji). Skill sprawdza po kolei:
  `businessType` w `Klienci/<alias>/config.json` → kategorie aktywnych akcji konwersji
  (`list-conversions` w konektorze: zakup/koszyk = ecom, lead/formularz/telefon = leadgen)
  → stronę WWW klienta → w razie wątpliwości pyta. Ustalony typ zapisuje do `config.json`,
  więc przy kolejnym uruchomieniu nie powtarza detekcji. Nadpisanie ręczne: `--typ=ecom|leadgen`.

- **Rejestr kont zakłada się sam: `--action=init-accounts`.** Rejestr
  `.claude/accounts.json`, który do tej pory wypełniało się ręcznie, konektor potrafi
  teraz zbudować sam — przy kilkudziesięciu kontach pod MCC to różnica między minutą
  a popołudniem. Akcja czyta wszystkie konta widoczne dla loginu, buduje klucz
  z nazwy konta i uzupełnia `id`, `login_customer_id`, `currency` oraz `timezone`.

  ```bash
  node ".claude/skills/gads-connector/scripts/cli.js" --action=init-accounts           # symulacja
  node ".claude/skills/gads-connector/scripts/cli.js" --action=init-accounts --commit  # zapis
  ```

  Jak każda akcja zapisująca domyślnie **symuluje** — bez `--commit` tylko pokazuje, co
  zapisze. Pomija konta managerskie, nieaktywne i te już obecne w rejestrze, każde
  z podanym powodem. **Istniejących wpisów nie nadpisuje**, więc bezpiecznie odpalić
  ponownie po dostaniu dostępu do nowych kont.

  Dwie rzeczy zostawia człowiekowi. Nie nadaje **aliasów** — alias trafia do narzędzia,
  które zmienia budżety, więc powinien przejść przez człowieka — ani flagi `default`.
  Gdy dwa konta dają ten sam klucz albo z nazwy nie da się zbudować czytelnego,
  **pomija oba i mówi dlaczego**, zamiast dorabiać końcówkę w rodzaju `klient2`.

  Konektor sam o tym przypomina: gdy rejestru nie ma, `test-connection`
  i `list-accessible` kończą się podpowiedzią z gotową komendą.

- **Kontrola rejestru: `--action=check-accounts`.** Wypisuje powtórzone klucze, ID
  i aliasy, aliasy zasłonięte cudzym kluczem lub nazwą oraz kilka kont z flagą `default`.
  Kod wyjścia 1, gdy coś znajdzie.

### Zmienione

- **Niejednoznaczny selektor konta zatrzymuje wywołanie.** Gdy `--account` pasuje do
  dwóch wpisów rejestru (ten sam klucz, alias albo ID) lub gdy bez `--account` kilka
  kont ma flagę `default`, konektor kończy błędem i wypisuje kolidujące wpisy, zamiast
  brać pierwsze trafienie z pliku. Takie wpisy wyłapuje z wyprzedzeniem
  `--action=check-accounts`.

- **Nazwa folderu klienta: małe litery bez separatorów.** Klucz rejestru i nazwa folderu
  w `Klienci/` liczone są teraz jedną funkcją w konektorze, w konwencji zgodnej z tą,
  którą proponują konektory GA4 i Search Console (`zielonyogrod`). Wcześniej skille
  budowały nazwę z myślnikami, a konektory bez, więc dopisanie konta do rejestru
  przemianowywało folder. Formy prawne i końcówki domenowe są wycinane, żeby sklejona
  nazwa dała się przeczytać: „Nowak i Syn sp. z o.o." daje `nowakisyn`, nie
  `nowakisynspzoo`. **Konto, które nie jest w rejestrze i miało już raporty, dostanie
  przy następnym uruchomieniu folder o nowej nazwie** — stare raporty zostają
  w poprzednim, przenieś je ręcznie albo dopisz konto do rejestru.

- **`list-accessible` zwraca strefę czasową i walutę** (`customer.time_zone`,
  `customer_client.currency_code`). Strefa jest polem nośnym: okna `--days` liczone są
  w strefie konta, więc rejestr bez niej rozjeżdża się o dzień dla kont spoza strefy
  operatora.

### Naprawione

- **`gads-wykluczenia-hasel` oceniał konta leadowe ROAS-em.** Typ konta był zgadywany
  z wartości konwersji (`> 0` = ecom), więc konto leadgen ze sztywno przypisaną wartością
  leada (np. „formularz = 200 zł") było traktowane jak sklep. Heurystyka usunięta; bez
  `businessType` w configu i bez `--typ` skrypt przyjmuje leadgen i wypisuje ostrzeżenie,
  a typ ustala Claude tą samą drogą co w nowym skillu.

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
  `--account=zielonyogrod` w Adsach i `--property=zielonyogrod` w GA4. Gdy property są
  rozrzucone po kilku loginach Google, każdy login autoryzujesz jako osobny profil tokena;
  przy jednym loginie widzącym wszystko profile są zbędne.

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
