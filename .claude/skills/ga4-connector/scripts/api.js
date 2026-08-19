/**
 * Google Analytics 4 client — self-contained, zero npm dependencies.
 *
 * Talks straight to the public REST endpoints with the global fetch (Node 18+):
 *   Data API  v1beta  https://analyticsdata.googleapis.com
 *   Admin API v1beta  https://analyticsadmin.googleapis.com
 *
 * Read-only by design: the OAuth scope is analytics.readonly, so nothing here can
 * change a client's property. Writing GA4 configuration (key events, attribution,
 * custom dimensions) would need analytics.edit and belongs in a separate skill.
 *
 * Docs: https://developers.google.com/analytics/devguides/reporting/data/v1
 *       https://developers.google.com/analytics/devguides/config/admin/v1
 */

import {
  oauthClient,
  refreshToken,
  readToken,
  writeToken,
  resolveTarget,
  tokenPath,
  SCOPES,
  REDIRECT_URI,
} from './config.js';

const DATA = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
// attributionSettings never graduated to v1beta — v1beta answers it with a 404
// HTML page, not a JSON error. Verified against a live property 2026-08-18.
const ADMIN_ALPHA = 'https://analyticsadmin.googleapis.com/v1alpha';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Data API caps a single response at 250k rows; stay a little under it.
const PAGE_SIZE = 100000;

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
        : 'Brak refresh tokena GA4 — konektor nie był jeszcze autoryzowany.\n' +
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
        'invalid_grant — refresh token GA4 został unieważniony (zmiana hasła, 6 miesięcy bez użycia,\n' +
          'cofnięta zgoda albo aplikacja w trybie testowym: token żyje wtedy 7 dni).\n' +
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
function explain(status, body, url, profile) {
  const err = body?.error || {};
  const details = err.details || [];
  const reason = details.find((d) => d.reason)?.reason;
  const activation = details.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;
  const api = url.includes('analyticsadmin') ? 'Google Analytics Admin API' : 'Google Analytics Data API';

  if (reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(err.message || '')) {
    return (
      `${api} jest wyłączone w projekcie Google Cloud, z którego pochodzą credentiale OAuth.\n\n` +
      `Włącz je tutaj:\n  ${activation || `https://console.cloud.google.com/apis/library/${url.includes('analyticsadmin') ? 'analyticsadmin' : 'analyticsdata'}.googleapis.com`}\n\n` +
      'Kliknij „Włącz”, odczekaj ~1 minutę i powtórz polecenie. To ten sam projekt, w którym\n' +
      'masz Google Ads API — nie zakładaj nowego.'
    );
  }
  if (status === 403) {
    return (
      `Brak dostępu (403). ${err.message || ''}\n` +
      `Najczęściej: login ${profile ? `profilu „${profile}”` : '(profil domyślny)'} nie ma uprawnień do tej usługi.\n` +
      `Sprawdź, co ten login widzi: --action=properties${profile ? ` --profile=${profile}` : ''}\n` +
      'Jeśli usługa należy do innego konta Google, wskaż jego profil (`--action=profiles` pokaże dostępne).'
    );
  }
  if (status === 401) {
    return 'Token odrzucony (401). Autoryzuj ponownie: node scripts/auth.js --step=url';
  }
  if (status === 400 && /Did you mean|not a valid|Field/i.test(err.message || '')) {
    return (
      `Zapytanie odrzucone (400): ${err.message}\n` +
      'Nazwy wymiarów i metryk są case-sensitive. `--action=metadata --property=ID` wypisze\n' +
      'wszystkie dostępne w tej usłudze, razem z niestandardowymi.'
    );
  }
  if (status === 429) {
    return (
      `Przekroczony limit GA4 (429): ${err.message || ''}\n` +
      'Data API rozlicza „tokeny” per usługa (dobowe, godzinowe i na równoległe zapytania).\n' +
      'Zmniejsz liczbę wymiarów albo zakres dat i spróbuj później.'
    );
  }
  return `${api} zwróciło ${status}: ${err.message || JSON.stringify(body)}`;
}

async function call(url, { method = 'GET', body, profile } = {}) {
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
  if (!res.ok) throw new Error(explain(res.status, json, url, profile));
  return json;
}

