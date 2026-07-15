import { getCustomer, unpackError } from './client.js';
import { getBudgetById, getCurrentFinalUrls, getSitelinkLinkDetails, sitelinkLinkLevel, getExistingSitelinks } from './queries.js';
import { checkBudgetChange, assertNotRemoval, validateFinalUrl, checkSitelinkTexts } from './safety.js';

/**
 * Entity metadata for Final URL updates. Maps our short entity key to the
 * google-ads-api service accessor and the resource-name prefix used to build a
 * full resource name from a bare ID.
 *   ad      → Ad.final_urls          (works for RSA; legacy text ads are immutable)
 *   keyword → AdGroupCriterion.final_urls  (keyword-level Final URL override)
 */
const FINAL_URL_ENTITIES = {
  ad: { service: 'ads', prefix: 'ads', label: 'reklama' },
  keyword: { service: 'adGroupCriteria', prefix: 'adGroupCriteria', label: 'słowo kluczowe' },
};

/**
 * Build a full resource name for a Final-URL update from a user-supplied ID.
 * Accepts an already-full resource name (contains '/') and returns it as-is;
 * otherwise joins customer + prefix + bare ID. For keywords the bare ID is the
 * composite `adGroupId~criterionId`.
 */
export function buildFinalUrlResourceName(customerId, entity, id) {
  const meta = FINAL_URL_ENTITIES[entity];
  if (!meta) throw new Error(`Nieznany typ zasobu do zmiany URL: "${entity}". Dozwolone: ad, keyword.`);
  const raw = String(id ?? '').trim();
  if (!raw) throw new Error('Brak ID / resource_name elementu do zmiany URL.');
  if (raw.includes('/')) return raw; // already a full resource name
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  return `customers/${cleanCustomerId}/${meta.prefix}/${raw}`;
}

/**
 * Update the Final URL of one or many ads or keywords.
 *
 * All-or-nothing on validation: if ANY requested URL is malformed or off-domain,
 * nothing is written (fail-safe — a batch shouldn't half-apply). `--dry-run`
 * reads the current URLs and returns a before→after diff without touching the
 * account.
 *
 * @param {string} customerId
 * @param {'ad'|'keyword'} entity
 * @param {Array<{resourceName: string, finalUrl: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{domain?: string}} [opts] - domain lock passed to validateFinalUrl
 * @returns {Promise<object>} Mutation summary with per-item diff
 */
