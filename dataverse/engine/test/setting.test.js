'use strict';
// App settings (kind "setting", 1.11.12, Dylan 10/18/26: "Lets build that into the toolkit"): change the
// current value of an environment variable, on a fake Dataverse (test/fake_setting.js). The case that asked
// for it: HGS sbrm_SharePointDocumentsEnable, set to "no" by a 12/4/2024 solution import, which silently
// stopped the guest "Create Documents folder" button for ~22 months. The module is called directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Never touch the real store (CLAUDE.md trap), even though this file only plans and applies in-process.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-setting-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const S = require('../lib/setting');
const { fakeSettingDv, IDS, ENVS, ACCESS } = require('./fake_setting');

const userOf = { admin: 'admin@example.org', dev: 'dev@example.org', writer: 'writer@example.org', reader: 'nobody@example.org' };
const dvAs = (who = 'admin', over = {}) => fakeSettingDv({ email: userOf[who], ...over });
const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, ...over });

function job(over = {}) {
  const setting = over.setting || 'sbrm_SharePointDocumentsEnable';
  const value = over.value === undefined ? 'yes' : over.value;
  return {
    contract: 'sbrm-dv-job/1', kind: 'setting', env: 'hgs', setting, value, source: 'claude-session',
    reason: 'Turn the HGS documents switch back on.', intent: { verb: 'set', setting, value }, ...over,
  };
}

function valid(raw) {
  const r = S.validateSettingJob(raw, { envs: ENVS });
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

async function applyRefused(promise, re, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'ApplyRefused', e.stack);
    assert.match(e.message, re);
    if (code) assert.equal(e.code, code);
    return true;
  });
}

const nonGets = (dv) => dv.calls.filter((c) => c.method !== 'GET');
const valueOf = (dv, id) => dv.data.environmentvariablevalues.find((r) => r.environmentvariablevalueid === id).value;

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await S.applySetting({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, ...over,
  }, { id: `20261018-1200${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown, fileGone: !fs.existsSync(file) };
}

// ---------- the job file ----------

test('validate: a good job passes; typos, missing pieces and intent mismatch are refused', () => {
  const j = valid(job());
  assert.equal(j.kind, 'setting');
  assert.equal(j.setting, 'sbrm_SharePointDocumentsEnable');
  assert.equal(j.value, 'yes');
  const cases = [
    [{ colour: 'red' }, /unknown top-level key "colour"/],
    [{ contract: 'x' }, /"contract" must be exactly/],
    [{ kind: 'component' }, /"kind" must be "setting"/],
    [{ env: 'nowhere' }, /"env" must be one of/],
    [{ setting: "x' or 1 eq 1", intent: { verb: 'set', setting: "x' or 1 eq 1", value: 'yes' } }, /"setting" must be the setting's schema name/],
    [{ setting: '' }, /"setting" must be the setting's schema name/],
    [{ value: 1, intent: { verb: 'set', setting: 'sbrm_SharePointDocumentsEnable', value: 1 } }, /"value" must be text/],
    [{ value: null, intent: { verb: 'set', setting: 'sbrm_SharePointDocumentsEnable', value: null } }, /"value" must be text/],
    [{ value: 'x'.repeat(2001), intent: { verb: 'set', setting: 'sbrm_SharePointDocumentsEnable', value: 'x'.repeat(2001) } }, /at most 2000 characters/],
    [{ source: '' }, /"source" is required/],
    [{ reason: 'two\nlines' }, /"reason" must be one line/],
    [{ intent: undefined }, /"intent" is required/],
    [{ intent: { verb: 'set', setting: 'sbrm_SharePointDocumentsEnable', value: 'no' } }, /intent does not match the job.*value says "no", the file sets "yes"/],
    [{ intent: { verb: 'set', setting: 'sbrm_Other', value: 'yes' } }, /intent does not match the job.*setting says "sbrm_Other"/],
    [{ intent: { verb: 'clear', setting: 'sbrm_SharePointDocumentsEnable', value: 'yes' } }, /intent does not match the job.*verb says "clear"/],
    [{ intent: { verb: 'set', setting: 'sbrm_SharePointDocumentsEnable', value: 'yes', extra: 1 } }, /unknown key "extra"/],
  ];
  for (const [over, re] of cases) {
    const r = S.validateSettingJob({ ...job(), ...over }, { envs: ENVS });
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(over).slice(0, 80)}: ${r.errors.join(' | ')}`);
  }
});

