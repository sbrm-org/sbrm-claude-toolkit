'use strict';
// Renaming an app component (1.11.30, tasks #6hrx9hX48jvgWh9J + #6hxFVrXF6M24mVJJ): `definition.name` in a component
// update for flows, views and forms (dashboards included). The name sits OUTSIDE the hashed definition, so it gets
// its own path through validation, the plan's diff and intent, the shape check, the write body, the read-back, the
// log and revert. Also the first table-less form: a dashboard reads objecttypecode "none" (read live 11/9/26,
// probe_dashboard.js), so it is published by its own id and has no table fields to check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-rename-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/component');
const { publishXml } = require('../lib/write');
const { fakeComponentDv, devDv, devEntry, flowCd, IDS, ENVS, ACCESS, FETCH, LAYOUT, FORM } = require('./fake_component');

const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, readEnv: () => devDv({}), ...over });
const dvAs = (email = 'dev@example.org', over = {}) => fakeComponentDv({ email, ...over });
const DASH = '33333333-3333-3333-3333-000000000002';
const DASH_XML = '<form><tabs><tab showlabel="false" verticallayout="true" id="{b41f028d-4a9b-4ec8-b8e0-ce3189fe460a}"><labels><label description="" languagecode="1033" /></labels><columns><column width="100%"><sections><section showlabel="false" showbar="false" columns="111" id="{312f5bcf-689d-475f-bf6f-7bc7a146b7a1}"><labels><label description="" languagecode="1033" /></labels><rows><row><cell id="{0a1b2c3d-0000-0000-0000-000000000001}" showlabel="false"><labels><label description="" languagecode="1033" /></labels><control id="pbi" classid="{8C54228C-1B25-4909-A12A-F2B968BB0D62}"><parameters><PowerBIGroupId>g</PowerBIGroupId></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs></form>';

function withDashboard(dv) {
  dv.data.systemforms[DASH] = { formid: DASH, name: 'Board Dashboard', ismanaged: false, objecttypecode: 'none', type: 103, description: null, formxml: DASH_XML };
  return dv;
}

