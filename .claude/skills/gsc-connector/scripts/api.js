/**
 * Google Search Console client — self-contained, zero npm dependencies.
 *
 * Talks straight to the public REST endpoints with the global fetch (Node 18+):
 *   Search Console  v3  https://www.googleapis.com/webmasters/v3
 *   URL Inspection  v1  https://searchconsole.googleapis.com/v1
 *
 * Read-only by design: the OAuth scope is webmasters.readonly, so nothing here
 * can submit a sitemap, request indexing or change a client's property.
 *
 * Docs: https://developers.google.com/webmaster-tools/v1/api_reference_index
 *       https://developers.google.com/webmaster-tools/v1/urlInspection.index
 */

import {
  oauthClient,
  refreshToken,
  readToken,
  writeToken,
  resolveTarget,
  tokenPath,
  siteHost,
  SCOPES,
  REDIRECT_URI,
} from './config.js';

const WM = 'https://www.googleapis.com/webmasters/v3';
const INSPECT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Search Analytics caps a single response at 25 000 rows.
const PAGE_SIZE = 25000;

const enc = (s) => encodeURIComponent(s);

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------
export function authUrl() {
  const { clientId } = oauthClient();
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'select_account consent', // force a refresh_token even on re-consent
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(code, profile) {
  const { clientId, clientSecret } = oauthClient();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Wymiana kodu na token nie udała się: ${JSON.stringify(data)}`);
  if (!data.refresh_token) {
    throw new Error(
      'Google nie zwróciło refresh_token. Zwykle znaczy to, że zgoda była już wcześniej wydana —\n' +
        'usuń dostęp na https://myaccount.google.com/permissions i powtórz autoryzację.'
    );
  }
  const stored = { ...readToken(profile), ...data, expiry: Date.now() + (data.expires_in || 3600) * 1000 };
  return { token: stored, path: writeToken(stored, profile) };
}

// Access tokens live per profile, for this process only.
const memoTokens = new Map();

export async function accessToken(profile) {
  const key = profile || '';
  const now = Date.now();
  const memo = memoTokens.get(key);
  if (memo && memo.expiry > now + 60_000) return memo.access_token;

  const onDisk = readToken(profile);
  if (onDisk?.access_token && onDisk.expiry > now + 60_000) {
    memoTokens.set(key, { access_token: onDisk.access_token, expiry: onDisk.expiry });
    return onDisk.access_token;
  }

  const rt = refreshToken(profile);
  if (!rt) {
    throw new Error(
      profile
        ? `Profil „${profile}” nie jest autoryzowany (brak ${tokenPath(profile)}).\n` +
          `Uruchom: node scripts/auth.js --step=url --profile=${profile}, otwórz link, potem --step=listen --profile=${profile}.\n` +
          'Listę autoryzowanych loginów pokaże `--action=profiles`.'
        : 'Brak refresh tokena Search Console — konektor nie był jeszcze autoryzowany.\n' +
          'Uruchom: node scripts/auth.js --step=url, otwórz link, potem --step=listen.'
    );
  }

  const { clientId, clientSecret } = oauthClient();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: rt,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === 'invalid_grant') {
      throw new Error(
        'invalid_grant — refresh token Search Console został unieważniony (zmiana hasła, 6 miesięcy\n' +
          'bez użycia, cofnięta zgoda albo aplikacja w trybie testowym: token żyje wtedy 7 dni).\n' +
          `Autoryzuj ponownie: node scripts/auth.js --step=url${profile ? ` --profile=${profile}` : ''}`
      );
    }
    throw new Error(`Odświeżenie tokena nie udało się: ${JSON.stringify(data)}`);
  }

  const expiry = Date.now() + (data.expires_in || 3600) * 1000;
  memoTokens.set(key, { access_token: data.access_token, expiry });
  // Persist only when the refresh token itself lives on disk.
  const stored = readToken(profile);
  if (stored) writeToken({ ...stored, access_token: data.access_token, expiry }, profile);
  return data.access_token;
}

// ---------------------------------------------------------------------------
// HTTP + error translation
// ---------------------------------------------------------------------------
function explain(status, body, url, { profile, site } = {}) {
  const err = body?.error || {};
  const reason = (err.details || []).find((d) => d.reason)?.reason;
  const activation = (err.details || []).find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;

  if (reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(err.message || '')) {
    return (
      'Google Search Console API jest wyłączone w projekcie Google Cloud, z którego pochodzą\n' +
      'credentiale OAuth.\n\n' +
      `Włącz je tutaj:\n  ${activation || 'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com'}\n\n` +
      'Kliknij „Włącz”, odczekaj ~1 minutę i powtórz polecenie. To ten sam projekt, w którym\n' +
      'masz Google Ads API — nie zakładaj nowego.'
    );
  }
  if (status === 403) {
    const czyInspekcja = url.startsWith(INSPECT);
    return (
      `Brak dostępu (403)${site ? ` do property ${site}` : ''}. ${err.message || ''}\n` +
      `Login ${profile ? `profilu „${profile}”` : '(profil domyślny)'} albo nie ma dostępu do tej property,\n` +
      'albo property jest zapisana w innej formie (domenowa „sc-domain:” vs prefiks URL —\n' +
      'to dwa różne obiekty i o brakujący GSC odpowiada 403, nie „nie ma takiej property”).' +
      (czyInspekcja
        ? '\nURL Inspection wymaga do tego uprawnienia „pełne” albo „właściciel” — rola\n' +
          '„ograniczona” dostaje 403 nawet przy poprawnej property.'
        : '') +
      `\nSprawdź, co ten login widzi: --action=sites${profile ? ` --profile=${profile}` : ''}`
    );
  }
  if (status === 401) {
    return 'Token odrzucony (401). Autoryzuj ponownie: node scripts/auth.js --step=url';
  }
  if (status === 404) {
    return (
      `Nie znaleziono (404)${site ? `: ${site}` : ''}. ${err.message || ''}\n` +
      'Przy Search Console 404 zwykle znaczy, że property w tej formie nie istnieje.\n' +
      'Property z prefiksem URL musi się zgadzać CO DO ZNAKU, ze slashem na końcu\n' +
      '(„https://example.com/”). Lista tego, co masz: --action=sites'
    );
  }
  if (status === 429) {
    return (
      `Przekroczony limit Search Console (429): ${err.message || ''}\n` +
      'Limity są per property i per projekt GCP. URL Inspection: 2000 URL-i na dobę\n' +
      'i 600 na minutę — przy --action=inspect-batch zmniejsz --concurrency albo rozbij\n' +
      'listę na kilka dni.'
    );
  }
  return `Search Console API zwróciło ${status}: ${err.message || JSON.stringify(body)}`;
}

async function call(url, { method = 'GET', body, profile, site } = {}) {
  let token = await accessToken(profile);

  const send = () =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  let res = await send();
  if (res.status === 401) {
    memoTokens.delete(profile || ''); // stale access token — refresh once and retry
    token = await accessToken(profile);
    res = await send();
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Niepoprawna odpowiedź (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const e = new Error(explain(res.status, json, url, { profile, site }));
    // The CLI turns these into a "did you mean this property" hint, which needs
    // a second call — so the context travels with the error instead.
    e.status = res.status;
    e.site = site;
    e.profile = profile;
    throw e;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Filters — the same little language the GA4 connector uses, restricted to the
// operators Search Console actually has.
//   page=~/blog/        contains
//   page!~/tag/         NOT contains
//   query==buty         exact
//   query!=buty         NOT exact
//   query=/^kup /       matches regex
//   query!/^kup /       does NOT match regex
// Multiple clauses joined with ";" are AND-ed.
// ---------------------------------------------------------------------------
const OPS = [
  ['!~', 'notContains'],
  ['!/', 'excludingRegex'],
  ['!=', 'notEquals'],
  ['=~', 'contains'],
  ['=/', 'includingRegex'],
  ['==', 'equals'],
];

export const FILTERABLE = ['query', 'page', 'country', 'device', 'searchAppearance'];
export const DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'searchAppearance'];
export const TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'];
export const DATA_STATES = ['final', 'all'];

/**
 * Reject anything Search Console would quietly ignore.
 *
 * `--data-state=fresh` is the case that matters: Google does not reject it, it
 * just serves FINAL data — so the user believes they are looking at today's
 * numbers and they are not. A rejected command is recoverable; a silently
 * narrowed one is not.
 */
export function assertQueryShape({ dimensions, type, dataState } = {}) {
  for (const d of [].concat(dimensions || []).filter(Boolean)) {
    if (!DIMENSIONS.includes(d)) {
      throw new Error(
        `Nieznany wymiar „${d}”. Search Console ma tylko: ${DIMENSIONS.join(', ')}.`
      );
    }
  }
  if (type !== undefined && !TYPES.includes(type)) {
    throw new Error(`Nieznany --type=${type}. Dozwolone: ${TYPES.join(', ')}.`);
  }
  if (dataState !== undefined && !DATA_STATES.includes(dataState)) {
    throw new Error(
      `Nieznany --data-state=${dataState}. Dozwolone: ${DATA_STATES.join(', ')}.\n` +
        'Uwaga: Google nie odrzuca błędnej wartości — po cichu podaje dane ostateczne,\n' +
        'więc wynik wyglądałby poprawnie, a nie zawierałby świeżych dni.'
    );
  }
}

function parseClause(clause) {
  for (const [op, operator] of OPS) {
    const i = clause.indexOf(op);
    if (i > 0) {
      const dimension = clause.slice(0, i).trim();
      const expression = clause.slice(i + op.length).trim();
      if (!FILTERABLE.includes(dimension)) {
        throw new Error(
          `Nie da się filtrować po „${dimension}”. Search Console pozwala tylko na: ${FILTERABLE.join(', ')}.` +
            (dimension === 'date' ? '\nZakres dat ustawia się przez --days albo --from/--to.' : '')
        );
      }
      if (!expression) throw new Error(`Pusta wartość w warunku „${clause}”.`);
      return { dimension, operator, expression };
    }
  }
  throw new Error(`Nie rozumiem warunku „${clause}”. Dozwolone: ==  !=  =~  !~  =/  !/`);
}

/** @returns {Array<{dimension,operator,expression}>|undefined} */
export function parseFilter(expr) {
  if (!expr) return undefined;
  const parts = String(expr)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;
  return parts.map(parseClause);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * `--days=90` means the last 90 days ending YESTERDAY.
 *
 * Search Console is not GA4: final data lags 2–3 days, so the last days of any
 * range usually come back empty even though tracking is fine. The CLI says this
 * out loud when a query returns nothing — silence here is what makes people
 * think the site stopped ranking.
 */
export function dateRange({ days, from, to, now = Date.now() } = {}) {
  const back = (n) => isoDay(now - n * 86400000);
  if (from || to) return { startDate: from || back(Number(days || 90)), endDate: to || back(1) };
  return { startDate: back(Number(days || 90)), endDate: back(1) };
}

// ---------------------------------------------------------------------------
// Search Console API
// ---------------------------------------------------------------------------
/** Every property the authorized login can see. Solves "co ja właściwie mam". */
export async function sites(profile) {
  const d = await call(`${WM}/sites`, { profile });
  return (d.siteEntry || []).map((s) => ({
    site: s.siteUrl,
    typ: s.siteUrl.startsWith('sc-domain:') ? 'domenowa' : 'prefiks URL',
    uprawnienie: s.permissionLevel,
  }));
}

export async function sitemaps({ site, profile } = {}) {
  const { site: id, profile: prof, assumed } = resolveTarget(site, profile);
  const d = await call(`${WM}/sites/${enc(id)}/sitemaps`, { profile: prof, site: id });
  return {
    site: id,
    assumed,
    rows: (d.sitemap || []).map((s) => ({
      sitemap: s.path,
      typ: (s.contents || []).map((c) => `${c.type}:${c.submitted}`).join(' ') || '-',
      zgloszona: (s.lastSubmitted || '').slice(0, 10),
      pobrana: (s.lastDownloaded || '').slice(0, 10),
      bledy: Number(s.errors ?? 0),
      ostrzezenia: Number(s.warnings ?? 0),
      oczekuje: s.isPending ? 'tak' : '',
      indeks: s.isSitemapsIndex ? 'tak' : '',
    })),
  };
}

/**
 * One Search Analytics page. Callers normally want `searchAnalytics` below,
 * which pages through everything.
 */
async function searchAnalyticsPage(id, prof, body) {
  const d = await call(`${WM}/sites/${enc(id)}/searchAnalytics/query`, {
    method: 'POST',
    profile: prof,
    site: id,
    body,
  });
  return d.rows || [];
}

/**
 * Search Analytics with automatic paging.
 *
 * @param {object} opts
 *   site, profile, days | from/to, dimensions[], filter (string), limit,
 *   type (web|image|video|news|discover|googleNews), dataState (final|all)
 */
export async function searchAnalytics({
  site,
  profile,
  days,
  from,
  to,
  dimensions = ['page'],
  filter,
  limit,
  type,
  dataState,
  now,
} = {}) {
  const { site: id, profile: prof, assumed } = resolveTarget(site, profile);
  const dims = [].concat(dimensions).filter(Boolean);
  assertQueryShape({ dimensions: dims, type, dataState });
  const range = dateRange({ days, from, to, now });
  const filters = parseFilter(filter);

  const rows = [];
  let startRow = 0;

  for (;;) {
    const want = limit ? Math.min(PAGE_SIZE, limit - rows.length) : PAGE_SIZE;
    if (want <= 0) break;

    const page = await searchAnalyticsPage(id, prof, {
      ...range,
      dimensions: dims,
      rowLimit: want,
      startRow,
      ...(type ? { type } : {}),
      ...(dataState ? { dataState } : {}),
      ...(filters ? { dimensionFilterGroups: [{ groupType: 'and', filters }] } : {}),
    });

    rows.push(...page);
    startRow += page.length;
    if (page.length < want) break;
    if (limit && rows.length >= limit) break;
  }

  // Flatten keys into named columns so the output is a plain table.
  const flat = rows.map((r) => {
    const o = {};
    dims.forEach((d, i) => {
      o[d] = r.keys?.[i] ?? '';
    });
    o.klikniecia = r.clicks ?? 0;
    o.wyswietlenia = r.impressions ?? 0;
    o.ctr = Number((((r.ctr ?? 0) * 100).toFixed(2)));
    o.pozycja = Number((r.position ?? 0).toFixed(1));
    return o;
  });

  return {
    site: id,
    dateRange: range,
    dimensions: dims,
    dataState: dataState || 'final',
    rows: flat,
    rowCount: flat.length,
    assumed,
  };
}

/** URL Inspection for a single address. */
export async function inspect({ site, url, profile, languageCode = 'pl' } = {}) {
  const { site: id, profile: prof, assumed } = resolveTarget(site, profile);
  if (!url) throw new Error('Brak adresu do sprawdzenia (--url=...).');
  const res = await call(INSPECT, {
    method: 'POST',
    profile: prof,
    site: id,
    body: { inspectionUrl: url, siteUrl: id, languageCode },
  });
  return { site: id, assumed, ...res };
}

/** The fields that answer "czy ten URL jest w indeksie i dlaczego nie". */
export function summarizeInspection(res, url) {
  const i = res?.inspectionResult?.indexStatusResult || {};
  return {
    url,
    verdict: i.verdict || null,
    coverageState: i.coverageState || null,
    robotsTxtState: i.robotsTxtState || null,
    indexingState: i.indexingState || null,
    pageFetchState: i.pageFetchState || null,
    crawledAs: i.crawledAs || null,
    lastCrawlTime: i.lastCrawlTime || null,
    googleCanonical: i.googleCanonical || null,
    userCanonical: i.userCanonical || null,
    canonicalMismatch:
      !!(i.googleCanonical && i.userCanonical && i.googleCanonical !== i.userCanonical),
    referringUrls: i.referringUrls || [],
    sitemaps: i.sitemap || [],
  };
}

/**
 * URL Inspection for a list of addresses, with bounded concurrency.
 *
 * Google's aggregate index-coverage report has no API. A representative sample
 * inspected one URL at a time gives the same verdicts, which is why this exists.
 * Quota: 2000 URLs/day, 600/min per property.
 */
export async function inspectBatch({ site, urls, profile, concurrency = 5, onProgress } = {}) {
  const { site: id, profile: prof, assumed } = resolveTarget(site, profile);
  const lista = [].concat(urls).filter(Boolean);
  const out = new Array(lista.length);
  let next = 0;
  let done = 0;
  let failed = 0;

  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= lista.length) return;
      const u = lista[idx];
      try {
        const res = await call(INSPECT, {
          method: 'POST',
          profile: prof,
          site: id,
          body: { inspectionUrl: u, siteUrl: id, languageCode: 'pl' },
        });
        out[idx] = summarizeInspection(res, u);
      } catch (e) {
        failed++;
        // One dead URL must not sink the batch — record it as a row and move on.
        out[idx] = { url: u, verdict: 'BŁĄD', coverageState: e.message.split('\n')[0].slice(0, 90) };
      }
      done++;
      onProgress?.(done, lista.length);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, lista.length)) }, worker));
  return { site: id, assumed, rows: out, failed };
}

/**
 * Everything the connector can answer about indexing in one call: sitemaps,
 * how much traffic the property gets, and the verdict for the home page.
 */
export async function diagnose({ site, profile, days = 28 } = {}) {
  const { site: id, profile: prof } = resolveTarget(site, profile);
  const home = /^sc-domain:/i.test(id) ? `https://${siteHost(id)}/` : id;

  const [mapy, ruch, glowna] = await Promise.all([
    sitemaps({ site: id, profile: prof }).catch((e) => ({ rows: [], blad: e.message.split('\n')[0] })),
    searchAnalytics({ site: id, profile: prof, days, dimensions: ['date'] }),
    inspect({ site: id, url: home, profile: prof })
      .then((r) => summarizeInspection(r, home))
      .catch((e) => ({ url: home, verdict: 'BŁĄD', coverageState: e.message.split('\n')[0] })),
  ]);

  const klikniecia = ruch.rows.reduce((s, r) => s + r.klikniecia, 0);
  const wyswietlenia = ruch.rows.reduce((s, r) => s + r.wyswietlenia, 0);
  const ostatniDzien = ruch.rows.map((r) => r.date).sort().pop() || null;

  return {
    site: id,
    okres: `${ruch.dateRange.startDate} → ${ruch.dateRange.endDate}`,
    sitemapy: mapy.rows,
    klikniecia,
    wyswietlenia,
    ostatniDzienZDanymi: ostatniDzien,
    stronaGlowna: glowna,
    uwagi: [
      mapy.blad && `Nie udało się odczytać sitemap: ${mapy.blad}`,
      !mapy.blad && mapy.rows.length === 0 && 'Brak zgłoszonych sitemap — Google znajdzie strony wolniej.',
      mapy.rows.some((s) => s.bledy > 0) && 'Część sitemap ma błędy — sprawdź --action=sitemaps.',
      wyswietlenia === 0 && 'Zero wyświetleń w oknie — sprawdź, czy to na pewno właściwa property.',
      glowna.verdict && glowna.verdict !== 'PASS' && `Strona główna NIE jest w indeksie: ${glowna.coverageState || glowna.verdict}.`,
      glowna.canonicalMismatch && 'Google wybrał dla strony głównej inny URL kanoniczny niż zadeklarowany.',
    ].filter(Boolean),
  };
}

export async function testConnection(profile) {
  const list = await sites(profile);
  return { ok: true, propertiesVisible: list.length, sample: list.slice(0, 5) };
}
