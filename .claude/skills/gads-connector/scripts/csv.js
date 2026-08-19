/**
 * Minimal, dependency-free CSV serialiser for the flat row objects produced by
 * queries.js (`runRawQuery`). Writing results to disk instead of returning them
 * inline keeps large pulls out of the model's context window — the agent gets a
 * file path + row count, then reads only what it needs.
 */

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Quote if the cell contains a comma, quote, or newline; double inner quotes.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Convert an array of flat objects to a CSV string. The column set is the union
 * of all keys across rows (stable first-seen order), so ragged rows are handled.
 * @param {Array<object>} rows
 * @returns {string} CSV text (with header row)
 */
export function rowsToCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const lines = [columns.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c])).join(','));
  }
  return lines.join('\n');
}

/**
 * Minimal CSV parser (the inverse of `rowsToCsv`) for reading a batch-input file
 * of mutations. Handles quoted cells, escaped `""`, and CR/LF line endings. The
 * first non-empty line is the header; each remaining line becomes an object
 * keyed by the column name **exactly as written in the file**. Blank lines are
 * skipped.
 *
 * Header case is preserved on purpose: these CSVs are also produced by other
 * connectors (GA4 emits camelCase like `sessionDefaultChannelGroup`), and
 * lower-casing the keys silently turned every such column into `undefined` —
 * a whole analysis rendering as zeros with no error. Look columns up with
 * `field()` instead of indexing directly, so alias/case differences can't bite.
 *
 * @param {string} text - raw CSV file contents
 * @returns {Array<object>} one object per data row
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, ''); // strip BOM
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { pushField(); rows.push(record); record = []; };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { pushField(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { pushRecord(); i++; continue; }
    field += ch; i++;
  }
  // flush trailing field/record if the file doesn't end in a newline
  if (field.length > 0 || record.length > 0) pushRecord();

  // Drop fully-empty records (e.g. trailing blank line → [''])
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return [];

  const header = nonEmpty[0].map((h) => h.trim());
  // Map of lower-cased name → real key, shared by every row (built once).
  const byLower = new Map(header.map((h) => [h.toLowerCase(), h]));

  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    header.forEach((key, idx) => { obj[key] = (r[idx] ?? '').trim(); });
    // Keys keep their original spelling (so `Object.keys`/`rowsToCsv` round-trip
    // cleanly), but reads fall back to a case-insensitive match — that way
    // `row.final_url` and `row.sessionDefaultChannelGroup` both work no matter
    // how the file spelled the header.
    return new Proxy(obj, {
      get(target, prop) {
        if (typeof prop !== 'string' || prop in target) return target[prop];
        const real = byLower.get(prop.toLowerCase());
        return real === undefined ? undefined : target[real];
      },
      has(target, prop) {
        if (typeof prop === 'string' && !(prop in target)) return byLower.has(prop.toLowerCase());
        return prop in target;
      },
    });
  });
}

/**
 * Case-insensitive column lookup with aliases. Returns the first alias present
 * in the row with a non-empty value, or undefined.
 *
 * Use this instead of `row.some_column` when reading a user-supplied CSV: the
 * file may capitalise headers differently than we do, and a silent `undefined`
 * is far worse than a slightly slower lookup.
 *
 * @param {object} row - one row from parseCsv
 * @param {...string} aliases - accepted column names, best first
 * @returns {string|undefined}
 */
export function field(row, ...aliases) {
  if (!row) return undefined;
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const alias of aliases.flat()) {
    const key = lower.get(String(alias).toLowerCase());
    if (key !== undefined && String(row[key] ?? '').trim() !== '') return row[key];
  }
  return undefined;
}
