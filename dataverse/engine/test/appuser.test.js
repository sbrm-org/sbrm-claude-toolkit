'use strict';
// Application users (kind "appuser", 1.11.31; Dylan 10/21/26: "Why cant we just do this through the toolkit?"):
// create, switch off and switch on one application user, on a fake Dataverse (test/fake_identity.js). Admin only.
// Never switched off here: an application user that holds a Microsoft (managed) role. A create's undo switches the
// user off; nothing is ever deleted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-appuser-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const A = require('../lib/appuser');
const { fakeIdentityDv, IDS, ENVS, ACCESS } = require('./fake_identity');

const dvAs = (email = 'admin@example.org', over = {}) => fakeIdentityDv({ email, ...over });
const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, ...over });

function job(over = {}) {
  const action = over.action || 'create';
  const client = over.client_id || IDS.newClient;
  return {
    contract: 'sbrm-dv-job/1', kind: 'appuser', env: 'hgs', action, client_id: client, source: 'claude-session',
    reason: 'The Mail Sorting Guide job signs in as its own Entra app.', intent: { verb: 'appuser', action, client_id: client }, ...over,
  };
}
function valid(raw) {
  const r = A.validateAppUserJob(raw, { envs: ENVS });
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
const userOf = (dv, client) => dv.data.systemusers.find((u) => u.applicationid && u.applicationid.toLowerCase() === client.toLowerCase());

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await A.applyAppUser({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, ...over,
  }, { id: `20261109-1300${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown, fileGone: !fs.existsSync(file) };
}

// ---------- the job file ----------

test('validate: a good job passes; bad client ids, actions, keys and intent mismatches are refused', () => {
  const j = valid(job({ client_id: ` ${IDS.newClient.toUpperCase()} `, intent: { verb: 'appuser', action: 'create', client_id: IDS.newClient } }));
  assert.equal(j.client_id, IDS.newClient);
  assert.equal(j.business_unit, undefined);
  assert.equal(valid(job({ business_unit: " Men's " })).business_unit, "Men's");
  const cases = [
    [{ colour: 1 }, /unknown top-level key "colour"/],
    [{ contract: 'x' }, /"contract" must be exactly/],
    [{ kind: 'role' }, /"kind" must be "appuser"/],
    [{ env: 'nowhere' }, /"env" must be one of/],
    [{ action: 'delete', intent: { verb: 'appuser', action: 'delete', client_id: IDS.newClient } }, /"action" must be "create", "disable" or "enable"/],
    [{ client_id: 'not-a-guid' }, /"client_id" must be the Entra app's Application \(client\) ID/],
    [{ client_id: '00000000-0000-0000-0000-000000000000' }, /"client_id" must be/],
    [{ action: 'disable', business_unit: 'X', intent: { verb: 'appuser', action: 'disable', client_id: IDS.newClient } }, /"business_unit" is only for "create"/],
    [{ business_unit: 'a\nb' }, /"business_unit" must be the business unit's name/],
    [{ source: '' }, /"source" is required/],
    [{ reason: '' }, /"reason" is required/],
    [{ reason: 'two\nlines' }, /"reason" must be one line/],
    [{ intent: undefined }, /"intent" is required/],
    [{ intent: { verb: 'roles', action: 'create', client_id: IDS.newClient } }, /intent does not match.*verb says "roles"/],
    [{ intent: { verb: 'appuser', action: 'disable', client_id: IDS.newClient } }, /intent does not match.*intent says "disable", the file says "create"/],
    [{ intent: { verb: 'appuser', action: 'create', client_id: IDS.offAppClient } }, /intent does not match.*intent names the app/],
    [{ intent: { verb: 'appuser', action: 'create', client_id: IDS.newClient, extra: 1 } }, /intent does not match.*unknown key "extra"/],
  ];
  for (const [over, re] of cases) {
    const r = A.validateAppUserJob({ ...job(), ...over }, { envs: ENVS });
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(over).slice(0, 80)}: ${r.errors.join(' | ')}`);
  }
});

// ---------- plan ----------