// ---------------------------------------------------------------------------
// Filters — a small language so the CLI stays readable
//   sessionSource=~google     contains
//   sessionSource==google     exact
//   sessionSource!~spam       NOT contains
//   sessionSource!=google     NOT exact
//   sessionSource=@a|b|c      in list
//   sessionSource=^blog       begins with
//   sessionSource=$.html      ends with
//   sessions>100              numeric (metric filters)
// Multiple clauses joined with ";" are AND-ed.
// ---------------------------------------------------------------------------
const STRING_OPS = [
  ['!~', 'CONTAINS', true],
  ['!=', 'EXACT', true],
  ['=~', 'CONTAINS', false],
  ['==', 'EXACT', false],
  ['=@', 'IN_LIST', false],
  ['=^', 'BEGINS_WITH', false],
  ['=$', 'ENDS_WITH', false],
];
const NUMERIC_OPS = [
  ['>=', 'GREATER_THAN_OR_EQUAL'],
  ['<=', 'LESS_THAN_OR_EQUAL'],
  ['>', 'GREATER_THAN'],
  ['<', 'LESS_THAN'],
];

function parseClause(clause) {
  for (const [op, matchType, negate] of STRING_OPS) {
    const i = clause.indexOf(op);
    if (i > 0) {
      const field = clause.slice(0, i).trim();
      const value = clause.slice(i + op.length).trim();
      const filter =
        matchType === 'IN_LIST'
          ? { fieldName: field, inListFilter: { values: value.split('|').map((v) => v.trim()), caseSensitive: false } }
          : { fieldName: field, stringFilter: { matchType, value, caseSensitive: false } };
      return negate ? { notExpression: { filter } } : { filter };
    }
  }
  for (const [op, operation] of NUMERIC_OPS) {
    const i = clause.indexOf(op);
    if (i > 0) {
      const field = clause.slice(0, i).trim();
      const value = Number(clause.slice(i + op.length).trim());
      if (Number.isNaN(value)) break;
      const isInt = Number.isInteger(value);
      return {
        filter: {
          fieldName: field,
          numericFilter: { operation, value: isInt ? { int64Value: String(value) } : { doubleValue: value } },
        },
      };
    }
  }
  throw new Error(
    `Nie rozumiem warunku „${clause}”. Dozwolone: ==  !=  =~  !~  =@  =^  =$  >  >=  <  <=`
  );
}

export function parseFilter(expr) {
  if (!expr) return undefined;
  const parts = String(expr)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;
  const expressions = parts.map(parseClause);
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
/**
 * `--days=30` means the last 30 COMPLETE days: 30daysAgo..yesterday.
 * Today is excluded on purpose — partial days quietly skew every comparison.
 */
export function dateRange({ days, from, to, includeToday = false } = {}) {
  if (from || to) {
    return { startDate: from || '30daysAgo', endDate: to || (includeToday ? 'today' : 'yesterday') };
  }
  const n = Number(days || 30);
  return {
    startDate: includeToday ? `${n - 1}daysAgo` : `${n}daysAgo`,
    endDate: includeToday ? 'today' : 'yesterday',
  };
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------
function toRows(resp) {
  const dims = (resp.dimensionHeaders || []).map((h) => h.name);
  const mets = (resp.metricHeaders || []).map((h) => h.name);
  return (resp.rows || []).map((row) => {
    const out = {};
    dims.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? '';
    });
    mets.forEach((name, i) => {
      const raw = row.metricValues?.[i]?.value;
      const num = Number(raw);
      out[name] = raw === undefined || raw === '' ? 0 : Number.isNaN(num) ? raw : num;
    });
    return out;
  });
}

function orderBys(order, metrics, dimensions) {
  if (!order) return undefined;
  return String(order)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const desc = token.startsWith('-');
      const name = desc ? token.slice(1) : token;
      return metrics.includes(name)
        ? { metric: { metricName: name }, desc }
        : dimensions.includes(name)
          ? { dimension: { dimensionName: name }, desc }
          : (() => {
              throw new Error(
                `--order=${token}: „${name}” nie występuje ani w --metrics, ani w --dimensions.`
              );
            })();
    });
}

// ---------------------------------------------------------------------------
// Data API
// ---------------------------------------------------------------------------
/**
 * runReport with automatic paging. Set `limit` to cap the result; leave it out
 * to pull everything the property will return.
 */
