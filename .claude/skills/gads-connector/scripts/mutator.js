import { writeFileSync } from 'node:fs';
import { getCustomer, unpackError } from './client.js';
import { getKeywordsByCriteria, getCampaignBasics, getCampaignBiddingInfo, getBudgetById, getCurrentFinalUrls, getSitelinkLinkDetails, sitelinkLinkLevel, getExistingSitelinks, getAdGroupsByCampaign, getExistingKeywords, getExistingRsa, getExistingCallouts, getExistingStructuredSnippets, getExistingPriceAssets, getExistingPromotions, promotionIdentity, getAdGroupAdsByAdIds, getAdGroupsByIds, getExistingYoutubeAssets, getExistingDemandGenAds, getExistingDemandGenProductAds, getExistingListingGroups, getAssetGroupsByIds, getListingFilterTree, LISTING_FILTER_TYPE_NAME, getAdGroupTargetingCriteria, getCampaignChannelTypes, getCallToActionAssets, getConversionActions, getExistingCampaigns, getBudgetsByName, COPYABLE_CRITERION_TYPES } from './queries.js';
import { checkBudgetChange, assertNotRemoval, validateFinalUrl, checkSitelinkTexts, checkKeywordText, checkAdGroupName, checkRsaTexts, checkCalloutText, checkStructuredSnippet, checkPriceOfferings, checkPromotion, checkDemandGenAdTexts, checkDemandGenChannels, DEMAND_GEN_LIMITS, adTextLength, checkConversionAction, checkCampaignSpec, checkListingFilterFlip, checkLabelExclusion, checkItemExclusion } from './safety.js';

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

  // Google refuses status/budget/date changes on DRAFT and EXPERIMENT ("trial")
  // campaigns. Without this read the dry-run would report success for a write the
  // API always rejects — a false green light is worse than no dry-run at all.
  const basics = await getCampaignBasics(cleanCustomerId, cleanCampaignId, { loginCustomerId });
  if (basics && basics.experimentType && basics.experimentType !== 'BASE') {
    throw new Error(
      `🛑 "${basics.name}" to kampania próbna (${basics.experimentType}) — Google nie pozwala zmieniać jej statusu, budżetu ani dat przez API ` +
      `(CANNOT_MODIFY_FOR_TRIAL_CAMPAIGN). Zakończ lub usuń eksperyment w panelu: Kampanie → Eksperymenty.`
    );
  }

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      campaignId: cleanCampaignId,
      status,
      currentStatus: basics?.status ?? null,
      changed: basics ? basics.status !== status : null,
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
 * Shared guts of the two status mutations below. Reads the current state first so
 * the dry-run can show a real from→to diff, and so a typo'd ID fails loudly
 * instead of silently writing nothing.
 *
 * All-or-nothing, like every other batch action here: if ANY id can't be resolved
 * the whole batch is refused. A half-applied status change across a set of ads is
 * exactly the state that's hard to reason about afterwards.
 *
 * @param {object} cfg
 * @param {string} cfg.label            - human label for messages ('reklam', 'grup reklam')
 * @param {string} cfg.entity           - mutateResources entity ('AdGroupAd', 'AdGroup')
 * @param {string} cfg.idKey            - key naming the id in items/results
 * @param {Function} cfg.lookup         - async (ids) => rows with {resourceName, status, ...}
 * @param {Function} cfg.describe       - row => extra fields for the plan output
 * @param {Function} [cfg.normalizeId]  - id sanitiser; defaults to digits-only. Keywords
 *                                        override it because their id is `adGroupId~criterionId`.
 */
async function applyStatusChange(cfg, customerId, items, dryRun, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const normalizeId = cfg.normalizeId || ((s) => s.replace(/[^0-9]/g, ''));
  const wanted = (items || [])
    .map((it) => ({ id: normalizeId(String(it[cfg.idKey] ?? it.id ?? '')), status: String(it.status ?? '').trim().toUpperCase() }))
    .filter((it) => it.id);
  if (wanted.length === 0) throw new Error(`Brak pozycji do zmiany statusu (pusta lista ${cfg.label}).`);

  // No-delete policy first: never let a status mutation become a deletion.
  for (const it of wanted) {
    assertNotRemoval(it.status);
    if (!['ENABLED', 'PAUSED'].includes(it.status)) {
      throw new Error(`Nieprawidłowy status "${it.status}" dla ${cfg.idKey}=${it.id}. Dozwolone: ENABLED, PAUSED.`);
    }
  }

  const found = await cfg.lookup([...new Set(wanted.map((w) => w.id))], { loginCustomerId });
  const byId = new Map(found.map((r) => [String(r[cfg.idKey]), r]));
  const missing = wanted.filter((w) => !byId.has(w.id)).map((w) => w.id);
  if (missing.length) {
    throw new Error(`🛑 Nie znaleziono ${missing.length} z ${wanted.length} ${cfg.label} (albo są usunięte): ${missing.join(', ')}. Nic nie zmieniono.`);
  }

  const plan = wanted.map((w) => {
    const row = byId.get(w.id);
    return {
      [cfg.idKey]: w.id,
      ...cfg.describe(row),
      from: row.status,
      to: w.status,
      changed: row.status !== w.status,
      resourceName: row.resourceName,
    };
  });
  // A lookup that forgets to return resource_name would otherwise send
  // `resource_name: undefined` to the API — fail here instead, while nothing is written.
  const noResource = plan.filter((p) => !p.resourceName).map((p) => p[cfg.idKey]);
  if (noResource.length) {
    throw new Error(`🛑 Brak resource_name dla ${noResource.length} pozycji (${noResource.join(', ')}) — błąd odczytu w ${cfg.entity}. Nic nie zmieniono.`);
  }

  const toChange = plan.filter((p) => p.changed);

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Zmiana statusu ${cfg.label}: ${toChange.length} do zmiany, ${plan.length - toChange.length} już w docelowym statusie...`);

  if (dryRun) {
    return { success: true, dryRun: true, entity: cfg.entity, toChange: toChange.length, unchanged: plan.length - toChange.length, plan };
  }
  if (toChange.length === 0) {
    return { success: true, dryRun: false, entity: cfg.entity, changed: 0, unchanged: plan.length, plan };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = toChange.map((p) => ({
      entity: cfg.entity,
      operation: 'update',
      resource: { resource_name: p.resourceName, status: p.to },
    }));
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return {
      success: true,
      dryRun: false,
      entity: cfg.entity,
      changed: toChange.length,
      unchanged: plan.length - toChange.length,
      chunks: responses.length,
      plan,
      resourceNames: mutatedResourceNames(responses),
    };
  } catch (error) {
    throw new Error(`Nie udało się zmienić statusu ${cfg.label}: ${unpackError(error)}`);
  }
}

/**
 * Enable / pause ADS by bare ad ID (the id shown in the Google Ads UI).
 *
 * Pausing is the reversible retirement for an ad — the ad and its history stay,
 * it just stops serving. This is also the only way to free a slot when an ad
 * group has hit Google's cap of 3 ENABLED responsive search ads: pause an old
 * creative, then `add-ads` the new one.
 *
 * @param {string} customerId
 * @param {Array<{adId: string|number, status: 'ENABLED'|'PAUSED'}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} Summary with a per-ad from→to plan
 */
export async function updateAdStatus(customerId, items, dryRun = false, loginCustomerId) {
  return applyStatusChange({
    label: 'reklam',
    entity: 'AdGroupAd',
    idKey: 'adId',
    lookup: (ids, opts) => getAdGroupAdsByAdIds(customerId, ids, opts),
    describe: (row) => ({ adGroupId: row.adGroupId, adGroupName: row.adGroupName }),
  }, customerId, items, dryRun, loginCustomerId);
}

/**
 * Enable / pause AD GROUPS by id. Complements `create-ad-groups`, which is
 * idempotent and therefore cannot revive a group that already exists in a paused
 * state — this is how you bring one back.
 *
 * @param {string} customerId
 * @param {Array<{adGroupId: string|number, status: 'ENABLED'|'PAUSED'}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} Summary with a per-group from→to plan
 */
export async function updateAdGroupStatus(customerId, items, dryRun = false, loginCustomerId) {
  return applyStatusChange({
    label: 'grup reklam',
    entity: 'AdGroup',
    idKey: 'adGroupId',
    lookup: (ids, opts) => getAdGroupsByIds(customerId, ids, opts),
    describe: (row) => ({ name: row.name, campaignId: row.campaignId, campaignName: row.campaignName }),
  }, customerId, items, dryRun, loginCustomerId);
}

/**
 * Enable / pause KEYWORDS by their `adGroupId~criterionId` key.
 *
 * The reversible way to retire a keyword — the criterion and its history stay, it
 * just stops matching. Typical use: a broad keyword whose search terms show the
 * spend going to queries you never wanted; pause it and keep the exact variants
 * that actually convert.
 *
 * Caveat worth knowing before you use it: pausing ONE variant of a same-meaning
 * pair (e.g. broad `netia internet` while broad `internet netia` stays enabled)
 * usually just moves the traffic to its sibling rather than stopping it.
 *
 * @param {string} customerId
 * @param {Array<{criterion: string, status: 'ENABLED'|'PAUSED'}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} Summary with a per-keyword from→to plan
 */
export async function updateKeywordStatus(customerId, items, dryRun = false, loginCustomerId) {
  return applyStatusChange({
    label: 'słów kluczowych',
    entity: 'AdGroupCriterion',
    idKey: 'criterion',
    normalizeId: (s) => s.replace(/[^0-9~]/g, ''),
    lookup: (ids, opts) => getKeywordsByCriteria(customerId, ids, opts),
    describe: (row) => ({ text: row.text, matchType: row.matchType, adGroupName: row.adGroupName }),
  }, customerId, items, dryRun, loginCustomerId);
}

/**
 * Enable / pause PMax ASSET GROUPS ("grupy plików") by id.
 *
 * The seasonal switch for a Performance Max account: a group built around a
 * product type that only sells for part of the year is paused out of season and
 * enabled back into it, instead of being rebuilt twice a year.
 *
 * Pausing an asset group stops that group serving; the products inside it keep
 * serving from any other group whose filter still matches them — usually the
 * catch-all "all products" group. So pausing a group narrows which creative and
 * which signals a product runs with, it does not necessarily stop the product.
 *
 * @param {string} customerId
 * @param {Array<{assetGroupId: string|number, status: 'ENABLED'|'PAUSED'}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} Summary with a per-group from→to plan
 */
export async function updateAssetGroupStatus(customerId, items, dryRun = false, loginCustomerId) {
  return applyStatusChange({
    label: 'grup plików (asset groups)',
    entity: 'AssetGroup',
    idKey: 'assetGroupId',
    lookup: (ids, opts) => getAssetGroupsByIds(customerId, ids, opts),
    describe: (row) => ({ name: row.name, campaignId: row.campaignId, campaignName: row.campaignName }),
  }, customerId, items, dryRun, loginCustomerId);
}

/**
 * Renames a campaign.
 *
 * Trivial as a mutation, easy to regret in a report: the name is how a campaign
 * is recognised in every export, dashboard and past screenshot, so this refuses
 * an empty name and reports the old one next to the new so a dry-run reads like
 * a decision rather than a formality. Google requires names to be unique among
 * non-removed campaigns, which is why a clash is checked before sending.
 *
 * @param {string} customerId
 * @param {string|number} campaignId
 * @param {string} newName
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} from→to plan (dry-run) or the mutate response
 */
export async function renameCampaign(customerId, campaignId, newName, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const cleanCampaignId = String(campaignId).replace(/[^0-9]/g, '');
  if (!cleanCampaignId) throw new Error('rename-campaign: brak poprawnego --campaign=<ID>.');
  const name = String(newName ?? '').trim();
  if (!name) throw new Error('rename-campaign: --name nie może być puste.');

  const before = await getCampaignBasics(cleanCustomerId, cleanCampaignId, { loginCustomerId });
  if (!before) throw new Error(`rename-campaign: nie znaleziono kampanii ${cleanCampaignId} na koncie ${cleanCustomerId}.`);
  if (before.name === name) {
    return { success: true, dryRun, campaignId: cleanCampaignId, from: before.name, to: name, unchanged: true };
  }

  // getExistingCampaigns takes (customerId, opts) and returns every ENABLED/PAUSED
  // campaign — there is no name filter, so the match happens here.
  const existing = await getExistingCampaigns(cleanCustomerId, { loginCustomerId });
  const clash = (existing || []).find((c) => c.name.toLowerCase() === name.toLowerCase()
    && c.campaignId !== cleanCampaignId);
  if (clash) {
    throw new Error(`🛑 Nazwa "${name}" jest już zajęta przez inną kampanię na tym koncie — Google wymaga unikalnych nazw.`);
  }

  const plan = { campaignId: cleanCampaignId, from: before.name, to: name, unchanged: false };
  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Renaming campaign ${cleanCampaignId}: "${before.name}" → "${name}"...`);
  if (dryRun) return { success: true, dryRun: true, ...plan };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const response = await customer.campaigns.update([
      { resource_name: `customers/${cleanCustomerId}/campaigns/${cleanCampaignId}`, name },
    ]);
    return { success: true, dryRun: false, ...plan, response };
  } catch (error) {
    throw new Error(`Failed to rename campaign: ${unpackError(error)}`);
  }
}

