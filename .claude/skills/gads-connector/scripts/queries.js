import { enums } from 'google-ads-api';
import { getApiClient, getCustomer, unpackError } from './client.js';

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
 * Enumerate EVERY account the authenticated user can reach — not just one MCC's
 * children. Two sources are merged:
 *   1. Accounts shared directly with the user (`listAccessibleCustomers`). These
 *      may be plain clients (e.g. a client added you to their own account) or
 *      manager (MCC) accounts. They are queried directly, with no MCC login.
 *   2. For every manager among those, all descendant child accounts
 *      (`customer_client` under that MCC).
 *
 * Each returned row carries the `login_customer_id` you must pass to query that
 * account: empty/null for a directly-shared account (query it directly), or the
 * MCC id for a child account. Rows are de-duplicated by account id; if an account
 * is reachable both ways, the direct path wins (it needs no MCC login).
 *
 * @returns {Promise<Array<{id:string, descriptive_name:string, manager:boolean,
 *   status:string|number|null, currency_code:string|null,
 *   login_customer_id:string|null, source:string}>>}
 */
export async function listAccessibleAccounts() {
  const { api, config } = getApiClient();

  let resourceNames;
  try {
    const res = await api.listAccessibleCustomers(config.refresh_token);
    resourceNames = res?.resource_names || (Array.isArray(res) ? res : []);
  } catch (error) {
    throw new Error(`listAccessibleCustomers failed: ${unpackError(error)}`);
  }
  const topLevelIds = resourceNames.map((rn) => String(rn).split('/').pop());

  // Query each top-level account in its OWN context (no MCC login) to learn its
  // name + whether it's a manager. Done in parallel; failures degrade to a stub.
  const topLevel = await Promise.all(topLevelIds.map(async (id) => {
    try {
      const customer = api.Customer({ customer_id: id, refresh_token: config.refresh_token });
      const rows = await customer.query(
        'SELECT customer.id, customer.descriptive_name, customer.manager, customer.status, customer.currency_code FROM customer LIMIT 1'
      );
      const c = rows[0]?.customer || {};
      return {
        id,
        descriptive_name: c.descriptive_name || '',
        manager: !!c.manager,
        status: c.status ?? null,
        currency_code: c.currency_code ?? null,
        login_customer_id: null,
        source: 'direct',
      };
    } catch (error) {
      return {
        id,
        descriptive_name: '',
        manager: null,
        status: 'INACCESSIBLE',
        currency_code: null,
        login_customer_id: null,
        source: 'direct',
        error: (error.message || '').slice(0, 80),
      };
    }
  }));

  // For every reachable manager, list its child accounts (one query per MCC
  // returns all descendants). Children record the MCC as their login id.
  const managerIds = topLevel.filter((a) => a.manager).map((a) => a.id);
  const childGroups = await Promise.all(managerIds.map(async (mccId) => {
    try {
      const accounts = await listAccounts(mccId, { loginCustomerId: mccId });
      return accounts.map((acc) => ({
        id: String(acc['customer_client.id']),
        descriptive_name: acc['customer_client.descriptive_name'] || '',
        manager: !!acc['customer_client.manager'],
        status: acc['customer_client.status'] ?? null,
        currency_code: null,
        login_customer_id: mccId,
        source: `mcc:${mccId}`,
      }));
    } catch {
      return [];
    }
  }));

  // Merge, de-duplicating by id. Direct access wins over an MCC path so the
  // caller doesn't need a login id when one isn't required.
  const byId = new Map();
  for (const row of [...topLevel, ...childGroups.flat()]) {
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, row);
    } else if (existing.source.startsWith('mcc:') && row.source === 'direct') {
      byId.set(row.id, row);
    }
  }

  return [...byId.values()].sort((a, b) =>
    (a.descriptive_name || '').localeCompare(b.descriptive_name || '', 'pl')
  );
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
 *   Defaults target Poland (geo 2616) + Polish (language 1030); override as needed.
 * @returns {Promise<Array<object>>} Ideas sorted by avg monthly searches (desc)
 */