export async function report({
  property,
  profile,
  dimensions = [],
  metrics = ['sessions'],
  days,
  from,
  to,
  includeToday,
  filter,
  metricFilter,
  order,
  limit,
  keepEmptyRows = false,
} = {}) {
  const { propertyId: id, profile: prof } = resolveTarget(property, profile);
  const dims = [].concat(dimensions).filter(Boolean);
  const mets = [].concat(metrics).filter(Boolean);
  const range = dateRange({ days, from, to, includeToday });

  const rows = [];
  let offset = 0;
  let meta = {};

  for (;;) {
    const want = limit ? Math.min(PAGE_SIZE, limit - rows.length) : PAGE_SIZE;
    const resp = await call(`${DATA}/properties/${id}:runReport`, {
      method: 'POST',
      profile: prof,
      body: {
        dateRanges: [range],
        dimensions: dims.map((name) => ({ name })),
        metrics: mets.map((name) => ({ name })),
        dimensionFilter: parseFilter(filter),
        metricFilter: parseFilter(metricFilter),
        orderBys: orderBys(order, mets, dims),
        limit: String(want),
        offset: String(offset),
        keepEmptyRows,
        returnPropertyQuota: true,
      },
    });

    const page = toRows(resp);
    rows.push(...page);
    meta = {
      rowCount: resp.rowCount ?? rows.length,
      // GA4 hides rows behind thresholds when Google Signals / demographics are on.
      thresholded: Boolean(resp.metadata?.subjectToThresholding),
      currency: resp.metadata?.currencyCode,
      timeZone: resp.metadata?.timeZone,
      quota: resp.propertyQuota,
    };

    offset += page.length;
    const done =
      page.length === 0 ||
      page.length < want ||
      offset >= (resp.rowCount ?? offset) ||
      (limit && rows.length >= limit);
    if (done) break;
  }

  return { property: id, dateRange: range, dimensions: dims, metrics: mets, rows, ...meta };
}

/** Realtime — last 30 minutes. Useful to answer "czy tag w ogóle zbiera dane". */
export async function realtime({ property, profile, dimensions = ['unifiedScreenName'], metrics = ['activeUsers'], limit = 50 } = {}) {
  const { propertyId: id, profile: prof } = resolveTarget(property, profile);
  const resp = await call(`${DATA}/properties/${id}:runRealtimeReport`, {
    method: 'POST',
    profile: prof,
    body: {
      dimensions: [].concat(dimensions).filter(Boolean).map((name) => ({ name })),
      metrics: [].concat(metrics).filter(Boolean).map((name) => ({ name })),
      limit: String(limit),
    },
  });
  return { property: id, rows: toRows(resp), rowCount: resp.rowCount ?? 0 };
}

/** Every dimension and metric this property accepts, including custom ones. */
export async function metadata({ property, profile } = {}) {
  const { propertyId: id, profile: prof } = resolveTarget(property, profile);
  const resp = await call(`${DATA}/properties/${id}/metadata`, { profile: prof });
  const shape = (list = []) =>
    list.map((x) => ({
      apiName: x.apiName,
      uiName: x.uiName,
      category: x.category,
      custom: Boolean(x.customDefinition),
      description: x.description,
    }));
  return { property: id, dimensions: shape(resp.dimensions), metrics: shape(resp.metrics) };
}

/**
 * Monthly cohort report — the shape ltv-cohort.js needs.
 * Cohorts are built on firstSessionDate; nth month 0 is the acquisition month.
 */
export async function cohort({
  property,
  profile,
  cohorts = 12,
  extraDimension,
  metrics = ['cohortActiveUsers', 'cohortTotalUsers', 'purchaseRevenue', 'transactions'],
} = {}) {
  const { propertyId: id, profile: prof } = resolveTarget(property, profile);
  const n = Number(cohorts);

  // Month starts, oldest first, ending with the last COMPLETE month.
  const today = new Date();
  const spec = [];
  for (let i = n; i >= 1; i--) {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i + 1, 0));
    const iso = (d) => d.toISOString().slice(0, 10);
    spec.push({
      name: iso(start).slice(0, 7),
      dimension: 'firstSessionDate',
      dateRange: { startDate: iso(start), endDate: iso(end) },
    });
  }

  const dims = [{ name: 'cohort' }, { name: 'cohortNthMonth' }];
  if (extraDimension) dims.push({ name: extraDimension });

  const resp = await call(`${DATA}/properties/${id}:runReport`, {
    method: 'POST',
    profile: prof,
    body: {
      dimensions: dims,
      metrics: [].concat(metrics).filter(Boolean).map((name) => ({ name })),
      cohortSpec: {
        cohorts: spec,
        cohortsRange: { granularity: 'MONTHLY', startOffset: 0, endOffset: n - 1 },
      },
      returnPropertyQuota: true,
    },
  });

  return {
    property: id,
    cohorts: spec.map((c) => ({ name: c.name, ...c.dateRange })),
    rows: toRows(resp),
    quota: resp.propertyQuota,
  };
}

