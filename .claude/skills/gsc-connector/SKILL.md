---
name: gsc-connector
description: |
  Kanoniczne wejście do Google Search Console — lista property, stan zgłoszonych sitemap, dane z wyszukiwarki (kliknięcia/wyświetlenia/CTR/pozycja per URL i fraza) oraz URL Inspection (czy URL jest zaindeksowany, jaki URL Google uznał za kanoniczny, kiedy ostatnio go crawlował, skąd go zna). Tylko odczyt — konektor niczego nie zmienia w GSC. USE WHEN użytkownik chce sprawdzić indeksowanie strony, zdiagnozować dlaczego podstrony nie wchodzą do indeksu, porównać kanoniczny URL wybrany przez Google z zadeklarowanym, zobaczyć które URL-e i frazy zbierają ruch, albo sprawdzić stan sitemap. Triggers "gsc-connector", "Search Console", "GSC", "czy strona jest zaindeksowana", "dlaczego Google nie indeksuje", "URL Inspection", "sprawdź indeksowanie", "sitemapy w GSC", "jaki canonical wybrał Google", "ruch z SEO", "pozycje w Google".
---

# GSC Connector

Cienka warstwa na Search Console API v3 + URL Inspection API v1. Bez zależności npm —
działa na wbudowanym `fetch` (Node 18+), `npm install` nie jest potrzebny.
Źródło prawdy: `scripts/api.js`.

**Tylko odczyt.** Zakres OAuth to `webmasters.readonly`, więc konektor nie jest w stanie
zgłosić sitemapy, poprosić o zaindeksowanie ani niczego zmienić w property klienta.
Jedyny zapis dotyczy naszego rejestru kont (`--action=remember`) i wymaga potwierdzenia.

## Konfiguracja — jedno API i jedna zgoda

Konektor używa **tego samego klienta OAuth co Google Ads** (`~/google-ads.yaml` albo
`GADS_CLIENT_ID`/`GADS_CLIENT_SECRET`), więc nie zakładasz drugiego klienta ani nie
rejestrujesz drugiego URI przekierowania.

1. Włącz w **tym samym** projekcie Google Cloud:
   https://console.cloud.google.com/apis/library/searchconsole.googleapis.com
2. Autoryzuj (dwa kroki — patrz niżej).

Token trzyma **osobno** w `~/.ads-agent/gsc-token.json`. To celowe: zakresy Adsów, GA4
i Search Console są różne, a nadpisanie któregokolwiek tokena zepsułoby tamten konektor.
Pełna lista zmiennych: `references/.env.example`.

## Autoryzacja (dwa kroki)

```bash
node scripts/auth.js --step=url        # wypisuje link
node scripts/auth.js --step=listen     # czeka na powrót z przeglądarki
```

Kolejność jest istotna: **najpierw uruchom nasłuch w tle**, dopiero potem podaj
użytkownikowi link i poczekaj, aż potwierdzi kliknięcie. Nasłuch musi wystartować przed
kliknięciem — inaczej przekierowanie trafi w zamknięty port. Musi też przeżyć między
turami, dlatego idzie w tło.

Z korzenia pakietu: `npm run gsc:auth`, potem `npm run gsc:auth-listen`.

## Property: dwa różne obiekty, nie synonimy

To jest **najczęstsza przyczyna niewyjaśnionego 403** i pierwsza rzecz do sprawdzenia:

| Zapis | Co obejmuje |
|---|---|
| `sc-domain:zielonyogrod.example` | property domenowa — wszystkie subdomeny, http i https |
| `https://zielonyogrod.example/` | prefiks URL — musi się zgadzać **co do znaku**, ze slashem na końcu |

Konto ma dostęp do konkretnego obiektu, nie do „domeny". Zapytane o formę, której nie
posiada, Google odpowiada **403**, a nie „nie ma takiej property" — dlatego przy 403/404
konektor sam dopytuje API i wypisuje, co ten login naprawdę widzi dla tej domeny.

