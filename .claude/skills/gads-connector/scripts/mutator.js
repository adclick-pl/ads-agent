import { getCustomer, unpackError } from './client.js';
import { getKeywordsByCriteria, getCampaignBasics, getBudgetById, getCurrentFinalUrls, getSitelinkLinkDetails, sitelinkLinkLevel, getExistingSitelinks, getAdGroupsByCampaign, getExistingKeywords, getExistingRsa, getExistingCallouts, getAdGroupAdsByAdIds, getAdGroupsByIds } from './queries.js';
import { checkBudgetChange, assertNotRemoval, validateFinalUrl, checkSitelinkTexts, checkKeywordText, checkAdGroupName, checkRsaTexts, checkCalloutText } from './safety.js';

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
function mutatedResourceNames(responses) {
  const names = [];
  for (const res of responses || []) {
    for (const r of res?.results || []) {
      if (r?.resource_name) names.push(String(r.resource_name));
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
 * Add Responsive Search Ads to existing ad groups.
 *
 * Ad groups are addressed by `adGroupId` or by `campaignId` + `adGroupName`, same
 * as `addKeywords` — so an ad file can be written before the groups exist.
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
    const headlines = (it.headlines || []).map((h) => String(h ?? '').trim()).filter(Boolean);
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

    return { adGroupId, campaignId, adGroupName, headlines, descriptions, finalUrl,
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
        headlines: r.headlines.map((t) => ({ text: t })),
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
    const headlines = (it.headlines || []).map((h) => String(h ?? '').trim()).filter(Boolean);
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
    return { adId, adGroupId, campaignId, adGroupName, headlines, descriptions,
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
        headlines: r.headlines.map((t) => ({ text: t })),
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
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const names = [...new Set((linkResourceNames || []).map((n) => String(n).trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('Brak objaśnień do wstrzymania (pusta lista).');
  const bad = names.filter((n) => !/\/(campaignAssets|adGroupAssets|customerAssets)\//.test(n));
  if (bad.length) throw new Error(`🛑 ${bad.length} pozycji nie jest linkiem zasobu (campaignAssets/adGroupAssets/customerAssets):\n${bad.map((b) => `  • ${b}`).join('\n')}`);

  console.log(`[Mutator] ${dryRun ? '[DRY-RUN] ' : ''}Wstrzymanie ${names.length} objaśnień...`);
  if (dryRun) return { success: true, dryRun: true, entity: 'callout', count: names.length, plan: names };

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const mutations = names.map((n) => ({
      entity: SITELINK_LINK_ENTITY[sitelinkLinkLevel(n)],
      operation: 'update',
      resource: { resource_name: n, status: 'PAUSED' },
    }));
    const responses = [];
    for (const part of chunk(mutations)) responses.push(await customer.mutateResources(part));
    return { success: true, dryRun: false, entity: 'callout', count: names.length, chunks: responses.length, resourceNames: mutatedResourceNames(responses) };
  } catch (error) {
    throw new Error(`Nie udało się wstrzymać objaśnień: ${unpackError(error)}`);
  }
}
