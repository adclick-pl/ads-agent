/**
 * SafetyLimits — pure guardrails that run before a mutation hits the account.
 *
 * The connector already forces a `--dry-run` preview, but a preview only *shows*
 * the change; it doesn't *stop* a dangerous one. These checks block the kinds of
 * mistakes that are expensive and hard to undo (a runaway budget jump), unless
 * the operator explicitly overrides with `--force`.
 *
 * Everything here is pure (no API calls) so it stays trivially testable offline.
 */

/** Max allowed daily-budget change, in percent, before a mutation is blocked. */
export const DEFAULT_MAX_BUDGET_CHANGE_PCT = 40;

/**
 * No-delete policy. The connector deliberately NEVER removes Google Ads resources
 * (campaigns, ad groups, keywords, etc.) — removal is permanent and irreversible.
 * Anything that can be paused should be paused, not deleted. There is no `--force`
 * override for this: deletion must be done by hand in the Google Ads UI.
 */
export const NO_DELETE_POLICY =
  'Connector nie usuwa zasobów Google Ads (kampanii, grup reklam, słów kluczowych itd.). ' +
  'Usuwanie jest nieodwracalne i celowo poza zakresem — zamiast tego użyj pauzy (PAUSED). ' +
  'Jeśli naprawdę musisz coś usunąć, zrób to ręcznie w panelu Google Ads.';

/** Statuses the connector refuses to set, because they remove the resource. */
export const FORBIDDEN_STATUSES = ['REMOVED'];

/**
 * Hard guard against turning a status mutation into a deletion. Throws with the
 * no-delete policy message for REMOVED (or any future removal status).
 * @param {string} status
 */
export function assertNotRemoval(status) {
  if (FORBIDDEN_STATUSES.includes(String(status).toUpperCase())) {
    throw new Error(`🛑 ${NO_DELETE_POLICY}`);
  }
}

/**
 * Percentage change from `current` to `next`.
 * Returns Infinity when there is no usable baseline (current unknown/<=0) but a
 * positive new value is requested — i.e. we can't verify the change, so callers
 * should treat it as unsafe.
 * @param {number|null|undefined} current
 * @param {number} next
 * @returns {number}
 */
export function pctChange(current, next) {
  const cur = Number(current);
  if (!Number.isFinite(cur) || cur <= 0) {
    return next > 0 ? Infinity : 0;
  }
  return ((Number(next) - cur) / cur) * 100;
}

/**
 * Validate a Final URL before it is written to an ad or keyword.
 *
 * Pure guardrail (no network): rejects anything that isn't a well-formed
 * absolute http(s) URL, and — when `domain` is given — rejects URLs that point
 * to a different host. The domain lock is the cheap way to stop a typo or a
 * pasted foreign link from silently sending traffic off-site; it does NOT verify
 * the page actually resolves (that would need a live fetch).
 *
 * @param {string} url
 * @param {{domain?: string}} [opts] - if set, the URL host must equal this
 *   (leading `www.` is ignored on both sides).
 * @returns {{valid: boolean, reason: string|null, host: string|null}}
 */
export function validateFinalUrl(url, opts = {}) {
  const raw = String(url ?? '').trim();
  if (!raw) return { valid: false, reason: 'Pusty URL.', host: null };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, reason: `Niepoprawny URL: "${raw}".`, host: null };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, reason: `URL musi być http/https (jest "${parsed.protocol}").`, host: parsed.host };
  }

  const host = parsed.host.replace(/^www\./, '');
  if (opts.domain) {
    const want = String(opts.domain).trim().replace(/^www\./, '').toLowerCase();
    if (host.toLowerCase() !== want) {
      return { valid: false, reason: `URL wskazuje na "${host}", oczekiwano domeny "${want}".`, host };
    }
  }
  return { valid: true, reason: null, host };
}

/** Google Ads hard limits for sitelink texts (characters, Unicode-aware). */
export const SITELINK_LIMITS = { linkText: 25, description: 35 };

