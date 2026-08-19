---
name: ga4-connector
description: |
  Kanoniczne wejście do Google Analytics 4 — raporty (sesje, kanały, kampanie, strony docelowe, produkty, kohorty, czas rzeczywisty) oraz konfiguracja usługi (strumienie danych, kluczowe zdarzenia, wymiary niestandardowe, model atrybucji, połączenie z Google Ads). Self-contained, zero zależności npm (globalny fetch, Node 18+). Tylko odczyt — konektor niczego nie zmienia w GA4. USE WHEN użytkownik chce dane z GA4, chce zestawić GA4 z Google Ads, sprawdzić czy usługa jest spięta z kontem Ads, zdiagnozować nadmiarowy ruch direct/none, albo znaleźć ID usługi klienta. Triggers "ga4-connector", "GA4", "Analytics", "dane z Analytics", "sesje w GA4", "konwersje w GA4", "kluczowe zdarzenia", "property ID", "połączenie GA4 z Ads", "dlaczego direct/none", "kohorty", "LTV".
---

# GA4 Connector

Cienka warstwa na publiczne REST API Google Analytics 4. Źródło prawdy: `scripts/api.js`.

- **Data API v1beta** — raporty
- **Admin API v1beta** — konfiguracja usługi, tylko do odczytu

Zakres OAuth to `analytics.readonly`. Konektor **nie potrafi** nic zmienić w GA4 i to
jest celowe: usługa GA4 zwykle należy do klienta, nie do nas, a jedna zmiana modelu
atrybucji psuje raportowanie wszystkim, którzy z niej korzystają.

## Konfiguracja — jednorazowo

**1. Włącz dwa API** w tym samym projekcie Google Cloud, z którego pochodzi konektor
Google Ads (nie zakładaj nowego projektu):

- https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com
- https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com

Jeśli któreś jest wyłączone, konektor sam zwróci link aktywacyjny z numerem projektu.
Gdy użytkownik nie ma jeszcze żadnego projektu GCP ani konektora Ads — przeprowadź go
przez `ONBOARDING.md` (krok 3 zakłada projekt i klienta OAuth typu **Desktop app**, przy
którym przekierowanie na `localhost` działa bez rejestrowania URI), a potem przez krok 6.

**2. Autoryzuj** — dwa kroki, zawsze na pierwszym planie:

```bash
node .claude/skills/ga4-connector/scripts/auth.js --step=url
```

Ten krok tylko wypisuje link i kończy się. Zaraz potem **uruchom nasłuch w tle** — musi
żyć między turami, bo trzyma serwer callbacku na `localhost:3000`:

```bash
node .claude/skills/ga4-connector/scripts/auth.js --step=listen --timeout=900
```

Dopiero teraz podaj użytkownikowi link i **poczekaj, aż potwierdzi kliknięcie**. Nasłuch
musi wystartować przed kliknięciem, inaczej przekierowanie trafi w zamknięty port.
Użytkownik nigdy nie klepie komend w terminalu — dostaje gotowy link.

Konektor bierze `client_id`/`client_secret` po kolei z: `GA4_CLIENT_ID`+`GA4_CLIENT_SECRET`,
`GADS_CLIENT_ID`+`GADS_CLIENT_SECRET`, `~/google-ads.yaml`. **Refresh token trzyma
osobno** (`~/.ads-agent/ga4-token.json`) — token Google Ads ma inny zakres i nadpisanie
któregokolwiek zepsułoby drugi konektor.

**3. Sprawdź:**

```bash
node .claude/skills/ga4-connector/scripts/cli.js --action=test-connection
```

## Wskazywanie usługi

`--property` przyjmuje trzy rzeczy: numeryczne ID (`123456789`), `properties/123456789`
albo **selektor konta z `.claude/accounts.json`** — klucz, nazwę lub alias. To ten sam
rejestr, którego używa `gads-connector`, więc `--account=zielonyogrod` i
`--property=zielonyogrod` wskazują tego samego klienta. `--account` działa tu jako synonim
`--property`.

