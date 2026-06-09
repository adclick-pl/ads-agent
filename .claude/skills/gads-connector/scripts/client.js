import { GoogleAdsApi } from 'google-ads-api';
import { loadConfig, validateConfig } from './config.js';

let apiInstance = null;
let apiConfig = null;

/**
 * Initializes and returns the global Google Ads API client and configuration.
 * @returns {{api: GoogleAdsApi, config: object}}
 */
export function getApiClient() {
  if (apiInstance && apiConfig) {
    return { api: apiInstance, config: apiConfig };
  }

  const config = loadConfig();
  validateConfig(config);

  apiConfig = config;
  apiInstance = new GoogleAdsApi({
    client_id: config.client_id,
    client_secret: config.client_secret,
    developer_token: config.developer_token,
  });

  return { api: apiInstance, config: apiConfig };
}

/**
 * Obtains a Google Ads Customer instance for operations.
 * @param {string} [customerId] - Optional 10-digit customer ID. Falls back to default.
 * @param {string} [loginCustomerId] - Optional MCC manager ID for THIS call,
 *   overriding the global config. Needed when accounts sit under different
 *   managers (resolved per-account from accounts.json). Dashes are stripped.
 * @returns {object} The Customer instance
 */
export function getCustomer(customerId, loginCustomerId) {
  const { api, config } = getApiClient();

  // Clean customer ID format (remove dashes)
  let targetCustomerId = customerId ? String(customerId).replace(/-/g, '') : config.default_customer_id;

  if (!targetCustomerId) {
    throw new Error('No target Customer ID specified and no default Customer ID configured. Please specify a customer ID.');
  }

  const options = {
    customer_id: targetCustomerId,
    refresh_token: config.refresh_token,
  };

  // Per-call login_customer_id wins over global config; either way an MCC
  // manager ID MUST be passed when querying a child account.
  const effectiveLogin = loginCustomerId
    ? String(loginCustomerId).replace(/-/g, '')
    : config.login_customer_id;
  if (effectiveLogin) {
    options.login_customer_id = effectiveLogin;
  }

  return api.Customer(options);
}

/**
 * Helper to extract human-readable error messages from nested Google Ads API failures.
 * @param {Error} error 
 * @returns {string} Fully readable error report
 */
export function unpackError(error) {
  let message = error.message || 'Unknown error occurred.';
  const details = [];

  if (error.errors && Array.isArray(error.errors)) {
    error.errors.forEach((err, idx) => {
      let detail = `Error ${idx + 1}: `;
      if (err.message) detail += err.message;
      else if (typeof err === 'string') detail += err;
      else detail += JSON.stringify(err);

      if (err.error_code) {
        detail += ` (Code: ${JSON.stringify(err.error_code)})`;
      }
      if (err.trigger) {
        detail += ` [Triggered by: ${JSON.stringify(err.trigger)}]`;
      }
      if (err.location) {
        detail += ` [At: ${JSON.stringify(err.location)}]`;
      }
      details.push(detail);
    });
  }

  if (details.length > 0) {
    return `${message}\nDetails:\n${details.join('\n')}`;
  }

  return message;
}
