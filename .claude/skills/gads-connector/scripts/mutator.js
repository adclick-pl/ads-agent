import { getCustomer, unpackError } from './client.js';
import { getKeywordsByCriteria, getCampaignBasics, getBudgetById, getCurrentFinalUrls, getSitelinkLinkDetails, sitelinkLinkLevel, getExistingSitelinks, getAdGroupsByCampaign, getExistingKeywords, getExistingRsa, getExistingCallouts, getExistingStructuredSnippets, getExistingPriceAssets, getExistingPromotions, promotionIdentity, getAdGroupAdsByAdIds, getAdGroupsByIds, getExistingYoutubeAssets, getExistingDemandGenAds, getExistingListingGroups, getAdGroupTargetingCriteria, getCampaignChannelTypes, getCallToActionAssets, COPYABLE_CRITERION_TYPES } from './queries.js';
import { checkBudgetChange, assertNotRemoval, validateFinalUrl, checkSitelinkTexts, checkKeywordText, checkAdGroupName, checkRsaTexts, checkCalloutText, checkStructuredSnippet, checkPriceOfferings, checkPromotion, checkDemandGenAdTexts, checkDemandGenChannels } from './safety.js';

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
  const keyOf = (level, parent, text, url) => `${level}:${parent}|${text}|${norm(url)}`;
  let existing = new Set();
  try {
    const current = await getExistingSitelinks(cleanCustomerId, { loginCustomerId });
    existing = new Set(current.map((s) => keyOf(s.level, parentOf(s.level, s.campaignId, s.adGroupId), s.linkText, s.finalUrl)));
  } catch {
    existing = new Set(); // best-effort — a read failure must not block a first-time add
  }
  const toCreate = [];
  const skipped = [];
  for (const r of rows) {
    (existing.has(keyOf(r.level, parentOf(r.level, r.campaignId, r.adGroupId), r.linkText, r.finalUrl)) ? skipped : toCreate).push(r);
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
const HEADLINE_PIN_FIELDS = { H1: 'HEADLINE_1', H2: 'HEADLINE_2', H3: 'HEADLINE_3' };
function splitHeadlinePin(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(.*?)\s*\|\s*(H[123])$/i);
  return m ? { text: m[1].trim(), pin: HEADLINE_PIN_FIELDS[m[2].toUpperCase()] } : { text: s, pin: null };
}

/**
 * Add Responsive Search Ads to existing ad groups.
 *
 * Ad groups are addressed by `adGroupId` or by `campaignId` + `adGroupName`, same
 * as `addKeywords` — so an ad file can be written before the groups exist.
 *
 * A headline may carry a pin marker (`"tekst|H1"`) to lock it to headline
 * position 1, 2 or 3. Pins are ignored by the content signature below, so an
 * ad differing only in pinning counts as already present.
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
    const headlineAssets = (it.headlines || []).map(splitHeadlinePin).filter((h) => h.text);
    const headlines = headlineAssets.map((h) => h.text);
    const descriptions = (it.descriptions || []).map((d) => String(d ?? '').trim()).filter(Boolean);
    const rsa = checkRsaTexts({ headlines, descriptions, path1: it.path1, path2: it.path2 });
    if (!rsa.valid) rsa.reasons.forEach((r) => problems.push(`${ref}: ${r}`));

    const finalUrl = String(it.finalUrl ?? '').trim();
    const urlCheck = validateFinalUrl(finalUrl, { domain: opts.domain });
    if (!urlCheck.valid) problems.push(`${ref}: ${urlCheck.reason}`);

    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    const adGroupName = String(it.adGroupName ?? '').trim();
    if (!adGroupId && !(campaignId && adGroupName)) problems.push(`${ref}: podaj ad_group_id albo campaign_id + ad_group_name.`);

    return { adGroupId, campaignId, adGroupName, headlines, headlineAssets, descriptions, finalUrl,
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
        descriptions: r.descriptions.map((t) => ({ text: t })),
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
    const headlineAssets = (it.headlines || []).map(splitHeadlinePin).filter((h) => h.text);
    const headlines = headlineAssets.map((h) => h.text);
    const descriptions = (it.descriptions || []).map((d) => String(d ?? '').trim()).filter(Boolean);
    const rsa = checkRsaTexts({ headlines, descriptions, path1: it.path1, path2: it.path2 });
    if (!rsa.valid) rsa.reasons.forEach((r) => problems.push(`${ref}: ${r}`));
    const adId = String(it.adId ?? '').replace(/[^0-9]/g, '');
    const adGroupId = String(it.adGroupId ?? '').replace(/[^0-9]/g, '');
    const campaignId = String(it.campaignId ?? '').replace(/[^0-9]/g, '');
    const adGroupName = String(it.adGroupName ?? '').trim();
    if (!adId && !adGroupId && !(campaignId && adGroupName)) {
      problems.push(`${ref}: podaj ad_id, ad_group_id albo campaign_id + ad_group_name.`);
    }
    return { adId, adGroupId, campaignId, adGroupName, headlines, headlineAssets, descriptions,
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
        descriptions: r.descriptions.map((t) => ({ text: t })),
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
 * Pause ANY asset link by its `*_asset` resource name — callouts, structured
 * snippets, price extensions, images. Retiring an asset is the same operation
 * whatever the asset is: flip the LINK to PAUSED and leave the asset itself
 * alone. The link and its history stay, the extension just stops serving.
 *
 * This is also the answer to "delete this extension": the connector never
 * removes, and a paused link does not serve, so the visible effect is identical
 * and the change is reversible.
 *
 * @param {string} customerId
 * @param {Array<string>} linkResourceNames
 * @param {boolean} [dryRun=false]
 * @param {string} [loginCustomerId]
 * @param {{entity?: string, label?: string}} [opts]
 */
export async function pauseAssetLinks(customerId, linkResourceNames, dryRun = false, loginCustomerId, opts = {}) {
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const entity = opts.entity || 'asset';
  const label = opts.label || 'rozszerzeń';
  const names = [...new Set((linkResourceNames || []).map((n) => String(n).trim()).filter(Boolean))];
  if (names.length === 0) throw new Error(`Brak ${label} do wstrzymania (pusta lista).`);
  const bad = names.filter((n) => !/\/(campaignAssets|adGroupAssets|customerAssets)\//.test(n));
  if (bad.length) throw new Error(`🛑 ${bad.length} pozycji nie jest linkiem zasobu (campaignAssets/adGroupAssets/customerAssets):\n${bad.map((b) => `  • ${b}`).join('\n')}`);

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Wstrzymanie ${names.length} ${label}...`);
  if (dryRun) return { success: true, dryRun: true, entity, count: names.length, plan: names };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = names.map((n) => ({
      entity: SITELINK_LINK_ENTITY[sitelinkLinkLevel(n)],
      operation: 'update',
      resource: { resource_name: n, status: 'PAUSED' },
    }));
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity, count: names.length, chunks: responses.length, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się wstrzymać ${label}: ${unpackError(error)}`);
  }
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
    r.currency);
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