// ---------------------------------------------------------------------------
// Admin API — read only
// ---------------------------------------------------------------------------
/** Every account + property the authorized user can see. Solves "jakie ID ma klient". */
export async function properties(profile) {
  const out = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
    const resp = await call(`${ADMIN}/accountSummaries?${q}`, { profile });
    for (const acc of resp.accountSummaries || []) {
      for (const p of acc.propertySummaries || []) {
        out.push({
          account: acc.displayName,
          accountId: (acc.account || '').replace('accounts/', ''),
          property: p.displayName,
          propertyId: (p.property || '').replace('properties/', ''),
          propertyType: p.propertyType,
        });
      }
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

export async function streams({ property, profile } = {}) {
  const { propertyId: id, profile: prof } = resolveTarget(property, profile);
  const resp = await call(`${ADMIN}/properties/${id}/dataStreams?pageSize=200`, { profile: prof });
  return (resp.dataStreams || []).map((s) => ({
    name: s.displayName,
    type: s.type,
    measurementId: s.webStreamData?.measurementId,
    defaultUri: s.webStreamData?.defaultUri,
    packageName: s.androidAppStreamData?.packageName || s.iosAppStreamData?.bundleId,
    created: s.createTime,
  }));
}

export async function keyEvents({ property, profile } = {}) {
  const { propertyId: id, profile: prof } = resolveTarget(property, profile);
  const resp = await call(`${ADMIN}/properties/${id}/keyEvents?pageSize=200`, { profile: prof });
  return (resp.keyEvents || []).map((e) => ({
    event: e.eventName,
    countingMethod: e.countingMethod,
    custom: e.custom,
    deletable: e.deletable,
    created: e.createTime,
  }));
}

export async function customDimensions({ property, profile } = {}) {
  const { propertyId: id, profile: prof } = resolveTarget(property, profile);
  const resp = await call(`${ADMIN}/properties/${id}/customDimensions?pageSize=200`, { profile: prof });
  return (resp.customDimensions || []).map((d) => ({
    apiName: `customEvent:${d.parameterName}`,
    display: d.displayName,
    parameter: d.parameterName,
    scope: d.scope,
    description: d.description,
  }));
}

/** Attribution model + lookback windows — read this before comparing GA4 with Ads. */
export async function attribution({ property, profile } = {}) {
  const { propertyId: id, profile: prof } = resolveTarget(property, profile);
  const s = await call(`${ADMIN_ALPHA}/properties/${id}/attributionSettings`, { profile: prof });
  // Enums repeat the field name in full; keep only the part that carries meaning.
  const days = (v) => (v ? (v.match(/_(\d+)_DAYS$/)?.[1] ?? v) + (v.match(/_(\d+)_DAYS$/) ? ' dni' : '') : undefined);
  return {
    reportingModel: s.reportingAttributionModel,
    acquisitionLookback: days(s.acquisitionConversionEventLookbackWindow),
    otherLookback: days(s.otherConversionEventLookbackWindow),
    adsChannelType: s.adsWebConversionDataExportScope,
  };
}

/** Is this property actually linked to a Google Ads account? */
export async function adsLinks({ property, profile } = {}) {
  const { propertyId: id, profile: prof } = resolveTarget(property, profile);
  const resp = await call(`${ADMIN}/properties/${id}/googleAdsLinks?pageSize=200`, { profile: prof });
  return (resp.googleAdsLinks || []).map((l) => ({
    customerId: l.customerId,
    canManageClients: l.canManageClients,
    adsPersonalization: l.adsPersonalizationEnabled,
    creator: l.creatorEmailAddress,
    created: l.createTime,
  }));
}

export async function testConnection(profile) {
  const list = await properties(profile);
  return { ok: true, propertiesVisible: list.length, sample: list.slice(0, 5) };
}
