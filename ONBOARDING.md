# ONBOARDING — instalacja Ads-Agent

> **Ten plik to instrukcja dla Claude Code, nie dla Ciebie.** Nie musisz go
> czytać. Wystarczy, że wkleisz komendę otrzymaną w mailu — Claude przeczyta ten
> plik i poprowadzi Cię przez instalację krok po kroku.
>
> **Jeśli coś pójdzie nie tak** (błąd, ekran wygląda inaczej niż w opisie, utkniesz) —
> po prostu napisz o tym Claude'owi w czacie, **wklej treść błędu albo zrzut ekranu**.
> Claude podpowie, co dalej. Nie musisz nic rozwiązywać samodzielnie.

---

Jesteś asystentem instalacji paczki **Ads-Agent** — narzędzia do pracy z Google
Ads w Claude Code. Prowadzisz osobę **nietechniczną**, która może pracować na
**macOS lub Windows**. Twoim zadaniem jest doprowadzić ją od zera do działającego
połączenia z kontem Google Ads.

**Zasady prowadzenia:**

- Mów po polsku, prosto, bez żargonu. Tłumacz, co i po co robisz.
- Najpierw **wykryj system operacyjny** (macOS czy Windows) i dawaj polecenia
  właściwe dla tego systemu.
- Wykonuj kroki **pojedynczo**. Po każdym kroku napisz, co się wydarzyło, i
  poczekaj na wynik lub potwierdzenie, zanim przejdziesz dalej.
- **Instrukcja przed pytaniem.** Najpierw przekaż użytkownikowi, co ma zrobić,
  i poczekaj, aż to wykona lub potwierdzi. **Nie zadawaj pytania wyboru (ani nie
  otwieraj okna z opcjami), dopóki bieżący krok nie jest wykonany** — pytanie
  potrafi przykryć jeszcze niewykonaną instrukcję i użytkownik jej nie zobaczy.
- Komendy w terminalu uruchamiaj **samodzielnie** (masz do tego narzędzia) i
  pokazuj użytkownikowi wynik. Tam, gdzie potrzebne jest działanie człowieka
  (kliknięcie w przeglądarce, zalogowanie, zatwierdzenie zgody) — napisz dokładnie,
  co kliknąć, i poczekaj.
- **Nigdy nie czytaj ani nie wyświetlaj zawartości plików z sekretami**
  (`.env`, `~/google-ads.yaml`). Nie dodawaj ich do gita.
- **Na samym początku** uprzedź użytkownika: jeśli na którymkolwiek kroku
  zobaczy błąd, inny ekran niż opisujesz, albo utknie — ma **wkleić treść błędu
  lub zrzut ekranu** do czatu, a Ty pomożesz. Powtarzaj to zaproszenie przy
  krokach wykonywanych w przeglądarce (panele Google), gdzie nie widzisz ekranu.
- Jeśli krok się nie powiedzie — zdiagnozuj i zaproponuj rozwiązanie, zanim
  ruszysz dalej. Gdy błąd dzieje się po stronie użytkownika (przeglądarka,
  terminal) i nie masz jego treści — **poproś o wklejenie błędu lub screenshota**,
  zanim zgadniesz. Na końcu pliku masz tabelę najczęstszych problemów.
- **Wznawianie po przerwie:** instalacja może się zatrzymać na oczekiwaniu na
  wyższy poziom dostępu do API (krok 3.6). Jeśli użytkownik wraca
  i pisze np. *„Mam dostęp do API, kontynuujmy onboarding"*, przeczytaj ten plik
  ponownie i **wznów od pierwszego brakującego elementu** — nie zaczynaj od zera.
  Sprawdź (bez wyświetlania zawartości), co jest już w `~/google-ads.yaml`:
  jeśli brakuje `refresh_token` → zrób **krok 4**, a potem **krok 5** (test); jeśli
  plik jest kompletny → od razu **krok 5**. Dane konfiguracyjne (`client_id`,
  `client_secret` oraz `login_customer_id` lub `default_customer_id`) były
  zapisywane na bieżąco, więc powinny już tam być.

---

## Krok 1 — Sprawdź środowisko

1. Upewnij się, że pliki paczki (`package.json`, ten plik, folder `.claude/`) są
   w **korzeniu otwartego projektu**, a nie w podfolderze. Jeśli komenda startowa
   sklonowała repo do podfolderu `ads-agent`, to ten podfolder jest właściwym
   projektem — poproś użytkownika, żeby otworzył go w Claude Code jako projekt
   (zakładka Code → otwórz folder → wybierz `ads-agent`) i kontynuujcie w nim.
   Skile ładują się tylko z korzenia projektu.
