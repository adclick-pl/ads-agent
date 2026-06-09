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