// ---------- plan ----------

test('plan: reads only; shows before -> after, the flows that read the setting, and the solutions carrying its value', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job()), ctx());
  assert.deepEqual(nonGets(dv), []);
  assert.equal(plan.kind, 'setting');
  assert.equal(plan.need, 'admin');
  assert.equal(plan.setting.value_id, IDS.docsVal);
  assert.equal(plan.setting.definition_id, IDS.docsDef);
  assert.equal(plan.setting.type_name, 'Yes/No');
  assert.equal(plan.before.value, 'no');
  assert.equal(plan.after.value, 'yes');
  assert.deepEqual(plan.flows.map((f) => [f.name, f.on]), [['Guest > Integrate Documents', true]]);
  assert.deepEqual(plan.solutions.map((s) => s.uniquename).sort(), ['CMUpdates202411', 'airSlateForms']);
  const text = S.settingSummary(plan);
  assert.match(text, /Set 'SharePoint Documents - Enable' \(sbrm_SharePointDocumentsEnable\) in the HGS App: no -> yes/);
  assert.match(text, /Flows that read it: Guest > Integrate Documents \(on\)/);
  assert.match(text, /airSlateForms, CMUpdates202411/);
  assert.match(text, /importing one of them again can set it back/);
  // A live flow reads it, so the change is not fully undoable: the flow acts on the new value at once.
  assert.ok(plan.severity.irreversible.some((x) => /Guest > Integrate Documents/.test(x)), JSON.stringify(plan.severity));
  assert.match(S.settingDetail(plan, { id: 'x' }), /Value row: 338b0829-f5e1-ec11-bb3d-000d3a31a448/);
});

test('plan: a setting no flow reads carries no warning, and says canvas apps and plug-ins were not checked', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job({ setting: 'sbrm_SiteUrl', value: 'https://example.invalid/sites/b' })), ctx());
  assert.deepEqual(plan.flows, []);
  assert.deepEqual(plan.severity.lines, []);
  assert.match(S.settingSummary(plan), /No cloud flow names it \(canvas apps and plug-ins are not checked\)/);
});

test('plan: a flow that is off and reads it is named, but warns nothing (it acts on nothing until turned on)', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job({ setting: 'sbrm_NotificationsEnable', value: 'no' })), ctx());
  assert.deepEqual(plan.flows.map((f) => [f.name, f.on]), [['Old Notifications', false]]);
  assert.deepEqual(plan.severity.irreversible, []);
});

test('plan: admin only; develop, write and read are refused', async () => {
  for (const who of ['dev', 'writer', 'reader']) {
    await refused(S.planSetting(dvAs(who), valid(job()), ctx()), /changing an app setting takes admin access in the HGS App/, who === 'reader' ? 'access_read' : 'not_permitted');
  }
});

test('plan: an unknown setting, a secret, a data source, a missing value row, a managed value row or two value rows are refused', async () => {
  const cases = [
    [{ setting: 'sbrm_Nope', value: 'x' }, /there is no setting "sbrm_Nope" in the HGS App/, 'invalid_job'],
    [{ setting: 'sbrm_ApiKey', value: 'x' }, /'API Key' is a Secret setting.*maker portal/, 'not_permitted'],
    [{ setting: 'sbrm_DocsLibrary', value: 'x' }, /'Documents Library' is a Data source setting.*maker portal/, 'not_permitted'],
    [{ setting: 'sbrm_EmailEnable', value: 'yes' }, /'Email - Enable' has no current value \(it uses its default, "no"\).*maker portal/, 'invalid_job'],
    [{ setting: 'msdyn_SLAWebClientDeprecationAcknowledge', value: '1' }, /current value of 'SLA Acknowledge' is managed/, 'not_permitted'],
    [{ setting: 'sbrm_Twice', value: 'c' }, /'Twice' has 2 current values/, 'invalid_job'],
  ];
  for (const [over, re, code] of cases) {
    const j = job({ ...over, intent: { verb: 'set', setting: over.setting, value: over.value } });
    await refused(S.planSetting(dvAs('admin'), valid(j), ctx()), re, code);
  }
});

