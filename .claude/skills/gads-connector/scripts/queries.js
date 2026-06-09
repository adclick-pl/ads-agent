import { getCustomer, unpackError } from './client.js';

/**
 * Format date in YYYY-MM-DD in local time
 * @param {Date} d
 * @returns {string} YYYY-MM-DD
 */
export function formatLocalPlainDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a Date as YYYY-MM-DD as seen in a given IANA timezone. Falls back to
 * local time if the timezone is invalid/unknown.
 * @param {Date} d
 * @param {string} [timezone] - e.g. "Europe/Warsaw"
 * @returns {string} YYYY-MM-DD
 */
export function formatInTimeZone(d, timezone) {
  if (!timezone) return formatLocalPlainDate(d);
  try {
    // en-CA gives ISO-like YYYY-MM-DD output.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return formatLocalPlainDate(d);
  }
}

/**
 * Get the inclusive date range ending "today" (in the account's timezone) and
 * spanning `days` days back. Computing in the account timezone matches how
 * Google Ads evaluates dates server-side, avoiding off-by-one errors when the
 * operator's machine is in a different zone than the account.
 * @param {number} days
 * @param {string} [timezone] - account IANA timezone
 * @returns {{start: string, end: string}}
 */
export function calculateDateRange(days = 30, timezone) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    start: formatInTimeZone(start, timezone),
    end: formatInTimeZone(end, timezone),
  };
}

/**
 * Fetch an account's IANA timezone (e.g. "Europe/Warsaw") so date ranges can be
 * computed correctly. Defaults to the machine's local zone if unavailable.
 * @param {string} customerId
 * @param {string} [loginCustomerId]
 * @returns {Promise<string>}
 */