/** The four strategies this connector can set on a Search campaign. */
export const BIDDING_STRATEGIES = ['MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'MANUAL_CPC'];

/**
 * Writes a bidding strategy onto a campaign resource.
 *
 * These fields are a protobuf `oneof`, so exactly one may be set — which is also
 * why switching a live campaign works at all: setting the new field clears the
 * old one. Shared by `create-campaigns` and `update-bidding` so both speak the
 * same dialect, including the important part: no target given means no target
 * set, and Google is left to learn rather than handed a number we invented.
 *
 * @param {object} campaign - Campaign resource being built (mutated in place).
 * @param {{biddingStrategy: string, cpcBidCeiling?: number|string|null,
 *   targetCpa?: number|string|null, targetRoas?: number|string|null,
 *   enhancedCpc?: boolean}} spec
 * @param {{forUpdate?: boolean}} [opts] - true when the resource goes to campaigns.update()
 * @returns {object} The same campaign resource, for chaining.
 */
export function setBiddingStrategy(campaign, spec, opts = {}) {
  const { forUpdate = false } = opts;
  // CREATE and UPDATE need different shapes for "no target". On create a bare
  // `{}` is fine. On update the client derives the field mask from the object we
  // send, and a mask pointing at a message field that has subfields is rejected
  // with FIELD_HAS_SUBFIELDS — so on update the subfield is named explicitly and
  // set to 0, which is how the API spells "no target".
  const noTarget = (subfield) => (forUpdate ? { [subfield]: 0 } : {});
  const strategy = String(spec.biddingStrategy ?? '').trim().toUpperCase();
  if (strategy === 'MAXIMIZE_CLICKS') {
    campaign.target_spend = spec.cpcBidCeiling
      ? { cpc_bid_ceiling_micros: standardToMicros(spec.cpcBidCeiling) }
      : noTarget('cpc_bid_ceiling_micros');
  } else if (strategy === 'MAXIMIZE_CONVERSIONS') {
    campaign.maximize_conversions = spec.targetCpa
      ? { target_cpa_micros: standardToMicros(spec.targetCpa) }
      : noTarget('target_cpa_micros');
  } else if (strategy === 'MAXIMIZE_CONVERSION_VALUE') {
    campaign.maximize_conversion_value = spec.targetRoas
      ? { target_roas: Number(spec.targetRoas) }
      : noTarget('target_roas');
  } else {
    campaign.manual_cpc = { enhanced_cpc_enabled: spec.enhancedCpc === true };
  }
  return campaign;
}

/**
 * Switches a LIVE campaign to a different bidding strategy.
 *
 * Three things make this less routine than it looks, and each is handled here:
 *
 *  - A campaign attached to a PORTFOLIO (shared) strategy cannot be switched
 *    field-by-field; the portfolio has to be detached first. We refuse with a
 *    plain sentence instead of letting the API return a bare mutate error.
 *  - Dropping a tCPA/tROAS target is a real change of behaviour, not a tidy-up:
 *    Google restarts the learning phase either way. The dry-run says so.
 *  - Experiment/draft campaigns reject the mutation outright, so we check that
 *    before promising anything.
 *
 * @param {string} customerId
 * @param {string|number} campaignId
 * @param {{biddingStrategy: string, targetCpa?: number|null, targetRoas?: number|null,
 *   cpcBidCeiling?: number|null, enhancedCpc?: boolean}} spec
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} from→to plan (dry-run) or the mutate response
 */
export async function updateCampaignBidding(customerId, campaignId, spec, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const cleanCampaignId = String(campaignId).replace(/[^0-9]/g, '');
  if (!cleanCampaignId) throw new Error('update-bidding: brak poprawnego --campaign=<ID>.');

  const strategy = String(spec.biddingStrategy ?? '').trim().toUpperCase();
  if (!BIDDING_STRATEGIES.includes(strategy)) {
    throw new Error(`update-bidding: --strategy musi być jedną z: ${BIDDING_STRATEGIES.join(' | ')} (podano: "${spec.biddingStrategy ?? ''}").`);
  }

  const before = await getCampaignBiddingInfo(cleanCustomerId, cleanCampaignId, { loginCustomerId });
  if (!before) throw new Error(`update-bidding: nie znaleziono kampanii ${cleanCampaignId} na koncie ${cleanCustomerId}.`);
  if (before.portfolio) {
    throw new Error(
      `🛑 Kampania "${before.name}" korzysta ze strategii PORTFOLIO (${before.portfolio}). ` +
      'Google nie pozwala nadpisać jej pojedynczym polem — najpierw odepnij kampanię od strategii współdzielonej w panelu, potem powtórz tę komendę.'
    );
  }
  const basics = await getCampaignBasics(cleanCustomerId, cleanCampaignId, { loginCustomerId });
  if (basics && basics.experimentType && basics.experimentType !== 'BASE') {
    throw new Error(
      `🛑 Kampania "${before.name}" jest typu ${basics.experimentType} (wersja robocza / eksperyment). ` +
      'Google odrzuca zmianę stawek dla takich kampanii (CANNOT_MODIFY_FOR_TRIAL_CAMPAIGN).'
    );
  }

  const campaign = { resource_name: `customers/${cleanCustomerId}/campaigns/${cleanCampaignId}` };
  setBiddingStrategy(campaign, { ...spec, biddingStrategy: strategy }, { forUpdate: true });

  const hadTarget = before.targetCpa !== null || before.targetRoas !== null;
  const wantsTarget = spec.targetCpa != null || spec.targetRoas != null;
  const notes = [];
  if (before.strategyField !== null || hadTarget) {
    notes.push('Zmiana strategii restartuje fazę uczenia — pierwsze dni po przełączeniu nie są miarodajne.');
  }
  if (hadTarget && !wantsTarget) {
    notes.push('Zdejmujesz cel (tCPA/tROAS) — kampania przestanie być nim ograniczana i może zacząć wydawać cały budżet.');
  }

  const plan = {
    campaignId: cleanCampaignId,
    campaignName: before.name,
    from: { strategyField: before.strategyField, targetCpa: before.targetCpa, targetRoas: before.targetRoas },
    to: {
      strategy,
      targetCpa: spec.targetCpa ?? null,
      targetRoas: spec.targetRoas ?? null,
      cpcBidCeiling: spec.cpcBidCeiling ?? null,
    },
    notes,
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Switching campaign ${cleanCampaignId} to ${strategy}...`);
  if (dryRun) return { success: true, dryRun: true, ...plan };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const response = await customer.campaigns.update([campaign]);
    return { success: true, dryRun: false, ...plan, response };
  } catch (error) {
    throw new Error(`Failed to update campaign bidding strategy: ${unpackError(error)}`);
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

    // Idempotent: skip domains already excluded, so re-running a list converges
    // instead of failing on duplicates.
    const existing = new Set();
    try {
      const rows = await customer.query(`
        SELECT customer_negative_criterion.placement.url
        FROM customer_negative_criterion
        WHERE customer_negative_criterion.type = 'PLACEMENT'
      `);
      for (const r of rows) {
        const url = r?.customer_negative_criterion?.placement?.url;
        if (url) existing.add(String(url).toLowerCase().replace(/^www\./, ''));
      }
    } catch {
      // Account with no exclusions yet — treat as empty.
    }
    const toAdd = parsedDomains.filter(d => !existing.has(d));
    const skipped = parsedDomains.filter(d => existing.has(d));
    if (toAdd.length === 0) return { success: true, dryRun: false, domains: [], added: [], skipped };

    // Account negative placements are CustomerNegativeCriterion
    const mutations = toAdd.map(domain => ({
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
      domains: toAdd,
      added: toAdd,
      skipped,
      response
    };
  } catch (error) {
    throw new Error(`Failed to add account negative placements: ${unpackError(error)}`);
  }
}

/**
 * Exclude YouTube CHANNELS at ACCOUNT level (`CustomerNegativeCriterion` with
 * `youtube_channel.channel_id`).
 *
 * Separate action from `addAccountNegativePlacements` because the API field differs:
 * a website exclusion carries `placement.url`, a channel carries a channel id. They
 * cannot be mixed in one resource.
 *
 * Account level is the right default for channels: it covers every campaign at once,
 * including Performance Max and Demand Gen. Campaign-level channel exclusions are a
 * common trap — they keep protecting a campaign long after it was paused, while the
 * campaigns actually spending stay uncovered.
 *
 * **Idempotent:** reads the channels already excluded on the account and SKIPS them,
 * so re-running the same list adds nothing instead of failing on duplicates.
 *
 * @param {string} customerId
 * @param {string[]} channelIds YouTube channel ids (the `UC…` form)
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} Summary: what was added and what was already there
 */
export async function addAccountNegativeYouTubeChannels(customerId, channelIds, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const parsed = [...new Set(
    channelIds.map((c) => String(c).trim()).filter(Boolean)
      // Accept a full channel URL as well — that is what reports hand you.
      .map((c) => (c.includes('/channel/') ? c.split('/channel/')[1].split(/[/?#]/)[0] : c))
  )];
  if (parsed.length === 0) throw new Error('No YouTube channel ids given.');

  const customer = getCustomer(cleanCustomerId, loginCustomerId);

  const existing = new Set();
  try {
    const rows = await customer.query(`
      SELECT customer_negative_criterion.youtube_channel.channel_id
      FROM customer_negative_criterion
      WHERE customer_negative_criterion.type = 'YOUTUBE_CHANNEL'
    `);
    for (const r of rows) {
      const id = r?.customer_negative_criterion?.youtube_channel?.channel_id;
      if (id) existing.add(String(id));
    }
  } catch {
    // An account with no exclusions yet may not expose the resource — treat as empty.
  }

  const toAdd = parsed.filter((c) => !existing.has(c));
  const skipped = parsed.filter((c) => existing.has(c));

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Excluding ${toAdd.length} YouTube channel(s) on Account level${skipped.length ? ` (${skipped.length} already excluded)` : ''}...`);

  if (dryRun || toAdd.length === 0) {
    return { success: true, dryRun, added: toAdd, skipped };
  }

  try {
    const response = await customer.mutateResources(toAdd.map((channelId) => ({
      entity: 'CustomerNegativeCriterion',
      operation: 'create',
      resource: { youtube_channel: { channel_id: channelId } },
    })));
    return { success: true, dryRun: false, added: toAdd, skipped, response };
  } catch (error) {
    throw new Error(`Failed to add account negative YouTube channels: ${unpackError(error)}`);
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
    if (!['customer', 'campaign', 'ad_group'].includes(level)) problems.push(`${ref}: level musi być "customer", "campaign" lub "ad_group" (jest "${it.level}").`);
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    if (level === 'campaign' && !campaignId) problems.push(`${ref}: level=campaign wymaga campaign_id.`);
    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    const adGroupName = String(it.adGroupName ?? '').trim();
    // ad_group: albo gotowe ID, albo campaign_id + nazwa (rozwiązywana niżej) —
    // ta druga droga pozwala napisać plik zanim grupy dostaną ID.
    if (level === 'ad_group' && !adGroupId && !(campaignId && adGroupName)) {
      problems.push(`${ref}: level=ad_group wymaga ad_group_id albo campaign_id + ad_group_name.`);
    }
    const urlCheck = validateFinalUrl(it.finalUrl, { domain: opts.domain });
    if (!urlCheck.valid) problems.push(`${ref}: ${urlCheck.reason}`);
    const textCheck = checkSitelinkTexts({ linkText: it.linkText, description1: it.description1, description2: it.description2 });
    if (!textCheck.valid) textCheck.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    return {
      level, campaignId, adGroupId, adGroupName,
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

  // Resolve ad-group names → IDs, same contract as addKeywords/addAds.
  const needGroup = rows.filter((r) => r.level === 'ad_group' && !r.adGroupId);
  if (needGroup.length) {
    const groups = await getAdGroupsByCampaign(cleanCustomerId, needGroup.map((r) => r.campaignId), { loginCustomerId });
    const byKey = new Map(groups.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g.adGroupId]));
    const unresolved = new Set();
    for (const r of needGroup) {
      const id = byKey.get(`${r.campaignId}|${r.adGroupName.toLowerCase()}`);
      if (id) r.adGroupId = id;
      else unresolved.add(`kampania ${r.campaignId} → grupa "${r.adGroupName}"`);
    }
    if (unresolved.size) {
      throw new Error(`🛑 Nie znaleziono ${unresolved.size} grup(y) reklam, nic nie zapisano:\n${[...unresolved].map((u) => `  • ${u}`).join('\n')}`);
    }
  }

  // Converge, don't accumulate: read the ENABLED sitelinks already on the account
  // and skip any with the same parent + text + URL. This makes re-running the same
  // set a no-op (like the other mutations), instead of silently duplicating — same
  // "read reality first" basis as the URL-swap dry-runs. Read runs in dry-run too,
  // so the preview is truthful.
  const norm = (u) => String(u).replace(/\/$/, '');
  const parentOf = (level, campaignId, adGroupId) =>
    level === 'campaign' ? campaignId : level === 'ad_group' ? adGroupId : 'acct';
  // Idempotencja po PEŁNEJ treści linku, nie po samym tekście i adresie. Zasób
  // sitelinka jest niezmienialny, więc "poprawka" z definicji polega na dodaniu
  // nowego linku i wstrzymaniu starego — a klucz bez opisów pomijał poprawioną
  // wersję jako duplikat i cementował na koncie komponent odrzucony przez Google.
  // Ponowne uruchomienie tego samego pliku nadal nic nie dodaje.
  const keyOf = (level, parent, text, url, d1, d2) => `${level}:${parent}|${text}|${norm(url)}|${d1 || ''}|${d2 || ''}`;
  let existing = new Set();
  try {
    const current = await getExistingSitelinks(cleanCustomerId, { loginCustomerId });
    existing = new Set(current.map((s) => keyOf(s.level, parentOf(s.level, s.campaignId, s.adGroupId), s.linkText, s.finalUrl, s.description1, s.description2)));
  } catch {
    existing = new Set(); // best-effort — a read failure must not block a first-time add
  }
  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    (existing.has(keyOf(r.level, parentOf(r.level, r.campaignId, r.adGroupId), r.linkText, r.finalUrl, r.description1, r.description2)) ? skipped : toCreate).push(r);
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
    linksToAdd: links.map((l) => ({ label: l.label, linkText: l.linkText, level: l.level, campaignId: l.campaignId || null, adGroupId: l.adGroupId || null, adGroupName: l.adGroupName || null, finalUrl: l.finalUrl })),
    skipped: skipped.map((s) => ({ label: s.label, linkText: s.linkText, level: s.level, campaignId: s.campaignId || null, adGroupId: s.adGroupId || null, finalUrl: s.finalUrl })),
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
      } else if (l.level === 'ad_group') {
        mutations.push({ entity: 'AdGroupAsset', operation: 'create', resource: { ad_group: `customers/${cleanCustomerId}/adGroups/${l.adGroupId}`, asset: assetRef, field_type: 'SITELINK', status: 'ENABLED' } });
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

/**
 * Split a mutation list into chunks. `mutateResources` is atomic *per request*,
 * so a set that fits in one chunk applies all-or-nothing. Above the chunk size
 * the batch is split and atomicity holds only within each chunk — the callers
 * below surface `chunks` in the result so a partial apply is visible rather than
 * silent. Validation and the duplicate read both run before any write, so the
 * realistic failure mode here is a transport error, not a bad row.
 */
const MUTATE_CHUNK = 1000;

function chunk(arr, size = MUTATE_CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Reduce raw `mutateResources` responses to just the created resource names.
 *
 * The raw response is a protobuf object tree that `JSON.stringify` can choke on —
 * and the CLI stringifies whatever the mutator returns. A throw there happens
 * AFTER the write has landed, so the operator sees an error for a change that
 * actually succeeded and is tempted to re-run. Returning a plain summary keeps
 * the result printable and is the only part anyone reads anyway.
 */
export function mutatedResourceNames(responses) {
  const names = [];
  for (const res of responses || []) {
    // GoogleAdsService.Mutate answers with `mutate_operation_responses`, one entry
    // per operation, each wrapping a single typed `*_result` (asset_result,
    // campaign_asset_result, ...) that carries the resource name. `results` is the
    // shape of a SEARCH response, not a mutate one — reading it silently yielded an
    // empty list for every write this connector has ever reported.
    const ops = res?.mutate_operation_responses || res?.mutateOperationResponses || res?.results || [];
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      // A bare {resource_name} (a typed service response) or a oneof wrapper.
      const direct = op.resource_name ?? op.resourceName;
      if (direct) { names.push(String(direct)); continue; }
      for (const value of Object.values(op)) {
        const rn = value && typeof value === 'object' ? (value.resource_name ?? value.resourceName) : null;
        if (rn) { names.push(String(rn)); break; }
      }
    }
  }
  return names;
}

/**
 * Create Search campaigns — each with its own daily budget — on an account.
 *
 * This is the missing first step of a build-out: `create-ad-groups`,
 * `add-keywords` and `add-ads` all need a campaign to hang off, and until now
 * that shell had to be clicked together in the UI. Deliberately limited to
 * SEARCH: everything else this connector builds (SEARCH_STANDARD ad groups,
 * keywords, RSAs) only makes sense there, and a half-supported Shopping or PMax
 * campaign would be worse than none — under the no-delete policy a wrong
 * campaign can only be paused, never taken back.
 *
 * **Born paused by default.** `status` defaults to PAUSED, because a campaign
 * created ENABLED starts spending the second the write lands, before anyone has
 * seen a keyword or an ad in it. Passing ENABLED works, and the plan warns.
 *
 * Idempotent on the campaign NAME (case-insensitively, ENABLED or PAUSED): a
 * re-run of the same file adds nothing. The idempotency read MUST succeed — a
 * duplicated campaign is not recoverable by re-running, unlike a skip.
 *
 * The budget is reused when one with the same name already exists, rather than
 * minting a second budget with an identical name. A different amount on that
 * existing budget is reported as a warning, never silently rewritten — that is
 * `update-budget`'s job, where the 40% SafetyLimit lives.
 *
 * Budget + campaign + geo/language criteria go out as ONE atomic
 * `mutateResources` per run, wired together with temporary resource names, so a
 * failure can't leave an orphan budget or a campaign targeting the whole world.
 *
 * @param {string} customerId
 * @param {Array<object>} items - rows: {name, budgetAmount, budgetName?, status?,
 *        biddingStrategy?, cpcBidCeiling?, targetCpa?, targetRoas?, enhancedCpc?,
 *        geoTargets?, languages?, searchPartners?, contentNetwork?, geoTargetType?,
 *        startDate?, endDate?, label?}
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>}
 */
export async function createSearchCampaigns(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak kampanii do utworzenia (pusta lista).');

  const problems = [];
  const warnings = [];
  const rows = items.map((it, i) => {
    const name = String(it.name ?? '').trim();
    const ref = it.label || name || `wiersz ${i + 1}`;
    const status = String(it.status ?? 'PAUSED').trim().toUpperCase();
    assertNotRemoval(status);
    const row = {
      label: ref,
      name,
      budgetName: String(it.budgetName ?? '').trim() || name,
      budgetAmount: it.budgetAmount,
      status,
      biddingStrategy: String(it.biddingStrategy ?? 'MAXIMIZE_CLICKS').trim().toUpperCase(),
      cpcBidCeiling: it.cpcBidCeiling === '' ? null : it.cpcBidCeiling ?? null,
      targetCpa: it.targetCpa === '' ? null : it.targetCpa ?? null,
      targetRoas: it.targetRoas === '' ? null : it.targetRoas ?? null,
      enhancedCpc: it.enhancedCpc === true || String(it.enhancedCpc ?? '').toLowerCase() === 'true',
      geoTargets: normaliseIdList(it.geoTargets, ['2616']),
      languages: normaliseIdList(it.languages, ['1030']),
      searchPartners: it.searchPartners === true || String(it.searchPartners ?? '').toLowerCase() === 'true',
      contentNetwork: it.contentNetwork === true || String(it.contentNetwork ?? '').toLowerCase() === 'true',
      geoTargetType: String(it.geoTargetType ?? 'PRESENCE').trim().toUpperCase(),
      euPoliticalAdvertising: String(it.euPoliticalAdvertising ?? 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING').trim().toUpperCase(),
      startDate: String(it.startDate ?? '').trim() || null,
      endDate: String(it.endDate ?? '').trim() || null,
    };
    const check = checkCampaignSpec(row);
    check.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    check.warnings.forEach((w) => warnings.push(`${ref}: ${w}`));
    return row;
  });

  // Two rows creating the same campaign name would both pass the "already on the
  // account" check and then collide with each other inside one batch.
  const seenInFile = new Set();
  for (const r of rows) {
    const k = r.name.toLowerCase();
    if (seenInFile.has(k)) problems.push(`${r.label}: nazwa kampanii powtarza się w pliku wejściowym.`);
    seenInFile.add(k);
  }

  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  // Converge, don't accumulate. A read failure MUST block here: a duplicate
  // campaign cannot be undone, only paused.
  const existingCampaigns = await getExistingCampaigns(cleanCustomerId, { loginCustomerId });
  const byName = new Map(existingCampaigns.map((c) => [c.name.toLowerCase(), c]));
  const existingBudgets = await getBudgetsByName(cleanCustomerId, { loginCustomerId });

  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    const hit = byName.get(r.name.toLowerCase());
    if (hit) { skipped.push({ ...r, campaignId: hit.campaignId }); continue; }
    const budget = existingBudgets.get(r.budgetName.toLowerCase()) || null;
    if (budget && budget.amount != null && Number(budget.amount) !== Number(r.budgetAmount)) {
      warnings.push(`${r.label}: budżet "${r.budgetName}" już istnieje z kwotą ${budget.amount} (żądano ${r.budgetAmount}) — użyję istniejącego, kwoty nie zmieniam. Zmiana kwoty → update-budget.`);
    }
    toCreate.push({ ...r, reuseBudget: budget });
  }

  const plan = {
    toCreate: toCreate.map((r) => ({
      name: r.name,
      status: r.status,
      budgetName: r.budgetName,
      budgetDaily: Number(r.budgetAmount),
      budgetMonthlyApprox: r.reuseBudget ? Number(r.reuseBudget.amount) * 30.4 : Math.round(Number(r.budgetAmount) * 30.4 * 100) / 100,
      budgetReused: r.reuseBudget ? { budgetId: r.reuseBudget.budgetId, amount: r.reuseBudget.amount } : null,
      biddingStrategy: r.biddingStrategy,
      cpcBidCeiling: r.cpcBidCeiling ? Number(r.cpcBidCeiling) : null,
      targetCpa: r.targetCpa ? Number(r.targetCpa) : null,
      targetRoas: r.targetRoas ? Number(r.targetRoas) : null,
      networks: { googleSearch: true, searchPartners: r.searchPartners, contentNetwork: r.contentNetwork },
      geoTargets: r.geoTargets,
      geoTargetType: r.geoTargetType,
      languages: r.languages,
      euPoliticalAdvertising: r.euPoliticalAdvertising,
      startDate: r.startDate,
      endDate: r.endDate,
    })),
    skipped: skipped.map((r) => ({ name: r.name, campaignId: r.campaignId, reason: 'kampania o tej nazwie już jest na koncie' })),
    warnings,
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Kampanie Search: do utworzenia ${toCreate.length}, pominięte (już istnieją) ${skipped.length}...`);

  if (toCreate.length === 0) {
    if (dryRun) return { success: true, dryRun: true, entity: 'campaign', toCreate: 0, skipped: skipped.length, plan };
    return { success: true, dryRun: false, entity: 'campaign', created: 0, skipped: skipped.length, plan, createdCampaigns: [], response: null };
  }

  // Build the batch once — the same mutations are used for the API validation in
  // a dry run and for the write, so what Google approves is what gets sent.
  let tempId = 0;
  const nextTemp = () => --tempId;
  const mutations = [];
  for (const r of toCreate) {
    let budgetRef;
    if (r.reuseBudget) {
      budgetRef = `customers/${cleanCustomerId}/campaignBudgets/${r.reuseBudget.budgetId}`;
    } else {
      budgetRef = `customers/${cleanCustomerId}/campaignBudgets/${nextTemp()}`;
      mutations.push({
        entity: 'CampaignBudget',
        operation: 'create',
        resource: {
          resource_name: budgetRef,
          name: r.budgetName,
          amount_micros: standardToMicros(r.budgetAmount),
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      });
    }

    const campaignRef = `customers/${cleanCustomerId}/campaigns/${nextTemp()}`;
    const campaign = {
      resource_name: campaignRef,
      name: r.name,
      status: r.status,
      advertising_channel_type: 'SEARCH',
      campaign_budget: budgetRef,
      network_settings: {
        target_google_search: true,
        target_search_network: r.searchPartners,
        target_content_network: r.contentNetwork,
        target_partner_search_network: false,
      },
      geo_target_type_setting: {
        positive_geo_target_type: r.geoTargetType,
        negative_geo_target_type: 'PRESENCE',
      },
      // Required by Google on every new campaign in the EU (Reg. 2024/900).
      // Omitting it fails the whole batch with a bare "required field" error.
      contains_eu_political_advertising: r.euPoliticalAdvertising,
    };
    if (r.startDate) campaign.start_date = r.startDate;
    if (r.endDate) campaign.end_date = r.endDate;

    setBiddingStrategy(campaign, r);
    mutations.push({ entity: 'Campaign', operation: 'create', resource: campaign });

    for (const geo of r.geoTargets) {
      mutations.push({
        entity: 'CampaignCriterion',
        operation: 'create',
        resource: { campaign: campaignRef, location: { geo_target_constant: `geoTargetConstants/${geo}` } },
      });
    }
    for (const lang of r.languages) {
      mutations.push({
        entity: 'CampaignCriterion',
        operation: 'create',
        resource: { campaign: campaignRef, language: { language_constant: `languageConstants/${lang}` } },
      });
    }
  }

  const customer = getCustomer(cleanCustomerId, loginCustomerId);

  // A locally-valid plan only proves the CSV parsed. Ask Google whether the whole
  // tree — budget, oneof strategy, criteria on a temporary campaign — is
  // acceptable, so objections surface in the simulation, not half-way through a
  // commit.
  if (dryRun) {
    const check = await validateWithApi(customer, chunk(mutations));
    return { success: check.ok, dryRun: true, entity: 'campaign', toCreate: toCreate.length, skipped: skipped.length, plan, apiValidated: check.ok, apiError: check.error };
  }

  try {
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));

    // Read back so the caller gets real campaign IDs to hang ad groups on.
    const after = await getExistingCampaigns(cleanCustomerId, { loginCustomerId });
    const afterByName = new Map(after.map((c) => [c.name.toLowerCase(), c]));
    const createdCampaigns = toCreate.map((r) => {
      const c = afterByName.get(r.name.toLowerCase());
      return { name: r.name, campaignId: c ? c.campaignId : null, budgetId: c ? c.budgetId : null, status: r.status };
    });

    return { success: true, dryRun: false, entity: 'campaign', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, createdCampaigns, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się utworzyć kampanii: ${unpackError(error)}`);
  }
}

/**
 * Normalise a list of numeric constant IDs given as an array, or as a string
 * separated by `|`, `,` or whitespace. Falls back to `fallback` when empty, which
 * is what makes `geo_targets` / `languages` optional columns in the CSV.
 */
function normaliseIdList(value, fallback) {
  if (value == null || value === '') return [...fallback];
  const raw = Array.isArray(value) ? value : String(value).split(/[|,\s]+/);
  const out = raw.map((v) => String(v).trim()).filter(Boolean);
  return out.length ? [...new Set(out)] : [...fallback];
}

/**
 * Create Search ad groups in existing campaigns.
 *
 * Idempotent: reads the ad groups already in the target campaigns first and
 * skips any whose name is taken (case-insensitively). Re-running the same file
 * is a no-op instead of an "duplicate ad group name" API error. Paused groups
 * count as existing — a re-run must not resurrect what was deliberately paused.
 *
 * Bids are deliberately not settable here: the campaigns this connector targets
 * run Smart Bidding (tROAS / tCPA), where an ad-group CPC bid is ignored. Setting
 * one would create a number in the UI that does nothing.
 *
 * @param {string} customerId
 * @param {Array<{campaignId: string|number, name: string, status?: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} `{plan, toCreate, skipped, ...}` — in dry-run the plan only.
 */
export async function createAdGroups(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak grup reklam do utworzenia (pusta lista).');

  // Fail-safe validation of every row before any write.
  const problems = [];
  const rows = items.map((it, i) => {
    const name = String(it.name ?? '').trim();
    const ref = it.label || name || `wiersz ${i + 1}`;
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    if (!campaignId) problems.push(`${ref}: brak campaign_id.`);
    const nameCheck = checkAdGroupName(name);
    if (!nameCheck.valid) nameCheck.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    const status = String(it.status ?? 'ENABLED').trim().toUpperCase();
    assertNotRemoval(status);
    if (!['ENABLED', 'PAUSED'].includes(status)) problems.push(`${ref}: status musi być ENABLED lub PAUSED (jest "${it.status}").`);
    return { campaignId, name, status, label: ref };
  });

  // Duplicate names inside the input file itself would pass the "already on the
  // account" check and then collide with each other in one batch.
  const seenInFile = new Set();
  for (const r of rows) {
    const k = `${r.campaignId}|${r.name.toLowerCase()}`;
    if (seenInFile.has(k)) problems.push(`${r.label}: nazwa powtarza się w pliku wejściowym.`);
    seenInFile.add(k);
  }

  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  // Converge, don't accumulate. A read failure here MUST block: creating a
  // duplicate ad group is not recoverable by re-running (unlike a skip).
  const existingRows = await getAdGroupsByCampaign(cleanCustomerId, rows.map((r) => r.campaignId), { loginCustomerId });
  const existing = new Map(existingRows.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g]));

  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    const hit = existing.get(`${r.campaignId}|${r.name.toLowerCase()}`);
    if (hit) skipped.push({ ...r, adGroupId: hit.adGroupId });
    else toCreate.push(r);
  }

  const plan = {
    toCreate: toCreate.map((r) => ({ campaignId: r.campaignId, name: r.name, status: r.status })),
    skipped: skipped.map((r) => ({ campaignId: r.campaignId, name: r.name, adGroupId: r.adGroupId, reason: 'grupa o tej nazwie już istnieje w kampanii' })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Grupy reklam: do utworzenia ${toCreate.length}, pominięte (już istnieją) ${skipped.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'ad_group', toCreate: toCreate.length, skipped: skipped.length, plan };

  if (toCreate.length === 0) {
    return { success: true, dryRun: false, entity: 'ad_group', created: 0, skipped: skipped.length, plan, createdGroups: [], response: null };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = toCreate.map((r) => ({
      entity: 'AdGroup',
      operation: 'create',
      resource: {
        campaign: `customers/${cleanCustomerId}/campaigns/${r.campaignId}`,
        name: r.name,
        status: r.status,
        type: 'SEARCH_STANDARD',
      },
    }));
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));

    // Read back so the caller gets real ad group IDs to hang keywords on.
    const after = await getAdGroupsByCampaign(cleanCustomerId, rows.map((r) => r.campaignId), { loginCustomerId });
    const byKey = new Map(after.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g]));
    const createdGroups = toCreate.map((r) => {
      const g = byKey.get(`${r.campaignId}|${r.name.toLowerCase()}`);
      return { campaignId: r.campaignId, name: r.name, adGroupId: g ? g.adGroupId : null };
    });

    return { success: true, dryRun: false, entity: 'ad_group', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, createdGroups, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się utworzyć grup reklam: ${unpackError(error)}`);
  }
}

/**
 * Add POSITIVE keywords to existing ad groups.
 *
 * Ad groups can be addressed either by `adGroupId` or by `campaignId` +
 * `adGroupName` — the latter is what makes a hand-written keyword file usable
 * straight after `create-ad-groups`, before anyone knows the new IDs. Unresolved
 * names block the whole batch rather than silently dropping rows.
 *
 * Idempotent: reads the keywords already in the target ad groups and skips any
 * (text + match type) pair that is present, so a re-run is a no-op instead of a
 * "duplicate keyword" error.
 *
 * `finalUrl` is the optional keyword-level Final URL override; leave it empty and
 * the keyword inherits the URL from the ad, which is what you normally want.
 *
 * @param {string} customerId
 * @param {Array<{adGroupId?: string|number, campaignId?: string|number, adGroupName?: string,
 *                text: string, matchType: string, finalUrl?: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{domain?: string}} [opts] - domain lock for keyword-level Final URLs
 * @returns {Promise<object>}
 */
export async function addKeywords(customerId, items, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak słów kluczowych do dodania (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const text = String(it.text ?? '').trim();
    const ref = it.label || text || `wiersz ${i + 1}`;
    const matchType = String(it.matchType ?? '').trim().toUpperCase();
    const kwCheck = checkKeywordText(text, matchType);
    if (!kwCheck.valid) kwCheck.reasons.forEach((r) => problems.push(`${ref}: ${r}`));

    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    const adGroupName = String(it.adGroupName ?? '').trim();
    if (!adGroupId && !(campaignId && adGroupName)) {
      problems.push(`${ref}: podaj ad_group_id albo campaign_id + ad_group_name.`);
    }

    const finalUrl = String(it.finalUrl ?? '').trim();
    if (finalUrl) {
      const urlCheck = validateFinalUrl(finalUrl, { domain: opts.domain });
      if (!urlCheck.valid) problems.push(`${ref}: ${urlCheck.reason}`);
    }
    return { adGroupId, campaignId, adGroupName, text, matchType, finalUrl, label: ref };
  });
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  // Resolve campaign_id + ad_group_name → adGroupId.
  const needLookup = rows.filter((r) => !r.adGroupId);
  if (needLookup.length) {
    const groups = await getAdGroupsByCampaign(cleanCustomerId, needLookup.map((r) => r.campaignId), { loginCustomerId });
    const byKey = new Map(groups.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g.adGroupId]));
    const unresolved = new Set();
    for (const r of needLookup) {
      const id = byKey.get(`${r.campaignId}|${r.adGroupName.toLowerCase()}`);
      if (id) r.adGroupId = id;
      else unresolved.add(`kampania ${r.campaignId} → grupa "${r.adGroupName}"`);
    }
    if (unresolved.size) {
      throw new Error(`🛑 Nie znaleziono ${unresolved.size} grup(y) reklam, nic nie zapisano:\n${[...unresolved].map((u) => `  • ${u}`).join('\n')}\nUtwórz je najpierw akcją create-ad-groups.`);
    }
  }

  // Converge: skip what already sits in the ad group, and collapse duplicates
  // inside the input file (Google rejects both cases).
  const existingRows = await getExistingKeywords(cleanCustomerId, rows.map((r) => r.adGroupId), { loginCustomerId });
  const keyOf = (adGroupId, text, matchType) => `${adGroupId}|${String(text).toLowerCase()}|${matchType}`;
  const existing = new Set(existingRows.map((k) => keyOf(k.adGroupId, k.text, k.matchType)));

  const toCreate = [];
  const skipped = [];
  const seenInFile = new Set();
  for (const r of rows) {
    const k = keyOf(r.adGroupId, r.text, r.matchType);
    if (existing.has(k)) { skipped.push({ ...r, reason: 'już jest w grupie' }); continue; }
    if (seenInFile.has(k)) { skipped.push({ ...r, reason: 'duplikat w pliku wejściowym' }); continue; }
    seenInFile.add(k);
    toCreate.push(r);
  }

  const byGroup = {};
  for (const r of toCreate) byGroup[r.adGroupId] = (byGroup[r.adGroupId] || 0) + 1;
  const plan = {
    perAdGroup: Object.entries(byGroup).map(([adGroupId, count]) => ({ adGroupId, count })),
    toCreate: toCreate.map((r) => ({ adGroupId: r.adGroupId, text: r.text, matchType: r.matchType, finalUrl: r.finalUrl || null })),
    skipped: skipped.map((r) => ({ adGroupId: r.adGroupId, text: r.text, matchType: r.matchType, reason: r.reason })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Słowa kluczowe: do dodania ${toCreate.length}, pominięte ${skipped.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'keyword', toCreate: toCreate.length, skipped: skipped.length, adGroups: Object.keys(byGroup).length, plan };

  if (toCreate.length === 0) {
    return { success: true, dryRun: false, entity: 'keyword', created: 0, skipped: skipped.length, plan, response: null };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = toCreate.map((r) => {
      const resource = {
        ad_group: `customers/${cleanCustomerId}/adGroups/${r.adGroupId}`,
        status: 'ENABLED',
        keyword: { text: r.text, match_type: r.matchType },
      };
      if (r.finalUrl) resource.final_urls = [r.finalUrl];
      return { entity: 'AdGroupCriterion', operation: 'create', resource };
    });
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'keyword', created: toCreate.length, skipped: skipped.length, adGroups: Object.keys(byGroup).length, chunks: responses.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się dodać słów kluczowych: ${unpackError(error)}`);
  }
}

