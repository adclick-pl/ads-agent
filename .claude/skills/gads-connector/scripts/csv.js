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
 * keyed by (trimmed, lower-cased) column name. Blank lines are skipped.
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

  const header = nonEmpty[0].map((h) => h.trim().toLowerCase());
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    header.forEach((key, idx) => { obj[key] = (r[idx] ?? '').trim(); });
    return obj;
  });
}