export async function updateFinalUrls(customerId, entity, items, dryRun = false, loginCustomerId, opts = {}) {
  const meta = FINAL_URL_ENTITIES[entity];
  if (!meta) throw new Error(`Nieznany typ zasobu do zmiany URL: "${entity}". Dozwolone: ad, keyword.`);
  const cleanCustomerId = String(customerId).replace(/-/g, '');

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Brak elementów do zmiany URL (pusta lista).');
  }

  // 1. Validate every URL first — fail-safe, before any write.
  const invalid = [];
  const normalized = items.map((it) => {
    const finalUrl = String(it.finalUrl ?? '').trim();
    const check = validateFinalUrl(finalUrl, { domain: opts.domain });
    if (!check.valid) invalid.push({ resourceName: it.resourceName, finalUrl, reason: check.reason });
    return { resourceName: it.resourceName, finalUrl, label: it.label };
  });
  if (invalid.length) {
    const lines = invalid.map((e) => `  • ${e.label || e.resourceName}: ${e.reason}`).join('\n');
    throw new Error(`🛑 Zablokowano — ${invalid.length} niepoprawny(ch) URL(i), nic nie zapisano:\n${lines}`);
  }

  // 2. Read current URLs for a real before→after diff.
  let currentMap = new Map();
  try {
    currentMap = await getCurrentFinalUrls(cleanCustomerId, entity, normalized.map((n) => n.resourceName), { loginCustomerId });
  } catch {
    currentMap = new Map(); // diff is best-effort; a read failure must not block a valid write
  }
  const diff = normalized.map((n) => {
    const from = currentMap.get(n.resourceName) || [];
    return {
      label: n.label,
      resourceName: n.resourceName,
      from,
      to: [n.finalUrl],
      changed: !(from.length === 1 && from[0] === n.finalUrl),
      found: currentMap.has(n.resourceName),
    };
  });

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Zmiana Final URL dla ${normalized.length} ${meta.label}(ów)...`);

  if (dryRun) {
    return { success: true, dryRun: true, entity, count: normalized.length, diff };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const updates = normalized.map((n) => ({ resource_name: n.resourceName, final_urls: [n.finalUrl] }));
    const response = await customer[meta.service].update(updates);
    return { success: true, dryRun: false, entity, count: normalized.length, diff, response };
  } catch (error) {
    throw new Error(`Nie udało się zmienić Final URL (${meta.label}): ${unpackError(error)}`);
  }
}

/**
 * Clear the keyword-level Final URL override (`ad_group_criterion.final_urls = []`)
 * so the keyword falls back to serving its AD's Final URL. This is an edit of a
 * field, NOT a resource removal — the keyword itself stays — so it is allowed by
 * the no-delete policy. Use it to retire redundant overrides that already point
 * to the same place the ad does.
 *
 * `--dry-run` reads the current override and returns a per-item `from → (URL
 * reklamy)` diff. It skips criteria that already have no override (`changed:false`).
 *
 * @param {string} customerId
 * @param {Array<{resourceName: string, label?: string}>} items - keyword criteria
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} Summary with per-item diff
 */
export async function clearKeywordFinalUrls(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Brak słów kluczowych do wyczyszczenia override (pusta lista).');
  }
  const normalized = items.map((it) => ({ resourceName: String(it.resourceName ?? '').trim(), label: it.label }));
  const bad = normalized.filter((n) => !n.resourceName.includes('/adGroupCriteria/'));
  if (bad.length) {
    throw new Error(`🛑 ${bad.length} pozycji nie jest zasobem słowa kluczowego (adGroupCriteria/...), nic nie zapisano:\n${bad.map((b) => `  • ${b.label || b.resourceName}`).join('\n')}`);
  }

  // Read current overrides for a real before→after diff (best-effort).
  let currentMap = new Map();
  try {
    currentMap = await getCurrentFinalUrls(cleanCustomerId, 'keyword', normalized.map((n) => n.resourceName), { loginCustomerId });
  } catch {
    currentMap = new Map();
  }
  const diff = normalized.map((n) => {
    const from = currentMap.get(n.resourceName) || [];
    return { label: n.label, resourceName: n.resourceName, from, to: [], changed: from.length > 0, found: currentMap.has(n.resourceName) };
  });

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Czyszczenie override Final URL dla ${normalized.length} słów (słowo dziedziczy URL reklamy)...`);
  if (dryRun) {
    return { success: true, dryRun: true, entity: 'keyword', count: normalized.length, willClear: diff.filter((d) => d.changed).length, diff };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    // Must go through mutateResources, NOT the `.update()` convenience: the latter
    // builds the field mask via `toObject(..., {defaults:false})`, which DROPS an
    // empty repeated field (`final_urls: []`) → empty mask → the clear is a no-op.
    // mutateResources computes the mask from the raw resource, so `final_urls`
    // stays in the mask and the field is actually cleared.
    const mutations = normalized.map((n) => ({
      entity: 'AdGroupCriterion',
      operation: 'update',
      resource: { resource_name: n.resourceName, final_urls: [] },
    }));
    const response = await customer.mutateResources(mutations);
    return { success: true, dryRun: false, entity: 'keyword', count: normalized.length, cleared: diff.filter((d) => d.changed).length, diff, response };
  } catch (error) {
    throw new Error(`Nie udało się wyczyścić override Final URL: ${unpackError(error)}`);
  }
}

/** Map a sitelink link level to its create/update mutateResources entity name. */
const SITELINK_LINK_ENTITY = { campaign: 'CampaignAsset', ad_group: 'AdGroupAsset', customer: 'CustomerAsset' };

