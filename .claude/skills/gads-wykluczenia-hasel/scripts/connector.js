/**
 * connector.js — jedyne miejsce, w którym ten skill wie, GDZIE leży konektor Google Ads.
 *
 * Warstwa danych (logowanie do API, GAQL, hasła wyszukiwania) należy do skilla
 * `gads-connector`, który leży w tym samym pakiecie, obok tego skilla. Ten plik tylko
 * ją re-eksportuje — dzięki temu ścieżka do konektora jest w JEDNYM miejscu, a reszta
 * kodu skilla nie zna żadnej ścieżki poza tym plikiem.
 *
 * Zależności npm (google-ads-api, js-yaml, dotenv) rozwiązują się względem konektora,
 * czyli z `node_modules` w korzeniu pakietu — ten skill nie importuje ich sam i nie
 * potrzebuje własnego `node_modules`.
 */

export {
    runRawQuery,
    getSearchTerms,
} from '../../gads-connector/scripts/queries.js';

export {
    resolveAccount,
} from '../../gads-connector/scripts/accounts.js';
