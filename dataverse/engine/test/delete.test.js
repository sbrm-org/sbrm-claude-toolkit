'use strict';
// The admin delete of records (ruled 10/7: "let admin do deletes of all"), end to end, plus the typed
// confirmation in the pop-up and the severity re-check at apply (DESIGN.md §10j, §10k).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-delete-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const { validateJob } = require('../lib/contract');
const { planJob } = require('../lib/resolve');
const { savePlan, loadPlan } = require('../lib/store');
const { applyPlan } = require('../lib/apply');
const { buildJob } = require('../lib/revert');
const { confirm, sameTyped } = require('../lib/dialog');
const severity = require('../lib/severity');
const { readAccess } = require('../lib/access');
const { fakeDv, IDS, ENVS, ACCESS } = require('./fake');

const LOG = 'sbrm_dataversewritelogs';
const entryOf = (row) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(row.sbrm_entry)[1]);

async function deletePlan(dv, rows, { warnRows } = {}) {
  const res = validateJob({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'delete', source: 'test', reason: 'Remove test records.',
    intent: { verb: 'delete', count: rows.length, table: 'contacts', fields: [] }, rows,
  }, { envs: ENVS });
  assert.deepEqual(res.errors, []);
  return savePlan(await planJob(dv, res.job, { envs: ENVS, access: ACCESS, warnRows })).id;
}

const run = async (id, dv, over = {}) => applyPlan(id, { access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }), ...over });

test('an admin delete: the pop-up asks for the name typed, the record is gone, the log keeps every column', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await deletePlan(dv, [{ name: 'Jane Example', id: IDS.jane }]);
  let shown = null;
  const res = await run(id, dv, { confirm: (x) => { shown = x; return { approved: true }; } });
  assert.equal(res.outcome, 'applied');
  assert.equal(shown.typed, 'Jane Example', 'the pop-up is told what must be typed');
  assert.match(shown.title, /DELETING/);
  assert.match(shown.summaryText, /^Before you approve:\n  ! Can't be fully undone: deletes 1 contact for good/);
  assert.equal(dv.data.contacts[IDS.jane], undefined, 'gone');
  const del = dv.calls.find((c) => c.method === 'DELETE');
  assert.match(del.etag, /^W\/"\d+"$/, 'the delete carries If-Match');
  const entry = entryOf(Object.values(dv.data[LOG])[0]);
  assert.equal(entry.mode, 'delete');
  assert.equal(entry.rows[0].before.address1_line1, '12 Old Rd', 'every column as it stood is in the log');
  assert.throws(() => loadPlan(id), /no plan/, 'plan consumed');
});

test('the access is re-read at apply: an admin who is no longer one cannot delete', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await deletePlan(dv, [{ name: 'Jane Example', id: IDS.jane }]);
  for (const r of Object.values(dv.data.sbrm_dataversewriteaccesses)) if (r.sbrm_email === 'dgross@example.org') r.sbrm_level = 'develop';
  // Read from the (fake) Write Access table at apply, as the CLI does.
  await assert.rejects(run(id, dv, { access: (d, env) => readAccess(d, env), confirm: () => { throw new Error('no pop-up'); } }), /now develop, not admin/);
  assert.ok(dv.data.contacts[IDS.jane], 'not deleted');
});

test('a record that changed since the plan is left out, never deleted', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await deletePlan(dv, [{ name: 'Jane Example', id: IDS.jane }, { name: 'Ina Active', id: IDS.inactive }]);
  dv.touch('contacts', IDS.inactive, { address1_city: 'Ventura' });
  let shown = null;
  const res = await run(id, dv, { confirm: (x) => { shown = x; return { approved: true }; } });
  assert.equal(res.written, 1);
  assert.equal(shown.typed, 'Jane Example', 'the typed name follows what is still being deleted');
  assert.ok(dv.data.contacts[IDS.inactive], 'Ina was edited after the plan, so she stays');
  assert.match(res.left_out[0].why, /changed since the plan/);
});

test('cancel deletes nothing', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await deletePlan(dv, [{ name: 'Jane Example', id: IDS.jane }]);
  const res = await run(id, dv, { confirm: () => ({ approved: false }) });
  assert.equal(res.outcome, 'cancelled');
  assert.ok(dv.data.contacts[IDS.jane]);
  assert.ok(!dv.calls.some((c) => c.method === 'DELETE'));
});

test('a delete that does not take is reported, not claimed', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  dv.removeIgnored = true;
  const id = await deletePlan(dv, [{ name: 'Jane Example', id: IDS.jane }]);
  const res = await run(id, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /read-back mismatch: the record is still there/);
});

test('undo of a delete is refused, and says where the record\'s values are', () => {
  assert.throws(() => buildJob(fakeDv(), { mode: 'delete', outcome: 'applied', plan_id: 'P1', rows: [] }), /a delete cannot be undone by the toolkit.*plan P1/);
});

// ---- the typed confirmation (lib/dialog.js) ----