/**
 * Validate sitelink texts against Google's hard character limits.
 * Descriptions are optional as a pair (both empty is fine — Google allows
 * text-only sitelinks), but when given each must fit its limit.
 *
 * @param {{linkText: string, description1?: string, description2?: string}} t
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkSitelinkTexts(t) {
  const len = (s) => [...String(s ?? '')].length;
  const reasons = [];
  if (!String(t.linkText ?? '').trim()) reasons.push('Pusty nagłówek (link_text).');
  if (len(t.linkText) > SITELINK_LIMITS.linkText) reasons.push(`link_text ma ${len(t.linkText)} znaków (limit ${SITELINK_LIMITS.linkText}).`);
  if (len(t.description1) > SITELINK_LIMITS.description) reasons.push(`description1 ma ${len(t.description1)} znaków (limit ${SITELINK_LIMITS.description}).`);
  if (len(t.description2) > SITELINK_LIMITS.description) reasons.push(`description2 ma ${len(t.description2)} znaków (limit ${SITELINK_LIMITS.description}).`);
  // Google requires description1 if description2 is set (and vice versa).
  const d1 = String(t.description1 ?? '').trim(), d2 = String(t.description2 ?? '').trim();
  if ((d1 && !d2) || (!d1 && d2)) reasons.push('Opisy muszą być podane parą (oba albo żaden).');
  return { valid: reasons.length === 0, reasons };
}

/** Google Ads hard limits for a positive keyword. */
export const KEYWORD_LIMITS = { chars: 80, words: 10 };

/** Match types the connector will write. BROAD is allowed but must be explicit. */
export const KEYWORD_MATCH_TYPES = ['EXACT', 'PHRASE', 'BROAD'];

/**
 * Validate a positive keyword before it is written to an ad group.
 *
 * Pure guardrail (no network). Google rejects the *whole* mutate batch when a
 * single keyword is malformed, so catching this locally is the difference
 * between "one row flagged" and "nothing applied, opaque API error".
 *
 * Checks Google's hard limits (80 characters, 10 words) plus the characters the
 * API refuses in keyword text. Match-type brackets/quotes are a common paste
 * artefact — `[stół okrągły]` typed as text is a different keyword than the
 * EXACT keyword `stół okrągły`, so we reject rather than silently strip them.
 *
 * @param {string} text
 * @param {string} matchType
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkKeywordText(text, matchType) {
  const raw = String(text ?? '').trim();
  const reasons = [];

  if (!raw) reasons.push('Puste słowo kluczowe.');
  const chars = [...raw].length;
  if (chars > KEYWORD_LIMITS.chars) reasons.push(`Słowo ma ${chars} znaków (limit ${KEYWORD_LIMITS.chars}).`);
  const words = raw.split(/\s+/).filter(Boolean).length;
  if (words > KEYWORD_LIMITS.words) reasons.push(`Słowo ma ${words} wyrazów (limit ${KEYWORD_LIMITS.words}).`);
  if (/[[\]"]/.test(raw)) {
    reasons.push('Nawiasy [] i cudzysłowy "" nie należą do treści słowa — typ dopasowania podaj w kolumnie match_type.');
  }
  if (/[!@%,*;^()={}<>~`|\\]/.test(raw)) {
    reasons.push('Słowo zawiera znak niedozwolony przez Google Ads (! @ % , * ; ^ ( ) = { } < > ~ ` | \\).');
  }

  const mt = String(matchType ?? '').trim().toUpperCase();
  if (!KEYWORD_MATCH_TYPES.includes(mt)) {
    reasons.push(`Typ dopasowania musi być jednym z: ${KEYWORD_MATCH_TYPES.join(' | ')} (jest "${matchType}").`);
  }

  return { valid: reasons.length === 0, reasons };
}

/** Google Ads hard limits for a Responsive Search Ad. */
export const RSA_LIMITS = {
  headlineChars: 30, descriptionChars: 90,
  minHeadlines: 3, maxHeadlines: 15,
  minDescriptions: 2, maxDescriptions: 4,
  pathChars: 15,
};

