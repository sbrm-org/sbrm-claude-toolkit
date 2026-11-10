'use strict';
// 1.11.31 (task #6hxFqHHhxvR2MCcr; the 1.11.30 C1 review's F4, general case, PRE-EXISTING for every component set):
// a component update logs row.after as the WHOLE re-read definition but its read-back compares only the fields it
// sent, so if another writer changed an unsent field between the publish and the read-back, row.after holds their
// edit, the read-back still says "written", and a later revert (hash of row.after, then every field from row.before)
// put the old value back over theirs. Now the log row carries `sent_fields` and revert restores only those; an older
// entry without it keeps the whole-definition restore. Each test was red before the fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-revfields-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/component');
const { fakeComponentDv, devDv, IDS, ENVS, ACCESS, LAYOUT } = require('./fake_component');

const ctx = { envs: ENVS, access: ACCESS, warnRows: 50, readEnv: () => devDv({}) };
const dvAs = () => fakeComponentDv({ email: 'dev@example.org' });
const snap = (dv, set, id) => C.snapshot(set, dv.data[set][id]);
const SWAPPED = LAYOUT.replace('<cell name="fullname" width="300" /><cell name="emailaddress1" width="150" />', '<cell name="emailaddress1" width="150" /><cell name="fullname" width="300" />');
const valid = (raw) => {
  const r = C.validateComponentJob(raw, { envs: ENVS });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
};
const base = { contract: 'sbrm-dv-job/1', kind: 'component', env: 'donorapp', source: 'claude-session', reason: 'Test.' };
const layout = (dv) => valid({ ...base, component: { set: 'savedqueries', id: IDS.view, name: 'Active Donors' }, mode: 'update', definition: { layoutxml: SWAPPED }, snapshot_hash: snap(dv, 'savedqueries', IDS.view).hash, intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['columns'] } });
let n = 0;
async function applied(plan, dv, over = {}) {
  n += 1;
  const file = path.join(HOME, `plan-${n}.json`);
  fs.writeFileSync(file, '{}');
  const res = await C.applyComponent({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }), sleep: () => {}, ...over,
  }, { id: `20261110-1200${String(n).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, row: res.rows[0] };
}
// Another writer's edit of an UNSENT field, read back in the same moment as this change: it sits in row.after
// (as the read-back put it there) and on the live component (so the whole-definition hash still matches).
function theirsOnDescription(dv, entry) {
  dv.data.savedqueries[IDS.view].description = 'Theirs, saved between the publish and the read-back.';
  entry.rows[0].after.definition.description = 'Theirs, saved between the publish and the read-back.';
  return entry;
}
const revertable = (res) => ({ ...res.entry, env: 'donorapp', plan_id: 'p-fields', person: { fullname: 'T' } });

test('the log row of a component update names the fields the plan sent', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, layout(dv), ctx);
  const { row } = await applied(p, dv);
  assert.equal(row.outcome, 'written');
  assert.deepEqual(row.sent_fields, ['layoutxml']);
});

test('reverting a layout change restores the layout only; a description another writer saved meanwhile is kept', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, layout(dv), ctx);
  const { res } = await applied(p, dv);
  const entry = theirsOnDescription(dv, revertable(res));
  const r = await C.planComponentRevert(dv, entry, ctx);
  assert.deepEqual(r.sent_fields, ['layoutxml']);
  const body = C.bodyFor(r);
  assert.deepEqual(Object.keys(body), ['layoutxml']);
  assert.equal(body.layoutxml, LAYOUT);
});

test('the revert still refuses when the component moved on after the read-back (whole-definition hash kept)', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, layout(dv), ctx);
  const { res } = await applied(p, dv);
  const entry = revertable(res);
  dv.data.savedqueries[IDS.view].description = 'Saved AFTER the read-back.';
  await assert.rejects(C.planComponentRevert(dv, entry, ctx), /changed since|no longer matches|has changed/);
});

test('an entry logged before 1.11.31 (no sent_fields) keeps the whole-definition restore', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, layout(dv), ctx);
  const { res } = await applied(p, dv);
  const entry = theirsOnDescription(dv, revertable(res));
  delete entry.rows[0].sent_fields;
  const r = await C.planComponentRevert(dv, entry, ctx);
  const body = C.bodyFor(r);
  assert.ok('description' in body, 'the old restore sends every field, description included');
  assert.equal(body.layoutxml, LAYOUT);
});

test('a flow switch logs no sent_fields: only an update sends fields', async () => {
  const dv = dvAs();
  const on = valid({ ...base, component: { set: 'workflows', id: IDS.offflow, name: 'Sync Letters' }, mode: 'on', snapshot_hash: snap(dv, 'workflows', IDS.offflow).hash, intent: { verb: 'on', component: 'flow', name: 'Sync Letters' } });
  const p = await C.planComponent(dv, on, ctx);
  const { row } = await applied(p, dv);
  assert.equal(row.outcome, 'written');
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'sent_fields'), false, 'no sent_fields key on a switch');
});

// 1.11.31 C1 review (Codex run 20261110-102244-2e8356; receipt reviews/2026-11-10_toolkit_1_11_31_f4): F1-F3, red first.
const renameLayout = (dv, to) => valid({ ...base, component: { set: 'savedqueries', id: IDS.view, name: 'Active Donors' }, mode: 'update', definition: { name: to, layoutxml: SWAPPED }, snapshot_hash: snap(dv, 'savedqueries', IDS.view).hash, intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['name', 'columns'] } });

test('review F1: a name another writer gave the component during the read-back is not renamed back (the plan never sent a name)', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, layout(dv), ctx);
  const { res } = await applied(p, dv);
  const entry = revertable(res);
  dv.data.savedqueries[IDS.view].name = 'Their Name';
  entry.rows[0].after.name = 'Their Name';
  const r = await C.planComponentRevert(dv, entry, ctx);
  assert.ok(!r.rename, 'no rename in the revert');
  assert.equal(Object.prototype.hasOwnProperty.call(C.bodyFor(r), 'name'), false);
  assert.deepEqual(Object.keys(C.bodyFor(r)), ['layoutxml']);
});

test('review F2: a sent_fields that is present but not a list is refused, never read as the legacy full restore', async () => {
  for (const bad of [null, 'layoutxml', { layoutxml: true }, 7]) {
    const dv = dvAs();
    const p = await C.planComponent(dv, layout(dv), ctx);
    const { res } = await applied(p, dv);
    const entry = revertable(res);
    entry.rows[0].sent_fields = bad;
    await assert.rejects(C.planComponentRevert(dv, entry, ctx), /sent_fields/, JSON.stringify(bad));
  }
});

test('review F3: a rename with a layout change reverts both, even if the logged sections were edited to read "name" only', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, renameLayout(dv, 'Donors (active)'), ctx);
  const { res, row } = await applied(p, dv);
  assert.equal(row.outcome, 'written');
  const entry = revertable(res);
  entry.sections = ['name'];
  const r = await C.planComponentRevert(dv, entry, ctx);
  const body = C.bodyFor(r);
  assert.equal(body.name, 'Active Donors');
  assert.equal(body.layoutxml, LAYOUT);
});

test('a rename-only entry logged by 1.11.30 (no sent_fields) is still undone by the name alone', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, valid({ ...base, component: { set: 'savedqueries', id: IDS.view, name: 'Active Donors' }, mode: 'update', definition: { name: 'Donors (active)' }, snapshot_hash: snap(dv, 'savedqueries', IDS.view).hash, intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['name'] } }), ctx);
  const { res } = await applied(p, dv);
  const entry = revertable(res);
  delete entry.rows[0].sent_fields;
  dv.data.savedqueries[IDS.view].layoutxml = SWAPPED;
  entry.rows[0].after.definition.layoutxml = SWAPPED;
  const r = await C.planComponentRevert(dv, entry, ctx);
  assert.deepEqual(C.bodyFor(r), { name: 'Active Donors' });
});

test('a real rename with a layout change reverts the name and the layout (no edit to the entry)', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, renameLayout(dv, 'Donors (active)'), ctx);
  const { res } = await applied(p, dv);
  const r = await C.planComponentRevert(dv, revertable(res), ctx);
  const body = C.bodyFor(r);
  assert.equal(body.name, 'Active Donors');
  assert.equal(body.layoutxml, LAYOUT);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'description'), false);
});

test('a forged sent_fields naming a field the set does not have is ignored, never sent', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, layout(dv), ctx);
  const { res } = await applied(p, dv);
  const entry = revertable(res);
  entry.rows[0].sent_fields = ['layoutxml', 'statecode', 'ownerid'];
  const r = await C.planComponentRevert(dv, entry, ctx);
  assert.deepEqual(Object.keys(C.bodyFor(r)), ['layoutxml']);
});
