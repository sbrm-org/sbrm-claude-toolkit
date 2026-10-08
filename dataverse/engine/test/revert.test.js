'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-revert-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const { validateJob } = require('../lib/contract');
const { planJob, PlanRefused } = require('../lib/resolve');
const { savePlan } = require('../lib/store');
const { applyPlan } = require('../lib/apply');
const { planRevert, findEntry } = require('../lib/revert');
const { summary, detail } = require('../lib/render');
const { fakeDv, IDS, ENVS, ACCESS } = require('./fake');

const LOG = 'sbrm_dataversewritelogs';
const approve = () => ({ approved: true });
const writes = (dv) => dv.calls.filter((c) => c.method !== 'GET' && c.path !== LOG);

function makePlan(raw, dv) {
  const fields = [...new Set(raw.rows.flatMap((r) => Object.keys(r.body)))].sort();
  const res = validateJob({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', source: 'test', reason: 'Test.',
    intent: { verb: raw.mode, count: raw.rows.length, table: 'contacts', fields }, ...raw,
  }, { envs: ENVS });
  assert.deepEqual(res.errors, []);
  return savePlan(planJob(dv, res.job, { envs: ENVS, access: ACCESS })).id;
}

// Plan + apply a write, then return its plan id (its entry is now in the fake log table).
function applied(raw, dv) {
  const id = makePlan(raw, dv);
  const res = applyPlan(id, { access: ACCESS, connect: () => dv, confirm: approve });
  assert.equal(res.logged.rowOk, true);
  return { id, res };
}

// Plan the undo and save it the way the CLI does; returns { id, plan }.
function revertOf(origId, dv) {
  const { plan } = planRevert(dv, findEntry(dv, origId), { envs: ENVS, access: ACCESS });
  return { id: savePlan(plan).id, plan };
}

const run = (id, dv, confirm = approve) => applyPlan(id, { access: ACCESS, connect: () => dv, confirm });

test('update revert: every changed column goes back, through its own pop-up, logged as undoing the original', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara', 'parentcustomerid_account@odata.bind': `/accounts(${IDS.acme})` } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_city: 'Santa Barbara' } },
  ] }, dv);
  const before = writes(dv).length;

  const { id, plan } = revertOf(orig, dv);
  assert.equal(writes(dv).length, before, 'planning a revert writes nothing');
  assert.equal(plan.reverts_plan_id, orig);
  assert.equal(plan.source, `revert ${orig}`);
  assert.match(plan.reason, new RegExp(`^Undo plan ${orig} \\("Update 2 contacts in the Donor App", applied .* by Test Person\\)\\.$`));
  assert.deepEqual(plan.rows.find((r) => r.id === IDS.jane).body, { address1_city: null, 'parentcustomerid_account@odata.bind': null });
  assert.deepEqual(plan.rows.find((r) => r.id === IDS.bob).body, { address1_city: 'Goleta' });
  assert.match(detail(plan, { id }), new RegExp(`Undoes plan: ${orig}`));

  let shown = null;
  const res = run(id, dv, (x) => { shown = x; return { approved: true }; });
  assert.ok(shown, 'a revert is approved in the pop-up like any write');
  assert.match(shown.summaryText, /^Update 2 contacts in the Donor App/);
  assert.equal(res.outcome, 'applied');
  assert.equal(dv.data.contacts[IDS.jane].address1_city, null);
  assert.equal(dv.data.contacts[IDS.jane]._parentcustomerid_value, null);
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Goleta');
  const row = Object.values(dv.data[LOG]).find((r) => r.sbrm_planid === id);
  assert.equal(row.sbrm_revertsplanid, orig, 'the log row names the plan it undoes');
  assert.match(row.sbrm_entry, new RegExp(`- Undoes plan: ${orig}`));
});

test('a lookup cleared by the original write is restored to its old record (set from the relationship)', () => {
  const dv = fakeDv();
  dv.touch('contacts', IDS.bob, { _parentcustomerid_value: IDS.acme });
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Bob Sample', id: IDS.bob, body: { 'parentcustomerid_account@odata.bind': null } }] }, dv);
  assert.equal(dv.data.contacts[IDS.bob]._parentcustomerid_value, null);
  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { 'parentcustomerid_account@odata.bind': `/accounts(${IDS.acme})` });
  run(id, dv);
  assert.equal(dv.data.contacts[IDS.bob]._parentcustomerid_value, IDS.acme);
});

test('RULED 10/7: a record whose undone column changed since is LEFT OUT; the rest is undone', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_city: 'Santa Barbara' } },
  ] }, dv);
  dv.touch('contacts', IDS.bob, { address1_city: 'Carpinteria' }); // someone corrected it after us

  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows.map((r) => r.id), [IDS.jane]);
  const out = plan.refused.find((x) => x.id === IDS.bob);
  assert.match(out.why, new RegExp(`changed since plan ${orig}, so it is left as it is \\(Address 1: City: Santa Barbara -> Carpinteria\\)`));
  assert.match(summary(plan), /Left out, will NOT be written \(1\):\n {2}Bob Sample: changed since plan/);
  run(id, dv);
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Carpinteria', 'the later edit survives');
  assert.equal(dv.data.contacts[IDS.jane].address1_city, null);
});