Nie znasz zapisu? `--action=sites` wypisze wszystko razem z poziomem uprawnień.

## Wskazywanie klienta

Konektor czyta ten sam rejestr co pozostałe konektory — `.claude/accounts.json`, pole
`gscSite` przy koncie. Dzięki temu jeden alias wskazuje klienta wszędzie:

```bash
--account=zielonyogrod    # Google Ads
--property=zielonyogrod   # GA4
--site=zielonyogrod       # Search Console
```

`--site` przyjmuje alias, pełny zapis property albo gołą domenę. Goła domena jest
**zgadywana** jako property domenowa i konektor mówi o tym wprost — bez tego pusta
tabela wyglądałaby jak brak ruchu, a byłaby pytaniem o nieistniejący obiekt.

Property spoza rejestru: po udanym zapytaniu konektor zaproponuje gotową komendę
`--action=remember`. **Uruchamiaj ją tylko po potwierdzeniu użytkownika** — alias staje
się selektorem dla wszystkich trzech konektorów, więc to decyzja nazewnicza.

**Świeże repo bez rejestru:** `.claude/accounts.json` nie istnieje, dopóki go nie
założysz — do tego czasu property podajesz pełnym zapisem, a konektor po `--action=sites`
sam zaproponuje start rejestru. Zaproponuj użytkownikowi jego założenie: pierwszy
`--action=remember` tworzy plik, kolejne dopisują property po jednej. Pełny format pól
(także dla Adsów i GA4) opisuje
`.claude/skills/gads-connector/references/accounts.example.json` — przy okazji zapisu
warto od razu uzupełnić `id` (konto Ads) i `ga4PropertyId`, żeby alias działał wszędzie.

## Kilka kont Google

`--action=sites` pokazuje, co widzi autoryzowany login. Jeśli lista zawiera wszystkich
klientów — pomiń ten rozdział. Gdy jakiejś property brakuje, autoryzuj login, który ją
widzi, jako profil (osobny plik tokena):

```bash
node scripts/auth.js --step=url --profile=firma2   # autoryzacja drugiego konta
node scripts/cli.js --action=sites --profile=firma2
```

W rejestrze pole `"gscProfile": "firma2"` przypisuje login do klienta na stałe, więc przy
`--site=<alias>` nie musisz o nim pamiętać. `--action=profiles` pokazuje autoryzowane
loginy.

## Użycie

```bash
S="scripts/cli.js"

node $S --action=test-connection
node $S --action=sites

# Stan sitemap
node $S --action=sitemaps --site=zielonyogrod

# Które URL-e zbierają ruch (90 dni)
node $S --action=query --site=zielonyogrod --days=90 --dimensions=page

# Fraza + strona, do CSV
node $S --action=query --site=zielonyogrod --dimensions=query,page --limit=5000 --output=frazy.csv

# Tylko podstrony z fragmentem ścieżki
node $S --action=query --site=zielonyogrod --contains=/blog/

# Pojedynczy URL
node $S --action=inspect --site=zielonyogrod --url="https://zielonyogrod.example/blog/rosliny/"

# Próbka URL-i z pliku (jeden na linię, # = komentarz)
node $S --action=inspect-batch --site=zielonyogrod --urls-file=urls.txt --concurrency=5

# Wszystko naraz: sitemapy + ruch + werdykt strony głównej
node $S --action=diagnose --site=zielonyogrod
```

Wyjście: tabela (domyślnie), `--json`, `--output=plik.csv`, `--show=N|all`.

## Zakres dat i opóźnienie danych

`--days=90` to ostatnie 90 dni **do wczoraj włącznie**. Dane ostateczne w Search Console
są opóźnione o **2–3 dni**, więc świeży zakres bywa pusty — to nie jest spadek ruchu.
`--data-state=all` dokłada dane świeże i niepełne (dobre do „czy dziś coś się dzieje",
złe do porównań). Przy zerowej liczbie wierszy konektor sam o tym przypomina.

