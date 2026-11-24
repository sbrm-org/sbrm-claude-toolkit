'use strict';
// Privileges taken OFF an existing SBRM security role (kind "securityrole", action "remove", 1.11.43; Dylan 11/20/26,
// "Build both into the toolkit", after an operator clicked New on the shelter waitlist), on a fake Dataverse
// (test/fake_identity.js, withNormal). Admin only; SBRM's own "#_ " roles only; never the security and code tables.
// The plan names who holds the role and every other role giving the same privilege. The read-back must show exactly
// the named privileges gone and every other one where it was. The undo gives back exactly what the apply took off, at
// the depth it was held, while the role is still as the apply left it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-secrole-rm-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const S = require('../lib/securityrole');
const { fakeIdentityDv, withNormal, IDS, ENVS, ACCESS, pid } = require('./fake_identity');

const ROLE = '#_ SBRM Normal';
const dvAs = (email = 'admin@example.org', over = {}) => fakeIdentityDv({ email, d: withNormal(), ...over });
const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, ...over });

function job(over = {}) {
  const remove = over.remove || [{ table: 'sbrm_guest', access: ['create'] }];
  const count = remove.reduce((n, p) => n + (Array.isArray(p.access) ? p.access.length : 0), 0);
  const role = over.role || ROLE;
  return {
    contract: 'sbrm-dv-job/1', kind: 'securityrole', env: 'hgs', role, remove, source: 'claude-session',
    reason: 'Operators should not make guest rows by hand.', intent: { verb: 'securityrole', role, action: 'remove', privileges: count },
    ...over,
  };
}
function valid(raw) {
  const r = S.validateSecurityRoleJob(raw, { envs: ENVS });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
}
const errorsOf = (raw) => S.validateSecurityRoleJob(raw, { envs: ENVS }).errors;
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
const heldNames = (dv) => dv.data.roleprivs[IDS.normal].map((p) => p.name).sort();
const entryFrom = (res) => JSON.parse(JSON.stringify(res.entry));

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await S.applySecurityRole({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, ...over,
  }, { id: `20261123-1400${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown, fileGone: !fs.existsSync(file) };
}

// ---------- the job file ----------

test('validate: role + remove pass; new-role keys, other roles, depth, duplicates, protected tables and intent are checked', () => {
  const j = valid(job());
  assert.equal(j.action, 'remove');
  assert.equal(j.role, ROLE);
  assert.deepEqual(j.remove, [{ table: 'sbrm_guest', access: ['create'] }]);
  const cases = [
    [{ name: '#_ x' }, /"name" belongs to a NEW role/],
    [{ privileges: [{ table: 'contact', access: ['read'], depth: 'user' }] }, /"privileges" belongs to a NEW role/],
    [{ writes: true }, /"writes" belongs to a NEW role/],
    [{ role: 'System Administrator', intent: { verb: 'securityrole', role: 'System Administrator', action: 'remove', privileges: 1 } }, /"role" may not be System Administrator/],
    [{ role: 'Basic User', intent: { verb: 'securityrole', role: 'Basic User', action: 'remove', privileges: 1 } }, /"role" must be one of SBRM's own roles/],
    [{ role: '#_ a\nb' }, /"role" must be the existing role's name/],
    [{ remove: [] }, /"remove" must list 1 to 50 tables/],
    [{ remove: undefined }, /"remove" must list 1 to 50 tables/],
    [{ remove: ['sbrm_guest'] }, /remove 1: must be an object/],
    [{ remove: [{ table: 'sbrm_guest', access: ['create'], depth: 'organization' }] }, /remove 1: unknown key "depth" \(a privilege is removed at whatever depth the role holds it\)/],
    [{ remove: [{ table: 'Bad Table', access: ['create'] }] }, /remove 1: "table" must be the table's logical name/],
    [{ remove: [{ table: 'sbrm_guest', access: [] }] }, /remove 1: "access" must list one or more of/],
    [{ remove: [{ table: 'sbrm_guest', access: ['create', 'create'] }] }, /none twice/],
    [{ remove: [{ table: 'sbrm_guest', access: ['peek'] }] }, /"access" must list one or more of/],
    [{ remove: [{ table: 'sbrm_guest', access: ['create'] }, { table: 'SBRM_Guest', access: ['write'] }] }, /remove 2: sbrm_guest appears more than once/],
    [{ remove: [{ table: 'role', access: ['read'] }] }, /remove 1: role decides who can do what or runs code/],
    [{ remove: [{ table: 'sbrm_dataversewritelog', access: ['create'] }] }, /sbrm_dataversewritelog decides who can do what or runs code/],
    [{ intent: undefined }, /"intent" is required/],
    [{ intent: { verb: 'role', role: ROLE, action: 'remove', privileges: 1 } }, /intent does not match.*verb says "role"/],
    [{ intent: { verb: 'securityrole', role: ROLE, action: 'delete', privileges: 1 } }, /intent does not match.*action says "delete"/],
    [{ intent: { verb: 'securityrole', role: '#_ other', action: 'remove', privileges: 1 } }, /intent does not match.*intent names the role "#_ other"/],
    [{ intent: { verb: 'securityrole', role: ROLE, action: 'remove', privileges: 2 } }, /intent does not match.*intent says 2 privileges, the file removes 1/],
    [{ intent: { verb: 'securityrole', role: ROLE, action: 'remove', privileges: 1, extra: 1 } }, /intent does not match.*unknown key "extra"/],
  ];
  for (const [over, re] of cases) {
    const errs = errorsOf({ ...job(), ...over });
    assert.ok(errs.some((e) => re.test(e)), `${JSON.stringify(over).slice(0, 90)}: ${errs.join(' | ')}`);
  }
  // A job that names neither key is still a new-role job (the older path), not a removal.
  assert.ok(errorsOf({ ...job(), role: undefined, remove: undefined }).length > 0);
});

// ---------- plan ----------

test('plan: reads only; each privilege at the depth the role holds it; holders and the other roles that give it are named', async () => {
  const dv = dvAs();
  // As measured live in HGS 11/23/26: disabled accounts and application users hold the role beside real people.
  dv.data.userroles.push({ user: IDS.offApp, role: IDS.normal }, { user: IDS.ourApp, role: IDS.normal });
  const plan = await S.planSecurityRole(dv, valid(job({ remove: [{ table: 'sbrm_guest', access: ['create', 'append'] }] })), ctx());
  assert.deepEqual(nonGets(dv), [], 'a plan only reads');
  assert.equal(plan.action, 'remove');
  assert.equal(plan.name, ROLE);
  assert.equal(plan.role_id, IDS.normal);
  assert.equal(plan.need, 'admin');
  assert.deepEqual(plan.privileges.map((r) => [r.table, r.access, r.privilege_name, r.privilege_id, r.depth, r.depth_word]), [
    ['sbrm_guest', 'create', 'prvCreatesbrm_guest', pid('prvCreatesbrm_guest'), 'Global', 'organization'],
    ['sbrm_guest', 'append', 'prvAppendsbrm_guest', pid('prvAppendsbrm_guest'), 'Global', 'organization'],
  ]);
  assert.equal(plan.before.length, 6, 'the whole role as read, for the apply-time check');
  // Enabled people, enabled application users and teams are who is affected; a disabled account is only counted.
  // `ids`: every holder by id (a disabled account too), so a same-name swap is a change at apply (round-2 review F2).
  assert.deepEqual(plan.holders, { people: ['Tim Molloy'], apps: ['# sbrmapps - Mail Sorting Guide (Dataverse read)'], teams: ['Homeless Program'], disabled: 1,
    ids: [IDS.tim, IDS.ourApp, IDS.offApp, `team:${IDS.team}`].sort() });
  // System Administrator also gives Create (a person and an application user hold it in the fake); nothing else gives Append.
  const also = Object.fromEntries(plan.also_given.map((g) => [g.privilege_name, g.roles]));
  assert.deepEqual(also.prvCreatesbrm_guest, [{ name: 'System Administrator', managed: true, depth: 'Global', people: 1, apps: 1, teams: [] }]);
  assert.deepEqual(also.prvAppendsbrm_guest, []);
  // The prompt shows only the headline and these lines (round-2 review F14): the application users by name and every
  // other role giving the privileges are IN the line, never "listed below".
  assert.deepEqual(plan.severity.ends, ["1 person, 1 application user and 1 team (application users: # sbrmapps - Mail Sorting Guide (Dataverse read)) holding '#_ SBRM Normal' lose create on sbrm_guest, append on sbrm_guest unless they hold another role giving it; also given by System Administrator (organization)"]);
  const s = S.securityRoleSummary(plan);
  assert.match(s, /Take 2 privileges off the security role '#_ SBRM Normal' in the HGS apps/);
  assert.match(s, /sbrm_guest: create \(organization\)/);
  assert.match(s, /Held by: 1 person, 1 application user and 1 team \(teams: Homeless Program\)/);
  assert.match(s, /Application users holding it \(an integration that loses this stops working\): # sbrmapps - Mail Sorting Guide \(Dataverse read\)/);
  assert.match(s, /1 disabled account also holds it; nothing changes for them\./);
  assert.match(s, /prvCreatesbrm_guest: System Administrator \(at organization depth; 1 person; 1 application user\)/);
  assert.match(s, /prvAppendsbrm_guest: no other role\n/);
  assert.match(s, /Can be undone with revert/);
  const d = S.securityRoleDetail(plan, { id: 'p1' });
  assert.match(d, /remove prvCreatesbrm_guest \(held at Global;/);
  assert.match(d, /Held by: Tim Molloy; application users: # sbrmapps - Mail Sorting Guide \(Dataverse read\); teams: Homeless Program; disabled accounts: 1/);
  // Only disabled accounts hold it: nobody is affected, so there is no "Ends access" line.
  const idle = dvAs();
  idle.data.userroles = idle.data.userroles.filter((g) => g.role !== IDS.normal);
  idle.data.teamroles = [];
  idle.data.userroles.push({ user: IDS.offApp, role: IDS.normal });
  const quiet = await S.planSecurityRole(idle, valid(job()), ctx());
  assert.deepEqual(quiet.holders, { people: [], apps: [], teams: [], disabled: 1, ids: [IDS.offApp] });
  assert.deepEqual(quiet.severity.ends || [], []);
  assert.match(S.securityRoleSummary(quiet), /Held by: nobody/);
});

test('plan: refused for a missing, duplicated or Microsoft role, a privilege the role does not give, an unknown table, and below admin', async () => {
  await refused(S.planSecurityRole(dvAs(), valid(job({ role: '#_ Nobody' })), ctx()), /there is no security role named '#_ Nobody'/, 'invalid_job');
  let dv = dvAs();
  dv.data.roles.push({ roleid: 'e5000000-0000-0000-0000-000000000001', name: ROLE, _parentrootroleid_value: 'e5000000-0000-0000-0000-000000000001', _businessunitid_value: IDS.rootBu, ismanaged: false });
  await refused(S.planSecurityRole(dv, valid(job()), ctx()), /2 security roles are named '#_ SBRM Normal'/, 'invalid_job');
  dv = dvAs();
  dv.data.roles.find((r) => r.roleid === IDS.normal).ismanaged = true;
  await refused(S.planSecurityRole(dv, valid(job()), ctx()), /is a Microsoft \(managed\) role; it is never changed here/, 'invalid_job');
  // Every problem is named at once.
  dv = dvAs();
  await refused(S.planSecurityRole(dv, valid(job({ remove: [{ table: 'sbrm_guest', access: ['delete'] }, { table: 'sbrm_nope', access: ['create'] }, { table: 'sbrm_bednight', access: ['create'] }] })), ctx()),
    /does not give delete on sbrm_guest, so there is nothing to take off[\s\S]*there is no table named sbrm_nope[\s\S]*does not give create on sbrm_bednight/, 'invalid_job');
  assert.deepEqual(nonGets(dv), []);
  await refused(S.planSecurityRole(dvAs('dev@example.org', { userId: IDS.tim }), valid(job()), ctx()), /takes admin access; .* has develop/, 'not_permitted');
});

// ---------- apply ----------

test('apply: takes off exactly the named privileges, one call each, and reads the role back with every other privilege in place', async () => {
  const dv = dvAs();
  const plan = await S.planSecurityRole(dv, valid(job({ remove: [{ table: 'sbrm_guest', access: ['create', 'append'] }] })), ctx());
  const before = heldNames(dv);
  dv.calls.length = 0;
  const { res, shown, fileGone } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied');
  assert.equal(res.written, 1);
  assert.ok(fileGone, 'the plan file is used up');
  assert.deepEqual(nonGets(dv).map((c) => [c.verb, c.roleId, c.privilegeId]), [
    ['removeRolePrivilege', IDS.normal, pid('prvCreatesbrm_guest')],
    ['removeRolePrivilege', IDS.normal, pid('prvAppendsbrm_guest')],
  ]);
  assert.deepEqual(heldNames(dv), before.filter((n) => n !== 'prvCreatesbrm_guest' && n !== 'prvAppendsbrm_guest'));
  const row = res.entry.rows[0];
  assert.equal(row.action, 'remove');
  assert.equal(row.id, IDS.normal);
  assert.equal(row.outcome, 'written');
  assert.deepEqual(row.before.privileges.map((p) => [p.name, p.depth]), [['prvCreatesbrm_guest', 'Global'], ['prvAppendsbrm_guest', 'Global']]);
  assert.equal(row.after.privileges.length, 4);
  assert.equal(shown.length, 1);
  assert.match(shown[0].title, /approve taking privileges off this security role in the HGS apps/);
  assert.match(shown[0].summaryText, /Take 2 privileges off/);
});

test('apply: the read-back catches a privilege still held, another one lost, or one that appeared; a failed call says how far it got', async () => {
  let dv = dvAs();
  let plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.readBackDrops = true;
  let { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.equal(res.written, 0);
  assert.match(res.entry.rows[0].outcome, /read-back mismatch: still held prvCreatesbrm_guest/);

  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.privsExtra = 'prvDeletesbrm_guest';
  ({ res } = await applied(plan, dv));
  assert.match(res.entry.rows[0].outcome, /read-back mismatch: unexpected prvDeletesbrm_guest \(Global\)/);

  // The platform takes off the named privilege AND another one.
  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  const real = dv.removeRolePrivilege;
  dv.removeRolePrivilege = (roleId, privilegeId) => {
    const out = real(roleId, privilegeId);
    dv.data.roleprivs[IDS.normal] = dv.data.roleprivs[IDS.normal].filter((p) => p.name !== 'prvWritesbrm_guest');
    return out;
  };
  ({ res } = await applied(plan, dv));
  assert.match(res.entry.rows[0].outcome, /read-back mismatch: lost prvWritesbrm_guest \(Global\)/);

  // The second of two calls fails: the row says one was taken off and carries what the role holds now.
  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job({ remove: [{ table: 'sbrm_guest', access: ['create', 'append'] }] })), ctx());
  let n = 0;
  const real2 = dv.removeRolePrivilege;
  dv.removeRolePrivilege = (roleId, privilegeId) => { n += 1; if (n === 2) dv.failOn = 'removeRolePrivilege'; return real2(roleId, privilegeId); };
  ({ res } = await applied(plan, dv));
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.entry.rows[0].outcome, /^failed: Privilege remove failed \(1 of 2 taken off before it stopped\)/);
  assert.equal(res.entry.rows[0].after.privileges.length, 5);
});

test('apply: refused when the role moved since the plan or while the approval waited; on tamper; cancelled writes nothing', async () => {
  let dv = dvAs();
  let plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.data.roleprivs[IDS.normal].push({ name: 'prvReadcontact', depth: 'Basic' });
  await applyRefused(applied(plan, dv), /privileges changed since the plan/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);

  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.data.roles.find((r) => r.roleid === IDS.normal).name = '#_ SBRM Renamed';
  await applyRefused(applied(plan, dv), /is now named '#_ SBRM Renamed'/, 'snapshot_moved');

  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.data.roles.find((r) => r.roleid === IDS.normal).ismanaged = true;
  await applyRefused(applied(plan, dv), /is not one of SBRM's own "#_ " roles/, 'not_permitted');

  // The prompt can wait minutes: a change made meanwhile stops the write.
  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  const moved = dv;
  await applyRefused(applied(plan, dv, { confirm: () => { moved.data.roleprivs[IDS.normal].push({ name: 'prvReadcontact', depth: 'Basic' }); return { approved: true }; } }),
    /Something changed while the approval was waiting: .*privileges changed since the plan/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);

  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  const file = path.join(HOME, 'y.json');
  fs.writeFileSync(file, '{}');
  const deps = { access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }) };
  const fresh = { ...plan, created: new Date().toISOString() };
  const tamper = [
    { role_id: 'x' }, { before: undefined }, { holders: undefined }, { privileges: [] },
    { privileges: [{ ...plan.privileges[0], privilege_id: 'x' }] },
    { privileges: [{ ...plan.privileges[0], access: 'peek' }] },
    { privileges: [{ ...plan.privileges[0], depth: 'Everything' }] },
    { privileges: [{ ...plan.privileges[0], table: 'role' }] },
  ];
  for (const bad of tamper) {
    await applyRefused(S.applySecurityRole({ ...fresh, ...bad }, deps, { id: 'p', file, fs }), /no security role plan writes/, 'plan_tampered');
  }
  await applyRefused(S.applySecurityRole({ ...fresh, created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, deps, { id: 'p', file, fs }), /more than 24 hours old/, 'stale_plan');
  assert.deepEqual(nonGets(dv), []);
  const { res } = await applied(plan, dv, { confirm: () => ({ approved: false }) });
  assert.equal(res.outcome, 'cancelled');
  assert.deepEqual(nonGets(dv), []);
});

// ---------- revert ----------

test('revert: gives back exactly what the apply took off, at the depth it was held, and reads the role back whole', async () => {
  const dv = dvAs();
  const whole = heldNames(dv);
  const { res } = await applied(await S.planSecurityRole(dv, valid(job({ remove: [{ table: 'sbrm_guest', access: ['create', 'append'] }] })), ctx()), dv);
  dv.calls.length = 0;
  const undo = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  assert.deepEqual(nonGets(dv), [], 'planning the undo only reads');
  assert.equal(undo.action, 'restore');
  assert.equal(undo.role_id, IDS.normal);
  assert.equal(undo.reverts_plan_id, res.entry.plan_id);
  assert.equal(undo.unit.id, IDS.rootBu);
  assert.deepEqual(undo.privileges.map((p) => [p.name, p.id, p.depth]), [
    ['prvCreatesbrm_guest', pid('prvCreatesbrm_guest'), 'Global'], ['prvAppendsbrm_guest', pid('prvAppendsbrm_guest'), 'Global'],
  ]);
  const s = S.securityRoleSummary(undo);
  assert.match(s, /Give back 2 privileges to the security role '#_ SBRM Normal'/);
  assert.match(s, /prvCreatesbrm_guest \(organization\)/);
  assert.match(s, /Not undone by revert/);
  const back = await applied(undo, dv);
  assert.equal(back.res.outcome, 'applied');
  const add = nonGets(dv);
  assert.equal(add.length, 1);
  assert.equal(add[0].verb, 'addRolePrivileges');
  assert.equal(add[0].roleId, IDS.normal);
  assert.deepEqual(add[0].privileges, [
    { PrivilegeId: pid('prvCreatesbrm_guest'), Depth: 'Global', BusinessUnitId: IDS.rootBu },
    { PrivilegeId: pid('prvAppendsbrm_guest'), Depth: 'Global', BusinessUnitId: IDS.rootBu },
  ]);
  assert.deepEqual(heldNames(dv), whole);
  assert.match(back.shown[0].title, /approve giving privileges back to this security role/);
  // Giving back is not undone here.
  await refused(S.planSecurityRoleRevert(dv, entryFrom(back.res), ctx()), /giving privileges back is not undone here/, 'nothing_to_undo');
});

test('revert: only what the read-back showed gone comes back; a removal that took nothing off has nothing to undo', async () => {
  const dv = dvAs();
  const plan = await S.planSecurityRole(dv, valid(job({ remove: [{ table: 'sbrm_guest', access: ['create', 'append'] }] })), ctx());
  dv.privsDrop = 'prvAppendsbrm_guest'; // the platform quietly leaves Append on
  const { res } = await applied(plan, dv);
  assert.match(res.entry.rows[0].outcome, /still held prvAppendsbrm_guest/);
  dv.privsDrop = null;
  const undo = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  assert.deepEqual(undo.privileges.map((p) => p.name), ['prvCreatesbrm_guest']);

  const dv2 = dvAs();
  const plan2 = await S.planSecurityRole(dv2, valid(job()), ctx());
  dv2.readBackDrops = true;
  const none = await applied(plan2, dv2);
  dv2.readBackDrops = false;
  await refused(S.planSecurityRoleRevert(dv2, entryFrom(none.res), ctx()), /took nothing off/, 'nothing_to_undo');
});

test('revert: the read-back catches a privilege the platform did not give back, and a failed call is logged as failed', async () => {
  let dv = dvAs();
  let { res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv);
  let undo = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  dv.privsDrop = 'prvCreatesbrm_guest';
  let back = await applied(undo, dv);
  assert.equal(back.res.outcome, 'applied with problems');
  assert.equal(back.res.written, 0);
  assert.match(back.res.entry.rows[0].outcome, /read-back mismatch: the role holds 5 privileges, 6 expected \(prvCreatesbrm_guest \(Global\) missing\)/);

  dv = dvAs();
  ({ res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv));
  undo = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  dv.failOn = 'addRolePrivileges';
  back = await applied(undo, dv);
  assert.equal(back.res.outcome, 'applied with problems');
  assert.match(back.res.entry.rows[0].outcome, /^failed: Privilege add failed/);
  assert.equal(back.res.entry.rows[0].after.privileges.length, 5);
});

test('revert: refused when the role moved since, or while the approval waited; and a restore plan is checked like any other', async () => {
  let dv = dvAs();
  let { res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv);
  dv.data.roleprivs[IDS.normal].push({ name: 'prvReadcontact', depth: 'Basic' });
  await refused(S.planSecurityRoleRevert(dv, entryFrom(res), ctx()), /privileges changed since plan/, 'snapshot_moved');

  dv = dvAs();
  ({ res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv));
  const undo = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  dv.calls.length = 0;
  const moved = dv;
  await applyRefused(applied(undo, dv, { confirm: () => { moved.data.roleprivs[IDS.normal].push({ name: 'prvReadcontact', depth: 'Basic' }); return { approved: true }; } }),
    /Something changed while the approval was waiting/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);

  dv = dvAs();
  ({ res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv));
  const good = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  const file = path.join(HOME, 'z.json');
  fs.writeFileSync(file, '{}');
  const deps = { access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }) };
  const fresh = { ...good, created: new Date().toISOString() };
  dv.calls.length = 0;
  const tamper = [
    { reverts_plan_id: null },                                                    // a restore that undoes nothing logged
    { unit: { id: 'x' } }, { expect_privileges: undefined }, { privileges: [] },
    { privileges: [{ ...good.privileges[0], depth: 'Everything' }] },
    { privileges: [{ ...good.privileges[0], name: 'prvCreaterole' }] },            // a security table
    { privileges: [{ ...good.privileges[0], name: 'not a privilege' }] },
    { privileges: [{ ...good.privileges[0], id: 'x' }] },
  ];
  for (const bad of tamper) {
    await applyRefused(S.applySecurityRole({ ...fresh, ...bad }, deps, { id: 'p', file, fs }), /no security role plan writes/, 'plan_tampered');
  }
  // A plan naming another privilege's id under this privilege's name is refused before the prompt.
  await applyRefused(S.applySecurityRole({ ...fresh, privileges: [{ ...good.privileges[0], id: pid('prvDeletesbrm_guest') }] }, deps, { id: 'p', file, fs }),
    /is not prvCreatesbrm_guest/, 'plan_tampered');
  assert.deepEqual(nonGets(dv), []);
});

test('revert: a forged or damaged log entry is refused (wrong role, a security table, a bad depth, a renamed privilege, no read-back)', async () => {
  const dv = dvAs();
  const { res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv);
  const base = entryFrom(res);
  const withRow = (change) => { const e = JSON.parse(JSON.stringify(base)); change(e.rows[0]); return e; };
  const cases = [
    [(r) => { r.id = 'x'; }, /no valid role/, 'invalid_job'],
    [(r) => { r.role.name = 'System Administrator'; }, /no valid role/, 'invalid_job'],
    [(r) => { r.role.name = 'Basic User'; }, /no valid role/, 'invalid_job'],
    [(r) => { r.before.privileges = []; }, /no valid list of what it took off/, 'invalid_job'],
    [(r) => { r.before.privileges[0].id = 'x'; }, /no valid list of what it took off/, 'invalid_job'],
    [(r) => { r.after = null; }, /no read-back of the role's privileges/, 'invalid_job'],
    [(r) => { r.before.privileges[0].depth = 'Everything'; }, /gives prvCreatesbrm_guest the depth "Everything"/, 'invalid_job'],
    [(r) => { r.before.privileges[0] = { name: 'prvCreaterole', id: pid('prvCreaterole'), depth: 'Global' }; }, /prvCreaterole is on a security or code table/, 'invalid_job'],
    [(r) => { r.before.privileges[0].id = pid('prvDeletesbrm_guest'); }, /is not prvCreatesbrm_guest in the HGS apps/, 'invalid_job'],
  ];
  for (const [change, re, code] of cases) await refused(S.planSecurityRoleRevert(dv, withRow(change), ctx()), re, code);
  await refused(S.planSecurityRoleRevert(dv, { ...base, env: 'recovery' }, ctx()), /./);
  await refused(S.planSecurityRoleRevert(dvAs('dev@example.org', { userId: IDS.tim }), base, ctx()), /takes admin access/, 'not_permitted');
  assert.deepEqual(nonGets(dv).filter((c) => c.verb !== 'removeRolePrivilege'), []);
});

// ---------- the write call ----------

test('identityCall: taking a privilege off has one fixed path and body; both ids are checked', () => {
  const { identityCall } = require('../lib/write');
  const p = pid('prvCreatesbrm_guest');
  assert.deepEqual(identityCall('removeRolePrivilege', { roleId: IDS.normal, privilegeId: p }), {
    method: 'POST', path: `roles(${IDS.normal})/Microsoft.Dynamics.CRM.RemovePrivilegeRole`,
    body: { Privilege: { '@odata.type': 'Microsoft.Dynamics.CRM.privilege', privilegeid: p } }, headers: [],
  });
  assert.throws(() => identityCall('removeRolePrivilege', { roleId: 'roles', privilegeId: p }), /not a GUID/);
  assert.throws(() => identityCall('removeRolePrivilege', { roleId: IDS.normal, privilegeId: 'x' }), /not a GUID/);
  assert.throws(() => identityCall('removeRolePrivilege', { roleId: IDS.normal }), /not a GUID/);
});

test('the log keeps what the undo reads when an entry is too big for one row: the trimmed entry still plans the undo', async () => {
  const { fitForRow, ENTRY_MAX } = require('../lib/log');
  const dv = dvAs();
  const { res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv);
  const entry = entryFrom(res);
  // Something the undo never reads grows past the limit, so the row is cut down to what undo keeps.
  entry.rows[0].changes[0].new_text = 'x'.repeat(ENTRY_MAX + 1000);
  const text = fitForRow(entry);
  assert.ok(text.length <= ENTRY_MAX, `fits (${text.length})`);
  const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);
  assert.equal(json.log_trimmed, 'bodies');
  assert.deepEqual(Object.keys(json.rows[0]).sort(), ['action', 'after', 'before', 'id', 'name', 'outcome', 'role']);
  const undo = await S.planSecurityRoleRevert(dv, json, ctx());
  assert.equal(undo.action, 'restore');
  assert.deepEqual(undo.privileges.map((p) => p.name), ['prvCreatesbrm_guest']);
});