/**
 * Split an optional pin marker off a headline: `"Krówki z logo|H1"` → pinned to
 * position 1. Without a marker the headline rotates freely, which is the default
 * Google prefers. The marker is stripped before validation, so it never counts
 * toward the 30-character limit.
 */
const PIN_FIELDS = {
  H1: 'HEADLINE_1', H2: 'HEADLINE_2', H3: 'HEADLINE_3',
  D1: 'DESCRIPTION_1', D2: 'DESCRIPTION_2',
};
function splitAssetPin(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(.*?)\s*\|\s*(H[123]|D[12])$/i);
  return m ? { text: m[1].trim(), pin: PIN_FIELDS[m[2].toUpperCase()] } : { text: s, pin: null };
}

/**
 * Add Responsive Search Ads to existing ad groups.
 *
 * Ad groups are addressed by `adGroupId` or by `campaignId` + `adGroupName`, same
 * as `addKeywords` — so an ad file can be written before the groups exist.
 *
 * An asset may carry a pin marker: `"tekst|H1"` locks a headline to position 1,
 * 2 or 3, `"tekst|D1"` locks a description to position 1 or 2. Pins are ignored
 * by the content signature below, so an ad differing only in pinning counts as
 * already present.
 *
 * Idempotent by CONTENT, not by name: an ad is skipped when the target group
 * already holds an RSA with the same headline set, description set and Final URL.
 * Order is ignored (Google serves assets in its own order, so two ads differing
 * only in asset order are the same ad in practice). This matters more here than
 * for keywords — Google happily accepts a second, identical RSA in one ad group
 * and would silently split traffic between two copies of the same creative.
 *
 * @param {string} customerId
 * @param {Array<{adGroupId?: string|number, campaignId?: string|number, adGroupName?: string,
 *                headlines: string[], descriptions: string[], finalUrl: string,
 *                path1?: string, path2?: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{domain?: string}} [opts]
 * @returns {Promise<object>}
 */
export async function addAds(customerId, items, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak reklam do dodania (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const ref = it.label || it.adGroupName || `wiersz ${i + 1}`;
    const headlineAssets = (it.headlines || []).map(splitAssetPin).filter((h) => h.text);
    const headlines = headlineAssets.map((h) => h.text);
    const descriptionAssets = (it.descriptions || []).map(splitAssetPin).filter((d) => d.text);
    const descriptions = descriptionAssets.map((d) => d.text);
    const rsa = checkRsaTexts({ headlines, descriptions, path1: it.path1, path2: it.path2 });
    if (!rsa.valid) rsa.reasons.forEach((r) => problems.push(`${ref}: ${r}`));

    const finalUrl = String(it.finalUrl ?? '').trim();
    const urlCheck = validateFinalUrl(finalUrl, { domain: opts.domain });
    if (!urlCheck.valid) problems.push(`${ref}: ${urlCheck.reason}`);

    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    const adGroupName = String(it.adGroupName ?? '').trim();
    if (!adGroupId && !(campaignId && adGroupName)) problems.push(`${ref}: podaj ad_group_id albo campaign_id + ad_group_name.`);

    return { adGroupId, campaignId, adGroupName, headlines, headlineAssets, descriptions, descriptionAssets, finalUrl,
             path1: String(it.path1 ?? '').trim(), path2: String(it.path2 ?? '').trim(), label: ref };
  });
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const needLookup = rows.filter((r) => !r.adGroupId);
  if (needLookup.length) {
    const groups = await getAdGroupsByCampaign(cleanCustomerId, needLookup.map((r) => r.campaignId), { loginCustomerId });
    const byKey = new Map(groups.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g.adGroupId]));
    const unresolved = new Set();
    for (const r of needLookup) {
      const id = byKey.get(`${r.campaignId}|${r.adGroupName.toLowerCase()}`);
      if (id) r.adGroupId = id;
      else unresolved.add(`kampania ${r.campaignId} → grupa "${r.adGroupName}"`);
    }
    if (unresolved.size) {
      throw new Error(`🛑 Nie znaleziono ${unresolved.size} grup(y) reklam, nic nie zapisano:\n${[...unresolved].map((u) => `  • ${u}`).join('\n')}\nUtwórz je najpierw akcją create-ad-groups.`);
    }
  }

  // Content signature: order-insensitive, so an ad differing only in asset order
  // counts as already present.
  const sig = (adGroupId, hs, ds, url) => [
    adGroupId,
    [...hs].map((x) => x.toLowerCase()).sort().join('|'),
    [...ds].map((x) => x.toLowerCase()).sort().join('|'),
    String(url).replace(/\/$/, ''),
  ].join('##');

  const existingRows = await getExistingRsa(cleanCustomerId, rows.map((r) => r.adGroupId), { loginCustomerId });
  const existing = new Set(existingRows.map((a) => sig(a.adGroupId, a.headlines, a.descriptions, (a.finalUrls || [])[0] || '')));

  const toCreate = [];
  const skipped = [];
  const seenInFile = new Set();
  for (const r of rows) {
    const k = sig(r.adGroupId, r.headlines, r.descriptions, r.finalUrl);
    if (existing.has(k)) { skipped.push({ ...r, reason: 'identyczna reklama już jest w grupie' }); continue; }
    if (seenInFile.has(k)) { skipped.push({ ...r, reason: 'duplikat w pliku wejściowym' }); continue; }
    seenInFile.add(k);
    toCreate.push(r);
  }

  const plan = {
    toCreate: toCreate.map((r) => ({ adGroupId: r.adGroupId, adGroupName: r.adGroupName || null,
      headlines: r.headlines.length, descriptions: r.descriptions.length, finalUrl: r.finalUrl,
      firstHeadline: r.headlines[0] })),
    skipped: skipped.map((r) => ({ adGroupId: r.adGroupId, adGroupName: r.adGroupName || null, reason: r.reason })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Reklamy RSA: do utworzenia ${toCreate.length}, pominięte ${skipped.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'rsa', toCreate: toCreate.length, skipped: skipped.length, plan };

  if (toCreate.length === 0) {
    return { success: true, dryRun: false, entity: 'rsa', created: 0, skipped: skipped.length, plan, resourceNames: [] };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = toCreate.map((r) => {
      const rsa = {
        headlines: r.headlineAssets.map((h) => (h.pin ? { text: h.text, pinned_field: h.pin } : { text: h.text })),
        descriptions: r.descriptionAssets.map((d) => (d.pin ? { text: d.text, pinned_field: d.pin } : { text: d.text })),
      };
      if (r.path1) rsa.path1 = r.path1;
      if (r.path2) rsa.path2 = r.path2;
      return {
        entity: 'AdGroupAd',
        operation: 'create',
        resource: {
          ad_group: `customers/${cleanCustomerId}/adGroups/${r.adGroupId}`,
          status: 'ENABLED',
          ad: { final_urls: [r.finalUrl], responsive_search_ad: rsa },
        },
      };
    });
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'rsa', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się dodać reklam RSA: ${unpackError(error)}`);
  }
}

/**
 * Replace the headline / description assets of an RSA that already exists in an
 * ad group. Keeps the ad ID — so nothing is paused, nothing is duplicated and the
 * ad's history (such as it is) survives. This is the honest way to fix copy: the
 * alternative under the no-delete policy would be pausing the old ad and adding a
 * new one, which leaves paused clutter in the account forever.
 *
 * Refuses an ad group holding MORE than one RSA: which ad to rewrite would be a
 * guess, and guessing wrong overwrites the wrong creative. Disambiguate by
 * passing `adId` explicitly.
 *
 * `--dry-run` reads the current assets and returns a real before→after diff
 * (added / removed per ad), and marks ads whose content already matches as
 * `changed: false` — so re-running is a visible no-op.
 *
 * @param {string} customerId
 * @param {Array<{adId?: string|number, adGroupId?: string|number, campaignId?: string|number,
 *                adGroupName?: string, headlines: string[], descriptions: string[],
 *                path1?: string, path2?: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>}
 */
export async function updateAdAssets(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak reklam do aktualizacji (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const ref = it.label || it.adGroupName || `wiersz ${i + 1}`;
    const headlineAssets = (it.headlines || []).map(splitAssetPin).filter((h) => h.text);
    const headlines = headlineAssets.map((h) => h.text);
    const descriptionAssets = (it.descriptions || []).map(splitAssetPin).filter((d) => d.text);
    const descriptions = descriptionAssets.map((d) => d.text);
    const rsa = checkRsaTexts({ headlines, descriptions, path1: it.path1, path2: it.path2 });
    if (!rsa.valid) rsa.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    const adId = String(it.adId ?? '').replace(/[^0-9]/g, '');
    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    const adGroupName = String(it.adGroupName ?? '').trim();
    if (!adId && !adGroupId && !(campaignId && adGroupName)) {
      problems.push(`${ref}: podaj ad_id, ad_group_id albo campaign_id + ad_group_name.`);
    }
    return { adId, adGroupId, campaignId, adGroupName, headlines, headlineAssets, descriptions, descriptionAssets,
             path1: String(it.path1 ?? '').trim(), path2: String(it.path2 ?? '').trim(), label: ref };
  });
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const needGroup = rows.filter((r) => !r.adId && !r.adGroupId);
  if (needGroup.length) {
    const groups = await getAdGroupsByCampaign(cleanCustomerId, needGroup.map((r) => r.campaignId), { loginCustomerId });
    const byKey = new Map(groups.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g.adGroupId]));
    const unresolved = new Set();
    for (const r of needGroup) {
      const id = byKey.get(`${r.campaignId}|${r.adGroupName.toLowerCase()}`);
      if (id) r.adGroupId = id;
      else unresolved.add(`kampania ${r.campaignId} → grupa "${r.adGroupName}"`);
    }
    if (unresolved.size) {
      throw new Error(`🛑 Nie znaleziono ${unresolved.size} grup(y) reklam, nic nie zapisano:\n${[...unresolved].map((u) => `  • ${u}`).join('\n')}`);
    }
  }

  // Resolve ad group → the single RSA inside it.
  const existing = await getExistingRsa(cleanCustomerId, rows.filter((r) => !r.adId).map((r) => r.adGroupId), { loginCustomerId });
  const byGroup = new Map();
  for (const a of existing) {
    if (!byGroup.has(a.adGroupId)) byGroup.set(a.adGroupId, []);
    byGroup.get(a.adGroupId).push(a);
  }
  const resolveProblems = [];
  for (const r of rows) {
    if (r.adId) { r.resourceName = `customers/${cleanCustomerId}/ads/${r.adId}`; continue; }
    const ads = byGroup.get(r.adGroupId) || [];
    if (ads.length === 0) resolveProblems.push(`${r.label}: grupa ${r.adGroupId} nie ma reklamy RSA do aktualizacji.`);
    else if (ads.length > 1) resolveProblems.push(`${r.label}: grupa ${r.adGroupId} ma ${ads.length} reklam RSA — wskaż konkretną przez ad_id.`);
    else { r.adId = ads[0].adId; r.resourceName = ads[0].adResourceName; r.current = ads[0]; }
  }
  if (resolveProblems.length) {
    throw new Error(`🛑 Nie da się jednoznacznie wskazać reklamy, nic nie zapisano:\n${resolveProblems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const norm = (a) => [...a].map((x) => x.toLowerCase()).sort().join('|');
  const diff = rows.map((r) => {
    const cur = r.current || { headlines: [], descriptions: [] };
    const changed = norm(cur.headlines) !== norm(r.headlines) || norm(cur.descriptions) !== norm(r.descriptions);
    const lower = (a) => new Set(a.map((x) => x.toLowerCase()));
    const curH = lower(cur.headlines), newH = lower(r.headlines);
    const curD = lower(cur.descriptions), newD = lower(r.descriptions);
    return {
      label: r.label, adId: r.adId, changed,
      headlinesBefore: cur.headlines.length, headlinesAfter: r.headlines.length,
      descriptionsBefore: cur.descriptions.length, descriptionsAfter: r.descriptions.length,
      headlinesRemoved: cur.headlines.filter((x) => !newH.has(x.toLowerCase())),
      headlinesAdded: r.headlines.filter((x) => !curH.has(x.toLowerCase())),
      descriptionsRemoved: cur.descriptions.filter((x) => !newD.has(x.toLowerCase())),
      descriptionsAdded: r.descriptions.filter((x) => !curD.has(x.toLowerCase())),
    };
  });
  const toUpdate = rows.filter((r, i) => diff[i].changed);

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Assety RSA: do podmiany ${toUpdate.length}, bez zmian ${rows.length - toUpdate.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'rsa_assets', toUpdate: toUpdate.length, unchanged: rows.length - toUpdate.length, diff };

  if (toUpdate.length === 0) {
    return { success: true, dryRun: false, entity: 'rsa_assets', updated: 0, unchanged: rows.length, diff, resourceNames: [] };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = toUpdate.map((r) => {
      const rsa = {
        headlines: r.headlineAssets.map((h) => (h.pin ? { text: h.text, pinned_field: h.pin } : { text: h.text })),
        descriptions: r.descriptionAssets.map((d) => (d.pin ? { text: d.text, pinned_field: d.pin } : { text: d.text })),
      };
      if (r.path1) rsa.path1 = r.path1;
      if (r.path2) rsa.path2 = r.path2;
      return { entity: 'Ad', operation: 'update', resource: { resource_name: r.resourceName, responsive_search_ad: rsa } };
    });
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'rsa_assets', updated: toUpdate.length, unchanged: rows.length - toUpdate.length, chunks: responses.length, diff, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się podmienić assetów RSA: ${unpackError(error)}`);
  }
}

/**
 * Add CALLOUT assets ("objaśnienia") at account, campaign or ad-group level.
 *
 * Callout assets are immutable like sitelinks — you cannot edit the text of an
 * existing one. Changing a callout therefore means: create the new one, pause
 * the old one (`pause-callouts` / the UI). That is why a stale callout such as
 * "Rabaty do -40%" has to be replaced rather than corrected in place.
 *
 * Idempotent: skips a callout whose text already exists at the same parent
 * (ENABLED or PAUSED), so a re-run adds nothing and does not resurrect something
 * that was deliberately paused.
 *
 * @param {string} customerId
 * @param {Array<{level: 'customer'|'campaign'|'ad_group', campaignId?: string|number,
 *                adGroupId?: string|number, adGroupName?: string, text: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>}
 */
export async function addCallouts(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak objaśnień do dodania (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const text = String(it.text ?? '').trim();
    const ref = it.label || text || `wiersz ${i + 1}`;
    const check = checkCalloutText(text);
    if (!check.valid) check.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    const level = String(it.level ?? '').trim().toLowerCase();
    if (!['customer', 'campaign', 'ad_group'].includes(level)) problems.push(`${ref}: level musi być "customer", "campaign" lub "ad_group".`);
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    const adGroupName = String(it.adGroupName ?? '').trim();
    if (level === 'campaign' && !campaignId) problems.push(`${ref}: level=campaign wymaga campaign_id.`);
    if (level === 'ad_group' && !adGroupId && !(campaignId && adGroupName)) problems.push(`${ref}: level=ad_group wymaga ad_group_id albo campaign_id + ad_group_name.`);
    return { level, campaignId, adGroupId, adGroupName, text, label: ref };
  });
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const needGroup = rows.filter((r) => r.level === 'ad_group' && !r.adGroupId);
  if (needGroup.length) {
    const groups = await getAdGroupsByCampaign(cleanCustomerId, needGroup.map((r) => r.campaignId), { loginCustomerId });
    const byKey = new Map(groups.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g.adGroupId]));
    const unresolved = new Set();
    for (const r of needGroup) {
      const id = byKey.get(`${r.campaignId}|${r.adGroupName.toLowerCase()}`);
      if (id) r.adGroupId = id; else unresolved.add(`kampania ${r.campaignId} → grupa "${r.adGroupName}"`);
    }
    if (unresolved.size) throw new Error(`🛑 Nie znaleziono ${unresolved.size} grup(y) reklam, nic nie zapisano:\n${[...unresolved].map((u) => `  • ${u}`).join('\n')}`);
  }

  const parentOf = (r) => r.level === 'campaign' ? r.campaignId : r.level === 'ad_group' ? r.adGroupId : 'acct';
  const keyOf = (level, parent, text) => `${level}:${parent}|${String(text).toLowerCase()}`;
  let existing = new Set();
  try {
    const current = await getExistingCallouts(cleanCustomerId, { loginCustomerId });
    existing = new Set(current.map((c) => keyOf(c.level, c.level === 'campaign' ? c.campaignId : c.level === 'ad_group' ? c.adGroupId : 'acct', c.text)));
  } catch {
    existing = new Set();
  }

  const toCreate = [];
  const skipped = [];
  const seenInFile = new Set();
  for (const r of rows) {
    const k = keyOf(r.level, parentOf(r), r.text);
    if (existing.has(k)) { skipped.push({ ...r, reason: 'takie objaśnienie już jest na tym poziomie' }); continue; }
    if (seenInFile.has(k)) { skipped.push({ ...r, reason: 'duplikat w pliku wejściowym' }); continue; }
    seenInFile.add(k);
    toCreate.push(r);
  }

  const plan = {
    toCreate: toCreate.map((r) => ({ level: r.level, parent: parentOf(r), text: r.text })),
    skipped: skipped.map((r) => ({ level: r.level, parent: parentOf(r), text: r.text, reason: r.reason })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Objaśnienia: do utworzenia ${toCreate.length}, pominięte ${skipped.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'callout', toCreate: toCreate.length, skipped: skipped.length, plan };
  if (toCreate.length === 0) return { success: true, dryRun: false, entity: 'callout', created: 0, skipped: skipped.length, plan, resourceNames: [] };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = [];
    toCreate.forEach((r, i) => {
      const tempId = -(i + 1);
      const assetRef = `customers/${cleanCustomerId}/assets/${tempId}`;
      mutations.push({ entity: 'Asset', operation: 'create', resource: { resource_name: assetRef, callout_asset: { callout_text: r.text } } });
      const link = { asset: assetRef, field_type: 'CALLOUT', status: 'ENABLED' };
      if (r.level === 'campaign') mutations.push({ entity: 'CampaignAsset', operation: 'create', resource: { ...link, campaign: `customers/${cleanCustomerId}/campaigns/${r.campaignId}` } });
      else if (r.level === 'ad_group') mutations.push({ entity: 'AdGroupAsset', operation: 'create', resource: { ...link, ad_group: `customers/${cleanCustomerId}/adGroups/${r.adGroupId}` } });
      else mutations.push({ entity: 'CustomerAsset', operation: 'create', resource: link });
    });
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'callout', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się dodać objaśnień: ${unpackError(error)}`);
  }
}

/**
 * Pause CALLOUT links (customer/campaign/ad-group `*_asset` rows). Same
 * data-preserving retirement as `pause-sitelinks`: the link and its history stay,
 * the callout just stops serving. Pairing `add-callouts` + `pause-callouts` is
 * how you "edit" an immutable callout.
 *
 * @param {string} customerId
 * @param {Array<string>} linkResourceNames
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 */
export async function pauseCallouts(customerId, linkResourceNames, dryRun = false, loginCustomerId) {
  return pauseAssetLinks(customerId, linkResourceNames, dryRun, loginCustomerId, { entity: 'callout', label: 'objaśnień' });
}

/**
 * Set the status of ANY asset link by its `*_asset` resource name — callouts,
 * structured snippets, price extensions, promotions, images. Retiring or
 * bringing back an asset is the same operation whatever the asset is: flip the
 * LINK and leave the asset itself alone. The link and its history stay.
 *
 * PAUSED is also the answer to "delete this extension": the connector never
 * removes, and a paused link does not serve, so the visible effect is identical
 * and the change is reversible — which is what ENABLED is for. An immutable
 * asset (callout, promotion) that swings back to a previous version is swapped
 * by re-enabling the old link, not by creating a copy of an asset the account
 * already holds.
 *
 * @param {string} customerId
 * @param {Array<string>} linkResourceNames
 * @param {'ENABLED'|'PAUSED'} status
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{entity?: string, label?: string}} [opts]
 */
export async function setAssetLinkStatus(customerId, linkResourceNames, status, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const entity = opts.entity || 'asset';
  const label = opts.label || 'rozszerzeń';
  const target = String(status ?? '').trim().toUpperCase();
  if (!['ENABLED', 'PAUSED'].includes(target)) throw new Error(`Nieprawidłowy status "${status}". Dozwolone: ENABLED, PAUSED.`);
  const verb = target === 'PAUSED' ? 'Wstrzymanie' : 'Włączenie';
  const verbPast = target === 'PAUSED' ? 'wstrzymać' : 'włączyć';
  const names = [...new Set((linkResourceNames || []).map((n) => String(n).trim()).filter(Boolean))];
  if (names.length === 0) throw new Error(`Brak ${label} do zmiany statusu (pusta lista).`);
  const bad = names.filter((n) => !/\/(campaignAssets|adGroupAssets|customerAssets)\//.test(n));
  if (bad.length) throw new Error(`🛑 ${bad.length} pozycji nie jest linkiem zasobu (campaignAssets/adGroupAssets/customerAssets):\n${bad.map((b) => `  • ${b}`).join('\n')}`);

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}${verb} ${names.length} ${label}...`);
  if (dryRun) return { success: true, dryRun: true, entity, status: target, count: names.length, plan: names };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = names.map((n) => ({
      entity: SITELINK_LINK_ENTITY[sitelinkLinkLevel(n)],
      operation: 'update',
      resource: { resource_name: n, status: target },
    }));
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity, status: target, count: names.length, chunks: responses.length, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się ${verbPast} ${label}: ${unpackError(error)}`);
  }
}