**Wiersz bez wyświetleń nie ma pozycji ani CTR.** Przy `--dimensions=date` API dopełnia
dni bez wyświetleń zerami — a „pozycja 0" nie istnieje (pozycje zaczynają się od 1)
i wciągnięta do średniej zaniża każdy wynik, wyglądając przy tym wiarygodnie. Konektor
zwraca w takich wierszach `null` (w tabeli `–`, w CSV pusta komórka), więc średnia
z kolumny `pozycja` jest poprawna z konstrukcji. Licząc cokolwiek na pozycji z surowego
`--json`, i tak filtruj `wyswietlenia > 0`.

## Filtry

Łącz średnikiem (AND). Filtrować można po `query`, `page`, `country`, `device`,
`searchAppearance` — po dacie **nie** (od tego są `--days` / `--from` / `--to`).

```bash
--filter="page=~/blog/"            zawiera
--filter="query!~marka"            NIE zawiera
--filter="page==https://x/a/"      dokładnie
--filter="query!=marka"            NIE dokładnie
--filter="query=/^jak "            wyrażenie regularne
--filter="query!/^jak "            NIE pasuje do wyrażenia
--contains=/blog/                  skrót na --filter="page=~/blog/"
```

## Interpretacja `inspect` — na co patrzeć

| Pole | Co mówi |
|---|---|
| `verdict` | `PASS` = w indeksie, `NEUTRAL`/`FAIL` = nie |
| `coverageState` | powód, np. „Duplikat, Google wybrał inną stronę kanoniczną", „Wykryta – obecnie niezaindeksowana" |
| `googleCanonical` vs `userCanonical` | rozjazd = Google zignorował zadeklarowany canonical; `canonicalMismatch` liczy to za Ciebie |
| `robotsTxtState` | czy robots.txt nie blokuje |
| `crawledAs` | `MOBILE`/`DESKTOP` |
| `referringUrls` | skąd Google zna ten URL — kluczowe przy diagnozie śmieciowych adresów |
| `sitemaps` | w której sitemapie URL występuje |

## Czego API nie da — nie obiecuj tego użytkownikowi

- **Zbiorczych liczb z raportu „Indeksowanie stron"** (ile URL-i w „Duplikat, Google
  wybrał inną stronę kanoniczną" itp.). Trzeba odczytać w interfejsie GSC.
- **Statystyk indeksowania** (trafienia robota, czasy odpowiedzi). Tylko interfejs.
- Danych starszych niż ~16 miesięcy.

Zamiast raportu zbiorczego: `inspect-batch` na reprezentatywnej próbce daje te same
werdykty per URL. Limity URL Inspection: **2000 URL-i/dobę, 600/min** per property.
Listę adresów do próbki najprościej zbudować z ruchu:
`--action=query --dimensions=page --limit=200 --output=strony.csv`.

## Diagnostyka błędów

| Objaw | Co zrobić |
|---|---|
| `has not been used` / `is disabled` | włącz „Google Search Console API" w projekcie GCP (link jest w komunikacie) |
| 403 przy property | najpierw sprawdź formę zapisu (`sc-domain:` vs prefiks URL) — konektor wypisze, co widzi login; potem uprawnienia |
| 403 tylko przy `inspect` | URL Inspection wymaga uprawnienia „pełne"/„właściciel"; rola „ograniczona" nie wystarcza |
| 404 przy property | property w tej formie nie istnieje; prefiks URL musi mieć slash na końcu |
| `invalid_grant` | token unieważniony — powtórz `auth.js --step=url` |
| 429 | limit URL Inspection — zmniejsz `--concurrency` albo rozbij listę na kilka dni |
| Zero wierszy w `query` | opóźnienie 2–3 dni, za wąski zakres albo nie ta property |

## Test offline

```bash
node scripts/smoke-test.js     # albo: npm run gsc:smoke
```

50 testów logiki czystej (normalizacja property, rozwiązywanie aliasów, filtry, daty,
inspekcja, zapis do rejestru) — bez sieci i bez credentiali.
