'use strict';
// The 1.11.30 C1 review's confirmed findings (one Codex seat, run 20261109-085041-797262; receipt in Shared Dataverse
// Write/reviews/2026-11-09_toolkit_1_11_30/), each red before its fix:
//   F1 a pending (unpublished) RENAME was invisible to the draft check   F2 a clash made while the approval was open
//   F3 drafts saved during a timeout's re-reads were published unseen    F4 reverting a rename restored every field
//   F5 a landed write whose read-back threw was logged "failed"           F6 a plan edited to drop `publish` skipped it
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-rev1130-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/component');
const { fakeComponentDv, devDv, IDS, ENVS, ACCESS, FETCH, LAYOUT, FORM } = require('./fake_component');

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
const rename = (dv, to) => valid({ ...base, component: { set: 'savedqueries', id: IDS.view, name: 'Active Donors' }, mode: 'update', definition: { name: to }, snapshot_hash: snap(dv, 'savedqueries', IDS.view).hash, intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['name'] } });
const layout = (dv) => valid({ ...base, component: { set: 'savedqueries', id: IDS.view, name: 'Active Donors' }, mode: 'update', definition: { layoutxml: SWAPPED }, snapshot_hash: snap(dv, 'savedqueries', IDS.view).hash, intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['columns'] } });
let n = 0;
async function applied(plan, dv, over = {}) {
  n += 1;
  const file = path.join(HOME, `plan-${n}.json`);
  fs.writeFileSync(file, '{}');
  const res = await C.applyComponent({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }), sleep: () => {}, ...over,
  }, { id: `20261109-1200${String(n).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, row: res.rows[0] };
}
const publishes = (dv) => dv.calls.filter((c) => c.path === 'PublishXml');

test('F1: a pending rename on the target is a draft (refused); on another component of the table it is named', async () => {
  const dv = dvAs();
  dv.data.drafts.savedqueries[IDS.view] = { name: 'Maker Name' };
  await assert.rejects(C.planComponent(dv, rename(dv, 'Development Donors'), ctx), /unpublished edits/);
  await assert.rejects(C.planComponent(dv, layout(dv), ctx), /unpublished edits/);

  const dv2 = dvAs();
  dv2.data.drafts.systemforms[IDS.form] = { name: 'Pending Form Name' };
  const p = await C.planComponent(dv2, layout(dv2), ctx);
  assert.deepEqual(p.facts.other_drafts, ["the form 'Pending Form Name'"]);
});

test('F2: a name taken while the approval was open is refused after it, nothing written', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, rename(dv, 'Lapsed Donors'), ctx);
  const confirm = () => {
    dv.data.savedqueries['22222222-2222-2222-2222-000000000009'] = { savedqueryid: '22222222-2222-2222-2222-000000000009', name: 'Lapsed Donors', ismanaged: false, statecode: 0, returnedtypecode: 'contact', querytype: 0, description: null, fetchxml: FETCH, layoutxml: LAYOUT };
    return { approved: true };
  };
  await assert.rejects(applied(p, dv, { confirm }), /already a view named 'Lapsed Donors'.*while the approval was waiting/);
  assert.equal(dv.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('F3: drafts saved on the table during a timeout\'s re-reads are not published along; the change is left saved, unpublished', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, layout(dv), ctx);
  dv.timeoutOnWrite = 2;
  let drafted = false;
  const sleep = () => { if (!drafted) { drafted = true; dv.data.drafts.systemforms[IDS.form] = { formxml: FORM.replace('CONTACT NAME', 'NAME') }; } };
  const { row } = await applied(p, dv, { sleep });
  assert.equal(publishes(dv).length, 0, 'nothing published');
  assert.match(row.outcome, /not published/);
  assert.ok(row.notes.some((x) => /unpublished edits were saved .*while this change was being re-read.*SBRM Donor: Contact/.test(x)), row.notes.join(' | '));
});

test('F4: reverting a rename puts back only the name, never the definition', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, rename(dv, 'Donors (active)'), ctx);
  const { res } = await applied(p, dv);
  const r = await C.planComponentRevert(dv, { ...res.entry, env: 'donorapp', plan_id: 'p-f4', person: { fullname: 'T' } }, ctx);
  assert.deepEqual(r.sent_fields, []);
  assert.deepEqual(r.diff.sections, ['name']);
  assert.deepEqual(C.bodyFor(r), { name: 'Active Donors' });
});

test('F5: a write that landed but could not be read back is "read-back failed", never "failed"', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, rename(dv, 'Donors (active)'), ctx);
  dv.failReads = IDS.view;
  const { res, row } = await applied(p, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(row.outcome, /^read-back failed: the write went through but '.*' could not be read back/);
});

test('F6: a plan edited to drop its publish is still published (apply decides, not the plan file)', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, layout(dv), ctx);
  const { row } = await applied({ ...p, publish: null }, dv);
  assert.equal(row.outcome, 'written', row.outcome);
  assert.deepEqual(publishes(dv).map((c) => c.body), [{ entities: ['contact'] }]);
});