export async function getAccountTimezone(customerId, loginCustomerId) {
  try {
    const customer = getCustomer(customerId, loginCustomerId);
    const rows = await customer.query('SELECT customer.time_zone FROM customer LIMIT 1');
    return rows[0]?.customer?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

/**
 * Standardizes micro amount to standard float (divide by 1,000,000)
 * @param {number|string} micros 
 * @returns {number}
 */
export function microsToStandard(micros) {
  if (micros === null || micros === undefined) return 0;
  return Number(micros) / 1000000;
}

/**
 * Optionally inject a concrete date range into a GAQL query, computed in the
 * account timezone. Mirrors how the `--days` flag works:
 *   - If the query contains `LAST_30_DAYS`, replace it with `BETWEEN 'a' AND 'b'`.
 *   - Else if the query has no date filter at all, prepend a default range.
 *   - If the query already specifies BETWEEN or a DURING macro, leave it alone.
 * @param {string} query
 * @param {{days?: number, timezone?: string}} opts
 * @returns {string}
 */
export function applyDateRange(query, { days, timezone } = {}) {
  if (!days) return query;
  const { start, end } = calculateDateRange(days, timezone);
  if (/LAST_30_DAYS/i.test(query)) {
    return query.replace(/LAST_30_DAYS/gi, `BETWEEN '${start}' AND '${end}'`);
  }
  if (/\bBETWEEN\b/i.test(query) || /DURING\s+LAST_\d+_DAYS/i.test(query)) {
    return query; // caller already specified a range
  }
  if (/\bWHERE\b/i.test(query)) {
    return query.replace(/\bWHERE\b/i, `WHERE segments.date BETWEEN '${start}' AND '${end}' AND`);
  }
  // No WHERE clause: insert one before ORDER BY / LIMIT if present, else append.
  const tail = query.match(/\b(ORDER\s+BY|LIMIT)\b/i);
  const clause = ` WHERE segments.date BETWEEN '${start}' AND '${end}' `;
  if (tail) {
    return query.slice(0, tail.index) + clause + query.slice(tail.index);
  }
  return `${query} ${clause}`;
}

/**
 * Executes a custom GAQL query and cleans/flattens the output.
 * Converts cost micros and formats percentages automatically.
 * @param {string} customerId - 10-digit customer ID
 * @param {string} query - GAQL query string
 * @param {{loginCustomerId?: string, days?: number, timezone?: string}} [opts]
 * @returns {Promise<Array<object>>} Flattened rows
 */
export async function runRawQuery(customerId, query, opts = {}) {
  try {
    const customer = getCustomer(customerId, opts.loginCustomerId);
    const finalQuery = applyDateRange(query, opts);
    const results = await customer.query(finalQuery);
    
    // Flatten rows for easy processing by LLMs/mini-agents
    return results.map(row => {
      const flattened = {};
      
      const traverse = (obj, prefix = '') => {
        if (!obj || typeof obj !== 'object') return;
        
        for (const [key, value] of Object.entries(obj)) {
          const fullKey = prefix ? `${prefix}.${key}` : key;
          
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            traverse(value, fullKey);
          } else {
            // Automatically convert cost micros to standard currency values
            if (fullKey.includes('cost_micros') || fullKey.includes('amount_micros') || fullKey.includes('spend_micros')) {
              const standardKey = fullKey.replace('_micros', '');
              flattened[standardKey] = microsToStandard(value);
            }
            
            flattened[fullKey] = value;
          }
        }
      };

      traverse(row);
      return flattened;
    });
  } catch (error) {
    throw new Error(`Google Ads query failed: ${unpackError(error)}`);
  }
}

/**
 * List all enabled customer accounts under the current login/MCC account.
 * @param {string} [customerId] - Customer ID to start checking from
 * @returns {Promise<Array<object>>} Account details
 */
export async function listAccounts(customerId, opts = {}) {
  // Use login_customer_id or default customer_id as the parent
  const targetId = customerId || undefined;

  const query = `
    SELECT
      customer_client.id,
      customer_client.descriptive_name,
      customer_client.manager,
      customer_client.status,
      customer_client.applied_labels
    FROM customer_client
    WHERE customer_client.status = 'ENABLED'
  `;

  return runRawQuery(targetId, query, { loginCustomerId: opts.loginCustomerId });
}

/**
 * Retrieve campaign performance details.
 * @param {string} customerId 
 * @param {number} [days=30] 
 * @returns {Promise<Array<object>>} Campaigns
 */
export async function getCampaigns(customerId, days = 30, opts = {}) {
  const { start, end } = calculateDateRange(days, opts.timezone);
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${start}' AND '${end}'
      AND campaign.status IN ('ENABLED', 'PAUSED')
    ORDER BY metrics.cost_micros DESC
  `;

  const rows = await runRawQuery(customerId, query, { loginCustomerId: opts.loginCustomerId });
  
  // Calculate supplementary metrics like CTR, CPC, and ROAS
  return rows.map(row => {
    const cost = row['metrics.cost'] || 0;
    const clicks = row['metrics.clicks'] || 0;
    const conversions = row['metrics.conversions'] || 0;
    const convValue = row['metrics.conversions_value'] || 0;
    const impressions = row['metrics.impressions'] || 0;

    return {
      id: row['campaign.id'],
      name: row['campaign.name'],
      status: row['campaign.status'],
      type: row['campaign.advertising_channel_type'],
      budget: row['campaign_budget.amount'] || 0,
      clicks,
      impressions,
      cost,
      conversions,
      conversion_value: convValue,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      cpc: clicks > 0 ? cost / clicks : 0,
      roas: cost > 0 ? convValue / cost : 0
    };
  });
}

/**
 * Retrieve keyword performance and quality scores.
 * @param {string} customerId 
 * @param {number} [days=30] 
 * @returns {Promise<Array<object>>} Keywords
 */
export async function getKeywords(customerId, days = 30, opts = {}) {
  const { start, end } = calculateDateRange(days, opts.timezone);
  const query = `
    SELECT
      campaign.name,
      ad_group.name,
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.quality_info.quality_score,
      metrics.clicks,
      metrics.impressions,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM keyword_view
    WHERE segments.date BETWEEN '${start}' AND '${end}'
      AND ad_group_criterion.status IN ('ENABLED', 'PAUSED')
    ORDER BY metrics.cost_micros DESC
  `;

  return runRawQuery(customerId, query, { loginCustomerId: opts.loginCustomerId });
}

/**
 * Keyword Planner research — generate keyword ideas (avg monthly searches,
 * competition, top-of-page bid range) from seed keywords and/or a landing URL.
 *
 * NOTE: this is NOT GAQL. It calls `KeywordPlanIdeaService.generateKeywordIdeas`,
 * a separate Google Ads API service (same auth/client). Kept deliberately minimal
 * so a script can build on top of it (expand a keyword base, cluster, score, etc.).
 *
 * @param {string} customerId - 10-digit account ID (needed even for pure research)
 * @param {{loginCustomerId?: string, keywords?: string[], url?: string,
 *          geoTargetId?: string|number, languageId?: string|number,
 *          network?: string, pageSize?: number}} [opts]
 *   Defaults target Poland (geo 2616) + Polish (language 1045); override as needed.
 * @returns {Promise<Array<object>>} Ideas sorted by avg monthly searches (desc)
 */
export async function getKeywordIdeas(customerId, opts = {}) {
  const {
    loginCustomerId,
    keywords = [],
    url,
    geoTargetId = '2616', // Poland
    languageId = '1045',  // Polish
    network = 'GOOGLE_SEARCH',
    pageSize = 1000,
  } = opts;

  const cleanCustomerId = String(customerId || '').replace(/-/g, '');
  if (!cleanCustomerId) {
    throw new Error('keyword-ideas requires a customer ID (--account / --customer).');
  }

  const seeds = (keywords || []).map((k) => String(k).trim()).filter(Boolean);
  if (seeds.length === 0 && !url) {
    throw new Error('keyword-ideas requires at least --keywords="a,b" and/or --url=https://...');
  }

  const request = {
    customer_id: cleanCustomerId,
    language: `languageConstants/${String(languageId).replace(/[^0-9]/g, '')}`,
    geo_target_constants: [`geoTargetConstants/${String(geoTargetId).replace(/[^0-9]/g, '')}`],
    keyword_plan_network: network,
    page_size: Number(pageSize),
  };

  // Seed type: keyword + URL > URL only > keywords only.
  if (seeds.length && url) {
    request.keyword_and_url_seed = { url, keywords: seeds };
  } else if (url) {
    request.url_seed = { url };
  } else {
    request.keyword_seed = { keywords: seeds };
  }

  try {
    const customer = getCustomer(cleanCustomerId, loginCustomerId);
    const response = await customer.keywordPlanIdeas.generateKeywordIdeas(request);
    const results = Array.isArray(response) ? response : (response?.results || []);

    return results
      .map((r) => {
        const m = r.keyword_idea_metrics || {};
        return {
          keyword: r.text,
          avg_monthly_searches: Number(m.avg_monthly_searches || 0),
          competition: m.competition ?? null,
          competition_index: m.competition_index != null ? Number(m.competition_index) : null,
          low_top_of_page_bid: microsToStandard(m.low_top_of_page_bid_micros),
          high_top_of_page_bid: microsToStandard(m.high_top_of_page_bid_micros),
        };
      })
      .sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches);
  } catch (error) {
    throw new Error(`Keyword Planner request failed: ${unpackError(error)}`);
  }
}

/**
 * Retrieve search term queries, highlighting high cost or converting terms.
 * @param {string} customerId 
 * @param {number} [days=30] 
 * @param {number} [minCost=0] 
 * @returns {Promise<Array<object>>} Search terms
 */
export async function getSearchTerms(customerId, days = 30, minCost = 0, opts = {}) {
  const { start, end } = calculateDateRange(days, opts.timezone);

  const query = `
    SELECT
      campaign.name,
      ad_group.name,
      search_term_view.search_term,
      search_term_view.status,
      metrics.clicks,
      metrics.impressions,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE segments.date BETWEEN '${start}' AND '${end}'
    ORDER BY metrics.cost_micros DESC
  `;

  const results = await runRawQuery(customerId, query, { loginCustomerId: opts.loginCustomerId });

  // Apply post-retrieval filtering for clean currency cost
  return results.filter(row => {
    const cost = row['metrics.cost'] || 0;
    return cost >= minCost;
  });
}

/**
 * Retrieve raw search terms for Performance Max campaigns.
 *
 * PMax search terms do NOT appear in `search_term_view` (that view returns 0 rows
 * for PMax). They live in `campaign_search_term_view` via the field
 * `campaign_search_term_view.search_term`. Do NOT use `segments.search_term`
 * (raises "incompatible segment") nor `keyword.info.text` with this view.
 *
 * @param {string} customerId
 * @param {number} [days=30]
 * @param {{loginCustomerId?: string, timezone?: string, campaignId?: string|number}} [opts]
 *   Pass `campaignId` to restrict results to a single campaign.
 * @returns {Promise<Array<object>>} Search terms
 */
export async function getPmaxSearchTerms(customerId, days = 30, opts = {}) {
  const { start, end } = calculateDateRange(days, opts.timezone);

  const campaignFilter = opts.campaignId
    ? `\n      AND campaign.id = ${String(opts.campaignId).replace(/[^0-9]/g, '')}`
    : '';

  const query = `
    SELECT
      campaign.name,
      campaign_search_term_view.search_term,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign_search_term_view
    WHERE segments.date BETWEEN '${start}' AND '${end}'${campaignFilter}
    ORDER BY metrics.impressions DESC
  `;

  return runRawQuery(customerId, query, { loginCustomerId: opts.loginCustomerId });
}

/**
 * Get active placements list (display & video domains) for exclusions check.
 * @param {string} customerId 
 * @param {number} [days=30] 
 * @returns {Promise<Array<object>>} Placements
 */
export async function getPlacementPerformance(customerId, days = 30, opts = {}) {
  const { start, end } = calculateDateRange(days, opts.timezone);
  const query = `
    SELECT
      campaign.name,
      ad_group.name,
      detail_placement_view.placement,
      detail_placement_view.placement_type,
      metrics.clicks,
      metrics.impressions,
      metrics.cost_micros,
      metrics.conversions
    FROM detail_placement_view
    WHERE segments.date BETWEEN '${start}' AND '${end}'
    ORDER BY metrics.cost_micros DESC
  `;

  return runRawQuery(customerId, query, { loginCustomerId: opts.loginCustomerId });
}

/**
 * Fetch a single campaign budget by ID, so a mutation can compare the requested
 * amount against the current one (SafetyLimits). Returns null if not found.
 * @param {string} customerId
 * @param {string|number} budgetId
 * @param {{loginCustomerId?: string}} [opts]
 * @returns {Promise<object|null>} Flattened budget row (incl. `campaign_budget.amount`)
 */
export async function getBudgetById(customerId, budgetId, opts = {}) {
  const cleanBudgetId = String(budgetId).replace(/[^0-9]/g, '');
  const query = `
    SELECT
      campaign_budget.id,
      campaign_budget.name,
      campaign_budget.amount_micros
    FROM campaign_budget
    WHERE campaign_budget.id = ${cleanBudgetId}
    LIMIT 1
  `;
  const rows = await runRawQuery(customerId, query, { loginCustomerId: opts.loginCustomerId });
  return rows[0] || null;
}

/**
 * Get budgets of campaigns.
 * @param {string} customerId
 * @returns {Promise<Array<object>>} Budgets
 */
export async function getBudgets(customerId, opts = {}) {
  const query = `
    SELECT
      campaign_budget.id,
      campaign_budget.name,
      campaign_budget.amount_micros,
      campaign_budget.status,
      campaign_budget.delivery_method
    FROM campaign_budget
    WHERE campaign_budget.status = 'ENABLED'
  `;
  return runRawQuery(customerId, query, { loginCustomerId: opts.loginCustomerId });
}