test('plan create: reads only; picks the root business unit; warns it is lasting; the summary says how it is undone', async () => {
  const dv = dvAs();
  const plan = await A.planAppUser(dv, valid(job()), ctx());
  assert.deepEqual(nonGets(dv), []);
  assert.equal(plan.kind, 'appuser');
  assert.equal(plan.mode, 'appuser');
  assert.equal(plan.need, 'admin');
  assert.deepEqual(plan.unit, { id: IDS.rootBu, name: 'SBRM Homeless' });
  assert.equal(plan.user, null);
  assert.ok(plan.severity.lasting.length === 1 && /a new application user for the Entra app d4000000/.test(plan.severity.lasting[0]));
  const s = A.appUserSummary(plan);
  assert.match(s, /Create an application user for the Entra app d4000000-0000-0000-0000-000000000001 in the HGS apps/);
  assert.match(s, /Business unit: SBRM Homeless/);
  assert.match(s, /switches the new application user off/);
  assert.match(A.appUserDetail(plan, { id: 'P1' }), /Business unit id: 6df44b00/);
});

test('plan create: a named business unit is used; an unknown one, or an app that already has a user, is refused', async () => {
  const plan = await A.planAppUser(dvAs(), valid(job({ business_unit: "Men's" })), ctx());
  assert.deepEqual(plan.unit, { id: IDS.childBu, name: "Men's" });
  await refused(A.planAppUser(dvAs(), valid(job({ business_unit: 'Nowhere' })), ctx()), /no business unit named 'Nowhere'/, 'invalid_job');
  await refused(A.planAppUser(dvAs(), valid(job({ client_id: IDS.ourAppClient, intent: { verb: 'appuser', action: 'create', client_id: IDS.ourAppClient } })), ctx()),
    /already has an application user.*Mail Sorting Guide.*\(on\)/, 'already_exists');
  await refused(A.planAppUser(dvAs(), valid(job({ client_id: IDS.offAppClient, intent: { verb: 'appuser', action: 'create', client_id: IDS.offAppClient } })), ctx()),
    /switched off; use action "enable"/, 'already_exists');
});

test('plan: admin only; develop and read are refused with their own codes', async () => {
  await refused(A.planAppUser(dvAs('dev@example.org'), valid(job()), ctx()), /takes admin access; Test Admin has develop/, 'not_permitted');
  await refused(A.planAppUser(dvAs('nobody@example.org'), valid(job()), ctx()), /has read/, 'access_read');
});

const sw = (action, client) => valid(job({ action, client_id: client, intent: { verb: 'appuser', action, client_id: client } }));