test('typed text compares without case or outer spaces; the pop-up is handed the phrase', () => {
  assert.ok(sameTyped('  jane example ', 'Jane Example'));
  assert.ok(!sameTyped('Jane', 'Jane Example'));
  assert.ok(!sameTyped(null, 'Jane Example'));
  let got = null;
  const res = confirm({ summaryText: 's', detailText: 'd', title: 't', typed: 'delete 2' }, { ask: (text, title, env, typed) => { got = typed; return { answer: 'APPROVE' }; }, open: () => {}, env: process.env });
  assert.equal(got, 'delete 2');
  assert.equal(res.approved, true);
  const no = confirm({ summaryText: 's', detailText: 'd', title: 't', typed: 'delete 2' }, { ask: () => ({ answer: 'CANCEL', note: 'approve needs "delete 2" typed exactly' }), open: () => {}, env: process.env });
  assert.deepEqual(no, { approved: false, note: 'approve needs "delete 2" typed exactly' });
});

test('typedPhrase: one thing is its name, several are "delete N", nothing is null', () => {
  assert.equal(severity.typedPhrase(['Interviews']), 'Interviews');
  assert.equal(severity.typedPhrase(['a', 'b', 'c']), 'delete 3');
  assert.equal(severity.typedPhrase([]), null);
});

// ---- severity (lib/severity.js) ----

test('severity: routine has no lines; each kind adds its line; grew() catches a bigger or more serious change', () => {
  const routine = severity.assess({ count: 3, noun: 'contacts' }, { warnRows: 50 });
  assert.deepEqual(routine.lines, []);
  assert.deepEqual(severity.block(routine), []);
  const big = severity.assess({ count: 51, noun: 'contacts', lasting: ['creates 1 column'], irreversible: ['x'], unproven: 'Not tried in Donor App Dev first' }, { warnRows: 50 });
  assert.deepEqual(big.lines, [
    'Large change: 51 contacts.',
    "Can't be fully undone: x.",
    'Lasting: creates 1 column. Undo cannot remove it; only an admin delete can.',
    'Not tried in Donor App Dev first.',
  ]);
  assert.equal(severity.grew(routine, big), true);
  assert.equal(severity.grew(big, routine), false, 'a smaller change at apply is fine');
  assert.equal(severity.grew(routine, severity.assess({ count: 3, noun: 'contacts', irreversible: ['y'] })), true, 'a new warning kind is growth');
  assert.equal(severity.grew(routine, routine), false);
});

// ---- what a delete takes with it (lib/cascade.js; 10/7 blind review finding 4) ----

const TASK1 = 'dddddddd-0000-0000-0000-000000000001';

test('a delete shows, counts and logs what it takes with it; a Restrict record is left out at plan', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const res = validateJob({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'delete', source: 'test', reason: 'R.',
    intent: { verb: 'delete', count: 2, table: 'contacts', fields: [] },
    rows: [{ name: 'Jane Example', id: IDS.jane }, { name: 'Bob Sample', id: IDS.bob }],
  }, { envs: ENVS });
  const plan = await planJob(dv, res.job, { envs: ENVS, access: ACCESS });
  assert.deepEqual(plan.rows.map((r) => r.name), ['Jane Example']);
  assert.match(plan.refused[0].why, /1 linked task block deleting it/);
  assert.ok(plan.severity.lines.some((l) => /also deletes the records linked to it: 1 task/.test(l)), plan.severity.lines.join('\n'));
  assert.deepEqual(plan.rows[0].cascade.Contact_Tasks.ids, [TASK1]);
  // Many-to-many associations go too (re-verify): counted and shown.
  assert.ok(plan.severity.lines.some((l) => /removes 2 links to sbrm_tag records/.test(l)), plan.severity.lines.join('\n'));
  assert.equal(plan.rows[0].cascade.sbrm_contact_tag.ids.length, 2);
  const id = savePlan(plan).id;
  const out = await run(id, dv);
  assert.equal(out.outcome, 'applied');
  const entry = entryOf(Object.values(dv.data[LOG])[0]);
  assert.deepEqual(entry.rows[0].cascade.Contact_Tasks.ids, [TASK1], 'the log keeps every linked id the delete took');
});

test('a linked record that appears between plan and apply refuses the delete (the pop-up would understate it)', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await deletePlan(dv, [{ name: 'Ina Active', id: IDS.inactive }]);
  dv.data.tasks['dddddddd-0000-0000-0000-000000000009'] = { activityid: 'dddddddd-0000-0000-0000-000000000009', subject: 'new', _regardingobjectid_value: IDS.inactive };
  await assert.rejects(run(id, dv, { confirm: () => { throw new Error('no pop-up'); } }), /linked to Ina Active changed since the plan/);
  assert.ok(dv.data.contacts[IDS.inactive]);
});

// ---- records jobs never touch the app's own definitions (finding 1) or skip admin on toolkit tables (9) ----

