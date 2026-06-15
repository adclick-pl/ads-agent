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
  zatwierdzenie developer tokena przez Google (krok 3.6). Jeśli użytkownik wraca
  i pisze np. *„Mam klucz API, kontynuujmy onboarding"*, przeczytaj ten plik
  ponownie i **wznów od pierwszego brakującego elementu** — nie zaczynaj od zera.
  Sprawdź (bez wyświetlania zawartości), co jest już w `~/google-ads.yaml`:
  jeśli brakuje `refresh_token` → zrób **krok 4**, a potem **krok 5** (test); jeśli
  plik jest kompletny → od razu **krok 5**. Dane konfiguracyjne (`developer_token`,
  `client_id`, `client_secret`, `login_customer_id`) były zapisywane na bieżąco,
  więc powinny już tam być.

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

1. W folderze paczki uruchom: `npm install`.
2. Następnie uruchom self-test, który **nie wymaga żadnych danych dostępowych**:
   `npm run connector:smoke`. Powinien przejść bez błędów — to potwierdza, że
   paczka jest poprawnie zainstalowana.

## Krok 3 — Skonfiguruj dostęp do Google Ads API

To najdłuższy etap — same kliknięcia w panelach Google. Przeprowadź użytkownika
przez poniższe punkty **pojedynczo**, otwierając mu linki i czekając, aż poda
każdą wartość. Nie spiesz się. Na końcu macie cztery dane: developer token,
Client ID, Client Secret oraz refresh token (ten ostatni powstanie w kroku 4).

**Najpierw ustal: konto menedżera (MCC).** Developer token (krok 3.5) można
uzyskać **wyłącznie z konta menedżera Google Ads (MCC)** — zwykłe konto reklamowe
nie ma sekcji API Center. **Zapytaj użytkownika, czy ma konto menedżera:**

- **Ma MCC** → poproś o jego **10-cyfrowy numer** (to będzie `login_customer_id`
  w kroku 3.7) i przejdź dalej.