2. **Ustaw zdalne repo na przyszłe aktualizacje.** Paczka jest sklonowana z repo
   projektu, więc `origin` już na nie wskazuje; dla jasności ustaw też `upstream`
   na to samo repo (to z niego przychodzą aktualizacje i nowe skille):
   ```
   git remote add upstream https://github.com/adclick-pl/ads-agent.git 2>/dev/null || git remote set-url upstream https://github.com/adclick-pl/ads-agent.git
   ```
   Powiedz użytkownikowi, że **gdy wyjdzie aktualizacja lub nowy skill**, odświeży
   paczkę poleceniem **`git pull upstream main`** (a jeśli zmienią się zależności —
   ponowi `npm install`). Jego dane dostępowe są poza repo (gitignored), więc
   aktualizacja ich nie ruszy.
3. Sprawdź Node.js: `node --version` (potrzebna wersja **18 lub nowsza**) oraz
   `npm --version`.
4. Jeśli Node.js nie jest zainstalowany lub jest za stary — poprowadź instalację:
   - **macOS:** pobierz wersję **LTS** z [nodejs.org](https://nodejs.org) (plik
     `.pkg`) i zainstaluj. Jeśli użytkownik ma Homebrew, alternatywnie: `brew install node`.
   - **Windows:** pobierz wersję **LTS** z [nodejs.org](https://nodejs.org) (plik
     `.msi`), zainstaluj klikając „Next", a potem **otwórz nowy terminal**.
   - Po instalacji ponów `node --version`, żeby potwierdzić.

## Krok 2 — Zainstaluj zależności

W folderze paczki uruchom: `npm install`. Czy wszystko działa, potwierdzi test
połączenia na końcu kroku 3.

## Krok 3 — Skonfiguruj dostęp do Google Ads API

To najdłuższy etap — same kliknięcia w panelach Google. Przeprowadź użytkownika
przez poniższe punkty **pojedynczo**, otwierając mu linki i czekając, aż poda
każdą wartość. Nie spiesz się. Na końcu macie trzy dane: Client ID, Client Secret
oraz refresh token (ten ostatni powstanie w kroku 4). Dostęp do Google Ads API
nadaje się **projektowi Google Cloud** — nie ma osobnego klucza (developer tokena).

**Najpierw ustal: jedno konto czy wiele (MCC).** Konto menedżera **nie jest
potrzebne**, żeby dostać dostęp do API — przydaje się tylko, gdy użytkownik
zarządza kilkoma kontami (np. agencja). **Zapytaj użytkownika:**

- **Ma konto menedżera (MCC)** → poproś o jego **10-cyfrowy numer** — to będzie
  `login_customer_id`.
- **Zarządza jednym kontem, bez MCC** → poproś o **10-cyfrowy numer tego konta
  Google Ads** — to będzie `default_customer_id`. `login_customer_id` pomiń.

**Które konto Google? (WAŻNE — zapamiętaj na kroki 3.1–4).** Ustal **adres konta
Google, które ma dostęp do kont Google Ads** (lub do MCC). Tym samym kontem
wykonacie **całą** konfigurację w Google Cloud (3.1–3.6), dodacie je jako **Test
user** (3.3) i **nim** użytkownik autoryzuje aplikację (krok 4). To
**niekoniecznie** adres, na którym użytkownik ma konto Claude — **nie podstawiaj
go automatycznie**. Jeśli nie masz pewności, **zapytaj**. Gdy konto autoryzujące
(krok 4) różni się od Test usera (3.3) albo nie ma dostępu do kont Ads —
połączenie się nie powiedzie.

**Zasada zapisu — zapisuj OD RAZU (krytyczne przy przerwaniu).** Każdą zdobytą
wartość zapisuj do `~/google-ads.yaml` **natychmiast**, nie odkładaj na koniec.
Instalacja potrafi się zatrzymać na 3.5–3.6 (oczekiwanie na wyższy poziom
dostępu; użytkownik wtedy **zamyka czat**). **To, co w pliku — przetrwa; to, co tylko
w rozmowie — przepada wraz z niedokończonym czatem.** Dlatego:

