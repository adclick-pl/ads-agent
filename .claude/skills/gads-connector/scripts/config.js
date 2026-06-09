import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

// Resolve the skill root (one level above /scripts) so the connector works
// no matter which working directory Claude Code or the agent launches it from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

// Load .env: prefer the skill-local file, then fall back to the current
// working directory (so `dotenv` defaults still apply when run elsewhere).
dotenv.config({ path: path.join(SKILL_ROOT, '.env'), quiet: true });
dotenv.config({ quiet: true });

/**
 * Loads the Google Ads configuration from .env or ~/google-ads.yaml
 * @returns {object} The configuration object
 */
export function loadConfig() {
  // 1. Try env vars first
  const envConfig = {
    developer_token: process.env.GADS_DEVELOPER_TOKEN,
    client_id: process.env.GADS_CLIENT_ID,
    client_secret: process.env.GADS_CLIENT_SECRET,
    refresh_token: process.env.GADS_REFRESH_TOKEN,
    login_customer_id: process.env.GADS_LOGIN_CUSTOMER_ID ? String(process.env.GADS_LOGIN_CUSTOMER_ID).replace(/-/g, '') : undefined,
    default_customer_id: process.env.GADS_DEFAULT_CUSTOMER_ID ? String(process.env.GADS_DEFAULT_CUSTOMER_ID).replace(/-/g, '') : undefined
  };

  // Check if env has the core authentication parameters
  const hasEnvCredentials = envConfig.developer_token && envConfig.client_id && envConfig.client_secret && envConfig.refresh_token;

  if (hasEnvCredentials) {
    // If GADS_DEFAULT_CUSTOMER_ID is not provided, fallback to GADS_LOGIN_CUSTOMER_ID
    if (!envConfig.default_customer_id) {
      envConfig.default_customer_id = envConfig.login_customer_id;
    }
    return envConfig;
  }

  // 2. Try loading from ~/google-ads.yaml as fallback
  const yamlPath = path.join(os.homedir(), 'google-ads.yaml');
  if (fs.existsSync(yamlPath)) {
    try {
      const fileContents = fs.readFileSync(yamlPath, 'utf8');
      const yamlConfig = yaml.load(fileContents);
      
      const parsedConfig = {
        developer_token: yamlConfig.developer_token,
        client_id: yamlConfig.client_id,
        client_secret: yamlConfig.client_secret,
        refresh_token: yamlConfig.refresh_token,
        login_customer_id: yamlConfig.login_customer_id ? String(yamlConfig.login_customer_id).replace(/-/g, '') : undefined,
        default_customer_id: yamlConfig.default_customer_id ? String(yamlConfig.default_customer_id).replace(/-/g, '') : undefined
      };

      if (!parsedConfig.default_customer_id) {
        parsedConfig.default_customer_id = parsedConfig.login_customer_id;
      }
      return parsedConfig;
    } catch (e) {
      console.warn(`[Warning] Failed to parse ~/google-ads.yaml: ${e.message}`);
    }
  }

  // Return the environment config if yaml doesn't exist
  return envConfig;
}

/**
 * Validates that all required Google Ads parameters are present
 * @param {object} config 
 * @returns {boolean} True if valid
 * @throws {Error} If credentials are missing
 */
export function validateConfig(config) {
  const missing = [];
  if (!config.developer_token) missing.push('GADS_DEVELOPER_TOKEN / developer_token');
  if (!config.client_id) missing.push('GADS_CLIENT_ID / client_id');
  if (!config.client_secret) missing.push('GADS_CLIENT_SECRET / client_secret');
  if (!config.refresh_token) missing.push('GADS_REFRESH_TOKEN / refresh_token');

  if (missing.length > 0) {
    throw new Error(`Missing required Google Ads API configuration: ${missing.join(', ')}. Please define them in a local .env file or ~/google-ads.yaml.`);
  }

  return true;
}