Żeby konto miało usługę GA4, dopisz do jego wpisu jedno pole:

```json
"zielonyogrod": {
  "name": "Zielony Ogród",
  "id": "1234567890",
  "ga4PropertyId": "123456789"
}
```

Nie znasz ID? `--action=properties` wypisze wszystkie usługi widoczne dla konta.
Konektor, gdy trafi na konto bez `ga4PropertyId`, sam powie, co i gdzie dopisać.

### Rejestr sam się nie tworzy — i nie tworzy się sam po cichu

W świeżej instalacji `.claude/accounts.json` **nie istnieje** i aliasy nie działają;
`--help` mówi to wprost. Nie trzeba go pisać ręcznie: po każdym raporcie zrobionym
na surowym numerycznym ID konektor sprawdza, czy zna tę usługę, i jeśli nie —
wypisuje gotową propozycję:

```
💡 Usługa 123456789 („Zielony Ogród – GA4") nie jest w rejestrze.
   Zapamiętać jako „zielonyogrod”, żeby następnym razem wystarczyło --property=zielonyogrod?
   node scripts/cli.js --action=remember --property=123456789 --as=zielonyogrod
```

**Zasada: propozycję pokazujesz użytkownikowi i czekasz na zgodę. `--action=remember`
uruchamiasz dopiero po jego potwierdzeniu — nigdy odruchowo po raporcie.** Alias staje
się selektorem dla obu konektorów, więc jest decyzją nazewniczą, a nie wartością do
wyprowadzenia. Użytkownik może podać własny alias zamiast proponowanego.

`remember` jest jedynym zapisem tego konektora i zachowuje się zachowawczo:

- gdy konto o tym aliasie **już istnieje** (np. jest w rejestrze z ID Google Ads, ale bez
  GA4) — uzupełnia mu `ga4PropertyId` zamiast tworzyć drugi wpis dla tego samego klienta;
- gdy usługa jest już zapisana pod innym kluczem — nie robi nic i mówi, pod jakim;
- nigdy nie zapisuje `"default": true`, więc nie zmienia zachowania `gads-connector`;
- zapisuje atomowo (zapis do pliku tymczasowego + podmiana), bo uszkodzony rejestr
  zepsułby też konektor Adsów;
- zakłada plik razem z opisem formatu, jeśli go nie było.

## Kilka kont Google

Jeden login rzadko widzi wszystkie usługi klientów — czasem nie da się dodać kolejnego
użytkownika po stronie klienta, czasem usługi są rozrzucone po Twoich własnych kontach.
**Profil** to nazwany plik tokena, dzięki czemu kilka loginów żyje obok siebie zamiast
się nadpisywać.

```bash
# autoryzacja drugiego konta → ~/.ads-agent/ga4-token-firma2.json
node scripts/auth.js --step=url --profile=firma2
node scripts/auth.js --step=listen --profile=firma2

node scripts/cli.js --action=profiles          # które loginy są autoryzowane
node scripts/cli.js --action=traffic --property=123456789 --profile=firma2
```

Żebyś nie musiał o profilu pamiętać, przypisz go do klienta w rejestrze:

```json
"drugafirma": { "id": "2233445566", "ga4PropertyId": "987654321", "ga4Profile": "firma2" }
```

Odtąd `--property=drugafirma` samo sięga po właściwy token. Pierwszeństwo: jawne
`--profile` → `ga4Profile` z rejestru → profil domyślny. Przy 403 konektor mówi, który
login próbował, i podpowiada sprawdzenie pozostałych.

Autoryzacja bez `--profile`, gdy domyślny token już istnieje, **nadpisze go** — `auth.js`
ostrzega o tym przed pokazaniem linku.