test('an UNRELATED later edit does not block (the check is per column being undone)', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }, dv);
  dv.touch('contacts', IDS.jane, { address1_line1: '77 New St' });
  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.refused, []);
  run(id, dv);
  assert.equal(dv.data.contacts[IDS.jane].address1_city, null);
  assert.equal(dv.data.contacts[IDS.jane].address1_line1, '77 New St');
});

test('two undone columns, one moved: the WHOLE record is left out, never half-undone', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara', address1_line1: '5 Main St' } }] }, dv);
  dv.touch('contacts', IDS.jane, { address1_line1: '6 Main St' });
  assert.throws(() => revertOf(orig, dv), (e) => e instanceof PlanRefused && /every record changed since the original write/.test(e.message)
    && /Address 1: Street 1: 5 Main St -> 6 Main St/.test(e.message));
  assert.equal(dv.data.contacts[IDS.jane].address1_city, 'Santa Barbara');
});

test('a record changed after the revert is PLANNED is still caught at apply (re-check), nothing lands', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }, dv);
  const { id } = revertOf(orig, dv);
  dv.touch('contacts', IDS.jane, { address1_city: 'Ventura' });
  const asked = () => { throw new Error('no pop-up when every row moved'); };
  assert.throws(() => run(id, dv, asked), /every row changed since the plan/);
  assert.equal(dv.data.contacts[IDS.jane].address1_city, 'Ventura');
});

test('already undone: refused, nothing planned', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }, dv);
  run(revertOf(orig, dv).id, dv);
  assert.throws(() => revertOf(orig, dv), PlanRefused);
});

test('create revert: the new record is marked inactive (state + the inactive status), never deleted', () => {
  const dv = fakeDv();
  const { id: orig, res } = applied({ mode: 'create', rows: [{ name: 'New One', body: { lastname: 'One' } }] }, dv);
  const newId = res.rows[0].id;
  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { statecode: 1, statuscode: 2 });
  assert.equal(plan.rows[0].id, newId);
  assert.match(summary(plan), /^Mark 1 contact inactive in the Donor App/);
  run(id, dv);
  assert.equal(dv.data.contacts[newId].statecode, 1);
  assert.equal(dv.data.contacts[newId].statuscode, 2);
  assert.ok(writes(dv).every((c) => c.method !== 'DELETE'));
});

test('records are made inactive, never deleted (ruled 10/8), so a deactivation must UNDO: the record is active again', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { statecode: 1, statuscode: 2 } }] }, dv);
  assert.equal(dv.data.contacts[IDS.jane].statecode, 1);
  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { statecode: 0, statuscode: 1 });
  assert.deepEqual(plan.refused, []);
  run(id, dv);
  assert.equal(dv.data.contacts[IDS.jane].statecode, 0);
  assert.equal(dv.data.contacts[IDS.jane].statuscode, 1);
});

test('a created record edited since is left out too', () => {
  const dv = fakeDv();
  const { id: orig, res } = applied({ mode: 'create', rows: [{ name: 'New One', body: { lastname: 'One' } }] }, dv);
  dv.touch('contacts', res.rows[0].id, { lastname: 'Uno' });
  assert.throws(() => revertOf(orig, dv), /Last Name: One -> Uno/);
});

test('rows the original did not write are not undone, and are listed', () => {
  const dv = fakeDv({ ignoreOnWrite: ['address1_line1'] }); // Bob's write reads back wrong
  const { id: orig } = applied({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_line1: '1 Elm St' } },
  ] }, dv);
  const { plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows.map((r) => r.id), [IDS.jane]);
  assert.match(plan.refused.find((x) => x.id === IDS.bob).why, /not undone: the original write reported "read-back mismatch/);
});

test('nothing to undo: an unknown or cancelled plan', () => {
  const dv = fakeDv();
  assert.equal(findEntry(dv, '20261007-000000-00000000'), null);
  assert.throws(() => planRevert(dv, null, { envs: ENVS, access: ACCESS }), /no applied entry for that plan/);
  const id = makePlan({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'X' } }] }, dv);
  run(id, dv, () => ({ approved: false }));
  assert.equal(findEntry(dv, id), null, 'a cancel is keyed plan id + time, so it is never found as an applied entry');
});

test('a reverter without write access is refused at plan', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }, dv);
  const reader = fakeDv({ email: 'reader@example.org', data: dv.data });
  assert.throws(() => planRevert(reader, findEntry(reader, orig), { envs: ENVS, access: ACCESS }), /has read access to the Donor App, not write/);
});

test('the revert module cannot write: it never imports the write connection', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'revert.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/write['"]\)/.test(src));
  assert.ok(!/require\(['"]\.\/apply['"]\)/.test(src));
});
