---
name: gads-reklamy
description: Pisze skuteczne reklamy Google Ads (RSA) po polsku w 4-etapowym procesie — zbiera dane, robi research firmy i konkurencji, proponuje kąty reklamowe do akceptacji, dopiero potem generuje nagłówki/teksty/objaśnienia w pełnym formacie RSA. Używaj gdy użytkownik mówi "napisz reklamy", "stwórz reklamy Google Ads", "RSA", "headlines do Google Ads", "teksty reklam", podaje URL i prosi o reklamy.
---

# Reklamy Google Ads (RSA)

Tworzy komplet RSA po polsku w 4 etapach z bramkami akceptacji. **Nie pomijaj etapów** — research → kąty → akceptacja → reklamy.

## ETAP 1 — Pobierz URL strony usługi

Zapytaj **tylko o jedno**:

> „Podaj URL strony usługi, którą reklamujemy."

## ETAP 2 — Research (firma + rynek + konkurencja)

### 2.1 Odwiedź strony

Użyj WebFetch:
- Stronę usługi (obowiązkowo)
- Stronę główną (wyderywowaną z URL usługi np. `example.com/usluga` → strona główna `example.com`)
- Stronę „o nas" / cennik / FAQ jeśli są (szybko, dla USP i obiekcji)

Potwierdź: „Odwiedziłem [URL]" — w 1 zdaniu.

### 2.2 Zrozum firmę

- **Przeanalizuj firmę**: Zrozum co firma sprzedaje i jakie ma usługi? Co jest główną usługą, a co pobocznymi?
- **Główne obietnice**: 3 najważniejsze korzyści (nie cechy!), które firma daje klientom.
- **Unique Selling Proposition**: Co jest najważniejszym wyróżnikiem tej firmy?
- **Obecna komunikacja**: Jakich argumentów sprzedażowych firma używa na swojej stronie internetowej?
- **Opinie**: Sprawdź opinie w Google Maps - Czy firma posiada pozytywne opinie w których użytkownicy podkreślają jakieś pozytywne cechy warte pokreślenia w reklamie?

### 2.3 Potwierdź zrozumienie (BRAMKA — krótka)

Pokaż użytkownikowi, co wywnioskowałeś ze strony:

```
## Sprawdzam, czy dobrze rozumiem:

- **Firma:** [nazwa]
- **Reklamujemy:** [usługa]
- **Branża:** [...]
- **Lokalizacja zasięgu:** [lokalnie: miasto / regionalnie / ogólnopolsko] — *moje wnioski ze strony*
- **Główny target:** [B2B / B2C, segment]
- **USP które widzę:** [...]
- **Sugerowane CTA:** [...]

**Czy się zgadza?** Daj znać, jeśli coś dopisać lub zmienić (np. budżet, USP do podkreślenia, czego unikać, preferowane CTA).
Jeśli OK — idę dalej z konkurencją i personą.
```

Czekaj na krótką odpowiedź. Jeśli „ok" — kontynuuj. Jeśli uwagi — uwzględnij i idź dalej (nie wracaj do bramki).

### 2.4 Voice of Customer (z opinii naszej firmy)

Sprawdź czy znajdziesz opinie o firmie:
- Jeśli dostępny jest MCP Playwright (lub Chrome) —> Otwórz google.com/maps/search/{firma}, zaakceptuj zgodę cookies i przeczytaj opinie (webFetch na Maps nie zadziała — użyj przeglądarki). Rozwiń «Więcej opinii», by 10-20 opinii (lub wszystkie, jeśli mniej).
- wyszukaj w Google: {firma} + opinie (używaj WebSearch)
- na stronie firmy

Oceń jakie są najmocniejsze argumenty i zwroty, którymi klienci chwalą firmę i warto ich użyć w reklamie?

### 2.5 Persona (Core 4)

Stwórz 1-3 profile najważniejszych klientów:
- **Bóle i frustracje**: Co go aktualnie najbardziej irytuje w jego sytuacji i pcha do kupna danej usługi / produktu?
- **Głębokie pragnienie**: Jaki jest jego prawdziwy, głęboki, emocjonalny motyw zakupu?
- **Wymarzony efekt (Dream Outcome)**: Jak wygląda jego idealny świat po skorzystaniu z oferty?
- **Obiekcje**: Czego się boi przed kliknięciem "Kup/Zamów"?