/**
 * Validate a Responsive Search Ad before it is written.
 *
 * Pure guardrail (no network). Google rejects the whole mutate batch on a single
 * over-limit asset, so catching this locally turns an opaque API failure into a
 * named row. Also enforces the *minimums* — an RSA with 2 headlines is refused by
 * the API, and that is easy to hit when a curated set gets trimmed too far.
 *
 * Duplicate headlines within one ad are rejected: Google dedupes them silently,
 * so an ad that looks like it has 15 assets can serve with fewer, which quietly
 * weakens the ad strength you thought you had.
 *
 * @param {{headlines: string[], descriptions: string[], path1?: string, path2?: string}} ad
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkRsaTexts(ad) {
  const len = (s) => [...String(s ?? '')].length;
  const reasons = [];
  const hs = (ad.headlines || []).map((h) => String(h ?? '').trim()).filter(Boolean);
  const ds = (ad.descriptions || []).map((d) => String(d ?? '').trim()).filter(Boolean);

  if (hs.length < RSA_LIMITS.minHeadlines) reasons.push(`Za mało nagłówków: ${hs.length} (min ${RSA_LIMITS.minHeadlines}).`);
  if (hs.length > RSA_LIMITS.maxHeadlines) reasons.push(`Za dużo nagłówków: ${hs.length} (max ${RSA_LIMITS.maxHeadlines}).`);
  if (ds.length < RSA_LIMITS.minDescriptions) reasons.push(`Za mało tekstów: ${ds.length} (min ${RSA_LIMITS.minDescriptions}).`);
  if (ds.length > RSA_LIMITS.maxDescriptions) reasons.push(`Za dużo tekstów: ${ds.length} (max ${RSA_LIMITS.maxDescriptions}).`);

  for (const h of hs) if (len(h) > RSA_LIMITS.headlineChars) reasons.push(`Nagłówek ${len(h)} zn. (limit ${RSA_LIMITS.headlineChars}): "${h}"`);
  for (const d of ds) if (len(d) > RSA_LIMITS.descriptionChars) reasons.push(`Tekst ${len(d)} zn. (limit ${RSA_LIMITS.descriptionChars}): "${d}"`);

  const dupH = hs.length - new Set(hs.map((h) => h.toLowerCase())).size;
  if (dupH) reasons.push(`${dupH} zduplikowany(ch) nagłówek(ów) w jednej reklamie — Google je scali.`);
  const dupD = ds.length - new Set(ds.map((d) => d.toLowerCase())).size;
  if (dupD) reasons.push(`${dupD} zduplikowany(ch) tekst(ów) w jednej reklamie.`);

  for (const [k, v] of [['path1', ad.path1], ['path2', ad.path2]]) {
    if (v && len(v) > RSA_LIMITS.pathChars) reasons.push(`${k} ma ${len(v)} zn. (limit ${RSA_LIMITS.pathChars}).`);
    if (v && /[/?#]/.test(String(v))) reasons.push(`${k} nie może zawierać / ? #.`);
  }

  return { valid: reasons.length === 0, reasons };
}

/** Google Ads hard limit for a callout ("objaśnienie"). */
export const CALLOUT_LIMIT = 25;

/**
 * Validate a callout text. Callout assets are immutable — a bad one can only be
 * paused and replaced — so it is worth blocking before the write.
 * @param {string} text
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkCalloutText(text) {
  const raw = String(text ?? '').trim();
  const reasons = [];
  if (!raw) reasons.push('Puste objaśnienie.');
  const n = [...raw].length;
  if (n > CALLOUT_LIMIT) reasons.push(`Objaśnienie ma ${n} znaków (limit ${CALLOUT_LIMIT}).`);
  return { valid: reasons.length === 0, reasons };
}

/** Google Ads limits for a structured snippet ("fragment strukturalny"). */
export const SNIPPET_LIMITS = { headerChars: 25, valueChars: 25, minValues: 3, maxValues: 10 };

/**
 * Validate a structured snippet. Like callouts, snippet assets are immutable —
 * fixing one means creating a new asset and pausing the old link.
 *
 * The header must be one of Google's supported headers FOR THE ACCOUNT LANGUAGE
 * (Polish accounts use "Typy", "Usługi", "Marki", "Style", "Modele", …). We do not
 * hardcode that list — it changes and is language-specific — so a wrong header
 * surfaces as an API error rather than a local one.
 *
 * @param {{header: string, values: string[]}} snippet
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkStructuredSnippet({ header, values }) {
  const len = (s) => [...String(s ?? '')].length;
  const reasons = [];
  const h = String(header ?? '').trim();
  const vs = (values || []).map((v) => String(v ?? '').trim()).filter(Boolean);

  if (!h) reasons.push('Pusty nagłówek fragmentu.');
  if (len(h) > SNIPPET_LIMITS.headerChars) reasons.push(`Nagłówek ma ${len(h)} znaków (limit ${SNIPPET_LIMITS.headerChars}).`);
  if (vs.length < SNIPPET_LIMITS.minValues) reasons.push(`Za mało wartości: ${vs.length} (min ${SNIPPET_LIMITS.minValues}).`);
  if (vs.length > SNIPPET_LIMITS.maxValues) reasons.push(`Za dużo wartości: ${vs.length} (max ${SNIPPET_LIMITS.maxValues}).`);
  for (const v of vs) if (len(v) > SNIPPET_LIMITS.valueChars) reasons.push(`Wartość ${len(v)} zn. (limit ${SNIPPET_LIMITS.valueChars}): "${v}"`);
  const dup = vs.length - new Set(vs.map((v) => v.toLowerCase())).size;
  if (dup) reasons.push(`${dup} zduplikowana(ych) wartość(ci) w jednym fragmencie.`);

  return { valid: reasons.length === 0, reasons };
}

/** Google Ads limits for a price extension ("rozszerzenie cenowe"). */
export const PRICE_LIMITS = { headerChars: 25, descriptionChars: 25, minOfferings: 3, maxOfferings: 8 };

