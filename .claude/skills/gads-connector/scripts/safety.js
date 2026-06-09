/**
 * SafetyLimits — pure guardrails that run before a mutation hits the account.
 *
 * The connector already forces a `--dry-run` preview, but a preview only *shows*
 * the change; it doesn't *stop* a dangerous one. These checks block the kinds of
 * mistakes that are expensive and hard to undo (a runaway budget jump), unless
 * the operator explicitly overrides with `--force`.
 *
 * Everything here is pure (no API calls) so it stays trivially testable offline.
 */

/** Max allowed daily-budget change, in percent, before a mutation is blocked. */
export const DEFAULT_MAX_BUDGET_CHANGE_PCT = 40;

/**
 * No-delete policy. The connector deliberately NEVER removes Google Ads resources
 * (campaigns, ad groups, keywords, etc.) — removal is permanent and irreversible.
 * Anything that can be paused should be paused, not deleted. There is no `--force`
 * override for this: deletion must be done by hand in the Google Ads UI.
 */
export const NO_DELETE_POLICY =
  'Connector nie usuwa zasobów Google Ads (kampanii, grup reklam, słów kluczowych itd.). ' +
  'Usuwanie jest nieodwracalne i celowo poza zakresem — zamiast tego użyj pauzy (PAUSED). ' +
  'Jeśli naprawdę musisz coś usunąć, zrób to ręcznie w panelu Google Ads.';

/** Statuses the connector refuses to set, because they remove the resource. */
export const FORBIDDEN_STATUSES = ['REMOVED'];

/**
 * Hard guard against turning a status mutation into a deletion. Throws with the
 * no-delete policy message for REMOVED (or any future removal status).
 * @param {string} status
 */
export function assertNotRemoval(status) {
  if (FORBIDDEN_STATUSES.includes(String(status).toUpperCase())) {
    throw new Error(`🛑 ${NO_DELETE_POLICY}`);
  }
}

/**
 * Percentage change from `current` to `next`.
 * Returns Infinity when there is no usable baseline (current unknown/<=0) but a
 * positive new value is requested — i.e. we can't verify the change, so callers
 * should treat it as unsafe.
 * @param {number|null|undefined} current
 * @param {number} next
 * @returns {number}
 */
export function pctChange(current, next) {
  const cur = Number(current);
  if (!Number.isFinite(cur) || cur <= 0) {
    return next > 0 ? Infinity : 0;
  }
  return ((Number(next) - cur) / cur) * 100;
}

/**
 * Decide whether a budget change is within the safety limit.
 * @param {number|null|undefined} currentAmount - current daily budget (standard currency)
 * @param {number} newAmount - requested daily budget (standard currency)
 * @param {{limitPct?: number}} [opts]
 * @returns {{currentAmount: number|null, newAmount: number, pctChange: number|null,
 *            limitPct: number, safe: boolean, reason: string|null}}
 */
export function checkBudgetChange(currentAmount, newAmount, opts = {}) {
  const limitPct = opts.limitPct ?? DEFAULT_MAX_BUDGET_CHANGE_PCT;
  const change = pctChange(currentAmount, newAmount);
  const abs = Math.abs(change);
  const safe = Number.isFinite(change) && abs <= limitPct;

  let reason = null;
  if (!safe) {
    reason = Number.isFinite(change)
      ? `Zmiana budżetu o ${Math.round(abs)}% przekracza limit bezpieczeństwa ${limitPct}%.`
      : `Nie udało się ustalić obecnego budżetu — nie mogę zweryfikować skali zmiany.`;
  }

  return {
    currentAmount: currentAmount ?? null,
    newAmount: Number(newAmount),
    pctChange: Number.isFinite(change) ? Math.round(change * 10) / 10 : null,
    limitPct,
    safe,
    reason,
  };
}