test('a records job on a flow, form, view or connection is refused at every level', async () => {
  for (const table of ['workflows', 'systemforms', 'savedqueries', 'connectionreferences', 'sitemaps', 'solutions', 'roles']) {
    const res = validateJob({
      contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table, mode: 'update', source: 't', reason: 'R.',
      intent: { verb: 'update', count: 1, table, fields: ['statecode'] }, rows: [{ name: 'x', id: IDS.jane, body: { statecode: 1 } }],
    }, { envs: ENVS });
    assert.deepEqual(res.errors, []);
    for (const email of ['writer@example.org', 'dgross@example.org']) {
      assert.throws(() => planJob(fakeDv({ email }), res.job, { envs: ENVS, access: ACCESS }), /holds the app's own definitions/, `${table} as ${email}`);
    }
  }
});

test('apply re-derives what it needs from the plan\'s table: a tampered or demoted plan on a toolkit table needs admin', async () => {
  const dv = fakeDv({ email: 'writer@example.org' });
  const plan = savePlan({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', host: 'h', app: 'Donor App', table: 'sbrm_dataversewriteaccesses', mode: 'update',
    source: 't', reason: 'R.', intent: {}, identity: { systemuserid: IDS.me, fullname: 'T', email: 'writer@example.org' }, access: 'admin',
    labels: { singular: 'x', plural: 'xs', primary_id: 'sbrm_dataversewriteaccessid' }, columns: {}, verify: [], rows: [{ name: 'x', id: IDS.jane, body: {}, before: {}, changes: [], warnings: [] }], refused: [],
  });
  await assert.rejects(run(plan.id, dv, { access: (d, env) => readAccess(d, env), confirm: () => { throw new Error('no pop-up'); } }), /now write, not admin/);
  const flow = savePlan({ ...loadPlan(plan.id).record, table: 'workflows', created: undefined });
  await assert.rejects(run(flow.id, fakeDv({ email: 'dgross@example.org' }), { confirm: () => { throw new Error('no pop-up'); } }), /never a records job/);
});

// ---- the pop-up and the write must agree (10/7 review finding 3, records) ----

test('a plan whose body writes something other than what it shows is refused before the pop-up', async () => {
  const dv = fakeDv({ email: 'writer@example.org' });
  const res = validateJob({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'update', source: 't', reason: 'R.',
    intent: { verb: 'update', count: 1, table: 'contacts', fields: ['address1_city'] },
    rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Goleta' } }],
  }, { envs: ENVS });
  const plan = await planJob(dv, res.job, { envs: ENVS, access: ACCESS });
  const noPopup = { confirm: () => { throw new Error('no pop-up'); } };
  const swapped = JSON.parse(JSON.stringify(plan));
  swapped.rows[0].body.address1_city = 'Somewhere Else';
  await assert.rejects(run(savePlan(swapped).id, dv, noPopup), /shows Address 1: City as "Goleta" but would write something else/);
  const extra = JSON.parse(JSON.stringify(plan));
  extra.rows[0].body.firstname = 'Hidden';
  await assert.rejects(run(savePlan(extra).id, dv, noPopup), /writes firstname, which it never showed|writes firstname without showing it/);
  const ghost = JSON.parse(JSON.stringify(plan));
  delete ghost.rows[0].body.address1_city;
  ghost.rows[0].body = { address1_city: 'Goleta' };
  ghost.rows[0].changes.push({ column: 'address1_line1', label: 'Street', new: 'x', new_text: 'x' });
  await assert.rejects(run(savePlan(ghost).id, dv, noPopup), /shows a change to Street it would not write/);
  assert.equal((await run(savePlan(plan).id, dv)).outcome, 'applied', 'the untouched plan still applies');
});

test('re-verify: the shown TEXT must match the written value, and every written column needs a before to re-check', async () => {
  const dv = fakeDv({ email: 'writer@example.org' });
  const res = validateJob({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'update', source: 't', reason: 'R.',
    intent: { verb: 'update', count: 1, table: 'contacts', fields: ['address1_city'] },
    rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Goleta' } }],
  }, { envs: ENVS });
  const plan = await planJob(dv, res.job, { envs: ENVS, access: ACCESS });
  const noPopup = { confirm: () => { throw new Error('no pop-up'); } };
  const text = JSON.parse(JSON.stringify(plan));
  text.rows[0].changes[0].new_text = 'Santa Barbara';
  await assert.rejects(run(savePlan(text).id, dv, noPopup), /text for Address 1: City does not match/);
  const nobefore = JSON.parse(JSON.stringify(plan));
  delete nobefore.rows[0].before.address1_city;
  await assert.rejects(run(savePlan(nobefore).id, dv, noPopup), /without a before value to re-check/);
});

test('a delete is refused when WHICH linked kinds could not be checked changed since the plan (final re-verify)', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await deletePlan(dv, [{ name: 'Jane Example', id: IDS.jane }]);
  delete dv.data.tasks; // the task table can no longer be read at apply
  await assert.rejects(run(id, dv, { confirm: () => { throw new Error('no pop-up'); } }), /which linked records could not be checked changed since the plan/);
});
