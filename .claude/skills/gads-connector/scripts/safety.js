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
 * Character count as GOOGLE measures it for ad text limits.
 *
 * Keyword-insertion placeholders — `{Keyword:Nawierzchnie na plac zabaw}` and its
 * case variants (`KeyWord`, `KEYWord`) — count only as their DEFAULT text, which
 * is what serves when no keyword fits. Counting the raw string instead rejects
 * perfectly legal ads: the literal form is ~9 characters longer than what Google
 * sees, so a valid 26-character default reads as 35 and the whole batch is
 * blocked. Hit for real when cloning existing ads that use insertion.
 *
 * @param {string} s
 * @returns {number} effective length
 */
export function adTextLength(s) {
  const expanded = String(s ?? '').replace(/\{\s*keyword\s*:\s*([^}]*)\}/gi, '$1');
  return [...expanded].length;
}

/**
 * Longest run of capitals Google still reads as an acronym rather than shouting.
 * PNG, JPG, RODO and HTML pass; GRATIS, PROMOCJA, NAJTANIEJ do not.
 */
export const CAPS_WORD_LIMIT = 4;

/** A whole word written in capitals — Unicode-aware, so ŚWIEŻE counts too. */
const SHOUTING_RE = new RegExp(`(?<!\\p{L})(\\p{Lu}{${CAPS_WORD_LIMIT + 1},})(?!\\p{L})`, 'gu');

/**
 * Find words written entirely in capitals in a piece of ad text.
 *
 * Google refuses these under "nadmierne użycie wielkich liter" as a **PROHIBITED**
 * policy topic — not a warning, a hard disapproval. It matters more than a length
 * slip, because the ad actions send a whole file as ONE atomic batch: a single
 * shouted word takes every other ad in it down too, and the API answers with a
 * bare `POLICY_FINDING` that names neither the topic nor the word. The failure
 * therefore lands after the commit, opaque, and costs a round of detective work
 * with `validate_only`.
 *
 * Acronyms are why this is a length threshold and not a flat ban: PNG, JPG, RODO
 * and HTML are normal in ad copy and Google accepts them. A brand genuinely
 * styled in capitals is the known false positive — business names are checked
 * elsewhere and deliberately left out of this one.
 *
 * @param {string} text
 * @returns {string[]} the shouted words, in order of appearance
 */
export function findShoutingWords(text) {
  return [...String(text ?? '').matchAll(SHOUTING_RE)].map((m) => m[1]);
}

/**
 * Turn every shouted word in a set of ad texts into a named reason.
 * @param {Array<[string, string[]]>} groups - `[label, texts]` pairs
 * @returns {string[]}
 */
