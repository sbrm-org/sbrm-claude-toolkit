'use strict';
// A built-in command-bar button hidden for one SBRM table in one app (kind "command", 1.11.43; Dylan 11/20/26, "Build
// both into the toolkit", after an operator deactivated three nights on the shelter waitlist), on a fake Dataverse
// (test/fake_command.js). Admin only; SBRM's own tables; Deactivate, Activate, New. The row made is the one the maker
// portal's command designer sends for its own Hide (captured 11/23/26): the global template's name, the table, the
// app, hidden, the template's action copied and its classic rules linked. Undo shows the button again; no row is deleted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-command-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/command');
const { fakeCommandDv, override, IDS, ENVS, ACCESS } = require('./fake_command');

const dvAs = (email = 'admin@example.org', over = {}) => fakeCommandDv({ email, ...over });
const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, ...over });
const TABLE = 'sbrm_waitlistcount';

function job(over = {}) {
  const hide = over.hide || ['deactivate'];
  const where = over.where === undefined ? ['list', 'form'] : over.where;
  const n = (Array.isArray(hide) ? hide.length : 0) * (where === null ? 4 : Array.isArray(where) ? where.length : 0);
  const j = {
    contract: 'sbrm-dv-job/1', kind: 'command', env: 'hgs', app: 'sbrm_Homeless', table: TABLE, hide, where, solution: 'SBRMWaitlistCount', source: 'claude-session',
    reason: 'The nightly flow makes these rows; nobody hides one by hand.', intent: { verb: 'command', action: 'hide', app: 'sbrm_Homeless', table: TABLE, buttons: n }, ...over,
  };
  if (j.where === null) delete j.where;
  return j;
}
function valid(raw) {
  const r = C.validateCommandJob(raw, { envs: ENVS });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
}
const errorsOf = (raw) => C.validateCommandJob(raw, { envs: ENVS }).errors;
async function refused(promise, re, code, name = 'PlanRefused') {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, name, e.stack);
    assert.match(e.message, re);
    if (code) assert.equal(e.code, code);
    return true;
  });
}
const applyRefused = (promise, re, code) => refused(promise, re, code, 'ApplyRefused');
const nonGets = (dv) => dv.calls.filter((c) => c.method !== 'GET');
const tmpl = (dv, button, location) => dv.data.appactions.find((r) => r.context === 0 && r.location === location && r.name.endsWith(`.${button}`));
const overridesOf = (dv, app = IDS.app) => dv.data.appactions.filter((r) => r.context === 1 && r._appmoduleid_value === app);
const entryFrom = (res) => JSON.parse(JSON.stringify(res.entry));

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await C.applyCommand({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, ...over,
  }, { id: `20261123-1600${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown, fileGone: !fs.existsSync(file) };
}

// ---------- the job file ----------

test('validate: app, table, buttons, places, solution and intent are checked; "where" defaults to all four places', () => {
  const j = valid(job());
  assert.deepEqual([j.app, j.table, j.hide, j.where, j.solution], ['sbrm_Homeless', TABLE, ['deactivate'], ['list', 'form'], 'SBRMWaitlistCount']);
  assert.deepEqual(valid(job({ where: null })).where, ['list', 'form', 'subgrid', 'associated']);
  const cases = [
    [{ colour: 1 }, /unknown top-level key "colour"/],
    [{ kind: 'component' }, /"kind" must be "command"/],
    [{ app: 'SBRM Homeless' }, /"app" must be the model-driven app's unique name/],
    [{ table: 'contact' }, /"table" must be the logical name of one of SBRM's own tables/],
    [{ table: 'sbrm_bad table' }, /"table" must be the logical name/],
    [{ solution: '' }, /"solution" must be the unique name of an existing SBRM solution/],
    [{ hide: [] }, /"hide" must list one or more of deactivate, activate, new/],
    [{ hide: ['delete'] }, /"hide" must list one or more of deactivate, activate, new, none twice/],
    [{ hide: ['deactivate', 'deactivate'] }, /none twice/],
    [{ where: ['everywhere'] }, /"where" must list one or more of list, form, subgrid, associated/],
    [{ where: [] }, /"where" must list one or more/],
    [{ reason: 'two\nlines' }, /"reason" must be one line/],
    [{ intent: undefined }, /"intent" is required/],
    [{ intent: { verb: 'component', action: 'hide', app: 'sbrm_Homeless', table: TABLE, buttons: 2 } }, /intent does not match.*verb says "component"/],
    [{ intent: { verb: 'command', action: 'show', app: 'sbrm_Homeless', table: TABLE, buttons: 2 } }, /intent does not match.*action says "show"/],
    [{ intent: { verb: 'command', action: 'hide', app: 'sbrm_Meals', table: TABLE, buttons: 2 } }, /intent does not match.*intent names the app "sbrm_Meals"/],
    [{ intent: { verb: 'command', action: 'hide', app: 'sbrm_Homeless', table: 'sbrm_other', buttons: 2 } }, /intent does not match.*intent names the table "sbrm_other"/],
    [{ intent: { verb: 'command', action: 'hide', app: 'sbrm_Homeless', table: TABLE, buttons: 1 } }, /intent does not match.*intent says 1 buttons, the file hides 2 \(1 in 2 places\)/],
    [{ intent: { verb: 'command', action: 'hide', app: 'sbrm_Homeless', table: TABLE, buttons: 2, extra: 1 } }, /intent does not match.*unknown key "extra"/],
  ];
  for (const [over, re] of cases) {
    const errs = errorsOf({ ...job(), ...over });
    assert.ok(errs.some((e) => re.test(e)), `${JSON.stringify(over).slice(0, 90)}: ${errs.join(' | ')}`);
  }
});

// ---------- plan ----------

test('plan: reads only; one step per button and place, each resting on Microsoft\'s own template and its rules', async () => {
  const dv = dvAs();
  const plan = await C.planCommand(dv, valid(job()), ctx());
  assert.deepEqual(nonGets(dv), [], 'a plan only reads');
  assert.equal(plan.action, 'hide');
  assert.equal(plan.need, 'admin');
  assert.deepEqual(plan.model_app, { id: IDS.app, name: 'SBRM Homeless', uniquename: 'sbrm_Homeless' });
  assert.deepEqual(plan.table, { name: TABLE, metadata_id: IDS.table });
  assert.deepEqual(plan.solution, { uniquename: 'SBRMWaitlistCount', id: IDS.solution, name: 'SBRM Waitlist Count', publisher: IDS.publisher });
  const t = tmpl(dv, 'Deactivate', 1);
  assert.deepEqual(plan.steps.map((s) => [s.button, s.where, s.location, s.action, s.row]), [['deactivate', 'list', 1, 'create', null], ['deactivate', 'form', 0, 'create', null]]);
  assert.equal(plan.steps[0].template.id, t.appactionid);
  assert.equal(plan.steps[0].template.name, 'Mscrm.HomepageGrid.{!EntityLogicalName}.Deactivate');
  assert.deepEqual(plan.steps[0].template.rules, [...t._rules].sort());
  assert.deepEqual(plan.steps[0].template.fields, {
    sequence: t.sequence, visibilitytype: 2, webresourceId: IDS.script, functionName: 'XrmCore.Commands.Deactivate.run', parameters: '[{"type":12,"value":null}]',
    label: 'Deactivate', tooltipTitle: 'Deactivate', accessibility: 'Deactivate', tooltipDescription: 'Deactivate these {EntityLogicalNameCollectionMarker}.', fonticon: '$clientsvg:PageBlock',
  });
  assert.deepEqual(C.planShapeProblems(plan), []);
  assert.ok(plan.severity.lasting.length === 1 && /^2 new command rows in the app 'SBRM Homeless'; undo shows the button again but keeps the rows$/.test(plan.severity.lasting[0]), JSON.stringify(plan.severity));
  const s = C.commandSummary(plan);
  assert.match(s, /Hide the Deactivate button for sbrm_waitlistcount in the app 'SBRM Homeless' \(HGS apps\): the list and the form/);
  assert.match(s, /disappears for EVERYONE who uses 'SBRM Homeless', admins included\. A security role does not bring it back/);
  assert.match(s, /Other apps that show sbrm_waitlistcount keep the button/);
  assert.match(s, /New command rows go in solution SBRM Waitlist Count/);
  assert.match(s, /if the button still shows, publish the app in the maker portal/);
  assert.match(s, /Can be undone with revert \(shows the button again; the rows stay\)/);
  assert.match(C.commandDetail(plan, { id: 'p1' }), /new row for Deactivate on the list: template Mscrm\.HomepageGrid\.\{!EntityLogicalName\}\.Deactivate \([0-9a-f-]{36}\), 2 rule\(s\)/);
  // all four places, two buttons
  const all = await C.planCommand(dv, valid(job({ hide: ['deactivate', 'new'], where: null })), ctx());
  assert.equal(all.steps.length, 8);
  assert.match(C.commandSummary(all), /Hide the Deactivate and New buttons for .*: the list, the form, sub grids and associated views/);
});

test('plan: a row an earlier job left showing is flipped, one already hidden is skipped, and nothing to do is refused', async () => {
  const dv = dvAs();
  const shown = override(dv.data, { location: 1, hidden: false });
  override(dv.data, { location: 0, hidden: true });
  override(dv.data, { location: 1, hidden: false, app: IDS.otherApp }); // another app's row is not this app's
  const plan = await C.planCommand(dv, valid(job()), ctx());
  assert.deepEqual(plan.steps.map((s) => [s.where, s.action, s.row]), [['list', 'hide', { id: shown.appactionid }]]);
  assert.deepEqual(plan.already_hidden, ['Deactivate on the form']);
  assert.deepEqual(plan.severity.lasting, [], 'no new row, so nothing lasting');
  assert.match(C.commandSummary(plan), /Already hidden, left as they are: Deactivate on the form\./);
  assert.doesNotMatch(C.commandSummary(plan), /New command rows go in solution/);
  shown.hidden = true;
  await refused(C.planCommand(dv, valid(job()), ctx()), /Deactivate on the list and Deactivate on the form are already hidden for sbrm_waitlistcount in SBRM Homeless; there is nothing to do/, 'nothing_to_do');
});

test('plan: refused below admin, for a missing app, table or solution, a managed solution, and a button that is not Microsoft\'s plain template', async () => {
  await refused(C.planCommand(dvAs('dev@example.org', { userId: IDS.dev }), valid(job()), ctx()), /changes the HGS apps for everyone who uses it, so it takes admin access; Dana Dev has develop/, 'not_permitted');
  const j = (over) => valid(job(over));
  await refused(C.planCommand(dvAs(), j({ app: 'sbrm_Nope', intent: { verb: 'command', action: 'hide', app: 'sbrm_Nope', table: TABLE, buttons: 2 } }), ctx()), /there is no app with the unique name sbrm_Nope in the HGS apps/, 'invalid_job');
  await refused(C.planCommand(dvAs(), j({ table: 'sbrm_nope', intent: { verb: 'command', action: 'hide', app: 'sbrm_Homeless', table: 'sbrm_nope', buttons: 2 } }), ctx()), /there is no table named sbrm_nope/, 'invalid_job');
  await refused(C.planCommand(dvAs(), j({ solution: 'Nope' }), ctx()), /Nope is not an existing unmanaged solution here/, 'invalid_job');
  await refused(C.planCommand(dvAs(), j({ solution: 'MicrosoftThing' }), ctx()), /MicrosoftThing is not an existing unmanaged solution here/, 'invalid_job');
  const breaks = [
    [(t) => { t.ismanaged = false; }, /is not Microsoft's own, live, unhidden definition here/],
    [(t) => { t.hidden = true; }, /is not Microsoft's own, live, unhidden definition here/],
    [(t) => { t.statecode = 1; }, /is not Microsoft's own, live, unhidden definition here/],
    [(t) => { t.onclickeventtype = 1; }, /is not a plain JavaScript button here/],
    [(t) => { t._onclickeventjavascriptwebresourceid_value = null; }, /is not a plain JavaScript button here/],
    [(t) => { t.context = 1; }, /has 0 global definitions here, not one/],
  ];
  for (const [change, re] of breaks) {
    const dv = dvAs();
    change(tmpl(dv, 'Deactivate', 1));
    await refused(C.planCommand(dv, valid(job()), ctx()), re, 'invalid_job');
    assert.deepEqual(nonGets(dv), []);
  }
  // two global definitions, two rows already overriding it, and a managed override
  let dv = dvAs();
  dv.data.appactions.push({ ...tmpl(dv, 'Deactivate', 1), appactionid: 'f1000000-0000-0000-0000-000000000001' });
  await refused(C.planCommand(dv, valid(job()), ctx()), /has 2 global definitions here, not one/, 'invalid_job');
  dv = dvAs();
  override(dv.data, { location: 1, hidden: false });
  override(dv.data, { location: 1, hidden: false });
  await refused(C.planCommand(dv, valid(job()), ctx()), /2 rows already override Deactivate on the list for sbrm_waitlistcount in this app/, 'invalid_job');
  dv = dvAs();
  override(dv.data, { location: 1, hidden: false, ismanaged: true });
  await refused(C.planCommand(dv, valid(job()), ctx()), /is managed or inactive; it is changed in the maker portal/, 'invalid_job');
});

// ---------- apply ----------

test('apply: one new row per button and place in the designer\'s shape, in the solution, rules linked, each read back', async () => {
  const dv = dvAs();
  const plan = await C.planCommand(dv, valid(job()), ctx());
  dv.calls.length = 0;
  const { res, shown, fileGone } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.equal(res.written, 2);
  assert.ok(fileGone);
  const t = tmpl(dv, 'Deactivate', 1);
  const writes = nonGets(dv);
  assert.deepEqual(writes.map((c) => c.verb), ['createCommandHide', 'linkCommandRule', 'linkCommandRule', 'createCommandHide', 'linkCommandRule', 'linkCommandRule']);
  assert.deepEqual(writes[0].args, { name: 'Mscrm.HomepageGrid.{!EntityLogicalName}.Deactivate', location: 1, table: TABLE, entityId: IDS.table, appId: IDS.app, fields: plan.steps[0].template.fields });
  assert.equal(writes[0].solution, 'SBRMWaitlistCount');
  const made = overridesOf(dv);
  assert.equal(made.length, 2);
  assert.deepEqual([...made[0]._rules].sort(), [...t._rules].sort());
  assert.ok(made.every((r) => r.hidden === true && r.contextvalue === TABLE));
  assert.deepEqual(writes.filter((c) => c.verb === 'linkCommandRule').slice(0, 2).map((c) => c.id), [made[0].appactionid, made[0].appactionid]);
  const row = res.entry.rows[0];
  assert.deepEqual([row.name, row.action, row.button, row.where, row.outcome, row.id], ['Deactivate on the list', 'create', 'deactivate', 'list', 'written', made[0].appactionid]);
  assert.deepEqual(row.before, { exists: false });
  assert.deepEqual(row.after, { id: made[0].appactionid, hidden: true, uniquename: made[0].uniquename, rules: [...t._rules].sort() });
  assert.ok(row.notes.some((n) => /Open the app and look: if the button still shows, publish the app/.test(n)));
  assert.equal(res.entry.mode, 'command');
  assert.equal(res.entry.command_table, TABLE);
  assert.match(shown[0].title, /approve hiding this button in the HGS apps/);
  assert.match(shown[0].summaryText, /disappears for EVERYONE/);
  // the templates themselves are untouched
  assert.ok(dv.data.appactions.filter((r) => r.context === 0).every((r) => r.hidden === false && r._v === 1));
});

test('apply: a row left showing is flipped with its version tag; a create whose id does not come back is found by what it is', async () => {
  let dv = dvAs();
  const shown = override(dv.data, { location: 1, hidden: false });
  const plan = await C.planCommand(dv, valid(job({ where: ['list'] })), ctx());
  dv.calls.length = 0;
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.deepEqual(nonGets(dv).map((c) => [c.verb, c.id, c.hidden, c.etag]), [['setCommandHidden', shown.appactionid, true, 'W/"1"']]);
  assert.equal(shown.hidden, true);
  assert.deepEqual(res.entry.rows[0].before, { hidden: false });

  dv = dvAs();
  const p2 = await C.planCommand(dv, valid(job({ where: ['list'] })), ctx());
  dv.createReturnsNoId = true;
  const r2 = await applied(p2, dv);
  assert.equal(r2.res.outcome, 'applied', JSON.stringify(r2.res.rows));
  assert.equal(r2.res.entry.rows[0].id, overridesOf(dv)[0].appactionid);
});

test('apply: the read-back catches a row that is not hidden or lost its rules; a failure stops the rest and says what was made', async () => {
  let dv = dvAs();
  let plan = await C.planCommand(dv, valid(job({ where: ['list'] })), ctx());
  dv.ignoreHidden = true;
  let { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.entry.rows[0].outcome, /read-back mismatch: the row does not read hidden/);

  dv = dvAs();
  plan = await C.planCommand(dv, valid(job({ where: ['list'] })), ctx());
  dv.dropRules = true;
  ({ res } = await applied(plan, dv));
  assert.match(res.entry.rows[0].outcome, /read-back mismatch: the row carries 0 of the button's 2 rules/);

  // the first row's second rule link fails: that row is logged with what it holds, the second button is not attempted
  dv = dvAs();
  plan = await C.planCommand(dv, valid(job()), ctx());
  let n = 0;
  const link = dv.linkCommandRule;
  dv.linkCommandRule = (id, ruleId) => { n += 1; if (n === 2) dv.failOn = 'linkCommandRule'; return link(id, ruleId); };
  ({ res } = await applied(plan, dv));
  assert.equal(res.outcome, 'applied with problems');
  assert.equal(res.written, 0);
  const [a, b] = res.entry.rows;
  assert.match(a.outcome, /^failed: linkCommandRule failed \(the new row [0-9a-f-]{36} was made, 1 of 2 rules linked; revert shows the button again\)/);
  assert.equal(a.after.hidden, true);
  assert.equal(a.after.rules.length, 1);
  assert.match(b.outcome, /^not attempted: an earlier button failed \(Deactivate on the list\)/);
  assert.equal(nonGets(dv).filter((c) => c.verb === 'createCommandHide').length, 1);

  // the create itself fails: nothing was made
  dv = dvAs();
  plan = await C.planCommand(dv, valid(job({ where: ['list'] })), ctx());
  dv.failOn = 'createCommandHide';
  ({ res } = await applied(plan, dv));
  assert.match(res.entry.rows[0].outcome, /^failed: createCommandHide failed$/);
  assert.equal(res.entry.rows[0].after, null);
  assert.equal(overridesOf(dv).length, 0);
});

test('apply: refused when anything moved since the plan or while the approval waited; on tamper, staleness, another person; cancelled writes nothing', async () => {
  const fresh = async (over) => { const dv = dvAs(); return { dv, plan: await C.planCommand(dv, valid(job(over)), ctx()) }; };
  // since the plan: a template changed, a row appeared, the solution went
  let { dv, plan } = await fresh();
  tmpl(dv, 'Deactivate', 1).sequence += 1;
  await applyRefused(applied(plan, dv), /the buttons or the rows that override them changed since the plan/, 'snapshot_moved');
  ({ dv, plan } = await fresh());
  override(dv.data, { location: 1, hidden: false });
  await applyRefused(applied(plan, dv), /changed since the plan/, 'snapshot_moved');
  ({ dv, plan } = await fresh());
  tmpl(dv, 'Deactivate', 0)._rules.push('f2000000-0000-0000-0000-000000000001');
  await applyRefused(applied(plan, dv), /changed since the plan/, 'snapshot_moved');
  ({ dv, plan } = await fresh());
  dv.data.solutions[0].ismanaged = true;
  await applyRefused(applied(plan, dv), /the solution SBRMWaitlistCount changed since the plan/, 'snapshot_moved');
  ({ dv, plan } = await fresh());
  tmpl(dv, 'Deactivate', 1).hidden = true;
  await applyRefused(applied(plan, dv), /is not Microsoft's own, live, unhidden definition here; it is changed in the maker portal \(changed since the plan\)/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
  // while the approval waited
  ({ dv, plan } = await fresh());
  const d1 = dv;
  await applyRefused(applied(plan, dv, { confirm: () => { override(d1.data, { location: 0, hidden: true }); return { approved: true }; } }), /changed while the approval was waiting/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
  ({ dv, plan } = await fresh());
  const d2 = dv;
  await applyRefused(applied(plan, dv, { confirm: () => { d2.data.solutions[0].solutionid = IDS.managedSolution; return { approved: true }; } }), /the solution SBRMWaitlistCount changed while the approval was waiting/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);

  ({ dv, plan } = await fresh());
  const file = path.join(HOME, 'y.json');
  fs.writeFileSync(file, '{}');
  const deps = { access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }) };
  const now = { ...plan, created: new Date().toISOString() };
  await applyRefused(C.applyCommand({ ...now, created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, deps, { id: 'p', file, fs }), /more than 24 hours old/, 'stale_plan');
  const s0 = plan.steps[0];
  const tamper = [
    { mode: 'component' }, { action: 'delete' }, { steps: [] }, { model_app: { id: 'x' } },
    { table: { name: 'contact', metadata_id: IDS.table } },                                  // not one of SBRM's own tables
    { table: { name: TABLE, metadata_id: 'x' } }, { solution: { uniquename: 'bad name', id: IDS.solution } },
    { steps: [{ ...s0, button: 'delete' }] }, { steps: [{ ...s0, where: 'everywhere' }] },
    { steps: [{ ...s0, location: 3 }] },                                                      // the place and its number disagree
    { steps: [{ ...s0, template: { ...s0.template, name: 'Mscrm.HomepageGrid.{!EntityLogicalName}.Delete' } }] }, // another button's template
    { steps: [{ ...s0, template: { ...s0.template, id: 'x' } }] },
    { steps: [{ ...s0, template: { ...s0.template, rules: ['x'] } }] },
    { steps: [{ ...s0, template: { ...s0.template, fields: { ...s0.template.fields, webresourceId: 'x' } } }] },
    { steps: [{ ...s0, row: { id: IDS.app } }] },                                             // a create that names a row
    { steps: [{ ...s0, action: 'hide' }] },                                                   // a flip with no row
  ];
  for (const bad of tamper) {
    await applyRefused(C.applyCommand({ ...now, ...bad }, deps, { id: 'p', file, fs }), /no command-bar plan writes/, 'plan_tampered');
  }
  // a step edited to carry another template's fields is caught by the live re-read
  await applyRefused(C.applyCommand({ ...now, steps: [{ ...s0, template: { ...s0.template, fields: { ...s0.template.fields, functionName: 'Evil.run' } } }, plan.steps[1]] }, deps, { id: 'p', file, fs }), /changed since the plan/, 'snapshot_moved');
  const other = fakeCommandDv({ email: 'dev@example.org', userId: IDS.dev });
  await applyRefused(C.applyCommand(now, { ...deps, connect: () => other }, { id: 'p', file, fs }), /you are signed in as Dana Dev/, 'different_person');
  await applyRefused(C.applyCommand(now, { ...deps, access: { people: { 'admin@example.org': { envs: { hgs: 'develop' } } } } }, { id: 'p', file, fs }), /takes admin access; you have develop/, 'access_revoked');
  assert.deepEqual(nonGets(dv), []);
  const { res } = await applied(plan, dv, { confirm: () => ({ approved: false }) });
  assert.equal(res.outcome, 'cancelled');
  assert.deepEqual(nonGets(dv), []);
});

// ---------- revert ----------

test('revert: shows every button the hide left hidden, version-tagged, read back; the rows stay; a show is not undone here', async () => {
  const dv = dvAs();
  const { res } = await applied(await C.planCommand(dv, valid(job()), ctx()), dv);
  const made = overridesOf(dv);
  dv.calls.length = 0;
  const undo = await C.planCommandRevert(dv, entryFrom(res), ctx());
  assert.deepEqual(nonGets(dv), [], 'planning the undo only reads');
  assert.equal(undo.action, 'show');
  assert.equal(undo.reverts_plan_id, res.entry.plan_id);
  assert.deepEqual(undo.steps.map((s) => [s.button, s.where, s.row.id]), [['deactivate', 'list', made[0].appactionid], ['deactivate', 'form', made[1].appactionid]]);
  assert.deepEqual(C.planShapeProblems(undo), []);
  const s = C.commandSummary(undo);
  assert.match(s, /Show the Deactivate button for sbrm_waitlistcount in the app 'SBRM Homeless' \(HGS apps\): the list and the form/);
  assert.match(s, /comes back for everyone who uses this app, with the visibility rules its row carries/);
  assert.doesNotMatch(s, /stopped part-way/);
  assert.match(s, /Not undone by revert: hide it again with a new job/);
  const back = await applied(undo, dv);
  assert.equal(back.res.outcome, 'applied', JSON.stringify(back.res.rows));
  assert.deepEqual(nonGets(dv).map((c) => [c.verb, c.id, c.hidden, c.etag]), [['setCommandHidden', made[0].appactionid, false, 'W/"1"'], ['setCommandHidden', made[1].appactionid, false, 'W/"1"']]);
  assert.equal(overridesOf(dv).length, 2, 'the rows stay');
  assert.ok(overridesOf(dv).every((r) => r.hidden === false && r._rules.length === 2));
  assert.match(back.shown[0].title, /approve showing this button again/);
  await refused(C.planCommandRevert(dv, entryFrom(back.res), ctx()), /showing a button again is not undone here/, 'nothing_to_undo');
  // hiding again finds the rows and flips them: no second row is made
  const again = await C.planCommand(dv, valid(job()), ctx());
  assert.deepEqual(again.steps.map((x) => x.action), ['hide', 'hide']);
});

test('revert: a hide that failed part-way still shows what it made; refused when a row moved, on a forged entry, another environment, below admin', async () => {
  let dv = dvAs();
  let plan = await C.planCommand(dv, valid(job()), ctx());
  let n = 0;
  const link = dv.linkCommandRule;
  dv.linkCommandRule = (id, ruleId) => { n += 1; if (n === 2) dv.failOn = 'linkCommandRule'; return link(id, ruleId); };
  let { res } = await applied(plan, dv);
  const undo = await C.planCommandRevert(dv, entryFrom(res), ctx());
  assert.deepEqual(undo.steps.map((s) => s.where), ['list'], 'only the row that was made');

  dv = dvAs();
  ({ res } = await applied(await C.planCommand(dv, valid(job({ where: ['list'] })), ctx()), dv));
  const base = entryFrom(res);
  const row = overridesOf(dv)[0];
  row.hidden = false;
  await refused(C.planCommandRevert(dv, base, ctx()), /Deactivate on the list is already showing/, 'nothing_to_undo');
  row.hidden = true;
  row._appmoduleid_value = IDS.otherApp;
  await refused(C.planCommandRevert(dv, base, ctx()), /changed since plan .*: it is not this table's row in this app/, 'snapshot_moved');
  row._appmoduleid_value = IDS.app;
  row.ismanaged = true;
  await refused(C.planCommandRevert(dv, base, ctx()), /it is managed or inactive/, 'snapshot_moved');
  row.ismanaged = false;
  const withEntry = (change) => { const e = JSON.parse(JSON.stringify(base)); change(e); return e; };
  const cases = [
    [(e) => { e.mode = 'component'; }, /not a command-bar change/, 'nothing_to_undo'],
    [(e) => { e.outcome = 'cancelled'; }, /there is nothing to undo/, 'nothing_to_undo'],
    [(e) => { e.env = 'nowhere'; }, /an environment the toolkit does not know/, 'invalid_job'],
    [(e) => { e.env = 'recovery'; }, /was made in the Recovery app/, 'invalid_job'],
    [(e) => { e.model_app.id = 'x'; }, /no valid app, table or action/, 'invalid_job'],
    [(e) => { e.command_table = 'contact'; }, /no valid app, table or action/, 'invalid_job'],
    [(e) => { e.action = 'delete'; }, /no valid app, table or action/, 'invalid_job'],
    [(e) => { e.rows[0].after.id = 'x'; }, /hid nothing/, 'nothing_to_undo'],
    [(e) => { e.rows[0].after.hidden = false; }, /hid nothing/, 'nothing_to_undo'],
    [(e) => { e.rows[0].button = 'delete'; }, /a button or place this kind does not know/, 'invalid_job'],
    // a forged id that points at Microsoft's own template is refused: it is not this table's row
    [(e) => { e.rows[0].after.id = tmpl(dv, 'Deactivate', 1).appactionid; }, /it is managed or inactive/, 'snapshot_moved'],
    [(e) => { e.rows[0].after.id = 'f3000000-0000-0000-0000-000000000001'; }, /it is gone/, 'nothing_to_undo'],
  ];
  for (const [change, re, code] of cases) await refused(C.planCommandRevert(dv, withEntry(change), ctx()), re, code);
  await refused(C.planCommandRevert(dvAs('dev@example.org', { userId: IDS.dev }), base, ctx()), /takes admin access/, 'not_permitted');
  // a row that moved while the undo's approval waited
  const good = await C.planCommandRevert(dv, base, ctx());
  dv.calls.length = 0;
  await applyRefused(applied(good, dv, { confirm: () => { row.hidden = false; return { approved: true }; } }), /Something changed while the approval was waiting: Deactivate on the list is already showing/, 'nothing_to_undo');
  assert.deepEqual(nonGets(dv), []);
  // a show plan with no logged hide behind it is not one a plan makes
  const file = path.join(HOME, 'z.json');
  fs.writeFileSync(file, '{}');
  await applyRefused(C.applyCommand({ ...good, reverts_plan_id: null, created: new Date().toISOString() }, { access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }) }, { id: 'p', file, fs }), /no command-bar plan writes/, 'plan_tampered');
});

// ---------- the write calls, the log, the dispatcher ----------

test('commandCall: three fixed paths; the body is the designer\'s shape built from checked values', () => {
  const { commandCall } = require('../lib/write');
  const fields = { sequence: 100100001, visibilitytype: 2, webresourceId: IDS.script, functionName: 'XrmCore.Commands.Deactivate.deactivateRecords', parameters: '[{"type":12,"value":null}]',
    label: 'Deactivate', tooltipTitle: 'Deactivate', accessibility: 'Deactivate', tooltipDescription: 'Deactivate these.', fonticon: '$clientsvg:PageBlock' };
  const args = { name: 'Mscrm.HomepageGrid.{!EntityLogicalName}.Deactivate', location: 1, table: TABLE, entityId: IDS.table, appId: IDS.app, fields };
  assert.deepEqual(commandCall('hide', args), {
    method: 'POST', path: 'appactions', headers: ['Prefer: return=representation'],
    body: {
      name: 'Mscrm.HomepageGrid.{!EntityLogicalName}.Deactivate', type: 0, location: 1, context: 1, contextvalue: TABLE, hidden: true, uniquename: '', origin: 2, sequence: 100100001,
      'ContextEntity@odata.bind': `/entities(${IDS.table})`, 'AppModuleId@odata.bind': `/appmodules(${IDS.app})`, onclickeventtype: 2,
      'OnClickEventJavaScriptWebResourceId@odata.bind': `/webresourceset(${IDS.script})`, onclickeventjavascriptfunctionname: 'XrmCore.Commands.Deactivate.deactivateRecords', visibilitytype: 2,
      buttonlabeltext: 'Deactivate', buttontooltiptitle: 'Deactivate', buttonaccessibilitytext: 'Deactivate', buttontooltipdescription: 'Deactivate these.', fonticon: '$clientsvg:PageBlock',
      onclickeventjavascriptparameters: '[{"type":12,"value":null}]',
    },
  });
  // texts the template does not carry are left out, never sent empty
  const bare = commandCall('hide', { ...args, fields: { sequence: 1, visibilitytype: 0, webresourceId: IDS.script, functionName: 'A.b', label: null } }).body;
  assert.ok(!('buttonlabeltext' in bare) && !('fonticon' in bare) && !('onclickeventjavascriptparameters' in bare));
  const bad = [
    [{ name: 'Mscrm.HomepageGrid.{!EntityLogicalName}.Delete' }, /not one of the built-in Deactivate, Activate or New buttons/],
    [{ name: 'Mscrm.HomepageGrid.sbrm_waitlistcount.Deactivate' }, /not one of the built-in/],
    [{ name: 'NewCommand!abc' }, /not one of the built-in/],
    [{ location: 4 }, /the place must be the form, the main grid/],
    [{ location: '1' }, /the place must be/],
    [{ table: 'contact' }, /the table must be one of SBRM's own/],
    [{ table: "sbrm_x' or 1 eq 1" }, /the table must be one of SBRM's own/],
    [{ entityId: 'x' }, /the table is not a GUID/],
    [{ appId: 'x' }, /the app is not a GUID/],
    [{ fields: { ...fields, webresourceId: 'x' } }, /the button's script is not a GUID/],
    [{ fields: { ...fields, sequence: '1' } }, /the button's position is not a number/],
    [{ fields: { ...fields, functionName: 'alert(1)' } }, /the button's action is not a function name/],
    [{ fields: { ...fields, visibilitytype: 9 } }, /unknown visibility type/],
    [{ fields: { ...fields, label: 'x'.repeat(201) } }, /the label must be text, at most 200 characters/],
    [{ fields: { ...fields, parameters: { a: 1 } } }, /the action's parameters must be text/],
  ];
  for (const [over, re] of bad) assert.throws(() => commandCall('hide', { ...args, ...over }), re, JSON.stringify(over).slice(0, 80));
  const row = 'c1000000-0000-0000-0000-000000000001';
  const rule = 'c2000000-0000-0000-0000-000000000002';
  assert.deepEqual(commandCall('linkRule', { id: row, ruleId: rule }, 'https://hgs.invalid'), {
    method: 'POST', path: `appactions(${row})/appaction_appactionrule_classicrules/$ref`, body: { '@odata.id': `https://hgs.invalid/api/data/v9.2/appactionrules(${rule})` }, headers: [],
  });
  assert.throws(() => commandCall('linkRule', { id: 'appactions', ruleId: rule }, 'https://hgs.invalid'), /the button row is not a GUID/);
  assert.throws(() => commandCall('linkRule', { id: row, ruleId: 'x' }, 'https://hgs.invalid'), /the rule is not a GUID/);
  assert.throws(() => commandCall('linkRule', { id: row, ruleId: rule }, 'https://hgs.invalid/api?x=1'), /not a bare https address/);
  assert.deepEqual(commandCall('setHidden', { id: row, hidden: false, etag: 'W/"3"' }), { method: 'PATCH', path: `appactions(${row})`, body: { hidden: false }, headers: ['If-Match: W/"3"'] });
  assert.throws(() => commandCall('setHidden', { id: row, hidden: 'false', etag: 'W/"3"' }), /hidden must be true or false/);
  assert.throws(() => commandCall('setHidden', { id: row, hidden: true }), /version tag/);
  assert.throws(() => commandCall('setHidden', { id: 'x', hidden: true, etag: 'W/"3"' }), /the button row is not a GUID/);
  assert.throws(() => commandCall('delete', { id: row }), /refusing command verb delete/);
});