/**
 * Validate the offerings of one price extension. Google rejects the whole asset
 * if a single offering is malformed, so everything is checked before the write.
 * Prices are in standard currency here — the mutator converts to micros.
 *
 * @param {Array<{header: string, description: string, price: number|string, finalUrl: string}>} offerings
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkPriceOfferings(offerings) {
  const len = (s) => [...String(s ?? '')].length;
  const reasons = [];
  const list = offerings || [];

  if (list.length < PRICE_LIMITS.minOfferings) reasons.push(`Za mało pozycji cennika: ${list.length} (min ${PRICE_LIMITS.minOfferings}).`);
  if (list.length > PRICE_LIMITS.maxOfferings) reasons.push(`Za dużo pozycji cennika: ${list.length} (max ${PRICE_LIMITS.maxOfferings}).`);

  for (const o of list) {
    const h = String(o.header ?? '').trim();
    const d = String(o.description ?? '').trim();
    if (!h) reasons.push('Pozycja cennika bez nagłówka.');
    if (len(h) > PRICE_LIMITS.headerChars) reasons.push(`Nagłówek pozycji ${len(h)} zn. (limit ${PRICE_LIMITS.headerChars}): "${h}"`);
    if (!d) reasons.push(`Pozycja "${h}" bez opisu.`);
    if (len(d) > PRICE_LIMITS.descriptionChars) reasons.push(`Opis pozycji ${len(d)} zn. (limit ${PRICE_LIMITS.descriptionChars}): "${d}"`);
    const p = Number(String(o.price ?? '').replace(',', '.'));
    if (!Number.isFinite(p) || p <= 0) reasons.push(`Pozycja "${h}": cena musi być liczbą dodatnią w walucie standardowej (dostałem "${o.price}").`);
  }

  const dup = list.length - new Set(list.map((o) => String(o.header ?? '').trim().toLowerCase())).size;
  if (dup) reasons.push(`${dup} zduplikowany(ch) nagłówek(ów) pozycji — Google wymaga unikalnych.`);

  return { valid: reasons.length === 0, reasons };
}

/** Google Ads hard limit for an ad group name. */
export const AD_GROUP_NAME_LIMIT = 255;

/**
 * Validate an ad group name. Google rejects duplicate names within a campaign,
 * but that is caught by the idempotency read in the mutator — here we only guard
 * the format.
 *
 * @param {string} name
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkAdGroupName(name) {
  const raw = String(name ?? '').trim();
  const reasons = [];
  if (!raw) reasons.push('Pusta nazwa grupy reklam.');
  const chars = [...raw].length;
  if (chars > AD_GROUP_NAME_LIMIT) reasons.push(`Nazwa ma ${chars} znaków (limit ${AD_GROUP_NAME_LIMIT}).`);
  return { valid: reasons.length === 0, reasons };
}

/**
 * Decide whether a budget change is within the safety limit.
 * @param {number|null|undefined} currentAmount - current daily budget (standard currency)
 * @param {number} newAmount - requested daily budget (standard currency)
 * @param {{limitPct?: number}} [opts]
 * @returns {{currentAmount: number|null, newAmount: number, pctChange: number|null,
 *            limitPct: number, safe: boolean, reason: string|null}}
 */
export function checkBudgetChange(currentAmount, newAmount, opts = {}) {
  const limitPct = opts.limitPct ?? DEFAULT_MAX_BUDGET_CHANGE_PCT;
  const change = pctChange(currentAmount, newAmount);
  const abs = Math.abs(change);
  const safe = Number.isFinite(change) && abs <= limitPct;

  let reason = null;
  if (!safe) {
    reason = Number.isFinite(change)
      ? `Zmiana budżetu o ${Math.round(abs)}% przekracza limit bezpieczeństwa ${limitPct}%.`
      : `Nie udało się ustalić obecnego budżetu — nie mogę zweryfikować skali zmiany.`;
  }

  return {
    currentAmount: currentAmount ?? null,
    newAmount: Number(newAmount),
    pctChange: Number.isFinite(change) ? Math.round(change * 10) / 10 : null,
    limitPct,
    safe,
    reason,
  };
}