Rejestr jest szukany w górę drzewa katalogów i **jest gitignorowany** — trzyma prawdziwe
ID klientów i nigdy nie trafia do repozytorium. Kolejność, gdy nie podasz `--property`:
`GA4_DEFAULT_PROPERTY` z `.env`, potem konto oznaczone `"default": true`.

## Użycie

```bash
C=".claude/skills/ga4-connector/scripts/cli.js"

# Nie znasz ID usługi? Zacznij tutaj.
node $C --action=properties

# Raporty — po aliasie konta albo po numerycznym ID
node $C --action=traffic --property=zielonyogrod --days=30
node $C --action=campaigns --property=123456789 --days=90
node $C --action=ecommerce --property=123456789 --days=365 --output=/tmp/produkty.csv

# Dowolne zapytanie
node $C --action=report --property=123456789 --days=30 \
  --dimensions=yearMonth,itemName --metrics=itemRevenue,itemsPurchased \
  --filter="itemName=~ogrod" --order=-itemRevenue --limit=50

# Konfiguracja usługi
node $C --action=streams --property=123456789
node $C --action=ads-links --property=123456789
node $C --action=attribution --property=123456789

# „GA4 nie zgadza się z Ads" — jeden rzut na całość
node $C --action=diagnose --property=123456789 --days=30 --json
```

Pełna lista akcji i opcji: `node $C --help`.

**Duże pobrania idą do pliku, nie do kontekstu.** `--output=/tmp/x.csv` przy czymkolwiek
powyżej ~50 wierszy; `--json` tylko wtedy, gdy naprawdę potrzebujesz surowej struktury.

## Porównanie okresów — `--compare`

Pytanie „jak było przed" pojawia się przy każdej migracji, awarii pomiaru i podejrzeniu
anomalii. Zamiast liczyć to ręcznie, dołóż okres odniesienia:

```bash
node $C --action=report --property=123456789 \
  --dimensions=landingPage --metrics=sessions,engagedSessions,keyEvents \
  --from=2026-08-04 --to=2026-08-17 --compare=2026-06-20:2026-07-09
```

Każda metryka dostaje trzy kolumny: `<metryka>`, `<metryka>_ref` (okres odniesienia)
i `<metryka>_Δ%`. Działa też z gotowcami (`traffic`, `sources`, `campaigns`,
`landing-pages`, `ecommerce`).

Dwie rzeczy, które to załatwia za Ciebie — bo ręcznie łatwo je przeoczyć:

- **Wskaźniki nie są uśredniane.** Każde okno liczy GA4 osobno, więc `bounceRate`,
  `engagementRate` czy `averageSessionDuration` przychodzą poprawnie zważone. Sumowanie
  ich po dniach i dzielenie przez liczbę dni daje średnią nieważoną — cicho zły wynik.
- **Okna różnej długości.** 14 dni vs 20 dni porównane sumami zaniżyłyby krótszy okres
  o 30%. Gdy długości się różnią, wartości i zmiany są liczone **na dzień** (wskaźników
  się nie dzieli), a nagłówek to wypisuje.

Dodatkowo: wiersze obecne **tylko w okresie odniesienia** też trafiają do wyniku (np.
podstrona, która po migracji zniknęła) — z `_Δ%` równym −100. Gdy czegoś nie było
wcześniej, `_Δ%` jest puste, a nie mylące „+100%".

**`--limit` działa po scaleniu, nie w zapytaniu.** Przy porównaniu oba okna pobierane są
w całości i dopiero scalony zestaw jest przycinany; nagłówek pokazuje wtedy „wierszy: 4
z 12". Gdyby limit szedł do API, GA4 przyciąłby **każde okno osobno**: wiersz z top-N
okna bieżącego, który w oknie odniesienia jest N+1, nie zostałby pobrany i wyrenderował
się jako `0` — nie do odróżnienia od prawdziwego zera. Dzięki temu **`_ref` równe 0
zawsze znaczy „naprawdę zero", a nie „nie pobrałem tego wiersza"**.

