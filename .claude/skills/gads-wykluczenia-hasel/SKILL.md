---
name: gads-wykluczenia-hasel
description: >
  Znajduje wykluczające słowa kluczowe (negatywy) dla konta Google Ads. Raport HTML
  z dwiema listami: „Pewne — do wykluczenia" i „Do sprawdzenia", oba ze statystykami
  z 30 dni i kontekstem rocznym, plus lista gotowa do wklejenia w Google Ads. Łączy
  sygnały liczbowe (koszt bez konwersji, rok bez konwersji, dopasowanie do słów
  kluczowych) z oceną AI, która zna ofertę klienta.
  USE WHEN użytkownik prosi o "wykluczenia", "negatywy", "wykluczające słowa kluczowe",
  "co wykluczyć", "hasła do wykluczenia", "negative keywords", "na czym przepalam budżet",
  "/gads-wykluczenia-hasel", albo podaje konto i prosi o listę negatywów.
  NIE używaj gdy użytkownik chce ogólny przegląd skuteczności konta, raport dla klienta
  ani wykluczeń miejsc docelowych — ten skill robi wyłącznie listę wykluczających
  słów kluczowych.
  Triggers: "wykluczenia", "negatywy", "wykluczające słowa kluczowe", "co wykluczyć",
  "negative keywords", "/gads-wykluczenia-hasel"
---

# Skill: gads-wykluczenia-hasel

Jedno zadanie: **powiedzieć, które wyszukiwane hasła wykluczyć z konta Google Ads** —
i pokazać, na jakiej podstawie. Output: raport HTML z dwiema listami + lista do
skopiowania. Skrypt **tylko czyta** konto; wykluczenia dodaje człowiek.

Wersja publiczna (lead magnet) przeglądu haseł. Świadomie **nie ma tu**: TOP-ów haseł
konta i kampanii, paneli „wszystkie hasła", motywów n-gramowych, propozycji nowych
słów kluczowych ani miejsc docelowych. Kto potrzebuje pełnego przeglądu — patrz
tabela niżej.

## Co robi, a czego nie

**Robi:** znajduje wyszukiwane hasła, na które konto przepala budżet, i dzieli je na te
z twardym dowodem i te wymagające decyzji człowieka. Do każdego podaje powód i liczby.

**Nie robi:** nie pokazuje TOP-ów haseł, motywów, propozycji nowych słów kluczowych ani
wykluczeń miejsc docelowych. Nie zmienia niczego na koncie — wykluczenia dodajesz sam.

---

## KROK 1 — Ustal konto

Jeśli użytkownik nie podał, zapytaj. Konto wskazuje się aliasem z `.claude/accounts.json`
albo 10-cyfrowym customer ID.

```bash
node ".claude/skills/gads-wykluczenia-hasel/scripts/wykluczenia-hasel.js" --account=1234567890 --open
```

Uruchamiaj z korzenia pakietu (tam, gdzie `package.json`) — wtedy skrypt sam znajdzie
`.claude/accounts.json`. Raport trafia do `Klienci/{alias}/Optymalizacja/`, opis oferty
czytany jest z `Klienci/{alias}/Kontekst/kontekst.md`, a cele z `Klienci/{alias}/config.json`.
Obie ścieżki zmieniają flagi `--out` i `--kontekst`; pełna lista flag jest na końcu.

Skrypt **tylko czyta** konto — nie potrzebuje uprawnień do zmian i niczego nie modyfikuje.

## KROK 2 — Przepływ (dwuprzebiegowy)

Ocena haseł niepewnych (warstwa 3b) **nie idzie przez płatne API**. Skrypt zapisuje je
do pliku, **oceniasz je Ty w głównym wątku**, drugi przebieg wciąga wynik.

**Podział pracy**

| Zadanie | Kto |
|---|---|
| Ocena haseł, decyzja o wykluczeniu, `pewnosc`, zapis `-negatives.json` | **główny wątek** |
| Aktualizacja `status-kierowanie.md` i `kontekst.md` | **główny wątek** |
| SERP-check 50 najdroższych haseł (`serpCheck: true`) | **5 subagentów po 10 haseł, równolegle** |
| Sprawdzenie, co klient ma w ofercie (drzewo kategorii sklepu) | **1 subagent, w tej samej wiadomości** |

