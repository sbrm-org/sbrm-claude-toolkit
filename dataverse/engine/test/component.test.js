'use strict';
// App components (DESIGN.md §10b, §10e, rulings §10j, §10k): views, forms, sitemaps and cloud flows on a fake
// Dataverse (test/fake_component.js). The module is called directly; the CLI wiring is tested elsewhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Never touch the real store (CLAUDE.md trap), even though this file only plans and applies in-process.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-component-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/component');
const { fakeComponentDv, devDv, devEntry, flowCd, REF, IDS, ENVS, ACCESS, FETCH, LAYOUT, FORM, SITEMAP, secretFlowCd, PLACEHOLDER_SECRET } = require('./fake_component');

// Donor App Dev's Write Log: the same column change to the same view, applied there first.
// (built on first use: SWAPPED_LAYOUT is defined below)
const devView = (over = {}) => devEntry({ after: { fetchxml: FETCH, layoutxml: SWAPPED_LAYOUT, description: null }, ...over });
const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, readEnv: () => devDv({ '20261007-090000-deadbeef': devView() }), ...over });
const userOf = { dev: 'dev@example.org', admin: 'admin@example.org', writer: 'writer@example.org', reader: 'nobody@example.org', oldadmin: 'oldadmin@example.org' };
const dvAs = (who = 'dev', over = {}) => fakeComponentDv({ email: userOf[who], ...over });

function live(dv, set, id) {
  const r = dv.data[set][id];
  return C.snapshot(set, r);
}

function job(over = {}) {
  const base = {
    contract: 'sbrm-dv-job/1', kind: 'component', env: 'donorapp', source: 'claude-session', reason: 'Show the email column first.',
  };
  return { ...base, ...over };
}

function valid(raw) {
  const r = C.validateComponentJob(raw, { envs: ENVS });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
}

async function refused(promise, re, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'PlanRefused', e.stack);
    assert.match(e.message, re);
    if (code) assert.equal(e.code, code);
    return true;
  });
}

function nonGets(dv) {
  return dv.calls.filter((c) => c.method !== 'GET');
}

// A view update job built from a live read, as Claude builds one.
function viewJob(dv, { layoutxml, fetchxml, changed = ['columns'], name = 'Active Donors', ...rest } = {}) {
  const s = live(dv, 'savedqueries', IDS.view);
  const definition = {};
  if (layoutxml) definition.layoutxml = layoutxml;
  if (fetchxml) definition.fetchxml = fetchxml;
  return job({ component: { set: 'savedqueries', id: IDS.view, name }, mode: 'update', definition, snapshot_hash: s.hash,
    intent: { verb: 'update', component: 'view', name, changed }, ...rest });
}

const SWAPPED_LAYOUT = LAYOUT.replace('<cell name="fullname" width="300" /><cell name="emailaddress1" width="150" />', '<cell name="emailaddress1" width="150" /><cell name="fullname" width="300" /><cell name="telephone1" width="100" />');

function flowJob(dv, cd, { changed, id = IDS.flow, name = 'Add Soft Credit', description, ...rest } = {}) {
  const s = live(dv, 'workflows', id);
  const definition = { clientdata: cd };
  if (description !== undefined) definition.description = description;
  return job({ component: { set: 'workflows', id, name }, mode: 'update', definition, snapshot_hash: s.hash,
    intent: { verb: 'update', component: 'flow', name, changed }, reason: 'Fix the soft-credit flow.', ...rest });
}