test('plan: the value must fit the setting\'s type', async () => {
  const bad = [
    ['sbrm_SharePointDocumentsEnable', 'true', /a Yes\/No setting takes "yes" or "no"/],
    ['sbrm_SharePointDocumentsEnable', 'Yes', /a Yes\/No setting takes "yes" or "no"/],
    ['sbrm_BatchSize', 'ten', /a Number setting takes a number/],
    ['sbrm_BatchSize', '', /a Number setting takes a number/],
    ['sbrm_RoutingRules', '{a:1}', /a JSON setting takes valid JSON/],
  ];
  for (const [setting, value, re] of bad) {
    await refused(S.planSetting(dvAs('admin'), valid(job({ setting, value, intent: { verb: 'set', setting, value } })), ctx()), re, 'invalid_job');
  }
  for (const [setting, value] of [['sbrm_BatchSize', '40'], ['sbrm_BatchSize', '-2.5'], ['sbrm_RoutingRules', '{"a":2}'], ['sbrm_SiteUrl', '']]) {
    const plan = await S.planSetting(dvAs('admin'), valid(job({ setting, value, intent: { verb: 'set', setting, value } })), ctx());
    assert.equal(plan.after.value, value);
  }
});

test('plan: the value it already has is refused (nothing to change)', async () => {
  await refused(S.planSetting(dvAs('admin'), valid(job({ value: 'no', intent: { verb: 'set', setting: 'sbrm_SharePointDocumentsEnable', value: 'no' } })), ctx()), /already "no"/, 'every_row_refused');
});

// ---------- apply ----------

test('apply: one version-tagged PATCH of the value, read back, logged with before and after', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job()), ctx());
  const { res, shown, fileGone } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.equal(valueOf(dv, IDS.docsVal), 'yes');
  const writes = nonGets(dv);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].path, `environmentvariablevalues(${IDS.docsVal})`);
  assert.deepEqual(writes[0].body, { value: 'yes' });
  assert.match(writes[0].etag, /^W\/"/);
  assert.equal(shown.length, 1);
  assert.match(shown[0].summaryText, /no -> yes/);
  assert.match(shown[0].title, /approve this setting change in the HGS App/);
  assert.ok(fileGone);
  const e = res.entry;
  assert.equal(e.mode, 'setting');
  assert.equal(e.action, 'set');
  assert.equal(e.table, 'environmentvariablevalues');
  assert.equal(e.outcome, 'applied');
  assert.equal(e.rows[0].id, IDS.docsVal);
  assert.equal(e.rows[0].name, 'sbrm_SharePointDocumentsEnable');
  assert.deepEqual(e.rows[0].before, { value: 'no' });
  assert.deepEqual(e.rows[0].after, { value: 'yes' });
  assert.deepEqual(e.rows[0].changes, [{ label: 'value', old_text: 'no', new_text: 'yes' }]);
});

test('apply: cancelled writes nothing and keeps the plan', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job()), ctx());
  const { res, fileGone } = await applied(plan, dv, { confirm: () => ({ approved: false }) });
  assert.equal(res.outcome, 'cancelled');
  assert.deepEqual(nonGets(dv), []);
  assert.equal(valueOf(dv, IDS.docsVal), 'no');
  assert.ok(!fileGone);
});