/**
 * Repoint sitelink Final URLs the data-preserving way: assets are (largely)
 * immutable, so instead of editing the URL in place we
 *   1. create a NEW sitelink asset cloning the old one's text/descriptions with
 *      the new Final URL,
 *   2. link that new asset at the same level/parent (ENABLED),
 *   3. set the OLD link to PAUSED — kept, not removed, so its history stays.
 *
 * All of it runs as ONE atomic `mutateResources` call using temporary resource
 * IDs (negative numbers) so the new links can reference the just-created assets.
 * Assets are de-duplicated by (source asset + new URL): one new asset is created
 * even when the same sitelink is linked in many places, then linked N times.
 *
 * @param {string} customerId
 * @param {Array<{linkResourceName: string, finalUrl: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{domain?: string}} [opts]
 * @returns {Promise<object>} Summary with the plan (assets to create, links to add, links to pause)
 */
export async function swapSitelinkFinalUrls(customerId, items, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Brak sitelinków do zmiany URL (pusta lista).');
  }

  // 1. Validate every URL first (fail-safe — nothing half-applies).
  const invalid = [];
  const wanted = items.map((it) => {
    const finalUrl = String(it.finalUrl ?? '').trim();
    const check = validateFinalUrl(finalUrl, { domain: opts.domain });
    if (!check.valid) invalid.push({ ref: it.label || it.linkResourceName, reason: check.reason });
    return { linkResourceName: String(it.linkResourceName ?? '').trim(), finalUrl, label: it.label };
  });
  if (invalid.length) {
    const lines = invalid.map((e) => `  • ${e.ref}: ${e.reason}`).join('\n');
    throw new Error(`🛑 Zablokowano — ${invalid.length} niepoprawny(ch) URL(i), nic nie zapisano:\n${lines}`);
  }

  // 2. Read each link + its source asset (text/descriptions/old URLs/level/parent).
  const detailMap = await getSitelinkLinkDetails(cleanCustomerId, wanted.map((w) => w.linkResourceName), { loginCustomerId });
  const missing = wanted.filter((w) => !detailMap.has(w.linkResourceName)).map((w) => w.label || w.linkResourceName);
  if (missing.length) {
    throw new Error(`🛑 Nie znaleziono ${missing.length} linku(ów) sitelink (błędny resource_name lub usunięty), nic nie zapisano:\n${missing.map((m) => `  • ${m}`).join('\n')}`);
  }

  // 3. De-duplicate the assets to create, keyed by (source asset + new URL).
  const assetPlan = new Map(); // key → {tempId, resourceName, linkText, description1, description2, oldUrls, newUrl}
  const links = wanted.map((w) => {
    const d = detailMap.get(w.linkResourceName);
    const key = `${d.assetResourceName}|${w.finalUrl}`;
    if (!assetPlan.has(key)) {
      assetPlan.set(key, {
        key,
        tempId: -(assetPlan.size + 1),
        linkText: d.linkText,
        description1: d.description1,
        description2: d.description2,
        oldUrls: d.finalUrls,
        hadMobile: (d.finalMobileUrls || []).length > 0,
        newUrl: w.finalUrl,
      });
    }
    return { ...w, level: d.level, parent: d.parent, assetKey: key, linkText: d.linkText, oldUrl: (d.finalUrls || [])[0] || '' };
  });

  const plan = {
    assetsToCreate: [...assetPlan.values()].map((a) => ({ linkText: a.linkText, newUrl: a.newUrl, clonesFromUrl: a.oldUrls[0] || '', hadMobileUrl: a.hadMobile })),
    linksToSwap: links.map((l) => ({ label: l.label, linkText: l.linkText, level: l.level, parent: l.parent, oldUrl: l.oldUrl, newUrl: l.finalUrl, oldLinkPausedKept: l.linkResourceName })),
  };
  if (plan.assetsToCreate.some((a) => a.hadMobileUrl)) {
    plan.warning = 'Część sitelinków miała osobny mobilny Final URL — nowy asset dostaje tylko URL desktop (mobilny NIE jest przenoszony). Zweryfikuj ręcznie, jeśli to istotne.';
  }

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Sitelinki: nowych assetów ${assetPlan.size}, przepięć ${links.length} (stare linki → PAUSED)...`);

  if (dryRun) {
    return { success: true, dryRun: true, entity: 'sitelink', assetsToCreate: assetPlan.size, linksToSwap: links.length, plan };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = [];

    // (a) Create the new assets, addressed by temporary resource IDs.
    for (const a of assetPlan.values()) {
      const sitelink = { link_text: a.linkText };
      if (a.description1) sitelink.description1 = a.description1;
      if (a.description2) sitelink.description2 = a.description2;
      mutations.push({
        entity: 'Asset',
        operation: 'create',
        resource: {
          resource_name: `customers/${cleanCustomerId}/assets/${a.tempId}`,
          final_urls: [a.newUrl],
          sitelink_asset: sitelink,
        },
      });
    }

    // (b) Link each new asset at the same level/parent (ENABLED).
    for (const l of links) {
      const a = assetPlan.get(l.assetKey);
      const assetRef = `customers/${cleanCustomerId}/assets/${a.tempId}`;
      const entity = SITELINK_LINK_ENTITY[l.level];
      const resource = { asset: assetRef, field_type: 'SITELINK', status: 'ENABLED' };
      if (l.level === 'campaign') resource.campaign = l.parent;
      if (l.level === 'ad_group') resource.ad_group = l.parent;
      mutations.push({ entity, operation: 'create', resource });
    }

    // (c) Pause (keep) the old links.
    for (const l of links) {
      mutations.push({
        entity: SITELINK_LINK_ENTITY[l.level],
        operation: 'update',
        resource: { resource_name: l.linkResourceName, status: 'PAUSED' },
      });
    }

    const response = await customer.mutateResources(mutations);
    return { success: true, dryRun: false, entity: 'sitelink', assetsCreated: assetPlan.size, linksSwapped: links.length, plan, response };
  } catch (error) {
    throw new Error(`Nie udało się przepiąć sitelinków: ${unpackError(error)}`);
  }
}

/**
 * Convert standard currency float amount to Google Ads micro amount (multiply by 1,000,000)
 * @param {number} amountStandard 
 * @returns {number} Amount in micros (integer)
 */
export function standardToMicros(amountStandard) {
  if (amountStandard === null || amountStandard === undefined) return 0;
  return Math.round(Number(amountStandard) * 1000000);
}

/**
 * Changes a campaign's status (ENABLED or PAUSED).
 * @param {string} customerId 
 * @param {string|number} campaignId 
 * @param {'ENABLED'|'PAUSED'} status 
 * @param {boolean} [dryRun=false] 
 * @returns {Promise<object>} Status report
 */
export async function updateCampaignStatus(customerId, campaignId, status, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const cleanCampaignId = String(campaignId);
  const resourceName = `customers/${cleanCustomerId}/campaigns/${cleanCampaignId}`;

  // No-delete policy: refuse REMOVED outright (permanent, out of scope).
  assertNotRemoval(status);
  if (!['ENABLED', 'PAUSED'].includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be ENABLED or PAUSED.`);
  }

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Updating campaign ${cleanCampaignId} status to ${status}...`);

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      campaignId: cleanCampaignId,
      status,
      resourceName
    };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const campaign = {
      resource_name: resourceName,
      status: status
    };
    
    const response = await customer.campaigns.update([campaign]);
    return {
      success: true,
      dryRun: false,
      campaignId: cleanCampaignId,
      status,
      response
    };
  } catch (error) {
    throw new Error(`Failed to update campaign status: ${unpackError(error)}`);
  }
}

/**
 * Updates a campaign's daily budget.
 * @param {string} customerId 
 * @param {string|number} budgetId 
 * @param {number} amountStandard - Budget in standard currency (e.g. 50.50)
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{force?: boolean, limitPct?: number}} [opts] - SafetyLimits options.
 *   `force` overrides a blocked change; `limitPct` overrides the default threshold.
 * @returns {Promise<object>} Status report
 */
export async function updateCampaignBudget(customerId, budgetId, amountStandard, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const cleanBudgetId = String(budgetId);
  const amountMicros = standardToMicros(amountStandard);
  const resourceName = `customers/${cleanCustomerId}/campaignBudgets/${cleanBudgetId}`;
  const { force = false, limitPct } = opts;

  // SafetyLimits: read the current budget so we can block runaway jumps before
  // they hit the account. If the read fails, the check treats the baseline as
  // unknown → unsafe → blocked unless --force is passed (fail-safe).
  let currentAmount = null;
  try {
    const current = await getBudgetById(cleanCustomerId, cleanBudgetId, { loginCustomerId });
    currentAmount = current ? (current['campaign_budget.amount'] ?? null) : null;
  } catch {
    currentAmount = null;
  }
  const safety = checkBudgetChange(currentAmount, Number(amountStandard), { limitPct });

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Updating budget ${cleanBudgetId} to ${amountStandard} standard currency (${amountMicros} micros)...`);

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      budgetId: cleanBudgetId,
      amountStandard,
      amountMicros,
      resourceName,
      safety
    };
  }

  if (!safety.safe && !force) {
    throw new Error(
      `🛑 Zablokowano przez SafetyLimits: ${safety.reason} ` +
      `(obecny: ${currentAmount ?? '—'}, nowy: ${amountStandard}). ` +
      `Jeśli to zamierzona zmiana, powtórz z flagą --force.`
    );
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const budget = {
      resource_name: resourceName,
      amount_micros: amountMicros
    };

    const response = await customer.campaignBudgets.update([budget]);
    return {
      success: true,
      dryRun: false,
      budgetId: cleanBudgetId,
      amountStandard,
      amountMicros,
      safety,
      response
    };
  } catch (error) {
    throw new Error(`Failed to update campaign budget: ${unpackError(error)}`);
  }
}