function stateJob(dv, mode, { id = IDS.flow, name = 'Add Soft Credit', set = 'workflows', noun = 'flow', ...rest } = {}) {
  return job({ component: { set, id, name }, mode, snapshot_hash: live(dv, set, id).hash, intent: { verb: mode, component: noun, name }, ...rest });
}

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await C.applyComponent({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, sleep: () => {}, ...over,
  }, { id: `20261007-1200${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown, fileGone: !fs.existsSync(file) };
}

// ---------- the job file ----------

test('validate: typos, missing pieces, wrong mode for the set and intent mismatch are refused', () => {
  const s = 'a'.repeat(64);
  const ok = job({ component: { set: 'savedqueries', id: IDS.view, name: 'Active Donors' }, mode: 'update', definition: { layoutxml: LAYOUT }, snapshot_hash: s, intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['columns'] } });
  valid(ok);
  const cases = [
    [{ colour: 'red' }, /unknown top-level key "colour"/],
    [{ contract: 'x' }, /"contract" must be exactly/],
    [{ kind: 'rows' }, /"kind" must be "component"/],
    [{ env: 'nowhere' }, /"env" must be one of/],
    [{ mode: 'publish' }, /"mode" must be one of/],
    [{ component: { set: 'webresources', id: IDS.view, name: 'x' } }, /"component.set" must be one of/],
    [{ component: { set: 'savedqueries', id: 'not-a-guid', name: 'Active Donors' } }, /must be the component's GUID/],
    [{ component: { set: 'savedqueries', id: IDS.view, name: 'Active Donors', type: 1 } }, /unknown key "component.type"/],
    [{ snapshot_hash: undefined }, /"snapshot_hash" is required/],
    [{ snapshot_hash: 'ABC' }, /"snapshot_hash" is required/],
    [{ definition: { layoutxml: '<grid><row></grid>' } }, /"definition.layoutxml" is not valid XML/],
    [{ definition: { layoutxml: '<fetch/>' } }, /must have <grid> as its root/],
    [{ definition: { formxml: FORM } }, /unknown key "definition.formxml"/],
    [{ reason: 'two\nlines' }, /"reason" must be one line/],
    [{ solution: 'SBRMAdHocChanges' }, /"solution" is for a create/],
    [{ owner: IDS.dev2 }, /"owner" is for mode "own"/],
    [{ publish: false }, /"publish" may only be true/],
    [{ mode: 'on' }, /mode "on" is for flows only/],
    [{ intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['actions'] } }, /intent does not match the job.*changed names actions/],
    [{ intent: { verb: 'create', component: 'view', name: 'Active Donors', changed: ['columns'] } }, /intent does not match the job.*verb says "create"/],
    [{ intent: { verb: 'update', component: 'form', name: 'Active Donors', changed: ['columns'] } }, /intent does not match.*component says "form"/],
    [{ intent: { verb: 'update', component: 'view', name: 'Other', changed: ['columns'] } }, /intent does not match.*name says "Other"/],
    [{ intent: { verb: 'update', component: 'view', name: 'Active Donors' } }, /intent does not match.*changed must list/],
  ];
  for (const [over, re] of cases) {
    const { errors } = C.validateComponentJob({ ...ok, ...over }, { envs: ENVS });
    assert.ok(errors && errors.length, `expected a refusal for ${JSON.stringify(over)}`);
    assert.match(errors.join('\n'), re);
  }
});

test('validate: create needs a solution and a full definition, no id and no snapshot; sitemap create is the portal\'s', () => {
  const c = job({ component: { set: 'savedqueries', name: 'Big Donors' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { fetchxml: FETCH, layoutxml: LAYOUT, returnedtypecode: 'contact' }, intent: { verb: 'create', component: 'view', name: 'Big Donors' } });
  const j = valid(c);
  assert.equal(j.component.id, null);
  const errs = (over) => C.validateComponentJob({ ...c, ...over }, { envs: ENVS }).errors.join('\n');
  assert.match(errs({ solution: undefined }), /"solution" is required for a create/);
  assert.match(errs({ solution: 'bad name!' }), /"solution" is required for a create/);
  assert.match(errs({ snapshot_hash: 'a'.repeat(64) }), /"snapshot_hash" is for changes to an existing component/);
  assert.match(errs({ component: { set: 'savedqueries', id: IDS.view, name: 'Big Donors' } }), /a create gets its id from Dataverse/);
  assert.match(errs({ definition: { fetchxml: FETCH, returnedtypecode: 'contact' } }), /"definition.layoutxml" is required for a new view/);
  assert.match(errs({ definition: { fetchxml: FETCH, layoutxml: LAYOUT } }), /returnedtypecode" is required for a new view/);
  assert.match(errs({ proven_in: 'x' }), /"proven_in" is for changes to something live/);
  const sm = C.validateComponentJob({ ...c, component: { set: 'sitemaps', name: 'X' }, definition: { sitemapxml: SITEMAP }, intent: { verb: 'create', component: 'sitemap', name: 'X' } }, { envs: ENVS });
  assert.match(sm.errors.join('\n'), /a new sitemap belongs to a new app, which is made in the maker portal/);
});

test('validate: a flow definition must parse, and platform note limits are checked before any write', () => {
  const s = 'a'.repeat(64);
  const base = { component: { set: 'workflows', id: IDS.flow, name: 'Add Soft Credit' }, mode: 'update', snapshot_hash: s, intent: { verb: 'update', component: 'flow', name: 'Add Soft Credit', changed: ['actions'] } };
  const errs = (definition) => C.validateComponentJob(job({ ...base, definition }), { envs: ENVS }).errors.join('\n');
  assert.match(errs({ clientdata: '{not json' }), /not valid JSON/);
  assert.match(errs({ clientdata: { properties: {} } }), /must be a flow definition/);
  const long = flowCd({ note: 'x'.repeat(257) });
  assert.match(errs({ clientdata: long }), /its note is 257 characters; the platform limit is 256/);
  assert.match(errs({ clientdata: flowCd(), description: 'y'.repeat(1025) }), /limited to 1024/);
  // a string clientdata is accepted and normalized to compact JSON
  const j = valid(job({ ...base, definition: { clientdata: JSON.stringify(flowCd(), null, 2) } }));
  assert.equal(j.definition.clientdata, JSON.stringify(flowCd()));
});

// ---------- snapshot ----------

test('snapshot: stable across cosmetic re-serialisation, sensitive to any real change', () => {
  const row = { savedqueryid: IDS.view.toUpperCase(), name: 'Active Donors', fetchxml: FETCH, layoutxml: LAYOUT, description: null };
  const a = C.snapshot('savedqueries', row);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(a.id, IDS.view, 'the id is lowercased');
  // attribute order, quote style, whitespace between tags, self-closing vs empty element: same hash
  const cosmetic = LAYOUT.replace('<cell name="fullname" width="300" />', "<cell width='300'   name=\"fullname\"></cell>").replace('<row ', '\n  <row ');
  assert.equal(C.snapshot('savedqueries', { ...row, layoutxml: cosmetic, description: '' }).hash, a.hash);
  // anything real: a width, a new column, a description, a different id
  assert.notEqual(C.snapshot('savedqueries', { ...row, layoutxml: LAYOUT.replace('300', '301') }).hash, a.hash);
  assert.notEqual(C.snapshot('savedqueries', { ...row, layoutxml: SWAPPED_LAYOUT }).hash, a.hash);
  assert.notEqual(C.snapshot('savedqueries', { ...row, description: 'x' }).hash, a.hash);
  assert.notEqual(C.snapshot('savedqueries', { ...row, savedqueryid: IDS.mview }).hash, a.hash);
  // flows: key order inside clientdata does not count; a value does
  const cd = flowCd();
  const f = { workflowid: IDS.flow, clientdata: JSON.stringify(cd), description: 'd' };
  const reordered = JSON.stringify({ schemaVersion: cd.schemaVersion, properties: { definition: cd.properties.definition, connectionReferences: cd.properties.connectionReferences } });
  assert.equal(C.snapshot('workflows', { ...f, clientdata: reordered }).hash, C.snapshot('workflows', f).hash);
  assert.notEqual(C.snapshot('workflows', { ...f, clientdata: JSON.stringify(flowCd({ filter: 'msnfp_amount,statecode' })) }).hash, C.snapshot('workflows', f).hash);
});

// ---------- plan: refusals ----------

test('plan refuses: read and write access, a moved snapshot, a managed component, a renamed id, a business rule', async () => {
  for (const [who, code] of [['reader', 'access_read'], ['writer', 'not_permitted']]) {
    const dv = dvAs(who);
    await refused(C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx()), /takes develop access in the Donor App/, code);
  }
  const dv = dvAs('dev');
  const j = valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT }));
  dv.touch('savedqueries', IDS.view, { layoutxml: LAYOUT.replace('300', '250') });
  await refused(C.planComponent(dv, j, ctx()), /has changed since the snapshot this job was built from/, 'snapshot_moved');

  const m = dvAs('admin');
  const mj = valid(job({ component: { set: 'savedqueries', id: IDS.mview, name: 'Active Contacts' }, mode: 'update', definition: { layoutxml: SWAPPED_LAYOUT }, snapshot_hash: live(m, 'savedqueries', IDS.mview).hash, intent: { verb: 'update', component: 'view', name: 'Active Contacts', changed: ['columns'] } }));
  await refused(C.planComponent(m, mj, ctx()), /is a MANAGED view .* never changed/, 'not_permitted');
  await refused(C.planComponent(m, valid(stateJob(m, 'off', { id: IDS.mflow, name: 'Microsoft Flow' })), ctx()), /MANAGED flow/, 'not_permitted');

  const n = dvAs('dev');
  await refused(C.planComponent(n, valid(viewJob(n, { layoutxml: SWAPPED_LAYOUT, name: 'Lapsed Donors', changed: ['columns'] })), ctx()), /calls this view 'Lapsed Donors', but .* is named 'Active Donors'/, 'invalid_job');
  await refused(C.planComponent(n, valid(stateJob(n, 'off', { id: IDS.rule, name: 'Require Phone' })), ctx()), /is not a cloud flow \(category 2\)/, 'invalid_job');
  assert.deepEqual(nonGets(n), [], 'plan never writes');
});

test('plan refuses a form that names a field its table does not have, and a change that changes nothing', async () => {
  const dv = dvAs('dev');
  const s = live(dv, 'systemforms', IDS.form);
  const bad = FORM.replace('datafieldname="emailaddress1"', 'datafieldname="sbrm_nosuchfield"');
  const j = valid(job({ component: { set: 'systemforms', id: IDS.form, name: 'SBRM Donor: Contact' }, mode: 'update', definition: { formxml: bad }, snapshot_hash: s.hash, intent: { verb: 'update', component: 'form', name: 'SBRM Donor: Contact', changed: ['fields'] } }));
  await refused(C.planComponent(dv, j, ctx()), /the form names field\(s\) that contact does not have: sbrm_nosuchfield/, 'invalid_job');
  await refused(C.planComponent(dv, valid(viewJob(dv, { layoutxml: LAYOUT.replace(/\/>/g, '></cell>').replace('</row>', '</row>') })), ctx()), /already has this definition/, 'every_row_refused');
  assert.deepEqual(nonGets(dv), []);
});

test('plan refuses intent that does not match the engine\'s own diff', async () => {
  const dv = dvAs('dev');
  const j = valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT, changed: ['filters'] }));
  await refused(C.planComponent(dv, j, ctx()), /^intent does not match the change: intent says filters; the definition changes columns/, 'intent_mismatch');
});

test('create: refuses a managed solution, a solution under another publisher, a missing table and a duplicate name', async () => {
  const dv = dvAs('dev');
  const mk = (over) => valid(job({ component: { set: 'savedqueries', name: 'Big Donors' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { fetchxml: FETCH, layoutxml: LAYOUT, returnedtypecode: 'contact' }, intent: { verb: 'create', component: 'view', name: 'Big Donors' }, ...over }));
  await refused(C.planComponent(dv, mk({ solution: 'msdynce_Fundraising' }), ctx()), /is managed; nothing is ever added to a managed solution/, 'not_permitted');
  await refused(C.planComponent(dv, mk({ solution: 'Crfb496' }), ctx()), /not under the SBRM publisher/, 'not_permitted');
  await refused(C.planComponent(dv, mk({ solution: 'NoSuchSolution' }), ctx()), /there is no solution "NoSuchSolution"/, 'invalid_job');
  await refused(C.planComponent(dv, mk({ definition: { fetchxml: FETCH, layoutxml: LAYOUT, returnedtypecode: 'sbrm_nothing' } }), ctx()), /there is no table "sbrm_nothing"/, 'table_missing');
  const dup = mk({ component: { set: 'savedqueries', name: 'Active Donors' }, intent: { verb: 'create', component: 'view', name: 'Active Donors' } });
  await refused(C.planComponent(dv, dup, ctx()), /a view named 'Active Donors' on contact already exists/, 'invalid_job');
  assert.deepEqual(nonGets(dv), []);
});

// ---------- plan: the diff, per component type ----------

test('view diff: columns added, removed, re-ordered; filters; sort; the residual catches anything else', () => {
  const before = { fetchxml: FETCH, layoutxml: LAYOUT, description: null };
  let d = C.diffView(before, { ...before, layoutxml: SWAPPED_LAYOUT });
  assert.deepEqual(d.sections, ['columns']);
  assert.match(d.lines[0], /^Columns: added telephone1$/);
  d = C.diffView(before, { ...before, layoutxml: LAYOUT.replace('<cell name="emailaddress1" width="150" />', '') });
  assert.match(d.lines[0], /^Columns: 1 column leaves the view \(emailaddress1\)$/);
  d = C.diffView(before, { ...before, layoutxml: LAYOUT.replace('<cell name="fullname" width="300" /><cell name="emailaddress1" width="150" />', '<cell name="emailaddress1" width="150" /><cell name="fullname" width="300" />') });
  assert.match(d.lines[0], /^Columns: order changed$/);
  d = C.diffView(before, { ...before, fetchxml: FETCH.replace('</filter>', '<condition attribute="donotemail" operator="eq" value="0" /></filter>') });
  assert.deepEqual(d.sections, ['filters']);
  assert.match(d.lines.join('\n'), /Filters CHANGED: adds donotemail eq 0/);
  d = C.diffView(before, { ...before, fetchxml: FETCH.replace('descending="false"', 'descending="true"') });
  assert.deepEqual(d.sections, ['sort']);
  assert.match(d.lines.join('\n'), /Sort: fullname -> fullname descending/);
  d = C.diffView(before, { ...before, fetchxml: FETCH.replace('distinct="false"', 'distinct="true"') });
  assert.deepEqual(d.sections, ['other'], 'a change no named section covers is never reported as unchanged');
});

test('form diff: tabs, sections, fields leaving, events, layout', () => {
  const before = { formxml: FORM, description: 'd' };
  let d = C.diffForm(before, { ...before, formxml: FORM.replace(/<row><cell id="\{9783[^]*?<\/row>/, '') });
  assert.deepEqual(d.sections, ['fields']);
  assert.match(d.lines.join('\n'), /1 field leaves the form: emailaddress1/);
  d = C.diffForm(before, { ...before, formxml: FORM.replace('description="Summary"', 'description="Overview"') });
  assert.deepEqual(d.sections, ['tabs']);
  assert.match(d.lines.join('\n'), /Tabs: relabelled SUMMARY_TAB \(Summary -> Overview\)/);
  d = C.diffForm(before, { ...before, formxml: FORM.replace('name="ContactName"', 'name="Names"') });
  assert.deepEqual(d.sections, ['sections']);
  d = C.diffForm(before, { ...before, formxml: FORM.replace('Form.onLoad', 'Form.onLoad2') });
  assert.deepEqual(d.sections, ['events']);
  assert.match(d.lines.join('\n'), /Form scripts or event handlers CHANGED/);
  d = C.diffForm(before, { ...before, formxml: FORM.replace('disabled="false" /></cell></row><row><cell id="{8783', 'disabled="true" /></cell></row><row><cell id="{8783') });
  assert.deepEqual(d.sections, ['other']);
  assert.deepEqual(C.formFields(FORM), ['fullname', 'firstname', 'lastname', 'emailaddress1']);
  // a field MOVED (same fields, new place) is a layout change, never "unchanged"
  const emailRow = /<row><cell id="\{9783[^]*?<\/row>/.exec(FORM)[0];
  const movedForm = FORM.replace(emailRow, '').replace('<rows><row>', `<rows>${emailRow}<row>`);
  assert.deepEqual(C.diffForm(before, { ...before, formxml: movedForm }).sections, ['other']);
  // a field removed AND another moved: both reported
  assert.deepEqual(C.diffForm(before, { ...before, formxml: movedForm.replace(/<row><cell id="\{8783[^]*?<\/row>/, '') }).sections, ['fields', 'other']);
});

test('sitemap diff: areas, groups and pages by id', () => {
  const before = { sitemapxml: SITEMAP };
  let d = C.diffSitemap(before, { sitemapxml: SITEMAP.replace('<SubArea Id="subarea_accounts" Entity="account" />', '') });
  assert.deepEqual(d.sections, ['subareas']);
  assert.match(d.lines[0], /Pages \(subareas\): removed subarea_accounts/);
  d = C.diffSitemap(before, { sitemapxml: SITEMAP.replace('</Area></SiteMap>', '</Area><Area Id="area_gifts"><Titles><Title LCID="1033" Title="Gifts" /></Titles></Area></SiteMap>') });
  assert.deepEqual(d.sections, ['areas']);
  d = C.diffSitemap(before, { sitemapxml: SITEMAP.replace('Icon="/WebResources/x"', 'Icon="/WebResources/y"') });
  assert.deepEqual(d.sections, ['other']);
});

test('flow diff: trigger, concurrency, actions changed / moved / added / removed, notes, connections, residual', () => {
  const old = flowCd();
  let d = C.diffFlow(old, flowCd({ filter: 'msnfp_amount,statecode', note: 'Now also on status (10/7).' }));
  assert.deepEqual(d.sections, ['trigger', 'notes']);
  assert.match(d.lines[0], /^Trigger CHANGED: on update of msnfp_transaction, filter msnfp_amount -> on update of msnfp_transaction, filter msnfp_amount,statecode$/);
  assert.equal(d.trigger_changed, true);

  const moreActions = flowCd();
  moreActions.properties.definition.actions.Compose_total.inputs = 'changed';
  moreActions.properties.definition.actions.Notify = { runAfter: { Compose_total: ['Succeeded'] }, type: 'Compose', inputs: 'x', description: 'note' };
  delete moreActions.properties.definition.actions.Get_donor.description;
  d = C.diffFlow(old, moreActions);
  assert.deepEqual(d.sections, ['actions', 'notes']);
  assert.match(d.lines.join('\n'), /Actions: 2 -> 3; 1 changed \(Compose_total\), 1 added \(Notify\)/);
  assert.match(d.lines.join('\n'), /Trigger unchanged: on update of msnfp_transaction, filter msnfp_amount/);

  // moving an action into a scope changes WHEN it runs: counted, never "unchanged"
  const moved = flowCd();
  const a = moved.properties.definition.actions;
  a.Scope_main = { runAfter: {}, type: 'Scope', actions: { Get_donor: a.Get_donor }, description: 'wraps' };
  delete a.Get_donor;
  a.Compose_total.runAfter = { Scope_main: ['Succeeded'] };
  d = C.diffFlow(old, moved);
  assert.match(d.lines.join('\n'), /1 moved or re-ordered \(Compose_total\)|Compose_total/);
  assert.match(d.lines.join('\n'), /Get_donor/, 'the move into the scope is listed');
  assert.ok(d.sections.includes('actions'));

  d = C.diffFlow(old, flowCd({ concurrency: { runs: 1, maximumWaitingRuns: 100 } }));
  assert.deepEqual(d.sections, ['concurrency']);
  assert.equal(d.concurrency_added, true);

  d = C.diffFlow(old, flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } }));
  assert.deepEqual(d.sections, ['connections']);
  assert.match(d.lines.join('\n'), /Connection references CHANGED: swapped shared_commondataserviceforapps \(sbrm_dataverse_appadmin -> sbrm_dataverse_owner2\)/);
  d = C.diffFlow(old, flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_appadmin'), shared_office365: REF('sbrm_outlook_appadmin', 'shared_office365') } }));
  assert.equal(d.connections.added.length, 1);

  const other = flowCd();
  other.properties.definition.parameters.$extra = { type: 'String' };
  d = C.diffFlow(old, other);
  assert.deepEqual(d.sections, ['other']);
  assert.deepEqual(C.diffFlow(old, flowCd()).sections, []);
});

// ---------- plan: the pop-up, runs as, levels, severity ----------

test('plan of a view change: headline, diff lines, publish of that table only, routine severity, reads only', async () => {
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT, proven_in: '20261007-090000-deadbeef' })), ctx());
  assert.deepEqual(plan.severity.lines, [], 'proven in Donor App Dev, revertable, one component: routine');
  const s = C.componentSummary(plan);
  assert.match(s, /^Change the view 'Active Donors' \(contact\) in the Donor App\n\n {2}Columns: added telephone1/);
  assert.match(s, /Published after the change \(the contact table only\)\./);
  assert.match(s, /Can be undone with revert: the definition before this change is kept in full in the Write Log\./);
  assert.match(s, /\nReason given: Show the email column first\.$/);
  assert.deepEqual(plan.publish, { entities: ['contact'] });
  assert.equal(plan.need, 'develop');
  assert.ok(/^[\x20-\x7e\n]*$/.test(s), 'plain ASCII');
  assert.deepEqual(nonGets(dv), [], 'plan never writes');
  const det = C.componentDetail(plan, { id: 'P1' });
  assert.match(det, /Plan: P1/);
  assert.match(det, /shown after: {2}emailaddress1, fullname, telephone1/);
});

test('not tried in Donor App Dev first: a warning line, never a refusal; proven_in must be in its Write Log as applied', async () => {
  const dv = dvAs('dev');
  const p1 = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx());
  assert.deepEqual(p1.severity.lines, ['Not tried in Donor App Dev first.']);
  assert.match(C.componentSummary(p1), /^Before you approve:\n {2}! Not tried in Donor App Dev first\.\n\nChange the view/);
  const p2 = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT, proven_in: '20261007-090000-00000000' })), ctx());
  assert.match(p2.severity.lines[0], /Not tried in Donor App Dev first \(plan 20261007-090000-00000000 is not in its Write Log as applied\)/);
  const dev = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT, env: 'fedev' })), ctx());
  assert.deepEqual(dev.severity.lines, [], 'the dev copy itself gets no line');
});

test('flow plan prints who it runs as, from the connection references it names', async () => {
  const dv = dvAs('dev');
  const cd = flowCd();
  cd.properties.definition.actions.Compose_total.inputs = 'changed';
  const plan = await C.planComponent(dv, valid(flowJob(dv, cd, { changed: ['actions'] })), ctx());
  const s = C.componentSummary(plan);
  assert.match(s, /Runs as: SBRM App Admin/);
  assert.match(s, /The flow is ON: the change applies from its next run\./);
  assert.equal(plan.flow.runs_as[0].display, 'Microsoft Dataverse');
  assert.match(C.componentDetail(plan), /shared_commondataserviceforapps: Microsoft Dataverse \(sbrm_dataverse_appadmin\), owner SBRM App Admin/);
  // a live flow's actions changed: can't be fully undone
  assert.ok(plan.severity.irreversible.some((x) => /changes the actions of the flow 'Add Soft Credit' while it is on/.test(x)));
  assert.equal(plan.need, 'develop');
  // a definition naming a connection reference that does not exist is refused
  const ghost = flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_nosuchref') } });
  const admin = dvAs('admin');
  await refused(C.planComponent(admin, valid(flowJob(admin, ghost, { changed: ['connections'] })), ctx()), /connection reference\(s\) that do not exist .*: sbrm_nosuchref/, 'invalid_job');
});

test('levels: write refused; develop ok; adding or swapping a connection reference and a live trigger change are admin; old "schema" reads as admin', async () => {
  const swap = (d) => flowJob(d, flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } }), { changed: ['connections'] });
  const add = (d) => flowJob(d, flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_appadmin'), shared_office365: REF('sbrm_outlook_appadmin', 'shared_office365') } }), { changed: ['connections'] });
  const trig = (d) => flowJob(d, flowCd({ filter: 'msnfp_amount,statecode', note: 'Also on status.' }), { changed: ['trigger', 'notes'] });
  for (const mk of [swap, add, trig]) {
    const dev = dvAs('dev');
    await refused(C.planComponent(dev, valid(mk(dev)), ctx()), /this change takes admin access in the Donor App because/, 'not_permitted');
    const adm = dvAs('admin');
    const p = await C.planComponent(adm, valid(mk(adm)), ctx());
    assert.equal(p.need, 'admin');
    const old = dvAs('oldadmin');
    await C.planComponent(old, valid(mk(old)), ctx());
  }
  // the same trigger change on a flow that is OFF is develop
  const dv = dvAs('dev');
  const off = flowJob(dv, flowCd({ filter: 'msnfp_amount,statecode', note: 'Also on status.', refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } }), { changed: ['trigger', 'notes'], id: IDS.offflow, name: 'Sync Letters' });
  const p = await C.planComponent(dv, valid(off), ctx());
  assert.equal(p.need, 'develop');
  assert.deepEqual(p.severity.irreversible, [], 'an off flow\'s change is revertable before it ever runs');
  // removing a connection reference is not adding power: develop
  const rm = flowCd({ refs: {} });
  const r = await C.planComponent(dvAs('dev'), valid(flowJob(dv, rm, { changed: ['connections'] })), ctx());
  assert.equal(r.need, 'develop');
});

test('flow notes (Vendor, 9/25): a changed trigger needs a changed note; an added step that can fail needs one', async () => {
  const dv = dvAs('admin');
  await refused(C.planComponent(dv, valid(flowJob(dv, flowCd({ filter: 'statecode' }), { changed: ['trigger'] })), ctx()), /trigger When_a_row_is_modified changed but its note did not/, 'invalid_job');
  const cd = flowCd();
  cd.properties.definition.actions.Update_gift = { runAfter: {}, type: 'OpenApiConnection', inputs: { host: { operationId: 'UpdateRecord' } } };
  await refused(C.planComponent(dv, valid(flowJob(dv, cd, { changed: ['actions'] })), ctx()), /added step\(s\) with no note: Update_gift/, 'invalid_job');
});

test('severity: create is lasting, delete is admin-only (no typed name, ruled 10/8), turning on says who it acts as, off names its callers', async () => {
  const dv = dvAs('dev');
  const create = valid(job({ component: { set: 'savedqueries', name: 'Big Donors' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { fetchxml: FETCH, layoutxml: LAYOUT, returnedtypecode: 'contact' }, intent: { verb: 'create', component: 'view', name: 'Big Donors' } }));
  const cp = await C.planComponent(dv, create, ctx());
  assert.deepEqual(cp.severity.lines, ["Lasting: creates the view 'Big Donors'. Undo cannot remove it; only an admin delete can."]);
  assert.match(C.componentSummary(cp), /Create the view 'Big Donors' \(contact\) in the Donor App in solution SBRM Ad-Hoc Changes\n\n {2}Columns: fullname, emailaddress1\n {2}Filters: statecode eq 0/);

  await refused(C.planComponent(dv, valid(stateJob(dv, 'delete', { set: 'savedqueries', id: IDS.view, name: 'Active Donors', noun: 'view' })), ctx()), /takes admin access .* because it deletes the view/, 'not_permitted');
  const adm = dvAs('admin');
  const del = await C.planComponent(adm, valid(stateJob(adm, 'delete', { set: 'savedqueries', id: IDS.view, name: 'Active Donors', noun: 'view' })), ctx());
  assert.equal(del.typed, undefined, 'no typed name (ruled 10/8)');
  assert.match(del.severity.lines[0], /^Can't be fully undone: deletes the view 'Active Donors' \(its full definition stays in the Write Log\)\.$/);
  assert.doesNotMatch(C.componentSummary(del), /type its name/);
  await refused(C.planComponent(adm, valid(stateJob(adm, 'delete')), ctx()), /is on; turn it off first/, 'invalid_job');

  const on = await C.planComponent(dv, valid(stateJob(dv, 'on', { id: IDS.offflow, name: 'Sync Letters' })), ctx());
  assert.ok(on.severity.lines.includes("Can't be fully undone: turning on the flow 'Sync Letters' starts it running and acting as Test Person."));
  await refused(C.planComponent(dv, valid(stateJob(dv, 'on')), ctx()), /is already on/, 'every_row_refused');

  const off = await C.planComponent(dv, valid(stateJob(dv, 'off', { id: IDS.flow })), ctx());
  assert.equal(off.need, 'develop');
  dv.data.workflows[IDS.offflow].statecode = 1;
  const off2 = await C.planComponent(dv, valid(stateJob(dv, 'off', { id: IDS.offflow, name: 'Sync Letters' })), ctx());
  assert.match(C.componentSummary(off2), /Flows that call it will fail while it is off: Gift Batch Posted/);
  assert.deepEqual(nonGets(dv), []);
});

test('own: an admin hands a flow to an active user only, and the pop-up says it will act as them (round 3)', async () => {
  const d = dvAs('dev');
  await refused(C.planComponent(d, valid(stateJob(d, 'own', { owner: IDS.dev2 })), ctx()), /takes admin access .* because it changes who owns the flow, and a flow acts as its owner/, 'not_permitted');
  const dv = dvAs('admin');
  const p = await C.planComponent(dv, valid(stateJob(dv, 'own', { owner: IDS.dev2 })), ctx());
  assert.equal(p.need, 'admin');
  assert.match(C.componentSummary(p), /Hand the flow 'Add Soft Credit' in the Donor App over to Dana Martin[\s\S]*Owner: SBRM App Admin -> Dana Martin\n {2}A flow acts as its owner: from now on it acts as Dana Martin \(its trigger subscription: runas 1\)\./);
  await refused(C.planComponent(dv, valid(stateJob(dv, 'own', { owner: IDS.gone })), ctx()), /Former Staff is a disabled user/);
  await refused(C.planComponent(dv, valid(stateJob(dv, 'own', { owner: IDS.appadmin })), ctx()), /already owned by SBRM App Admin/);
});

test('plan refuses when the log entry would not fit one Write Log row', async () => {
  const dv = dvAs('dev');
  const big = LAYOUT.replace('</row>', `${'<cell name="fullname" width="300" />'.repeat(30000)}</row>`);
  await refused(C.planComponent(dv, valid(viewJob(dv, { layoutxml: big, changed: ['columns'] })), ctx()), /log entry .* would be \d+ characters, over the 1000000/, 'too_big');
});

// ---------- apply ----------

test('apply a view change: one PATCH with If-Match, publishes only that table, reads back, logs before AND after in full', async () => {
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx());
  const { res, shown, fileGone } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.ok(fileGone, 'the plan file is consumed');
  assert.match(shown[0].summaryText, /^Before you approve:\n {2}! Not tried in Donor App Dev first\./);
  assert.equal(shown[0].typed, undefined, 'no typed name (ruled 10/8)');
  const writes = nonGets(dv);
  assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), [`PATCH savedqueries(${IDS.view})`, 'POST PublishXml']);
  assert.equal(writes[0].etag, 'W/"1"', 'If-Match carries the version read at apply');
  assert.deepEqual(Object.keys(writes[0].body), ['layoutxml'], 'only the field the job changes is sent');
  assert.deepEqual(writes[1].body, { entities: ['contact'] }, 'only the touched table is published, never PublishAllXml');
  const e = res.entry;
  assert.equal(e.mode, 'component');
  assert.equal(e.action, 'update');
  assert.equal(e.table, 'savedqueries (contact)');
  assert.equal(e.rows[0].before.definition.layoutxml, LAYOUT);
  assert.equal(e.rows[0].after.definition.layoutxml, SWAPPED_LAYOUT);
  assert.equal(e.rows[0].before.definition.fetchxml, FETCH, 'the whole definition, not only the changed field');
});

test('apply refuses a snapshot that moved after the plan, and a plan made by someone else; nothing written', async () => {
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx());
  dv.touch('savedqueries', IDS.view, { fetchxml: FETCH.replace('eq" value="0"', 'eq" value="1"') });
  await assert.rejects(applied(plan, dv, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'snapshot_moved');
  const other = fakeComponentDv({ email: 'dev@example.org', userId: IDS.dev2, d: dv.data });
  await assert.rejects(applied(plan, other), (e) => e.code === 'different_person');
  assert.deepEqual(nonGets(dv), []);
});

test('apply reports a read-back mismatch, and a failed publish, never as written', async () => {
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx());
  dv.readBackDrops = 'layoutxml';
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /read-back mismatch: the definition read back differs from what was sent \(layoutxml\)/);

  const dv2 = dvAs('dev');
  const p2 = await C.planComponent(dv2, valid(viewJob(dv2, { layoutxml: SWAPPED_LAYOUT })), ctx());
  dv2.publishFails = true;
  const r2 = (await applied(p2, dv2)).res;
  assert.match(r2.rows[0].outcome, /not published/);
  assert.match(r2.rows[0].notes.join(' '), /saved but NOT published/);
});

test('apply a form change: publishes the form\'s table; a sitemap change publishes that sitemap only', async () => {
  const dv = dvAs('dev');
  const s = live(dv, 'systemforms', IDS.form);
  const newForm = FORM.replace(/<row><cell id="\{9783[^]*?<\/row>/, '');
  const plan = await C.planComponent(dv, valid(job({ component: { set: 'systemforms', id: IDS.form, name: 'SBRM Donor: Contact' }, mode: 'update', definition: { formxml: newForm }, snapshot_hash: s.hash, intent: { verb: 'update', component: 'form', name: 'SBRM Donor: Contact', changed: ['fields'] } })), ctx());
  assert.match(C.componentSummary(plan), /1 field leaves the form: emailaddress1/);
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied');
  assert.deepEqual(nonGets(dv).find((c) => c.path === 'PublishXml').body, { entities: ['contact'] });

  const sm = dvAs('dev');
  const sj = valid(job({ component: { set: 'sitemaps', id: IDS.sitemap, name: 'Donor App' }, mode: 'update', definition: { sitemapxml: SITEMAP.replace('<SubArea Id="subarea_accounts" Entity="account" />', '') }, snapshot_hash: live(sm, 'sitemaps', IDS.sitemap).hash, intent: { verb: 'update', component: 'sitemap', name: 'Donor App', changed: ['subareas'] } }));
  const sp = await C.planComponent(sm, sj, ctx());
  await applied(sp, sm);
  assert.deepEqual(nonGets(sm).find((c) => c.path === 'PublishXml').body, { sitemaps: [`{${IDS.sitemap}}`] });
});

test('flow PATCH carries trigger concurrency forward (it can never be removed), and checks the trigger subscription', async () => {
  const dv = dvAs('dev');
  dv.data.workflows[IDS.flow].clientdata = JSON.stringify(flowCd({ concurrency: { runs: 1, maximumWaitingRuns: 100 } }));
  const cd = flowCd(); // built from a definition with NO concurrency: would be refused by the platform as written
  cd.properties.definition.actions.Compose_total.inputs = 'changed';
  const plan = await C.planComponent(dv, valid(flowJob(dv, cd, { changed: ['actions'] })), ctx());
  assert.deepEqual(plan.flow.concurrency_carried, { runs: 1, maximumWaitingRuns: 100 });
  assert.match(C.componentSummary(plan), /Trigger concurrency \(runs 1, maximumWaitingRuns 100\) is kept/);
  assert.deepEqual(plan.diff.sections, ['actions'], 'concurrency shows as unchanged');
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  const sent = JSON.parse(nonGets(dv)[0].body.clientdata);
  assert.deepEqual(sent.properties.definition.triggers.When_a_row_is_modified.runtimeConfiguration.concurrency, { runs: 1, maximumWaitingRuns: 100 });
  assert.ok(!nonGets(dv).some((c) => c.path === 'PublishXml'), 'flows are not published');
  assert.match(res.rows[0].notes.join(' '), /trigger live on msnfp_transaction, filter msnfp_amount/);
});

test('a flow change whose trigger subscription does not re-register is reported, not called written', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(flowJob(dv, flowCd({ filter: 'msnfp_amount,statecode', note: 'Also on status.' }), { changed: ['trigger', 'notes'] })), ctx());
  dv.staleSubscription = true;
  let slept = 0;
  const { res } = await applied(plan, dv, { sleep: () => { slept += 1; } });
  assert.match(res.rows[0].outcome, /read-back mismatch: the trigger is not live as the definition says \(msnfp_transaction, filter msnfp_amount,statecode; registered: filter msnfp_amount\)/);
  assert.equal(slept, 9, 'polled ~30 s before saying so');
});

test('turning a flow on: a 403 ConnectionAuthorizationFailed comes back as who has to turn it on', async () => {
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(stateJob(dv, 'on', { id: IDS.offflow, name: 'Sync Letters' })), ctx());
  dv.connectionOwnerOnly = true;
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /^refused: Power Automate refused: only the owner of this flow's connections \(Test Person\) can turn this flow on\. Nothing changed\./);
  assert.match(res.rows[0].outcome, /Sharing their connection with you is never the fix/);
  assert.equal(dv.data.workflows[IDS.offflow].statecode, 0);

  const ok = dvAs('dev');
  const p2 = await C.planComponent(ok, valid(stateJob(ok, 'on', { id: IDS.offflow, name: 'Sync Letters' })), ctx());
  const r2 = (await applied(p2, ok)).res;
  assert.equal(r2.outcome, 'applied', JSON.stringify(r2.rows));
  assert.deepEqual(nonGets(ok)[0].body, { statecode: 1, statuscode: 2 });
});

test('apply refuses when the change became more serious: the flow was turned on since the plan', async () => {
  const dv = dvAs('admin');
  const cd = flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } });
  cd.properties.definition.actions.Compose_total.inputs = 'changed';
  const plan = await C.planComponent(dv, valid(flowJob(dv, cd, { changed: ['actions'], id: IDS.offflow, name: 'Sync Letters' })), ctx());
  assert.deepEqual(plan.severity.irreversible, []);
  dv.touch('workflows', IDS.offflow, { statecode: 1, statuscode: 2 });
  await assert.rejects(applied(plan, dv, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'severity_grew' && /while it is on/.test(e.message));
});

test('apply re-checks the level: develop lost since the plan refuses; a trigger change on a flow turned on since now needs admin', async () => {
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx());
  const demoted = { people: { 'dev@example.org': { envs: { donorapp: 'write' } } } };
  await assert.rejects(applied(plan, dv, { access: demoted }), (e) => e.code === 'access_revoked');

  const f = dvAs('dev');
  const off = flowJob(f, flowCd({ filter: 'statecode', note: 'On status.', refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } }), { changed: ['trigger', 'notes'], id: IDS.offflow, name: 'Sync Letters' });
  const p = await C.planComponent(f, valid(off), ctx());
  f.touch('workflows', IDS.offflow, { statecode: 1, statuscode: 2 });
  await assert.rejects(applied(p, f), (e) => e.code === 'access_revoked' && /takes admin access because it changes the trigger of a flow that is on; you have develop/.test(e.message));
});

test('create a flow: POST into the named solution, Off; a delete (admin) is read back gone', async () => {
  const dv = dvAs('dev');
  const cd = flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } });
  cd.properties.definition.actions.Compose_total.description = 'Totals.';
  const j = valid(job({ component: { set: 'workflows', name: 'Test Flow' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { clientdata: cd, description: 'Built 10/7.' }, intent: { verb: 'create', component: 'flow', name: 'Test Flow' } }));
  const plan = await C.planComponent(dv, j, ctx());
  assert.match(C.componentSummary(plan), /Create the flow 'Test Flow' in the Donor App, Off, in solution SBRM Ad-Hoc Changes[\s\S]*Trigger: on update of msnfp_transaction[\s\S]*Runs as: Test Person[\s\S]*Undo turns the flow off; it is not deleted/);
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  const post = nonGets(dv)[0];
  assert.equal(post.method, 'POST');
  assert.equal(post.solution, 'SBRMAdHocChanges');
  assert.equal(post.body.category, 5);
  assert.equal(res.rows[0].before, null);
  assert.equal(JSON.parse(res.rows[0].after.definition.clientdata).properties.definition.actions.Compose_total.description, 'Totals.');

  // a create whose connection reference has no connection could never run: refused
  const dead = flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_unbound') } });
  dead.properties.definition.actions.Compose_total.description = 'x';
  await refused(C.planComponent(dv, valid(job({ component: { set: 'workflows', name: 'Dead Flow' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { clientdata: dead }, intent: { verb: 'create', component: 'flow', name: 'Dead Flow' } })), ctx()), /inactive or have no connection/);

  const adm = dvAs('admin');
  const del = await C.planComponent(adm, valid(stateJob(adm, 'delete', { set: 'savedqueries', id: IDS.view, name: 'Active Donors', noun: 'view' })), ctx());
  const { res: dres, shown } = await applied(del, adm);
  assert.equal(shown[0].typed, undefined, 'no typed name (ruled 10/8)');
  assert.equal(dres.outcome, 'applied');
  assert.equal(nonGets(adm)[0].method, 'DELETE');
  assert.equal(nonGets(adm)[0].etag, 'W/"1"');
  assert.equal(adm.data.savedqueries[IDS.view], undefined);
  assert.equal(dres.rows[0].before.definition.fetchxml, FETCH, 'the deleted definition is in the log');
});

test('cancel writes nothing and returns a cancelled entry', async () => {
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx());
  const { res } = await applied(plan, dv, { confirm: () => ({ approved: false, note: 'not now' }) });
  assert.equal(res.outcome, 'cancelled');
  assert.equal(res.entry.outcome, 'cancelled');
  assert.deepEqual(res.entry.rows, []);
  assert.deepEqual(nonGets(dv), []);
});

// ---------- revert ----------

async function appliedEntry(dv, plan) {
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  return res.entry;
}

test('revert an update: PATCHes the logged before back, only while the component still holds what was written', async () => {
  const dv = dvAs('dev');
  const entry = await appliedEntry(dv, await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx()));
  const rp = await C.planComponentRevert(dv, entry, ctx());
  assert.equal(rp.kind, 'component');
  assert.equal(rp.reverts_plan_id, entry.plan_id);
  assert.match(C.componentSummary(rp), /Columns: 1 column leaves the view \(telephone1\)/);
  await appliedEntry(dv, rp);
  assert.equal(dv.data.savedqueries[IDS.view].layoutxml, LAYOUT);

  const moved = dvAs('dev');
  const e2 = await appliedEntry(moved, await C.planComponent(moved, valid(viewJob(moved, { layoutxml: SWAPPED_LAYOUT })), ctx()));
  moved.touch('savedqueries', IDS.view, { description: 'edited by Dana since' });
  await refused(C.planComponentRevert(moved, e2, ctx()), /has changed since plan .* a revert would overwrite someone's later change/, 'snapshot_moved');
});

test('revert of a flow update keeps concurrency it added (the platform never lets it go)', async () => {
  const dv = dvAs('dev');
  const cd = flowCd({ concurrency: { runs: 1 } });
  cd.properties.definition.actions.Compose_total.inputs = 'changed';
  const entry = await appliedEntry(dv, await C.planComponent(dv, valid(flowJob(dv, cd, { changed: ['concurrency', 'actions'] })), ctx()));
  const rp = await C.planComponentRevert(dv, entry, ctx());
  assert.deepEqual(rp.flow.concurrency_carried, { runs: 1 });
  assert.deepEqual(rp.diff.sections, ['actions'], 'the revert puts the action back and keeps the concurrency');
  await appliedEntry(dv, rp);
  const now = JSON.parse(dv.data.workflows[IDS.flow].clientdata).properties.definition;
  assert.deepEqual(now.triggers.When_a_row_is_modified.runtimeConfiguration, { concurrency: { runs: 1 } });
  assert.equal(now.actions.Compose_total.inputs, flowCd().properties.definition.actions.Compose_total.inputs);
  // a concurrency-only change cannot be reverted at all, and says why
  const only = dvAs('dev');
  const e2 = await appliedEntry(only, await C.planComponent(only, valid(flowJob(only, flowCd({ concurrency: { runs: 1 } }), { changed: ['concurrency'] })), ctx()));
  await refused(C.planComponentRevert(only, e2, ctx()), /the only difference is trigger concurrency, which the platform never lets anyone remove/);
});

test('revert on <-> off and own; a created flow is turned off; a created view stays; a delete is refused', async () => {
  const dv = dvAs('dev');
  const onEntry = await appliedEntry(dv, await C.planComponent(dv, valid(stateJob(dv, 'on', { id: IDS.offflow, name: 'Sync Letters' })), ctx()));
  const back = await C.planComponentRevert(dv, onEntry, ctx());
  assert.equal(back.mode, 'off');
  await appliedEntry(dv, back);
  assert.equal(dv.data.workflows[IDS.offflow].statecode, 0);
  const offEntry = await appliedEntry(dv, await C.planComponent(dv, valid(stateJob(dv, 'off')), ctx()));
  assert.equal((await C.planComponentRevert(dv, offEntry, ctx())).mode, 'on');

  const owner = fakeComponentDv({ email: 'admin@example.org', d: dv.data }); // an owner change is an admin's (round 3)
  const ownEntry = await appliedEntry(owner, await C.planComponent(owner, valid(stateJob(owner, 'own', { id: IDS.offflow, name: 'Sync Letters', owner: IDS.dev2 })), ctx()));
  await refused(C.planComponentRevert(dv, ownEntry, ctx()), /changes who owns the flow/, 'not_permitted');
  const ownBack = await C.planComponentRevert(owner, ownEntry, ctx());
  assert.equal(ownBack.owner_to.id, IDS.me);
  await appliedEntry(owner, ownBack);
  assert.equal(dv.data.workflows[IDS.offflow]._ownerid_value, IDS.me);

  const cd = flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } });
  cd.properties.definition.actions.Compose_total.description = 'x';
  const createEntry = await appliedEntry(dv, await C.planComponent(dv, valid(job({ component: { set: 'workflows', name: 'Test Flow' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { clientdata: cd }, intent: { verb: 'create', component: 'flow', name: 'Test Flow' } })), ctx()));
  await refused(C.planComponentRevert(dv, createEntry, ctx()), /is already off; it stays \(only an admin delete removes it\)/, 'nothing_to_undo');
  dv.data.workflows[createEntry.rows[0].id].statecode = 1;
  assert.equal((await C.planComponentRevert(dv, createEntry, ctx())).mode, 'off');

  const viewCreate = await appliedEntry(dv, await C.planComponent(dv, valid(job({ component: { set: 'savedqueries', name: 'Big Donors' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { fetchxml: FETCH, layoutxml: LAYOUT, returnedtypecode: 'contact' }, intent: { verb: 'create', component: 'view', name: 'Big Donors' } })), ctx()));
  await refused(C.planComponentRevert(dv, viewCreate, ctx()), /stays: revert does not delete what it created; only an admin delete removes it/, 'nothing_to_undo');

  const adm = dvAs('admin');
  const delEntry = await appliedEntry(adm, await C.planComponent(adm, valid(stateJob(adm, 'delete', { set: 'savedqueries', id: IDS.view, name: 'Active Donors', noun: 'view' })), ctx()));
  await refused(C.planComponentRevert(adm, delEntry, ctx()), /a deleted view cannot be brought back by revert\. Its full definition is in the Write Log entry for plan .* \(rows\[0\]\.before\.definition\)/, 'nothing_to_undo');
  await refused(C.planComponentRevert(adm, { ...delEntry, outcome: 'cancelled' }, ctx()), /there is nothing to undo/);
});

test('revert plans read only', async () => {
  const dv = dvAs('dev');
  const entry = await appliedEntry(dv, await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx()));
  const before = nonGets(dv).length;
  await C.planComponentRevert(dv, entry, ctx());
  assert.equal(nonGets(dv).length, before);
});

// ---------- blind review 10/7: apply never trusts the plan's account of itself ----------

const seenBy = (list) => (x) => { list.push(x); return { approved: false }; };

test('a hand-edited plan cannot lower the level: apply works the need out again from the live flow', async () => {
  const adm = dvAs('admin');
  const plan = await C.planComponent(adm, valid(flowJob(adm, flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_appadmin'), shared_office365: REF('sbrm_outlook_appadmin', 'shared_office365') } }), { changed: ['connections'] })), ctx());
  assert.equal(plan.need, 'admin');
  const tampered = { ...plan, need: 'develop', need_why: [], facts: { ...plan.facts, connections_added: false }, access: 'develop' };
  const dev = fakeComponentDv({ email: 'dev@example.org', d: adm.data });
  await assert.rejects(applied(tampered, dev, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'access_revoked' && /adds or swaps a connection reference/.test(e.message));
  assert.deepEqual(nonGets(dev), []);
});

test('a hand-edited plan cannot hide a warning or the change: severity and diff come from the live re-read', async () => {
  const dv = dvAs('dev');
  const cd = flowCd();
  cd.properties.definition.actions.Compose_total.inputs = 'changed';
  const plan = await C.planComponent(dv, valid(flowJob(dv, cd, { changed: ['actions'] })), ctx());
  assert.ok(plan.severity.irreversible.length);
  const quiet = { ...plan, severity: { ...plan.severity, irreversible: [], lines: [] }, facts: { ...plan.facts, live_on: false } };
  await assert.rejects(applied(quiet, dv, { confirm: () => { throw new Error('no pop-up'); } }),
    (e) => e.code === 'severity_grew' && /Can't be fully undone: changes the actions of the flow 'Add Soft Credit' while it is on/.test(e.message));
  assert.deepEqual(nonGets(dv), []);

  const v = dvAs('dev');
  const vp = await C.planComponent(v, valid(viewJob(v, { layoutxml: SWAPPED_LAYOUT })), ctx());
  const sneaky = { ...vp, after_definition: { ...vp.after_definition, layoutxml: LAYOUT.replace('<cell name="emailaddress1" width="150" />', '') } };
  const s2 = [];
  await applied(sneaky, v, { confirm: seenBy(s2) });
  assert.match(s2[0].summaryText, /Columns: 1 column leaves the view \(emailaddress1\)/, 'the pop-up shows what will actually be written');
  assert.doesNotMatch(s2[0].summaryText, /added telephone1/);
});

test('the pop-up says whether the flow is on NOW, not when it was planned', async () => {
  const dv = dvAs('dev');
  const cd = flowCd();
  cd.properties.definition.actions.Compose_total.inputs = 'changed';
  const plan = await C.planComponent(dv, valid(flowJob(dv, cd, { changed: ['actions'] })), ctx());
  assert.match(C.componentSummary(plan), /The flow is ON/);
  dv.touch('workflows', IDS.flow, { statecode: 0, statuscode: 1 });
  const seen = [];
  await applied(plan, dv, { confirm: seenBy(seen) });
  assert.match(seen[0].summaryText, / {2}The flow is off\./);
  assert.doesNotMatch(seen[0].summaryText, /The flow is ON/);
});

test('a delete applies on the LIVE component, whatever name the plan carries; no typed name (ruled 10/8)', async () => {
  const adm = dvAs('admin');
  const plan = await C.planComponent(adm, valid(stateJob(adm, 'delete', { set: 'savedqueries', id: IDS.view, name: 'Active Donors', noun: 'view' })), ctx());
  const seen = [];
  await applied({ ...plan, typed: null, component: { ...plan.component, name: 'x' } }, adm, { confirm: seenBy(seen) });
  assert.equal(seen[0].typed, undefined, 'no typed name (ruled 10/8)');
  adm.data.savedqueries[IDS.view].name = '';
  await applied(plan, adm, { confirm: seenBy(seen) });
  assert.equal(seen[1].typed, undefined, 'no typed name (ruled 10/8)');
});

test('a delete whose read-back fails for any other reason is "could not confirm", never written', async () => {
  const adm = dvAs('admin');
  const plan = await C.planComponent(adm, valid(stateJob(adm, 'delete', { set: 'savedqueries', id: IDS.view, name: 'Active Donors', noun: 'view' })), ctx());
  adm.failReads = IDS.view;
  const { res } = await applied(plan, adm);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /^read-back mismatch: could not confirm it is gone \(The service is temporarily unavailable\)/);
});

// ---------- unpublished drafts ----------

test('drafts: a view with unpublished edits is refused at plan, and at apply if they appear after it', async () => {
  const dv = dvAs('dev');
  dv.data.drafts.savedqueries[IDS.view] = { layoutxml: LAYOUT.replace('300', '200') };
  await refused(C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx()), /'Active Donors' has unpublished edits; publish or discard them in the maker portal first/, 'invalid_job');
  const adm = dvAs('admin');
  adm.data.drafts.savedqueries[IDS.view] = { layoutxml: LAYOUT.replace('300', '200') };
  await refused(C.planComponent(adm, valid(stateJob(adm, 'delete', { set: 'savedqueries', id: IDS.view, name: 'Active Donors', noun: 'view' })), ctx()), /has unpublished edits/);

  const late = dvAs('dev');
  const plan = await C.planComponent(late, valid(viewJob(late, { layoutxml: SWAPPED_LAYOUT })), ctx());
  late.data.drafts.savedqueries[IDS.view] = { fetchxml: FETCH.replace('descending="false"', 'descending="true"') };
  await assert.rejects(applied(plan, late, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'snapshot_moved' && /has unpublished edits/.test(e.message));
  assert.deepEqual(nonGets(late), []);
});

test('drafts: a draft identical to the published definition is not a draft; forms and sitemaps are checked too', async () => {
  const dv = dvAs('dev');
  dv.data.drafts.savedqueries[IDS.view] = { layoutxml: LAYOUT.replace(/ \/>/g, '/>') }; // re-serialised, same definition
  await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx());
  const f = dvAs('dev');
  f.data.drafts.systemforms[IDS.form] = { formxml: FORM.replace('Form.onLoad', 'Form.onLoad2') };
  const fj = valid(job({ component: { set: 'systemforms', id: IDS.form, name: 'SBRM Donor: Contact' }, mode: 'update', definition: { formxml: FORM.replace('description="Summary"', 'description="Overview"') }, snapshot_hash: live(f, 'systemforms', IDS.form).hash, intent: { verb: 'update', component: 'form', name: 'SBRM Donor: Contact', changed: ['tabs'] } }));
  await refused(C.planComponent(f, fj, ctx()), /'SBRM Donor: Contact' has unpublished edits/);
  const s = dvAs('dev');
  s.data.drafts.sitemaps[IDS.sitemap] = { sitemapxml: SITEMAP.replace('Title="People"', 'Title="Persons"') };
  const sj = valid(job({ component: { set: 'sitemaps', id: IDS.sitemap, name: 'Donor App' }, mode: 'update', definition: { sitemapxml: SITEMAP.replace('<SubArea Id="subarea_accounts" Entity="account" />', '') }, snapshot_hash: live(s, 'sitemaps', IDS.sitemap).hash, intent: { verb: 'update', component: 'sitemap', name: 'Donor App', changed: ['subareas'] } }));
  await refused(C.planComponent(s, sj, ctx()), /'Donor App' has unpublished edits/);
});

test('drafts: OTHER views on the table go live with the publish, so the pop-up says so; one appearing after the plan refuses', async () => {
  const dv = dvAs('dev');
  const draftId = '22222222-2222-2222-2222-000000000009';
  dv.data.drafts.savedqueries[draftId] = { savedqueryid: draftId, name: 'Draft Donors', returnedtypecode: 'contact', fetchxml: FETCH, layoutxml: LAYOUT };
  const plan = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT, proven_in: '20261007-090000-deadbeef' })), ctx());
  assert.deepEqual(plan.severity.lines, ["Can't be fully undone: publishing contact also publishes unpublished edits to: the view 'Draft Donors'."]);
  const create = await C.planComponent(dv, valid(job({ component: { set: 'savedqueries', name: 'Big Donors' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { fetchxml: FETCH, layoutxml: LAYOUT, returnedtypecode: 'contact' }, intent: { verb: 'create', component: 'view', name: 'Big Donors' } })), ctx());
  assert.ok(create.severity.irreversible.some((x) => /also publishes unpublished edits to: the view .Draft Donors./.test(x)), 'a create publishes the table too');

  const late = dvAs('dev');
  const p2 = await C.planComponent(late, valid(viewJob(late, { layoutxml: SWAPPED_LAYOUT, proven_in: '20261007-090000-deadbeef' })), ctx());
  assert.deepEqual(p2.severity.lines, []);
  late.data.drafts.savedqueries[IDS.mview] = { layoutxml: SWAPPED_LAYOUT };
  await assert.rejects(applied(p2, late, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'severity_grew' && /also publishes unpublished edits to: the view .Active Contacts./.test(e.message));
});

// ---------- proven_in: the SAME change ----------

test('proven_in counts only when the dev copy applied the same change: same kind, name, mode and sections', async () => {
  const log = {
    'P-SAME': devView(),
    'P-NAME': devEntry({ name: 'Lapsed Donors' }),
    'P-SECT': devEntry({ sections: ['filters'] }),
    'P-MODE': devEntry({ action: 'delete', sections: [] }),
    'P-SET': devEntry({ set: 'systemforms' }),
    'P-ROWS': { mode: 'update', table: 'contacts', outcome: 'applied' },
  };
  const c = ctx({ readEnv: () => devDv(log) });
  const line = async (pid) => {
    const dv = dvAs('dev');
    const p = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT, proven_in: pid })), c);
    return p.severity.lines.join(' | ');
  };
  assert.equal(await line('P-SAME'), '');
  assert.match(await line('P-NAME'), /Not tried in Donor App Dev first \(plan P-NAME was a different change: it changed 'Lapsed Donors', not 'Active Donors'\)/);
  assert.match(await line('P-SECT'), /different change: it changed filters; this changes columns/);
  assert.match(await line('P-MODE'), /different change: it was a delete, not a update/);
  assert.match(await line('P-SET'), /different change: it changed a form, not a view/);
  assert.match(await line('P-ROWS'), /different change: it was not an app component change/);
  assert.match(await line('P-NONE'), /plan P-NONE is not in its Write Log as applied/);
});

test('the log entry records the sections changed, so it can be cited as proven_in later', async () => {
  const dv = dvAs('dev');
  const { res } = await applied(await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx()), dv);
  assert.deepEqual(res.entry.sections, ['columns']);
  assert.equal(res.entry.component.name, 'Active Donors');
  assert.equal(res.entry.action, 'update');
});

// ---------- blind review round 2 ----------

test('drafts: publishing the table for a VIEW names a FORM draft on it, and the other way round', async () => {
  const dv = dvAs('dev');
  dv.data.drafts.systemforms[IDS.form] = { formxml: FORM.replace('Form.onLoad', 'Form.onLoad2') };
  const p = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT, proven_in: '20261007-090000-deadbeef' })), ctx());
  assert.deepEqual(p.severity.lines, ["Can't be fully undone: publishing contact also publishes unpublished edits to: the form 'SBRM Donor: Contact'."]);

  const f = dvAs('dev');
  f.data.drafts.savedqueries[IDS.view] = { layoutxml: SWAPPED_LAYOUT };
  const fj = valid(job({ component: { set: 'systemforms', id: IDS.form, name: 'SBRM Donor: Contact' }, mode: 'update', definition: { formxml: FORM.replace('description="Summary"', 'description="Overview"') }, snapshot_hash: live(f, 'systemforms', IDS.form).hash, intent: { verb: 'update', component: 'form', name: 'SBRM Donor: Contact', changed: ['tabs'] } }));
  const fp = await C.planComponent(f, fj, ctx());
  assert.ok(fp.severity.irreversible.includes("publishing contact also publishes unpublished edits to: the view 'Active Donors'"));
});

test('proven_in matches on CONTENT: a view with other columns, a form with another label, a flow changing other actions are different changes', () => {
  const after = { fetchxml: FETCH, layoutxml: SWAPPED_LAYOUT, description: null };
  const me = { set: 'savedqueries', name: 'Active Donors', mode: 'update', sections: ['columns'], after };
  assert.equal(C.sameChange(me, devView()), true);
  const other = devView({ after: { ...after, layoutxml: SWAPPED_LAYOUT.replace('telephone1', 'mobilephone') } });
  assert.equal(C.sameChange(me, other), "its columns differs from this change's");
  assert.equal(C.sameChange(me, devEntry()), 'its log entry does not carry the definitions to compare');
  // drift outside the changed sections does not count (the dev copy's filters differ, the change is columns)
  assert.equal(C.sameChange(me, devView({ after: { ...after, fetchxml: FETCH.replace('value="0"', 'value="1"') } })), true);

  const formAfter = { formxml: FORM.replace('description="Summary"', 'description="Overview"'), description: 'd' };
  const fme = { set: 'systemforms', name: 'SBRM Donor: Contact', mode: 'update', sections: ['tabs'], after: formAfter };
  assert.equal(C.sameChange(fme, devEntry({ set: 'systemforms', name: 'SBRM Donor: Contact', sections: ['tabs'], after: formAfter })), true);
  assert.equal(C.sameChange(fme, devEntry({ set: 'systemforms', name: 'SBRM Donor: Contact', sections: ['tabs'], after: { ...formAfter, formxml: FORM.replace('description="Summary"', 'description="Totals"') } })), "its tabs differs from this change's");

  // flows: same action change, but the dev copy's connection reference logical names differ (they do by environment)
  const prodBefore = flowCd();
  const prodAfter = flowCd();
  prodAfter.properties.definition.actions.Compose_total.inputs = 'changed';
  const devBefore = flowCd({ refs: { shared_commondataserviceforapps: REF('new_shareddataverse_dev01') } });
  const devAfter = flowCd({ refs: { shared_commondataserviceforapps: REF('new_shareddataverse_dev01') } });
  devAfter.properties.definition.actions.Compose_total.inputs = 'changed in dev';
  const flowMe = { set: 'workflows', name: 'Add Soft Credit', mode: 'update', sections: ['actions'], diff: C.diffFlow(prodBefore, prodAfter) };
  const fe = (b, a) => devEntry({ set: 'workflows', name: 'Add Soft Credit', sections: ['actions'], before: { clientdata: JSON.stringify(b), description: null }, after: { clientdata: JSON.stringify(a), description: null } });
  assert.equal(C.sameChange(flowMe, fe(devBefore, devAfter)), true, 'the same action changed, in another environment');
  const devOther = flowCd({ refs: { shared_commondataserviceforapps: REF('new_shareddataverse_dev01') } });
  devOther.properties.definition.actions.Get_donor.inputs.parameters.entityName = 'accounts';
  assert.equal(C.sameChange(flowMe, fe(devBefore, devOther)), "its actions differs from this change's");
  // the same action name, changed into a different KIND of step, is a different change
  const devRetyped = flowCd({ refs: { shared_commondataserviceforapps: REF('new_shareddataverse_dev01') } });
  devRetyped.properties.definition.actions.Compose_total = { runAfter: { Get_donor: ['Succeeded'] }, type: 'Http', inputs: { method: 'POST', uri: 'https://example.invalid' } };
  assert.equal(C.sameChange(flowMe, fe(devBefore, devRetyped)), "its actions differs from this change's");

  // a connection reference added under the same key is the same change, though its logical name is per environment
  const addOutlook = (cd, logical) => { cd.properties.connectionReferences.shared_office365 = REF(logical, 'shared_office365'); return cd; };
  const connMe = { set: 'workflows', name: 'Add Soft Credit', mode: 'update', sections: ['connections'], diff: C.diffFlow(flowCd(), addOutlook(flowCd(), 'sbrm_outlook_appadmin')) };
  const conn = (key) => devEntry({ set: 'workflows', name: 'Add Soft Credit', sections: ['connections'], before: { clientdata: JSON.stringify(devBefore) }, after: { clientdata: JSON.stringify(key ? addOutlook(flowCd({ refs: { shared_commondataserviceforapps: REF('new_shareddataverse_dev01') } }), 'new_sharedoffice365_dev02') : devBefore) } });
  assert.equal(C.sameChange(connMe, conn(true)), true);
  const devOtherKey = flowCd({ refs: { shared_commondataserviceforapps: REF('new_shareddataverse_dev01'), shared_teams: REF('new_sharedteams_dev03', 'shared_teams') } });
  assert.equal(C.sameChange(connMe, devEntry({ set: 'workflows', name: 'Add Soft Credit', sections: ['connections'], before: { clientdata: JSON.stringify(devBefore) }, after: { clientdata: JSON.stringify(devOtherKey) } })), "its connections differs from this change's");
});

test('proven_in: a designer link-entity alias that differs by environment is not a difference; anything else is', () => {
  const fetch = (alias) => FETCH.replace('<attribute name="contactid" />', `<attribute name="contactid" /><link-entity name="msnfp_transaction" from="msnfp_transactionid" to="msnfp_lasttransactionid" link-type="outer" alias="${alias}"><attribute name="msnfp_amount" /></link-entity>`);
  const layout = (alias) => LAYOUT.replace('</row>', `<cell name="${alias}.msnfp_amount" width="100" /></row>`);
  const a = { fetchxml: fetch('a_a4256f4f7ce1ee11904c00224805c3cf'), layoutxml: layout('a_a4256f4f7ce1ee11904c00224805c3cf') };
  const b = { fetchxml: fetch('a_cf56218319954b6a998ef0a90a231337'), layoutxml: layout('a_cf56218319954b6a998ef0a90a231337') };
  assert.equal(C.sectionContent('savedqueries', a, 'columns'), C.sectionContent('savedqueries', b, 'columns'));
  assert.equal(C.sectionContent('savedqueries', a, 'filters'), C.sectionContent('savedqueries', b, 'filters'));
  const hand = { fetchxml: fetch('donation'), layoutxml: layout('donation') };
  assert.notEqual(C.sectionContent('savedqueries', a, 'columns'), C.sectionContent('savedqueries', hand, 'columns'), 'only the designer\'s generated aliases are renamed');
});

test('a create shows every field its body sets, not only the definition', async () => {
  const dv = dvAs('admin'); // the fixture form carries an onload script, which is an admin's since round 3
  const view = await C.planComponent(dv, valid(job({ component: { set: 'savedqueries', name: 'Big Donors' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { fetchxml: FETCH, layoutxml: LAYOUT, returnedtypecode: 'contact' }, intent: { verb: 'create', component: 'view', name: 'Big Donors' } })), ctx());
  assert.match(C.componentSummary(view), /Also sets: querytype 0 \(public view\), returnedtypecode contact/);
  const form = await C.planComponent(dv, valid(job({ component: { set: 'systemforms', name: 'Quick Donor' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { formxml: FORM, objecttypecode: 'contact', type: 7 }, intent: { verb: 'create', component: 'form', name: 'Quick Donor' } })), ctx());
  assert.match(C.componentSummary(form), /Also sets: type 7 \(quick create form\), objecttypecode contact/);
  const { res } = await applied(form, dv);
  assert.equal(nonGets(dv).find((c) => c.method === 'POST' && c.path === 'systemforms').body.type, 7, 'and the body sets exactly that');
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  const cd = flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } });
  cd.properties.definition.actions.Compose_total.description = 'x';
  const flow = await C.planComponent(dv, valid(job({ component: { set: 'workflows', name: 'Test Flow' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { clientdata: cd }, intent: { verb: 'create', component: 'flow', name: 'Test Flow' } })), ctx());
  assert.match(C.componentSummary(flow), /Also sets: category 5 \(cloud flow\), type 1 \(definition\), primaryentity none/);
});

test('views, forms, sitemaps and flows on the toolkit\'s own tables need admin', async () => {
  assert.deepEqual([...C.TOOLKIT_TABLES].sort(), ['sbrm_dataverseevent', 'sbrm_dataversewriteaccess', 'sbrm_dataversewritelog']);
  const mkView = (dv) => valid(job({ component: { set: 'savedqueries', name: 'All Log Rows' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { fetchxml: FETCH.replace('name="contact"', 'name="sbrm_dataversewritelog"'), layoutxml: LAYOUT, returnedtypecode: 'sbrm_dataversewritelog' }, intent: { verb: 'create', component: 'view', name: 'All Log Rows' } }));
  const dev = dvAs('dev');
  dev.data.attrs.sbrm_dataversewritelog = ['sbrm_dataversewritelogid', 'sbrm_name'];
  await refused(C.planComponent(dev, mkView(dev), ctx()), /takes admin access .* because it touches the toolkit's own sbrm_dataversewritelog/, 'not_permitted');
  const adm = dvAs('admin');
  adm.data.attrs.sbrm_dataversewritelog = ['sbrm_dataversewritelogid', 'sbrm_name'];
  assert.equal((await C.planComponent(adm, mkView(adm), ctx())).need, 'admin');

  const s = dvAs('dev');
  const sj = valid(job({ component: { set: 'sitemaps', id: IDS.sitemap, name: 'Donor App' }, mode: 'update', definition: { sitemapxml: SITEMAP.replace('</Group>', '<SubArea Id="subarea_events" Entity="sbrm_dataverseevent" /></Group>') }, snapshot_hash: live(s, 'sitemaps', IDS.sitemap).hash, intent: { verb: 'update', component: 'sitemap', name: 'Donor App', changed: ['subareas'] } }));
  await refused(C.planComponent(s, sj, ctx()), /touches the toolkit's own sbrm_dataverseevent/, 'not_permitted');

  const f = dvAs('dev');
  const cd = flowCd();
  cd.properties.definition.actions.Compose_total = { runAfter: { Get_donor: ['Succeeded'] }, type: 'OpenApiConnection', description: 'Writes a log row.', inputs: { host: { operationId: 'CreateRecord' }, parameters: { entityName: 'sbrm_dataversewritelogs' } } };
  await refused(C.planComponent(f, valid(flowJob(f, cd, { changed: ['actions', 'notes'] })), ctx()), /touches the toolkit's own sbrm_dataversewritelog/, 'not_permitted');
  // turning such a flow off adds nothing it can do: develop
  f.data.workflows[IDS.flow].clientdata = JSON.stringify(cd);
  assert.equal((await C.planComponent(f, valid(stateJob(f, 'off')), ctx())).need, 'develop');
});

// ---------- blind review round 3 ----------

const noSecret = (s) => assert.ok(!String(s).includes(PLACEHOLDER_SECRET), 'the secret value is never printed');
const SECRET_RE = /the flow holds a secret in plain text \(parameter "SecretId \(sbrm_SecretId\)"\); move it to a Secret environment variable first\. Nothing was logged\./;

test('secrets: a flow holding one in plain text is refused for every mode, before anything is stored, without printing it', async () => {
  for (const [who, mode] of [['dev', 'on'], ['admin', 'own'], ['admin', 'delete']]) {
    const dv = dvAs(who);
    const over = mode === 'own' ? { owner: IDS.dev2 } : {};
    await assert.rejects(C.planComponent(dv, valid(stateJob(dv, mode, { id: IDS.secretflow, name: 'Example Secret Flow', ...over })), ctx()), (e) => {
      assert.equal(e.code, 'invalid_job');
      assert.match(e.message, SECRET_RE);
      noSecret(e.message);
      return true;
    });
    assert.deepEqual(nonGets(dv), []);
  }
  // an update that would REMOVE it is refused too: the before would be logged
  const dv = dvAs('admin');
  const clean = secretFlowCd({ secret: '' });
  await assert.rejects(C.planComponent(dv, valid(flowJob(dv, clean, { id: IDS.secretflow, name: 'Example Secret Flow', changed: ['other'] })), ctx()), (e) => SECRET_RE.test(e.message) && !e.message.includes(PLACEHOLDER_SECRET));
});

test('secrets: a job file carrying one is refused at validation; literal Http credentials and secure parameters count; expressions do not', () => {
  const cd = flowCd();
  cd.properties.definition.actions.Call = { runAfter: {}, type: 'Http', description: 'x', inputs: { method: 'GET', uri: 'https://example.invalid/x', headers: { Authorization: 'Bearer PLACEHOLDER-token-0000' } } };
  const { errors } = C.validateComponentJob(job({ component: { set: 'workflows', id: IDS.flow, name: 'Add Soft Credit' }, mode: 'update', definition: { clientdata: cd }, snapshot_hash: 'a'.repeat(64), intent: { verb: 'update', component: 'flow', name: 'Add Soft Credit', changed: ['actions'] } }), { envs: ENVS });
  assert.match(errors.join('\n'), /holds a secret in plain text \(step "Call" \(its Authorization header\)\)/);
  assert.ok(!errors.join('\n').includes('PLACEHOLDER-token'));
  const p = (params, actions = {}) => C.flowSecrets({ properties: { definition: { parameters: params, actions, triggers: {} } } });
  assert.deepEqual(p({ 'Api Key': { type: 'String', defaultValue: 'x' } }), ['parameter "Api Key"']);
  assert.deepEqual(p({ Cred: { type: 'SecureString', defaultValue: 'x' } }), ['parameter "Cred"']);
  assert.deepEqual(p({ 'Api Key': { type: 'String', defaultValue: '' }, ClientId: { type: 'String', defaultValue: 'abc' }, $authentication: { type: 'SecureObject', defaultValue: {} } }), []);
  assert.deepEqual(p({}, { H: { type: 'Http', inputs: { authentication: { type: 'Basic', username: 'u', password: 'p' } } } }), ['step "H" (its authentication password)']);
  assert.deepEqual(p({}, { H: { type: 'Http', inputs: { authentication: { type: 'Basic', username: 'u', password: "@parameters('pw')" } } } }), []);
});

test('secrets: apply refuses a plan file whose definition was edited to carry one, without printing it', async () => {
  const dv = dvAs('admin');
  const cd = flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } });
  cd.properties.definition.actions.Compose_total.inputs = 'changed';
  const plan = await C.planComponent(dv, valid(flowJob(dv, cd, { changed: ['actions'], id: IDS.offflow, name: 'Sync Letters' })), ctx());
  const bad = { ...plan, after_definition: { ...plan.after_definition, clientdata: JSON.stringify(secretFlowCd()) } };
  await assert.rejects(applied(bad, dv, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'invalid_job' && SECRET_RE.test(e.message) && !e.message.includes(PLACEHOLDER_SECRET));
  assert.deepEqual(nonGets(dv), []);
});

test('power: an Http step, a child flow, a run-time table and a step on someone else\'s connection are admin, with their inputs shown', async () => {
  const mine = () => flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } }); // Sync Letters runs on the person's own connection
  const cases = [
    [(cd) => { cd.properties.definition.actions.Call_api = { runAfter: {}, type: 'Http', description: 'Calls the API.', inputs: { method: 'post', uri: 'https://api.example.invalid/v1/x', authentication: { type: 'ManagedServiceIdentity' } } }; }, ['actions'],
      /step Call_api calls POST api\.example\.invalid directly over HTTP/, /\+ Call_api \[Http\]: POST api\.example\.invalid, auth ManagedServiceIdentity/],
    [(cd) => { cd.properties.definition.actions.Run_child = { runAfter: {}, type: 'Workflow', description: 'Runs the child.', inputs: { host: { workflowReferenceName: IDS.caller } } }; }, ['actions'],
      /step Run_child runs another flow \(child flow 11111111-1111-1111-1111-000000000002\)/, /\+ Run_child \[Workflow\]: child flow 11111111/],
    [(cd) => { cd.properties.definition.actions.Get_donor.inputs.parameters.entityName = "@{concat('con','tacts')}"; }, ['actions'],
      /step Get_donor picks its table or operation at run time/, /~ Get_donor \[OpenApiConnection\]: table @\{concat/],
  ];
  for (const [edit, changed, why, line] of cases) {
    const dev = dvAs('dev');
    const cd = mine();
    edit(cd);
    await refused(C.planComponent(dev, valid(flowJob(dev, cd, { changed, id: IDS.offflow, name: 'Sync Letters' })), ctx()), why, 'not_permitted');
    const adm = dvAs('admin');
    const p = await C.planComponent(adm, valid(flowJob(adm, cd, { changed, id: IDS.offflow, name: 'Sync Letters' })), ctx());
    assert.match(C.componentSummary(p), line);
    assert.match(C.componentDetail(p), why);
  }
  // changing a step that runs through SBRM App Admin's connection, with no connection change, is admin too
  const dev = dvAs('dev');
  const cd = flowCd();
  cd.properties.definition.actions.Get_donor.inputs.parameters.recordId = "@triggerOutputs()?['body/msnfp_transactionid']";
  await refused(C.planComponent(dev, valid(flowJob(dev, cd, { changed: ['actions'] })), ctx()), /step Get_donor acts through Microsoft Dataverse, as SBRM App Admin/, 'not_permitted');
  // and a plain step on the person's own connection stays develop
  const ok = dvAs('dev');
  const own = mine();
  own.properties.definition.actions.Get_donor.inputs.parameters.recordId = 'x';
  assert.equal((await C.planComponent(ok, valid(flowJob(ok, own, { changed: ['actions'], id: IDS.offflow, name: 'Sync Letters' })), ctx())).need, 'develop');
});

test('a flow change in "other" (parameters, outputs, settings) is admin, carries a warning, and shows what changed', async () => {
  const cd = flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } });
  cd.properties.definition.parameters.Region = { type: 'String', defaultValue: 'west' };
  const dev = dvAs('dev');
  await refused(C.planComponent(dev, valid(flowJob(dev, cd, { changed: ['other'], id: IDS.offflow, name: 'Sync Letters' })), ctx()), /changes parts of the flow outside its trigger, steps and connections/, 'not_permitted');
  const adm = dvAs('admin');
  const p = await C.planComponent(adm, valid(flowJob(adm, cd, { changed: ['other'], id: IDS.offflow, name: 'Sync Letters' })), ctx());
  assert.ok(p.severity.irreversible.some((x) => /changes parts of the flow 'Sync Letters' outside its trigger, steps and connections/.test(x)));
  assert.match(C.componentDetail(p), /other \+ .*"Region"/);
});

test('views: the whole cell is compared, and a script hook on a column is admin and named', async () => {
  const hooked = LAYOUT.replace('<cell name="fullname" width="300" />', '<cell name="fullname" width="300" imageproviderwebresource="$webresource:sbrm_/icons.js" imageproviderfunctionname="Sbrm.icon" />');
  const d = C.diffView({ fetchxml: FETCH, layoutxml: LAYOUT }, { fetchxml: FETCH, layoutxml: hooked });
  assert.deepEqual(d.sections, ['columns'], 'a cell attribute change is a column change, not unseen');
  assert.deepEqual(C.viewHooks(LAYOUT.replace('width="300"', 'width="300" imageproviderwebresource="$webresource:"')), [], 'the designer\'s empty hook is not a hook');
  const dev = dvAs('dev');
  await refused(C.planComponent(dev, valid(viewJob(dev, { layoutxml: hooked })), ctx()), /a view column fullname: imageproviderfunctionname Sbrm\.icon runs a script/, 'not_permitted');
  const adm = dvAs('admin');
  const p = await C.planComponent(adm, valid(viewJob(adm, { layoutxml: hooked })), ctx());
  assert.match(C.componentSummary(p), /Script hook added or changed: column fullname: imageproviderwebresource \$webresource:sbrm_\/icons\.js/);
  // removing a hook runs nothing: develop
  const back = dvAs('dev');
  back.data.savedqueries[IDS.view].layoutxml = hooked;
  assert.equal((await C.planComponent(back, valid(viewJob(back, { layoutxml: LAYOUT })), ctx())).need, 'develop');
});

test('forms: a web resource, iframe, custom control or URL control, even one bound to a field, is admin and named', async () => {
  const cell = (control, extra = '') => FORM.replace('</rows></section>', `<row><cell id="{aaaa0000-0000-0000-0000-000000000001}" showlabel="false">${control}</cell></row></rows></section>`).replace('</form>', `${extra}</form>`);
  const cases = [
    [cell('<control id="WebResource_map" classid="{9FDF5F91-88B1-47f4-AD53-C11EFC01A01D}"><parameters><Url>sbrm_/map.html</Url></parameters></control>'), /control WebResource_map \(web resource: sbrm_\/map\.html\)/],
    [cell('<control id="IFRAME_site" classid="{FD2A7985-3187-444e-908D-6624B21F69C0}"><parameters><Url>https://example.invalid/page</Url></parameters></control>'), /control IFRAME_site \(iframe: https:\/\/example\.invalid\/page\)/],
    [cell('<control id="emailaddress1b" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="emailaddress1"><parameters><Url>https://example.invalid/lookup</Url></parameters></control>'), /control emailaddress1b \(URL: https:\/\/example\.invalid\/lookup\)/],
    [cell('<control id="lastname_pcf" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="lastname" />', '<controlDescriptions><controlDescription forControl="lastname_pcf"><customControl name="sbrm_Sbrm.Slider" formFactor="0" /></controlDescription></controlDescriptions>'), /control lastname_pcf \(custom control: sbrm_Sbrm\.Slider\)/],
  ];
  for (const [formxml, re] of cases) {
    const dev = dvAs('dev');
    const s = live(dev, 'systemforms', IDS.form);
    const j = valid(job({ component: { set: 'systemforms', id: IDS.form, name: 'SBRM Donor: Contact' }, mode: 'update', definition: { formxml }, snapshot_hash: s.hash, intent: { verb: 'update', component: 'form', name: 'SBRM Donor: Contact', changed: C.diffForm({ formxml: FORM }, { formxml }).sections } }));
    await refused(C.planComponent(dev, j, ctx()), re, 'not_permitted');
  }
  // Microsoft's own controls are not custom; and a changed event handler is admin
  assert.deepEqual(C.formHooks(FORM.replace('</form>', '<controlDescriptions><controlDescription forControl="lastname"><customControl name="MscrmControls.FieldControls.TextBoxControl" /></controlDescription></controlDescriptions></form>')).map((h) => h.label).filter((l) => /control/.test(l)), []);
  assert.match(C.markupPower('systemforms', { formxml: FORM }, { formxml: FORM.replace('Form.onLoad', 'Form.onLoad2') }).why.join(' '), /it adds or changes on onload: sbrm_contact\.js\.Form\.onLoad2/);
});

test('sitemaps: a page that opens a URL or web resource instead of a table is admin and named', async () => {
  const sm = SITEMAP.replace('</Group>', '<SubArea Id="subarea_report" Url="/WebResources/sbrm_/report.html" /></Group>');
  const dev = dvAs('dev');
  const j = (dv) => valid(job({ component: { set: 'sitemaps', id: IDS.sitemap, name: 'Donor App' }, mode: 'update', definition: { sitemapxml: sm }, snapshot_hash: live(dv, 'sitemaps', IDS.sitemap).hash, intent: { verb: 'update', component: 'sitemap', name: 'Donor App', changed: ['subareas'] } }));
  await refused(C.planComponent(dev, j(dev), ctx()), /it adds or changes page subarea_report opens \/WebResources\/sbrm_\/report\.html/, 'not_permitted');
  const adm = dvAs('admin');
  assert.match(C.componentSummary(await C.planComponent(adm, j(adm), ctx())), /Added or changed: page subarea_report opens \/WebResources\/sbrm_\/report\.html/);
});

test('plan_tampered: apply refuses a plan file that sends anything but definition fields (and the create extras)', async () => {
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx());
  for (const bad of [
    { ...plan, sent_fields: ['layoutxml', 'ismanaged'], after_definition: { ...plan.after_definition, ismanaged: true } },
    { ...plan, sent_fields: ['statecode'] },
    { ...plan, after_definition: { ...plan.after_definition, returnedtypecode: 'account' } },
  ]) {
    await assert.rejects(applied(bad, dv, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'plan_tampered');
  }
  const c = await C.planComponent(dv, valid(job({ component: { set: 'savedqueries', name: 'Big Donors' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { fetchxml: FETCH, layoutxml: LAYOUT, returnedtypecode: 'contact' }, intent: { verb: 'create', component: 'view', name: 'Big Donors' } })), ctx());
  await assert.rejects(applied({ ...c, create_extra: { ...c.create_extra, statecode: 1 } }, dv, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'plan_tampered' && /the create field "statecode"/.test(e.message));
  assert.deepEqual(nonGets(dv), []);
  assert.deepEqual(C.planShapeProblems(plan), []);
  assert.deepEqual(C.planShapeProblems({ ...plan, sent_fields: ['statecode'] }), ['the field "statecode"'], 'the sent fields are checked themselves, not only through the body');
});

test('drafts are read AGAIN after the pop-up is approved: one saved while it was open stops the write', async () => {
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx());
  await assert.rejects(applied(plan, dv, { confirm: () => { dv.data.drafts.savedqueries[IDS.view] = { layoutxml: LAYOUT.replace('300', '250') }; return { approved: true }; } }),
    (e) => e.code === 'snapshot_moved' && /saved while the approval was waiting/.test(e.message));
  const v = dvAs('dev');
  const p2 = await C.planComponent(v, valid(viewJob(v, { layoutxml: SWAPPED_LAYOUT })), ctx());
  await assert.rejects(applied(p2, v, { confirm: () => { v.data.drafts.systemforms[IDS.form] = { formxml: FORM.replace('Form.onLoad', 'Form.onLoad9') }; return { approved: true }; } }),
    (e) => e.code === 'severity_grew' && /publishing contact now would publish them too: the form 'SBRM Donor: Contact'/.test(e.message));
  assert.deepEqual(nonGets(dv), []);
  assert.deepEqual(nonGets(v), []);
});

test('read-back: a flow the platform switched off on save, or a subscription with another scope, is not "written"', async () => {
  const mk = () => {
    const cd = flowCd();
    cd.properties.definition.actions.Compose_total.inputs = 'changed';
    return cd;
  };
  const dv = dvAs('dev');
  const plan = await C.planComponent(dv, valid(flowJob(dv, mk(), { changed: ['actions'] })), ctx());
  dv.switchOffOnSave = true;
  const { res } = await applied(plan, dv);
  assert.match(res.rows[0].outcome, /^read-back mismatch: the flow's state changed on save \(statecode 1 -> 0, statuscode 2 -> 1\)/);
  const s = dvAs('dev');
  const p2 = await C.planComponent(s, valid(flowJob(s, mk(), { changed: ['actions'] })), ctx());
  s.subscriptionScope = 2;
  const r2 = (await applied(p2, s)).res;
  assert.match(r2.rows[0].outcome, /the trigger is not live as the definition says .*scope 2 \(the definition says 4\)/);
});

test('proven_in for flows compares the changed steps\' inputs, not only their names and types', () => {
  const before = flowCd();
  const prodAfter = flowCd();
  prodAfter.properties.definition.actions.Get_donor.inputs.parameters.entityName = 'accounts';
  const devAfter = flowCd();
  devAfter.properties.definition.actions.Get_donor.inputs.parameters.entityName = 'leads';
  const me = { set: 'workflows', name: 'Add Soft Credit', mode: 'update', sections: ['actions'], diff: C.diffFlow(before, prodAfter) };
  const e = (a) => devEntry({ set: 'workflows', name: 'Add Soft Credit', sections: ['actions'], before: { clientdata: JSON.stringify(before) }, after: { clientdata: JSON.stringify(a) } });
  assert.equal(C.sameChange(me, e(devAfter)), "its actions differs from this change's");
  assert.equal(C.sameChange(me, e(prodAfter)), true);
});

// ---------- blind review round 4 ----------

test('secrets: every place a typed-in credential can sit, in steps AND triggers; expressions and count fields never count', () => {
  const S = (actions = {}, triggers = {}) => C.flowSecrets({ properties: { definition: { parameters: {}, actions, triggers } } });
  const http = (inputs) => S({ H: { type: 'Http', inputs } });
  assert.deepEqual(http({ authentication: { type: 'Raw', value: 'Bearer abc123' } }), ['step "H" (its authentication value)']);
  assert.deepEqual(http({ authentication: { type: 'ClientCertificate', pfx: 'MIIabc', password: 'pw' } }), ['step "H" (its authentication pfx)', 'step "H" (its authentication password)']);
  assert.deepEqual(http({ authentication: { type: 'ActiveDirectoryOAuth', tenant: 't', audience: 'a', clientId: 'c', secret: 's3cr3t' } }), ['step "H" (its authentication secret)']);
  assert.deepEqual(http({ method: 'GET', uri: 'https://x.invalid/api?sv=1&sig=abcDEF&code=zz' }), ['step "H" (its URI query sig)', 'step "H" (its URI query code)']);
  assert.deepEqual(http({ method: 'GET', uri: "https://x.invalid/api?sig=@{parameters('sig')}" }), [], 'an interpolated expression is not a literal');
  assert.deepEqual(http({ headers: { 'x-api-key': 'k1', 'Ocp-Apim-Subscription-Key': 'k2', 'Content-Type': 'application/json' } }), ['step "H" (its x-api-key header)', 'step "H" (its Ocp-Apim-Subscription-Key header)']);
  assert.deepEqual(http({ queries: { apikey: 'k' } }), ['step "H" (its query apikey)']);
  assert.deepEqual(http({ headers: { Authorization: "Bearer @{parameters('Api Token (sbrm_ApiToken)')}" } }), [], 'text around an @{...} expression is not a literal secret');
  assert.deepEqual(http({ body: { grant: 'client_credentials', client_secret: 'abc', max_tokens: 500, nested: { password: 'p' } } }), ['step "H" (its body client_secret)', 'step "H" (its body password)']);
  assert.deepEqual(http({ body: 'grant_type=client_credentials&client_secret=abc' }), ['step "H" (its body client_secret)']);
  assert.deepEqual(http({ body: '{"apiKey":"abc","max_completion_tokens":800}' }), ['step "H" (its body apiKey)']);
  assert.deepEqual(http({ body: { client_secret: "@parameters('s')", max_tokens: 4000 } }), []);
  // a non-HTTP connector step, and a trigger
  assert.deepEqual(S({ C1: { type: 'OpenApiConnection', inputs: { host: { connectionName: 'k' }, parameters: { 'item/apiKey': 'abc', 'item/name': 'x' } } } }), ['step "C1" (its parameter item/apiKey)']);
  assert.deepEqual(S({}, { T: { type: 'HttpWebhook', inputs: { subscribe: { method: 'POST' }, headers: { Authorization: 'Basic abc' } } } }), ['trigger "T" (its Authorization header)']);
});

test('power: outside-facing triggers, connector HTTP operations and older $connections steps are judged like Http steps', async () => {
  const ra = [{ key: 'shared_sp', owner_id: IDS.me, owner: 'Test Person', display: 'SharePoint' }, { key: 'shared_admin', owner_id: IDS.appadmin, owner: 'SBRM App Admin', display: 'Dataverse' }];
  const f = (a) => C.actionFacts(a);
  assert.match(C.stepPower('Send', f({ type: 'OpenApiConnection', inputs: { host: { connectionName: 'shared_sp', operationId: 'HttpRequest' } } }), ra, IDS.me).join(), /sends a raw HTTP request through its connection \(operation HttpRequest\)/);
  assert.match(C.stepPower('Entra', f({ type: 'OpenApiConnection', inputs: { host: { connectionName: 'shared_sp', operationId: 'InvokeHttp' } } }), ra, IDS.me).join(), /operation InvokeHttp/);
  const legacy = (key) => ({ type: 'ApiConnection', inputs: { host: { connection: { name: `@parameters('$connections')['${key}']['connectionId']` } }, method: 'get', path: '/x' } });
  assert.match(C.stepPower('Old', f(legacy('shared_admin')), ra, IDS.me).join(), /step Old acts through Dataverse, as SBRM App Admin/);
  assert.deepEqual(C.stepPower('Old', f(legacy('shared_sp')), ra, IDS.me), [], 'the person\'s own connection, resolved from $connections');
  assert.match(C.stepPower('Odd', f({ type: 'ApiConnection', inputs: { host: { connection: { name: "@variables('conn')" } } } }), ra, IDS.me).join(), /cannot match to a connection reference/);
  assert.match(C.stepPower('Ghost', f({ type: 'OpenApiConnection', inputs: { host: { connectionName: 'shared_nowhere', operationId: 'GetItem' } } }), ra, IDS.me).join(), /connection references do not name/);
  assert.match(C.triggerPower('manual', f({ type: 'Request', kind: 'Http', inputs: { schema: {} } }), ra, IDS.me).join(), /takes HTTP requests from outside/);
  assert.deepEqual(C.triggerPower('manual', f({ type: 'Request', kind: 'Button', inputs: { schema: {} } }), ra, IDS.me), [], 'a manual or child-flow trigger is in-platform');
  assert.match(C.triggerPower('hook', f({ type: 'HttpWebhook', inputs: {} }), ra, IDS.me).join(), /registers a webhook/);

  // in a plan: a new flow with an HTTP request trigger is admin; a changed trigger on App Admin's connection too
  const cd = flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } });
  cd.properties.definition.triggers = { manual: { type: 'Request', kind: 'Http', inputs: { schema: {} }, description: 'Called by the website.' } };
  cd.properties.definition.actions.Compose_total.description = 'x';
  const dev = dvAs('dev');
  await refused(C.planComponent(dev, valid(job({ component: { set: 'workflows', name: 'Web Hook Flow' }, mode: 'create', solution: 'SBRMAdHocChanges', definition: { clientdata: cd }, intent: { verb: 'create', component: 'flow', name: 'Web Hook Flow' } })), ctx()), /trigger manual takes HTTP requests from outside/, 'not_permitted');
  const off = dvAs('dev');
  off.data.workflows[IDS.offflow].clientdata = JSON.stringify(flowCd());
  const offJob = flowJob(off, flowCd({ filter: 'statecode', note: 'Status only.' }), { changed: ['trigger', 'notes'], id: IDS.offflow, name: 'Sync Letters' });
  await refused(C.planComponent(off, valid(offJob), ctx()), /trigger When_a_row_is_modified acts through Microsoft Dataverse, as SBRM App Admin/, 'not_permitted');
});

test('revert refuses a forged or foreign log entry cleanly: unknown set, bad id, no name, another environment', async () => {
  const dv = dvAs('dev');
  const entry = await appliedEntry(dv, await C.planComponent(dv, valid(viewJob(dv, { layoutxml: SWAPPED_LAYOUT })), ctx()));
  const forged = (rowOver, top = {}) => ({ ...entry, ...top, rows: [{ ...entry.rows[0], ...rowOver }] });
  await refused(C.planComponentRevert(dv, forged({ set: 'roles' }, { component: { ...entry.component, set: 'roles' } }), ctx()), /does not name a component set this engine changes/, 'invalid_job');
  await refused(C.planComponentRevert(dv, forged({ set: 'systemforms' }), ctx()), /does not name a component set/, 'invalid_job');
  await refused(C.planComponentRevert(dv, forged({ id: '../../roles' }), ctx()), /no valid component id/, 'invalid_job');
  await refused(C.planComponentRevert(dv, forged({ name: '', after: { ...entry.rows[0].after, name: null } }), ctx()), /no component name/, 'invalid_job');
  await refused(C.planComponentRevert(dv, forged({}, { env: 'nowhere' }), ctx()), /names an environment the toolkit does not know/, 'invalid_job');
  const devCopy = fakeComponentDv({ email: 'dev@example.org', d: dv.data, host: ENVS.fedev.host });
  await refused(C.planComponentRevert(devCopy, entry, ctx()), /that change was made in the Donor App; this revert was planned against another environment/, 'invalid_job');
  assert.equal((await C.planComponentRevert(dv, entry, ctx())).mode, 'update', 'the genuine entry still reverts');
});

// Live 10/8: Dataverse drops a null-valued key when it saves a flow (`templateName: null` came back absent),
// so the create read back as a mismatch. A null key and an absent key are the same stored flow; a null
// inside an array is a value and still counts.
test('flow definitions: a null-valued key equals an absent key; array nulls still count', () => {
  const cd = (props) => JSON.stringify({ properties: { connectionReferences: {}, definition: { triggers: { manual: { type: 'Request' } }, actions: {} }, ...props }, schemaVersion: '1.0.0.0' });
  const row = (clientdata) => ({ workflowid: 'a0beabfa-36c3-f111-aaaf-70a8a5afce12', name: 'Test', clientdata, description: null });
  assert.equal(C.snapshot('workflows', row(cd({ templateName: null }))).hash, C.snapshot('workflows', row(cd({}))).hash);
  assert.notEqual(C.snapshot('workflows', row(cd({ list: [null] }))).hash, C.snapshot('workflows', row(cd({ list: [] }))).hash);
  assert.notEqual(C.snapshot('workflows', row(cd({ templateName: 'x' }))).hash, C.snapshot('workflows', row(cd({}))).hash);
});
