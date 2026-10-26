---
name: google-auth
description: >
  Wspólne logowanie do Google dla wszystkich konektorów paczki (Google Ads, GA4,
  Search Console, Merchant Center, Tag Manager, Gmail, Kalendarz, Arkusze). Jeden
  token na konto Google, nazwany e-mailem, którym faktycznie się zalogowano — kilka
  kont Google działa obok siebie i nic się nie nadpisuje. USE WHEN konektor zgłasza
  brak zgody, `invalid_grant`, „nie jest autoryzowane”, trzeba dodać drugie konto
  Google, dołożyć usługę do konta albo sprawdzić, które konta są podłączone.
  Triggers: "google-auth", "autoryzacja Google", "invalid_grant", "token wygasł",
  "dodaj konto Google", "drugie konto Google", "jakie konta są podłączone".
---

# google-auth

Jeden magazyn tokenów dla wszystkich konektorów. `CLI=.claude/skills/google-auth/scripts/cli.js`
(ścieżka względem katalogu paczki).

## Jak to działa

- **Jeden token na konto Google**: `~/.ads-agent/google/<email>.json`. E-mail pochodzi
  z odpowiedzi Google (`id_token`), nie z tego, kim „miałeś” się zalogować — zalogowanie
  się innym kontem tworzy drugi plik, a nie nadpisuje pierwszego.
- **Usługi dokłada się do tokena**: link dla znanego konta prosi o jego dotychczasowe
  usługi plus nową, więc zgoda na GA4 dla konta, które ma już Ads, daje jeden token z oboma
  (samo `include_granted_scopes` Google nie zawsze dokłada wcześniejsze zgody). Gdyby nowa
  zgoda obejmowała mniej usług niż dotychczasowy token, stary zostaje.
- **Wybór konta przy zapytaniu**: jawne `--account`/`--profile` (e-mail albo etykieta)
  → `GOOGLE_ACCOUNT` w `.env` → jedyne konto z daną usługą → konto domyślne (★).
  W `.claude/accounts.json` klient może mieć `googleAccount` (wszystkie usługi) albo
  `ga4Profile` / `gscProfile` (tylko ta usługa).
- **Klient OAuth**: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` → `GADS_CLIENT_ID`/`GADS_CLIENT_SECRET`
  (`.env`) → `~/google-ads.yaml`. Jeden klient na instalację.
- **Eksporty**: kopie tokena dla narzędzi, które czytają plik same (np. `~/google-ads.yaml`
  dla biblioteki python google-ads). Odświeżane po każdej autoryzacji. Bez konfiguracji —
  tylko `~/google-ads.yaml`, jeśli istnieje. Lista w `~/.ads-agent/google/_config.json`
  → `exports` (typy `google-ads-yaml`, `oauth-token-json`).

## Autoryzacja (agent prowadzi, użytkownik tylko klika)

```bash
node "$CLI" --action=listen --timeout=900          # NAJPIERW, W TLE (musi przeżyć turę)
node "$CLI" --action=auth --services=all           # link dla użytkownika
node "$CLI" --action=auth --services=ga4 --account=ktos@example.com   # dołóż usługę do konta
```

Usługi: `ads, ga4, gsc, gmc, gtm, gmail, calendar, sheets, docs` albo `all`. Jeden nasłuch obsłuży
każdy link; drugi `listen`, gdy pierwszy działa, tylko to zgłosi. Po kliknięciu nasłuch
wypisze konto, usługi i eksporty.

Na ekranie „Google nie zweryfikował tej aplikacji” → **Zaawansowane → Przejdź do…**, potem
zaznacz wszystkie checkboxy.

## Stan i porządki

```bash
node "$CLI" --action=status --check                # konta, usługi, czy tokeny działają
node "$CLI" --action=set-default --account=<email> # konto domyślne (★)
node "$CLI" --action=label --account=<email> --label=<nazwa>
node "$CLI" --action=test --service=ga4 [--account=…]
node "$CLI" --action=sync-exports
```

## Tokeny wygasające co 7 dni

Jeśli `status` pokazuje „token wygaśnie …”, aplikacja OAuth w Google Cloud jest w trybie
„Testing”. Napraw raz: Google Cloud Console → Google Auth Platform → Audience → **Publish app**
(Branding wymaga nazwy, e-maila, strony głównej i polityki prywatności na autoryzowanej domenie;
weryfikacji przez Google nie trzeba). Potem jedna, ostatnia autoryzacja każdego konta.

Token unieważniają też: zmiana hasła (tokeny z Gmailem), cofnięcie dostępu, 6 miesięcy bez użycia.
Błąd konektora podaje wtedy gotową komendę `--action=auth … --account=<email>`.

## Użycie w kodzie

```js
import { getAccessToken, getCredentials } from '../../google-auth/scripts/tokens.js';
const { accessToken, email } = await getAccessToken('ga4', account);      // REST + fetch
const { clientId, clientSecret, refreshToken } = getCredentials('ads');   // biblioteki
```

CommonJS (Node 22+): `require('<ścieżka>/tokens.js')`. Błędy mają `code`: `NO_ACCOUNT`,
`NO_SCOPE`, `AMBIGUOUS`, `INVALID_GRANT`, `CLIENT_MISMATCH`, `CONFIG`.