test('plan disable / enable: the one application user, its state; refusals for already-there, people, Microsoft integrations', async () => {
  const dv = dvAs();
  const plan = await A.planAppUser(dv, sw('disable', IDS.ourAppClient), ctx());
  assert.deepEqual(nonGets(dv), []);
  assert.equal(plan.user.id, IDS.ourApp);
  assert.equal(plan.user.disabled, false);
  assert.ok(plan.severity.ends.length === 1 && /can no longer sign in to the HGS apps/.test(plan.severity.ends[0]));
  assert.match(A.appUserSummary(plan), /Switch off the application user # sbrmapps - Mail Sorting Guide \(Dataverse read\).*\n[\s\S]*on -> off/);
  const on = await A.planAppUser(dvAs(), sw('enable', IDS.offAppClient), ctx());
  assert.equal(on.user.disabled, true);
  assert.deepEqual(on.severity.ends, []);
  assert.deepEqual(on.severity.lasting, []);
  await refused(A.planAppUser(dvAs(), sw('enable', IDS.ourAppClient), ctx()), /already on/, 'nothing_to_change');
  await refused(A.planAppUser(dvAs(), sw('disable', IDS.offAppClient), ctx()), /already switched off/, 'nothing_to_change');
  await refused(A.planAppUser(dvAs(), sw('disable', IDS.newClient), ctx()), /has no application user/, 'nothing_to_change');
  await refused(A.planAppUser(dvAs(), sw('disable', IDS.personClient), ctx()), /is not an application user \(access mode 0\)/, 'not_permitted');
  await refused(A.planAppUser(dvAs(), sw('disable', IDS.msAppClient), ctx()), /holds the Microsoft role System Administrator.*never switched off here/, 'not_permitted');
  // Switching ON a Microsoft integration is not refused by name (nothing is lost by switching it back on).
  const d = dvAs();
  d.data.systemusers.find((u) => u.systemuserid === IDS.msApp).isdisabled = true;
  assert.equal((await A.planAppUser(d, sw('enable', IDS.msAppClient), ctx())).action, 'enable');
});

test('plan: two users carrying one client id is refused (never guess)', async () => {
  const dv = dvAs();
  dv.data.systemusers.push({ systemuserid: 'b2000000-0000-0000-0000-0000000000ff', fullname: '# twin', applicationid: IDS.ourAppClient, accessmode: 4, isdisabled: false, _businessunitid_value: IDS.rootBu });
  await refused(A.planAppUser(dv, sw('disable', IDS.ourAppClient), ctx()), /2 users carry the Entra app/, 'invalid_job');
});

// ---------- apply ----------

test('apply create: one POST, read back by client id, logged; the plan file is removed', async () => {
  const dv = dvAs();
  const plan = await A.planAppUser(dv, valid(job()), ctx());
  dv.calls.length = 0;
  const { res, shown, fileGone } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied');
  assert.equal(res.written, 1);
  assert.ok(fileGone);
  assert.match(shown[0].summaryText, /Create an application user/);
  const writes = nonGets(dv);
  assert.equal(writes.length, 1);
  assert.deepEqual({ verb: writes[0].verb, clientId: writes[0].clientId, unitId: writes[0].unitId }, { verb: 'createAppUser', clientId: IDS.newClient, unitId: IDS.rootBu });
  const u = userOf(dv, IDS.newClient);
  const row = res.entry.rows[0];
  assert.equal(row.outcome, 'written');
  assert.equal(row.id, u.systemuserid);
  assert.deepEqual(row.after, { exists: true, id: u.systemuserid, fullname: '# New Entra App', disabled: false, bu: IDS.rootBu });
  assert.equal(res.entry.mode, 'appuser');
  assert.equal(res.entry.table, 'systemusers');
  assert.equal(res.entry.approval, 'prompt');
  assert.ok(dv.calls.some((c) => c.method === 'GET' && c.strong && /applicationid eq/.test(decodeURIComponent(c.path))), 'the read-back reads past the cache');
  assert.match(row.changes[0].new_text, /# New Entra App, on, SBRM Homeless/);
});

test('apply create: refused if a user appeared or the business unit went since the plan; a read-back that finds nothing says so', async () => {
  let dv = dvAs();
  let plan = await A.planAppUser(dv, valid(job()), ctx());
  dv.data.systemusers.push({ systemuserid: 'b2000000-0000-0000-0000-0000000000aa', fullname: '# raced', applicationid: IDS.newClient, accessmode: 4, isdisabled: false, _businessunitid_value: IDS.rootBu });
  await applyRefused(applied(plan, dv), /has an application user since the plan/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
  dv = dvAs();
  plan = await A.planAppUser(dv, valid(job({ business_unit: "Men's" })), ctx());
  dv.data.businessunits = dv.data.businessunits.filter((b) => b.businessunitid !== IDS.childBu);
  await applyRefused(applied(plan, dv), /business unit Men's is gone since the plan/, 'snapshot_moved');
  dv = dvAs();
  plan = await A.planAppUser(dv, valid(job()), ctx());
  dv.readBackDrops = true;
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.entry.rows[0].outcome, /read-back mismatch: 0 user\(s\) carry the app/);
  assert.equal(res.entry.rows[0].after, null);
});

test('apply create: a failed POST is logged as failed, nothing claimed', async () => {
  const { DataverseError } = require('../lib/cli');
  const dv = dvAs();
  const plan = await A.planAppUser(dv, valid(job()), ctx());
  dv.failNext = new DataverseError('The application was not found in the directory', { code: '0x80072560' });
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.entry.rows[0].outcome, /^failed: The application was not found/);
  assert.equal(res.entry.rows[0].after, null);
});

test('apply disable: version-tagged PATCH, read back; refused if it moved, switched, became a person, or gained a Microsoft role', async () => {
  let dv = dvAs();
  let plan = await A.planAppUser(dv, sw('disable', IDS.ourAppClient), ctx());
  dv.calls.length = 0;
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied');
  const w = nonGets(dv);
  assert.equal(w.length, 1);
  assert.deepEqual({ verb: w[0].verb, userId: w[0].userId, disabled: w[0].disabled, etag: w[0].etag }, { verb: 'setUserDisabled', userId: IDS.ourApp, disabled: true, etag: 'W/"1"' });
  assert.equal(userOf(dv, IDS.ourAppClient).isdisabled, true);
  assert.deepEqual(res.entry.rows[0].before, { disabled: false });
  assert.deepEqual(res.entry.rows[0].after, { disabled: true });
  assert.deepEqual(res.entry.rows[0].changes[0], { label: 'Status', old_text: 'on', new_text: 'off' });

  for (const move of [
    (d) => { d.data.systemusers.find((u) => u.systemuserid === IDS.ourApp).isdisabled = true; },
    (d) => { d.data.systemusers.find((u) => u.systemuserid === IDS.ourApp).applicationid = IDS.newClient; },
    (d) => { d.data.systemusers.find((u) => u.systemuserid === IDS.ourApp).accessmode = 0; },
    (d) => { d.data.systemusers = d.data.systemusers.filter((u) => u.systemuserid !== IDS.ourApp); },
  ]) {
    dv = dvAs();
    plan = await A.planAppUser(dv, sw('disable', IDS.ourAppClient), ctx());
    move(dv);
    await applyRefused(applied(plan, dv), /changed since the plan/, 'snapshot_moved');
    assert.deepEqual(nonGets(dv), []);
  }
  dv = dvAs();
  plan = await A.planAppUser(dv, sw('disable', IDS.ourAppClient), ctx());
  dv.data.userroles.push({ user: IDS.ourApp, role: IDS.sa });
  await applyRefused(applied(plan, dv), /now holds the Microsoft role System Administrator/, 'not_permitted');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: stale, tampered, another person, lost admin, or cancelled; nothing is written', async () => {
  const dv = dvAs();
  const plan = await A.planAppUser(dv, valid(job()), ctx());
  const file = path.join(HOME, 'x.json');
  fs.writeFileSync(file, '{}');
  const deps = { access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }) };
  const old = { ...plan, created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() };
  await applyRefused(A.applyAppUser(old, deps, { id: 'p', file, fs }), /more than 24 hours old/, 'stale_plan');
  const fresh = { ...plan, created: new Date().toISOString() };
  for (const bad of [{ mode: 'role' }, { action: 'delete' }, { client_id: 'x' }, { unit: { id: 'x' } }, { user: { id: IDS.ourApp, disabled: false } }]) {
    await applyRefused(A.applyAppUser({ ...fresh, ...bad }, deps, { id: 'p', file, fs }), /no application user plan writes/, 'plan_tampered');
  }
  const sp = await A.planAppUser(dvAs(), sw('disable', IDS.ourAppClient), ctx());
  for (const bad of [{ user: null }, { user: { ...sp.user, disabled: 'no' } }, { unit: { id: IDS.rootBu } }]) {
    await applyRefused(A.applyAppUser({ ...sp, ...bad, created: new Date().toISOString() }, deps, { id: 'p', file, fs }), /no application user plan writes/, 'plan_tampered');
  }
  const other = fakeIdentityDv({ email: 'tim@example.org', userId: IDS.tim });
  await applyRefused(A.applyAppUser(fresh, { ...deps, connect: () => other }, { id: 'p', file, fs }), /made by Test Admin; you are signed in as Tim Molloy/, 'different_person');
  await applyRefused(A.applyAppUser(fresh, { ...deps, access: { people: { 'admin@example.org': { envs: { hgs: 'write' } } } } }, { id: 'p', file, fs }), /takes admin access; you have write/, 'access_revoked');
  const { res } = await applied(plan, dv, { confirm: () => ({ approved: false, note: 'not yet' }) });
  assert.equal(res.outcome, 'cancelled');
  assert.equal(res.entry.note, 'not yet');
  assert.deepEqual(nonGets(dv), []);
});