/**
 * Pause asset links — the common case, kept as its own name so every existing
 * caller (and every `pause-*` action) reads the same as before.
 *
 * @param {string} customerId
 * @param {Array<string>} linkResourceNames
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{entity?: string, label?: string}} [opts]
 */
export async function pauseAssetLinks(customerId, linkResourceNames, dryRun = false, loginCustomerId, opts = {}) {
  return setAssetLinkStatus(customerId, linkResourceNames, 'PAUSED', dryRun, loginCustomerId, opts);
}

/**
 * Resolve the level / parent of asset-link rows and validate that combination.
 * Every `add-*` extension action addresses its target the same way — account,
 * campaign id, or ad group (by id, or by campaign + name) — so the checking and
 * the name→id lookup live here once.
 *
 * Mutates `rows` in place (fills `adGroupId`) and pushes any complaint onto
 * `problems`, matching the "collect everything, then refuse the whole batch"
 * contract the other mutators use.
 *
 * @param {string} cleanCustomerId
 * @param {Array<object>} rows
 * @param {string[]} problems
 * @param {string} [loginCustomerId]
 */
async function resolveAssetLinkTargets(cleanCustomerId, rows, problems, loginCustomerId) {
  for (const r of rows) {
    if (!['customer', 'campaign', 'ad_group'].includes(r.level)) problems.push(`${r.label}: level musi być "customer", "campaign" lub "ad_group".`);
    if (r.level === 'campaign' && !r.campaignId) problems.push(`${r.label}: level=campaign wymaga campaign_id.`);
    if (r.level === 'ad_group' && !r.adGroupId && !(r.campaignId && r.adGroupName)) problems.push(`${r.label}: level=ad_group wymaga ad_group_id albo campaign_id + ad_group_name.`);
  }
  if (problems.length) return;

  const needGroup = rows.filter((r) => r.level === 'ad_group' && !r.adGroupId);
  if (!needGroup.length) return;
  const groups = await getAdGroupsByCampaign(cleanCustomerId, needGroup.map((r) => r.campaignId), { loginCustomerId });
  const byKey = new Map(groups.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g.adGroupId]));
  const unresolved = new Set();
  for (const r of needGroup) {
    const id = byKey.get(`${r.campaignId}|${r.adGroupName.toLowerCase()}`);
    if (id) r.adGroupId = id; else unresolved.add(`kampania ${r.campaignId} → grupa "${r.adGroupName}"`);
  }
  if (unresolved.size) throw new Error(`🛑 Nie znaleziono ${unresolved.size} grup(y) reklam, nic nie zapisano:\n${[...unresolved].map((u) => `  • ${u}`).join('\n')}`);
}

/** Build the level-appropriate link mutation for a freshly created asset. */
function assetLinkMutation(cleanCustomerId, row, assetRef, fieldType) {
  const link = { asset: assetRef, field_type: fieldType, status: 'ENABLED' };
  if (row.level === 'campaign') return { entity: 'CampaignAsset', operation: 'create', resource: { ...link, campaign: `customers/${cleanCustomerId}/campaigns/${row.campaignId}` } };
  if (row.level === 'ad_group') return { entity: 'AdGroupAsset', operation: 'create', resource: { ...link, ad_group: `customers/${cleanCustomerId}/adGroups/${row.adGroupId}` } };
  return { entity: 'CustomerAsset', operation: 'create', resource: link };
}

/**
 * Add STRUCTURED SNIPPET assets ("fragmenty strukturalne") at account, campaign
 * or ad-group level.
 *
 * Snippet assets are immutable like callouts and sitelinks — changing a value
 * means creating a new asset and pausing the old link (`pause-assets`).
 *
 * Idempotent by HEADER per parent: a campaign that already has a "Typy" block
 * (ENABLED or PAUSED) is skipped, so a re-run neither duplicates nor resurrects
 * something deliberately paused. Change the values by pausing and re-adding.
 *
 * The header must be a header Google supports for the account language — Polish
 * accounts use "Typy", "Usługi", "Marki", "Style", "Modele" and so on. A wrong
 * header comes back as an API error, because the supported list is
 * language-specific and changes.
 *
 * @param {string} customerId
 * @param {Array<{level: 'customer'|'campaign'|'ad_group', campaignId?: string|number,
 *                adGroupId?: string|number, adGroupName?: string,
 *                header: string, values: string[], label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>}
 */
export async function addStructuredSnippets(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak fragmentów do dodania (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const header = String(it.header ?? '').trim();
    const values = (it.values || []).map((v) => String(v ?? '').trim()).filter(Boolean);
    const ref = it.label || header || `wiersz ${i + 1}`;
    const check = checkStructuredSnippet({ header, values });
    if (!check.valid) check.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    return {
      level: String(it.level ?? '').trim().toLowerCase(),
      campaignId: String(it.campaignId ?? '').replace(/[^0-9]/g, ''),
      adGroupId: String(it.adGroupId ?? '').replace(/[^0-9]/g, ''),
      adGroupName: String(it.adGroupName ?? '').trim(),
      header, values, label: ref,
    };
  });
  await resolveAssetLinkTargets(cleanCustomerId, rows, problems, loginCustomerId);
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const parentOf = (r) => r.level === 'campaign' ? r.campaignId : r.level === 'ad_group' ? r.adGroupId : 'acct';
  const keyOf = (r) => `${r.level}:${parentOf(r)}|${r.header.toLowerCase()}`;
  let existing = new Set();
  try {
    const current = await getExistingStructuredSnippets(cleanCustomerId, { loginCustomerId });
    existing = new Set(current.map((c) => `${c.level}:${c.level === 'campaign' ? c.campaignId : c.level === 'ad_group' ? c.adGroupId : 'acct'}|${c.identity}`));
  } catch { existing = new Set(); }

  const toCreate = [];
  const skipped = [];
  const seenInFile = new Set();
  for (const r of rows) {
    const k = keyOf(r);
    if (existing.has(k)) { skipped.push({ ...r, reason: 'fragment z tym nagłówkiem już jest na tym poziomie' }); continue; }
    if (seenInFile.has(k)) { skipped.push({ ...r, reason: 'duplikat w pliku wejściowym' }); continue; }
    seenInFile.add(k);
    toCreate.push(r);
  }

  const plan = {
    toCreate: toCreate.map((r) => ({ level: r.level, parent: parentOf(r), header: r.header, values: r.values })),
    skipped: skipped.map((r) => ({ level: r.level, parent: parentOf(r), header: r.header, reason: r.reason })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Fragmenty strukturalne: do utworzenia ${toCreate.length}, pominięte ${skipped.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'structured_snippet', toCreate: toCreate.length, skipped: skipped.length, plan };
  if (toCreate.length === 0) return { success: true, dryRun: false, entity: 'structured_snippet', created: 0, skipped: skipped.length, plan, resourceNames: [] };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = [];
    toCreate.forEach((r, i) => {
      const assetRef = `customers/${cleanCustomerId}/assets/${-(i + 1)}`;
      mutations.push({ entity: 'Asset', operation: 'create', resource: { resource_name: assetRef, structured_snippet_asset: { header: r.header, values: r.values } } });
      mutations.push(assetLinkMutation(cleanCustomerId, r, assetRef, 'STRUCTURED_SNIPPET'));
    });
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'structured_snippet', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się dodać fragmentów strukturalnych: ${unpackError(error)}`);
  }
}

/**
 * Add PRICE assets ("rozszerzenia cenowe") at account, campaign or ad-group level.
 *
 * One item = one price extension carrying 3–8 offerings. Prices are given in
 * STANDARD currency (71.00), never micros — the conversion happens here, same
 * contract as `update-budget`.
 *
 * Idempotent by price TYPE per parent (PRODUCT_TIERS, SERVICES, …): Google serves
 * one price extension per level, so a second of the same type is almost always a
 * mistake and is skipped.
 *
 * Every offering's Final URL is validated, and with `opts.domain` must stay on
 * that host — one bad URL refuses the whole batch, so nothing half-applies.
 *
 * @param {string} customerId
 * @param {Array<{level: 'customer'|'campaign'|'ad_group', campaignId?: string|number,
 *                adGroupId?: string|number, adGroupName?: string,
 *                priceType?: string, priceQualifier?: string, language?: string, unit?: string,
 *                currency?: string, label?: string,
 *                offerings: Array<{header: string, description: string, price: number|string,
 *                                  finalUrl: string, unit?: string, currency?: string}>}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{domain?: string}} [opts]
 * @returns {Promise<object>}
 */
export async function addPriceAssets(customerId, items, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak cenników do dodania (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const ref = it.label || `cennik ${i + 1}`;
    const offerings = (it.offerings || []).map((o) => ({
      header: String(o.header ?? '').trim(),
      description: String(o.description ?? '').trim(),
      price: Number(String(o.price ?? '').replace(',', '.')),
      currency: String(o.currency || it.currency || 'PLN').trim().toUpperCase(),
      unit: String(o.unit || it.unit || '').trim().toUpperCase(),
      finalUrl: String(o.finalUrl ?? '').trim(),
    }));
    const check = checkPriceOfferings(offerings);
    if (!check.valid) check.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    for (const o of offerings) {
      const urlCheck = validateFinalUrl(o.finalUrl, { domain: opts.domain });
      if (!urlCheck.valid) problems.push(`${ref} / "${o.header}": ${urlCheck.reason}`);
    }
    return {
      level: String(it.level ?? '').trim().toLowerCase(),
      campaignId: String(it.campaignId ?? '').replace(/[^0-9]/g, ''),
      adGroupId: String(it.adGroupId ?? '').replace(/[^0-9]/g, ''),
      adGroupName: String(it.adGroupName ?? '').trim(),
      priceType: String(it.priceType || 'PRODUCT_TIERS').trim().toUpperCase(),
      priceQualifier: String(it.priceQualifier || 'FROM').trim().toUpperCase(),
      language: String(it.language || 'pl').trim(),
      offerings, label: ref,
    };
  });
  await resolveAssetLinkTargets(cleanCustomerId, rows, problems, loginCustomerId);
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const parentOf = (r) => r.level === 'campaign' ? r.campaignId : r.level === 'ad_group' ? r.adGroupId : 'acct';
  // Only an ENABLED price extension blocks a new one: Google serves one per level,
  // so a live duplicate is a real conflict — but a PAUSED one is exactly what you
  // retire before adding its replacement, and must not stand in the way.
  let existing = new Set();
  try {
    const current = await getExistingPriceAssets(cleanCustomerId, { loginCustomerId });
    existing = new Set(current
      .filter((c) => c.status === 'ENABLED')
      .map((c) => `${c.level}:${c.level === 'campaign' ? c.campaignId : c.level === 'ad_group' ? c.adGroupId : 'acct'}|${c.identity}`));
  } catch { existing = new Set(); }

  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    // The API reports the type as an enum number; compare on both spellings so a
    // pre-existing PRODUCT_TIERS block is recognised either way.
    const keys = [`${r.level}:${parentOf(r)}|${r.priceType}`, `${r.level}:${parentOf(r)}|${PRICE_TYPE_ENUM[r.priceType] ?? ''}`];
    if (keys.some((k) => existing.has(k))) { skipped.push({ ...r, reason: `aktywny cennik typu ${r.priceType} już jest na tym poziomie — najpierw wstrzymaj stary (pause-assets)` }); continue; }
    toCreate.push(r);
  }

  const plan = {
    toCreate: toCreate.map((r) => ({ level: r.level, parent: parentOf(r), priceType: r.priceType, priceQualifier: r.priceQualifier,
      offerings: r.offerings.map((o) => `${o.header} — ${o.price.toFixed(2)} ${o.currency} → ${o.finalUrl}`) })),
    skipped: skipped.map((r) => ({ level: r.level, parent: parentOf(r), priceType: r.priceType, reason: r.reason })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Cenniki: do utworzenia ${toCreate.length}, pominięte ${skipped.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'price', toCreate: toCreate.length, skipped: skipped.length, plan };
  if (toCreate.length === 0) return { success: true, dryRun: false, entity: 'price', created: 0, skipped: skipped.length, plan, resourceNames: [] };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = [];
    toCreate.forEach((r, i) => {
      const assetRef = `customers/${cleanCustomerId}/assets/${-(i + 1)}`;
      const priceAsset = {
        type: r.priceType,
        price_qualifier: r.priceQualifier,
        language_code: r.language,
        price_offerings: r.offerings.map((o) => {
          const offering = {
            header: o.header,
            description: o.description,
            price: { currency_code: o.currency, amount_micros: Math.round(o.price * 1_000_000) },
            final_url: o.finalUrl,
          };
          if (o.unit) offering.unit = o.unit;
          return offering;
        }),
      };
      mutations.push({ entity: 'Asset', operation: 'create', resource: { resource_name: assetRef, price_asset: priceAsset } });
      mutations.push(assetLinkMutation(cleanCustomerId, r, assetRef, 'PRICE'));
    });
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'price', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się dodać cenników: ${unpackError(error)}`);
  }
}

/**
 * Create PROMOTION assets and link them at account / campaign / ad-group level in
 * ONE `mutateResources` call, so an asset never lands without its link.
 *
 * A promotion asset is what puts "7 € de descuento" under a text ad. It is NOT the
 * same thing as a Merchant Center promotion: this one decorates ads, the Merchant
 * one decorates free listings and Shopping. An account that wants both needs both.
 *
 * **Idempotent:** reads the promotions already linked (ENABLED or PAUSED) and skips
 * a row whose target + discount already exists at that level, so re-running a CSV
 * converges instead of stacking duplicates.
 *
 * Promotion assets are immutable, like callouts: to change one, add the replacement
 * and retire the old link with `pause-assets`.
 *
 * @param {string} customerId
 * @param {Array<{level: string, campaignId?: string, adGroupId?: string, adGroupName?: string,
 *                promotionTarget: string, percentOff?: number, moneyAmountOff?: number,
 *                currency?: string, ordersOverAmount?: number, discountModifier?: string,
 *                occasion?: string, language?: string, finalUrl?: string,
 *                startDate?: string, endDate?: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{domain?: string}} [opts]
 */
export async function addPromotionAssets(customerId, items, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak promocji do dodania (pusta lista).');

  const num = (v) => (v === undefined || v === null || String(v).trim() === '' ? undefined : Number(String(v).replace(',', '.')));
  const problems = [];
  const rows = items.map((it, i) => {
    const promotionTarget = String(it.promotionTarget ?? '').trim();
    const ref = it.label || promotionTarget || `wiersz ${i + 1}`;
    const r = {
      level: String(it.level ?? '').trim().toLowerCase(),
      campaignId: String(it.campaignId ?? '').replace(/[^0-9]/g, ''),
      adGroupId: String(it.adGroupId ?? '').replace(/[^0-9]/g, ''),
      adGroupName: String(it.adGroupName ?? '').trim(),
      promotionTarget,
      percentOff: num(it.percentOff),
      moneyAmountOff: num(it.moneyAmountOff),
      currency: String(it.currency ?? '').trim().toUpperCase(),
      ordersOverAmount: num(it.ordersOverAmount),
      discountModifier: String(it.discountModifier ?? '').trim().toUpperCase(),
      occasion: String(it.occasion ?? '').trim().toUpperCase(),
      language: String(it.language || 'pl').trim(),
      finalUrl: String(it.finalUrl ?? '').trim(),
      startDate: String(it.startDate ?? '').trim(),
      endDate: String(it.endDate ?? '').trim(),
      label: ref,
    };
    const check = checkPromotion(r);
    if (!check.valid) check.reasons.forEach((m) => problems.push(`${ref}: ${m}`));
    // Every promotion asset carries a Final URL (the API refuses one without it),
    // and it must survive the same domain check as every other URL we write.
    if (r.finalUrl) {
      const urlCheck = validateFinalUrl(r.finalUrl, { domain: opts.domain });
      if (!urlCheck.valid) problems.push(`${ref}: ${urlCheck.reason}`);
    }
    if ((r.startDate && !r.endDate) || (!r.startDate && r.endDate)) problems.push(`${ref}: podaj obie daty (start_date i end_date) albo żadnej.`);
    return r;
  });
  await resolveAssetLinkTargets(cleanCustomerId, rows, problems, loginCustomerId);
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((m) => `  • ${m}`).join('\n')}`);
  }

  const parentOf = (r) => r.level === 'campaign' ? r.campaignId : r.level === 'ad_group' ? r.adGroupId : 'acct';
  const identityOf = (r) => promotionIdentity(
    r.promotionTarget,
    r.percentOff ? Math.round(r.percentOff * 1_000_000) : null,
    r.moneyAmountOff ? Math.round(r.moneyAmountOff * 1_000_000) : null,
    r.currency,
    r.ordersOverAmount ? Math.round(r.ordersOverAmount * 1_000_000) : null);
  const keyOf = (r) => `${r.level}:${parentOf(r)}|${identityOf(r)}`;

  let existing = new Set();
  try {
    const current = await getExistingPromotions(cleanCustomerId, { loginCustomerId });
    existing = new Set(current.map((c) => `${c.level}:${c.level === 'campaign' ? c.campaignId : c.level === 'ad_group' ? c.adGroupId : 'acct'}|${c.identity}`));
  } catch { existing = new Set(); }

  const toCreate = [];
  const skipped = [];
  const seenInFile = new Set();
  for (const r of rows) {
    const k = keyOf(r);
    if (existing.has(k)) { skipped.push({ ...r, reason: 'taka promocja już jest na tym poziomie' }); continue; }
    if (seenInFile.has(k)) { skipped.push({ ...r, reason: 'duplikat w pliku wejściowym' }); continue; }
    seenInFile.add(k);
    toCreate.push(r);
  }

  const describe = (r) => `${r.promotionTarget}: ${r.moneyAmountOff ? `${r.moneyAmountOff} ${r.currency}` : `${r.percentOff}%`}`
    + `${r.ordersOverAmount ? ` przy zamówieniu od ${r.ordersOverAmount} ${r.currency}` : ''} [${r.language}]`;
  const plan = {
    toCreate: toCreate.map((r) => ({ level: r.level, parent: parentOf(r), promocja: describe(r), finalUrl: r.finalUrl || null, okres: r.startDate ? `${r.startDate}..${r.endDate}` : 'bez dat (do odwołania)' })),
    skipped: skipped.map((r) => ({ level: r.level, parent: parentOf(r), promocja: describe(r), reason: r.reason })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Promocje: do utworzenia ${toCreate.length}, pominięte ${skipped.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'promotion', toCreate: toCreate.length, skipped: skipped.length, plan };
  if (toCreate.length === 0) return { success: true, dryRun: false, entity: 'promotion', created: 0, skipped: skipped.length, plan, resourceNames: [] };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = [];
    toCreate.forEach((r, i) => {
      const assetRef = `customers/${cleanCustomerId}/assets/${-(i + 1)}`;
      const promo = { promotion_target: r.promotionTarget, language_code: r.language };
      if (r.percentOff) promo.percent_off = Math.round(r.percentOff * 1_000_000);
      else promo.money_amount_off = { currency_code: r.currency, amount_micros: Math.round(r.moneyAmountOff * 1_000_000) };
      if (r.ordersOverAmount) promo.orders_over_amount = { currency_code: r.currency, amount_micros: Math.round(r.ordersOverAmount * 1_000_000) };
      if (r.discountModifier) promo.discount_modifier = r.discountModifier;
      if (r.occasion) promo.occasion = r.occasion;
      if (r.startDate) { promo.start_date = r.startDate; promo.end_date = r.endDate; }
      mutations.push({ entity: 'Asset', operation: 'create', resource: { resource_name: assetRef, promotion_asset: promo, final_urls: [r.finalUrl] } });
      mutations.push(assetLinkMutation(cleanCustomerId, r, assetRef, 'PROMOTION'));
    });
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'promotion', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się dodać promocji: ${unpackError(error)}`);
  }
}

/** PriceExtensionType name → enum number, for comparing against what the API returns. */
const PRICE_TYPE_ENUM = { BRANDS: 2, EVENTS: 3, LOCATIONS: 4, NEIGHBORHOODS: 5, PRODUCT_CATEGORIES: 6, PRODUCT_TIERS: 7, SERVICES: 8, SERVICE_CATEGORIES: 9, SERVICE_TIERS: 10 };

/* ────────────────────────────────────────────────────────────────────────────
 * Demand Gen
 *
 * Four building blocks, deliberately kept as separate actions rather than one
 * "create the whole thing" command: each is idempotent on its own, so a batch
 * that dies half-way is fixed by re-running it, not by unpicking what landed.
 *   1. add-youtube-assets           film → asset on the account
 *   2. create-demand-gen-ad-groups  ad group + channel settings
 *   3. copy-ad-group-targeting      clone audiences/demographics from a sibling
 *   4. add-demand-gen-ads           the video responsive ad itself
 *   5. add-listing-groups           the product feed shown next to the ad
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Ask Google to validate a batch WITHOUT writing it (`validate_only`).
 *
 * A locally-built plan only proves the CSV parsed; it says nothing about whether
 * the resource tree is acceptable. That gap matters most where the shape is
 * intricate — a listing-group tree wired together with temporary resource names,
 * or a nested responsive ad — because the first real feedback would otherwise
 * arrive on the `--commit` run, half-applied.
 *
 * Returns `{ok: true}` or `{ok: false, error}`; never throws, so a simulation
 * reports the objection instead of dying on it.
 *
 * @param {object} customer - google-ads-api Customer
 * @param {Array<Array<object>>} batches - mutation arrays, each sent as one request
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function validateWithApi(customer, batches) {
  try {
    for (const b of batches) {
      if (b.length) await customer.mutateResources(b, { validate_only: true });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: unpackError(error) };
  }
}

/** `advertising_channel_type` value for Demand Gen (10 is PMax — a classic mix-up). */
const DEMAND_GEN_CHANNEL_TYPE = 14;

/** A bare YouTube ID: 11 chars of the URL-safe base64 alphabet. */
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Accept either a bare YouTube ID or any of the URL forms an operator is likely
 * to paste (watch?v=, youtu.be/, /shorts/, /embed/) and return the bare ID.
 * Returns '' when nothing usable is found, so the caller reports one clear
 * validation error instead of creating an asset for a malformed ID.
 *
 * @param {string} raw
 * @returns {string} bare video ID, or '' if unparseable
 */