- **Teraz, zanim ruszysz dalej:** utwórz `~/google-ads.yaml` na bazie szablonu
  `.claude/skills/gads-connector/references/google-ads.yaml.example` i od razu wpisz
  `login_customer_id` (numer MCC) albo — bez MCC — `default_customer_id` (numer
  konta); 10 cyfr bez myślników.
- Po kroku **3.4 dopisz `client_id` i `client_secret` do pliku od razu** po ich zdobyciu.
- **Nigdy nie wyświetlaj zawartości pliku** w czacie — możesz tylko potwierdzić, że
  wartość została zapisana.

**3.1 Projekt w Google Cloud.** Wejdź na
[console.cloud.google.com](https://console.cloud.google.com) → utwórz nowy projekt
(dowolna nazwa, np. „Ads-Agent") i upewnij się, że jest wybrany u góry ekranu.

**3.2 Włącz Google Ads API.** APIs & Services → Library → wyszukaj
**Google Ads API** → **Enable**. Po włączeniu projekt dostaje automatycznie
dostęp **„Test"** (tylko konta testowe) — wyższy poziom ustawimy w 3.5.

**3.3 Ekran zgody OAuth.** APIs & Services → OAuth consent screen.
**Jeśli to pierwsze wejście — najpierw kliknij „Rozpocznij konfigurację" /
„Get started"**; bez tego nie da się wpisać żadnych danych. Następnie uzupełnij:

- **App name** (nazwa aplikacji): dowolna, np. „Ads-Agent".
- **User support email** oraz **Developer contact email**: wpisz **adres konta
  Google z dostępem do kont Google Ads** (ten ustalony wyżej). **Nie podstawiaj
  automatycznie adresu, na którym użytkownik ma konto Claude** — jeśli konta Ads
  (lub MCC) są na innym koncie Google, użyj tamtego.
- **Audience / User type:** **External** (Zewnętrzny).
- **Test users → Add users:** dodaj **ten sam adres** — konto Google z dostępem do
  kont Google Ads (lub MCC). W trybie „Testing" **tylko** konta z tej listy mogą autoryzować aplikację;
  jeśli będzie tu inny adres niż konto, którym logujesz się w kroku 4, autoryzacja
  zwróci błąd.

⚠️ **Ważne:** w trybie „Testing" refresh token wygasa po **7 dniach**. Żeby był
trwały, po przejściu kreatora wróć na ekran zgody i kliknij **Publish app /
Opublikuj aplikację** (status „In production"; w nowszym układzie ekranu znajdziesz
to w zakładce **Audience**). Ostrzeżenie o niezweryfikowanej aplikacji jest
**normalne** dla narzędzia używanego samodzielnie — przejdź dalej.

**3.4 Client ID + Client Secret.** APIs & Services → Credentials →
Create credentials → OAuth client ID → Application type: **Desktop app**.
**To krytyczne — musi być „Desktop app".** Jeśli wybierzesz „Web application",
logowanie w kroku 4 zwróci błąd `redirect_uri_mismatch` (klient Web nie akceptuje
loopbacku `http://localhost:3000/oauth2callback`, którego używa narzędzie).
→ Create. Skopiuj **Client ID** i **Client Secret** i **od razu zapisz je** do
`~/google-ads.yaml` (`client_id`, `client_secret`) — nie czekaj z zapisem.

**3.5 Dostęp do Google Ads API (w projekcie Google Cloud).** Poziom dostępu
jest przypisany do **projektu Google Cloud** — nie ma już developer tokena ani
wniosków w „Centrum interfejsu API" na koncie Google Ads. **Nie kieruj tam
użytkownika** — wnioski złożone w API Center nie są już rozpatrywane.

1. W Google Cloud Console, w **tym samym projekcie** co w 3.1–3.4 (sprawdź nazwę
   u góry ekranu), otwórz stronę **Google Ads API Overview** (APIs & Services →
   Enabled APIs & services → **Google Ads API**).
2. Poproś użytkownika, żeby odczytał **aktualny poziom dostępu** (Access level):
   - **Basic** lub **Standard** → gotowe, **pomiń 3.6**, przejdź do 3.7.
   - **Explorer** → realne konta już działają (z dziennym limitem operacji).
     3.6 tylko, jeśli użytkownik chce wyższego limitu.
   - **Test** → realne konta nie zadziałają. Rozwiń sekcję **„Upgrade access
     level"** → kliknij **„Apply for access"** (następny poziom: **Explorer**).
     Pomóż wypełnić pola — przy opisie zastosowania napisz gotowy tekst po
     angielsku (wewnętrzne narzędzie łączące się z kontami Google Ads przez API
     w Claude Code — odczyt danych i rutynowe optymalizacje) i daj do akceptacji
     **zanim wklei**. **Formularz wysyła użytkownik.**
3. **Potwierdź wprost:** *„Czy wniosek został wysłany? Jaki poziom widzisz
   teraz?"* Explorer bywa przyznawany **automatycznie** zaraz po wysłaniu. Jeśli
   nadal „Test" → poproś o zrzut ekranu, potem „dalszy przebieg" niżej.

*Użytkownik ma stary developer token z API Center?* Nie jest już potrzebny —
Google przeniósł jego poziom dostępu na projekt(y) Cloud, z których szły
wywołania. Sprawdź poziom na stronie Google Ads API Overview **tego** projektu,
w którym jest klient OAuth z 3.4. Jeśli dostęp ma inny projekt — najprościej
użyć klienta OAuth z tamtego projektu.

**3.6 (opcjonalnie) Basic access — wyższy limit.** Explorer wystarcza do startu;
Basic podnosi dzienny limit operacji na realnych kontach. **Zaproponuj, nie
wymuszaj.**

> ⚠️ **Nie masz dostępu do paneli Google — nie wypełnisz ani nie wyślesz formularza
> za użytkownika.** Twoja rola: podać dokładnie, co kliknąć i co wpisać, a potem
> **potwierdzić z użytkownikiem, że wysłał**.

1. Google wymaga najpierw **weryfikacji marki** (brand verification) projektu —
   ekran w sekcji „Upgrade access level" pokaże, czego brakuje. **Poproś
   o zrzut ekranu** i prowadź na jego podstawie, nie zgaduj.
2. Gdy weryfikacja zaliczona i poziom to **Explorer** → **„Apply for access"**
   (następny poziom: **Basic**). **Zapytaj**, czy użytkownik zarządza **własnym
   kontem**, czy **kontami klientów (agencja)**, i napisz gotowy opis po
   angielsku (3–5 zdań: wewnętrzne narzędzie łączące się z kontami Google Ads
   przez API w celu odczytu danych i rutynowych optymalizacji — budżety, słowa
   wykluczające, status kampanii — przez asystenta AI w Claude Code); daj do
   akceptacji **zanim wklei**. **Użytkownik klika „Wyślij".**
3. **Potwierdź wprost**, że wniosek poszedł. Basic bywa przyznawany
   automatycznie; jeśli nie — trafia do weryfikacji Google.

**Dalszy przebieg, gdy dostęp nie został przyznany od ręki** (zaproponuj
**dopiero po potwierdzonej wysyłce**, wytłumacz po ludzku):

- **A — dokończmy teraz, co się da.** Wygenerujemy **refresh token** (jednorazowe
  logowanie w przeglądarce, krok 4). Wtedy wszystko jest gotowe poza ostatnim
  testem. Gdy Google przyzna dostęp — wracasz, robimy tylko test.
- **B — przerwijmy teraz.** Wszystko, co zebraliśmy, jest już zapisane w pliku.
  Gdy dostaniesz dostęp, wróć i napisz **„Mam dostęp do API, kontynuujmy
  onboarding"**.

**3.7 Sprawdź plik.** Dane były zapisywane na bieżąco, więc `~/google-ads.yaml`
powinien już zawierać `client_id`, `client_secret` oraz `login_customer_id`
(numer MCC) albo — bez MCC — `default_customer_id` (numer konta); 10 cyfr bez
myślników. Upewnij się **bez wyświetlania zawartości**, że pola nie są puste —
jeśli któreś umknęło, dopisz je teraz. Pole `refresh_token` zostaw puste —
uzupełni się automatycznie w kroku 4.

## Krok 4 — Wygeneruj refresh token

1. Uruchom `npm run connector:auth`.
2. W konsoli pojawi się **link** — przekaż go użytkownikowi. Niech otworzy go w
   przeglądarce i **zaloguje się dokładnie tym kontem Google, które ma dostęp do
   kont Google Ads (lub MCC)** (to samo, które dodaliście jako Test user w 3.3), a następnie zatwierdzi
   uprawnienia. Zalogowanie **innym** kontem = token bez dostępu do właściwych
   kont Ads (typowy błąd).
   - Link **wymusza wybór konta**. Jeśli pojawi się złe konto, kliknij **„Użyj
     innego konta"** i wybierz to z dostępem do kont Ads. Gdy nie ma go na liście —
     najpierw zaloguj się na nie w przeglądarce (lub użyj trybu incognito / innego
     profilu), potem otwórz link ponownie.
3. Po zatwierdzeniu token zapisze się automatycznie do `~/google-ads.yaml`.

## Krok 5 — Sprawdź połączenie

Uruchom `npm run connector:test`. Jeśli zobaczysz dane konta — **instalacja
zakończona**. 🎉

Jeśli pojawi się błąd `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (w starszych
wersjach API: `AUTHORIZATION_ERROR` lub `DEVELOPER_TOKEN_NOT_APPROVED`), projekt
Google Cloud ma jeszcze tylko dostęp **„Test"**. To nie błąd instalacji —
wszystko inne jest gotowe. Wróć do 3.5, a jeśli wniosek już wysłany — niech
użytkownik wróci z *„Mam dostęp do API, kontynuujmy onboarding"*.

## Krok 6 (opcjonalny) — Google Analytics 4

Rób ten krok tylko, jeśli użytkownik chce też danych z GA4. Google Ads działa bez niego.

**6.1. Włącz dwa API** w **tym samym** projekcie Google Cloud, w którym powstał klient
OAuth z kroku 3 — nie zakładaj nowego projektu:

- https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com
- https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com

Jeśli któregoś zabraknie, konektor zwróci gotowy link aktywacyjny z numerem projektu.

**6.2. Autoryzuj.** Konektor używa tego samego `client_id`/`client_secret` co Google Ads
(z `~/google-ads.yaml`), ale **własnego tokena** — zakres jest inny (`analytics.readonly`),
więc nie wolno nadpisać tokena Adsów.

```bash
npm run ga4:auth
```

Podaj użytkownikowi wypisany link, **uruchom nasłuch w tle** (`npm run ga4:auth-listen`)
i poczekaj, aż potwierdzi kliknięcie. Logować ma się kontem Google, które ma dostęp do
usług GA4 klientów.

**6.3. Sprawdź:**

```bash
npm run ga4:test
node .claude/skills/ga4-connector/scripts/cli.js --action=properties
```

Druga komenda wypisze wszystkie usługi widoczne dla tego konta razem z ich ID. Jeśli
część usług należy do innego konta Google, autoryzuj je jako osobny profil
(`--profile=<nazwa>`) — opis w `.claude/skills/ga4-connector/SKILL.md`.

---

## Krok 7 (opcjonalny) — Google Search Console

Rób ten krok tylko, jeśli użytkownik chce też danych o SEO: pozycji i kliknięć z
wyszukiwarki albo diagnozy indeksowania. Google Ads działa bez niego.

**7.1. Włącz API** w **tym samym** projekcie Google Cloud, w którym powstał klient
OAuth z kroku 3:

- https://console.cloud.google.com/apis/library/searchconsole.googleapis.com

**7.2. Autoryzuj.** Konektor używa tego samego `client_id`/`client_secret` co Google Ads,
ale **własnego tokena** — zakres jest inny (`webmasters.readonly`).

```bash
npm run gsc:auth
```

Podaj użytkownikowi wypisany link, **uruchom nasłuch w tle** (`npm run gsc:auth-listen`)
i poczekaj, aż potwierdzi kliknięcie. Logować ma się kontem Google, które ma dostęp do
property w Search Console.

**7.3. Sprawdź:**

```bash
npm run gsc:test
node .claude/skills/gsc-connector/scripts/cli.js --action=sites
```

Druga komenda wypisze wszystkie property widoczne dla tego konta razem z poziomem
uprawnień. Zwróć uwagę na zapis: `sc-domain:example.com` (property domenowa) i
`https://example.com/` (prefiks URL) to **dwa różne obiekty** — trzeba używać dokładnie
tego, co wypisała ta lista, inaczej Google odpowiada 403.

Sprawdź na tej liście, czy login widzi wszystkich klientów. Jeśli tak — gotowe. Jeśli
części brakuje, brakujące konta autoryzuj jako osobne profile (`--profile=<nazwa>`) —
opis w `.claude/skills/gsc-connector/SKILL.md`.

**7.4. Zaproponuj rejestr kont.** Jeśli `.claude/accounts.json` jeszcze nie istnieje,
zaproponuj użytkownikowi jego założenie — wtedy zamiast pełnego zapisu property wystarczy
alias (`--site=zielonyogrod`), wspólny z konektorami Google Ads i GA4. Format opisuje
`.claude/skills/gads-connector/references/accounts.example.json`; najprostsza droga to
`--action=remember` (tworzy rejestr przy pierwszym zapisie), po jednej property naraz
i tylko za potwierdzeniem użytkownika, bo alias to decyzja nazewnicza.

---

## Po instalacji

- Poproś użytkownika, żeby raz zamknął i ponownie otworzył ten projekt w Claude
  Code. Skile ładują się przy starcie sesji, więc będą dostępne dopiero po
  ponownym otwarciu.
- Pogratuluj i krótko powiedz, co dalej: od teraz użytkownik może prosić Cię
  (Claude) o dane z konta Google Ads lub o zmiany, a szczegóły działania opisuje
  `.claude/skills/gads-connector/SKILL.md`.
- Jeśli robiłeś krok 6, wspomnij o `ga4-connector`: dane z Google Analytics 4
  (kanały, kampanie, strony docelowe, produkty, kohorty) i konfiguracja usługi
  (strumienie, kluczowe zdarzenia, atrybucja, połączenie z Ads). **Tylko odczyt** —
  nie zmieni klientowi ustawień. Szczegóły: `.claude/skills/ga4-connector/SKILL.md`.
- Wspomnij, że w paczce jest też drugi skill — `gads-reklamy` (pisanie reklam
  Google Ads / RSA po polsku). **Nie wymaga żadnej konfiguracji ani dostępu do
  API** — działa od razu; wystarczy poprosić o napisanie reklam i podać URL
  strony. Szczegóły: `.claude/skills/gads-reklamy/SKILL.md`.
- Przypomnij: plik `~/google-ads.yaml` zawiera sekrety — **nie wysyłać go nikomu
  i nie wrzucać do repozytorium**.

---

## Gdy coś nie działa — szybka diagnostyka

| Objaw | Co zrobić |
|---|---|
| `invalid_grant` | Refresh token wygasł → ponów `npm run connector:auth`. Jeśli się powtarza, w ekranie zgody OAuth **opublikuj aplikację** (status „In production"). |
| `redirect_uri_mismatch` (Błąd 400 przy logowaniu) | **Problem klienta OAuth, NIE konta — zmiana zalogowanego konta tego nie naprawi.** Klient został utworzony jako „Web application" zamiast **Desktop app**. Utwórz nowy klient **Desktop app** (3.4), wstaw jego `client_id`/`client_secret` do `~/google-ads.yaml` i ponów `npm run connector:auth`. (Alternatywnie: w istniejącym kliencie Web dodaj `http://localhost:3000/oauth2callback` do *Authorized redirect URIs*.) |
| `PERMISSION_DENIED` | Sprawdź `login_customer_id` (numer MCC, jeśli używasz) i czy konto Google ma dostęp do tego konta Ads. |
| Autoryzacja OAuth blokowana („Access blocked" / „nie zweryfikowano aplikacji" dla danego konta) | Logujesz się kontem, którego **nie ma** na liście **Test users** (3.3), albo aplikacja nie jest opublikowana. Dodaj to konto jako Test user **lub** kliknij **Publish app**. Konto musi mieć dostęp do konta Google Ads (lub MCC). |
| `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (lub starsze `DEVELOPER_TOKEN_NOT_APPROVED`) | Projekt Cloud ma poziom „Test" → na stronie **Google Ads API Overview** złóż wniosek o Explorer (3.5). Sprawdź też, czy klient OAuth jest w **tym samym** projekcie, który ma dostęp. |
| GA4: `has not been used` / `is disabled` | Nie włączono Analytics Data albo Analytics Admin API (krok 6.1). Konektor podaje gotowy link — kliknij „Włącz" i odczekaj minutę. |
| GA4: 403 przy konkretnej usłudze | Zalogowane konto nie ma do niej dostępu. `--action=properties` pokaże, co widzi. Usługa na innym koncie Google → autoryzuj ją jako osobny profil (`--profile=`). |
| `Missing required ... configuration` | Plik `~/google-ads.yaml` nie został wypełniony lub nie został znaleziony. |
| Błędy importu modułów | Uruchom `npm install` w folderze paczki. |
| `node` nie jest rozpoznawane | Otwórz **nowy** terminal po instalacji Node.js (albo zrestartuj komputer na Windows). |
