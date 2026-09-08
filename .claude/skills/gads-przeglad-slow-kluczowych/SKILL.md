---
name: gads-przeglad-slow-kluczowych
description: >
  Audyt SŁÓW KLUCZOWYCH dodanych do konta Google Ads (HTML). Same liczby, bez oceny AI.
  Trzy panele w dwóch częściach: OBRAZ KONTA (podsumowanie + rozkład typów dopasowania
  bez brandu, główne źródła konwersji) i CO CIĄĆ (kandydaci do wstrzymania, rozbici
  na kampanie, z podziałem „pewne" / „do sprawdzenia" oraz ochroną słów, które w którymś
  z okresów trzymają cel).
  USE WHEN użytkownik prosi o „audyt słów kluczowych", „przegląd słów kluczowych",
  „które słowa wstrzymać", „co przepala w słowach kluczowych",
  „/gads-przeglad-slow-kluczowych".
  NIE używaj gdy użytkownik pyta o WYSZUKIWANE HASŁA / negatywy (→ `gads-wykluczenia-hasel`)
  ani o SZUKANIE NOWYCH słów kluczowych — inny proces.
  Triggers: „audyt słów kluczowych", „przegląd słów kluczowych", „które słowa wstrzymać",
  „/gads-przeglad-slow-kluczowych".
---

# Skill: gads-przeglad-slow-kluczowych

Audyt **słów kluczowych dodanych do konta** Google Ads. Output: raport HTML + CSV
z kluczami kryteriów kandydatów do wstrzymania (wejście dla `gads-connector`).

Obiektem analizy jest słowo kluczowe, które ktoś do konta **wpisał** — nie hasło, które
je wywołało. To rozróżnienie decyduje o wszystkim innym w tym skillu.

**Założenie: skoro ktoś dodał słowo kluczowe, jest ono zgodne z ofertą.** Dlatego skrypt
nie ocenia dopasowania tematycznego i **nie korzysta z modelu językowego** — ocenia
wyłącznie liczby. Jeden przebieg, ~15–30 s.

**Zasada porządkująca: każdy panel musi prowadzić do działania.** Skill świadomie NIE
pokazuje rzeczy ciekawych, ale bezczynnych — martwych słów (zwykle nic się z nimi nie
da zrobić) ani duplikatów między grupami (to problem struktury konta, nie słów). Przy
dokładaniu czegokolwiek do raportu pytanie brzmi „jaką decyzję z tego podejmę", a nie
„czy to ciekawe".

## Różnica vs `gads-wykluczenia-hasel`

Najczęstsza pomyłka: **„co wykluczyć" to `gads-wykluczenia-hasel`, nie ten skill.**
Wykluczenia dotyczą **haseł wyszukiwania**, które wywołały reklamę — użytkownicy je
wpisali. Tutaj chodzi o **słowa kluczowe**, które dodał operator konta — te się
wstrzymuje albo zawęża dopasowanie, a nie wyklucza.

## KROK 1 — Ustal konto

Alias z `.claude/accounts.json` albo 10-cyfrowy customer ID. Jeśli użytkownik nie podał
— zapytaj. Aliasy widać w rejestrze:

```bash
node -e "const {loadAccounts}=require('./.claude/skills/gads-connector/scripts/accounts.js'); loadAccounts().forEach(a=>console.log(a.key,'—',a.name))"
```

## KROK 2 — Uruchom

```bash
node .claude/skills/gads-przeglad-slow-kluczowych/scripts/przeglad-slow-kluczowych.js \
  --account={alias} --open
```

`--open` otwiera raport w przeglądarce (macOS). Bez tego otwórz **ścieżkę wypisaną
w logu** — nazwa folderu klienta może różnić się od aliasu.

Konto bez słów kluczowych (same PMax / Shopping / DSA) kończy się komunikatem
„nie ma czego audytować" i nie generuje pustego raportu.

**Opcje kluczowe** (poza `--account` i `--open`):

