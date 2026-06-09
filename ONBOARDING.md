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
  ponownie i wznów od **kroku 5** (test połączenia) — wcześniejsze kroki są już
  wykonane.

---

## Krok 1 — Sprawdź środowisko

1. Upewnij się, że jesteś w folderze sklonowanej paczki (zawiera `package.json`
   i ten plik). Jeśli nie — przejdź do niego.
2. Sprawdź Node.js: `node --version` (potrzebna wersja **18 lub nowsza**) oraz
   `npm --version`.
3. Jeśli Node.js nie jest zainstalowany lub jest za stary — poprowadź instalację:
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

**3.1 Projekt w Google Cloud.** Wejdź na
[console.cloud.google.com](https://console.cloud.google.com) → utwórz nowy projekt
(dowolna nazwa, np. „Ads-Agent") i upewnij się, że jest wybrany u góry ekranu.

**3.2 Włącz Google Ads API.** APIs & Services → Library → wyszukaj
**Google Ads API** → **Enable**.

**3.3 Ekran zgody OAuth.** APIs & Services → OAuth consent screen → User type:
**External** → wypełnij nazwę aplikacji i e-maile → dodaj adres użytkownika jako
**Test user**.
⚠️ **Ważne:** w trybie „Testing" refresh token wygasa po **7 dniach**. Żeby token
był trwały, kliknij **Publish app** (status „In production"). Pojawi się
ostrzeżenie o niezweryfikowanej aplikacji — to **normalne** dla narzędzia, którego
użytkownik używa sam; przejdź dalej.

**3.4 Client ID + Client Secret.** APIs & Services → Credentials →
Create credentials → OAuth client ID → Application type: **Desktop app** →
Create. Skopiuj **Client ID** i **Client Secret**.

**3.5 Skopiuj developer token.** Zaloguj się do Google Ads na **koncie menedżera
(MCC)** → Tools & Settings → API Center. Znajdziesz tam **developer token** —
skopiuj go. Ten token istnieje od razu, ale na starcie ma poziom dostępu
**„Test account"**: działa tylko na kontach testowych. Żeby używać go na
**realnych kontach**, trzeba złożyć wniosek o **Basic access** (krok 3.6). Sam
ciąg tokena się przy tym nie zmieni — zmieni się tylko jego zakres dostępu.

**3.6 Złóż wniosek o Basic access.** To osobny, trochę dłuższy krok — przeprowadź
przez niego użytkownika spokojnie:

- W tym samym **API Center** znajdź opcję podniesienia poziomu dostępu / złożenia
  wniosku (**Apply for Basic access**) i otwórz formularz.
- Formularz wymaga m.in. **opisu narzędzia i sposobu użycia API** oraz danych
  kontaktowych. Najpierw **zapytaj użytkownika**, czy zarządza **własnym kontem**,
  czy **kontami klientów (agencja)** — od tego zależy treść opisu. Następnie
  **zaproponuj gotowy opis** (sam go napisz, po angielsku, 3–5 zdań: że to
  wewnętrzne narzędzie łączące się z kontami Google Ads przez API w celu odczytu
  danych i rutynowych optymalizacji — budżety, słowa wykluczające, status kampanii —
  przez asystenta AI w Claude Code) i daj użytkownikowi do akceptacji/edycji,
  zanim go wklei.
- Pomóż uzupełnić pozostałe pola (e-mail kontaktowy, kraj, akceptacja warunków) i
  **wyślij wniosek**.
- Po wysłaniu **wyjaśnij, co teraz**: wniosek trafia do **ręcznej weryfikacji
  Google**, która trwa zwykle **1–2 dni robocze**. Do tego czasu połączenie z
  realnym kontem nie zadziała.
- Daj użytkownikowi **wybór**: możecie albo **dokończyć teraz** kroki, które nie
  wymagają zatwierdzenia (3.7 i krok 4 — zapis danych i refresh token), i
  zatrzymać się przed testem połączenia; albo **przerwać tutaj** i wrócić po
  zatwierdzeniu.
- W obu przypadkach **powiedz wyraźnie**: *„Gdy Google zatwierdzi dostęp
  (dostaniesz potwierdzenie / w API Center zobaczysz poziom «Basic»), wróć tu i
  napisz: «Mam klucz API, kontynuujmy onboarding» — dokończę test połączenia."*

**3.7 Zapisz dane.** Utwórz plik `~/google-ads.yaml` na bazie szablonu
`.claude/skills/gads-connector/references/google-ads.yaml.example` i wpisz:
`developer_token`, `client_id`, `client_secret` oraz `login_customer_id`
(numer konta MCC, 10 cyfr bez myślników). Pole `refresh_token` zostaw puste —
uzupełni się w kroku 4. **Nie wyświetlaj zawartości tego pliku w czacie.**

## Krok 4 — Wygeneruj refresh token

1. Uruchom `npm run connector:auth`.
2. W konsoli pojawi się **link** — przekaż go użytkownikowi. Niech otworzy go w
   przeglądarce, zaloguje się na konto Google **mające dostęp do kont Google Ads**
   i zatwierdzi uprawnienia.
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
| `PERMISSION_DENIED` | Sprawdź `login_customer_id` (numer MCC) i czy konto Google ma dostęp do tego konta Ads. |
| `DEVELOPER_TOKEN_NOT_APPROVED` | Token czeka na zatwierdzenie przez Google albo jest używany na realnym koncie przed uzyskaniem Basic access. |
| `Missing required ... configuration` | Plik `~/google-ads.yaml` nie został wypełniony lub nie został znaleziony. |
| Błędy importu modułów | Uruchom `npm install` w folderze paczki. |
| `node` nie jest rozpoznawane | Otwórz **nowy** terminal po instalacji Node.js (albo zrestartuj komputer na Windows). |