function shoutingReasons(groups) {
  const reasons = [];
  for (const [kind, list] of groups) {
    for (const t of list || []) {
      const shouted = findShoutingWords(t);
      if (shouted.length) reasons.push(`${kind} zawiera wyraz wersalikami (${shouted.join(', ')}) — Google odrzuca to jako "nadmierne użycie wielkich liter" (PROHIBITED) i ubija całą partię reklam. Zapisz normalnie: "${t}".`);
    }
  }
  return reasons;
}

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
 * Words in capitals are rejected too (see `findShoutingWords`) — that one is a
 * PROHIBITED policy topic, so it disapproves the ad rather than merely weakening
 * it, and takes the whole atomic batch with it.
 *
 * Lengths are measured with `adTextLength`, so keyword insertion is counted the
 * way Google counts it.
 *
 * @param {{headlines: string[], descriptions: string[], path1?: string, path2?: string}} ad
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkRsaTexts(ad) {
  const len = adTextLength;
  const reasons = [];
  const hs = (ad.headlines || []).map((h) => String(h ?? '').trim()).filter(Boolean);
  const ds = (ad.descriptions || []).map((d) => String(d ?? '').trim()).filter(Boolean);

  if (hs.length < RSA_LIMITS.minHeadlines) reasons.push(`Za mało nagłówków: ${hs.length} (min ${RSA_LIMITS.minHeadlines}).`);
  if (hs.length > RSA_LIMITS.maxHeadlines) reasons.push(`Za dużo nagłówków: ${hs.length} (max ${RSA_LIMITS.maxHeadlines}).`);
  if (ds.length < RSA_LIMITS.minDescriptions) reasons.push(`Za mało tekstów: ${ds.length} (min ${RSA_LIMITS.minDescriptions}).`);
  if (ds.length > RSA_LIMITS.maxDescriptions) reasons.push(`Za dużo tekstów: ${ds.length} (max ${RSA_LIMITS.maxDescriptions}).`);

  for (const h of hs) if (len(h) > RSA_LIMITS.headlineChars) reasons.push(`Nagłówek ${len(h)} zn. (limit ${RSA_LIMITS.headlineChars}): "${h}"`);
  for (const d of ds) if (len(d) > RSA_LIMITS.descriptionChars) reasons.push(`Tekst ${len(d)} zn. (limit ${RSA_LIMITS.descriptionChars}): "${d}"`);

  reasons.push(...shoutingReasons([['Nagłówek', hs], ['Tekst', ds]]));

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

/** Google Ads hard limit for a campaign name. */
export const CAMPAIGN_NAME_LIMIT = 255;

/** Bidding strategies `create-campaigns` can set on a Search campaign. */
export const SEARCH_BIDDING_STRATEGIES = ['MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'MANUAL_CPC'];

/** Which extra knob belongs to which strategy. Anything else is a silent no-op → blocked. */
const STRATEGY_KNOB = {
  MAXIMIZE_CLICKS: 'cpcBidCeiling',
  MAXIMIZE_CONVERSIONS: 'targetCpa',
  MAXIMIZE_CONVERSION_VALUE: 'targetRoas',
  MANUAL_CPC: null,
};

/** How a campaign treats people outside the targeted area. */
export const GEO_TARGET_TYPES = ['PRESENCE', 'PRESENCE_OR_INTEREST'];

/**
 * EU political-advertising declaration. Google made this REQUIRED on campaign
 * creation (Regulation (EU) 2024/900) — a campaign without it is rejected
 * outright. It is a legal statement about the ADS, so the connector never
 * guesses "contains": the default declares that they do not, and an account
 * that really runs political ads has to say so explicitly in the CSV.
 */
export const EU_POLITICAL_ADVERTISING = ['DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', 'CONTAINS_EU_POLITICAL_ADVERTISING'];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate one Search campaign spec before anything is created.
 *
 * Blocks are things Google would reject, or that silently do nothing — a
 * `target_roas` on a Maximize-clicks campaign is accepted by the CSV and then
 * ignored by the API, which is worse than an error because nobody notices.
 * Warnings are configurations Google accepts and the account regrets: a campaign
 * born ENABLED starts spending the moment it is written, and the display network
 * inside a Search campaign quietly eats the budget.
 *
 * @param {object} c - normalised campaign row (see createSearchCampaigns)
 * @returns {{valid: boolean, reasons: string[], warnings: string[]}}
 */
export function checkCampaignSpec(c) {
  const reasons = [];
  const warnings = [];

  const name = String(c.name ?? '').trim();
  if (!name) reasons.push('Pusta nazwa kampanii.');
  const chars = [...name].length;
  if (chars > CAMPAIGN_NAME_LIMIT) reasons.push(`Nazwa ma ${chars} znaków (limit ${CAMPAIGN_NAME_LIMIT}).`);

  const budget = Number(c.budgetAmount);
  if (!Number.isFinite(budget) || budget <= 0) reasons.push(`Budżet dzienny musi być liczbą dodatnią (jest "${c.budgetAmount}").`);

  const strategy = String(c.biddingStrategy ?? '').trim().toUpperCase();
  if (!SEARCH_BIDDING_STRATEGIES.includes(strategy)) {
    reasons.push(`Strategia "${c.biddingStrategy}" nieobsługiwana. Dozwolone: ${SEARCH_BIDDING_STRATEGIES.join(', ')}.`);
  } else {
    // A knob that belongs to another strategy would be accepted and ignored.
    const allowed = STRATEGY_KNOB[strategy];
    for (const knob of ['cpcBidCeiling', 'targetCpa', 'targetRoas']) {
      if (c[knob] == null || c[knob] === '') continue;
      if (knob !== allowed) reasons.push(`"${knob}" nie działa ze strategią ${strategy} — Google przyjmie kampanię i zignoruje tę wartość. Usuń kolumnę albo zmień strategię.`);
      else if (!(Number(c[knob]) > 0)) reasons.push(`"${knob}" musi być liczbą dodatnią (jest "${c[knob]}").`);
    }
  }

  const status = String(c.status ?? '').trim().toUpperCase();
  if (!['ENABLED', 'PAUSED'].includes(status)) reasons.push(`Status musi być ENABLED albo PAUSED (jest "${c.status}").`);
  if (status === 'ENABLED') warnings.push(`Kampania powstanie jako ENABLED — zacznie wydawać budżet od razu po zapisie.`);

  if (!Array.isArray(c.geoTargets) || c.geoTargets.length === 0) reasons.push('Brak lokalizacji docelowej (geo_targets).');
  else c.geoTargets.forEach((g) => { if (!/^\d+$/.test(String(g))) reasons.push(`Lokalizacja "${g}" nie jest numerycznym ID geoTargetConstant.`); });

  if (!Array.isArray(c.languages) || c.languages.length === 0) reasons.push('Brak języka (languages).');
  else c.languages.forEach((l) => { if (!/^\d+$/.test(String(l))) reasons.push(`Język "${l}" nie jest numerycznym ID languageConstant.`); });

  const geoType = String(c.geoTargetType ?? '').trim().toUpperCase();
  if (!GEO_TARGET_TYPES.includes(geoType)) reasons.push(`geo_target_type musi być ${GEO_TARGET_TYPES.join(' albo ')} (jest "${c.geoTargetType}").`);

  const euPolitical = String(c.euPoliticalAdvertising ?? '').trim().toUpperCase();
  if (!EU_POLITICAL_ADVERTISING.includes(euPolitical)) reasons.push(`eu_political_advertising musi być ${EU_POLITICAL_ADVERTISING.join(' albo ')} (jest "${c.euPoliticalAdvertising}").`);
  if (euPolitical === 'CONTAINS_EU_POLITICAL_ADVERTISING') warnings.push('Kampania zadeklarowana jako reklama polityczna w UE — Google nałoży na nią osobne wymogi weryfikacji i przejrzystości. Upewnij się, że to świadoma deklaracja.');

  if (c.contentNetwork) warnings.push('Włączona sieć reklamowa w kampanii w wyszukiwarce — zwykle zjada budżet po znacznie gorszych stawkach niż wyszukiwarka.');

  for (const [field, value] of [['start_date', c.startDate], ['end_date', c.endDate]]) {
    if (!value) continue;
    if (!ISO_DATE_RE.test(String(value))) reasons.push(`${field} musi być w formacie RRRR-MM-DD (jest "${value}").`);
  }
  if (c.startDate && c.endDate && ISO_DATE_RE.test(String(c.startDate)) && ISO_DATE_RE.test(String(c.endDate)) && String(c.endDate) < String(c.startDate)) {
    reasons.push(`end_date (${c.endDate}) jest wcześniejszy niż start_date (${c.startDate}).`);
  }

  return { valid: reasons.length === 0, reasons, warnings };
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

/**
 * Google Ads hard limits for a Demand Gen video responsive ad.
 *
 * The API proto marks only `videos`, `logo_images` and `business_name` as
 * REQUIRED; the text minimums below are enforced by the server at ad-creation
 * time, not by the proto. Checking them here turns a rejected mutate into a
 * readable message before anything is written.
 */
export const DEMAND_GEN_LIMITS = {
  headlineChars: 40,
  longHeadlineChars: 90,
  descriptionChars: 90,
  businessNameChars: 25,
  minHeadlines: 1,
  maxHeadlines: 5,
  maxLongHeadlines: 5,
  minDescriptions: 1,
  maxDescriptions: 5,
};

/**
 * Validate the text side of a Demand Gen video responsive ad.
 *
 * Mirrors `checkRsaTexts`: collect every reason, never throw here — the caller
 * aggregates problems across the whole batch and blocks the write as a unit, so
 * the operator fixes one file instead of discovering errors row by row.
 *
 * @param {{headlines?: string[], longHeadlines?: string[], descriptions?: string[], businessName?: string}} ad
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkDemandGenAdTexts(ad) {
  const len = adTextLength;
  const L = DEMAND_GEN_LIMITS;
  const reasons = [];
  const hs = (ad.headlines || []).map((h) => String(h ?? '').trim()).filter(Boolean);
  const lhs = (ad.longHeadlines || []).map((h) => String(h ?? '').trim()).filter(Boolean);
  const ds = (ad.descriptions || []).map((d) => String(d ?? '').trim()).filter(Boolean);
  const bn = String(ad.businessName ?? '').trim();

  if (hs.length < L.minHeadlines) reasons.push(`Za mało nagłówków: ${hs.length} (min ${L.minHeadlines}).`);
  if (hs.length > L.maxHeadlines) reasons.push(`Za dużo nagłówków: ${hs.length} (max ${L.maxHeadlines}).`);
  if (lhs.length > L.maxLongHeadlines) reasons.push(`Za dużo długich nagłówków: ${lhs.length} (max ${L.maxLongHeadlines}).`);
  if (ds.length < L.minDescriptions) reasons.push(`Za mało tekstów: ${ds.length} (min ${L.minDescriptions}).`);
  if (ds.length > L.maxDescriptions) reasons.push(`Za dużo tekstów: ${ds.length} (max ${L.maxDescriptions}).`);

  for (const h of hs) if (len(h) > L.headlineChars) reasons.push(`Nagłówek ${len(h)} zn. (limit ${L.headlineChars}): "${h}"`);
  for (const h of lhs) if (len(h) > L.longHeadlineChars) reasons.push(`Długi nagłówek ${len(h)} zn. (limit ${L.longHeadlineChars}): "${h}"`);
  for (const d of ds) if (len(d) > L.descriptionChars) reasons.push(`Tekst ${len(d)} zn. (limit ${L.descriptionChars}): "${d}"`);

  if (!bn) reasons.push('Brak nazwy firmy (business_name) — pole wymagane przez API.');
  else if (len(bn) > L.businessNameChars) reasons.push(`Nazwa firmy ${len(bn)} zn. (limit ${L.businessNameChars}): "${bn}"`);

  // Nazwa firmy świadomie pominięta — marka bywa zapisana wersalikami legalnie.
  reasons.push(...shoutingReasons([['Nagłówek', hs], ['Długi nagłówek', lhs], ['Tekst', ds]]));

  const dupH = hs.length - new Set(hs.map((h) => h.toLowerCase())).size;
  if (dupH) reasons.push(`${dupH} zduplikowany(ch) nagłówek(ów) w jednej reklamie — Google je scali.`);
  const dupD = ds.length - new Set(ds.map((d) => d.toLowerCase())).size;
  if (dupD) reasons.push(`${dupD} zduplikowany(ch) tekst(ów) w jednej reklamie.`);

  return { valid: reasons.length === 0, reasons };
}

/** Surfaces a Demand Gen ad group can be pinned to, as named in the API proto. */
export const DEMAND_GEN_CHANNELS = ['youtube_in_stream', 'youtube_in_feed', 'youtube_shorts', 'discover', 'gmail', 'display'];

/** Channel strategies that let Google pick the surfaces itself. */
export const DEMAND_GEN_STRATEGIES = ['ALL_CHANNELS', 'ALL_OWNED_AND_OPERATED_CHANNELS'];

/**
 * Validate the channel configuration of a Demand Gen ad group.
 *
 * `channel_strategy` and `selected_channels` are a protobuf oneof, so exactly
 * one of them may be set. Sending both silently drops one — this makes that a
 * blocking error instead.
 *
 * @param {{strategy?: string, channels?: string[]}} cfg
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkDemandGenChannels(cfg) {
  const reasons = [];
  const strategy = String(cfg.strategy ?? '').trim().toUpperCase();
  const channels = (cfg.channels || []).map((c) => String(c ?? '').trim().toLowerCase()).filter(Boolean);

  if (strategy && channels.length) {
    reasons.push('Podano jednocześnie channel_strategy i channels — to pola wykluczające się (oneof). Wybierz jedno.');
  }
  if (strategy && !DEMAND_GEN_STRATEGIES.includes(strategy)) {
    reasons.push(`Nieznana strategia kanałów "${strategy}". Dozwolone: ${DEMAND_GEN_STRATEGIES.join(', ')}.`);
  }
  for (const c of channels) {
    if (!DEMAND_GEN_CHANNELS.includes(c)) reasons.push(`Nieznany kanał "${c}". Dozwolone: ${DEMAND_GEN_CHANNELS.join(', ')}.`);
  }
  return { valid: reasons.length === 0, reasons };
}

/** Google Ads limits for a promotion asset ("promocja"). */
export const PROMOTION_LIMITS = { targetChars: 25 };

/** Discount modifiers Google accepts on a promotion asset. */
const PROMOTION_MODIFIERS = new Set(['UP_TO']);

/**
 * Validate a promotion asset. Like callouts and price extensions, promotion
 * assets are immutable — "editing" one means creating a replacement and pausing
 * the old link (`pause-assets`).
 *
 * The two discount shapes are mutually exclusive: Google takes EITHER a percent
 * OFF or a money amount off, never both and never neither. When a minimum order
 * value is set it must be in the same currency as the discount, otherwise the
 * API accepts the asset and it silently fails to serve.
 *
 * A promotion asset without a Final URL is rejected by the API
 * (REQUIRED_NONEMPTY_LIST), so the URL is required here rather than optional.
 *
 * @param {{promotionTarget: string, percentOff?: number, moneyAmountOff?: number,
 *          currency?: string, ordersOverAmount?: number, discountModifier?: string,
 *          finalUrl?: string}} p
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function checkPromotion(p) {
  const reasons = [];
  const target = String(p.promotionTarget ?? '').trim();
  if (!target) reasons.push('Puste "co obejmuje promocja" (promotion_target).');
  const n = [...target].length;
  if (n > PROMOTION_LIMITS.targetChars) reasons.push(`promotion_target ma ${n} znaków (limit ${PROMOTION_LIMITS.targetChars}): "${target}"`);

  const hasPct = Number.isFinite(p.percentOff) && p.percentOff > 0;
  const hasMoney = Number.isFinite(p.moneyAmountOff) && p.moneyAmountOff > 0;
  if (hasPct && hasMoney) reasons.push('Podano naraz percent_off i money_amount_off — Google przyjmuje tylko jedno z dwóch.');
  if (!hasPct && !hasMoney) reasons.push('Brak rabatu: podaj percent_off (np. 10) albo money_amount_off (np. 7) z walutą.');
  if (hasPct && p.percentOff > 100) reasons.push(`percent_off = ${p.percentOff}% (dopuszczalne 0-100).`);
  if (hasMoney && !String(p.currency ?? '').trim()) reasons.push('money_amount_off wymaga waluty (currency), np. EUR.');

  const hasMin = Number.isFinite(p.ordersOverAmount) && p.ordersOverAmount > 0;
  if (hasMin && hasMoney && p.ordersOverAmount <= p.moneyAmountOff) {
    reasons.push(`Próg zamówienia (${p.ordersOverAmount}) nie jest wyższy od rabatu (${p.moneyAmountOff}) — taka promocja nie ma sensu.`);
  }
  if (hasMin && !String(p.currency ?? '').trim()) reasons.push('orders_over_amount wymaga waluty (currency) — tej samej co rabat.');

  if (!String(p.finalUrl ?? '').trim()) reasons.push('Brak final_url — Google wymaga adresu docelowego na assecie promocji.');

  const mod = String(p.discountModifier ?? '').trim().toUpperCase();
  if (mod && !PROMOTION_MODIFIERS.has(mod)) reasons.push(`discount_modifier = "${mod}" — dopuszczalne: ${[...PROMOTION_MODIFIERS].join(', ')} albo puste.`);

  return { valid: reasons.length === 0, reasons };
}

// --- Conversion actions (wdrażanie konwersji) --------------------------------

/**
 * Conversion action types this connector creates. Deliberately narrow: these are
 * the ones you deploy by hand — a website tag (`WEBPAGE`), a call from the site
 * (`WEBSITE_CALL`), or offline imports (`UPLOAD_CLICKS` / `UPLOAD_CALLS`).
 *
 * Everything else in the API enum (GOOGLE_ANALYTICS_4_*, FIREBASE_*, STORE_*,
 * app-analytics types) is NOT created this way — those appear in the account by
 * linking GA4 / Firebase / a store feed, and asking the API to create one either
 * fails or produces a dead action that never fires.
 */
export const CONVERSION_TYPES = ['WEBPAGE', 'WEBSITE_CALL', 'UPLOAD_CLICKS', 'UPLOAD_CALLS'];

/** Conversion categories Google accepts (the enum minus UNSPECIFIED/UNKNOWN). */
export const CONVERSION_CATEGORIES = [
  'DEFAULT', 'PAGE_VIEW', 'PURCHASE', 'SIGNUP', 'DOWNLOAD', 'ADD_TO_CART', 'BEGIN_CHECKOUT',
  'SUBSCRIBE_PAID', 'PHONE_CALL_LEAD', 'IMPORTED_LEAD', 'SUBMIT_LEAD_FORM', 'BOOK_APPOINTMENT',
  'REQUEST_QUOTE', 'GET_DIRECTIONS', 'OUTBOUND_CLICK', 'CONTACT', 'ENGAGEMENT', 'STORE_VISIT',
  'STORE_SALE', 'QUALIFIED_LEAD', 'CONVERTED_LEAD',
];

/** Categories that describe a lead, not a sale — used only for the warnings below. */
const LEAD_CATEGORIES = new Set([
  'SIGNUP', 'PHONE_CALL_LEAD', 'IMPORTED_LEAD', 'SUBMIT_LEAD_FORM', 'BOOK_APPOINTMENT',
  'REQUEST_QUOTE', 'CONTACT', 'QUALIFIED_LEAD', 'CONVERTED_LEAD',
]);

/** How many conversions one click may produce. */
export const CONVERSION_COUNTING_TYPES = ['ONE_PER_CLICK', 'MANY_PER_CLICK'];

/** Attribution models settable on a conversion action. */
export const CONVERSION_ATTRIBUTION_MODELS = [
  'GOOGLE_ADS_LAST_CLICK', 'GOOGLE_SEARCH_ATTRIBUTION_FIRST_CLICK',
  'GOOGLE_SEARCH_ATTRIBUTION_LINEAR', 'GOOGLE_SEARCH_ATTRIBUTION_TIME_DECAY',
  'GOOGLE_SEARCH_ATTRIBUTION_POSITION_BASED', 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN',
];

/**
 * Statuses the connector will set on a conversion action. `REMOVED` is absent on
 * purpose (no-delete policy) — retiring a conversion means `HIDDEN`, which stops
 * it from counting while the history stays readable.
 */
export const CONVERSION_STATUSES = ['ENABLED', 'HIDDEN'];

/** Google's hard bounds on the conversion windows, in days. */
export const CONVERSION_LOOKBACK = { clickMin: 1, clickMax: 90, viewMin: 1, viewMax: 30 };

/**
 * Validate one conversion action before it is created or updated.
 *
 * Two separate outputs, and the difference matters: `reasons` are API-level
 * errors that block the batch, `warnings` are configurations the API accepts
 * happily but which quietly break measurement or bidding later (a purchase
 * counted once per click, revenue flattened to one default value). Warnings ride
 * along in the dry-run plan so the operator sees them before `--commit`.
 *
 * On an update only the fields actually present are checked — a CSV row that
 * only flips `primary_for_goal` must not be rejected for "missing type".
 *
 * @param {{name?: string, type?: string, category?: string, status?: string,
 *          countingType?: string, attributionModel?: string, primaryForGoal?: boolean,
 *          defaultValue?: number|string, currency?: string, alwaysUseDefaultValue?: boolean,
 *          clickLookbackDays?: number|string, viewLookbackDays?: number|string}} c
 * @param {{isUpdate?: boolean}} [opts]
 * @returns {{valid: boolean, reasons: string[], warnings: string[]}}
 */
export function checkConversionAction(c, opts = {}) {
  const isUpdate = !!opts.isUpdate;
  const reasons = [];
  const warnings = [];
  const up = (v) => String(v ?? '').trim().toUpperCase();
  const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';

  const name = String(c.name ?? '').trim();
  if (!isUpdate && !name) reasons.push('Brak nazwy konwersji (name).');

  const type = up(c.type);
  if (given(c.type) && !CONVERSION_TYPES.includes(type)) {
    reasons.push(`type = "${type}" — ten connector tworzy tylko: ${CONVERSION_TYPES.join(', ')}. Konwersje z GA4/Firebase powstają przez połączenie usługi, nie przez API.`);
  }
  if (!isUpdate && !given(c.type)) reasons.push('Brak type (np. WEBPAGE dla konwersji ze strony).');

  const category = up(c.category);
  if (given(c.category) && !CONVERSION_CATEGORIES.includes(category)) {
    reasons.push(`category = "${category}" — nieznana kategoria. Dozwolone: ${CONVERSION_CATEGORIES.join(', ')}.`);
  }
  if (!isUpdate && !given(c.category)) reasons.push('Brak category (np. PURCHASE dla zakupu, SUBMIT_LEAD_FORM dla formularza).');

  if (given(c.status)) {
    assertNotRemoval(c.status); // throws with the no-delete policy
    if (!CONVERSION_STATUSES.includes(up(c.status))) {
      reasons.push(`status = "${up(c.status)}" — dozwolone: ${CONVERSION_STATUSES.join(', ')} (wycofanie konwersji to HIDDEN, nie usunięcie).`);
    }
  }

  const counting = up(c.countingType);
  if (given(c.countingType) && !CONVERSION_COUNTING_TYPES.includes(counting)) {
    reasons.push(`counting_type = "${counting}" — dozwolone: ${CONVERSION_COUNTING_TYPES.join(', ')}.`);
  }

  if (given(c.attributionModel) && !CONVERSION_ATTRIBUTION_MODELS.includes(up(c.attributionModel))) {
    reasons.push(`attribution_model = "${up(c.attributionModel)}" — dozwolone: ${CONVERSION_ATTRIBUTION_MODELS.join(', ')}.`);
  }

  if (given(c.defaultValue)) {
    const v = Number(c.defaultValue);
    if (!Number.isFinite(v) || v < 0) reasons.push(`default_value = "${c.defaultValue}" — musi być liczbą >= 0.`);
  }
  if (given(c.currency) && !/^[A-Za-z]{3}$/.test(String(c.currency).trim())) {
    reasons.push(`currency = "${c.currency}" — oczekiwano trzyliterowego kodu waluty (np. PLN).`);
  }
  if (c.alwaysUseDefaultValue === true && !given(c.defaultValue)) {
    reasons.push('always_use_default_value = TRUE bez default_value — każda konwersja dostałaby wartość 0.');
  }

  const win = (v, min, max, label) => {
    if (!given(v)) return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) reasons.push(`${label} = "${v}" — musi być całkowitą liczbą dni z zakresu ${min}-${max}.`);
  };
  win(c.clickLookbackDays, CONVERSION_LOOKBACK.clickMin, CONVERSION_LOOKBACK.clickMax, 'click_through_lookback_days');
  win(c.viewLookbackDays, CONVERSION_LOOKBACK.viewMin, CONVERSION_LOOKBACK.viewMax, 'view_through_lookback_days');

  // Configurations the API accepts and the account regrets.
  if (category === 'PURCHASE') {
    if (c.alwaysUseDefaultValue === true) {
      warnings.push(`"${name || 'PURCHASE'}": always_use_default_value na zakupie spłaszcza przychód do jednej kwoty — ROAS przestanie odpowiadać rzeczywistości. Wartość powinna przychodzić ze strony (transaction value).`);
    }
    if (counting === 'ONE_PER_CLICK') {
      warnings.push(`"${name || 'PURCHASE'}": counting_type = ONE_PER_CLICK na zakupie — drugie zamówienie z tego samego kliknięcia nie policzy się. Dla e-commerce standardem jest MANY_PER_CLICK.`);
    }
    if (c.primaryForGoal === false) {
      warnings.push(`"${name || 'PURCHASE'}": zakup jako konwersja dodatkowa (primary_for_goal = FALSE) nie wejdzie do licytacji — Smart Bidding jej nie użyje.`);
    }
  }
  if (LEAD_CATEGORIES.has(category)) {
    if (counting === 'MANY_PER_CLICK') {
      warnings.push(`"${name || category}": counting_type = MANY_PER_CLICK na leadzie policzy każde powtórzenie tego zdarzenia z jednego kliknięcia. Dla leadów standardem jest ONE_PER_CLICK.`);
    }
    if (!given(c.defaultValue) && c.alwaysUseDefaultValue !== true) {
      warnings.push(`"${name || category}": lead bez wartości (default_value) — tCPA zadziała, tROAS nie ma z czego liczyć.`);
    }
  }

  return { valid: reasons.length === 0, reasons, warnings };
}
