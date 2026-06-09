import { getCustomer, unpackError } from './client.js';
import { getBudgetById } from './queries.js';
import { checkBudgetChange, assertNotRemoval } from './safety.js';

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