export function parseYoutubeVideoId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (YOUTUBE_ID_RE.test(s)) return s;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return '';
}

/**
 * Create YouTube video assets on the account.
 *
 * Idempotent by video ID: an asset that already exists is skipped and its ID is
 * returned, so the caller can hang an ad on it either way. This matters because
 * Google does NOT deduplicate — asking twice yields two assets for one film, and
 * assets cannot be deleted.
 *
 * @param {string} customerId
 * @param {Array<{video: string, name?: string, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} `{plan, assets: [{videoId, assetId, resourceName, created}]}`
 */
export async function addYoutubeAssets(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak filmów do dodania (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const ref = it.label || String(it.video ?? '') || `wiersz ${i + 1}`;
    const videoId = parseYoutubeVideoId(it.video);
    if (!videoId) problems.push(`${ref}: nie rozpoznano ID filmu YouTube w "${it.video}".`);
    const name = String(it.name ?? '').trim();
    return { videoId, name, label: ref };
  });

  const seenInFile = new Set();
  for (const r of rows) {
    if (!r.videoId) continue;
    if (seenInFile.has(r.videoId)) problems.push(`${r.label}: film ${r.videoId} powtarza się w pliku wejściowym.`);
    seenInFile.add(r.videoId);
  }
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  // A read failure must block: a duplicate asset cannot be un-made.
  const existingRows = await getExistingYoutubeAssets(cleanCustomerId, rows.map((r) => r.videoId), { loginCustomerId });
  const existing = new Map(existingRows.map((a) => [a.videoId, a]));

  const toCreate = rows.filter((r) => !existing.has(r.videoId));
  const skipped = rows.filter((r) => existing.has(r.videoId));

  const plan = {
    toCreate: toCreate.map((r) => ({ videoId: r.videoId, name: r.name || `YouTube ${r.videoId}` })),
    skipped: skipped.map((r) => ({ videoId: r.videoId, assetId: existing.get(r.videoId).assetId, reason: 'zasób dla tego filmu już istnieje na koncie' })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Zasoby YouTube: do utworzenia ${toCreate.length}, pominięte (już są) ${skipped.length}...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'asset', toCreate: toCreate.length, skipped: skipped.length, plan };

  let responses = [];
  if (toCreate.length) {
    try {
      const customer = getCustomer(cleanCustomerId, loginCustomerId);
      const mutations = toCreate.map((r) => ({
        entity: 'Asset',
        operation: 'create',
        resource: {
          name: r.name || `YouTube ${r.videoId}`,
          youtube_video_asset: { youtube_video_id: r.videoId },
        },
      }));
      for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    } catch (error) {
      throw new Error(`Nie udało się utworzyć zasobów YouTube: ${unpackError(error)}`);
    }
  }

  // Read back so every row — created or skipped — carries a usable asset ID.
  const after = await getExistingYoutubeAssets(cleanCustomerId, rows.map((r) => r.videoId), { loginCustomerId });
  const byVideo = new Map(after.map((a) => [a.videoId, a]));
  const assets = rows.map((r) => {
    const hit = byVideo.get(r.videoId);
    return {
      videoId: r.videoId,
      assetId: hit ? hit.assetId : null,
      resourceName: hit ? `customers/${cleanCustomerId}/assets/${hit.assetId}` : null,
      created: !existing.has(r.videoId),
    };
  });

  return { success: true, dryRun: false, entity: 'asset', created: toCreate.length, skipped: skipped.length, plan, assets, resourceNames: mutatedResourceNames(responses) };
}

/**
 * Create ad groups in existing Demand Gen campaigns.
 *
 * Two things differ from `createAdGroups` (Search) and are the reason this is a
 * separate function rather than a flag:
 *   • `type` is NOT set. `AdGroupType` has no Demand Gen member — the campaign's
 *     channel type is what defines the group, and sending a Search/Video type
 *     here is rejected.
 *   • `channel_strategy` and `selected_channels` are a protobuf oneof, so at most
 *     one is written. `channel_config` is OUTPUT_ONLY and never sent.
 *
 * Refuses campaigns that are not Demand Gen: the resulting group would be wrong
 * in a way that only a manual fix can undo.
 *
 * @param {string} customerId
 * @param {Array<{campaignId: string|number, name: string, status?: string, strategy?: string, channels?: string[], label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>}
 */
export async function createDemandGenAdGroups(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak grup reklam do utworzenia (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const name = String(it.name ?? '').trim();
    const ref = it.label || name || `wiersz ${i + 1}`;
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    if (!campaignId) problems.push(`${ref}: brak campaign_id.`);
    const nameCheck = checkAdGroupName(name);
    if (!nameCheck.valid) nameCheck.reasons.forEach((r) => problems.push(`${ref}: ${r}`));

    const status = String(it.status ?? 'ENABLED').trim().toUpperCase();
    assertNotRemoval(status);
    if (!['ENABLED', 'PAUSED'].includes(status)) problems.push(`${ref}: status musi być ENABLED lub PAUSED (jest "${it.status}").`);

    const strategy = String(it.strategy ?? '').trim().toUpperCase();
    const channels = (it.channels || []).map((c) => String(c ?? '').trim().toLowerCase()).filter(Boolean);
    const chCheck = checkDemandGenChannels({ strategy, channels });
    if (!chCheck.valid) chCheck.reasons.forEach((r) => problems.push(`${ref}: ${r}`));

    return { campaignId, name, status, strategy, channels, label: ref };
  });

  const seenInFile = new Set();
  for (const r of rows) {
    const k = `${r.campaignId}|${r.name.toLowerCase()}`;
    if (seenInFile.has(k)) problems.push(`${r.label}: nazwa powtarza się w pliku wejściowym.`);
    seenInFile.add(k);
  }
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  // Guardrail: every target campaign must actually be Demand Gen.
  const campaigns = await getCampaignChannelTypes(cleanCustomerId, rows.map((r) => r.campaignId), { loginCustomerId });
  const wrongChannel = [];
  for (const r of rows) {
    const c = campaigns.get(r.campaignId);
    if (!c) wrongChannel.push(`${r.label}: kampania ${r.campaignId} nie istnieje albo jest niedostępna.`);
    else if (c.channelType !== DEMAND_GEN_CHANNEL_TYPE) {
      wrongChannel.push(`${r.label}: kampania "${c.name}" (${r.campaignId}) nie jest kampanią Demand Gen (advertising_channel_type=${c.channelType}).`);
    }
  }
  if (wrongChannel.length) {
    throw new Error(`🛑 Zablokowano — nieprawidłowe kampanie docelowe, nic nie zapisano:\n${wrongChannel.map((p) => `  • ${p}`).join('\n')}`);
  }

  const existingRows = await getAdGroupsByCampaign(cleanCustomerId, rows.map((r) => r.campaignId), { loginCustomerId });
  const existing = new Map(existingRows.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g]));

  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    const hit = existing.get(`${r.campaignId}|${r.name.toLowerCase()}`);
    if (hit) skipped.push({ ...r, adGroupId: hit.adGroupId });
    else toCreate.push(r);
  }

  const describeChannels = (r) => (r.strategy ? `strategia ${r.strategy}` : (r.channels.length ? `kanały: ${r.channels.join(', ')}` : 'ustawienie kanałów: domyślne kampanii'));
  const plan = {
    toCreate: toCreate.map((r) => ({ campaignId: r.campaignId, campaign: campaigns.get(r.campaignId)?.name, name: r.name, status: r.status, channels: describeChannels(r) })),
    skipped: skipped.map((r) => ({ campaignId: r.campaignId, name: r.name, adGroupId: r.adGroupId, reason: 'grupa o tej nazwie już istnieje w kampanii' })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Grupy Demand Gen: do utworzenia ${toCreate.length}, pominięte ${skipped.length}...`);
  if (!dryRun && toCreate.length === 0) {
    return { success: true, dryRun: false, entity: 'ad_group', created: 0, skipped: skipped.length, plan, createdGroups: [], response: null };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = toCreate.map((r) => {
      const resource = {
        campaign: `customers/${cleanCustomerId}/campaigns/${r.campaignId}`,
        name: r.name,
        status: r.status,
      };
      // oneof channel_configuration — set at most one branch.
      if (r.strategy) {
        resource.demand_gen_ad_group_settings = { channel_controls: { channel_strategy: r.strategy } };
      } else if (r.channels.length) {
        const selected = {};
        for (const c of r.channels) selected[c] = true;
        resource.demand_gen_ad_group_settings = { channel_controls: { selected_channels: selected } };
      }
      return { entity: 'AdGroup', operation: 'create', resource };
    });

    if (dryRun) {
      const check = await validateWithApi(customer, chunk(mutations));
      if (!check.ok) console.log(`[Mutator] ⚠️  Google odrzucił grupy w walidacji: ${check.error}`);
      return { success: check.ok, dryRun: true, entity: 'ad_group', toCreate: toCreate.length, skipped: skipped.length, plan, apiValidated: check.ok, apiError: check.error };
    }

    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));

    const after = await getAdGroupsByCampaign(cleanCustomerId, rows.map((r) => r.campaignId), { loginCustomerId });
    const byKey = new Map(after.map((g) => [`${g.campaignId}|${g.name.toLowerCase()}`, g]));
    const createdGroups = toCreate.map((r) => {
      const g = byKey.get(`${r.campaignId}|${r.name.toLowerCase()}`);
      return { campaignId: r.campaignId, name: r.name, adGroupId: g ? g.adGroupId : null };
    });

    return { success: true, dryRun: false, entity: 'ad_group', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, createdGroups, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się utworzyć grup Demand Gen: ${unpackError(error)}`);
  }
}

/**
 * Copy audience + demographic targeting from one ad group onto others.
 *
 * A Demand Gen group routinely carries 30-40 criteria (age brackets, genders,
 * parental status, interests, custom audiences). Rebuilding that by hand for
 * every new group is where mistakes live, and a missed exclusion spends money
 * silently. This clones only what `COPYABLE_CRITERION_TYPES` can rebuild and
 * reports the rest as `notCopied` instead of pretending the copy was complete.
 *
 * Idempotent: criteria already present on the target (same type + same value)
 * are skipped, so a re-run tops up rather than duplicating.
 *
 * @param {string} customerId
 * @param {Array<{sourceAdGroupId: string|number, targetAdGroupId: string|number, label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>}
 */
export async function copyAdGroupTargeting(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak par grup do skopiowania targetowania (pusta lista).');

  const problems = [];
  const pairs = items.map((it, i) => {
    const source = String(it.sourceAdGroupId ?? '').replace(/[^0-9]/g, '');
    const target = String(it.targetAdGroupId ?? '').replace(/[^0-9]/g, '');
    const ref = it.label || `${source || '?'} → ${target || '?'}` || `wiersz ${i + 1}`;
    if (!source) problems.push(`${ref}: brak source_ad_group_id.`);
    if (!target) problems.push(`${ref}: brak target_ad_group_id.`);
    if (source && source === target) problems.push(`${ref}: źródło i cel to ta sama grupa.`);
    return { source, target, label: ref };
  });
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const perPair = [];
  const mutations = [];
  for (const p of pairs) {
    const src = await getAdGroupTargetingCriteria(cleanCustomerId, p.source, { loginCustomerId });
    const dst = await getAdGroupTargetingCriteria(cleanCustomerId, p.target, { loginCustomerId });
    const have = new Set(dst.criteria.map((c) => `${c.key}|${c.value}|${c.negative ? 'neg' : 'pos'}`));

    // "Audience grouped" is the modern Demand Gen shape: the whole targeting —
    // demographics included — lives inside ONE account-level Audience resource,
    // referenced by a single `audience` criterion. Google rejects every other
    // criterion in that mode (demographics come back as
    // CANNOT_ADD_AUDIENCE_SEGMENT_CRITERION_WHEN_AUDIENCE_GROUPED_IS_SET, not
    // just segments), so copying anything else would fail the whole batch.
    // Loose criteria still read out of such a group via GAQL — they are history
    // from before the switch, not something that can be re-created.
    const grouped = dst.useAudienceGrouped;
    const targetHasAudience = dst.criteria.some((c) => c.group === 'audience');

    const toAdd = [];
    const already = [];
    const blocked = [];
    let audienceTaken = targetHasAudience;
    for (const c of src.criteria) {
      const k = `${c.key}|${c.value}|${c.negative ? 'neg' : 'pos'}`;
      if (have.has(k)) { already.push(c); continue; }

      // UNSPECIFIED (0) / UNKNOWN (1) are read-back artefacts; Google rejects
      // them on create. Never pass one through just because it came back.
      if (c.valueField === 'type' && (c.value === 0 || c.value === 1)) {
        blocked.push({ label: c.label, reason: 'wartość UNKNOWN/UNSPECIFIED — Google nie przyjmuje jej przy tworzeniu kryterium' });
        continue;
      }

      if (c.group === 'audience') {
        if (audienceTaken) {
          blocked.push({ label: c.label, reason: 'grupa docelowa ma już przypisanych odbiorców, a Google dopuszcza jednych na grupę' });
          continue;
        }
        audienceTaken = true;
      } else if (grouped) {
        blocked.push({ label: c.label, reason: 'grupa docelowa działa w trybie „audience grouped" — całe targetowanie (także demografia) siedzi w zasobie Audience; podepnij tych samych odbiorców zamiast pojedynczych kryteriów' });
        continue;
      }

      have.add(k); // guard against duplicates inside the source itself
      toAdd.push(c);
    }

    for (const c of toAdd) {
      const resource = {
        ad_group: `customers/${cleanCustomerId}/adGroups/${p.target}`,
        [c.key]: { [c.valueField]: c.value },
      };
      // Only set `negative` when excluding — some criterion types reject an
      // explicit `negative: false` on create.
      if (c.negative) resource.negative = true;
      mutations.push({ entity: 'AdGroupCriterion', operation: 'create', resource });
    }

    perPair.push({
      source: p.source,
      target: p.target,
      toCopy: toAdd.length,
      alreadyPresent: already.length,
      byType: [...toAdd.reduce((m, c) => m.set(c.label, (m.get(c.label) || 0) + 1), new Map())].map(([label, count]) => ({ label, count })),
      audienceGrouped: grouped,
      notCopied: [
        ...src.skipped.map((s) => ({ criterionType: s.type, count: s.count, reason: 'typ kryterium nieobsługiwany przez kopiowanie — przenieś ręcznie' })),
        ...blocked.map((b) => ({ label: b.label, count: 1, reason: b.reason })),
      ],
    });
  }

  const plan = { pairs: perPair, totalToCopy: mutations.length };
  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Kopiowanie targetowania: ${mutations.length} kryteriów w ${pairs.length} parach...`);
  const uncopyable = perPair.flatMap((p) => p.notCopied);
  if (uncopyable.length) {
    console.log(`[Mutator] ⚠️  ${uncopyable.reduce((n, u) => n + u.count, 0)} kryteriów NIE zostanie skopiowanych (nieobsługiwane typy) — sprawdź "notCopied" w wyniku.`);
  }

  if (!dryRun && mutations.length === 0) return { success: true, dryRun: false, entity: 'ad_group_criterion', created: 0, plan, response: null };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    if (dryRun) {
      const check = await validateWithApi(customer, chunk(mutations));
      if (!check.ok) console.log(`[Mutator] ⚠️  Google odrzucił kryteria w walidacji: ${check.error}`);
      return { success: check.ok, dryRun: true, entity: 'ad_group_criterion', toCopy: mutations.length, plan, apiValidated: check.ok, apiError: check.error };
    }
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'ad_group_criterion', created: mutations.length, chunks: responses.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się skopiować targetowania: ${unpackError(error)}`);
  }
}

/** CTA names accepted by `add-demand-gen-ads`, mapped to their enum value. */
export const CALL_TO_ACTION_VALUES = {
  LEARN_MORE: 2, GET_QUOTE: 3, APPLY_NOW: 4, SIGN_UP: 5, CONTACT_US: 6, SUBSCRIBE: 7,
  DOWNLOAD: 8, BOOK_NOW: 9, SHOP_NOW: 10, BUY_NOW: 11, DONATE_NOW: 12, ORDER_NOW: 13,
  PLAY_NOW: 14, SEE_MORE: 15, START_NOW: 16, VISIT_SITE: 17, WATCH_NOW: 18,
};

/**
 * Create Demand Gen video responsive ads.
 *
 * The proto marks `videos`, `logo_images` and `business_name` REQUIRED; the text
 * minimums are enforced server-side and checked up front by
 * `checkDemandGenAdTexts` so a bad row fails with a readable message.
 *
 * The video must already be an asset on the account — run `add-youtube-assets`
 * first. Resolving it here by ID (rather than creating it on the fly) keeps this
 * action free of the "created a duplicate asset" failure mode.
 *
 * The call-to-action is an ASSET reference, not an inline enum. Missing CTA
 * assets are created in a pre-pass and reused across rows.
 *
 * Idempotent: an ad in the same group with the same video and the same Final URL
 * counts as present.
 *
 * @param {string} customerId
 * @param {Array<object>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{domain?: string}} [opts] - domain lock for Final URLs
 * @returns {Promise<object>}
 */
export async function addDemandGenAds(customerId, items, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak reklam do dodania (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const ref = it.label || `wiersz ${i + 1}`;
    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    if (!adGroupId) problems.push(`${ref}: brak ad_group_id.`);

    const videoId = parseYoutubeVideoId(it.video);
    if (!videoId) problems.push(`${ref}: nie rozpoznano ID filmu YouTube w "${it.video}".`);

    const logoAssetId = String(it.logoAssetId ?? '').replace(/[^0-9]/g, '');
    if (!logoAssetId) problems.push(`${ref}: brak logo_asset_id (logo jest wymagane przez API).`);

    const finalUrl = String(it.finalUrl ?? '').trim();
    const urlCheck = validateFinalUrl(finalUrl, { domain: opts.domain });
    if (!urlCheck.valid) problems.push(`${ref}: ${urlCheck.reason}`);

    const headlines = (it.headlines || []).map((h) => String(h ?? '').trim()).filter(Boolean);
    const longHeadlines = (it.longHeadlines || []).map((h) => String(h ?? '').trim()).filter(Boolean);
    const descriptions = (it.descriptions || []).map((d) => String(d ?? '').trim()).filter(Boolean);
    const businessName = String(it.businessName ?? '').trim();
    const textCheck = checkDemandGenAdTexts({ headlines, longHeadlines, descriptions, businessName });
    if (!textCheck.valid) textCheck.reasons.forEach((r) => problems.push(`${ref}: ${r}`));

    const cta = String(it.cta ?? '').trim().toUpperCase();
    const status = String(it.status ?? 'ENABLED').trim().toUpperCase();
    assertNotRemoval(status);
    if (!['ENABLED', 'PAUSED'].includes(status)) problems.push(`${ref}: status musi być ENABLED lub PAUSED (jest "${it.status}").`);

    return { adGroupId, videoId, logoAssetId, finalUrl, headlines, longHeadlines, descriptions, businessName, cta, status, name: String(it.name ?? '').trim(), label: ref };
  });
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  // Resolve videos to existing assets — never create one here.
  const videoAssets = await getExistingYoutubeAssets(cleanCustomerId, rows.map((r) => r.videoId), { loginCustomerId });
  const byVideo = new Map(videoAssets.map((a) => [a.videoId, a.assetId]));
  const missingVideos = [...new Set(rows.filter((r) => !byVideo.has(r.videoId)).map((r) => r.videoId))];
  if (missingVideos.length) {
    throw new Error(`🛑 Zablokowano — te filmy nie są jeszcze zasobami na koncie: ${missingVideos.join(', ')}.\n   Uruchom najpierw: --action=add-youtube-assets`);
  }

  // Skip ads that already exist (same group + same video asset + same URL).
  const existingAds = await getExistingDemandGenAds(cleanCustomerId, rows.map((r) => r.adGroupId), { loginCustomerId });
  const existingKeys = new Set();
  for (const a of existingAds) {
    for (const v of a.videoAssets) {
      for (const u of (a.finalUrls || [])) existingKeys.add(`${a.adGroupId}|${v}|${u}`);
    }
  }

  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    const assetRn = `customers/${cleanCustomerId}/assets/${byVideo.get(r.videoId)}`;
    const key = `${r.adGroupId}|${assetRn}|${r.finalUrl}`;
    if (existingKeys.has(key)) { skipped.push({ ...r, reason: 'reklama z tym filmem i tym URL już jest w grupie' }); continue; }
    existingKeys.add(key);
    toCreate.push({ ...r, videoAssetResourceName: assetRn });
  }

  const plan = {
    toCreate: toCreate.map((r) => ({ adGroupId: r.adGroupId, video: r.videoId, finalUrl: r.finalUrl, headlines: r.headlines.length, longHeadlines: r.longHeadlines.length, descriptions: r.descriptions.length, cta: r.cta || '(brak — Google dobierze)', status: r.status })),
    skipped: skipped.map((r) => ({ adGroupId: r.adGroupId, video: r.videoId, reason: r.reason })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Reklamy Demand Gen: do utworzenia ${toCreate.length}, pominięte ${skipped.length}...`);
  if (!dryRun && toCreate.length === 0) return { success: true, dryRun: false, entity: 'ad_group_ad', created: 0, skipped: skipped.length, plan, response: null };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);

    // Pre-pass: make sure every requested CTA exists as an asset, then reuse it.
    const ctaWanted = [...new Set(toCreate.map((r) => r.cta).filter(Boolean))];
    let ctaAssets = ctaWanted.length ? await getCallToActionAssets(cleanCustomerId, { loginCustomerId }) : new Map();
    const ctaEnumOf = (name) => CALL_TO_ACTION_VALUES[name];
    const unknownCta = ctaWanted.filter((c) => ctaEnumOf(c) === undefined);
    if (unknownCta.length) {
      throw new Error(`Nieznane CTA: ${unknownCta.join(', ')}. Dozwolone: ${Object.keys(CALL_TO_ACTION_VALUES).join(', ')}.`);
    }
    const ctaToCreate = ctaWanted.filter((c) => !ctaAssets.has(ctaEnumOf(c)));
    // A simulation must not create assets. Missing CTAs are reported and the ad
    // is validated without them — the part worth checking is the ad structure.
    const ctaDeferred = dryRun ? ctaToCreate : [];
    if (ctaToCreate.length && !dryRun) {
      await customer.mutateResources(ctaToCreate.map((c) => ({
        entity: 'Asset',
        operation: 'create',
        resource: { call_to_action_asset: { call_to_action: c } },
      })));
      ctaAssets = await getCallToActionAssets(cleanCustomerId, { loginCustomerId });
    }

    const mutations = toCreate.map((r) => {
      const ad = {
        final_urls: [r.finalUrl],
        demand_gen_video_responsive_ad: {
          videos: [{ asset: r.videoAssetResourceName }],
          logo_images: [{ asset: `customers/${cleanCustomerId}/assets/${r.logoAssetId}` }],
          business_name: { text: r.businessName },
          headlines: r.headlines.map((t) => ({ text: t })),
          long_headlines: r.longHeadlines.map((t) => ({ text: t })),
          descriptions: r.descriptions.map((t) => ({ text: t })),
        },
      };
      // `ad.name` is REQUIRED for Demand Gen ads (unlike RSA, where it is a free
      // label). Google rejects the whole mutate without it, so fall back to a
      // descriptive, per-video default instead of making every CSV carry one.
      ad.name = r.name || `${(r.headlines[0] || 'Demand Gen').slice(0, 60)} [${r.videoId}]`;
      if (r.cta) {
        const rn = ctaAssets.get(ctaEnumOf(r.cta));
        if (!rn && !dryRun) throw new Error(`Nie udało się ustalić zasobu CTA dla "${r.cta}".`);
        if (rn) ad.demand_gen_video_responsive_ad.call_to_actions = [{ asset: rn }];
      }
      return {
        entity: 'AdGroupAd',
        operation: 'create',
        resource: { ad_group: `customers/${cleanCustomerId}/adGroups/${r.adGroupId}`, status: r.status, ad },
      };
    });

    if (dryRun) {
      const check = await validateWithApi(customer, chunk(mutations));
      if (!check.ok) console.log(`[Mutator] ⚠️  Google odrzucił reklamę w walidacji: ${check.error}`);
      if (ctaDeferred.length) console.log(`[Mutator] ℹ️  CTA do utworzenia przy --commit: ${ctaDeferred.join(', ')} (walidacja poszła bez nich).`);
      return { success: check.ok, dryRun: true, entity: 'ad_group_ad', toCreate: toCreate.length, skipped: skipped.length, plan, apiValidated: check.ok, apiError: check.error, ctaToCreate: ctaDeferred };
    }

    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'ad_group_ad', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się utworzyć reklam Demand Gen: ${unpackError(error)}`);
  }
}