Oceń, jakie są najważniejsze kwestie, do których warto się odwołać w reklamie?

### 2.6 Branża

1. Przeanalizuj dostępne badania i analizy marketingowe pod kontem tego: jakie aspekty najlepiej podkreślić reklamie tego typu produktu / usługi. Co jest ważne dla klienta? Dlaczego klienci kupują?
2. Jakie aspekty ważne dla klienta w tej branży najbardziej pasują do tej firmy?

## ETAP 3 — Strategia i kąty (BRAMKA AKCEPTACJI)

Przed pisaniem reklam podsumuj najważniejsze wnioski z powyższych analiz i czekaj na akceptację.

Zakończ pytaniem: **„Czy akceptujesz ten kierunek? Mogę pisać reklamy, czy chcesz coś poprawić?"**

**STOP** — czekaj na potwierdzenie. Krótkie uwagi użytkownika uwzględnij i pisz od razu (nie wracaj do bramki, chyba że zmiana jest fundamentalna).

## ETAP 4 — Napisz reklamy (RSA)

Na podstawie zebranych informacji napisz możliwe najlepsze:

Nagłówki reklamowe:
- 20 nagłówków reklamowych.
- Długość: max **30 znaków** (po polsku)

Teksty reklamowe
- 8 tekstów reklamowych łączących różne kąty reklamowe i inne argumenty
- Dany tekst reklamowy skupiony na 1 lub 2 argumentach + CTA
Długość:  max **90 znaków** (po polsku)

- Posortuj nagłówki i opisy "od najlepszego"

### Zasady tworzenia

**Wyniki przedstaw w czytelnej tabeli.**

**Bądź tak specyficzny jak to tylko możliwe**

**Standardowe kąty reklamowe** — Sprawdź czy pokryłeś poniższe kąty reklamowe, jeśli nie, to dopisz nagłówki z pasujących poniższych kategorii:
1. Główna korzyść (problem → rozwiązanie)
2. USP / wyróżnik
3. Cena / oferta / promocja
4. Gwarancja / brak ryzyka
5. Dowód społeczny (lata, klienci, opinie z liczbą)
6. CTA (silne wezwanie)
7. Pilność / dostępność
8. Liczba / symbol / konkret (np. „24h", „od 99 zł", „bez prowizji")

### Walidacja przed wysłaniem

Po wygenerowaniu **przejdź checklist** i napisz krótkie podsumowanie:
- [ ] Wszystkie krótkie nagłówki ≤ 30 znaków
- [ ] Wszystkie długie nagłówki i opisy ≤ 90 znaków
- [ ] Nagłówki brzmią dobrze w języku Polskim, a ich przekaz (korzyść) jest zrozumiała dla klienta.

Jeśli któryś punkt nie przechodzi — popraw przed pokazaniem użytkownikowi.

## Walidacja
[checklist z [x]]

### Zakończenie

Po napisaniu reklam zapytaj czy nagłówki się podobają, czy spróbować z innym kątem reklamowym (którym?), czy jest ok i potrzeba dopisać:
- Objaśnienia: **10 objaśnień (callouts)** — max **25 znaków**
- Sitelinki: **4 sitelinki** (tekst max 25 znaków + 2 opisy max 35 znaków każdy)
- Rozszerzenia informacji: **1-3 strukturalne fragmenty**
    - 1 nagłówek z wybranych typów (wybierz pasujący do biznesu): Usługi, Typy, Modele, Udogodnienia, Marki, Style, Miejsca docelowe, Okolice, Polecane hotele, Programy, Ubezpieczenia, Kierunki studiów, Kursy
    - 4-10 wartości max 25 znaków
- Długie nagłówki:
    - 5x Wybrane i połączone najlepsze argumenty w zgrabną całość
    - Format: Produkt + Argument + CTA
    Długość: max **90 znaków** (po polsku)