const snap = (dv, set, id) => C.snapshot(set, dv.data[set][id]);
function job(dv, { set = 'savedqueries', id = IDS.view, name = 'Active Donors', noun = 'view', definition, changed, ...rest }) {
  return {
    contract: 'sbrm-dv-job/1', kind: 'component', env: 'donorapp', source: 'claude-session', reason: 'One name across the app.',
    component: { set, id, name }, mode: 'update', definition, snapshot_hash: snap(dv, set, id).hash,
    intent: { verb: 'update', component: noun, name, changed }, ...rest,
  };
}
function valid(raw) {
  const r = C.validateComponentJob(raw, { envs: ENVS });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
}
const errorsOf = (raw) => C.validateComponentJob(raw, { envs: ENVS }).errors.join('\n');
async function refused(promise, re, code) {
  await assert.rejects(promise, (e) => {
    assert.match(e.message, re);
    if (code) assert.equal(e.code, code);
    return true;
  });
}
let n = 0;
async function applied(plan, dv, over = {}) {
  n += 1;
  const file = path.join(HOME, `plan-${n}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await C.applyComponent({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, sleep: () => {}, ...over,
  }, { id: `20261109-1000${String(n).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown };
}
const writes = (dv) => dv.calls.filter((c) => c.method !== 'GET');

// ---------- the job file ----------

test('validate: a name is a definition key for flows, views and forms, one line, within the column', () => {
  const dv = withDashboard(dvAs());
  const v = valid(job(dv, { definition: { name: 'Active Donors (email first)' }, changed: ['name'] }));
  assert.equal(v.rename, 'Active Donors (email first)');
  assert.deepEqual(v.definition, {}, 'the name never enters the hashed definition');
  valid(job(dv, { set: 'workflows', id: IDS.flow, name: 'Add Soft Credit', noun: 'flow', definition: { name: 'Add Soft Credit (v2)' }, changed: ['name'] }));
  valid(job(dv, { set: 'systemforms', id: DASH, name: 'Board Dashboard', noun: 'form', definition: { name: 'Development Dashboard' }, changed: ['name'] }));
  valid(job(dv, { definition: { name: '  Padded  ', layoutxml: LAYOUT }, changed: ['name', 'columns'] }));
  assert.equal(C.validateComponentJob(job(dv, { definition: { name: '  Padded  ' }, changed: ['name'] }), { envs: ENVS }).job.rename, 'Padded');
  for (const [d, re] of [
    [{ name: '' }, /"definition.name" must be/],
    [{ name: '   ' }, /"definition.name" must be/],
    [{ name: 'two\nlines' }, /"definition.name" must be/],
    [{ name: 42 }, /"definition.name" must be/],
    [{ name: 'x'.repeat(201) }, /at most 200 characters/],
  ]) assert.match(errorsOf(job(dv, { definition: d, changed: ['name'] })), re, JSON.stringify(d));
  // a view takes 200, a form and a flow 100 (read live 11/9/26)
  valid(job(dv, { definition: { name: 'v'.repeat(200) }, changed: ['name'] }));
  assert.match(errorsOf(job(dv, { set: 'systemforms', id: DASH, name: 'Board Dashboard', noun: 'form', definition: { name: 'f'.repeat(101) }, changed: ['name'] })), /at most 100 characters/);
  assert.match(errorsOf(job(dv, { set: 'workflows', id: IDS.flow, name: 'Add Soft Credit', noun: 'flow', definition: { name: 'w'.repeat(101) }, changed: ['name'] })), /at most 100 characters/);
  // not for a sitemap or a web resource, and not in a create (component.name names a new one)
  assert.match(errorsOf(job(dv, { set: 'sitemaps', id: IDS.sitemap, name: 'Donor App', noun: 'sitemap', definition: { name: 'X' }, changed: ['other'] })), /unknown key "definition.name"/);
  assert.match(errorsOf(job(dv, { set: 'webresourceset', id: IDS.wr, name: 'sbrm_contact.js', noun: 'web resource', definition: { name: 'X' }, changed: ['content'] })), /unknown key "definition.name"/);
  const create = { contract: 'sbrm-dv-job/1', kind: 'component', env: 'donorapp', source: 's', reason: 'r', mode: 'create', solution: 'SBRMAdHocChanges', component: { set: 'savedqueries', name: 'New View' }, definition: { returnedtypecode: 'contact', fetchxml: FETCH, layoutxml: LAYOUT, name: 'Other' }, intent: { verb: 'create', component: 'view', name: 'New View' } };
  assert.match(errorsOf(create), /unknown key "definition.name"/);
});

// ---------- plan ----------

test('plan: a rename alone is a change, shown as old -> new under its own section, GETs only', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, valid(job(dv, { definition: { name: 'Active Donors (email first)' }, changed: ['name'] })), ctx());
  assert.deepEqual(p.diff.sections, ['name']);
  assert.ok(p.diff.lines.some((l) => l === "Name: 'Active Donors' -> 'Active Donors (email first)'"), p.diff.lines.join('\n'));
  assert.deepEqual(p.rename, { from: 'Active Donors', to: 'Active Donors (email first)' });
  assert.deepEqual(p.sent_fields, []);
  assert.deepEqual(writes(dv), []);
  assert.match(C.componentSummary(p), /Name: 'Active Donors' -> 'Active Donors \(email first\)'/);
});

test('plan: intent must name the rename; a rename with a definition change lists both', async () => {
  const dv = dvAs();
  const swapped = LAYOUT.replace('<cell name="fullname" width="300" /><cell name="emailaddress1" width="150" />', '<cell name="emailaddress1" width="150" /><cell name="fullname" width="300" />');
  await refused(C.planComponent(dv, valid(job(dv, { definition: { name: 'Renamed', layoutxml: swapped }, changed: ['columns'] })), ctx()), /intent does not match the change/, 'intent_mismatch');
  const p = await C.planComponent(dv, valid(job(dv, { definition: { name: 'Renamed', layoutxml: swapped }, changed: ['columns', 'name'] })), ctx());
  assert.deepEqual([...p.diff.sections].sort(), ['columns', 'name']);
  assert.deepEqual(p.sent_fields, ['layoutxml']);
});

