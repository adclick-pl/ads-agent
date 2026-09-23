# Changelog

Zmiany w pakiecie Ads-Agent. Najnowsze na górze.

Po `git pull` **zrestartuj Claude Code** — nowe skille pojawiają się dopiero po
restarcie sesji. Szczegóły każdego skilla: `.claude/skills/<skill>/SKILL.md`.

---

## 2026-09-22

### Dodane

- **Odczyt strategii licytacji: `--action=get-bidding`.** `getCampaignBiddingInfo()`
  istniała w `queries.js` od dawna, ale nie była wystawiona w CLI — widział ją wyłącznie
  `update-bidding` jako własny pre-check. Skutek: jedyną drogą do pytania „na czym
  licytuje ta kampania" było `raw-query`, które zwraca `bidding_strategy_type` jako
  **surową liczbę**. Numeracja enumów nie jest stabilna między wersjami API, więc
  dopisanie do niej nazwy z pamięci kończy się odwrotnym wnioskiem: kod `10` wygląda
  na `TARGET_SPEND` z jednej tabeli, a jest `MAXIMIZE_CONVERSIONS`.

  ```bash
  node ".claude/skills/gads-connector/scripts/cli.js" --action=get-bidding \
    --account=zielonyogrod --campaign=1234567890
  ```

  Zwraca nazwę strategii, tCPA/tROAS, flagę strategii portfelowej i surowy kod enuma.
  Akcja jest w `READ_ONLY_ACTIONS`, więc nie dokleja stopki o symulacji.

### Zmienione

- **`getCampaignBiddingInfo()` nazywa strategię (`typeName`).** Dotąd świadomie tego nie
  robiła, w obawie przed złą etykietą — ale odpowiadała wtedy tylko przez `strategyField`,
  wnioskowany z obecności **celu**. Kampania na Maksymalizacji konwersji **bez tCPA** —
  układ domyślny i najczęstszy — wychodziła więc jako nierozpoznana. Nazwa idzie teraz
  z `enums.BiddingStrategyType` biblioteki `google-ads-api`, czyli z tego samego pakietu
  co klient API: numeracja nie ma jak się rozjechać, inaczej niż przy mapie pisanej ręcznie.

  `strategyField` zostaje i odpowiada na węższe pytanie — do którego pola `oneof` **pisać**
  przy zmianie strategii, a nie co jest ustawione. Rozróżnienie opisane w docblocku.