// ---------- revert ----------

const entryFrom = (res) => JSON.parse(JSON.stringify(res.entry));

test('revert: a create is undone by switching the user OFF; a disable by switching it on; only while nothing moved', async () => {
  let dv = dvAs();
  let { res } = await applied(await A.planAppUser(dv, valid(job()), ctx()), dv);
  let undo = await A.planAppUserRevert(dv, entryFrom(res), ctx());
  assert.equal(undo.action, 'disable');
  assert.equal(undo.reverts_plan_id, res.entry.plan_id);
  assert.match(undo.reason, /^Undo plan /);
  const back = await applied(undo, dv);
  assert.equal(back.res.outcome, 'applied');
  assert.equal(userOf(dv, IDS.newClient).isdisabled, true);
  assert.ok(dv.data.systemusers.some((u) => u.applicationid === IDS.newClient), 'never deleted');
  // Undo of that undo switches it back on.
  const again = await A.planAppUserRevert(dv, entryFrom(back.res), ctx());
  assert.equal(again.action, 'enable');

  dv = dvAs();
  ({ res } = await applied(await A.planAppUser(dv, sw('disable', IDS.ourAppClient), ctx()), dv));
  undo = await A.planAppUserRevert(dv, entryFrom(res), ctx());
  assert.equal(undo.action, 'enable');
  // Someone switched it back on by hand: the revert would overwrite that, so it is refused.
  dv.data.systemusers.find((u) => u.systemuserid === IDS.ourApp).isdisabled = false;
  await refused(A.planAppUserRevert(dv, entryFrom(res), ctx()), /changed since plan .* \(it is on now\)/, 'snapshot_moved');
});