/**
 * Create Demand Gen PRODUCT ads — the ad type that renders items from the feed.
 *
 * This is the piece that turns a Demand Gen remarketing campaign into a DYNAMIC
 * one: a multi-asset ad shows the same creative to everyone, a product ad shows
 * products drawn from the ad group's listing tree. Both can live in one group.
 *
 * Unlike the video ad, a product ad carries exactly ONE headline and ONE
 * description (not lists), so the shared text check runs on single-element
 * lists — same limits, same policy rules, one code path.
 *
 * Two guardrails, both of which would otherwise surface as an opaque API error
 * or, worse, as an ad that serves nothing:
 *   • the ad group must sit in a Demand Gen campaign;
 *   • the ad group must already have a product feed (listing group), because a
 *     product ad with no feed has nothing to render.
 *
 * The call-to-action is an ASSET reference (as in `add-demand-gen-ads`), but the
 * field is singular here: `call_to_action`, not `call_to_actions`.
 *
 * Idempotent: a product ad in the same group with the same headline and the
 * same Final URL counts as present.
 *
 * @param {string} customerId
 * @param {Array<object>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{domain?: string}} [opts] - domain lock for Final URLs
 * @returns {Promise<object>}
 */
export async function addDemandGenProductAds(customerId, items, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak reklam do dodania (pusta lista).');

  const problems = [];
  const rows = items.map((it, i) => {
    const ref = it.label || `wiersz ${i + 1}`;
    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    if (!adGroupId) problems.push(`${ref}: brak ad_group_id.`);

    const logoAssetId = String(it.logoAssetId ?? '').replace(/[^0-9]/g, '');
    if (!logoAssetId) problems.push(`${ref}: brak logo_asset_id (logo jest wymagane przez API).`);

    const finalUrl = String(it.finalUrl ?? '').trim();
    const urlCheck = validateFinalUrl(finalUrl, { domain: opts.domain });
    if (!urlCheck.valid) problems.push(`${ref}: ${urlCheck.reason}`);

    const headline = String(it.headline ?? '').trim();
    const description = String(it.description ?? '').trim();
    const businessName = String(it.businessName ?? '').trim();
    const textCheck = checkDemandGenAdTexts({
      headlines: headline ? [headline] : [],
      descriptions: description ? [description] : [],
      businessName,
    });
    if (!textCheck.valid) textCheck.reasons.forEach((r) => problems.push(`${ref}: ${r}`));

    const breadcrumb1 = String(it.breadcrumb1 ?? '').trim();
    const breadcrumb2 = String(it.breadcrumb2 ?? '').trim();
    for (const [field, b] of [['breadcrumb1', breadcrumb1], ['breadcrumb2', breadcrumb2]]) {
      if (b && adTextLength(b) > DEMAND_GEN_LIMITS.breadcrumbChars) {
        problems.push(`${ref}: ${field} ${adTextLength(b)} zn. (limit ${DEMAND_GEN_LIMITS.breadcrumbChars}): "${b}"`);
      }
    }

    const cta = String(it.cta ?? '').trim().toUpperCase();
    const status = String(it.status ?? 'ENABLED').trim().toUpperCase();
    assertNotRemoval(status);
    if (!['ENABLED', 'PAUSED'].includes(status)) problems.push(`${ref}: status musi być ENABLED lub PAUSED (jest "${it.status}").`);

    return { adGroupId, logoAssetId, finalUrl, headline, description, businessName, breadcrumb1, breadcrumb2, cta, status, name: String(it.name ?? '').trim(), label: ref };
  });
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const groupIds = [...new Set(rows.map((r) => r.adGroupId))];

  // Guardrail 1 — the ad group exists and its campaign is Demand Gen.
  const groups = await getAdGroupsByIds(cleanCustomerId, groupIds, { loginCustomerId });
  const groupById = new Map(groups.map((g) => [g.adGroupId, g]));
  const campaigns = await getCampaignChannelTypes(cleanCustomerId, [...new Set(groups.map((g) => g.campaignId))], { loginCustomerId });
  const wrongTarget = [];
  for (const r of rows) {
    const g = groupById.get(r.adGroupId);
    if (!g) { wrongTarget.push(`${r.label}: grupa ${r.adGroupId} nie istnieje, jest usunięta albo niedostępna.`); continue; }
    const c = campaigns.get(g.campaignId);
    if (!c) wrongTarget.push(`${r.label}: nie udało się odczytać kampanii grupy ${r.adGroupId}.`);
    else if (c.channelType !== DEMAND_GEN_CHANNEL_TYPE) {
      wrongTarget.push(`${r.label}: grupa "${g.name}" leży w kampanii "${c.name}" (${g.campaignId}), która nie jest Demand Gen (advertising_channel_type=${c.channelType}).`);
    }
  }
  if (wrongTarget.length) {
    throw new Error(`🛑 Zablokowano — nieprawidłowe grupy docelowe, nic nie zapisano:\n${wrongTarget.map((p) => `  • ${p}`).join('\n')}`);
  }

  // Guardrail 2 — no feed, nothing to render.
  const listing = await getExistingListingGroups(cleanCustomerId, groupIds, { loginCustomerId });
  const withFeed = new Set(listing.map((l) => String(l.adGroupId)));
  const noFeed = [...new Set(rows.filter((r) => !withFeed.has(r.adGroupId)).map((r) => r.adGroupId))];
  if (noFeed.length) {
    throw new Error(`🛑 Zablokowano — te grupy nie mają kanału produktowego, więc reklama produktowa nie miałaby czego pokazać: ${noFeed.join(', ')}.\n   Podepnij feed najpierw: --action=add-listing-groups`);
  }

  // Skip product ads that already exist (same group + same headline + same URL).
  const existingAds = await getExistingDemandGenProductAds(cleanCustomerId, groupIds, { loginCustomerId });
  const existingKeys = new Set();
  for (const a of existingAds) {
    for (const u of (a.finalUrls || [])) existingKeys.add(`${a.adGroupId}|${a.headline.toLowerCase()}|${u}`);
  }

  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    const key = `${r.adGroupId}|${r.headline.toLowerCase()}|${r.finalUrl}`;
    if (existingKeys.has(key)) { skipped.push({ ...r, reason: 'reklama produktowa z tym nagłówkiem i tym URL już jest w grupie' }); continue; }
    existingKeys.add(key);
    toCreate.push(r);
  }

  const plan = {
    toCreate: toCreate.map((r) => ({ adGroupId: r.adGroupId, headline: r.headline, description: r.description, finalUrl: r.finalUrl, businessName: r.businessName, cta: r.cta || '(brak — Google dobierze)', status: r.status })),
    skipped: skipped.map((r) => ({ adGroupId: r.adGroupId, headline: r.headline, reason: r.reason })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Reklamy produktowe Demand Gen: do utworzenia ${toCreate.length}, pominięte ${skipped.length}...`);
  if (!dryRun && toCreate.length === 0) return { success: true, dryRun: false, entity: 'ad_group_ad', created: 0, skipped: skipped.length, plan, response: null };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);

    // Pre-pass: make sure every requested CTA exists as an asset, then reuse it.
    const ctaWanted = [...new Set(toCreate.map((r) => r.cta).filter(Boolean))];
    let ctaAssets = ctaWanted.length ? await getCallToActionAssets(cleanCustomerId, { loginCustomerId }) : new Map();
    const ctaEnumOf = (name) => CALL_TO_ACTION_VALUES[name];
    const unknownCta = ctaWanted.filter((c) => ctaEnumOf(c) === undefined);
    if (unknownCta.length) {
      throw new Error(`Nieznane CTA: ${unknownCta.join(', ')}. Dozwolone: ${Object.keys(CALL_TO_ACTION_VALUES).join(', ')}.`);
    }
    const ctaToCreate = ctaWanted.filter((c) => !ctaAssets.has(ctaEnumOf(c)));
    // A simulation must not create assets — same rule as add-demand-gen-ads.
    const ctaDeferred = dryRun ? ctaToCreate : [];
    if (ctaToCreate.length && !dryRun) {
      await customer.mutateResources(ctaToCreate.map((c) => ({
        entity: 'Asset',
        operation: 'create',
        resource: { call_to_action_asset: { call_to_action: c } },
      })));
      ctaAssets = await getCallToActionAssets(cleanCustomerId, { loginCustomerId });
    }

    const mutations = toCreate.map((r) => {
      const productAd = {
        headline: { text: r.headline },
        description: { text: r.description },
        logo_image: { asset: `customers/${cleanCustomerId}/assets/${r.logoAssetId}` },
        business_name: { text: r.businessName },
      };
      if (r.breadcrumb1) productAd.breadcrumb1 = r.breadcrumb1;
      if (r.breadcrumb2) productAd.breadcrumb2 = r.breadcrumb2;
      if (r.cta) {
        const rn = ctaAssets.get(ctaEnumOf(r.cta));
        if (!rn && !dryRun) throw new Error(`Nie udało się ustalić zasobu CTA dla "${r.cta}".`);
        // Singular here — a product ad takes one CTA, a video ad takes a list.
        if (rn) productAd.call_to_action = { asset: rn };
      }
      const ad = { final_urls: [r.finalUrl], demand_gen_product_ad: productAd };
      // `ad.name` is REQUIRED for Demand Gen ads — same as the video variant.
      ad.name = r.name || `${r.headline.slice(0, 60)} [produktowa]`;
      return {
        entity: 'AdGroupAd',
        operation: 'create',
        resource: { ad_group: `customers/${cleanCustomerId}/adGroups/${r.adGroupId}`, status: r.status, ad },
      };
    });

    if (dryRun) {
      const check = await validateWithApi(customer, chunk(mutations));
      if (!check.ok) console.log(`[Mutator] ⚠️  Google odrzucił reklamę w walidacji: ${check.error}`);
      if (ctaDeferred.length) console.log(`[Mutator] ℹ️  CTA do utworzenia przy --commit: ${ctaDeferred.join(', ')} (walidacja poszła bez nich).`);
      return { success: check.ok, dryRun: true, entity: 'ad_group_ad', toCreate: toCreate.length, skipped: skipped.length, plan, apiValidated: check.ok, apiError: check.error, ctaToCreate: ctaDeferred };
    }

    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'ad_group_ad', created: toCreate.length, skipped: skipped.length, chunks: responses.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się utworzyć reklam produktowych Demand Gen: ${unpackError(error)}`);
  }
}

/**
 * Attach a product feed to Demand Gen ad groups, restricted to specific products.
 *
 * Builds the standard three-part listing tree, in ONE mutate per ad group so the
 * temporary resource names resolve:
 *   • root  — SUBDIVISION on product_item_id
 *   • units — one per requested item ID (these serve)
 *   • other — the "everything else" unit, EXCLUDED, so only the listed products
 *             can show. Without it the tree is invalid and, if Google accepted
 *             it, the whole catalogue would run.
 *
 * Refuses an ad group that already has a tree: changing one means removing
 * criteria, and this connector does not delete. Sort that in the UI instead.
 *
 * @param {string} customerId
 * @param {Array<{adGroupId: string|number, itemIds: string[], label?: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>}
 */
export async function addListingGroups(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak grup do podpięcia kanału produktowego (pusta lista).');

  const problems = [];
  // Several CSV rows may target the same ad group; merge them into one tree.
  const byAdGroup = new Map();
  items.forEach((it, i) => {
    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    const ref = it.label || adGroupId || `wiersz ${i + 1}`;
    if (!adGroupId) { problems.push(`${ref}: brak ad_group_id.`); return; }
    const ids = (it.itemIds || []).map((v) => String(v ?? '').trim()).filter(Boolean);
    if (ids.length === 0) problems.push(`${ref}: brak ID produktów (product_item_ids).`);
    const entry = byAdGroup.get(adGroupId) || { adGroupId, itemIds: [], labels: [] };
    for (const id of ids) if (!entry.itemIds.includes(id)) entry.itemIds.push(id);
    entry.labels.push(ref);
    byAdGroup.set(adGroupId, entry);
  });
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const groups = [...byAdGroup.values()];
  for (const g of groups) {
    // root + "everything else" + one node per product must fit a single request.
    if (g.itemIds.length + 2 > MUTATE_CHUNK) {
      problems.push(`Grupa ${g.adGroupId}: ${g.itemIds.length} produktów to za dużo na jedno drzewo (limit ${MUTATE_CHUNK - 2}).`);
    }
  }
  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów), nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  // Guardrail: never touch an ad group that already has a feed tree.
  const existing = await getExistingListingGroups(cleanCustomerId, groups.map((g) => g.adGroupId), { loginCustomerId });
  const haveTree = new Map();
  for (const n of existing) haveTree.set(n.adGroupId, (haveTree.get(n.adGroupId) || 0) + 1);

  const toBuild = groups.filter((g) => !haveTree.has(g.adGroupId));
  const skipped = groups.filter((g) => haveTree.has(g.adGroupId));

  const plan = {
    toBuild: toBuild.map((g) => ({ adGroupId: g.adGroupId, products: g.itemIds.length, itemIds: g.itemIds, nodes: g.itemIds.length + 2 })),
    skipped: skipped.map((g) => ({ adGroupId: g.adGroupId, existingNodes: haveTree.get(g.adGroupId), reason: 'grupa ma już kanał produktowy — zmiana wymaga usunięcia kryteriów, a konektor nie usuwa (zrób to w UI)' })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Kanał produktowy: do zbudowania ${toBuild.length} drzew, pominięte ${skipped.length}...`);
  if (!dryRun && toBuild.length === 0) return { success: true, dryRun: false, entity: 'ad_group_criterion', built: 0, skipped: skipped.length, plan, response: null };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    // One batch per ad group: temporary IDs only resolve inside a single mutate,
    // and a failure stays contained to that group's tree.
    const batches = toBuild.map((g) => {
      const adGroup = `customers/${cleanCustomerId}/adGroups/${g.adGroupId}`;
      const temp = (n) => `customers/${cleanCustomerId}/adGroupCriteria/${g.adGroupId}~${n}`;
      const rootRn = temp(-1);

      return [
        {
          entity: 'AdGroupCriterion',
          operation: 'create',
          resource: { resource_name: rootRn, ad_group: adGroup, status: 'ENABLED', listing_group: { type: 'SUBDIVISION' } },
        },
        {
          // "Everything else", excluded — only the listed products may serve.
          entity: 'AdGroupCriterion',
          operation: 'create',
          resource: {
            resource_name: temp(-2),
            ad_group: adGroup,
            status: 'ENABLED',
            negative: true,
            listing_group: { type: 'UNIT', parent_ad_group_criterion: rootRn, case_value: { product_item_id: {} } },
          },
        },
        ...g.itemIds.map((id, i) => ({
          entity: 'AdGroupCriterion',
          operation: 'create',
          resource: {
            resource_name: temp(-3 - i),
            ad_group: adGroup,
            status: 'ENABLED',
            listing_group: { type: 'UNIT', parent_ad_group_criterion: rootRn, case_value: { product_item_id: { value: id } } },
          },
        })),
      ];
    });

    if (dryRun) {
      const check = await validateWithApi(customer, batches);
      if (!check.ok) console.log(`[Mutator] ⚠️  Google odrzucił drzewo w walidacji: ${check.error}`);
      return { success: check.ok, dryRun: true, entity: 'ad_group_criterion', toBuild: toBuild.length, skipped: skipped.length, plan, apiValidated: check.ok, apiError: check.error };
    }

    const responses = [];
    for (const b of batches) responses.push(await customer.mutateResources(b));
    return { success: true, dryRun: false, entity: 'ad_group_criterion', built: toBuild.length, skipped: skipped.length, plan, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się zbudować kanału produktowego: ${unpackError(error)}`);
  }
}

// --- Conversion actions (wdrażanie konwersji) --------------------------------

/**
 * Build the API resource for a conversion action from our flat row, sending ONLY
 * the fields the caller actually provided.
 *
 * Nested messages are the subtlety here. `value_settings` and
 * `attribution_model_settings` are sub-messages, so on an update the whole
 * sub-message is what travels — send just `default_value` and the sibling
 * currency can be wiped. Callers therefore pass `base` (the current values read
 * from the account) and this merges onto it, so an update touches one field and
 * leaves the rest as they were. `data_driven_model_status` is read-only and is
 * never sent.
 *
 * @param {object} row - normalized row (see createConversionActions)
 * @param {object} [base] - current values, for merge-on-update
 * @returns {object} partial ConversionAction resource
 */
function buildConversionResource(row, base = {}) {
  const res = {};
  if (row.name !== undefined) res.name = row.name;
  if (row.type !== undefined) res.type = row.type;
  if (row.category !== undefined) res.category = row.category;
  if (row.status !== undefined) res.status = row.status;
  if (row.primaryForGoal !== undefined) res.primary_for_goal = row.primaryForGoal;
  if (row.countingType !== undefined) res.counting_type = row.countingType;
  if (row.clickLookbackDays !== undefined) res.click_through_lookback_window_days = row.clickLookbackDays;
  if (row.viewLookbackDays !== undefined) res.view_through_lookback_window_days = row.viewLookbackDays;

  const touchesValue = row.defaultValue !== undefined || row.currency !== undefined || row.alwaysUseDefaultValue !== undefined;
  if (touchesValue) {
    const defaultValue = row.defaultValue !== undefined ? row.defaultValue : base.defaultValue;
    const currency = row.currency !== undefined ? row.currency : base.currency;
    const always = row.alwaysUseDefaultValue !== undefined ? row.alwaysUseDefaultValue : base.alwaysUseDefaultValue;
    res.value_settings = {};
    if (defaultValue !== undefined && defaultValue !== null) res.value_settings.default_value = Number(defaultValue);
    if (currency) res.value_settings.default_currency_code = String(currency).toUpperCase();
    if (always !== undefined && always !== null) res.value_settings.always_use_default_value = !!always;
  }

  if (row.attributionModel !== undefined) {
    res.attribution_model_settings = { attribution_model: row.attributionModel };
  }
  return res;
}

/**
 * Normalize one CSV/flag row into the shape the builder and the validator expect.
 * Empty cells become `undefined` (= "don't touch"), not empty strings — that
 * distinction is what makes a partial update possible.
 */
function normalizeConversionRow(it) {
  const str = (v) => (v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim());
  const upper = (v) => (str(v) === undefined ? undefined : str(v).toUpperCase());
  const num = (v) => (str(v) === undefined ? undefined : Number(str(v)));
  const bool = (v) => {
    const s = str(v);
    if (s === undefined) return undefined;
    if (/^(true|yes|tak|1|primary|glowna|główna)$/i.test(s)) return true;
    if (/^(false|no|nie|0|secondary|dodatkowa)$/i.test(s)) return false;
    return undefined;
  };
  return {
    id: str(it.id),
    resourceName: str(it.resourceName),
    name: str(it.name),
    type: upper(it.type),
    category: upper(it.category),
    status: upper(it.status),
    countingType: upper(it.countingType),
    attributionModel: upper(it.attributionModel),
    primaryForGoal: bool(it.primaryForGoal),
    defaultValue: num(it.defaultValue),
    currency: upper(it.currency),
    alwaysUseDefaultValue: bool(it.alwaysUseDefaultValue),
    clickLookbackDays: num(it.clickLookbackDays),
    viewLookbackDays: num(it.viewLookbackDays),
    label: str(it.label) || str(it.name) || 'wiersz',
  };
}

/**
 * Create conversion actions — the Google Ads half of deploying conversion
 * tracking. What GTM needs afterwards (the `AW-…` conversion ID and the label)
 * is read back and returned per created action, so the tagging step can start
 * immediately without a trip to the UI.
 *
 * Idempotent by NAME (case-insensitively): an existing action with the same name
 * is skipped, so a re-run adds nothing. This matters more here than anywhere else
 * in the connector — two live actions measuring the same event double-count every
 * conversion, they poison Smart Bidding, and the no-delete policy means the
 * connector cannot take the duplicate back. For the same reason a failed read of
 * the current actions BLOCKS the write instead of assuming the account is empty.
 *
 * Only tag-based and offline-import types are creatable (see CONVERSION_TYPES) —
 * GA4 and Firebase conversions appear by linking the property, not through here.
 *
 * @param {string} customerId
 * @param {Array<object>} items - rows: name, type, category, [status, primaryForGoal,
 *   countingType, defaultValue, currency, alwaysUseDefaultValue, clickLookbackDays,
 *   viewLookbackDays, attributionModel]
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} `{plan, warnings, created, skipped, createdActions}`
 */