export async function getKeywordIdeas(customerId, opts = {}) {
  const {
    loginCustomerId,
    keywords = [],
    url,
    geoTargetId = '2616', // Poland
    languageId = '1030',  // Polish
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

/**
 * Account change history (change_event): who changed what, when.
 *
 * Handles the two traps a raw GAQL pull of change_event walks into:
 *  1. Enums arrive as numbers — decoded here via the library's `enums`
 *     (no hand-maintained maps that can drift).
 *  2. Criterion changes carry no keyword text — it is resolved with a second
 *     lookup that depends on the level: ad_group_criterion (group) vs
 *     campaign_criterion (campaign-level negatives).
 *
 * NOTE: the API keeps change_event for the last 30 days only; `days` is
 * capped at 29. change_event queries require LIMIT (max 10000).
 *
 * @param {string} customerId - 10-digit customer ID
 * @param {number} [days=14] - lookback window (capped at 29)
 * @param {{loginCustomerId?: string, timezone?: string, user?: string}} [opts]
 *   opts.user - filter by user email(s), comma-separated
 * @returns {Promise<Array<object>>} Flat rows: datetime, date, user, operation,
 *   resourceType, campaign, keyword, matchType, negative, level, changedFields,
 *   oldBudget, newBudget, oldStatus, newStatus, detail
 */
export async function getChangeHistory(customerId, days = 14, opts = {}) {
  const RT = enums.ChangeEventResourceType;
  const OP = enums.ResourceChangeOperation;
  const MT = enums.KeywordMatchType;

  const effectiveDays = Math.min(days, 29);
  const { start, end } = calculateDateRange(effectiveDays, opts.timezone);
  const customer = getCustomer(customerId, opts.loginCustomerId);

  const userFilter = opts.user
    ? `AND change_event.user_email IN (${String(opts.user).split(',').map((u) => `'${u.trim()}'`).join(', ')})`
    : '';

  let rows;
  try {
    rows = await customer.query(`
      SELECT
        change_event.change_date_time,
        change_event.change_resource_type,
        change_event.change_resource_name,
        change_event.resource_change_operation,
        change_event.campaign,
        change_event.ad_group,
        change_event.changed_fields,
        change_event.user_email,
        change_event.old_resource,
        change_event.new_resource
      FROM change_event
      WHERE change_event.change_date_time >= '${start} 00:00:00'
        AND change_event.change_date_time <= '${end} 23:59:59'
        ${userFilter}
      ORDER BY change_event.change_date_time ASC
      LIMIT 10000
    `);
  } catch (error) {
    throw new Error(unpackError(error));
  }

  // Batch lookups: campaign names + criterion texts (level decides the resource).
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const campaignNames = uniq(rows.map((r) => r.change_event?.campaign));
  const groupCriteria = uniq(rows
    .filter((r) => r.change_event?.change_resource_type === RT.AD_GROUP_CRITERION)
    .map((r) => r.change_event?.change_resource_name));
  const campCriteria = uniq(rows
    .filter((r) => r.change_event?.change_resource_type === RT.CAMPAIGN_CRITERION)
    .map((r) => r.change_event?.change_resource_name));

  const lookup = async (resource, names) => {
    if (names.length === 0) return {};
    const inClause = names.map((n) => `'${n}'`).join(', ');
    const map = {};
    try {
      const res = await customer.query(`
        SELECT ${resource}.resource_name, ${resource}.keyword.text,
               ${resource}.keyword.match_type, ${resource}.negative
        FROM ${resource}
        WHERE ${resource}.resource_name IN (${inClause})
      `);
      for (const r of res) {
        const c = r[resource];
        map[c.resource_name] = { text: c.keyword?.text, match: c.keyword?.match_type, negative: c.negative };
      }
    } catch { /* removed resources simply stay unresolved */ }
    return map;
  };

  const [campMap, kwMap, ccMap] = await Promise.all([
    (async () => {
      if (campaignNames.length === 0) return {};
      const map = {};
      try {
        const res = await customer.query(`
          SELECT campaign.resource_name, campaign.name FROM campaign
          WHERE campaign.resource_name IN (${campaignNames.map((n) => `'${n}'`).join(', ')})
        `);
        for (const r of res) map[r.campaign.resource_name] = r.campaign.name;
      } catch { /* deleted campaigns keep their resource name */ }
      return map;
    })(),
    lookup('ad_group_criterion', groupCriteria),
    lookup('campaign_criterion', campCriteria),
  ]);

  return rows.map((r) => {
    const e = r.change_event;
    const paths = Array.isArray(e.changed_fields?.paths) ? e.changed_fields.paths : [];
    const out = {
      datetime: e.change_date_time || '',
      date: (e.change_date_time || '').substring(0, 10),
      user: e.user_email || null,
      operation: OP[e.resource_change_operation] || String(e.resource_change_operation),
      resourceType: RT[e.change_resource_type] || String(e.change_resource_type),
      campaign: campMap[e.campaign] || e.campaign || '',
      keyword: null,
      matchType: null,
      negative: null,
      level: null,
      changedFields: paths.join('; '),
      detail: '',
    };

    // Criterion text (group vs campaign level)
    const isGroupCrit = e.change_resource_type === RT.AD_GROUP_CRITERION;
    const isCampCrit = e.change_resource_type === RT.CAMPAIGN_CRITERION;
    if (isGroupCrit || isCampCrit) {
      out.level = isCampCrit ? 'campaign' : 'ad_group';
      const c = (isCampCrit ? ccMap : kwMap)[e.change_resource_name];
      if (c && c.text != null) {
        out.keyword = c.text;
        out.matchType = MT[c.match] || null;
        out.negative = c.negative ?? null;
        out.detail = `${c.negative ? 'NEGATIVE' : 'keyword'}: ${c.text}`;
      } else {
        out.detail = 'criterion (text unavailable — removed?)';
      }
    }

    // Budget amounts
    if (e.change_resource_type === RT.CAMPAIGN_BUDGET) {
      const o = e.old_resource?.campaign_budget?.amount_micros;
      const n = e.new_resource?.campaign_budget?.amount_micros;
      if (o != null) out.oldBudget = Number(o) / 1_000_000;
      if (n != null) out.newBudget = Number(n) / 1_000_000;
      out.detail = `budget: ${out.oldBudget ?? '?'} → ${out.newBudget ?? '?'}`;
    }

    // Campaign status flips
    if (e.change_resource_type === RT.CAMPAIGN && paths.includes('status')) {
      const CS = enums.CampaignStatus;
      out.oldStatus = CS[e.old_resource?.campaign?.status] || null;
      out.newStatus = CS[e.new_resource?.campaign?.status] || null;
      out.detail = `status: ${out.oldStatus ?? '?'} → ${out.newStatus ?? '?'}`;
    }

    if (!out.detail) out.detail = out.changedFields;
    return out;
  });
}

/**
 * Read the current Final URLs for a set of ads or keywords, keyed by resource
 * name. Used to build a before→after diff for the `update-ad-url` /
 * `update-keyword-url` dry-run so the operator sees exactly what changes.
 *
 * @param {string} customerId
 * @param {'ad'|'keyword'} entity
 * @param {Array<string>} resourceNames - full resource names to look up
 * @param {{loginCustomerId?: string}} [opts]
 * @returns {Promise<Map<string, string[]>>} resourceName → current final_urls
 */
export async function getCurrentFinalUrls(customerId, entity, resourceNames, opts = {}) {
  const map = new Map();
  const names = [...new Set(resourceNames.filter(Boolean))];
  if (names.length === 0) return map;

  // GAQL IN-lists have a practical size limit; chunk to stay well under it.
  const CHUNK = 200;
  const inList = (arr) => arr.map((n) => `'${String(n).replace(/'/g, "")}'`).join(', ');

  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    const query = entity === 'ad'
      ? `SELECT ad_group_ad.ad.resource_name, ad_group_ad.ad.final_urls
         FROM ad_group_ad
         WHERE ad_group_ad.ad.resource_name IN (${inList(chunk)})`
      : `SELECT ad_group_criterion.resource_name, ad_group_criterion.final_urls
         FROM ad_group_criterion
         WHERE ad_group_criterion.resource_name IN (${inList(chunk)})`;
    const rows = await runRawQuery(customerId, query, { loginCustomerId: opts.loginCustomerId });
    for (const r of rows) {
      const rn = entity === 'ad' ? r['ad_group_ad.ad.resource_name'] : r['ad_group_criterion.resource_name'];
      const urls = entity === 'ad' ? r['ad_group_ad.ad.final_urls'] : r['ad_group_criterion.final_urls'];
      if (rn) map.set(rn, urls || []);
    }
  }
  return map;
}

/**
 * Detect the level of a sitelink *_asset LINK resource name.
 * @param {string} rn - e.g. customers/1/campaignAssets/2~3~SITELINK
 * @returns {'campaign'|'ad_group'|'customer'}
 */
export function sitelinkLinkLevel(rn) {
  const s = String(rn);
  if (s.includes('/campaignAssets/')) return 'campaign';
  if (s.includes('/adGroupAssets/')) return 'ad_group';
  if (s.includes('/customerAssets/')) return 'customer';
  throw new Error(`Nierozpoznany resource_name linku sitelink: "${rn}" (oczekiwano campaignAssets/adGroupAssets/customerAssets).`);
}

/**
 * List the sitelinks that already EXIST on the account (status ENABLED or PAUSED,
 * i.e. not removed), at campaign and customer level, as
 * `{level, campaignId, linkText, finalUrl}`. Lets `add-sitelinks` converge — skip
 * a sitelink that already exists at the same parent — instead of blindly creating
 * duplicates. Paused ones count as "exists" too, so a set we deliberately paused
 * (e.g. a retired sitelink) is not silently resurrected by a re-run.
 *
 * @param {string} customerId
 * @param {{loginCustomerId?: string}} [opts]
 * @returns {Promise<Array<{level:'campaign'|'customer', campaignId:string|null, linkText:string, finalUrl:string}>>}
 */
export async function getExistingSitelinks(customerId, opts = {}) {
  const clean = String(customerId).replace(/-/g, '');
  const out = [];
  const campRows = await runRawQuery(clean,
    `SELECT campaign.id, campaign.status, campaign_asset.status, asset.sitelink_asset.link_text, asset.final_urls
     FROM campaign_asset
     WHERE asset.type = 'SITELINK' AND campaign_asset.status IN ('ENABLED', 'PAUSED')`,
    { loginCustomerId: opts.loginCustomerId });
  for (const r of campRows) {
    out.push({ level: 'campaign', campaignId: String(r['campaign.id']), linkText: r['asset.sitelink_asset.link_text'] || '', finalUrl: (r['asset.final_urls'] || [])[0] || '' });
  }
  const custRows = await runRawQuery(clean,
    `SELECT customer_asset.status, asset.sitelink_asset.link_text, asset.final_urls
     FROM customer_asset
     WHERE asset.type = 'SITELINK' AND customer_asset.status IN ('ENABLED', 'PAUSED')`,
    { loginCustomerId: opts.loginCustomerId });
  for (const r of custRows) {
    out.push({ level: 'customer', campaignId: null, linkText: r['asset.sitelink_asset.link_text'] || '', finalUrl: (r['asset.final_urls'] || [])[0] || '' });
  }
  return out;
}

/**
 * Read the full detail of sitelink LINKS (campaign/ad_group/customer level) so a
 * URL swap can clone the underlying asset and re-link it. Returns per-link:
 * level, parent resource (campaign/ad_group, null for account), link status, the
 * source asset resource name, and the sitelink text/descriptions + current URLs.
 *
 * @param {string} customerId
 * @param {Array<string>} linkResourceNames - full *_asset resource names
 * @param {{loginCustomerId?: string}} [opts]
 * @returns {Promise<Map<string, object>>} linkResourceName → detail
 */
export async function getSitelinkLinkDetails(customerId, linkResourceNames, opts = {}) {
  const map = new Map();
  const names = [...new Set(linkResourceNames.filter(Boolean))];
  if (names.length === 0) return map;

  const byLevel = { campaign: [], ad_group: [], customer: [] };
  for (const rn of names) byLevel[sitelinkLinkLevel(rn)].push(rn);

  const assetFields =
    'asset.resource_name, asset.sitelink_asset.link_text, ' +
    'asset.sitelink_asset.description1, asset.sitelink_asset.description2, ' +
    'asset.final_urls, asset.final_mobile_urls';
  const inList = (arr) => arr.map((n) => `'${String(n).replace(/'/g, "")}'`).join(', ');
  const CHUNK = 200;

  const runChunks = async (level, arr, buildQuery, mapRow) => {
    for (let i = 0; i < arr.length; i += CHUNK) {
      const rows = await runRawQuery(customerId, buildQuery(arr.slice(i, i + CHUNK)), { loginCustomerId: opts.loginCustomerId });
      for (const r of rows) {
        const d = mapRow(r);
        if (d.linkResourceName) map.set(d.linkResourceName, d);
      }
    }
  };

  const assetOf = (r) => ({
    assetResourceName: r['asset.resource_name'],
    linkText: r['asset.sitelink_asset.link_text'] || '',
    description1: r['asset.sitelink_asset.description1'] || '',
    description2: r['asset.sitelink_asset.description2'] || '',
    finalUrls: r['asset.final_urls'] || [],
    finalMobileUrls: r['asset.final_mobile_urls'] || [],
  });

  if (byLevel.campaign.length) {
    await runChunks('campaign', byLevel.campaign,
      (c) => `SELECT campaign_asset.resource_name, campaign_asset.status, campaign.resource_name, ${assetFields} FROM campaign_asset WHERE campaign_asset.resource_name IN (${inList(c)})`,
      (r) => ({ level: 'campaign', linkResourceName: r['campaign_asset.resource_name'], parent: r['campaign.resource_name'], linkStatus: r['campaign_asset.status'], ...assetOf(r) }));
  }
  if (byLevel.ad_group.length) {
    await runChunks('ad_group', byLevel.ad_group,
      (c) => `SELECT ad_group_asset.resource_name, ad_group_asset.status, ad_group.resource_name, ${assetFields} FROM ad_group_asset WHERE ad_group_asset.resource_name IN (${inList(c)})`,
      (r) => ({ level: 'ad_group', linkResourceName: r['ad_group_asset.resource_name'], parent: r['ad_group.resource_name'], linkStatus: r['ad_group_asset.status'], ...assetOf(r) }));
  }
  if (byLevel.customer.length) {
    await runChunks('customer', byLevel.customer,
      (c) => `SELECT customer_asset.resource_name, customer_asset.status, ${assetFields} FROM customer_asset WHERE customer_asset.resource_name IN (${inList(c)})`,
      (r) => ({ level: 'customer', linkResourceName: r['customer_asset.resource_name'], parent: null, linkStatus: r['customer_asset.status'], ...assetOf(r) }));
  }
  return map;
}