- **Nie ma MCC** → poprowadź **założenie** (darmowe): otwórz
  [ads.google.com/home/tools/manager-accounts](https://ads.google.com/home/tools/manager-accounts)
  → „Utwórz konto menedżera" → podaj nazwę, kraj i walutę. Następnie **połącz** z
  tym MCC konto(a) Google Ads, którymi użytkownik chce zarządzać: w panelu MCC
  → Konta → Połącz istniejące konto → podaj numer konta (właściciel konta musi
  zaakceptować zaproszenie). Numer nowego MCC to przyszły `login_customer_id`.

**Które konto Google? (WAŻNE — zapamiętaj na kroki 3.1–4).** Ustal **adres konta
Google, które ma dostęp do tego MCC**. Tym samym kontem wykonacie **całą**
konfigurację w Google Cloud (3.1–3.4), dodacie je jako **Test user** (3.3) i **nim**
użytkownik autoryzuje aplikację (krok 4). To **niekoniecznie** adres, na którym
użytkownik ma konto Claude — **nie podstawiaj go automatycznie**. Jeśli nie masz
pewności, **zapytaj użytkownika, na którym koncie Google jest jego MCC**, i używaj
tego adresu wszędzie w krokach 3–4. Gdy konto autoryzujące (krok 4) różni się od
Test usera (3.3) albo nie ma dostępu do MCC — połączenie się nie powiedzie.

**Zasada zapisu — zapisuj OD RAZU (krytyczne przy przerwaniu).** Każdą zdobytą
wartość zapisuj do `~/google-ads.yaml` **natychmiast**, nie odkładaj na koniec.
Instalacja często się zatrzymuje na 3.6 (oczekiwanie na Basic access — od kilku
dni do ~2 tygodni; użytkownik wtedy **zamyka czat**). **To, co w pliku — przetrwa; to, co tylko
w rozmowie — przepada wraz z niedokończonym czatem.** Dlatego:

- **Teraz, zanim ruszysz dalej:** utwórz `~/google-ads.yaml` na bazie szablonu
  `.claude/skills/gads-connector/references/google-ads.yaml.example` i od razu wpisz
  `login_customer_id` (numer MCC, 10 cyfr bez myślników).
- Po krokach **3.4 i 3.5 dopisuj kolejne wartości do pliku od razu** po ich zdobyciu.
- **Nigdy nie wyświetlaj zawartości pliku** w czacie — możesz tylko potwierdzić, że
  wartość została zapisana.

**3.1 Projekt w Google Cloud.** Wejdź na
[console.cloud.google.com](https://console.cloud.google.com) → utwórz nowy projekt
(dowolna nazwa, np. „Ads-Agent") i upewnij się, że jest wybrany u góry ekranu.

**3.2 Włącz Google Ads API.** APIs & Services → Library → wyszukaj
**Google Ads API** → **Enable**.

**3.3 Ekran zgody OAuth.** APIs & Services → OAuth consent screen.
**Jeśli to pierwsze wejście — najpierw kliknij „Rozpocznij konfigurację" /
„Get started"**; bez tego nie da się wpisać żadnych danych. Następnie uzupełnij:

- **App name** (nazwa aplikacji): dowolna, np. „Ads-Agent".
- **User support email** oraz **Developer contact email**: wpisz **adres konta
  Google z dostępem do MCC** (ten ustalony wyżej). **Nie podstawiaj automatycznie
  adresu, na którym użytkownik ma konto Claude** — jeśli MCC jest na innym koncie
  Google, użyj tamtego.
- **Audience / User type:** **External** (Zewnętrzny).
- **Test users → Add users:** dodaj **ten sam adres** — konto Google z dostępem do
  MCC. W trybie „Testing" **tylko** konta z tej listy mogą autoryzować aplikację;
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

**3.5 Zdobądź developer token (klucz API).** Token jest w **API Center** na koncie
menedżera (MCC): w lewym menu **Administrator** (koło zębate na dole; ang. *Admin*)
→ **Centrum interfejsu API** (ang. *API Center*).
*(Nie widzisz „Centrum interfejsu API"? Upewnij się, że jesteś na **koncie
menedżera (MCC)**, nie na zwykłym koncie reklamowym. Starszy układ: Tools &
Settings → Setup → API Center.)*

**Najpierw zapytaj użytkownika, czy już korzysta z Google Ads API / ma developer
token** — to skraca drogę osobom z gotowym dostępem:

- **Ma już token** → niech wejdzie do API Center i **skopiuje istniejący token**.
  Sprawdźcie też **poziom dostępu** (Access level) — patrz 3.6. Jeśli to już
  **Basic** lub **Standard**, **pomińcie 3.6** (wniosek niepotrzebny).
- **Pierwszy raz** → przy pierwszym wejściu Google **najpierw wyświetli formularz
  dostępu do API** (API contact email, nazwa i typ firmy, „intended use", kraj) —
  **token pojawia się dopiero po jego wysłaniu**. Przeprowadź użytkownika **pole po
  polu**: napisz gotowy „intended use" po angielsku (krótko: wewnętrzne narzędzie
  łączące się z kontami Google Ads przez API w Claude Code — odczyt danych
  i rutynowe optymalizacje), resztę pomóż uzupełnić. **Formularz wypełnia i wysyła
  użytkownik** (nie masz dostępu do tych ekranów). Po wysłaniu Google pokaże
  **developer token** — niech go skopiuje.

**Od razu dopisz** `developer_token` do `~/google-ads.yaml`.

**3.6 Sprawdź poziom dostępu i — jeśli trzeba — złóż wniosek o Basic access.**

Świeży token ma zwykle poziom **„Test account"** (tylko konta testowe) albo
**„Explorer"** (realne konta, ale z ograniczeniami). Pełne użycie realnych kont =
**Basic access**. *Sam ciąg tokena się nie zmienia — rośnie tylko zakres dostępu.*

**Najpierw ustal aktualny poziom** (widoczny przy „Access level" w API Center) i na
tej podstawie zdecyduj:

- **Basic** lub **Standard** → gotowe, **pomiń resztę 3.6**, przejdź do kroku 4.
- **Explorer** → połączenie z realnym kontem zwykle zadziała (z limitami) — możesz
  iść dalej, a wniosek o Basic złożyć dla pełnego dostępu.
- **Test account** → realne konta nie zadziałają; trzeba złożyć wniosek o Basic
  i poczekać na zatwierdzenie.

**Jeśli składacie wniosek o Basic access — KOLEJNOŚĆ jest ważna. Przeprowadź
użytkownika przez wypełnienie i wysyłkę, a DOPIERO PO potwierdzeniu wysłania
przejdź do pytania o dalszy przebieg. NIE zadawaj pytania „jak dokończyć", póki
wniosek nie jest wysłany — inaczej instrukcja wypełnienia ginie za pytaniem.**

> ⚠️ **Nie masz dostępu do paneli Google — nie wypełnisz ani nie wyślesz formularza
> za użytkownika.** Twoja rola: podać dokładnie, co kliknąć i co wpisać, a potem
> **potwierdzić z użytkownikiem, że wysłał**.

1. W API Center kliknij **strzałkę przy „Access level"** → **Apply for Basic
   Access** (Złóż wniosek o dostęp podstawowy).
2. **Zapytaj użytkownika**, czy zarządza **własnym kontem**, czy **kontami klientów
   (agencja)** — od tego zależy opis. Potem **napisz gotowy opis po angielsku**
   (3–5 zdań: wewnętrzne narzędzie łączące się z kontami Google Ads przez API
   w celu odczytu danych i rutynowych optymalizacji — budżety, słowa wykluczające,
   status kampanii — przez asystenta AI w Claude Code) i daj do akceptacji/edycji
   **zanim wklei**.
3. Pomóż uzupełnić pozostałe pola (e-mail kontaktowy, kraj, akceptacja warunków).
   **Użytkownik klika „Wyślij".**
4. **Potwierdź wprost:** zapytaj *„Czy wniosek został wysłany?"* i **dopiero po
   „tak"** idź dalej. Nie zakładaj, że wysłany.
5. **Wyjaśnij prosto, co teraz:** wniosek idzie do **ręcznej weryfikacji Google**
   (zwykle **od kilku dni do ~2 tygodni** — bywa backlog i opóźnienia
   w zatwierdzeniach; Google może też poprosić o weryfikację reklamodawcy). Do
   zatwierdzenia realne konta nie zadziałają.

**Dopiero teraz** (po potwierdzonej wysyłce) zaproponuj dalszy przebieg —
**wytłumacz po ludzku, co każda opcja oznacza**, bo osoba robi to pierwszy raz:

- **A — dokończmy teraz, co się da.** Wygenerujemy **refresh token** (jednorazowe
  logowanie w przeglądarce, krok 4). Wtedy wszystko jest gotowe poza ostatnim
  testem, który wymaga zgody Google. Gdy Google zatwierdzi — wracasz, robimy tylko
  test.
- **B — przerwijmy teraz.** Wszystko, co zebraliśmy, jest już zapisane w pliku.
  Gdy dostaniesz zatwierdzenie, wróć i napisz **„Mam klucz API, kontynuujmy
  onboarding"** — dokończę refresh token (jeśli trzeba) i test.

**3.7 Sprawdź plik.** Dane były zapisywane na bieżąco, więc `~/google-ads.yaml`
powinien już zawierać `developer_token`, `client_id`, `client_secret` oraz
`login_customer_id` (numer MCC, 10 cyfr bez myślników). Upewnij się **bez
wyświetlania zawartości**, że żadne z tych pól nie jest puste — jeśli któreś
umknęło, dopisz je teraz. Pole `refresh_token` zostaw puste — uzupełni się
automatycznie w kroku 4.

## Krok 4 — Wygeneruj refresh token

1. Uruchom `npm run connector:auth`.
2. W konsoli pojawi się **link** — przekaż go użytkownikowi. Niech otworzy go w
   przeglądarce i **zaloguje się dokładnie tym kontem Google, które ma dostęp do
   MCC** (to samo, które dodaliście jako Test user w 3.3), a następnie zatwierdzi
   uprawnienia. Zalogowanie **innym** kontem = token bez dostępu do właściwych
   kont Ads (typowy błąd).
   - Link **wymusza wybór konta**. Jeśli pojawi się złe konto, kliknij **„Użyj
     innego konta"** i wybierz to z dostępem do MCC. Gdy nie ma go na liście —
     najpierw zaloguj się na nie w przeglądarce (lub użyj trybu incognito / innego
     profilu), potem otwórz link ponownie.
3. Po zatwierdzeniu token zapisze się automatycznie do `~/google-ads.yaml`.

## Krok 5 — Sprawdź połączenie

Uruchom `npm run connector:test`. Jeśli zobaczysz dane konta — **instalacja
zakończona**. 🎉

Jeśli pojawi się błąd `DEVELOPER_TOKEN_NOT_APPROVED`, to znaczy, że wniosek o
Basic access (krok 3.6) **jeszcze nie został zatwierdzony**. To nie błąd
instalacji — wszystko inne jest gotowe. Powiedz użytkownikowi, żeby wrócił i
napisał *„Mam klucz API, kontynuujmy onboarding"*, gdy Google zatwierdzi dostęp,
a wtedy ponów ten krok.

## Po instalacji

- Poproś użytkownika, żeby raz zamknął i ponownie otworzył ten projekt w Claude
  Code. Skile ładują się przy starcie sesji, więc będą dostępne dopiero po
  ponownym otwarciu.
- Pogratuluj i krótko powiedz, co dalej: od teraz użytkownik może prosić Cię
  (Claude) o dane z konta Google Ads lub o zmiany, a szczegóły działania opisuje
  `.claude/skills/gads-connector/SKILL.md`.
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
| `PERMISSION_DENIED` | Sprawdź `login_customer_id` (numer MCC) i czy konto Google ma dostęp do tego konta Ads. |
| Autoryzacja OAuth blokowana („Access blocked" / „nie zweryfikowano aplikacji" dla danego konta) | Logujesz się kontem, którego **nie ma** na liście **Test users** (3.3), albo aplikacja nie jest opublikowana. Dodaj to konto jako Test user **lub** kliknij **Publish app**. Konto musi mieć dostęp do MCC. |
| `DEVELOPER_TOKEN_NOT_APPROVED` | Token czeka na zatwierdzenie przez Google albo jest używany na realnym koncie przed uzyskaniem Basic access. |
| `Missing required ... configuration` | Plik `~/google-ads.yaml` nie został wypełniony lub nie został znaleziony. |
| Błędy importu modułów | Uruchom `npm install` w folderze paczki. |
| `node` nie jest rozpoznawane | Otwórz **nowy** terminal po instalacji Node.js (albo zrestartuj komputer na Windows). |