test('plan: the same name is nothing to change; a name another view on the table already has is refused', async () => {
  const dv = dvAs();
  await refused(C.planComponent(dv, valid(job(dv, { definition: { name: 'Active Donors' }, changed: ['name'] })), ctx()), /already has this definition and this name/, 'every_row_refused');
  dv.data.savedqueries['22222222-2222-2222-2222-000000000009'] = { savedqueryid: '22222222-2222-2222-2222-000000000009', name: 'Lapsed Donors', ismanaged: false, statecode: 0, returnedtypecode: 'contact', querytype: 0, description: null, fetchxml: FETCH, layoutxml: LAYOUT };
  await refused(C.planComponent(dv, valid(job(dv, { definition: { name: 'lapsed donors' }, changed: ['name'] })), ctx()), /already a view named 'Lapsed Donors' on contact/, 'invalid_job');
  // a view of that name on ANOTHER table is no clash
  dv.data.savedqueries['22222222-2222-2222-2222-000000000009'].returnedtypecode = 'account';
  await C.planComponent(dv, valid(job(dv, { definition: { name: 'Lapsed Donors' }, changed: ['name'] })), ctx());
  // a change of case alone is a rename, and the component never clashes with itself
  const p = await C.planComponent(dv, valid(job(dv, { definition: { name: 'Active donors' }, changed: ['name'] })), ctx());
  assert.deepEqual(p.rename, { from: 'Active Donors', to: 'Active donors' });
  // a form of another type with the name is no clash either (a dashboard beside a main form)
  withDashboard(dv);
  dv.data.systemforms[DASH].name = 'Contact Board';
  dv.data.systemforms[DASH].objecttypecode = 'contact';
  const f = { set: 'systemforms', id: IDS.form, name: 'SBRM Donor: Contact', noun: 'form' };
  await C.planComponent(dv, valid(job(dv, { ...f, definition: { name: 'Contact Board' }, changed: ['name'] })), ctx());
  dv.data.systemforms[DASH].type = 2;
  await refused(C.planComponent(dv, valid(job(dv, { ...f, definition: { name: 'Contact Board' }, changed: ['name'] })), ctx()), /already a form named 'Contact Board' on contact/);
});

test('plan: a clash check that cannot be read refuses the rename (never assumed clear)', async () => {
  const dv = dvAs();
  const real = dv.get;
  dv.get = (q, o) => {
    if (/\$filter=name%20eq%20/.test(q)) throw new (require('../lib/cli').DataverseError)('The service is temporarily unavailable', { code: '0x80072322', status: 503 });
    return real(q, o);
  };
  await refused(C.planComponent(dv, valid(job(dv, { definition: { name: 'Lapsed Donors' }, changed: ['name'] })), ctx()), /could not check whether another view is already named 'Lapsed Donors'/);
});

test('dashboard: with the platform holding the save unpublished, the publish by id makes the new name live', async () => {
  const dv = withDashboard(dvAs());
  dv.unpublishedUntilPublish = true;
  const p = await C.planComponent(dv, valid(job(dv, { set: 'systemforms', id: DASH, name: 'Board Dashboard', noun: 'form', definition: { name: 'Development Dashboard' }, changed: ['name'] })), ctx());
  const { res } = await applied(p, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.equal(dv.data.systemforms[DASH].name, 'Development Dashboard');
});

// ---------- apply ----------

test('apply: a view rename sends the name, publishes the table, reads the new name back and logs both names', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, valid(job(dv, { definition: { name: 'Active Donors (email first)' }, changed: ['name'] })), ctx());
  const { res, shown } = await applied(p, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  const patch = writes(dv).find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { name: 'Active Donors (email first)' });
  assert.deepEqual(writes(dv).find((c) => c.path === 'PublishXml').body, { entities: ['contact'] });
  assert.equal(dv.data.savedqueries[IDS.view].name, 'Active Donors (email first)');
  assert.equal(res.rows[0].before.name, 'Active Donors');
  assert.equal(res.rows[0].after.name, 'Active Donors (email first)');
  assert.match(shown[0].summaryText, /Name: 'Active Donors' -> 'Active Donors \(email first\)'/);
});

