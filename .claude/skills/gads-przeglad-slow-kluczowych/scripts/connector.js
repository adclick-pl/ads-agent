/**
 * connector.js — jedyne miejsce, w którym ten skill wie, GDZIE leży konektor Google Ads.
 *
 * Warstwa danych (logowanie do API, GAQL) należy do skilla `gads-connector`, który leży
 * w tym samym pakiecie, obok tego skilla. Ten plik tylko ją re-eksportuje.
 *
 * Zależności npm (google-ads-api, js-yaml, dotenv) rozwiązują się względem konektora,
 * czyli z `node_modules` w korzeniu pakietu — ten skill nie importuje ich sam.
 */

export {
    runRawQuery,
    getAccountTimezone,
    formatInTimeZone,
} from '../../gads-connector/scripts/queries.js';

export {
    resolveAccount,
    accountSlug,
} from '../../gads-connector/scripts/accounts.js';