Do subagentów idzie **wyłącznie zbieranie materiału** — SERP-check i przegląd oferty.
Jedno i drugie to kilkadziesiąt tysięcy tokenów jednorazowych wyników, bezwartościowych
po podjęciu decyzji. Decyzja zostaje w głównym wątku, bo tam jest rozmowa z użytkownikiem
(ustalenia, których nie ma w `kontekst.md`), tam widać rozumowanie i tam można je
zakwestionować, zanim hasło trafi na listę wykluczeń.

Wszystkie 6 subagentów spawnuj **w jednej wiadomości** — całość zajmuje wtedy tyle, co
najwolniejszy z nich (~2 min), zamiast sumy.

### Przebieg 1 — uruchom skrypt

Skrypt generuje raport (na razie z samych sygnałów liczbowych) i zapisuje w folderze
raportu:

| Plik | Co to |
|---|---|
| `{data}-wykluczenia.html` | raport |
| `{data}-wykluczenia-uncertain.json` | hasła do oceny + cały kontekst potrzebny do decyzji |
| `kontekst.md` | opis oferty (szablon przy pierwszym uruchomieniu) |
| `status-kierowanie.md` | pamięć między rundami (szablon przy pierwszym uruchomieniu) |

**Jeśli `kontekst.md` powstał pusty — zatrzymaj się i uzupełnij go**, zanim zaczniesz
oceniać hasła. To jedna rzecz, która najmocniej decyduje o jakości wyniku: bez opisu
oferty ocena jest zgadywaniem z nazwy konta. Zbierz treść z rozmowy z użytkownikiem
i z `WebFetch` strony klienta, wypełnij sekcje, pokaż użytkownikowi do potwierdzenia,
dopiero potem oceniaj. Frontmatter (`typ`, `celRoas`, `branza`) też wypełnij —
`typ` decyduje, czy ocena idzie po ROAS, czy po koszcie konwersji.

### Ocena — jeśli `terms` niepuste

Plik `-uncertain.json` zawiera wszystko, czego potrzebujesz: **cały `kontekst.md`**,
**`statusKierowania`** (pamięć z poprzednich rund), pole `instrukcja` oraz listę `terms`
posortowaną **wg kosztu malejąco** — każde hasło z `kampanie`, `impressions`, `clicks`,
`cost`, flagą `serpCheck` i ewentualnym `znaneZeStatusu`.

Hasło występuje w pliku **raz**, a metryki są **zsumowane po wszystkich jego kampaniach**
— to koszt decyduje o kolejności i o przydziale sprawdzeń SERP. Pole `kampanie` mówi,
gdzie hasło się pokazało: oceniaj je wobec celu tej kampanii, jeśli kontekst go opisuje,
a nie tylko wobec całej oferty.

1. **Przeczytaj** `{data}-wykluczenia-uncertain.json` razem z `kontekst` i `statusKierowania`.

2. **Sprawdź, co klient FAKTYCZNIE ma w ofercie** — jednym subagentem, równolegle z SERP-checkiem
   (poniżej). Zadanie: `WebFetch` strony klienta, wypisz drzewo kategorii i rozstrzygnij
   `jest` / `nie ma` / `nie ustalono` dla konkretnych rzeczy, które pojawiły się w hasłach
   spoza rdzenia oferty. Wynik dopisz do `kontekst.md` i do „Ustalenia o ofercie".

   **SERP tego nie zastąpi.** SERP mówi, czego szuka użytkownik; oferta mówi, czy to masz —
   i to drugie rozstrzyga. Realny przypadek (sklep z odzieżą dziecięcą): SERP dla `karuzela
   do łóżeczka` (5 wariantów hasła, 83 zł/mies.) i `torebka dla dziewczynki` (5,66 zł)
   pokazywał wyłącznie sklepy z zabawkami, więc dwa niezależne SERP-checki orzekły „nie
   pasuje do oferty" — a sklep ma jedno i drugie w kategorii Akcesoria. Bez sprawdzenia
   oferty wyleciałoby ~89 zł/mies. trafionego ruchu. Odwrotnie też: „przebranie lwa dla
   dziecka" wygląda na temat dziecięcy, a sklep ma tylko dwa kostiumy halloweenowe —
   i to dopiero sprawdzenie oferty uczyniło z tego hasła pewny negatyw.

   Uwaga: sprawdzenie oferty **nie rozstrzyga wszystkiego**. „cute pluszaki" zostało na
   liście mimo że pluszaki są w ofercie — bo problemem jest intencja (Pinterest, Etsy,
   inspiracje), a nie brak produktu. Oferta odpowiada na „czy to mam", SERP na „po co
   ktoś to wpisuje"; potrzebujesz obu.

