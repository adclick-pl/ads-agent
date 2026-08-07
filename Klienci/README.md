# Klienci

Jeden podfolder na klienta: `Klienci/<alias>/`. Strukturę folderu opisuje `CLAUDE.md` w korzeniu pakietu.

## config.json

Wymagane są tylko `alias` i `googleAdsId`, reszta jest opcjonalna. Klucze zaczynające się od `_` są ignorowane.

```json
{
  "_README": "Kontekst klienta dla skilli Ads-Agent. Skopiuj ten plik do Klienci/<alias>/config.json i wypełnij. Wymagane są tylko alias i googleAdsId. Klucze zaczynające się od _ są ignorowane. Opis pól: Klienci/README.md.",

  "name": "Zielony Ogród sp. z o.o.",
  "alias": "zielonyogrod",
  "googleAdsId": "1234567890",
  "website": "https://zielonyogrod.example",
  "currency": "PLN",

  "businessType": "ecommerce",
  "industry": "sklep ogrodniczy",
  "seasonality": "Szczyt marzec-czerwiec. Lipiec-sierpień dołek. Listopad-grudzień słabo, poza choinkami.",

  "targetRoas": 3.5,
  "targetCpa": null,
  "leadValue": null,

  "campaignTargets": {
    "[PMax] Nasiona": { "targetRoas": 6.0 },
    "[Search] Marka": { "targetRoas": 8.0 }
  },
  "leadValuePerCampaign": {},

  "conversionValueDivisor": 1,
  "margin": 0.35,
  "breakEvenRoas": 2.9,

  "budgetControl": true,
  "monthlyBudget": null,

  "lastUpdated": "2026-07-29"
}
```

| Pole | Opis |
|---|---|
| `name` | pełna nazwa do nagłówków raportów |
| `alias` | klucz łączący folder, `accounts.json` i flagę `--account` |
| `googleAdsId` | 10 cyfr, bez myślników |
| `website` | adres do researchu oferty |
| `currency` | waluta konta |
| `businessType` | `ecommerce` \| `leadgen` \| `local`; `null` = wykryj po wartości konwersji |
| `industry` | branża klienta |
| `seasonality` | proza; chroni przed wycięciem kategorii w dołku sezonowym |
| `targetRoas` | ecom — punkt odniesienia zamiast średniej kampanii |
| `targetCpa` | leadgen — j.w. |
| `leadValue` | wartość leada; pozwala liczyć ROAS dla leadgenu |
| `campaignTargets` | override celu per kampania |
| `leadValuePerCampaign` | wartość leada per kampania |
| `conversionValueDivisor` | dzielnik wartości konwersji przy podwójnym liczeniu; `1` = bez zmian |
| `margin` | marża brutto (0–1) |
| `breakEvenRoas` | ROAS progu rentowności |
| `budgetControl` | czy wolno ruszać budżety |
| `monthlyBudget` | budżet miesięczny ustalony z klientem |
| `lastUpdated` | `YYYY-MM-DD` |

Klucz w `campaignTargets` to **dokładna** nazwa kampanii z Google Ads. Po zmianie nazwy w panelu override przestaje działać i kampania wraca do celu konta.

Gdy konto jest w `.claude/accounts.json`, tamtejsze `website` i `currency` mają pierwszeństwo.

`config.json` trzyma krótkie wartości: liczby, typ konta, branżę. Opis oferty — co klient sprzedaje, czego nie robi, do kogo kieruje — idzie do `Kontekst/kontekst.md`.

## Skąd bierze się kontekst

`config.json` i `Kontekst/kontekst.md` to wspólna pamięć o kliencie. Każdy skill może z nich korzystać — i każdy powinien do nich dopisywać, gdy w trakcie pracy pojawi się nowa informacja o kliencie.

- **`kontekst.md`** powstaje z szablonem przy pierwszym uruchomieniu skilla, który go potrzebuje. Treść bierze się ze strony klienta (oferta, kategorie, zasięg) i z rozmowy z użytkownikiem. Rośnie narastająco: trwałe ustalenia — „nie wysyłamy za granicę", „celowo licytujemy konkurencję", „wchodzimy w nową kategorię" — dopisuje się od razu, gdy padną.
- **`config.json`** jest wypełniany podczas pracy z kontem oraz w rozmowie z użytkownikiem (cele typu `targetRoas` zna tylko on), ale wartości wykryte w trakcie pracy — typ biznesu, branżę — warto do niego wpisać, żeby następna sesja nie wykrywała ich od nowa.

Im pełniejsze te dwa pliki, tym mniej pytań przy każdej kolejnej pracy na koncie.