/**
 * Adds negative keywords to a specific campaign.
 * @param {string} customerId 
 * @param {string|number} campaignId 
 * @param {Array<string|object>} keywords - Array of strings (e.g., ['free', 'cheap']) or objects (e.g. [{text: 'spam', matchType: 'PHRASE'}])
 * @param {boolean} [dryRun=false] 
 * @returns {Promise<object>} Mutation summary
 */
export async function addCampaignNegativeKeywords(customerId, campaignId, keywords, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const cleanCampaignId = String(campaignId);
  
  const parsedKeywords = keywords.map(kw => {
    if (typeof kw === 'string') {
      return { text: kw.trim().toLowerCase(), matchType: 'BROAD' };
    }
    return {
      text: String(kw.text || kw.keyword).trim().toLowerCase(),
      matchType: String(kw.matchType || kw.match_type || 'BROAD').toUpperCase()
    };
  }).filter(k => k.text);

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Adding ${parsedKeywords.length} negative keywords to campaign ${cleanCampaignId}...`);

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      campaignId: cleanCampaignId,
      keywordsAdded: parsedKeywords
    };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);

    // In google-ads-api, adding negative keywords at campaign level is done via CampaignCriterion mutation
    const mutations = parsedKeywords.map(kw => ({
      entity: 'CampaignCriterion',
      operation: 'create',
      resource: {
        campaign: `customers/${cleanCustomerId}/campaigns/${cleanCampaignId}`,
        negative: true,
        type: 'KEYWORD',
        keyword: {
          text: kw.text,
          match_type: kw.matchType
        }
      }
    }));

    const response = await customer.mutateResources(mutations);
    return {
      success: true,
      dryRun: false,
      campaignId: cleanCampaignId,
      keywordsAdded: parsedKeywords,
      response
    };
  } catch (error) {
    throw new Error(`Failed to add campaign negative keywords: ${unpackError(error)}`);
  }
}

/**
 * Adds negative placements (domain exclusions) on Account level.
 * @param {string} customerId 
 * @param {Array<string>} domains - E.g. ['spamdomain.com', 'badapps.net']
 * @param {boolean} [dryRun=false] 
 * @returns {Promise<object>} Mutation summary
 */
export async function addAccountNegativePlacements(customerId, domains, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const parsedDomains = domains.map(d => d.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Excluding ${parsedDomains.length} placements on Account level...`);

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      domains: parsedDomains
    };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);

    // Account negative placements are CustomerNegativeCriterion
    const mutations = parsedDomains.map(domain => ({
      entity: 'CustomerNegativeCriterion',
      operation: 'create',
      resource: {
        placement: { url: domain }
      }
    }));

    const response = await customer.mutateResources(mutations);
    return {
      success: true,
      dryRun: false,
      domains: parsedDomains,
      response
    };
  } catch (error) {
    throw new Error(`Failed to add account negative placements: ${unpackError(error)}`);
  }
}