3. **SERP-check → 5 subagentów równolegle.** 50 najdroższych haseł ma `"serpCheck": true`
   (mniej, gdy lista jest krótsza). Podziel je na **paczki po 10** i spawnuj **5 subagentów**
   (`Agent`, `subagent_type: general-purpose`) — wszystkie **w jednej wiadomości**, żeby
   ruszyły równolegle; sekwencyjnie trwałoby to 5× dłużej. Każdemu przekaż **tylko jego
   10 haseł** (wypisz je w promptcie — subagent nie musi czytać pliku) plus 2–3 zdania
   o tym, co klient sprzedaje. Zadanie: dla każdego hasła `WebSearch` i **zwięzłe
   streszczenie, nie werdykt**:

   | Pole | Co ma zawierać |
   |---|---|
   | `term` | hasło |
   | `intencja` | dominująca intencja wyników: zakupowa / informacyjna / lokalna / praca / inna — jednym słowem + krótkie doprecyzowanie |
   | `ktoSieWyswietla` | jakiego typu strony i oferty są w wynikach (2–3 kategorie, bez wklejania całych SERP-ów) |
   | `pasujeDoOferty` | `tak` / `nie` / `czesciowo` + jedno zdanie dlaczego |

   Powiedz każdemu **wprost, żeby nie rekomendował wykluczeń** i nie zapisywał żadnych
   plików — ma zwrócić wyłącznie tę tabelę w odpowiedzi. To ~10 wyszukiwań na subagenta,
   ~30–60 s; równolegle całe 50 zajmuje tyle, co wcześniej 10.
   Ograniczenie: WebSearch zwraca wyniki organiczne, nie reklamy — sygnał pomocniczy,
   nie dowód.

4. **Oceń hasła i zapisz** `{data}-wykluczenia-negatives.json` w folderze raportu:

   ```json
   {"negative": [{"term": "…", "powod": "krótko dlaczego", "serp": true, "pewnosc": 85}]}
   ```

   `powod` trafia wprost do kolumny „Uwagi", `serp` decyduje o podpisie („ocena AI" vs
   „ocena AI + SERP"), a **`pewnosc` rozstrzyga, czy hasło trafi do „pewnych" (≥ 80),
   czy do „do sprawdzenia"**. Prostszy format `{"negative": ["hasło"]}` też działa —
   takie hasła lądują w „do sprawdzenia", bo nie deklarują pewności.

5. **Konserwatywnie.** Wyrzucenie dobrego hasła kosztuje klienta po cichu, zostawienie
   słabego kosztuje kilka złotych. Przy braku pewności — nie wykluczaj i nie zawyżaj
   `pewnosc`.