export async function createConversionActions(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak konwersji do utworzenia (pusta lista).');

  const problems = [];
  const warnings = [];
  const rows = items.map((it, i) => {
    const row = normalizeConversionRow(it);
    const ref = row.label || `wiersz ${i + 1}`;
    const check = checkConversionAction(row, { isUpdate: false });
    check.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    check.warnings.forEach((w) => warnings.push(w));
    return { ...row, label: ref };
  });

  const seen = new Set();
  for (const r of rows) {
    const k = String(r.name ?? '').toLowerCase();
    if (seen.has(k)) problems.push(`${r.label}: nazwa konwersji powtarza się w pliku wejściowym.`);
    seen.add(k);
  }

  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  // A read failure must block: a duplicate conversion action cannot be undone here.
  const existing = await getConversionActions(cleanCustomerId, { loginCustomerId, all: true });
  const byName = new Map(existing.map((a) => [a.name.toLowerCase(), a]));

  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    const hit = byName.get(String(r.name).toLowerCase());
    if (hit) skipped.push({ ...r, existingId: hit.id, existingStatus: hit.status });
    else toCreate.push(r);
  }

  const plan = {
    toCreate: toCreate.map((r) => ({
      name: r.name, type: r.type, category: r.category,
      primaryForGoal: r.primaryForGoal ?? '(domyślnie Google)',
      countingType: r.countingType ?? '(domyślnie Google)',
      defaultValue: r.defaultValue ?? null, currency: r.currency ?? null,
      alwaysUseDefaultValue: r.alwaysUseDefaultValue ?? false,
      clickLookbackDays: r.clickLookbackDays ?? '(domyślnie Google)',
      viewLookbackDays: r.viewLookbackDays ?? '(domyślnie Google)',
      attributionModel: r.attributionModel ?? '(domyślnie Google)',
    })),
    skipped: skipped.map((r) => ({ name: r.name, existingId: r.existingId, status: r.existingStatus, reason: 'konwersja o tej nazwie już istnieje w koncie' })),
  };

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Konwersje: do utworzenia ${toCreate.length}, pominięte (już istnieją) ${skipped.length}...`);
  if (dryRun) {
    return { success: true, dryRun: true, entity: 'conversion_action', toCreate: toCreate.length, skipped: skipped.length, plan, warnings };
  }
  if (toCreate.length === 0) {
    return { success: true, dryRun: false, entity: 'conversion_action', created: 0, skipped: skipped.length, plan, warnings, createdActions: [] };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const resources = toCreate.map((r) => buildConversionResource(r));
    const responses = [];
    for (const part of chunk(resources)) responses.push(await customer.conversionActions.create(part));

    // Read back for the IDs and the tag snippets — this is the GTM handoff.
    let createdActions = toCreate.map((r) => ({ name: r.name, id: null, conversionId: null, label: null }));
    try {
      const after = await getConversionActions(cleanCustomerId, { loginCustomerId, all: true });
      const afterByName = new Map(after.map((a) => [a.name.toLowerCase(), a]));
      createdActions = toCreate.map((r) => {
        const a = afterByName.get(String(r.name).toLowerCase());
        return {
          name: r.name,
          id: a ? a.id : null,
          category: a ? a.category : r.category,
          conversionId: a ? a.conversionId : null,
          label: a ? a.label : null,
        };
      });
    } catch { /* the write landed; a failed read-back must not look like a failure */ }

    return {
      success: true, dryRun: false, entity: 'conversion_action',
      created: toCreate.length, skipped: skipped.length, chunks: responses.length,
      plan, warnings, createdActions, resourceNames: mutatedResourceNames(responses),
      next: 'Konwersje istnieją w Google Ads. Wartości do tagu w GTM: conversionId (AW-…) + label. Etykieta pojawia się dopiero po chwili — jeśli jest pusta, powtórz list-conversions --with-snippets.',
    };
  } catch (error) {
    throw new Error(`Nie udało się utworzyć konwersji: ${unpackError(error)}`);
  }
}

/**
 * Update existing conversion actions — the second half of deployment: promoting an
 * action to primary once its tag is verified, correcting a value or a counting
 * type, retiring an old action with HIDDEN.
 *
 * Partial by design: a row changes only the columns it fills in. Current values
 * are read first, so the from→to diff is real and nested sub-messages
 * (`value_settings`) are merged rather than overwritten. An unknown ID blocks the
 * whole batch — silently skipping it would report success for a change that never
 * happened.
 *
 * `REMOVED` is refused (no-delete policy); use `HIDDEN` to stop an action from
 * counting while keeping its history.
 *
 * @param {string} customerId
 * @param {Array<object>} items - rows with `id` (or `resourceName`) + the fields to change
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} Summary with a per-action from→to diff
 */
export async function updateConversionActions(customerId, items, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak konwersji do zmiany (pusta lista).');

  const problems = [];
  const warnings = [];
  const rows = items.map((it, i) => {
    const row = normalizeConversionRow(it);
    const ref = row.label || row.id || `wiersz ${i + 1}`;
    const idFromRn = row.resourceName ? String(row.resourceName).split('/').pop() : undefined;
    const id = (row.id || idFromRn || '').replace(/[^0-9]/g, '');
    if (!id) problems.push(`${ref}: brak id konwersji (kolumna id albo resource_name).`);
    const check = checkConversionAction(row, { isUpdate: true });
    check.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    check.warnings.forEach((w) => warnings.push(w));

    const CHANGEABLE = ['name', 'category', 'status', 'countingType', 'attributionModel', 'primaryForGoal',
      'defaultValue', 'currency', 'alwaysUseDefaultValue', 'clickLookbackDays', 'viewLookbackDays'];
    const changes = CHANGEABLE.filter((k) => row[k] !== undefined);
    // `type` is immutable once the action exists — the API rejects it, so catch it
    // here. It also answers "this row changes nothing", so don't say both.
    if (row.type !== undefined) problems.push(`${ref}: typu konwersji (type) nie da się zmienić po utworzeniu — założ nową konwersję i ukryj starą (status=HIDDEN).`);
    else if (changes.length === 0) problems.push(`${ref}: wiersz nie zmienia żadnego pola.`);
    return { ...row, id, label: ref, changes };
  });

  if (problems.length) {
    throw new Error(`🛑 Zablokowano — ${problems.length} problem(ów) walidacji, nic nie zapisano:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
  }

  const current = await getConversionActions(cleanCustomerId, { loginCustomerId, all: true });
  const byId = new Map(current.map((a) => [a.id, a]));
  const missing = rows.filter((r) => !byId.has(r.id));
  if (missing.length) {
    throw new Error(`🛑 Zablokowano — ${missing.length} konwersji nie ma w koncie (id: ${missing.map((m) => m.id).join(', ')}), nic nie zapisano.`);
  }

  const diff = rows.map((r) => {
    const cur = byId.get(r.id);
    const fields = {};
    for (const k of r.changes) fields[k] = { from: cur[k] ?? null, to: r[k] };
    return { id: r.id, name: cur.name, changed: r.changes, fields };
  });

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Zmiana ${rows.length} konwersji...`);
  if (dryRun) {
    return { success: true, dryRun: true, entity: 'conversion_action', count: rows.length, diff, warnings };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const resources = rows.map((r) => ({
      resource_name: byId.get(r.id).resourceName || `customers/${cleanCustomerId}/conversionActions/${r.id}`,
      ...buildConversionResource(r, byId.get(r.id)),
    }));
    const responses = [];
    for (const part of chunk(resources)) responses.push(await customer.conversionActions.update(part));

    return {
      success: true, dryRun: false, entity: 'conversion_action',
      updated: rows.length, chunks: responses.length, diff, warnings,
      resourceNames: mutatedResourceNames(responses),
    };
  } catch (error) {
    throw new Error(`Nie udało się zmienić konwersji: ${unpackError(error)}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Performance Max: flipping ONE listing-group filter leaf
 *
 * Why this is a remove+create and not an update: `type` is IMMUTABLE on
 * AssetGroupListingGroupFilter (only `case_value` is mutable), so there is no
 * update that turns an exclusion into an inclusion. See the carve-out note above
 * `checkListingFilterFlip` in safety.js for what that costs and how it is fenced.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Rebuild the `case_value` payload of a node from the shape `getListingFilterTree`
 * read back, so the replacement leaf splits on exactly the same dimension value.
 *
 * A catch-all node carries the dimension and its level/index but no value — that
 * absence IS the meaning ("everything else at this level"), so it is preserved
 * rather than filled in.
 *
 * @param {{kind:string|null, value:string|null, level:number|null, index:number|null}} dim
 * @returns {object|null} case_value for the create operation
 */
export function rebuildListingCaseValue(dim) {
  if (!dim || !dim.kind) return null;
  const val = dim.value;
  const withValue = (key) => (val === null ? {} : { [key]: val });
  const withLevel = () => (dim.level === null || dim.level === undefined ? {} : { level: dim.level });
  switch (dim.kind) {
    case 'product_type':
      return { product_type: { ...withValue('value'), ...withLevel() } };
    case 'product_category':
      return { product_category: { ...withValue('category_id'), ...withLevel() } };
    case 'product_brand':
      return { product_brand: { ...withValue('value') } };
    case 'product_item_id':
      return { product_item_id: { ...withValue('value') } };
    case 'product_custom_attribute':
      return {
        product_custom_attribute: {
          ...withValue('value'),
          ...(dim.index === null || dim.index === undefined ? {} : { index: dim.index }),
        },
      };
    case 'product_channel':
      return { product_channel: { channel: val } };
    case 'product_condition':
      return { product_condition: { condition: val } };
    default:
      return null;
  }
}

/**
 * Pick the one node a selector refers to, or explain why it can't.
 *
 * Refuses ambiguity rather than guessing: the same product type legitimately
 * appears more than once in a tree (once per subdivision branch), and flipping
 * the wrong copy is a silent mistake that only shows up in next month's spend.
 *
 * @param {Array<object>} tree
 * @param {{filterId?: string|number, productType?: string}} selector
 * @returns {{node: object|null, error: string|null}}
 */
export function selectListingFilterNode(tree, selector = {}) {
  const nodes = tree || [];
  const filterId = String(selector.filterId ?? '').replace(/[^0-9]/g, '');
  if (filterId) {
    const node = nodes.find((n) => String(n.id) === filterId);
    if (!node) {
      return { node: null, error: `Nie ma węzła o id ${filterId} w tej grupie plików. Dostępne id: ${nodes.map((n) => n.id).join(', ')}` };
    }
    return { node, error: null };
  }

  const wanted = String(selector.productType ?? '').trim().toLowerCase();
  if (!wanted) {
    return { node: null, error: 'Wskaż węzeł: --product-type="typ produktu" albo --filter-id=<ID>.' };
  }
  const hits = nodes.filter(
    (n) => n.dimension.kind === 'product_type'
      && n.dimension.value !== null
      && String(n.dimension.value).trim().toLowerCase() === wanted
  );
  if (hits.length === 0) {
    const available = nodes
      .filter((n) => n.dimension.kind === 'product_type' && n.dimension.value !== null)
      .map((n) => `"${n.dimension.value}"`)
      .sort();
    return {
      node: null,
      error: `Nie ma typu produktu "${selector.productType}" w tej grupie plików.`
        + (available.length ? ` Są za to: ${[...new Set(available)].join(', ')}` : ' Ta grupa nie dzieli się po typie produktu.'),
    };
  }
  if (hits.length > 1) {
    const list = hits.map((n) => `id=${n.id} (${n.typeName}, poziom ${n.dimension.level ?? '?'})`).join('; ');
    return {
      node: null,
      error: `Typ "${selector.productType}" występuje ${hits.length} razy w tym drzewie — nie zgaduję który. Wskaż --filter-id=<ID>. Kandydaci: ${list}`,
    };
  }
  return { node: hits[0], error: null };
}

/**
 * Flip ONE listing-group filter leaf between included and excluded.
 *
 * The routine seasonal edit on a Performance Max account: a product type that is
 * excluded out of season has to be let back in, and no status field can express
 * that. Scope is deliberately one leaf per call — a dry-run you can read in full
 * is the only real protection on a tree this easy to break.
 *
 * @param {string} customerId
 * @param {string|number} assetGroupId
 * @param {{filterId?: string|number, productType?: string}} selector
 * @param {'INCLUDED'|'EXCLUDED'} to
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @returns {Promise<object>} plan (dry-run, validated by Google) or the mutate result
 */