test('revert: refuses entries that did not land, forged entries, other kinds and other environments', async () => {
  const dv = dvAs();
  const { res } = await applied(await A.planAppUser(dv, valid(job()), ctx()), dv);
  const e = entryFrom(res);
  await refused(A.planAppUserRevert(dv, { ...e, mode: 'role' }, ctx()), /not an application user change/, 'nothing_to_undo');
  await refused(A.planAppUserRevert(dv, { ...e, outcome: 'cancelled' }, ctx()), /outcome is "cancelled"/, 'nothing_to_undo');
  await refused(A.planAppUserRevert(dv, { ...e, env: 'mars' }, ctx()), /does not know \("mars"\)/, 'invalid_job');
  await refused(A.planAppUserRevert(dv, { ...e, env: 'recovery' }, ctx()), /made in the Recovery app; this revert was planned against another environment/, 'invalid_job');
  await refused(A.planAppUserRevert(dv, { ...e, rows: [{ ...e.rows[0], client_id: 'x' }] }, ctx()), /no valid application user/, 'invalid_job');
  await refused(A.planAppUserRevert(dv, { ...e, rows: [{ ...e.rows[0], action: 'nuke' }] }, ctx()), /no valid application user/, 'invalid_job');
  await refused(A.planAppUserRevert(dv, { ...e, rows: [{ ...e.rows[0], after: null, outcome: 'failed: x' }] }, ctx()), /did not land \(failed: x\)/, 'nothing_to_undo');
  await refused(A.planAppUserRevert(dv, { ...e, rows: [{ ...e.rows[0], action: 'disable', after: { disabled: 'yes' } }] }, ctx()), /did not land/, 'nothing_to_undo');
});

// ---------- the write connection's verbs ----------

test('identityCall: fixed paths and bodies; anything that is not a GUID, a boolean or a version tag is refused', () => {
  const { identityCall } = require('../lib/write');
  const c = identityCall('createAppUser', { clientId: IDS.newClient.toUpperCase(), unitId: IDS.rootBu });
  assert.deepEqual(c, { method: 'POST', path: 'systemusers', body: { applicationid: IDS.newClient, 'businessunitid@odata.bind': `/businessunits(${IDS.rootBu})` }, headers: ['Prefer: return=representation'] });
  assert.deepEqual(identityCall('setUserDisabled', { userId: IDS.ourApp, disabled: true, etag: 'W/"7"' }),
    { method: 'PATCH', path: `systemusers(${IDS.ourApp})`, body: { isdisabled: true }, headers: ['If-Match: W/"7"'] });
  assert.throws(() => identityCall('createAppUser', { clientId: "x') or 1 eq 1", unitId: IDS.rootBu }), /not a GUID/);
  assert.throws(() => identityCall('createAppUser', { clientId: IDS.newClient, unitId: '../contacts' }), /not a GUID/);
  assert.throws(() => identityCall('setUserDisabled', { userId: IDS.ourApp, disabled: 'true', etag: 'W/"7"' }), /true or false/);
  assert.throws(() => identityCall('setUserDisabled', { userId: IDS.ourApp, disabled: true }), /version tag/);
  assert.throws(() => identityCall('setUserDisabled', { userId: 'contacts', disabled: true, etag: 'W/"7"' }), /not a GUID/);
  assert.throws(() => identityCall('dropTable', {}), /refusing identity verb dropTable/);
});

