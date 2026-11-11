---
name: feedback
description: >
  Wysyła autorom Ads-Agent zgłoszenie błędu albo pomysł na usprawnienie: ustala, czego
  dotyczy, zbiera z rozmowy potrzebny kontekst (skill, komenda, treść błędu), pokazuje
  dokładnie, co wyśle, i wysyła dopiero po zgodzie. USE WHEN użytkownik mówi "/feedback",
  "zgłoś błąd", "coś nie działa, zgłoś to", "mam pomysł na skill", "prześlij uwagę autorom",
  "wyślij feedback". NIE używaj do naprawiania błędu w tej sesji — zgłoszenie tylko
  informuje autorów.
  Triggers: "/feedback", "zgłoś błąd", "zgłoś pomysł", "wyślij uwagę".
---

# Skill: feedback

Jedno zadanie: **przekazać autorom paczki krótkie, zrozumiałe zgłoszenie — bez danych
klientów.** Mów po polsku, prosto. Komendy uruchamiasz z korzenia projektu.

## Krok 1 — Ustal, co zgłaszamy

- **Rodzaj:** `blad` (coś nie działa) albo `pomysl` (propozycja, nowy skill, usprawnienie).
  Zwykle wynika z wypowiedzi — pytaj tylko, gdy nie wynika.
- **Błąd:** jeśli czegoś ważnego brakuje, dopytaj o 1–2 rzeczy naraz (np. co dokładnie
  wpisał i co zobaczył). Nie przesłuchuj.
- **Kontekst zbierz sam z rozmowy:** którego skilla dotyczy, jaka komenda poszła, treść
  błędu, co już próbowaliście. Wersję paczki, system i Node dołoży skrypt.

**Dane klientów nie trafiają do zgłoszenia.** Nazwy klientów i kampanii, ID kont, domeny,
kwoty, adresy e-mail, tokeny i klucze zastępujesz ogólnikiem („konto klienta”, „kampania
PMax”, `1234567890`). Opisujesz problem, nie konto.

## Krok 2 — Podgląd

Przekaż zgłoszenie jako JSON na wejście skryptu (pola: `rodzaj`, `skill` — sama nazwa,
może być pusta, `opis` — 1–5 zdań, `kontekst` — komenda, błąd, próby; `mail` — patrz niżej):

```bash
node .claude/skills/feedback/scripts/feedback.js --action=podglad <<'EOF'
{"rodzaj":"blad","skill":"gads-connector","opis":"…","kontekst":"…"}
EOF
```

Skrypt nic nie wysyła. Zwraca `zgloszenie` (dokładnie to, co poleci), `pro` i `plik`.
`stan: blad` → popraw według `komunikat` i powtórz.

**Mail do odpowiedzi:** gdy `pro: false`, zapytaj raz, czy podać e-mail, na który możemy
odpowiedzieć (można pominąć) — jeśli poda, powtórz podgląd z polem `mail`. Gdy `pro: true`,
nie pytaj: serwer rozpozna kupującego po kluczu z `.env` (klucza nie pokazuj).

Pokaż użytkownikowi całe `zgloszenie` i zapytaj, czy wysłać. Zmiany → nowy podgląd.

## Krok 3 — Wyślij (tylko po zgodzie)

```bash
node .claude/skills/feedback/scripts/feedback.js --action=wyslij --plik=<plik z podglądu>
```

`stan: wyslane` → podziękuj i podaj `numer` zgłoszenia. Inny stan → przekaż `komunikat`
(przy `blad-sieci` zaproponuj spróbować później; zgłoszenie z podglądu nadal czeka w `plik`).