- **`gads-wykluczenia-hasel`: ocena AI nie wyklucza hasła, które sprzedało.** Hasło
  z co najmniej 1 konwersją w skali roku nie trafia już do pliku oceny, a werdykt
  z wcześniejszej rundy nie robi z niego „pewnego" — schodzi do „do sprawdzenia".
  Bez tego ocena jakościowa przebijała twardy wynik: hasło brandowe konkurencji
  z pewnością 92% („nie mamy tej marki w feedzie") i 9,5 konwersji w roku szło na listę
  pewnych, a wykluczenie zabiłoby sprzedaż. Próg jest na **całej** konwersji — ułamek
  z atrybucji to udział w sprzedaży, nie sprzedaż. Pula haseł do oceny jest teraz dwa
  razy większa niż budżet pliku wymiany, bo część odpada na filtrze rocznym.

- **`gads-wykluczenia-hasel`: skan roczny bierze kryterium, nie ranking.** Obejmuje
  **każde** hasło kampanii z kosztem w 30 dniach ponad progiem kliknięć (cap 1000
  najdroższych na kampanię, ucięcie widać w logu). Wcześniej brał top 30 wg wyświetleń
  + top 30 wg kosztu — a sygnał roczny z definicji celuje w OGON, czyli w hasło,
  którego 30 dni nie zgłosi, bo ma za mało kliknięć w miesiącu. Zmierzone pominięcie:
  31% kosztu haseł na koncie Search i 112 ze 147 haseł kwalifikowalnych w kampanii PMax.

- **`gads-wykluczenia-hasel`: `config.json` szukany niezależnie od układu katalogów.**
  `loadClientConfig()` sprawdza kolejno katalog pliku z `--kontekst`, katalog wyżej
  i domyślny `Klienci/<alias>/`. Wcześniej ścieżka była sztywna, więc skill uruchomiony
  spoza pakietu nie widział `businessType` klienta i szedł fallbackiem na leadgen,
  mimo że config stał obok pliku kontekstu.

- **`get-campaigns` pokazuje nazwy zamiast kodów.** Kolumny `Status` i `Typ` wypisywały
  `2` i `14` zamiast `ENABLED` i `DEMAND_GEN`.

  `getCampaigns()` zwraca teraz dodatkowo `statusName` i `typeName`, dekodowane przez
  `enums.CampaignStatus` i `enums.AdvertisingChannelType`. **Pola `status` i `type`
  zostały surowe** — kod raportowy konsumuje je jako liczby i kluczuje po nich własne
  tabele kanałów, więc podmiana w miejscu wyczyściłaby te kolumny po cichu. Nowe pola
  stoją obok starych, kontrakt bez zmian.

## 2026-09-10

### Dodane

- **Reklamy produktowe Demand Gen: `--action=add-demand-gen-product-ads`.**
  Konektor umiał w kampanii DemGen wszystko poza jedną rzeczą, która decyduje o tym,
  czy remarketing jest *dynamiczny*: reklamę produktową. `add-demand-gen-ads` tworzy
  wariant wideo/multi-asset, a ten pokazuje tę samą kreację całej grupie odbiorców.
  Produkty z feedu renderuje dopiero `DEMAND_GEN_PRODUCT_AD` — i tego typu nie dało
  się dotąd utworzyć inaczej niż w panelu. Oba typy mogą stać w jednej grupie.

  ```bash
  # symulacja — Google sprawdza strukturę przez validate_only
  node ".claude/skills/gads-connector/scripts/cli.js" --action=add-demand-gen-product-ads \
    --account=zielonyogrod --input=produktowe.csv --domain=zielonyogrod.example

  # zapis
  node ".claude/skills/gads-connector/scripts/cli.js" --action=add-demand-gen-product-ads \
    --account=zielonyogrod --input=produktowe.csv --domain=zielonyogrod.example --commit
  ```

  CSV: `ad_group_id,final_url,headline,description,logo_asset_id,business_name`
  plus opcjonalne `cta,breadcrumb1,breadcrumb2,status,name`.

  Reklama produktowa ma **jeden** nagłówek i **jeden** tekst (wideo bierze listy do
  pięciu), a pole CTA jest w liczbie pojedynczej — `call_to_action`, nie
  `call_to_actions`. To dwie pułapki, przez które przepisanie kodu z wariantu wideo
  kończy się odrzuceniem przez API. Limity znaków te same co dla wideo, plus 15 na
  każdy opcjonalny breadcrumb (`DEMAND_GEN_LIMITS.breadcrumbChars`); walidację
  tekstu robi ta sama `checkDemandGenAdTexts()`, wywołana na jednoelementowych
  listach — jeden zestaw reguł dla obu typów reklam.

  Akcja odmawia w dwóch sytuacjach, zamiast pozwolić API zwrócić surowy błąd albo —
  co gorsza — utworzyć reklamę, która nic nie wyświetli:
  grupa leży w kampanii, która nie jest Demand Gen, oraz grupa nie ma jeszcze kanału
  produktowego (→ najpierw `add-listing-groups`). Idempotentna po
  (grupa + nagłówek + Final URL), więc ponowne uruchomienie nie mnoży reklam.

  Do sprawdzania duplikatów doszło osobne zapytanie `getExistingDemandGenProductAds()`,
  zamiast rozszerzania `getExistingDemandGenAds()`: oba typy mają inną tożsamość —
  reklamę wideo identyfikuje zasób filmu, produktową nagłówek. Jedno zapytanie na
  oba kształty zwracałoby wiersz z połową pól pustych i zgadywanie po stronie
  wywołującego.

- **Zmiana strategii licytacji istniejącej kampanii: `--action=update-bidding`.**
  Konektor umiał ustawić strategię tylko przy zakładaniu kampanii
  (`create-campaigns`) — mapowanie było wpisane na sztywno w środku tej akcji, więc
  przestawienie żywej kampanii trzeba było klikać w panelu. Teraz jest osobna akcja,
  a samo mapowanie żyje we wspólnej funkcji `setBiddingStrategy()`, z której
  korzystają obie ścieżki.

  ```bash
  # symulacja: pokazuje plan from→to i ostrzeżenia
  node ".claude/skills/gads-connector/scripts/cli.js" --action=update-bidding \
    --account=zielonyogrod --campaign=987654321 --strategy=MAXIMIZE_CONVERSION_VALUE

  # zapis, z celem ROAS 650%
  node ".claude/skills/gads-connector/scripts/cli.js" --action=update-bidding \
    --account=zielonyogrod --campaign=987654321 --strategy=MAXIMIZE_CONVERSION_VALUE \
    --target-roas=6.5 --commit
  ```

  Strategie: `MAXIMIZE_CLICKS`, `MAXIMIZE_CONVERSIONS`, `MAXIMIZE_CONVERSION_VALUE`,
  `MANUAL_CPC`. Cel (`--target-cpa`, `--target-roas`, `--cpc-bid-ceiling`) jest
  opcjonalny i **pominięcie go znaczy „bez celu"** — to właściwy start dla kampanii,
  która ma za mało danych, by w cokolwiek celować. Symulacja wypisuje obecną
  strategię obok nowej i dwa ostrzeżenia, gdy są na miejscu: że przełączenie
  restartuje fazę uczenia i że zdjęcie celu przestaje ograniczać wydatek.

  Akcja odmawia w dwóch sytuacjach, zamiast pozwolić API zwrócić surowy błąd:
  kampania podpięta pod strategię **portfolio** (trzeba ją najpierw odpiąć w panelu)
  oraz kampania robocza/eksperymentalna (Google i tak odrzuca takie zmiany przez
  `CANNOT_MODIFY_FOR_TRIAL_CAMPAIGN`).

- **Zmiana nazwy kampanii: `--action=rename-campaign`.** Drobiazg, którego dotąd nie
  dało się zrobić z konektora, a wraca za każdym razem, gdy kampania przestaje robić
  to, co zapowiada jej nazwa — na przykład gdy nazwa niesie strategię licytacji, która
  już nie obowiązuje, albo typ kampanii, który jest dziś tylko jej częścią.

  ```bash
  node ".claude/skills/gads-connector/scripts/cli.js" --action=rename-campaign \
    --account=zielonyogrod --campaign=987654321 --name="[Search]" --commit
  ```

  Symulacja pokazuje starą nazwę obok nowej. Akcja odmawia, gdy nazwa jest już zajęta
  przez inną kampanię — Google wymaga unikalnych nazw wśród nieusuniętych — i nie robi
  nic, gdy nazwa się nie zmienia.

### Naprawione

- **`create` i `update` wymagają różnego zapisu „brak celu".** Przy zakładaniu
  kampanii pusty obiekt (`maximize_conversion_value: {}`) jest poprawny, ale przy
  aktualizacji klient buduje maskę pól z wysyłanego obiektu i taka maska wskazuje na
  pole, które ma podpola — API odrzuca to jako `FIELD_HAS_SUBFIELDS`. Na ścieżce
  aktualizacji podpole jest więc nazwane wprost i ustawione na 0
  (`{ target_roas: 0 }`), co jest sposobem API na wyrażenie „bez celu".
  `setBiddingStrategy()` przyjmuje `{ forUpdate: true }` i rozróżnia oba przypadki.

- **Testy asynchroniczne w `smoke-test.js` przechodziły zawsze.** `check()` wywołuje
  ciało testu, ale nie czeka na obietnicę, więc test z `async` kończył się zielonym
  ptaszkiem niezależnie od asercji w środku. Doszło `checkAsync()` — używaj go
  (z `await`) wszędzie tam, gdzie ciało testu jest asynchroniczne.

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