test('apply: a flow rename writes the name with no publish', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, valid(job(dv, { set: 'workflows', id: IDS.flow, name: 'Add Soft Credit', noun: 'flow', definition: { name: 'Add Soft Credits' }, changed: ['name'] })), ctx());
  const { res } = await applied(p, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.deepEqual(writes(dv).map((c) => c.method), ['PATCH']);
  assert.equal(dv.data.workflows[IDS.flow].name, 'Add Soft Credits');
});

test('apply: renamed by someone else since the plan, or a name that did not stick, is not written', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, valid(job(dv, { definition: { name: 'New Name' }, changed: ['name'] })), ctx());
  dv.touch('savedqueries', IDS.view, { name: 'Someone Else' });
  await assert.rejects(applied(p, dv), /renamed since the plan/);
  assert.equal(dv.data.savedqueries[IDS.view].name, 'Someone Else');

  const dv2 = dvAs();
  dv2.readBackDrops = 'name';
  const p2 = await C.planComponent(dv2, valid(job(dv2, { definition: { name: 'New Name' }, changed: ['name'] })), ctx());
  const { res } = await applied(p2, dv2);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /read-back mismatch: .*name/);
});

test('apply: a name taken since the plan is refused before the write', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, valid(job(dv, { definition: { name: 'Lapsed Donors' }, changed: ['name'] })), ctx());
  dv.data.savedqueries['22222222-2222-2222-2222-000000000009'] = { savedqueryid: '22222222-2222-2222-2222-000000000009', name: 'Lapsed Donors', ismanaged: false, statecode: 0, returnedtypecode: 'contact', querytype: 0, description: null, fetchxml: FETCH, layoutxml: LAYOUT };
  let asked = 0;
  await assert.rejects(applied(p, dv, { confirm: () => { asked += 1; return { approved: true }; } }), /already a view named 'Lapsed Donors'/);
  assert.equal(asked, 0, 'refused BEFORE the approval prompt, never after the person said yes');
  assert.deepEqual(writes(dv), []);
});

test('the shape check: a name only rides an update of a set that can be renamed, as a one-line string', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, valid(job(dv, { definition: { name: 'New Name' }, changed: ['name'] })), ctx());
  assert.deepEqual(C.planShapeProblems(p), []);
  assert.deepEqual(C.bodyFor(p), { name: 'New Name' });
  assert.ok(C.planShapeProblems({ ...p, rename: { from: 'Active Donors', to: '' } }).length);
  assert.ok(C.planShapeProblems({ ...p, rename: { from: 'Active Donors', to: 'a\nb' } }).length);
  assert.ok(C.planShapeProblems({ ...p, rename: null }).length, 'no field and no name = nothing to send');
  assert.ok(C.planShapeProblems({ ...p, component: { ...p.component, set: 'sitemaps' }, sent_fields: ['sitemapxml'], after_definition: { sitemapxml: '<SiteMap/>' } }).length);
  assert.ok(C.planShapeProblems({ ...p, mode: 'on', rename: { from: 'a', to: 'b' } }).length);
});

// ---------- a dashboard (a form with no table) ----------

