import path from 'path';
import os from 'os';

/**
 * Default row-count threshold: results with this many rows or fewer are returned
 * inline; larger results are written to CSV to keep them out of the AI's context.
 */
export const DEFAULT_INLINE_THRESHOLD = 500;

/**
 * Decide how to emit a result set.
 * Explicit flags win; otherwise the row count vs the threshold decides.
 * @param {number} rowCount
 * @param {{forceJson?: boolean, forceCsv?: boolean, threshold?: number}} [opts]
 * @returns {'json' | 'csv'}
 */
export function chooseOutputMode(rowCount, opts = {}) {
  const { forceJson = false, forceCsv = false, threshold = DEFAULT_INLINE_THRESHOLD } = opts;
  if (forceCsv) return 'csv';
  if (forceJson) return 'json';
  return rowCount > threshold ? 'csv' : 'json';
}

/**
 * Build a default temp CSV path for an action, used by --auto when the result is
 * large and no explicit --output was given.
 * @param {string} action - e.g. "get-search-terms"
 * @returns {string} absolute path under the OS temp dir
 */
export function defaultCsvPath(action = 'query') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(os.tmpdir(), `gads-${action}-${stamp}.csv`);
}