test('apply: a value changed since the plan is refused, nothing written', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job()), ctx());
  dv.touch('environmentvariablevalues', IDS.docsVal, { value: 'yes' });
  await applyRefused(applied(plan, dv), /has changed since the plan \(now "yes", the plan read "no"\)/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: the setting\'s type changed since the plan is refused', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job()), ctx());
  dv.touch('environmentvariabledefinitions', IDS.docsDef, { type: 100000000 });
  await applyRefused(applied(plan, dv), /changed since the plan/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: another person, or access lowered since the plan, is refused', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job()), ctx());
  await applyRefused(applied(plan, dvAs('dev', { d: dv.data, userId: '12121212-1212-1212-1212-121212121212', fullname: 'Dana Martin' })), /this plan was made by Test Admin/, 'different_person');
  await applyRefused(applied(plan, dv, { access: { people: { 'admin@example.org': { envs: { hgs: 'develop' } } } } }), /takes admin access/, 'access_revoked');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: a flow that reads it turned on since the plan makes the change more serious, so it is refused', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job({ setting: 'sbrm_NotificationsEnable', value: 'no' })), ctx());
  assert.deepEqual(plan.severity.irreversible, []);
  dv.touch('workflows', IDS.offFlow, { statecode: 1 });
  await applyRefused(applied(plan, dv), /more serious than when it was planned/, 'severity_grew');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: a plan file edited to write something else is refused', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job()), ctx());
  const tampered = [
    { setting: { ...plan.setting, value_id: 'not-a-guid' } },
    { after: { value: 'x'.repeat(2001) } },
    { after: { value: 42 } },
    { mode: 'delete' },
  ];
  for (const over of tampered) {
    await applyRefused(applied({ ...plan, ...over }, dv), /changed after it was made/, 'plan_tampered');
  }
  // The value is checked against the LIVE type again, so a hand-edited value of the wrong type cannot pass.
  await applyRefused(applied({ ...plan, after: { value: 'maybe' } }, dv), /a Yes\/No setting takes "yes" or "no"/, 'invalid_job');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: a value the platform did not keep is "applied with problems"', async () => {
  const dv = dvAs('admin');
  dv.readBackDrops = true;
  const plan = await S.planSetting(dv, valid(job()), ctx());
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /read-back mismatch: the value reads "no", not "yes"/);
});

test('apply: a plan more than 24 hours old is refused', async () => {
  const dv = dvAs('admin');
  const plan = await S.planSetting(dv, valid(job()), ctx());
  await assert.rejects(S.applySetting({ ...plan, created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }),
  }, { id: 'x', file: path.join(HOME, 'nofile.json'), fs }), /more than 24 hours old/);
});

// ---------- revert ----------

async function appliedEntry(dv, plan) {
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  return JSON.parse(JSON.stringify({ ...res.entry, plan_id: '20261018-120000-abcdef01' })); // as read back from the Write Log
}

test('revert: sets the logged value back, only while the setting still holds what was written', async () => {
  const dv = dvAs('admin');
  const entry = await appliedEntry(dv, await S.planSetting(dv, valid(job()), ctx()));
  const rp = await S.planSettingRevert(dv, entry, ctx());
  assert.equal(rp.before.value, 'yes');
  assert.equal(rp.after.value, 'no');
  assert.equal(rp.reverts_plan_id, '20261018-120000-abcdef01');
  assert.match(S.settingSummary(rp), /yes -> no/);
  const { res } = await applied(rp, dv);
  assert.equal(res.outcome, 'applied');
  assert.equal(valueOf(dv, IDS.docsVal), 'no');
  assert.equal(res.entry.reverts_plan_id, '20261018-120000-abcdef01');

  const moved = dvAs('admin');
  const e2 = await appliedEntry(moved, await S.planSetting(moved, valid(job()), ctx()));
  moved.touch('environmentvariablevalues', IDS.docsVal, { value: 'no' });
  await refused(S.planSettingRevert(moved, e2, ctx()), /changed since plan .* a revert would overwrite someone's later change/, 'snapshot_moved');
});

test('revert: refuses an entry of another kind, a cancelled one, a damaged one, or one from another environment', async () => {
  const dv = dvAs('admin');
  const entry = await appliedEntry(dv, await S.planSetting(dv, valid(job()), ctx()));
  await refused(S.planSettingRevert(dv, { ...entry, mode: 'component' }, ctx()), /not an app setting change/, 'nothing_to_undo');
  await refused(S.planSettingRevert(dv, { ...entry, outcome: 'cancelled' }, ctx()), /nothing to undo/, 'nothing_to_undo');
  await refused(S.planSettingRevert(dv, { ...entry, rows: [{ ...entry.rows[0], outcome: 'failed: x' }] }, ctx()), /did not land/, 'nothing_to_undo');
  await refused(S.planSettingRevert(dv, { ...entry, rows: [{ ...entry.rows[0], name: "x' or 1 eq 1" }] }, ctx()), /no valid setting name/, 'invalid_job');
  await refused(S.planSettingRevert(dv, { ...entry, env: 'nowhere' }, ctx()), /names an environment the toolkit does not know/, 'invalid_job');
  await refused(S.planSettingRevert(dv, { ...entry, env: 'recovery' }, ctx()), /was made in the Recovery App/, 'invalid_job');
});