/**
 * Create sitelink assets and link them at customer or campaign level, in ONE
 * atomic `mutateResources` (temp resource IDs). Assets are de-duplicated by
 * (link_text + descriptions + final URL), so a set shared by several campaigns
 * creates one asset linked N times.
 *
 * **Idempotent:** first reads the ENABLED sitelinks already on the account and
 * SKIPS any with the same parent + text + URL — so re-running the same set adds
 * nothing (converges, like every other mutation here) instead of duplicating.
 * Nothing existing is touched — pausing old links is a separate action
 * (`pauseSitelinkLinks`).
 *
 * @param {string} customerId
 * @param {Array<{level: 'customer'|'campaign', campaignId?: string, linkText: string,
 *   description1?: string, description2?: string, finalUrl: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{domain?: string}} [opts]
 * @returns {Promise<object>} Summary: assets to create + links to add
 */
export async function addSitelinks(customerId, items, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak sitelinków do dodania (pusta lista).');

  // Fail-safe validation of every row before any write.
  const problems = [];
  const rows = items.map((it, i) => {
    const ref = it.label || it.linkText || `wiersz ${i + 1}`;
    const level = String(it.level ?? '').trim().toLowerCase();
    if (!['customer', 'campaign'].includes(level)) problems.push(`${ref}: level musi być "customer" lub "campaign" (jest "${it.level}").`);
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    if (level === 'campaign' && !campaignId) problems.push(`${ref}: level=campaign wymaga campaign_id.`);
    const urlCheck = validateFinalUrl(it.finalUrl, { domain: opts.domain });
    if (!urlCheck.valid) problems.push(`${ref}: ${urlCheck.reason}`);
    const textCheck = checkSitelinkTexts({ linkText: it.linkText, description1: it.description1, description2: it.description2 });
    if (!textCheck.valid) textCheck.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    return {
      level, campaignId,
      linkText: String(it.linkText ?? '').trim(),
      description1: String(it.description1 ?? '').trim(),
      description2: String(it.description2 ?? '').trim(),
      finalUrl: String(it.finalUrl ?? '').trim(),
      label: ref,
    };
  });
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  // Converge, don't accumulate: read the ENABLED sitelinks already on the account
  // and skip any with the same parent + text + URL. This makes re-running the same
  // set a no-op (like the other mutations), instead of silently duplicating — same
  // "read reality first" basis as the URL-swap dry-runs. Read runs in dry-run too,
  // so the preview is truthful.
  const norm = (u) => String(u).replace(/\/$/, '');
  const keyOf = (level, campaignId, text, url) =>
    `${level}:${level === 'campaign' ? campaignId : 'acct'}|${text}|${norm(url)}`;
  let existing = new Set();
  try {
    const current = await getExistingSitelinks(cleanCustomerId, { loginCustomerId });
    existing = new Set(current.map((s) => keyOf(s.level, s.campaignId, s.linkText, s.finalUrl)));
  } catch {
    existing = new Set(); // best-effort — a read failure must not block a first-time add
  }
  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    (existing.has(keyOf(r.level, r.campaignId, r.linkText, r.finalUrl)) ? skipped : toCreate).push(r);
  }

  // De-duplicate assets by content (only among links we will actually create).
  const assetPlan = new Map();
  const links = toCreate.map((r) => {
    const key = [r.linkText, r.description1, r.description2, r.finalUrl].join('|');
    if (!assetPlan.has(key)) assetPlan.set(key, { tempId: -(assetPlan.size + 1), ...r });
    return { ...r, assetKey: key };
  });

  const plan = {
    assetsToCreate: [...assetPlan.values()].map((a) => ({ linkText: a.linkText, description1: a.description1, description2: a.description2, finalUrl: a.finalUrl })),
    linksToAdd: links.map((l) => ({ label: l.label, linkText: l.linkText, level: l.level, campaignId: l.campaignId || null, finalUrl: l.finalUrl })),
    skipped: skipped.map((s) => ({ label: s.label, linkText: s.linkText, level: s.level, campaignId: s.campaignId || null, finalUrl: s.finalUrl })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Sitelinki: do utworzenia ${links.length}, pominięte (już istnieją) ${skipped.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'sitelink', assetsToCreate: assetPlan.size, linksToAdd: links.length, skipped: skipped.length, plan };

  // Nothing new to add (everything already exists) → no-op success.
  if (links.length === 0) {
    return { success: true, dryRun: false, entity: 'sitelink', assetsCreated: 0, linksAdded: 0, skipped: skipped.length, plan, response: null };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = [];
    for (const a of assetPlan.values()) {
      const sitelink = { link_text: a.linkText };
      if (a.description1) sitelink.description1 = a.description1;
      if (a.description2) sitelink.description2 = a.description2;
      mutations.push({
        entity: 'Asset',
        operation: 'create',
        resource: {
          resource_name: `customers/${cleanCustomerId}/assets/${a.tempId}`,
          final_urls: [a.finalUrl],
          sitelink_asset: sitelink,
        },
      });
    }
    for (const l of links) {
      const a = assetPlan.get(l.assetKey);
      const assetRef = `customers/${cleanCustomerId}/assets/${a.tempId}`;
      if (l.level === 'campaign') {
        mutations.push({ entity: 'CampaignAsset', operation: 'create', resource: { campaign: `customers/${cleanCustomerId}/campaigns/${l.campaignId}`, asset: assetRef, field_type: 'SITELINK', status: 'ENABLED' } });
      } else {
        mutations.push({ entity: 'CustomerAsset', operation: 'create', resource: { asset: assetRef, field_type: 'SITELINK', status: 'ENABLED' } });
      }
    }
    const response = await customer.mutateResources(mutations);
    return { success: true, dryRun: false, entity: 'sitelink', assetsCreated: assetPlan.size, linksAdded: links.length, skipped: skipped.length, plan, response };
  } catch (error) {
    throw new Error(`Nie udało się dodać sitelinków: ${unpackError(error)}`);
  }
}

/**
 * Pause sitelink LINKS (campaign/ad_group/customer *_asset rows) — the
 * data-preserving retirement: the link and its history stay on the account,
 * the sitelink just stops serving. Refuses resource names it cannot find.
 *
 * @param {string} customerId
 * @param {Array<string>} linkResourceNames - full *_asset resource names
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>}
 */
export async function pauseSitelinkLinks(customerId, linkResourceNames, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const names = [...new Set((linkResourceNames || []).map((n) => String(n).trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('Brak linków sitelink do wstrzymania (pusta lista).');

  const detailMap = await getSitelinkLinkDetails(cleanCustomerId, names, { loginCustomerId });
  const missing = names.filter((n) => !detailMap.has(n));
  if (missing.length) {
    throw new Error(`🛑 Nie znaleziono ${missing.length} linku(ów), nic nie zapisano:\n${missing.map((m) => `  • ${m}`).join('\n')}`);
  }

  const plan = names.map((n) => {
    const d = detailMap.get(n);
    // AssetLinkStatus: 2=ENABLED, 4=PAUSED (3=REMOVED) — accept the string form too.
    return { linkResourceName: n, level: d.level, linkText: d.linkText, url: (d.finalUrls || [])[0] || '', alreadyPaused: d.linkStatus === 4 || d.linkStatus === 'PAUSED' };
  });
  const toPause = plan.filter((p) => !p.alreadyPaused);

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Wstrzymanie ${toPause.length} linków sitelink (${plan.length - toPause.length} już wstrzymanych)...`);
  if (dryRun) return { success: true, dryRun: true, count: toPause.length, alreadyPaused: plan.length - toPause.length, plan };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = toPause.map((p) => ({
      entity: SITELINK_LINK_ENTITY[sitelinkLinkLevel(p.linkResourceName)],
      operation: 'update',
      resource: { resource_name: p.linkResourceName, status: 'PAUSED' },
    }));
    const response = mutations.length ? await customer.mutateResources(mutations) : null;
    return { success: true, dryRun: false, count: toPause.length, alreadyPaused: plan.length - toPause.length, plan, response };
  } catch (error) {
    throw new Error(`Nie udało się wstrzymać sitelinków: ${unpackError(error)}`);
  }
}
