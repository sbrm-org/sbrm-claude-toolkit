'use strict';
// A component write this computer gave up on (1.11.30, task #6hwXVXHPvrvGcp7r; 1.11.28 review F3): the CLI's client
// timeout (D-1240) fires while Dataverse saves the change. Before 1.11.30 the apply logged "failed", kept the BEFORE
// state as the after-state, never published and so blocked its own revert. Now, as the records path does (CONTRACT.md
// section 5), the component is re-read every 10 s for up to 2 minutes, never sent again: landed = written (then published
// and read back as usual) with a note; not there = failed, may still land; unreadable = not known.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-ctimeout-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/component');
const { fakeComponentDv, devDv, IDS, ENVS, ACCESS, FETCH, LAYOUT } = require('./fake_component');

const ctx = { envs: ENVS, access: ACCESS, warnRows: 50, readEnv: () => devDv({}) };
const dvAs = (email = 'dev@example.org') => fakeComponentDv({ email });
const SWAPPED = LAYOUT.replace('<cell name="fullname" width="300" /><cell name="emailaddress1" width="150" />', '<cell name="emailaddress1" width="150" /><cell name="fullname" width="300" />');
const snap = (dv, set, id) => C.snapshot(set, dv.data[set][id]);
const base = { contract: 'sbrm-dv-job/1', kind: 'component', env: 'donorapp', source: 'claude-session', reason: 'Test.' };
const valid = (raw) => {
  const r = C.validateComponentJob(raw, { envs: ENVS });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
};
const viewJob = (dv, over = {}) => valid({ ...base, component: { set: 'savedqueries', id: IDS.view, name: 'Active Donors' }, mode: 'update', definition: { layoutxml: SWAPPED }, snapshot_hash: snap(dv, 'savedqueries', IDS.view).hash, intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['columns'] }, ...over });
const stateJob = (dv, mode, { set = 'workflows', id = IDS.flow, name = 'Add Soft Credit', noun = 'flow' } = {}) => valid({ ...base, component: { set, id, name }, mode, snapshot_hash: snap(dv, set, id).hash, intent: { verb: mode, component: noun, name } });

