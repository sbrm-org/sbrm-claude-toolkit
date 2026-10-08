'use strict';
// The closed-year rule, case for case with Donor App Reference\audited_fy.py's self-test, so the
// Node engine and the Python jobs can never disagree about which gifts are closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { closedThrough, bookDay, isOpen, why, guardFor } = require('../lib/closedyear');

const day = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };

test('a fiscal year locks on Dec 1 after it ends (audited_fy self-test cases)', () => {
  const cases = {
    '2026-09-29': '2025-09-30', '2026-11-30': '2025-09-30', '2026-12-01': '2026-09-30', '2027-01-15': '2026-09-30',
    '2027-11-30': '2026-09-30', '2027-12-01': '2027-09-30', '2025-12-01': '2025-09-30',
  };
  for (const [today, want] of Object.entries(cases)) assert.equal(closedThrough(day(today)), want, today);
});

test('book dates: stored at local midnight in UTC, read as their local day (audited_fy cases)', () => {
  const t = day('2026-09-29');
  const cases = {
    '2025-09-30T07:00:00Z': false, '2025-10-01T07:00:00Z': true, '2025-10-01T00:00:00Z': false,
    '2024-11-22': false, '2026-01-02T08:00:00Z': true, '2025-11-24T08:00:00': true, '2025-09-30T07:00:00': false,
  };
  for (const [v, want] of Object.entries(cases)) assert.equal(isOpen(v, t), want, v);
  assert.equal(isOpen(null, t), false, 'an unknown date is never open');
  assert.equal(isOpen('', t), false);
  assert.equal(isOpen('2026-09-15T07:00:00Z', day('2026-12-01')), false, 'FY26 closes on Dec 1, 2026');
  assert.equal(isOpen('2026-10-02T07:00:00Z', day('2026-12-01')), true);
  assert.equal(bookDay('2025-10-01T07:00:00Z'), '2025-10-01');
});

test('the refusal says why in plain words', () => {
  assert.equal(why('2025-09-14T07:00:00Z', day('2026-10-07')),
    'is in a closed fiscal year (book date 9/14/2025, FY25; closed through 9/30/2025). Closed-year gifts are never modified');
  assert.match(why(null), /has no book date/);
});

test('only tables listed in envs.json are guarded', () => {
  const env = { closed_year: { msnfp_transactions: 'msnfp_bookdate' } };
  assert.equal(guardFor(env, 'msnfp_transactions'), 'msnfp_bookdate');
  assert.equal(guardFor(env, 'contacts'), null);
  assert.equal(guardFor({}, 'msnfp_transactions'), null);
});