6. **Uwzględnij ustalenia z tej rozmowy.** Jeśli użytkownik powiedział coś, czego nie ma
   w `kontekst.md` („właśnie wchodzimy w kategorię ogrodową, nie wycinaj tego") — to ma
   pierwszeństwo przed plikiem. To główny powód, dla którego ocena została w tym wątku.
   Trwałe ustalenia dopisz do `kontekst.md`, jednorazowe — do `status-kierowanie.md`.

7. **Zaktualizuj `status-kierowanie.md`** (ścieżka w polu `statusPlik`): nowe ustalenia
   o ofercie, sprawdzone hasła które zostawiasz (z powodem i datą), rekomendowane
   wykluczenia i linia w „Historia rund". Hasła **w grawisach, jako wpisy listy** —
   inaczej następna runda ich nie rozpozna i zmarnuje na nie budżet SERP.

### Przebieg 2 — uruchom skrypt ponownie

Ta sama komenda. Teraz skrypt wczyta `-negatives.json` → ocenione hasła trafią do list
jako sygnał „ocena AI". Dodaj `--open`, żeby otworzyć raport.

Czas: ~20–60 s na przebieg + SERP-check subagentów (~30–60 s, bo równolegle) + Twoja ocena.
Jeśli `terms` puste — pomiń ocenę, przebieg 1 to już finalny raport.

## KROK 3 — Podaj wynik

Otwórz **ścieżkę, którą skrypt wypisał** w logu (`✅ Raport zapisany: …`) i streść
użytkownikowi: ile haseł pewnych, ile do sprawdzenia, jaki koszt z 30 dni tego dotyczy
i **w których kampaniach** siedzi najwięcej do odzyskania. Przypomnij, że wykluczenia
dodaje sam — skrypt niczego nie zmienia na koncie.

---

## Co jest w raporcie

**Podsumowanie konta:** ile haseł przeanalizowano i za ile, ile pewnych i do sprawdzenia
(z kosztem), jaki to udział w koszcie konta, ile haseł obronił wynik roczny, stan oceny AI.

**Sekcja per kampania** (zwijana, kampanie z największym kosztem kandydatów na górze),
a w każdej **dwie tabele**:

1. **Pewne — do wykluczenia** — sygnał potwierdzony danymi
2. **Do sprawdzenia — decyduje człowiek** — sygnał niepotwierdzony

Obie posortowane wg kosztu i z pełnymi metrykami: blok **30 dni** (Wyśw. · Kliknięcia ·
Koszt · CTR · Konw. · [ecom: Wart. konw. + ROAS | leadgen: Koszt konw.] · Wsp. konw.),
blok **roczny** (metryki wynikowe) i kolumna **„Uwagi"** z powodami — czerwone = sygnał
pewny, szare = do sprawdzenia. Maksymalnie 100 wierszy na tabelę; ucięcie zawsze opisane.

Podział na kampanie jest i w analizie, i w prezentacji, bo wykluczające dodaje się
w koncie per kampania, a benchmark („drogo") jest lokalny dla kampanii. Nagłówek sekcji
pokazuje typ kampanii, liczbę haseł, koszt i licznik kandydatów. **Kampanie z pewnymi
kandydatami startują rozwinięte**, reszta zwinięta (przycisk „Rozwiń wszystkie" przełącza
wszystkie); kampanie bez żadnych kandydatów nie dostają sekcji — są wymienione jedną
linią pod spodem.

**Listy do skopiowania** — hasła „pewne" w dopasowaniu ścisłym (`[hasło]`), gotowe do
wklejenia w Google Ads: jedna w każdej sekcji kampanii, a przy koncie z kilkoma
kampaniami dodatkowo jedna zbiorcza (tylko dla wspólnej listy wykluczających na poziomie
konta).

## Skąd biorą się kandydaci

| Sygnał | Poziom | Dlaczego |
|---|---|---|
| Wydajność z 30 dni (koszt > 2× CPA bez konwersji · ROAS < 50% celu przy koszcie > 2× kosztu konwersji) | **pewny**, gdy potwierdza to rok: cały rok kosztów bez konwersji | Bez danych rocznych to 30 dni przy progu 5 kliknięć — za cienko na decyzję |
| **Wydajność roczna** (osobny sygnał) | 0 konwersji przez rok: **pewny** od 3× rocznego kosztu konwersji kampanii, **do sprawdzenia** od 2×. Konwersje są, ale wynik roczny mocno pod celem → **do sprawdzenia** | Łapie hasła, których 30 dni nie zgłosi (za mało kliknięć), a które systematycznie przepalają budżet. Między 2× a 3× decyduje człowiek — przy niskim CPA taki koszt uzbiera się w rok z samej wariancji |
| Dopasowanie semantyczne do słów kluczowych grupy | zawsze **do sprawdzenia** | Próg podobieństwa nie zna specyfiki tematu |
| Ocena AI (warstwa 3b) | **pewny** od `pewnosc ≥ 80`, niżej do sprawdzenia | Pewność deklarowana przy zapisie oceny |

Hasło trafia do „pewnych", gdy ma **choć jeden pewny sygnał** — chyba że jest słowem
kluczowym kampanii (patrz „Ochrona przez słowo kluczowe" niżej). Trzy niepewne sygnały to
nadal niepewność — sumowanie heurystyk niczego nie promuje.

**Ochrona przez historię.** Hasło słabe w 30 dniach, ale trzymające cel w skali roku
(ecom: ROAS ≥ 75% benchmarku rocznego · leadgen: CPA ≤ 1,5× rocznego CPA kampanii)
**wypada z obu list** — zostaje po nim licznik w podsumowaniu. Świadomie liczy się tylko
wynik: pojedyncza stara konwersja nie chroni hasła. Miernikiem jest średnia kampanii
**z tego samego roku** — porównywanie roku hasła do średniej z 30 dni to błąd
systematyczny: po dobrym miesiącu poprzeczka rośnie i produkuje fałszywe „pewne",
po słabym wszystko ląduje w „bronione".

**Ochrona przez słowo kluczowe.** Hasło, które **jest słowem kluczowym tej kampanii**,
nigdy nie trafia do „pewnych" — schodzi do „do sprawdzenia" z adnotacją wyjaśniającą
degradację, a same sygnały zostają widoczne. Nie dlatego, że sygnał się myli: rok bez
konwersji przy 3× koszcie konwersji to realny sygnał także tutaj. Zmienia się **koszt
błędu** — wycięcie hasła z długiego ogona kosztuje kilka złotych, a wykluczenie własnego
słowa kluczowego zabija je w koncie (negatyw ma pierwszeństwo) i wyłącza segment kupowany
świadomie. Taką decyzję podejmuje człowiek.

Porównanie idzie do słów kluczowych **całej kampanii**, nie grupy reklam — wykluczające
dodaje się per kampania. Liczy się **tożsamość** haseł (te same znaczące słowa, z tolerancją
polskiej fleksji), a nie objęcie dopasowaniem: słowo kluczowe do wyrażenia `skup samochodów`
pokrywa też „skup samochodów warszawa", które chcemy móc wyciąć. Ograniczenie tolerancji:
przy krótkich słowach w silnej odmianie („katowicach" wobec „katowice") podobieństwo
3-gramowe nie łapie progu i degradacja nie zadziała — skutkiem jest wtedy zachowanie sprzed
tej reguły, nic gorszego.

**Reguł słownikowych nie ma.** Listy „praca / za darmo / jak…" pisane pod ogół zderzają
się z branżą klienta i mylą się częściej, niż trafiają: u sklepu ogrodniczego
„stanowisko" to miejsce nasadzenia, nie oferta pracy. Ocenę intencji robi wyłącznie
warstwa 3b, która ma kontekst. Bez zamiennika — celowo.

**Kampanie produktowe (PMax, Shopping) mają próg 5 kliknięć** — kandydatem może być
tylko hasło z realnym ruchem w 30 dniach. Nie mają słów kluczowych, generują dziesiątki
tysięcy haseł z długim ogonem, a wyklucza się w nich rzadko i tylko to, co wyraźnie szkodzi.

## Pamięć klienta — `status-kierowanie.md`

W folderze raportu leży `status-kierowanie.md` — pamięć **między rundami**. Skrypt
tworzy go z szablonem przy pierwszym uruchomieniu i wkłada jego treść do
`-uncertain.json`; czytasz go na starcie razem z `kontekst.md` i **aktualizujesz po
rundzie**.

| Sekcja | Co trzyma |
|---|---|
| Ustalenia o ofercie i kierowaniu | Trwałe fakty zmieniające ocenę (np. „mamy raty 0%", „celowo licytujemy konkurencję", zasięg geograficzny) |
| Hasła sprawdzone — zostawiamy | Fałszywe alarmy z uzasadnieniem i datą |
| Zarekomendowane do wykluczenia | Co poszło do użytkownika |
| Wdrożone wykluczenia | Co faktycznie dodano w koncie |
| Historia rund | Po jednej linii na rundę |

**Dlaczego to oszczędza sprawdzenia SERP:** skrypt parsuje hasła w `grawisach` z wpisów
listy (linie od `-`) i **pomija je przy rozdzielaniu flag `serpCheck`** — budżet
50 sprawdzeń idzie na tematy jeszcze niezbadane, zamiast co rundę rozstrzygać to samo.
Dlatego hasła muszą być w grawisach i w wpisach listy.

Rozpoznawanie działa **na słowach i rozmyto**, nie na całym napisie: wpis `fotel biurowy`
pokrywa też „fotele biurowe opinie" (polska fleksja). Cały klaster zapisuje się jednym
wpisem z **wieloznacznikiem w klamrach** — `serwis {miejscowość}` pokrywa „serwis kraków"
i „serwis laptopów gdańsk", ale nie samo „serwis". Wpis **jednowyrazowy** (`nazwa-marki`)
musi trafić w całe hasło: inaczej wpis `serwis` oznaczałby jako zbadane praktycznie
każde hasło na koncie usługowym.

Jeśli po odsianiu tematów zbadanych budżet sprawdzeń zostaje, **dobija się go najdroższymi
hasłami znanymi** — odświeżenie najkosztowniejszego założenia jest warte więcej niż
niewykorzystane sprawdzenia. Im dłuższa sekcja „Hasła sprawdzone", tym więcej sprawdzeń
zostaje na nowe tematy.

---

## Opcje skryptu

| Flaga | Znaczenie |
|---|---|
| `--account` | alias z `.claude/accounts.json` albo 10-cyfrowy customer ID (wymagane) |
| `--accounts-dir` | katalog, od którego szukamy `.claude/accounts.json` (domyślnie: bieżący) |
| `--out` | folder raportu (domyślnie `Klienci/{alias}/Optymalizacja`) |
| `--kontekst` | ścieżka do `kontekst.md` (domyślnie `Klienci/{alias}/Kontekst/kontekst.md`) |
| `--typ` | `ecom` \| `leadgen` — nadpisuje `config.json` i wykrywanie automatyczne |
| `--cel-roas` | docelowy ROAS (ecom) — nadpisuje `targetRoas` z `config.json` |
| `--open` | otwórz raport po wygenerowaniu (macOS) |

**Typ konta** ustala się w kolejności: flaga → `config.json` → frontmatter `kontekst.md`
→ wykrycie automatyczne (konto raportujące wartość konwersji = ecommerce, bo tylko tam
ROAS jest sensowną miarą).

**Cel ROAS** (z `config.json` albo frontmattera) wygrywa ze średnią własnej kampanii przy ocenie haseł. Powód:
przy porównaniu do średniej **własnej** kampanii połowa haseł jest poniżej niej
z definicji, więc w kampanii brandowej sygnał nic nie znaczy — hasło z ROAS 6,3 przy
celu 3,5 lądowało wśród kandydatów tylko dlatego, że Brand ma średnią 9.

## Test bez API

```bash
node ".claude/skills/gads-wykluczenia-hasel/scripts/smoke-test.js"
```

Offline, bez sieci i sekretów — sprawdza progi sygnałów, poziomy pewności, obronę rokiem,
rozpoznawanie zbadanych tematów i render raportu. Uruchom po każdej zmianie w `analiza.js`.

## Architektura

| Plik | Odpowiada za |
|---|---|
| `scripts/wykluczenia-hasel.js` | CLI, pobranie danych, orkiestracja, pliki wymiany |
| `scripts/analiza.js` | logika sygnałów — czyste funkcje, zero I/O |
| `scripts/raport-html.js` | raport HTML (motyw dark/light, tabele, lista do skopiowania) |
| `scripts/format.js` | formatery pl-PL, waluta konta, okna czasowe |
| `scripts/connector.js` | **jedyne** miejsce ze ścieżką do konektora `gads-connector` |
| `scripts/smoke-test.js` | test offline |

**Pokrycie typów kampanii** — hasła składane z TRZECH źródeł, bo żadne nie pokrywa wszystkiego:

| Źródło | Co obejmuje |
|---|---|
| `search_term_view` + segment `segments.keyword.info.text` | Search ze słowami kluczowymi |
| `search_term_view` bez segmentu | **DSA, AI Max, Shopping** — segment słowa kluczowego wycina te kampanie do zera |
| `campaign_search_term_view` (filtr `clicks > 0`) | **Performance Max** — w `search_term_view` nie występuje w ogóle |

Z drugiego źródła dokładane są tylko kampanie nieobecne w pierwszym, więc metryki nie
liczą się podwójnie.

**Dane roczne** pobierane WYŁĄCZNIE dla haseł, które trafiają do analizy (kandydaci +
skan roczny) — filtr `IN` po stronie GAQL, w paczkach po 1000, z obu widoków. Klucz mapy
rocznej to para **(kampania, hasło)**: to samo zapytanie bywa obsługiwane przez kilka
kampanii i rok jednej podszywałby się pod drugą.

**Skan roczny** obejmuje top 30 wg wyświetleń **i** top 30 wg kosztu z 30 dni. Sam top wg
wyświetleń nie wystarczał — hasło z drogim CPC i małym wolumenem, czyli profil cichego
przepalacza, potrafiło się do niego nie załapać.

## Powiązane

- Konektor danych: skill `gads-connector` (`.claude/skills/gads-connector/`) — stamtąd
  bierze się logowanie do Google Ads API i wykonanie zapytań GAQL. Jeśli skrypt nie
  łączy się z kontem, zacznij od `npm run connector:test`.