Kosztem jest pobranie pełnych okien. Przy wymiarach o dużej liczności (np.
`landingPagePlusQueryString` na roku danych) porównanie będzie wolniejsze niż zwykły
raport z `--limit` — to świadomy wybór na rzecz poprawności liczb.

`--compare` **nie łączy się z wymiarem czasu** (`date`, `yearMonth`, …) — porównujemy
dwa okresy, więc wiersze muszą być po czymś innym. Konektor odmówi z wyjaśnieniem.

## Filtry

Łączone średnikiem (AND). Wartości nie są wrażliwe na wielkość liter.

| Zapis | Znaczenie |
|---|---|
| `pole==wartość` | dokładnie |
| `pole!=wartość` | różne od |
| `pole=~fragment` | zawiera |
| `pole!~fragment` | **nie** zawiera |
| `pole=@a\|b\|c` | z listy |
| `pole=^start` / `pole=$koniec` | zaczyna się / kończy się |
| `metryka>100` | próg liczbowy (`--metric-filter`) |

Wykluczenie spamu z raportu: `--filter="sessionSource!~semalt;sessionSource!~buttons"`.

## Pułapki, o których trzeba wiedzieć

- **Nieznana opcja przerywa zapytanie.** Konektor nie połyka literówek: `--start=` zamiast
  `--from=` zatrzymuje wykonanie i podpowiada właściwą nazwę. Wartość musi iść po znaku
  równości — `--from 2026-01-01` ze spacją też jest błędem, a nie cichym powrotem do
  domyślnego okresu. Celowo, bo zignorowana opcja daje dane za inny okres, wyglądające
  zupełnie poprawnie.
- **Domyślnie okres kończy się na wczoraj.** `--days=30` to 30 **pełnych** dni. Dzisiejszy,
  niepełny dzień dopisuje dopiero `--include-today`. To celowe — półdzień cicho psuje
  każde porównanie okresów.
- **`keyEvents`, nie `conversions`.** Google przemianował metrykę. Jeśli usługa zwróci 400
  na `keyEvents`, sprawdź `--action=metadata --property=ID --only=metrics`.
- **Próg danych.** Przy włączonych sygnałach Google GA4 ukrywa wiersze o małej liczbie
  użytkowników. Konektor to wykrywa i wypisuje ostrzeżenie — sumy są wtedy zaniżone.
- **Wiersz `(other)`.** Przy dużej liczbie kombinacji wymiarów GA4 zwija ogon do jednego
  wiersza. Mniej wymiarów naraz = mniej `(other)`.
- **Limity są na usługę, nie na konto.** Data API rozlicza tokeny dobowo, godzinowo i za
  równoległość. Konektor wypisuje pozostały limit dobowy pod nagłówkiem raportu.
- **GA4 ≠ Google Ads i nigdy nie będzie.** Inne okno konwersji, inny model atrybucji, inna
  data przypisania. Zanim wyjaśnisz komukolwiek różnicę, zobacz `--action=attribution`.

## Diagnostyka błędów

| Objaw | Co zrobić |
|---|---|
| `has not been used` / `is disabled` | włączyć Data albo Admin API — konektor podaje gotowy link |
| 403 przy konkretnej usłudze | konto nie ma do niej dostępu; `--action=properties` pokaże, co widzi |
| `invalid_grant` | token unieważniony — powtórzyć `auth.js --step=url` |
| 400 „Did you mean" | zła nazwa wymiaru/metryki — `--action=metadata` |
| 429 | limit usługi wyczerpany — mniej wymiarów, krótszy okres, później |
| Port 3000 zajęty | inny nasłuch autoryzacji nadal żyje — zamknąć go |

## Test offline

```bash
node .claude/skills/ga4-connector/scripts/smoke-test.js
```

Sprawdza parser filtrów, arytmetykę dat i rozwiązywanie ID usługi. Bez sieci i bez credentiali.