- `--typ=ecom|leadgen` — nadpisuje `businessType` z `config.json` i wykrywanie
  automatyczne (domyślnie: konto z wartością konwersji = ecom).
- `--cel-roas=3.5` (ecom) / `--cel-cpa=80` (leadgen) — nadpisuje `targetRoas`/`targetCpa`
  z `config.json`.
- `--out=<folder>` — inny folder zapisu (domyślnie: `Klienci/{alias}/Optymalizacja`).
- `--accounts-dir=<ścieżka>` — katalog, od którego szukamy `.claude/accounts.json`.

## KROK 3 — Zreferuj wyniki

Skrypt wypisuje w logu liczniki wszystkich paneli. **Powiedz użytkownikowi, co wyszło,
zamiast odsyłać go do pliku** — zaczynając od tego, co wymaga decyzji.

Gdy konto ma mało ruchu w Search, panele decyzyjne wyjdą puste i **to jest prawidłowy
wynik** — nie ma tam czego optymalizować per słowo. Nie szukaj wtedy na siłę czegoś
do pokazania.

Raport jest dokumentem roboczym operatora. **Skrypt niczego nie modyfikuje w koncie** —
wstrzymania wykonuje w kroku 3,5 konektor `gads-connector`, po potwierdzeniu.

## KROK 3,5 — Zaproponuj wstrzymanie

Obok raportu leży `…-slowa-kluczowe-kandydaci.csv` z kluczami kryteriów
(`adGroupId~criterionId`) — bez nich konektor nie zidentyfikuje słowa.

1. **Zaproponuj listę „pewnych"** — po nazwach, z powodem, w kolejności kosztu rocznego.
   Przeszły twardy sygnał, więc idą do propozycji domyślnie.
2. **O „do sprawdzenia" zapytaj osobno** — czy dorzucić któreś z nich. Nigdy nie
   wciągaj ich do propozycji domyślnie: nazwa listy jest dosłowna, a decyzja wymaga
   kontekstu, którego skrypt nie ma.
3. **Czekaj na wskazanie.** Brak odpowiedzi nie jest zgodą, a „wstrzymaj wszystko"
   dotyczy tylko listy pewnych, chyba że operator powie inaczej.
4. Wstrzymaj potwierdzone — jedno wywołanie, kryteria po przecinku:

   ```bash
   node .claude/skills/gads-connector/scripts/cli.js \
     --action=update-keyword-status --account={alias} \
     --criterion=<adGroupId~criterionId>[,<...>] --status=PAUSED
   ```

   Powyżej kilkunastu pozycji: `--input=mapa.csv` (kolumny `criterion,status`).
   `--dry-run` pokazuje, co poszłoby do API, bez zmiany w koncie.
5. **Wstrzymanie, nie usunięcie.** `PAUSED` zostawia historię i wraca jednym
   `--status=ENABLED`. Usunięte kryterium traci ciągłość danych.
6. Przejdź do KROK 4 — zapis do `status-slowa-kluczowe.md` z liczbami z CSV.

## KROK 4 — Zapisz to, co wstrzymane

Wstrzymanie to jedyna informacja z tego audytu, która ma wartość **po** zamknięciu
raportu: przy rozszerzaniu kierowania trzeba wiedzieć, czego już próbowaliśmy. Konto
pamięta sam status `PAUSED` — nie pamięta liczb ani powodu.

Plik: `Klienci/{alias}/Optymalizacja/status-slowa-kluczowe.md`. Utwórz z szablonem,
jeśli go nie ma.

**Zapisuj wyłącznie słowa, które operator faktycznie wstrzymał w koncie** — nie
kandydatów z raportu. Plik niekompletny jest nieszkodliwy; plik z niewdrożonymi
wstrzymaniami kłamie. Gdy operator wdroży zmiany w innej sesji, dopisz je wtedy.