test('the log keeps what the undo reads when an entry is too big for one row; the prompt and the dispatcher know the kind', async () => {
  const { fitForRow, ENTRY_MAX } = require('../lib/log');
  const dv = dvAs();
  const { res } = await applied(await C.planCommand(dv, valid(job({ where: ['list'] })), ctx()), dv);
  const entry = entryFrom(res);
  entry.rows[0].changes[0].new_text = 'x'.repeat(ENTRY_MAX + 1000);
  const text = fitForRow(entry);
  assert.ok(text.length <= ENTRY_MAX);
  const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);
  assert.equal(json.log_trimmed, 'bodies');
  assert.deepEqual(Object.keys(json.rows[0]).sort(), ['action', 'after', 'before', 'button', 'id', 'name', 'outcome', 'where']);
  const undo = await C.planCommandRevert(dv, json, ctx());
  assert.deepEqual(undo.steps.map((s) => [s.button, s.where]), [['deactivate', 'list']]);

  const { approvalText } = require('../../guard/guard');
  const store = require('../lib/store');
  const put = (id, rec) => fs.writeFileSync(path.join(store.dir('plans'), `${id}.json`), JSON.stringify(rec));
  const plan = await C.planCommand(dvAs(), valid(job({ hide: ['deactivate', 'new'] })), ctx());
  put('20261123-170001-aaaaaaa1', { ...plan, severity: { lines: [] } });
  assert.equal(approvalText({ verb: 'apply', keys: ['20261123-170001-aaaaaaa1'] }),
    "Hide Deactivate, New for sbrm_waitlistcount in the app 'SBRM Homeless' (HGS apps) on the list, the form, for everyone who uses that app");
  put('20261123-170002-aaaaaaa2', { ...undo, severity: { lines: [] } });
  assert.equal(approvalText({ verb: 'apply', keys: ['20261123-170002-aaaaaaa2'] }),
    "Show Deactivate for sbrm_waitlistcount in the app 'SBRM Homeless' (HGS apps) on the list, for everyone who uses that app (an undo)");
  // the rows kind still refuses the table itself, and now says which kind to use
  const R = require('../lib/resolve');
  assert.equal(typeof R.PlanRefused, 'function');
});
