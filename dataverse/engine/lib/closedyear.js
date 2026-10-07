'use strict';
// The closed-fiscal-year guard (DESIGN.md §8d), the Node port of `Donor App Reference\audited_fy.py`.
//
// HARD RULE (Dylan 7/30/26 for QBO, restated 9/24/26 for donor-app gifts): once a fiscal year is closed,
// its gifts are CLOSED. No creating, deactivating, recoding or re-pointing a gift or soft credit whose book
// date falls in a closed FY. The ONE exception (Dylan 10/7/26): a MERGE may re-point closed-year gifts to
// the kept donor, because it changes attribution, not finances (lib/merge, when built).
//
// WHEN A YEAR CLOSES (Dylan 9/29/26): SBRM's FY runs Oct 1 - Sep 30 and each FY locks on Dec 1 after it
// ends. A rule of TIME computed from today's date, never a date anyone moves.
//
// Which tables, and their book-date column, come from envs.json (`closed_year`, per environment), so the
// list is patched centrally. A table not listed there is not guarded.

const LOCK_MONTH = 12; // Dec (1-based), the month an FY locks after it ends

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// The last day of the most recent CLOSED fiscal year on `today` (local date), as YYYY-MM-DD.
function closedThrough(today = new Date()) {
  const y = today.getFullYear();
  const year = today.getMonth() + 1 >= LOCK_MONTH ? y : y - 1;
  return ymd(year, 9, 30);
}

// The LOCAL calendar day of a stored book date. Dataverse stores it at local midnight, 07:00Z (PDT) or
// 08:00Z (PST); a 6-hour shift lands each on its own day (same rule as audited_fy._day). A date-only
// string is taken as is. Unknown -> null.
function bookDay(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  if (!s.includes('T')) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

// True only when the book date is AFTER the last closed FY. An unknown date is NOT open (refused).
function isOpen(bookdate, today = new Date()) {
  const d = bookDay(bookdate);
  return d !== null && d > closedThrough(today);
}

function fyOf(day) {
  const [y, m] = day.split('-').map(Number);
  return m >= 10 ? y + 1 : y;
}

function why(bookdate, today = new Date()) {
  const d = bookDay(bookdate);
  if (d === null) return 'has no book date, so the closed-year rule cannot be checked';
  const [cy, cm, cd] = closedThrough(today).split('-');
  return `is in a closed fiscal year (book date ${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(0, 4)}, FY${String(fyOf(d)).slice(2)}; `
    + `closed through ${Number(cm)}/${Number(cd)}/${cy}). Closed-year gifts are never modified`;
}

// The guarded book-date column for this env + table, or null.
function guardFor(envInfo, table) {
  const g = (envInfo && envInfo.closed_year) || {};
  return Object.prototype.hasOwnProperty.call(g, table) ? g[table] : null;
}

module.exports = { closedThrough, bookDay, isOpen, why, guardFor, LOCK_MONTH };