Format wpisu (jedna linia, grepowalna po frazie):

    - `[fraza]` · Kampania › Grupa · wstrzymane RRRR-MM-DD — rok: N kl., KOSZT, K konw. (WYNIK vs poprzeczka X) → powód

Dopasowanie w notacji Google Ads: `[ścisłe]`, `"do wyrażenia"`, przybliżone bez
znaczników — to samo słowo w dwóch dopasowaniach to dwie różne decyzje.

Liczby bierz **roczne**, nie z 30 dni — po pół roku miesięczna próbka nic nie mówi.
Powód przepisz z kolumny „Uwagi" raportu, skrócony do jednego zdania.

---

## Konfiguracja klienta

Ścieżka: `Klienci/{alias}/config.json`. Wszystkie pola opcjonalne — bez configu skrypt
wykryje typ konta automatycznie, a poprzeczką będą średnie roczne kampanii.

```json
{
  "businessType": "ecom",
  "targetRoas": 3.5,
  "industry": "sklep ogrodniczy"
}
```

- `businessType`: `ecom` / `ecommerce` / `leadgen`. Bez tego — konto raportujące
  wartość konwersji jest traktowane jak ecom.
- `targetRoas` (ecom): poprzeczka dla całego konta. Cel ustawiony **w kampanii**
  (tROAS/tCPA ze strategii licytacji) i tak bije cel z configu.
- `targetCpa` (leadgen): jak wyżej, tylko dla kosztu konwersji.
- `industry`: krótki opis do nagłówka raportu.

---

## Zakres danych — co wchodzi do analizy

Dwie reguły decydują o tym, co skrypt w ogóle uzna za materiał. Obie są nieoczywiste
i obie kiedyś dawały złe wyniki.

**1. „Aktywne" znaczy ENABLED na TRZECH poziomach** — słowa, grupy i kampanii. Sam
status słowa nie wystarcza: kryterium bywa ENABLED w kampanii wstrzymanej albo
usuniętej i wtedy nie może się wyświetlić, więc żadna decyzja z tego raportu go nie
dotyczy. Skala problemu bywa duża — na koncie z długą historią wstrzymane słowa
potrafią być **większością** listy.

Ale słowa z kampanii wstrzymanych **są pobierane** i liczą się do **rocznych średnich
kampanii** — to prawdziwy koszt konta i punkt odniesienia ma go uwzględniać. Odcięte
są wyłącznie od paneli proponujących działanie i od KPI panelu 1. W kodzie realizuje
to jedna flaga `kw.aktywne`, policzona raz przy budowie mapy; panele nie mają własnych
warunków statusu.