test('mutation gaps (11/9): two business units of one name are refused; a switch the platform did not keep reads back as a mismatch', async () => {
  const dv = dvAs();
  dv.data.businessunits.push({ businessunitid: '4f8ff316-0000-0000-0000-000000000002', name: "Men's", _parentbusinessunitid_value: IDS.rootBu });
  await refused(A.planAppUser(dv, valid(job({ business_unit: "Men's" })), ctx()), /2 business units match in the HGS apps; name one exactly/, 'invalid_job');
  const d2 = dvAs();
  const plan = await A.planAppUser(d2, sw('disable', IDS.ourAppClient), ctx());
  d2.readBackDrops = true;
  const { res } = await applied(plan, d2);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.entry.rows[0].outcome, /read-back mismatch: # sbrmapps - Mail Sorting Guide \(Dataverse read\) is on/);
  assert.deepEqual(res.entry.rows[0].after, { disabled: false });
});

// ---------- review C1 (11/9, run 20261109-121738-2cdbf1): written red first ----------

test('review F3: a switch that did not land is not "undone" by repeating it; revert refuses', async () => {
  const dv = dvAs();
  const plan = await A.planAppUser(dv, sw('disable', IDS.ourAppClient), ctx());
  dv.readBackDrops = true;
  const { res } = await applied(plan, dv);
  assert.deepEqual(res.entry.rows[0].after, { disabled: false });
  dv.readBackDrops = false;
  await refused(A.planAppUserRevert(dv, entryFrom(res), ctx()), /did not land/, 'nothing_to_undo');
  assert.equal(userOf(dv, IDS.ourAppClient).isdisabled, false);
});

test('review F4: revert of a create refuses when the client id now belongs to a different user than the one made', async () => {
  const dv = dvAs();
  const { res } = await applied(await A.planAppUser(dv, valid(job()), ctx()), dv);
  const made = res.entry.rows[0].id;
  dv.data.systemusers = dv.data.systemusers.filter((u) => u.systemuserid !== made);
  dv.data.systemusers.push({ systemuserid: 'b2000000-0000-0000-0000-0000000000bb', fullname: '# replacement', applicationid: IDS.newClient, accessmode: 4, isdisabled: false, _businessunitid_value: IDS.rootBu });
  await refused(A.planAppUserRevert(dv, entryFrom(res), ctx()), /not the user plan .* (made|changed)/, 'snapshot_moved');
});

test('review F5: a Microsoft role held through a team also protects an application user from being switched off', async () => {
  const dv = dvAs();
  dv.data.teamroles.push({ team: IDS.team, role: IDS.sa });
  dv.data.members.push({ user: IDS.ourApp, team: IDS.team });
  await refused(A.planAppUser(dv, sw('disable', IDS.ourAppClient), ctx()), /holds the Microsoft role System Administrator \(through the team Homeless Program\)/, 'not_permitted');
});

test('review F6: a Microsoft role given while the approval waits stops the switch-off; nothing is written', async () => {
  const dv = dvAs();
  const plan = await A.planAppUser(dv, sw('disable', IDS.ourAppClient), ctx());
  dv.calls.length = 0;
  await applyRefused(applied(plan, dv, { confirm: () => { dv.data.userroles.push({ user: IDS.ourApp, role: IDS.sa }); return { approved: true }; } }),
    /while the approval was waiting/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
  assert.equal(userOf(dv, IDS.ourAppClient).isdisabled, false);
});
