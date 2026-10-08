'use strict';
// The closed-fiscal-year guard (DESIGN.md §8d), the Node port of `Donor App Reference\audited_fy.py`.
//
// HARD RULE (Dylan 7/30/26 for QBO, restated 9/24/26 for donor-app gifts): once a fiscal year is closed,
// its gifts are CLOSED. No creating, deactivating, recoding or re-pointing a gift or soft credit whose book
// date falls in a closed FY. Two exceptions: a MERGE may re-point closed-year gifts to the kept donor, because
// it changes attribution, not finances (Dylan 10/7/26, lib/merge); and LATE ENTRY (Dylan 10/8/26, below).
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

// THE SECOND EXCEPTION, late entry (Dylan 10/8/26, "yes"): a gift CREATED after its book date's fiscal year
// locked was never in that year's closed books, so its BOOK DATE ALONE may be moved into an open year. Narrow:
// the change sets only the book-date column, the new date is open, and the record was created at or after
// Dec 1, 00:00 Pacific of the year the old date's FY ended (December is always PST, so 08:00Z). Case: GIK batch
// 2026_858, entered 10/8/26, put 17 gifts into 2006-2025 by misreading "26"; moving them out RESTORES the
// closed years. Same rule as audited_fy.late_entry_fix.
function lockedAt(bookdate) {
  const d = bookDay(bookdate);
  return d === null ? null : `${fyOf(d)}-12-01T08:00:00Z`;
}

function lateEntry(oldBookdate, createdon, body, col, today = new Date()) {
  const keys = Object.keys(body || {});
  if (keys.length !== 1 || keys[0] !== col || !isOpen(body[col], today)) return false;
  const lock = lockedAt(oldBookdate);
  const made = createdon ? Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(createdon)) ? createdon : `${createdon}Z`) : NaN;
  return lock !== null && !Number.isNaN(made) && made >= Date.parse(lock);
}

// The plan's note on a row that uses the exception, so the person sees it before the Yes.
function lateEntryNote(oldBookdate, createdon) {
  const d = bookDay(oldBookdate);
  const m = new Date(Date.parse(createdon) - 8 * 3600 * 1000).toISOString().slice(0, 10);
  return `book date moves out of closed FY${String(fyOf(d)).slice(2)}: entered ${Number(m.slice(5, 7))}/${Number(m.slice(8, 10))}/${m.slice(0, 4)}, `
    + 'after that year locked, so it was never in its closed books (late-entry exception, Dylan 10/8/26)';
}

// The guarded book-date column for this env + table, or null.
function guardFor(envInfo, table) {
  const g = (envInfo && envInfo.closed_year) || {};
  return Object.prototype.hasOwnProperty.call(g, table) ? g[table] : null;
}

module.exports = { closedThrough, bookDay, isOpen, why, guardFor, lateEntry, lateEntryNote, LOCK_MONTH };