**2. Konwersje < 0,1 liczą się jako zero** (`PROG_KONWERSJI`). Google atrybuuje
ułamki, więc słowo z setną częścią konwersji pokazywało „0,0 konw." obok
**pięciocyfrowego kosztu konwersji** — liczba formalnie poprawna, w tabeli czytana
jak błąd skryptu. Zerowanie odpala właściwy sygnał („rok bez konwersji") zamiast
wariantu z absurdalną poprzeczką. **Wartość konwersji zostaje nietknięta** — to
realny przychód i jego sumy mają się zgadzać z interfejsem Google Ads.

---

## Co jest w raporcie

Trzy panele w dwóch częściach, każdy zwijany, plus pasek nawigacji z licznikami.
Wszystkie otwarte domyślnie.

**Raport pisany jest dla specjalisty Google Ads.** Nie tłumaczy pojęć branżowych
i nie uzasadnia metody — komentarz zostaje tylko wtedy, gdy niesie liczbę (ile
danych pominięto), zastrzeżenie do wiarygodności metryki albo wskazanie następnego
kroku.

### Obraz konta

**1. Podsumowanie.** Ile słów aktywnych (ENABLED na trzech poziomach), koszt i wynik
30 dni, jaki udział wydatku idzie w słowa bez konwersji. Do tego rozkład typów
dopasowania — liczba słów obok udziału w koszcie i wyniku.

**Dwa ostatnie kafelki to CEL i WYNIK ROCZNY, i stoją obok siebie celowo** — cel bez
wyniku jest deklaracją, wynik bez celu liczbą bez oceny. Gdy celu nie ma w configu,
kafelek mówi wprost, że poprzeczką będą średnie roczne. Wynik roczny to ROAS dla ecom,
koszt konwersji dla leadgen.

Wynik roczny liczony jest **ze słów kluczowych, nie z całego konta**, bo to dokładnie
ta liczba, która staje się poprzeczką przy braku celu. Różnica bywa wielokrotna:
konto leadgen potrafi raportować 1500+ konwersji rocznie, a jego słowa kluczowe 100 —
reszta to PMax i DSA. Dlatego podtytuł podaje wolumen, z którego średnia jest
policzona.

**Rozkład typów liczony jest BEZ KAMPANII BRANDOWYCH** (rozpoznawanych po słowie
„brand" w nazwie); notka nad tabelą mówi, ile słów i ile kosztu pominięto. Brand
siedzi prawie w całości w dopasowaniu ścisłym i ma nieporównywalnie wysoki wynik,
więc wciągnięty do tej tabeli odpowiada na złe pytanie. Tabela ma odpowiadać na
jedno pytanie: czy szersze dopasowania zarabiają na siebie **na ruchu niebrandowym**.

**2. Główne źródła konwersji.** Top 10 wg wyniku (ecom: wartość konwersji,
leadgen: konwersje), **bez kampanii brandowych**. Przed listami do cięcia — żeby
było widać, czego nie ruszać. Brand zawsze wygrywa ranking wyniku, bo to ruch od
ludzi, którzy już znają markę: wypełniłby listę i przykrył to, po co ona jest —
które słowa realnie **pozyskują nowych klientów**.

### Co ciąć

**3. Kandydaci do wstrzymania.** Główny panel. Ocena z **30 dni**, rok obok jako
kontekst.

Dwie listy — „pewne" i „do sprawdzenia" — obie **rozbite na kampanie**, bo decyzję
o wstrzymaniu podejmuje się w kontekście jednej kampanii: każda ma własny cel,
budżet i rolę. Nagłówek sekcji kampanii pokazuje wyłącznie **poprzeczkę tej kampanii
wraz ze źródłem**. Kampanie idą wg kosztu rocznego malejąco — najpierw te, gdzie
stawka jest największa.

| Sygnał | Poziom | Dlaczego |
|---|---|---|
| 30 dni bez konwersji, koszt ≥ 1,5× kosztu konwersji kampanii, min. 5 kliknięć | **do sprawdzenia**, **pewny** gdy rok potwierdza (też zero konwersji) | Miesiąc to za mało danych na samodzielną decyzję |
| Rok bez konwersji, koszt ≥ 3× rocznego kosztu konwersji | **pewny** | Systematyczne przepalanie, którego 30 dni nie zgłosi |
| Rok bez konwersji, koszt 2–3× | **do sprawdzenia** | Przy niskim koszcie konwersji taka kwota uzbiera się przez rok z samej wariancji |
| Konwersje są, ale roczny ROAS < 50% poprzeczki (leadgen: koszt konw. > 2×) | **do sprawdzenia** | Słabe, ale nie zerowe — decyzja zależy od roli słowa |

Słowo trafia do „pewnych", gdy ma **choć jeden pewny sygnał** — trzy niepewne
sygnały to nadal niepewność, więc heurystyki się nie sumują.

**Ochrona przez wynik — działa w obie strony i jest CICHYM FILTREM.** Słowo
trzymające cel w **którymkolwiek** okresie znika z list i nigdzie się w raporcie nie
pojawia (licznik zostaje tylko w logu). Każdy okres ma inną przewagę: rok ma więcej
danych, 30 dni ma świeższe.

| Okres broni gdy | Próg | Dlaczego taki |
|---|---|---|
| **rok** trzyma cel, miesiąc słaby | ROAS ≥ 75% poprzeczki · leadgen: koszt konw. ≤ 1,5× | Próbka duża, więc próg łagodny |
| **30 dni** trzyma cel, rok słaby | ROAS ≥ **pełna** poprzeczka · leadgen: koszt konw. ≤ poprzeczka · **min. 1 pełna konwersja** | Próbka mała, więc próg ostry — inaczej jedna szczęśliwa sprzedaż broniłaby słowa |

Kierunek „30 dni broni" chroni słowa, które **właśnie zaczęły dowozić** — bez niego
raport proponował wstrzymanie słów, w których większość rocznych konwersji siedziała
w ostatnich 30 dniach.

**Poprzeczka — hierarchia od najbardziej konkretnej:**

1. **cel ustawiony w kampanii** (tROAS / tCPA ze strategii licytacji),
2. cel konta z `config.json` klienta,
3. średnia roczna kampanii,
4. średnia roczna konta.

**Cel kampanii bije cel konta i to jest kluczowe.** Gdy konto ma jeden cel, a
kampanie własne i niższe, porównywanie słabszej kategorii do celu konta produkuje
listę „do sprawdzenia" złożoną z całej tej kategorii. Słaba kategoria jako całość
to inny problem (struktury konta / budżetów), nie audyt pojedynczych słów.

Raport pokazuje w kolumnie „Uwagi", której poprzeczki użył — `cel kampanii`,
`cel konta`, `śr. roczna kampanii` albo `śr. roczna konta`. Log wypisuje, ile
kampanii ma własny cel.

## Czego świadomie NIE ma

| Temat | Dlaczego wycięty |
|---|---|
| **Martwe słowa** (zero wyświetleń przez rok) | Najdłuższa lista i najmniej decyzyjna. Zwykle nic się z tym nie robi |
| **Duplikaty i kanibalizacja** | To problem **struktury konta**, nie słów kluczowych |
| **Wstrzymane słowa, które kiedyś zarabiały** | Ponowne włączanie to zwykle decyzja o przebudowie konta |
| **Tabela „bronione przez wynik"** | Lista słów, których **nie** wstrzymujemy — panel bez działania. Obrona została jako cichy filtr, licznik widać w logu |
| **Słowa z kampanii wstrzymanych/usuniętych** na listach działań | Nie mogą się wyświetlić, więc żadna decyzja ich nie dotyczy |
| **Quality Score** (alerty, histogram) | Nie odpowiada na pytanie „co zrobić ze słowem" — słowo z niskim QS zostaje w koncie, a pracy wymaga reklama, grupa albo strona docelowa |
| **Potencjał z niedowydanego budżetu** | Odpowiada na „gdzie dołożyć", nie na „co wstrzymać" — inna decyzja i inny moment pracy |
| **Wstrzymywanie hurtem bez potwierdzenia** (kolumna `status` w CSV, „do sprawdzenia" domyślnie) | Sygnały niepewne nie sumują się do decyzji, a wstrzymanie na ślepo cofa się drożej, niż kosztuje potwierdzenie |

## Architektura

- **Warstwa danych** → konektor `gads-connector` (obok tego skilla), przez
  `runRawQuery`. Słowa kluczowe istnieją tylko w kampaniach Search (i Display
  z kierowaniem na hasła), więc wystarczy jedno źródło metryk.
- **Warstwa zapisu** → ten sam konektor, akcja `update-keyword-status` (KROK 3,5).
  Skrypt zostaje bezstanowy i tylko czytający; mutacja jest osobnym, potwierdzonym
  wywołaniem.
- **Lista słów idzie z `ad_group_criterion`, metryki z `keyword_view`** (join po
  `adGroupId~criterionId`). To nie kosmetyka: **`keyword_view` zwraca RÓWNIEŻ
  WYKLUCZAJĄCE słowa kluczowe**. Gdyby lista szła stamtąd, negatywy trafiłyby do
  analizy jako słowa bez wyników — na koncie aktywnie wykluczającym potrafi to
  być znacząca część listy.
- **Cele kampanii** → osobne zapytanie `FROM campaign` o
  `maximize_conversion_value.target_roas`, `target_roas.target_roas`,
  `maximize_conversions.target_cpa_micros`, `target_cpa.target_cpa_micros`.
- **`search_budget_lost_impression_share` NIE ISTNIEJE na poziomie słowa
  kluczowego** — API odrzuca zapytanie (`query_error 49`). Dostępne są tylko
  `search_impression_share` i `search_rank_lost_impression_share`, więc utratę
  przez budżet liczymy jako resztę: `1 − udział − utrata przez ranking`.
- **Średnie kampanii liczone ze słów kluczowych tej kampanii**, nie z całej
  kampanii — dorzucanie ruchu z DSA czy z odbiorców zaburzyłoby punkt odniesienia.
  Fallback na średnią konta jest konieczny, bo kampania bez ani jednej konwersji
  nie ma własnego kosztu konwersji, a to właśnie kampanie przepalające budżet
  w całości.
- **Limit tabel** — 100 wierszy, z informacją o pominięciu i kryterium sortowania.
- **Kolor niesie informację, nie dekoruje.** Kolumna wyniku (ROAS / koszt konwersji)
  w panelu 3 jest tintowana względem poprzeczki **tej kampanii**: ≥ cel zielony,
  50–100% żółty, < 50% czerwony. Koszt dostaje pasek skali względem najdroższego
  słowa **całej sekcji** (nie kampanii — inaczej drobna kampania miałaby paski
  tak długie jak kilkanaście razy większa).

### Motyw ciemny — poziomy tła dobiera się jasnością L*, nie kontrastem

Przy ciemnych tłach stała `+0,05` we wzorze na kontrast WCAG zjada różnicę: każde
dwa sąsiednie odcienie wychodzą ~1,1:1, mimo że oko widzi je jako różne. Miernikiem
jest **jasność percepcyjna L\***, cel: **Δ ≈ 5 L\*** między poziomami (bg → karta
→ nagłówek tabeli → sekcja → obramowanie).

Dwie pułapki znalezione pomiarem:

- **Nagłówek raportu musi być JAŚNIEJSZY od tła** w dark (odwrotnie niż w light),
  inaczej znika.
- **`filter: brightness()` działa tylko w jedną stronę.** `brightness(0.97)` na
  hoverze przyciemniało wiersz w OBU motywach, więc w ciemnym podświetlenie gasło
  zamiast rozjaśniać. Zastąpione zmienną `--overlay` nakładaną przez
  `box-shadow: inset` — rgba czarna w light, biała w dark. **Nie wprowadzaj
  `filter: brightness()` z powrotem.**

## Output

- `Klienci/{alias}/Optymalizacja/YYYY-MM-DD-slowa-kluczowe.html` — raport.
- `Klienci/{alias}/Optymalizacja/YYYY-MM-DD-slowa-kluczowe-kandydaci.csv` — klucze
  kryteriów kandydatów (`criterion, slowo, dopasowanie, kampania, grupa, poziom,
  klikniecia_rok, koszt_rok, konw_rok, wynik_rok, powod`). Wejście dla KROK 3,5.
  `slowo` w notacji Google Ads (`[ścisłe]`, `"do wyrażenia"`, przybliżone bez
  znaczników).
- `Klienci/{alias}/Optymalizacja/status-slowa-kluczowe.md` — pamięć wstrzymań,
  pisana ręcznie w KROK 4. **Nieczytana przez skrypt.**

Folder wyjściowy można nadpisać flagą `--out=<folder>`.

## Powiązane

- Konektor danych i mutacji: skill `gads-connector` (obok).
- Wyszukiwane hasła i negatywy: skill `gads-wykluczenia-hasel` (obok) — inny
  obiekt (hasło vs słowo kluczowe).