export async function updateListingFilter(customerId, assetGroupId, selector, to, dryRun = false, loginCustomerId) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const cleanAssetGroupId = String(assetGroupId ?? '').replace(/[^0-9]/g, '');
  if (!cleanAssetGroupId) throw new Error('update-listing-filter wymaga --asset-group=<ID grupy plików>.');

  const tree = await getListingFilterTree(cleanCustomerId, cleanAssetGroupId, { loginCustomerId });
  if (tree.length === 0) {
    throw new Error(`🛑 Grupa plików ${cleanAssetGroupId} nie ma drzewa filtrów (albo nie istnieje / jest usunięta). Nic nie zmieniono.`);
  }

  const { node, error } = selectListingFilterNode(tree, selector);
  if (error) throw new Error(`🛑 ${error}`);

  const verdict = checkListingFilterFlip(node, tree, to);
  if (!verdict.ok) throw new Error(`🛑 ${verdict.reason}`);

  const assetGroupName = node.assetGroupName;
  const base = {
    assetGroupId: cleanAssetGroupId,
    assetGroupName,
    assetGroupStatus: node.assetGroupStatus,
    filterId: node.id,
    dimension: node.dimension.label,
    from: node.typeName,
    to: LISTING_FILTER_TYPE_NAME[verdict.targetType],
  };

  if (verdict.noop) {
    console.log(`[Mutator] Węzeł ${node.id} już jest ${base.to} — nic do zrobienia.`);
    return { success: true, dryRun, changed: 0, noop: true, ...base };
  }

  const caseValue = rebuildListingCaseValue(node.dimension);
  if (!caseValue) {
    throw new Error(
      `🛑 Nie umiem odtworzyć warunku węzła ${node.id} (wymiar: ${node.dimension.kind || 'nieznany'}). ` +
      'Bez wiernej kopii warunku przełączenie zmieniłoby zakres grupy plików. Zrób to ręcznie w panelu.'
    );
  }

  // Order matters: the old leaf must be gone before its replacement lands, or
  // the parent would momentarily hold two leaves with the same case value.
  const mutations = [
    {
      entity: 'AssetGroupListingGroupFilter',
      operation: 'remove',
      resource: node.resourceName,
    },
    {
      entity: 'AssetGroupListingGroupFilter',
      operation: 'create',
      resource: {
        asset_group: `customers/${cleanCustomerId}/assetGroups/${cleanAssetGroupId}`,
        type: verdict.targetType,
        ...(node.listingSource === null || node.listingSource === undefined
          ? {}
          : { listing_source: node.listingSource }),
        parent_listing_group_filter: node.parentResourceName,
        case_value: caseValue,
      },
    },
  ];

  const warning = 'Węzeł dostanie NOWE id, więc jego historia statystyk w panelu zaczyna się od zera '
    + '(historia kampanii i produktów zostaje nietknięta).';

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}${assetGroupName}: ${base.dimension} ${base.from} → ${base.to}...`);

  if (dryRun) {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const check = await validateWithApi(customer, [mutations]);
    return {
      success: check.ok,
      dryRun: true,
      ...base,
      operations: ['remove ' + node.resourceName, 'create ' + base.to],
      warning,
      googleValidation: check.ok ? 'OK' : `ODRZUCONE: ${check.error}`,
    };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const response = await customer.mutateResources(mutations);
    return {
      success: true,
      dryRun: false,
      changed: 1,
      ...base,
      warning,
      resourceNames: mutatedResourceNames([response]),
    };
  } catch (error) {
    throw new Error(`Nie udało się przełączyć filtra: ${unpackError(error)}`);
  }
}
/* ────────────────────────────────────────────────────────────────────────────
 * PMax: dorównanie węzłów `product_type` do feedu
 *
 * Drzewo filtrów trzyma nazwy kategorii przepisane z ręki, a feed potrafi je
 * zmienić z dnia na dzień (inna aplikacja sklepu, przebudowa kategorii). Węzeł
 * z nieistniejącą nazwą nie rzuca błędu — po prostu przestaje cokolwiek łapać:
 * grupa plików głodnieje, a wykluczenie przestaje chronić. Widać to dopiero
 * w wydatkach, bo produkty spadają do gałęzi „wszystko inne".
 *
 * `update-listing-filter` przełącza WYŁĄCZNIE istniejący liść, więc nie dokłada
 * nowej nazwy ani nie sprząta martwej. Ta akcja robi jedno i drugie wsadowo,
 * w jednym żądaniu na grupę plików.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Dopuszczalne wartości kolumny `action` w pliku wsadowym. */
const LISTING_TYPE_ACTIONS = new Set(['INCLUDED', 'EXCLUDED', 'REMOVE']);

/**
 * Plan operacji dorównujących węzły `product_type` jednej grupy plików.
 *
 * Czysta funkcja — żadnego wywołania API, więc plan da się obejrzeć i przetestować
 * offline. Wszystkie liście muszą wisieć pod JEDNYM podziałem po typie produktu:
 * ten sam typ w dwóch gałęziach znaczy co innego w każdej z nich, a zgadywanie
 * której dotyczy wiersz to cicha pomyłka widoczna dopiero w wydatkach.
 *
 * @param {Array<object>} tree - drzewo z `getListingFilterTree`
 * @param {Array<{productType: string, to: 'INCLUDED'|'EXCLUDED'|'REMOVE'}>} items
 * @param {{customerId: string, assetGroupId: string}} opts
 * @returns {{mutations: Array<object>, plan: Array<object>, added: number, flipped: number, removed: number, noop: number}}
 */
export function buildListingTypeMutations(tree, items, opts) {
  const { customerId, assetGroupId } = opts;
  const assetGroup = `customers/${customerId}/assetGroups/${assetGroupId}`;
  const entity = 'AssetGroupListingGroupFilter';
  const norm = (v) => String(v ?? '').trim().toLowerCase();

  const typeNodes = (tree || []).filter(
    (n) => n.dimension.kind === 'product_type' && n.dimension.value !== null,
  );
  if (typeNodes.length === 0) {
    throw new Error(
      '🛑 Ta grupa plików nie dzieli się po typie produktu, więc nie ma gdzie dołożyć węzła. '
      + 'Podział trzeba najpierw założyć w panelu — dokładanie go tutaj oznaczałoby przebudowę całego drzewa.',
    );
  }
  const parents = new Set(typeNodes.map((n) => n.parentResourceName));
  if (parents.size > 1) {
    throw new Error(
      `🛑 Typy produktów wiszą pod ${parents.size} różnymi podziałami — ten sam typ znaczy co innego w każdej gałęzi. `
      + 'Nie zgaduję której dotyczy wiersz. Zrób to w panelu. Nic nie zmieniono.',
    );
  }
  const parent = [...parents][0];
  const { level } = typeNodes[0].dimension;
  const listingSource = typeNodes[0].listingSource;
  const src = listingSource === null || listingSource === undefined ? {} : { listing_source: listingSource };

  const mutations = [];
  const plan = [];
  let added = 0; let flipped = 0; let removed = 0; let noop = 0;
  // Stan docelowy gałęzi, żeby sprawdzić, czy po zmianie zostaje co wyświetlać.
  const finalType = new Map(typeNodes.map((n) => [norm(n.dimension.value), n.type]));
  const seen = new Set();

  for (const it of items) {
    const wanted = norm(it.productType);
    const to = String(it.to ?? '').trim().toUpperCase();
    if (!wanted) throw new Error('🛑 Wiersz bez nazwy typu produktu (kolumna product_type).');
    if (!LISTING_TYPE_ACTIONS.has(to)) {
      throw new Error(`🛑 "${it.productType}": nieznana operacja "${it.to}". Dozwolone: INCLUDED, EXCLUDED, REMOVE.`);
    }
    if (seen.has(wanted)) throw new Error(`🛑 Typ "${it.productType}" występuje w pliku dwa razy — plan byłby niejednoznaczny.`);
    seen.add(wanted);

    const existing = typeNodes.find((n) => norm(n.dimension.value) === wanted);

    if (to === 'REMOVE') {
      if (!existing) { plan.push({ productType: it.productType, action: 'REMOVE', result: 'nie ma go w drzewie — pomijam' }); noop += 1; continue; }
      if (existing.childIds.length) {
        throw new Error(
          `🛑 Węzeł "${it.productType}" ma pod sobą ${existing.childIds.length} podwęzłów — usunięcie zabrałoby też je. `
          + 'Rozwiąż to w panelu. Nic nie zmieniono.',
        );
      }
      mutations.push({ entity, operation: 'remove', resource: existing.resourceName });
      finalType.delete(wanted);
      plan.push({ productType: it.productType, action: 'REMOVE', result: `usuwam węzeł ${existing.id} (${existing.typeName})` });
      removed += 1;
      continue;
    }

    const targetType = to === 'INCLUDED' ? 3 : 4;
    const caseValue = { product_type: { value: String(it.productType).trim(), ...(level === null || level === undefined ? {} : { level }) } };

    if (!existing) {
      mutations.push({
        entity,
        operation: 'create',
        resource: { asset_group: assetGroup, type: targetType, ...src, parent_listing_group_filter: parent, case_value: caseValue },
      });
      finalType.set(wanted, targetType);
      plan.push({ productType: it.productType, action: to, result: 'dokładam nowy węzeł' });
      added += 1;
      continue;
    }
    if (existing.type === targetType) {
      plan.push({ productType: it.productType, action: to, result: `węzeł ${existing.id} już jest ${existing.typeName}` });
      noop += 1;
      continue;
    }
    // `type` jest niezmienne — przełączenie to usunięcie i utworzenie przeciwnego liścia.
    mutations.push({ entity, operation: 'remove', resource: existing.resourceName });
    mutations.push({
      entity,
      operation: 'create',
      resource: { asset_group: assetGroup, type: targetType, ...src, parent_listing_group_filter: parent, case_value: caseValue },
    });
    finalType.set(wanted, targetType);
    plan.push({ productType: it.productType, action: to, result: `przełączam węzeł ${existing.id}: ${existing.typeName} → ${LISTING_FILTER_TYPE_NAME[targetType]}` });
    flipped += 1;
  }

  // Gałąź bez ani jednego włączonego liścia przestaje wyświetlać cokolwiek — chyba
  // że ratuje ją włączone „wszystko inne" obok. To jedyny sposób, w jaki ta akcja
  // może wyłączyć grupę plików, więc sprawdzamy to przed wysłaniem.
  const catchAll = (tree || []).find((n) => n.parentResourceName === parent && n.dimension.value === null);
  const catchAllServes = Boolean(catchAll && catchAll.type === 3);
  const anyIncluded = [...finalType.values()].some((t) => t === 3);
  if (!anyIncluded && !catchAllServes) {
    throw new Error(
      '🛑 Po tej zmianie w gałęzi nie zostaje ANI JEDEN włączony typ produktu, a „wszystko inne" jest wykluczone — '
      + 'grupa plików przestałaby wyświetlać cokolwiek. Nic nie zmieniono.',
    );
  }

  if (mutations.length > MUTATE_CHUNK) {
    throw new Error(
      `🛑 Plan to ${mutations.length} operacji, a jedno żądanie mieści ${MUTATE_CHUNK}. `
      + 'Podziel plik na mniejsze partie — rozbicie jednej grupy plików na kilka żądań zostawiłoby drzewo w połowie zmienione.',
    );
  }
  return { mutations, plan, added, flipped, removed, noop };
}

/**
 * Dorównaj węzły `product_type` JEDNEJ grupy plików do podanej listy.
 *
 * @param {string} customerId
 * @param {string|number} assetGroupId
 * @param {Array<{productType: string, to: string}>} items
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{snapshotPath?: string|null}} [opts]
 * @returns {Promise<object>} plan (symulacja walidowana przez Google) albo wynik zapisu
 */
export async function syncListingTypes(customerId, assetGroupId, items, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const cleanAssetGroupId = String(assetGroupId ?? '').replace(/[^0-9]/g, '');
  if (!cleanAssetGroupId) throw new Error('sync-listing-types wymaga ID grupy plików.');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Brak wierszy do wprowadzenia (pusta lista).');

  const surowe = await getListingFilterTree(cleanCustomerId, cleanAssetGroupId, { loginCustomerId });
  if (surowe.length === 0) {
    throw new Error(`🛑 Grupa plików ${cleanAssetGroupId} nie ma drzewa filtrów (albo nie istnieje / jest usunięta). Nic nie zmieniono.`);
  }
  const tree = inferCatchAllDimensions(surowe);
  const assetGroupName = (tree[0] && tree[0].assetGroupName) || '';

  const { mutations, plan, added, flipped, removed, noop } = buildListingTypeMutations(tree, items, {
    customerId: cleanCustomerId,
    assetGroupId: cleanAssetGroupId,
  });

  const base = {
    assetGroupId: cleanAssetGroupId,
    assetGroupName,
    assetGroupStatus: (tree[0] && tree[0].assetGroupStatus) || null,
    nodesBefore: tree.length,
    added,
    flipped,
    removed,
    noop,
    plan,
  };

  if (mutations.length === 0) {
    console.log(`[Mutator] ${assetGroupName}: drzewo już zgadza się z listą — nic do zrobienia.`);
    return { success: true, dryRun, changed: 0, noop: true, ...base };
  }

  const warning = 'Dołożone i przełączone węzły dostają NOWE id, więc ich statystyki w panelu startują od zera '
    + '(historia kampanii i produktów zostaje nietknięta).';

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}${assetGroupName}: +${added} dołożone, ${flipped} przełączone, ${removed} usunięte...`);

  const customer = getCustomer(cleanCustomerId, loginCustomerId);

  if (dryRun) {
    const check = await validateWithApi(customer, [mutations]);
    return {
      success: check.ok,
      dryRun: true,
      ...base,
      operations: mutations.length,
      warning,
      googleValidation: check.ok ? 'OK' : `ODRZUCONE: ${check.error}`,
    };
  }

  // Snapshot PRZED mutacją — jedyna droga powrotu do poprzedniego kształtu drzewa.
  let snapshot = null;
  if (opts.snapshotPath) {
    writeFileSync(opts.snapshotPath, JSON.stringify({
      customerId: cleanCustomerId, assetGroupId: cleanAssetGroupId, assetGroupName,
      savedAt: new Date().toISOString(), tree,
    }, null, 1));
    snapshot = opts.snapshotPath;
    console.log(`[Mutator] Snapshot drzewa sprzed zmiany: ${snapshot}`);
  }

  try {
    const response = await customer.mutateResources(mutations);
    return {
      success: true,
      dryRun: false,
      changed: mutations.length,
      ...base,
      warning,
      snapshot,
      resourceNames: mutatedResourceNames([response]),
    };
  } catch (error) {
    throw new Error(`Nie udało się dorównać typów produktów: ${unpackError(error)}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * PMax: wykluczenie etykiety niestandardowej (custom_label_N)
 *
 * Feed oznacza śmieci etykietą, a każda grupa plików ma ją wykluczać — jeden
 * przełącznik na cały katalog zamiast wyliczania pojedynczych produktów. Grupa,
 * której ten węzeł brakuje, po cichu wyświetla wszystko, co reszta konta już
 * wykluczyła, i widać to dopiero po miesiącach w wydatkach.
 *
 * Dlaczego ta jedna akcja USUWA kryteria, choć connector zasadniczo tego nie robi:
 * podział rozdziela po JEDNYM wymiarze, więc etykieta wchodząca jako pierwszy
 * podział wymaga przeniesienia dotychczasowego drzewa pod jej gałąź „wszystko
 * inne" — a kryterium nie da się przepiąć, tylko odtworzyć. W drzewie filtrów
 * PMax usunięcie jest odwracalne inaczej niż gdzie indziej: to czysta
 * konfiguracja kierowania, historia wydatków siedzi na kampanii i produktach,
 * a snapshot sprzed zmiany pozwala odtworzyć poprzedni kształt.
 * ──────────────────────────────────────────────────────────────────────────── */

/** `ProductCustomAttributeIndex`: INDEX0 = 2, bo 0 i 1 zajmują UNSPECIFIED i UNKNOWN. */
const CUSTOM_LABEL_ENUM_OFFSET = 2;

/**
 * Dopisz wymiar węzłom „wszystko inne", których API nie opisuje.
 *
 * Węzeł zbiorczy nie ma wartości, a `product_item_id` i `product_brand` nie mają
 * też pola `level` — więc w odczycie wychodzą BEZ ŚLADU tego, po czym dzielą,
 * nie do odróżnienia od korzenia. Przy samym przełączaniu liścia to nie
 * przeszkadzało; przy przebudowie oznacza węzeł, którego nie da się odtworzyć,
 * i przebudowa słusznie odmawia.
 *
 * Rozstrzyga rodzeństwo: wszystkie dzieci jednego podziału dzielą po TYM SAMYM
 * wymiarze, więc brakujący wymiar bierzemy od siostry, która go ma. Zgadywania
 * tu nie ma — gdy żadna siostra nie ma wymiaru, węzeł zostaje nieopisany
 * i wyżej odpala się odmowa.
 *
 * @param {Array<object>} tree
 * @returns {Array<object>} kopia drzewa z uzupełnionymi wymiarami
 */
export function inferCatchAllDimensions(tree) {
  return (tree || []).map((n) => {
    if (!n.parentResourceName) return n;          // korzeń nie ma warunku
    if (n.dimension && n.dimension.kind) return n;
    const siostra = tree.find((s) => s.parentResourceName === n.parentResourceName
      && s.resourceName !== n.resourceName
      && s.dimension && s.dimension.kind);
    if (!siostra) return n;
    return {
      ...n,
      dimension: {
        kind: siostra.dimension.kind,
        value: null,
        level: siostra.dimension.level ?? null,
        index: siostra.dimension.index ?? null,
        label: '(POZOSTAŁE)',
      },
    };
  });
}


/**
 * Wspólny mechanizm PRZEBUDOWY drzewa filtrów: nowy pierwszy podział z wykluczeniami
 * obok gałęzi „wszystko inne", pod którą ląduje całe dotychczasowe drzewo.
 *
 * Używają go obie ścieżki wykluczania (etykieta i ID produktów), bo ryzykowna część jest
 * dokładnie ta sama i ma istnieć raz: kolejność operacji, wykrycie sierot i limit jednego
 * żądania. Kolejność jest istotna i jest tu zagwarantowana — usunięcia idą od liści w górę,
 * tworzenia od korzenia w dół, wszystko w JEDNYM mutate (identyfikatory tymczasowe
 * rozwiązują się tylko w obrębie jednego żądania, a częściowa przebudowa zostawiłaby grupę
 * bez drzewa).
 */
function planujPrzebudowe(tree, root, { assetGroup, entity, temp, src, podzialBezWartosci, wykluczenia }) {
  const create = (resource) => ({ entity, operation: 'create', resource });
  const remove = (resourceName) => ({ entity, operation: 'remove', resource: resourceName });
  const childrenOf = (rn) => tree.filter((n) => n.parentResourceName === rn);

  // Usuwamy od najgłębszych: kasowanie podziału przed jego dziećmi bywa odrzucane,
  // a nawet gdy przechodzi, plan przestaje być czytelny.
  const depth = new Map([[root.resourceName, 0]]);
  const queue = [root];
  while (queue.length) {
    const n = queue.shift();
    for (const kid of childrenOf(n.resourceName)) {
      depth.set(kid.resourceName, depth.get(n.resourceName) + 1);
      queue.push(kid);
    }
  }
  const stare = tree.filter((n) => n.resourceName !== root.resourceName);
  const orphans = stare.filter((n) => !depth.has(n.resourceName));
  if (orphans.length) {
    throw new Error(
      `🛑 ${orphans.length} węzłów nie wisi pod korzeniem — odczyt drzewa jest niepełny i przebudowa zgubiłaby je. Nic nie zmieniono.`
    );
  }
  const removes = [...stare]
    .sort((a, b) => depth.get(b.resourceName) - depth.get(a.resourceName))
    .map((n) => remove(n.resourceName));

  const elseRn = temp();
  const creates = [
    create({
      asset_group: assetGroup,
      resource_name: elseRn,
      type: 2,
      ...src(root),
      parent_listing_group_filter: root.resourceName,
      case_value: podzialBezWartosci,
    }),
    ...wykluczenia.map((caseValue) => create({
      asset_group: assetGroup,
      type: 4,
      ...src(root),
      parent_listing_group_filter: root.resourceName,
      case_value: caseValue,
    })),
  ];

  // Odtworzenie w kolejności BFS, żeby rodzic zawsze powstawał przed dzieckiem.
  const nowyRn = new Map([[root.resourceName, elseRn]]);
  const kolejka = [...childrenOf(root.resourceName)];
  while (kolejka.length) {
    const n = kolejka.shift();
    const caseValue = rebuildListingCaseValue(n.dimension);
    if (!caseValue) {
      throw new Error(
        `🛑 Nie umiem odtworzyć warunku węzła ${n.id} (wymiar: ${n.dimension.kind || 'nieznany'}). ` +
        'Bez wiernej kopii przebudowa zmieniłaby zakres grupy plików. Nic nie zmieniono.'
      );
    }
    const rn = temp();
    nowyRn.set(n.resourceName, rn);
    creates.push(create({
      asset_group: assetGroup,
      resource_name: rn,
      type: n.type,
      ...src(n),
      parent_listing_group_filter: nowyRn.get(n.parentResourceName),
      case_value: caseValue,
    }));
    kolejka.push(...childrenOf(n.resourceName));
  }

  const mutations = [...removes, ...creates];
  if (mutations.length > MUTATE_CHUNK) {
    throw new Error(
      `🛑 Przebudowa to ${mutations.length} operacji, a jedno żądanie mieści ${MUTATE_CHUNK}. ` +
      'Podziel listę ID na mniejsze partie albo przebuduj drzewo w panelu — podzielenie samej przebudowy na partie ' +
      'zostawiłoby grupę bez drzewa między żądaniami.'
    );
  }
  return { mutations, removed: removes.length, created: creates.length };
}

/**
 * Zbuduj operacje wprowadzające `custom_label_<index> = <value>` jako WYKLUCZONY.
 *
 * Czysta funkcja — żadnego wywołania API, więc plan da się obejrzeć i przetestować
 * offline. Kolejność operacji jest istotna i jest tu zagwarantowana:
 * usunięcia idą od liści w górę, tworzenia od korzenia w dół, wszystko w JEDNYM
 * mutate (identyfikatory tymczasowe rozwiązują się tylko w obrębie jednego
 * żądania, a częściowa przebudowa zostawiłaby grupę bez drzewa).
 *
 * @param {Array<object>} tree - drzewo z `getListingFilterTree`
 * @param {{mode: string, node: object|null, root: object|null}} plan - werdykt `checkLabelExclusion`
 * @param {{customerId: string, assetGroupId: string, index: number, value: string}} opts
 * @returns {{mutations: Array<object>, removed: number, created: number}}
 */
export function buildLabelExclusionMutations(tree, plan, opts) {
  const { customerId, assetGroupId, index, value } = opts;
  const assetGroup = `customers/${customerId}/assetGroups/${assetGroupId}`;
  const entity = 'AssetGroupListingGroupFilter';

  let seq = 0;
  const temp = () => `customers/${customerId}/assetGroupListingGroupFilters/${assetGroupId}~${-(++seq)}`;
  const src = (n) => (n.listingSource === null || n.listingSource === undefined ? {} : { listing_source: n.listingSource });
  const labelCase = (withValue) => ({
    product_custom_attribute: {
      index: index + CUSTOM_LABEL_ENUM_OFFSET,
      ...(withValue ? { value } : {}),
    },
  });
  const create = (resource) => ({ entity, operation: 'create', resource });
  const remove = (resourceName) => ({ entity, operation: 'remove', resource: resourceName });

  if (plan.mode === 'flip') {
    const node = plan.node;
    return {
      mutations: [
        remove(node.resourceName),
        create({
          asset_group: assetGroup,
          type: 4,
          ...src(node),
          parent_listing_group_filter: node.parentResourceName,
          case_value: labelCase(true),
        }),
      ],
      removed: 1,
      created: 1,
    };
  }

  const root = plan.root;

  if (plan.mode === 'add') {
    return {
      mutations: [
        create({
          asset_group: assetGroup,
          type: 4,
          ...src(root),
          parent_listing_group_filter: root.resourceName,
          case_value: labelCase(true),
        }),
      ],
      removed: 0,
      created: 1,
    };
  }

  // ── rebuild ───────────────────────────────────────────────────────────────
  return planujPrzebudowe(tree, root, {
    assetGroup, entity, temp, src,
    podzialBezWartosci: labelCase(false),
    wykluczenia: [labelCase(true)],
  });
}

/**
 * Ensure one PMax asset group excludes `custom_label_<index> = <value>`.
 *
 * @param {string} customerId
 * @param {string|number} assetGroupId
 * @param {{index: number, value: string}} label
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{snapshotPath?: string}} [opts]
 * @returns {Promise<object>} plan (dry-run, sprawdzony przez Google) albo wynik mutate
 */
export async function addLabelExclusion(customerId, assetGroupId, label, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const cleanAssetGroupId = String(assetGroupId ?? '').replace(/[^0-9]/g, '');
  if (!cleanAssetGroupId) throw new Error('add-label-exclusion wymaga --asset-group=<ID grupy plików>.');

  const surowe = await getListingFilterTree(cleanCustomerId, cleanAssetGroupId, { loginCustomerId });
  const tree = inferCatchAllDimensions(surowe);
  const plan = checkLabelExclusion(tree, label);
  if (!plan.ok) throw new Error(`🛑 ${plan.reason}`);

  const assetGroupName = (tree[0] && tree[0].assetGroupName) || '';
  const etykieta = `custom_label_${label.index} = "${label.value}"`;
  const base = {
    assetGroupId: cleanAssetGroupId,
    assetGroupName,
    label: etykieta,
    mode: plan.mode,
    nodesBefore: tree.length,
  };

  if (plan.mode === 'noop') {
    console.log(`[Mutator] ${assetGroupName}: ${etykieta} już jest wykluczone — nic do zrobienia.`);
    return { success: true, dryRun, changed: 0, noop: true, ...base };
  }

  const { mutations, removed, created } = buildLabelExclusionMutations(tree, plan, {
    customerId: cleanCustomerId,
    assetGroupId: cleanAssetGroupId,
    index: Number(label.index),
    value: String(label.value).trim(),
  });

  const warning = plan.mode === 'rebuild'
    ? `Przebudowa: ${removed} węzłów zostaje odtworzonych pod gałęzią „wszystko inne". `
      + 'Zakres kierowania nie zmienia się, ale węzły dostają NOWE id, więc ich statystyki w panelu startują od zera '
      + '(historia kampanii i produktów zostaje nietknięta).'
    : 'Węzeł dostanie NOWE id, więc jego historia statystyk w panelu zaczyna się od zera.';

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}${assetGroupName}: ${etykieta} → WYKLUCZONE (${plan.mode}, ${removed} usunięć + ${created} utworzeń)...`);

  const customer = getCustomer(cleanCustomerId, loginCustomerId);

  if (dryRun) {
    const check = await validateWithApi(customer, [mutations]);
    return {
      success: check.ok,
      dryRun: true,
      ...base,
      removed,
      created,
      warning,
      googleValidation: check.ok ? 'OK' : `ODRZUCONE: ${check.error}`,
    };
  }

  // Snapshot PRZED mutacją — jedyna droga powrotu do poprzedniego kształtu drzewa.
  // Zapis musi się udać, zanim cokolwiek pójdzie do API.
  let snapshot = null;
  if (opts.snapshotPath) {
    writeFileSync(opts.snapshotPath, JSON.stringify({
      customerId: cleanCustomerId, assetGroupId: cleanAssetGroupId, assetGroupName,
      savedAt: new Date().toISOString(), tree,
    }, null, 1));
    snapshot = opts.snapshotPath;
    console.log(`[Mutator] Snapshot drzewa sprzed zmiany: ${snapshot}`);
  }

  try {
    const response = await customer.mutateResources(mutations);
    return {
      success: true,
      dryRun: false,
      changed: removed + created,
      ...base,
      removed,
      created,
      snapshot,
      warning,
      resourceNames: mutatedResourceNames([response]),
    };
  } catch (error) {
    throw new Error(`Nie udało się wprowadzić wykluczenia etykiety: ${unpackError(error)}`);
  }
}

/**
 * Zbuduj operacje wykluczające konkretne ID PRODUKTÓW z jednej grupy plików PMax.
 *
 * Czysta funkcja — żadnego wywołania API, więc plan da się obejrzeć i przetestować offline.
 *
 * ID zapisujemy MAŁYMI LITERAMI, bo tak trzyma je API (Google Ads raportuje
 * `shopify_pl_…` tam, gdzie feed ma `shopify_PL_…`). Wysłanie wersji z feedu utworzyłoby
 * drugi węzeł obok istniejącego przy każdym ponownym uruchomieniu.
 *
 * @param {Array<object>} tree - drzewo z `getListingFilterTree`
 * @param {object} plan - werdykt `checkItemExclusion`
 * @param {{customerId: string, assetGroupId: string}} opts
 * @returns {{mutations: Array<object>, removed: number, created: number}}
 */
export function buildItemExclusionMutations(tree, plan, opts) {
  const { customerId, assetGroupId } = opts;
  const assetGroup = `customers/${customerId}/assetGroups/${assetGroupId}`;
  const entity = 'AssetGroupListingGroupFilter';

  let seq = 0;
  const temp = () => `customers/${customerId}/assetGroupListingGroupFilters/${assetGroupId}~${-(++seq)}`;
  const src = (n) => (n.listingSource === null || n.listingSource === undefined ? {} : { listing_source: n.listingSource });
  const itemCase = (value) => ({ product_item_id: value ? { value } : {} });
  const create = (resource) => ({ entity, operation: 'create', resource });
  const remove = (resourceName) => ({ entity, operation: 'remove', resource: resourceName });

  if (plan.mode === 'rebuild') {
    // Wszystkie żądane ID lądują jako wykluczone liście NOWEGO pierwszego podziału.
    // Stare drzewo jest odtwarzane wiernie pod gałęzią „wszystko inne" — jeżeli miało
    // własny węzeł na któreś z tych ID, jest on odtąd nieosiągalny (produkt trafia
    // najpierw w wykluczenie przy korzeniu), ale nie zmienia zakresu kierowania.
    const wszystkie = [...plan.doPrzelaczenia.map((n) => String(n.dimension.value).toLowerCase()), ...plan.doDodania];
    return planujPrzebudowe(tree, plan.root, {
      assetGroup, entity, temp, src,
      podzialBezWartosci: itemCase(null),
      wykluczenia: wszystkie.map((id) => itemCase(id)),
    });
  }

  // ── apply: korzeń już dzieli po product_item_id ───────────────────────────
  const mutations = [];
  for (const node of plan.doPrzelaczenia) {
    // API nie pozwala zmienić typu węzła, więc przełączenie to usunięcie starego
    // liścia i utworzenie przeciwnego — tak samo robi to panel.
    mutations.push(remove(node.resourceName));
    mutations.push(create({
      asset_group: assetGroup,
      type: 4,
      ...src(node),
      parent_listing_group_filter: node.parentResourceName,
      case_value: itemCase(String(node.dimension.value).toLowerCase()),
    }));
  }
  for (const id of plan.doDodania) {
    mutations.push(create({
      asset_group: assetGroup,
      type: 4,
      ...src(plan.root),
      parent_listing_group_filter: plan.root.resourceName,
      case_value: itemCase(id),
    }));
  }
  if (mutations.length > MUTATE_CHUNK) {
    throw new Error(
      `🛑 To ${mutations.length} operacji, a jedno żądanie mieści ${MUTATE_CHUNK}. Podziel listę ID na mniejsze partie.`
    );
  }
  return { mutations, removed: plan.doPrzelaczenia.length, created: plan.doPrzelaczenia.length + plan.doDodania.length };
}

/**
 * Wyklucz konkretne ID produktów z jednej grupy plików Performance Max.
 *
 * Droga bez feedu: wykluczenie siedzi w drzewie filtrów kampanii, więc nie wymaga ani
 * Merchant Center, ani etykiety. Cena jest taka, że drzewo puchnie o jeden węzeł na
 * WARIANT i utrzymuje się je w każdej grupie plików osobno — przy katalogu, w którym
 * te same produkty wyklucza się we wszystkich grupach, tańsza jest droga przez etykietę
 * (`addLabelExclusion`), która działa na całe konto jednym węzłem na grupę.
 *
 * @param {string} customerId
 * @param {string|number} assetGroupId
 * @param {string[]} itemIds
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{snapshotPath?: string}} [opts]
 * @returns {Promise<object>} plan (dry-run, sprawdzony przez Google) albo wynik mutate
 */
export async function addItemExclusion(customerId, assetGroupId, itemIds, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const cleanAssetGroupId = String(assetGroupId ?? '').replace(/[^0-9]/g, '');
  if (!cleanAssetGroupId) throw new Error('add-item-exclusion wymaga --asset-group=<ID grupy plików>.');

  const surowe = await getListingFilterTree(cleanCustomerId, cleanAssetGroupId, { loginCustomerId });
  const tree = inferCatchAllDimensions(surowe);
  const plan = checkItemExclusion(tree, itemIds);
  if (!plan.ok) throw new Error(`🛑 ${plan.reason}`);

  const assetGroupName = (tree[0] && tree[0].assetGroupName) || '';
  const base = {
    assetGroupId: cleanAssetGroupId,
    assetGroupName,
    mode: plan.mode,
    nodesBefore: tree.length,
    juzWykluczone: plan.juzWykluczone.length,
    doPrzelaczenia: plan.doPrzelaczenia.length,
    doDodania: plan.doDodania.length,
  };

  if (plan.mode === 'noop') {
    console.log(`[Mutator] ${assetGroupName}: wszystkie ${plan.juzWykluczone.length} ID już wykluczone — nic do zrobienia.`);
    return { success: true, dryRun, changed: 0, noop: true, ...base };
  }

  const { mutations, removed, created } = buildItemExclusionMutations(tree, plan, {
    customerId: cleanCustomerId,
    assetGroupId: cleanAssetGroupId,
  });

  const warning = plan.mode === 'rebuild'
    ? `PRZEBUDOWA: ${removed} węzłów zostaje odtworzonych pod gałęzią „wszystko inne". Zakres kierowania nie zmienia się, `
      + 'ale węzły dostają NOWE id, więc ich statystyki w panelu startują od zera (historia kampanii i produktów zostaje '
      + 'nietknięta). Gdy ta grupa dzieli się dziś po etykiecie niestandardowej, TAŃSZE jest wykluczenie przez etykietę '
      + '(--action=add-label-exclusion): jeden węzeł zamiast przebudowy całego drzewa.'
    : `Dokładamy ${plan.doDodania.length} wykluczeń i przełączamy ${plan.doPrzelaczenia.length} — przełączone węzły dostają `
      + 'NOWE id, więc ich historia statystyk w panelu zaczyna się od zera.';

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}${assetGroupName}: ${plan.doPrzelaczenia.length + plan.doDodania.length} ID → WYKLUCZONE (${plan.mode}, ${removed} usunięć + ${created} utworzeń)...`);

  const customer = getCustomer(cleanCustomerId, loginCustomerId);

  if (dryRun) {
    const check = await validateWithApi(customer, [mutations]);
    return {
      success: check.ok,
      dryRun: true,
      ...base,
      removed,
      created,
      warning,
      googleValidation: check.ok ? 'OK' : `ODRZUCONE: ${check.error}`,
    };
  }

  // Snapshot PRZED mutacją — jedyna droga powrotu do poprzedniego kształtu drzewa.
  // Zapis musi się udać, zanim cokolwiek pójdzie do API.
  let snapshot = null;
  if (opts.snapshotPath) {
    writeFileSync(opts.snapshotPath, JSON.stringify({
      customerId: cleanCustomerId, assetGroupId: cleanAssetGroupId, assetGroupName,
      savedAt: new Date().toISOString(), tree,
    }, null, 1));
    snapshot = opts.snapshotPath;
    console.log(`[Mutator] Snapshot drzewa sprzed zmiany: ${snapshot}`);
  }

  const wynik = await customer.mutateResources(mutations);
  const changed = wynik?.mutate_operation_responses?.length ?? mutations.length;
  console.log(`[Mutator] ✓ ${assetGroupName}: gotowe (${changed} operacji).`);
  return { success: true, dryRun: false, changed, removed, created, snapshot, warning, ...base };
}