let n = 0;
async function applied(plan, dv) {
  n += 1;
  const file = path.join(HOME, `plan-${n}.json`);
  fs.writeFileSync(file, '{}');
  const sleeps = [];
  const res = await C.applyComponent({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }), sleep: (ms) => sleeps.push(ms),
  }, { id: `20261109-1100${String(n).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, sleeps, row: res.rows[0] };
}
const writes = (dv) => dv.calls.filter((c) => c.method !== 'GET').map((c) => c.method === 'POST' ? c.path : c.method);
const publishes = (dv) => dv.calls.filter((c) => c.path === 'PublishXml').length;

test('update: the save landed before the timeout = written, then published and read back, with a note', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, viewJob(dv), ctx);
  dv.timeoutOnWrite = 'after';
  const { res, row } = await applied(p, dv);
  assert.equal(row.outcome, 'written', row.outcome);
  assert.equal(res.outcome, 'applied');
  assert.ok(row.notes.some((x) => /timed out on this computer, but the change landed/.test(x)), row.notes.join(' | '));
  assert.equal(publishes(dv), 1, 'published after the re-read found it');
  assert.equal(dv.calls.filter((c) => c.method === 'PATCH').length, 1, 'never sent twice');
  assert.equal(row.after.definition.layoutxml, SWAPPED, 'the after-state is the change, not the before');
});

test('update: a saved view sits in the UNPUBLISHED layer until the publish; the re-read looks there', async () => {
  const dv = dvAs();
  dv.unpublishedUntilPublish = true;
  const p = await C.planComponent(dv, viewJob(dv), ctx);
  dv.timeoutOnWrite = 'after';
  const { row } = await applied(p, dv);
  assert.equal(row.outcome, 'written', row.outcome);
  assert.equal(publishes(dv), 1);
  assert.equal(dv.data.savedqueries[IDS.view].layoutxml, SWAPPED, 'live after the publish');
});

test('update: the save lands a few reads late = still written', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, viewJob(dv), ctx);
  dv.timeoutOnWrite = 3;
  const { row, sleeps } = await applied(p, dv);
  assert.equal(row.outcome, 'written', row.outcome);
  assert.ok(sleeps.filter((s) => s === 10000).length >= 1, 'it waited between re-reads');
  assert.equal(publishes(dv), 1);
});

test('update: nothing saved = failed, may still land, never published, never re-sent, after-state unknown', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, viewJob(dv), ctx);
  dv.timeoutOnWrite = 'before';
  const { res, row, sleeps } = await applied(p, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(row.outcome, /^failed: the request timed out on this computer and the change was not on 'Active Donors' after 2 minutes\. It may still land/);
  assert.equal(publishes(dv), 0);
  assert.equal(dv.calls.filter((c) => c.method === 'PATCH').length, 0);
  assert.equal(sleeps.filter((s) => s === 10000).length, 12, 'two minutes of 10 s waits, then the final read');
  assert.equal(row.after, null, 'an unknown after-state is not logged as the before-state');
  await assert.rejects(C.planComponentRevert(dv, { ...res.entry, env: 'donorapp', plan_id: 'p1', person: { fullname: 'T' } }, ctx), /did not land/);
});

test('update: the re-reads fail = not known', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, viewJob(dv), ctx);
  dv.timeoutOnWrite = 'before';
  const realGet = dv.get;
  let armed = false;
  dv.get = (q, o) => { if (armed && q.includes(IDS.view)) throw new (require('../lib/cli').DataverseError)('The service is temporarily unavailable', { code: '0x80072322', status: 503 }); return realGet(q, o); };
  const realUpdate = dv.update;
  dv.update = (...a) => { armed = true; return realUpdate(...a); };
  const { row } = await applied(p, dv);
  assert.match(row.outcome, /^failed: the request timed out on this computer and 'Active Donors' could not be re-read .*whether the change landed is not known/);
});

test('flow on / off / owner: a state change that landed is written', async () => {
  const dv = dvAs();
  dv.data.workflows[IDS.offflow]._ownerid_value = IDS.me;
  const p = await C.planComponent(dv, stateJob(dv, 'on', { id: IDS.offflow, name: 'Sync Letters' }), ctx);
  dv.timeoutOnWrite = 'after';
  const { row } = await applied(p, dv);
  assert.equal(row.outcome, 'written', row.outcome);
  assert.equal(dv.data.workflows[IDS.offflow].statecode, 1);

  const dv3 = dvAs();
  dv3.data.workflows[IDS.offflow]._ownerid_value = IDS.me;
  const p3 = await C.planComponent(dv3, stateJob(dv3, 'on', { id: IDS.offflow, name: 'Sync Letters' }), ctx);
  dv3.timeoutOnWrite = 'before';
  const r3 = await applied(p3, dv3);
  assert.match(r3.row.outcome, /^failed: the request timed out/, 'an On that did not land is not written');

  const dv2 = dvAs();
  const p2 = await C.planComponent(dv2, stateJob(dv2, 'off'), ctx);
  dv2.timeoutOnWrite = 'before';
  const r2 = await applied(p2, dv2);
  assert.match(r2.row.outcome, /^failed: the request timed out/);
});

test('flow definition: landed = written (no publish for a flow)', async () => {
  const dv = dvAs();
  const raw = { ...base, component: { set: 'workflows', id: IDS.flow, name: 'Add Soft Credit' }, mode: 'update', definition: { description: 'Stamp 11/9.' }, snapshot_hash: snap(dv, 'workflows', IDS.flow).hash, intent: { verb: 'update', component: 'flow', name: 'Add Soft Credit', changed: ['description'] } };
  const p = await C.planComponent(dv, valid(raw), ctx);
  dv.timeoutOnWrite = 'after';
  const { row } = await applied(p, dv);
  assert.equal(row.outcome, 'written', row.outcome);
  assert.equal(publishes(dv), 0);
  assert.equal(dv.data.workflows[IDS.flow].description, 'Stamp 11/9.');
});

test('create: found by its name after the timeout = written with its new id; not found = may still land', async () => {
  const dv = dvAs();
  const raw = { ...base, mode: 'create', solution: 'SBRMAdHocChanges', component: { set: 'savedqueries', name: 'Recent Donors' }, definition: { returnedtypecode: 'contact', querytype: 0, fetchxml: FETCH, layoutxml: LAYOUT }, intent: { verb: 'create', component: 'view', name: 'Recent Donors' } };
  const p = await C.planComponent(dv, valid(raw), ctx);
  dv.timeoutOnWrite = 'after';
  const { row } = await applied(p, dv);
  assert.equal(row.outcome, 'written', row.outcome);
  assert.match(row.id, /^cccccccc-/);
  assert.equal(publishes(dv), 1);
  assert.equal(writes(dv).filter((w) => w === 'savedqueries').length, 1, 'never created twice');

  const dv2 = dvAs();
  const p2 = await C.planComponent(dv2, valid(raw), ctx);
  dv2.timeoutOnWrite = 'before';
  const r2 = await applied(p2, dv2);
  assert.match(r2.row.outcome, /^failed: the request timed out on this computer and no view named 'Recent Donors' had appeared after 2 minutes\. It may still land/);
  assert.equal(publishes(dv2), 0);
});

test('delete: gone after the timeout = written', async () => {
  const dv = dvAs('admin@example.org');
  const p = await C.planComponent(dv, stateJob(dv, 'delete', { set: 'savedqueries', id: IDS.view, name: 'Active Donors', noun: 'view' }), ctx);
  dv.timeoutOnWrite = 'after';
  const { row } = await applied(p, dv);
  assert.equal(row.outcome, 'written', row.outcome);
  assert.equal(dv.data.savedqueries[IDS.view], undefined);
});

test('a rename that landed before the timeout is written, and its revert works', async () => {
  const dv = dvAs();
  const raw = { ...base, component: { set: 'savedqueries', id: IDS.view, name: 'Active Donors' }, mode: 'update', definition: { name: 'Donors (active)' }, snapshot_hash: snap(dv, 'savedqueries', IDS.view).hash, intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['name'] } };
  const p = await C.planComponent(dv, valid(raw), ctx);
  dv.timeoutOnWrite = 'after';
  const { res, row } = await applied(p, dv);
  assert.equal(row.outcome, 'written', row.outcome);
  const r = await C.planComponentRevert(dv, { ...res.entry, env: 'donorapp', plan_id: 'p2', person: { fullname: 'T' } }, ctx);
  assert.deepEqual(r.rename, { from: 'Donors (active)', to: 'Active Donors' });
});

test('any other error is still reported as it was (no re-read)', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, viewJob(dv), ctx);
  const real = dv.update;
  dv.update = () => { throw new (require('../lib/cli').DataverseError)('Principal user is missing prvWriteSavedQuery privilege'); };
  const { row, sleeps } = await applied(p, dv);
  assert.match(row.outcome, /^failed: Principal user is missing/);
  assert.equal(sleeps.length, 0);
  dv.update = real;
});