test('dashboard: plan needs no table, publishes only that dashboard, and the rename lands', async () => {
  const dv = withDashboard(dvAs());
  const p = await C.planComponent(dv, valid(job(dv, { set: 'systemforms', id: DASH, name: 'Board Dashboard', noun: 'form', definition: { name: 'Development Dashboard' }, changed: ['name'] })), ctx());
  assert.deepEqual(p.publish, { dashboards: [`{${DASH}}`] });
  assert.match(C.componentSummary(p), /Published after the change \(this dashboard only\)/);
  assert.ok(!dv.calls.some((c) => /EntityDefinitions\(LogicalName='none'\)/.test(c.path)), 'no table read for a dashboard');
  assert.ok(!dv.calls.some((c) => /returnedtypecode eq 'none'|objecttypecode eq 'none'/.test(decodeURIComponent(c.path))), 'no table-wide draft read for a dashboard');
  const { res } = await applied(p, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  const pub = writes(dv).find((c) => c.path === 'PublishXml').body;
  assert.equal(publishXml(pub), `<importexportxml><dashboards><dashboard>{${DASH}}</dashboard></dashboards></importexportxml>`);
  assert.equal(dv.data.systemforms[DASH].name, 'Development Dashboard');
});

test('dashboard: a layout change plans too (no table fields to check)', async () => {
  const dv = withDashboard(dvAs());
  const xml = DASH_XML.replace('<PowerBIGroupId>g</PowerBIGroupId>', '<PowerBIGroupId>h</PowerBIGroupId>');
  const p = await C.planComponent(dv, valid(job(dv, { set: 'systemforms', id: DASH, name: 'Board Dashboard', noun: 'form', definition: { formxml: xml }, changed: ['other'] })), ctx());
  assert.deepEqual(p.publish, { dashboards: [`{${DASH}}`] });
});

test('publishXml names a dashboard by its id, checked like every other name', () => {
  assert.equal(publishXml({ dashboards: ['{33333333-3333-3333-3333-000000000002}'] }), '<importexportxml><dashboards><dashboard>{33333333-3333-3333-3333-000000000002}</dashboard></dashboards></importexportxml>');
  assert.throws(() => publishXml({ dashboards: ['<x/>'] }), /refusing to publish/);
});

// ---------- revert ----------

function entryOf(res, plan) {
  return { ...res.entry, env: plan.env, plan_id: 'p-rename', person: { fullname: 'Test Person' } };
}

test('revert: a rename goes back to the old name; renamed again since = nothing to undo', async () => {
  const dv = dvAs();
  const p = await C.planComponent(dv, valid(job(dv, { definition: { name: 'New Name' }, changed: ['name'] })), ctx());
  const { res } = await applied(p, dv);
  const r = await C.planComponentRevert(dv, entryOf(res, p), ctx());
  assert.deepEqual(r.rename, { from: 'New Name', to: 'Active Donors' });
  assert.ok(r.diff.sections.includes('name'));
  const back = await applied(r, dv);
  assert.equal(back.res.outcome, 'applied', JSON.stringify(back.res.rows));
  assert.equal(dv.data.savedqueries[IDS.view].name, 'Active Donors');

  const dv2 = dvAs();
  const p2 = await C.planComponent(dv2, valid(job(dv2, { definition: { name: 'New Name' }, changed: ['name'] })), ctx());
  const { res: res2 } = await applied(p2, dv2);
  dv2.touch('savedqueries', IDS.view, { name: 'Third Name' });
  await refused(C.planComponentRevert(dv2, entryOf(res2, p2), ctx()), /renamed again since/, 'nothing_to_undo');
});

test('revert: an older entry with the same name before and after renames nothing', async () => {
  const dv = dvAs();
  const swapped = LAYOUT.replace('<cell name="fullname" width="300" /><cell name="emailaddress1" width="150" />', '<cell name="emailaddress1" width="150" /><cell name="fullname" width="300" />');
  const p = await C.planComponent(dv, valid(job(dv, { definition: { layoutxml: swapped }, changed: ['columns'] })), ctx());
  const { res } = await applied(p, dv);
  const r = await C.planComponentRevert(dv, entryOf(res, p), ctx());
  assert.equal(r.rename, null);
  assert.ok(!r.diff.sections.includes('name'));
});

// ---------- tried in the dev copy first ----------

test('proven_in: the dev rename counts only when it gave the same new name', () => {
  const dev = (to) => {
    const e = devEntry({ sections: ['name'], before: { fetchxml: FETCH, layoutxml: LAYOUT, description: null }, after: { fetchxml: FETCH, layoutxml: LAYOUT, description: null } });
    e.rows[0].after.name = to;
    return e;
  };
  const args = { set: 'savedqueries', name: 'Active Donors', mode: 'update', sections: ['name'], diff: { sections: ['name'] }, after: { fetchxml: FETCH, layoutxml: LAYOUT, description: null }, rename: 'Renamed' };
  assert.equal(C.sameChange(args, dev('Renamed')), true);
  assert.match(String(C.sameChange(args, dev('Something Else'))), /name differs/);
});
