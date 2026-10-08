'use strict';
// The closed-year guard inside plan and apply (DESIGN.md §8d). The fake's contacts stand in for gifts:
// envs.json-style config guards `contacts` on `birthdate` as if it were the book date.
// Dates are computed from TODAY so the tests never go stale across a Dec 1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-closed-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const { validateJob } = require('../lib/contract');
const { planJob, PlanRefused } = require('../lib/resolve');
const { savePlan } = require('../lib/store');
const { applyPlan } = require('../lib/apply');
const { closedThrough } = require('../lib/closedyear');
const { fakeDv, IDS, ACCESS } = require('./fake');

const ENVS = { donorapp: { host: 'https://example.invalid', name: 'Donor App', closed_year: { contacts: 'birthdate' } } };

// A date in the last CLOSED fiscal year, and one in the current OPEN year, both as stored (07:00Z).
const closedThru = closedThrough(new Date());           // e.g. 2025-09-30
const CLOSED = `${closedThru}T07:00:00Z`;
const openYear = Number(closedThru.slice(0, 4));
const OPEN = `${openYear}-10-02T07:00:00Z`;             // the day after open-from
const OPEN2 = `${openYear}-10-03T07:00:00Z`;

function job(raw) {
  const fields = [...new Set(raw.rows.flatMap((r) => Object.keys(r.body)))].sort();
  const res = validateJob({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', source: 'test', reason: 'Test.',
    intent: { verb: raw.mode, count: raw.rows.length, table: 'contacts', fields }, ...raw,
  }, { envs: ENVS });
  assert.deepEqual(res.errors, []);
  return res.job;
}
const plan = (dv, raw) => planJob(dv, job(raw), { envs: ENVS, access: ACCESS });

test('an update to a closed-year record is left out; an open one goes ahead', () => {
  const dv = fakeDv();
  dv.touch('contacts', IDS.jane, { birthdate: CLOSED });
  dv.touch('contacts', IDS.bob, { birthdate: OPEN });
  const p = plan(dv, { mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_city: 'X' } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_city: 'X' } },
  ] });
  assert.deepEqual(p.rows.map((r) => r.id), [IDS.bob]);
  assert.match(p.refused[0].why, /^this record is in a closed fiscal year \(book date .*\)\. Closed-year gifts are never modified$/);
  assert.equal(p.closed_year_column, 'birthdate');
});

test('an open record cannot be MOVED into a closed year, and a record with no date is refused', () => {
  const dv = fakeDv();
  dv.touch('contacts', IDS.bob, { birthdate: OPEN });
  assert.throws(() => plan(dv, { mode: 'update', rows: [{ name: 'Bob Sample', id: IDS.bob, body: { birthdate: CLOSED } }] }),
    (e) => e instanceof PlanRefused && /the new book date is in a closed fiscal year/.test(e.message));
  dv.touch('contacts', IDS.jane, { birthdate: null });
  assert.throws(() => plan(dv, { mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'X' } }] }),
    /has no book date, so the closed-year rule cannot be checked/);
});

test('deactivating a closed-year record is refused like any other edit', () => {
  const dv = fakeDv();
  dv.touch('contacts', IDS.jane, { birthdate: CLOSED });
  assert.throws(() => plan(dv, { mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { statecode: 1, statuscode: 2 } }] }),
    /closed fiscal year/);
});

test('a create dated in a closed year, or with no date, is refused; an open one is planned', () => {
  const dv = fakeDv();
  assert.throws(() => plan(dv, { mode: 'create', rows: [{ name: 'Old Gift', body: { lastname: 'Old', birthdate: CLOSED } }] }), /the book date is in a closed fiscal year/);
  assert.throws(() => plan(dv, { mode: 'create', rows: [{ name: 'No Date', body: { lastname: 'NoDate' } }] }), /has no book date/);
  assert.equal(plan(dv, { mode: 'create', rows: [{ name: 'New Gift', body: { lastname: 'New', birthdate: OPEN } }] }).rows.length, 1);
});

test('a table that is not guarded is untouched by the rule', () => {
  const dv = fakeDv();
  dv.touch('contacts', IDS.jane, { birthdate: CLOSED });
  const res = validateJob({ contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'update', source: 't', reason: 'T.',
    intent: { verb: 'update', count: 1, table: 'contacts', fields: ['address1_city'] },
    rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'X' } }] }, { envs: { donorapp: { host: 'h', name: 'Donor App' } } });
  const p = planJob(dv, res.job, { envs: { donorapp: { host: 'h', name: 'Donor App' } }, access: ACCESS });
  assert.equal(p.rows.length, 1);
  assert.equal(p.closed_year_column, null);
});

test('APPLY re-checks: a plan made Nov 30 and applied Dec 1 is caught when the year closes overnight', () => {
  const dv = fakeDv();
  dv.touch('contacts', IDS.bob, { birthdate: OPEN });
  const p = plan(dv, { mode: 'update', rows: [{ name: 'Bob Sample', id: IDS.bob, body: { birthdate: OPEN2 } }] });
  // OPEN is in the fiscal year ending 9/30/(openYear+1); it locks Dec 1 of openYear+1.
  const nov30 = new Date(openYear + 1, 10, 30, 20, 0);
  const dec1 = new Date(openYear + 1, 11, 1, 10, 0);
  const { id } = savePlan(p, { now: nov30 });
  const asked = () => { throw new Error('no pop-up: every row left out'); };
  assert.throws(() => applyPlan(id, { access: ACCESS, connect: () => dv, confirm: asked, now: dec1 }), /every row changed since the plan[\s\S]*closed fiscal year/);
  assert.equal(dv.data.contacts[IDS.bob].birthdate, OPEN, 'nothing written');
});

test('APPLY re-checks the NEW date too: a move into the year that closed overnight is caught', () => {
  const dv = fakeDv();
  const nextYearDate = `${openYear + 1}-10-02T07:00:00Z`; // in the fiscal year AFTER the one that locks
  dv.touch('contacts', IDS.bob, { birthdate: nextYearDate });
  const p = plan(dv, { mode: 'update', rows: [{ name: 'Bob Sample', id: IDS.bob, body: { birthdate: OPEN2 } }] });
  const { id } = savePlan(p, { now: new Date(openYear + 1, 10, 30, 20, 0) });
  const asked = () => { throw new Error('no pop-up: every row left out'); };
  assert.throws(() => applyPlan(id, { access: ACCESS, connect: () => dv, confirm: asked, now: new Date(openYear + 1, 11, 1, 10, 0) }),
    /the new book date is in a closed fiscal year/);
  assert.equal(dv.data.contacts[IDS.bob].birthdate, nextYearDate, 'nothing written');
});

test('a revert cannot touch a closed-year record either (it is planned through the same guard)', () => {
  const dv = fakeDv();
  dv.touch('contacts', IDS.jane, { birthdate: CLOSED });
  // The revert module builds an ordinary update job; the guard sees it like any other.
  assert.throws(() => plan(dv, { mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: 'back' } }] }), /closed fiscal year/);
});
