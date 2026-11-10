'use strict';
// New SBRM security roles (kind "securityrole", 1.11.31; Dylan 10/21/26: "Why cant we just do this through the
// toolkit?"), on a fake Dataverse (test/fake_identity.js). Admin only. Read unless the job says "writes": true;
// never write-class access at organization depth; the security and code tables are read-only; names are "#_ ...".
// The read-back allows exactly the asked-for privileges plus Dataverse's per-role baseline. The undo deletes the
// role, only while nobody holds it and its privileges are what the apply left.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-secrole-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const S = require('../lib/securityrole');
const { fakeIdentityDv, IDS, ENVS, ACCESS, BASELINE, pid } = require('./fake_identity');

const dvAs = (email = 'admin@example.org', over = {}) => fakeIdentityDv({ email, ...over });
const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, ...over });
const NAME = '#_ sbrmapps Test Job (read)';

function job(over = {}) {
  const privileges = over.privileges || [{ table: 'sbrm_guest', access: ['read'], depth: 'organization' }, { table: 'sbrm_bednight', access: ['read'], depth: 'organization' }];
  const count = privileges.reduce((n, p) => n + (Array.isArray(p.access) ? p.access.length : 0), 0);
  const writes = privileges.some((p) => Array.isArray(p.access) && p.access.some((a) => a !== 'read'));
  const name = over.name || NAME;
  return {
    contract: 'sbrm-dv-job/1', kind: 'securityrole', env: 'hgs', name, privileges, source: 'claude-session',
    reason: 'The test job reads guests and bed nights.', intent: { verb: 'securityrole', name, privileges: count, writes },
    ...(writes ? { writes: true } : {}), ...over,
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
const roleNamed = (dv, name) => dv.data.roles.find((r) => r.name === name && r._parentrootroleid_value === r.roleid);

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await S.applySecurityRole({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, ...over,
  }, { id: `20261109-1400${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown, fileGone: !fs.existsSync(file) };
}

// ---------- the job file ----------

test('validate: a read-only job passes; names, tables, access, depth, duplicates and intent are checked', () => {
  const j = valid(job());
  assert.equal(j.writes, false);
  assert.deepEqual(j.privileges[0], { table: 'sbrm_guest', access: ['read'], depth: 'organization' });
  const cases = [
    [{ colour: 1 }, /unknown top-level key "colour"/],
    [{ kind: 'role' }, /"kind" must be "securityrole"/],
    [{ name: 'Test Job', intent: { verb: 'securityrole', name: 'Test Job', privileges: 2, writes: false } }, /"name" must start with "#_ "/],
    [{ name: '#_ a\nb' }, /"name" must be the new role's name/],
    [{ name: `#_ ${'x'.repeat(98)}` }, /at most 100 characters/],
    [{ description: 'two\nlines' }, /"description" must be one line/],
    [{ writes: false }, /"writes" is either true or left out/],
    [{ privileges: [] }, /"privileges" must list 1 to 50 tables/],
    [{ privileges: [{ table: 'Bad Table', access: ['read'], depth: 'user' }] }, /privilege 1: "table" must be the table's logical name/],
    [{ privileges: [{ table: 'contact', access: ['read'], depth: 'user', extra: 1 }] }, /privilege 1: unknown key "extra"/],
    [{ privileges: [{ table: 'contact', access: [], depth: 'user' }] }, /privilege 1: "access" must list one or more of/],
    [{ privileges: [{ table: 'contact', access: ['read', 'read'], depth: 'user' }] }, /none twice/],
    [{ privileges: [{ table: 'contact', access: ['peek'], depth: 'user' }] }, /"access" must list one or more of/],
    [{ privileges: [{ table: 'contact', access: ['read'], depth: 'everyone' }] }, /"depth" must be one of user, businessunit, parentchild, organization/],
    [{ privileges: [{ table: 'contact', access: ['read'], depth: 'user' }, { table: 'Contact', access: ['write'], depth: 'user' }], writes: true }, /privilege 2: contact appears more than once/],
    [{ intent: undefined }, /"intent" is required/],
    [{ intent: { verb: 'roles', name: NAME, privileges: 2, writes: false } }, /intent does not match.*verb says "roles"/],
    [{ intent: { verb: 'securityrole', name: '#_ other', privileges: 2, writes: false } }, /intent does not match.*intent names the role "#_ other"/],
    [{ intent: { verb: 'securityrole', name: NAME, privileges: 3, writes: false } }, /intent does not match.*intent says 3 privileges, the file asks for 2/],
    [{ intent: { verb: 'securityrole', name: NAME, privileges: 2, writes: true } }, /intent does not match.*intent says writes true, the file only reads/],
  ];
  for (const [over, re] of cases) {
    const errs = errorsOf({ ...job(), ...over });
    assert.ok(errs.some((e) => re.test(e)), `${JSON.stringify(over).slice(0, 90)}: ${errs.join(' | ')}`);
  }
});

test('validate: anything but read needs "writes": true; write-class at organization depth and writes on security tables are refused', () => {
  const w = (privs, extra = {}) => ({ ...job({ privileges: privs }), ...extra });
  // A write needs the flag.
  assert.ok(errorsOf({ ...w([{ table: 'contact', access: ['read', 'write'], depth: 'user' }]), writes: undefined }).some((e) => /write on contact needs "writes": true/.test(e)));
  // With it, a user-depth write passes and the job says it writes.
  const ok = valid(w([{ table: 'contact', access: ['read', 'write', 'append', 'appendto'], depth: 'businessunit' }]));
  assert.equal(ok.writes, true);
  // The flag with nothing but read is refused (keep the job honest).
  assert.ok(errorsOf({ ...job(), writes: true }).some((e) => /"writes": true but every privilege is read/.test(e)));
  // Organization depth: append / appendto may go; create, write, delete, assign, share may not.
  assert.deepEqual(errorsOf(w([{ table: 'contact', access: ['read', 'append', 'appendto'], depth: 'organization' }])), []);
  for (const a of ['create', 'write', 'delete', 'assign', 'share']) {
    const errs = errorsOf(w([{ table: 'contact', access: ['read', a], depth: 'organization' }]));
    assert.ok(errs.some((e) => new RegExp(`${a} at organization depth is never given here`).test(e)), `${a}: ${errs.join(' | ')}`);
  }
  // The security and code tables: read is fine, anything else is not.
  assert.deepEqual(errorsOf(job({ privileges: [{ table: 'role', access: ['read'], depth: 'organization' }] })), []);
  for (const t of ['role', 'systemuser', 'team', 'workflow', 'webresource', 'sbrm_dataversewritelog', 'pluginassembly', 'businessunit']) {
    const errs = errorsOf(w([{ table: t, access: ['append'], depth: 'user' }]));
    assert.ok(errs.some((e) => new RegExp(`${t} decides who can do what or runs code, so a role made here may only read it`).test(e)), `${t}: ${errs.join(' | ')}`);
  }
  assert.ok(S.PROTECTED.has('sbrm_dataversewritelog'));
  assert.ok(!S.WRITE_CLASS.has('append') && !S.WRITE_CLASS.has('read'));
});

// ---------- plan ----------

test('plan: reads only; resolves every privilege from table metadata at the asked depth; root unit; summary and detail', async () => {
  const dv = dvAs();
  const plan = await S.planSecurityRole(dv, valid(job()), ctx());
  assert.deepEqual(nonGets(dv), []);
  assert.equal(plan.kind, 'securityrole');
  assert.equal(plan.mode, 'securityrole');
  assert.equal(plan.action, 'create');
  assert.equal(plan.need, 'admin');
  assert.deepEqual(plan.unit, { id: IDS.rootBu, name: 'SBRM Homeless' });
  assert.deepEqual(plan.privileges.map((p) => [p.privilege_name, p.depth, p.privilege_id]), [
    ['prvReadsbrm_guest', 'Global', pid('prvReadsbrm_guest')], ['prvReadsbrm_bednight', 'Global', pid('prvReadsbrm_bednight')]]);
  assert.equal(plan.writes, false);
  assert.deepEqual(plan.severity.lasting, []);
  assert.equal(plan.severity.count, 2);
  const s = S.securityRoleSummary(plan);
  assert.match(s, /Create the security role '#_ sbrmapps Test Job \(read\)' in the HGS apps \(2 privileges, read only\)/);
  assert.match(s, /sbrm_guest: read \(organization\)/);
  assert.match(s, /baseline/);
  assert.match(s, /it deletes the role, while nobody holds it/);
  assert.match(S.securityRoleDetail(plan, { id: 'P' }), /prvReadsbrm_guest at Global/);
  const w = await S.planSecurityRole(dvAs(), valid(job({ privileges: [{ table: 'contact', access: ['read', 'write'], depth: 'user' }] })), ctx());
  assert.match(S.securityRoleSummary(w), /\(2 privileges, WRITES\)/);
  assert.deepEqual(w.privileges.map((p) => [p.access, p.depth]), [['read', 'Basic'], ['write', 'Basic']]);
});

test('plan: a taken name, an unknown table, a depth the table cannot take, and admin only are refused (every problem named)', async () => {
  await refused(S.planSecurityRole(dvAs(), valid(job({ name: '#_ sbrmapps Mail Guide (read)' })), ctx()), /a role named '#_ sbrmapps Mail Guide \(read\)' already exists/, 'invalid_job');
  await refused(S.planSecurityRole(dvAs(), valid(job({ privileges: [{ table: 'sbrm_nope', access: ['read'], depth: 'user' }] })), ctx()), /there is no table named sbrm_nope/, 'invalid_job');
  await refused(S.planSecurityRole(dvAs(), valid(job({ privileges: [{ table: 'sbrm_setting', access: ['read'], depth: 'user' }] })), ctx()),
    /read on sbrm_setting cannot be given at user depth \(an organization-owned table\); it allows organization/, 'invalid_job');
  await refused(S.planSecurityRole(dvAs(), valid(job({ privileges: [{ table: 'sbrm_setting', access: ['read', 'assign'], depth: 'user' }] })), ctx()), /sbrm_setting has no assign privilege/, 'invalid_job');
  // Both problems at once, not one at a time.
  await assert.rejects(S.planSecurityRole(dvAs(), valid(job({ name: '#_ sbrmapps Mail Guide (read)', privileges: [{ table: 'sbrm_nope', access: ['read'], depth: 'user' }] })), ctx()),
    (e) => /already exists/.test(e.message) && /no table named sbrm_nope/.test(e.message));
  await refused(S.planSecurityRole(dvAs('dev@example.org'), valid(job()), ctx()), /takes admin access; Test Admin has develop/, 'not_permitted');
  await refused(S.planSecurityRole(dvAs('nobody@example.org'), valid(job()), ctx()), /has read/, 'access_read');
});

// ---------- apply ----------

test('apply: creates the role, reads the baseline, adds exactly the asked privileges at their depth, reads all back', async () => {
  const dv = dvAs();
  const plan = await S.planSecurityRole(dv, valid(job({ description: 'Reads guests and bed nights for the test job.' })), ctx());
  dv.calls.length = 0;
  const { res, shown, fileGone } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.entry.rows[0]));
  assert.ok(fileGone);
  assert.match(shown[0].summaryText, /Create the security role/);
  const w = nonGets(dv);
  assert.deepEqual(w.map((c) => c.verb), ['createRole', 'addRolePrivileges']);
  assert.deepEqual({ name: w[0].name, unitId: w[0].unitId, description: w[0].description }, { name: NAME, unitId: IDS.rootBu, description: 'Reads guests and bed nights for the test job.' });
  assert.deepEqual(w[1].privileges, [
    { PrivilegeId: pid('prvReadsbrm_guest'), Depth: 'Global', BusinessUnitId: IDS.rootBu },
    { PrivilegeId: pid('prvReadsbrm_bednight'), Depth: 'Global', BusinessUnitId: IDS.rootBu }]);
  const role = roleNamed(dv, NAME);
  const row = res.entry.rows[0];
  assert.equal(row.id, role.roleid);
  assert.equal(row.after.role_id, role.roleid);
  assert.deepEqual(row.baseline.map((p) => p.name).sort(), [...BASELINE].sort());
  assert.deepEqual(row.after.privileges.map((p) => p.name).sort(), [...BASELINE, 'prvReadsbrm_bednight', 'prvReadsbrm_guest'].sort());
  assert.deepEqual(row.asked, [{ name: 'prvReadsbrm_guest', depth: 'Global' }, { name: 'prvReadsbrm_bednight', depth: 'Global' }]);
  assert.equal(res.entry.mode, 'securityrole');
  assert.equal(res.entry.table, 'roles');
  assert.ok(dv.calls.some((c) => c.method === 'GET' && c.strong && /^RetrieveRolePrivilegesRole/.test(c.path)), 'read-back past the cache');
  assert.match(row.changes[0].new_text, /2 asked, 11 held/);
});

test('apply: the read-back catches a privilege the platform left out, one it added, or a wrong depth', async () => {
  for (const [setup, re] of [
    [(d) => { d.privsDrop = 'prvReadsbrm_guest'; }, /read-back mismatch: missing prvReadsbrm_guest \(Global\)/],
    [(d) => { d.privsExtra = 'prvDeletecontact'; }, /read-back mismatch: unexpected prvDeletecontact \(Global\)/],
  ]) {
    const dv = dvAs();
    const plan = await S.planSecurityRole(dv, valid(job()), ctx());
    setup(dv);
    const { res } = await applied(plan, dv);
    assert.equal(res.outcome, 'applied with problems');
    assert.match(res.entry.rows[0].outcome, re);
  }
  // A depth other than the asked one is a mismatch both ways (missing at Basic, unexpected at Global).
  const dv = dvAs();
  const plan = await S.planSecurityRole(dv, valid(job({ privileges: [{ table: 'contact', access: ['read'], depth: 'user' }] })), ctx());
  const realAdd = dv.addRolePrivileges;
  dv.addRolePrivileges = (id, ps) => realAdd(id, ps.map((p) => ({ ...p, Depth: 'Global' })));
  const { res } = await applied(plan, dv);
  assert.match(res.entry.rows[0].outcome, /missing prvReadcontact \(Basic\).*unexpected prvReadcontact \(Global\)/);
});

test('apply: a failed privilege add leaves the role logged with what it holds, so revert can delete it', async () => {
  const dv = dvAs();
  const plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.failOn = 'addRolePrivileges';
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  const row = res.entry.rows[0];
  assert.match(row.outcome, /^failed: Privilege add failed/);
  assert.equal(row.after.role_id, roleNamed(dv, NAME).roleid);
  assert.deepEqual(row.after.privileges.map((p) => p.name).sort(), [...BASELINE].sort());
  const undo = await S.planSecurityRoleRevert(dv, JSON.parse(JSON.stringify(res.entry)), ctx());
  assert.equal(undo.action, 'delete');
  const back = await applied(undo, dv);
  assert.equal(back.res.outcome, 'applied');
  assert.equal(roleNamed(dv, NAME), undefined);
});

test('apply: a create that answers with no id finds the role by name in the root unit; a failed create logs no role', async () => {
  let dv = dvAs();
  let plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.createReturnsNoId = true;
  let { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied');
  assert.equal(res.entry.rows[0].id, roleNamed(dv, NAME).roleid);
  const { DataverseError } = require('../lib/cli');
  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.failNext = new DataverseError('denied', { code: '0x80040220' });
  ({ res } = await applied(plan, dv));
  assert.match(res.entry.rows[0].outcome, /^failed: denied/);
  assert.equal(res.entry.rows[0].after, null);
  assert.equal(res.entry.rows[0].id, null);
});

test('apply: refused when the name was taken, the unit went, or a table changed since the plan; and on tamper, staleness, another person', async () => {
  let dv = dvAs();
  let plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.data.roles.push({ roleid: 'e5000000-0000-0000-0000-000000000001', name: NAME, _parentrootroleid_value: 'e5000000-0000-0000-0000-000000000001', _businessunitid_value: IDS.rootBu, ismanaged: false });
  await applyRefused(applied(plan, dv), /a role named '#_ sbrmapps Test Job \(read\)' exists since the plan/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  delete dv.data.tables.sbrm_bednight;
  await applyRefused(applied(plan, dv), /the tables changed since the plan: there is no table named sbrm_bednight/, 'snapshot_moved');
  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.data.tables.sbrm_guest.Privileges.find((p) => p.PrivilegeType === 'Read').PrivilegeId = 'f6000000-0000-0000-0000-000000000001';
  await applyRefused(applied(plan, dv), /prvReadsbrm_guest is not what the table's metadata says since the plan/, 'snapshot_moved');
  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.data.businessunits = dv.data.businessunits.filter((b) => b.businessunitid !== IDS.rootBu);
  await applyRefused(applied(plan, dv), /business unit SBRM Homeless is gone since the plan/, 'snapshot_moved');

  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  const file = path.join(HOME, 'y.json');
  fs.writeFileSync(file, '{}');
  const deps = { access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }) };
  const fresh = { ...plan, created: new Date().toISOString() };
  await applyRefused(S.applySecurityRole({ ...fresh, created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, deps, { id: 'p', file, fs }), /more than 24 hours old/, 'stale_plan');
  const tamper = [
    { mode: 'role' }, { name: 'System Administrator' }, { unit: { id: 'x' } }, { privileges: [] }, { action: 'grant' },
    { privileges: [{ ...plan.privileges[0], access: 'write' }] },                                    // a write on a read-only role
    { writes: true, privileges: [{ ...plan.privileges[0], access: 'write', depth: 'Global' }] },      // write-class at organization depth
    { writes: true, privileges: [{ ...plan.privileges[0], table: 'role', access: 'append', depth_word: 'user', depth: 'Basic' }] }, // append on a protected table
    { privileges: [{ ...plan.privileges[0], depth: 'Basic' }] },                                     // depth word and depth disagree
    { privileges: [{ ...plan.privileges[0], privilege_id: 'x' }] },
  ];
  for (const bad of tamper) {
    await applyRefused(S.applySecurityRole({ ...fresh, ...bad }, deps, { id: 'p', file, fs }), /no security role plan writes/, 'plan_tampered');
  }
  const other = fakeIdentityDv({ email: 'tim@example.org', userId: IDS.tim });
  await applyRefused(S.applySecurityRole(fresh, { ...deps, connect: () => other }, { id: 'p', file, fs }), /you are signed in as Tim Molloy/, 'different_person');
  await applyRefused(S.applySecurityRole(fresh, { ...deps, access: { people: { 'admin@example.org': { envs: { hgs: 'develop' } } } } }, { id: 'p', file, fs }), /you have develop/, 'access_revoked');
  const { res } = await applied(plan, dv, { confirm: () => ({ approved: false }) });
  assert.equal(res.outcome, 'cancelled');
  assert.deepEqual(nonGets(dv), []);
});

// ---------- revert ----------

const entryFrom = (res) => JSON.parse(JSON.stringify(res.entry));

test('revert: deletes the role it made (every business unit copy goes with it), version-tagged, read back gone', async () => {
  const dv = dvAs();
  const { res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv);
  const id = res.entry.rows[0].id;
  assert.equal(dv.data.roles.filter((r) => r._parentrootroleid_value === id).length, 2, 'root + the child unit copy');
  const undo = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  assert.equal(undo.action, 'delete');
  assert.equal(undo.role_id, id);
  assert.equal(undo.reverts_plan_id, res.entry.plan_id);
  assert.ok(undo.severity.irreversible.length === 1 && /re-creating it makes a new role/.test(undo.severity.irreversible[0]));
  assert.match(S.securityRoleSummary(undo), /Delete the security role '#_ sbrmapps Test Job \(read\)'/);
  dv.calls.length = 0;
  const back = await applied(undo, dv);
  assert.equal(back.res.outcome, 'applied');
  const del = nonGets(dv);
  assert.deepEqual(del.map((c) => [c.verb, c.roleId, c.etag]), [['deleteRole', id, 'W/"1"']]);
  assert.equal(dv.data.roles.filter((r) => r._parentrootroleid_value === id).length, 0);
  assert.deepEqual(back.res.entry.rows[0].after, { exists: false });
  // A delete is not undone here.
  await refused(S.planSecurityRoleRevert(dv, entryFrom(back.res), ctx()), /a deleted role is not brought back here/, 'nothing_to_undo');
});

test('revert: refused while anyone holds the role (a person, an application user or a team, through any copy) or its privileges moved', async () => {
  const setups = [
    [(dv, id) => { dv.data.userroles.push({ user: IDS.tim, role: id }); }, /held by Tim Molloy; take it from them first/],
    [(dv, id) => { const child = dv.data.roles.find((r) => r._parentrootroleid_value === id && r.roleid !== id); dv.data.userroles.push({ user: IDS.ourApp, role: child.roleid }); }, /held by # sbrmapps - Mail Sorting Guide/],
    [(dv, id) => { dv.data.teamroles.push({ team: IDS.team, role: id }); }, /held by the team Homeless Program/],
    [(dv, id) => { dv.data.roleprivs[id].push({ name: 'prvReadcontact', depth: 'Basic' }); }, /privileges changed since plan/],
    [(dv, id) => { dv.data.roles.find((r) => r.roleid === id).name = '#_ renamed'; }, /is now named '#_ renamed'/],
    [(dv, id) => { dv.data.roles = dv.data.roles.filter((r) => r._parentrootroleid_value !== id); }, /already gone/],
  ];
  for (const [setup, re] of setups) {
    const dv = dvAs();
    const { res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv);
    setup(dv, res.entry.rows[0].id);
    await refused(S.planSecurityRoleRevert(dv, entryFrom(res), ctx()), re);
  }
  // Moved between the undo plan and its apply: refused at apply, nothing deleted.
  const dv = dvAs();
  const { res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv);
  const undo = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  dv.data.userroles.push({ user: IDS.tim, role: res.entry.rows[0].id });
  await applyRefused(applied(undo, dv), /held by Tim Molloy/, 'not_permitted');
  assert.ok(roleNamed(dv, NAME));
});

test('revert: refuses forged or damaged entries, other kinds, other environments, and Microsoft roles', async () => {
  const dv = dvAs();
  const { res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv);
  const e = entryFrom(res);
  const r0 = e.rows[0];
  await refused(S.planSecurityRoleRevert(dv, { ...e, mode: 'appuser' }, ctx()), /not a security role change/, 'nothing_to_undo');
  await refused(S.planSecurityRoleRevert(dv, { ...e, outcome: 'cancelled' }, ctx()), /outcome is "cancelled"/, 'nothing_to_undo');
  await refused(S.planSecurityRoleRevert(dv, { ...e, env: 'recovery' }, ctx()), /made in the Recovery app/, 'invalid_job');
  await refused(S.planSecurityRoleRevert(dv, { ...e, rows: [{ ...r0, role: { name: 'System Administrator' } }] }, ctx()), /no valid role or action/, 'invalid_job');
  await refused(S.planSecurityRoleRevert(dv, { ...e, rows: [{ ...r0, after: null }] }, ctx()), /did not make a role/, 'nothing_to_undo');
  await refused(S.planSecurityRoleRevert(dv, { ...e, rows: [{ ...r0, after: { role_id: r0.id, privileges: null } }] }, ctx()), /no read-back of the role's privileges/, 'invalid_job');
  dv.data.roles.find((r) => r.roleid === r0.id).ismanaged = true;
  await refused(S.planSecurityRoleRevert(dv, e, ctx()), /Microsoft \(managed\) role; it is never deleted here/, 'not_permitted');
});

// ---------- the write connection's verbs ----------

test('identityCall: role verbs have fixed paths; names, depths, ids and version tags are checked', () => {
  const { identityCall } = require('../lib/write');
  assert.deepEqual(identityCall('createRole', { name: NAME, unitId: IDS.rootBu, description: 'd' }),
    { method: 'POST', path: 'roles', body: { name: NAME, 'businessunitid@odata.bind': `/businessunits(${IDS.rootBu})`, description: 'd' }, headers: ['Prefer: return=representation'] });
  assert.ok(!('description' in identityCall('createRole', { name: NAME, unitId: IDS.rootBu }).body));
  const p = [{ PrivilegeId: pid('prvReadcontact'), Depth: 'Local', BusinessUnitId: IDS.rootBu }];
  assert.deepEqual(identityCall('addRolePrivileges', { roleId: IDS.mailRole, privileges: p }),
    { method: 'POST', path: `roles(${IDS.mailRole})/Microsoft.Dynamics.CRM.AddPrivilegesRole`, body: { Privileges: p }, headers: [] });
  assert.deepEqual(identityCall('deleteRole', { roleId: IDS.mailRole, etag: 'W/"3"' }), { method: 'DELETE', path: `roles(${IDS.mailRole})`, body: undefined, headers: ['If-Match: W/"3"'] });
  assert.throws(() => identityCall('createRole', { name: 'a\nb', unitId: IDS.rootBu }), /one line/);
  assert.throws(() => identityCall('createRole', { name: NAME, unitId: IDS.rootBu, description: 'x'.repeat(2001) }), /at most 2000/);
  assert.throws(() => identityCall('addRolePrivileges', { roleId: IDS.mailRole, privileges: [{ ...p[0], Depth: 'Everything' }] }), /depth "Everything"/);
  assert.throws(() => identityCall('addRolePrivileges', { roleId: IDS.mailRole, privileges: [] }), /1 to 400/);
  assert.throws(() => identityCall('addRolePrivileges', { roleId: IDS.mailRole, privileges: [{ ...p[0], PrivilegeId: 'x' }] }), /not a GUID/);
  assert.throws(() => identityCall('addRolePrivileges', { roleId: 'roles', privileges: p }), /not a GUID/);
  assert.throws(() => identityCall('deleteRole', { roleId: IDS.mailRole }), /version tag/);
});

test('mutation gap (11/9): a read-only plan carrying a non-read access that no other rule catches is refused at apply', async () => {
  const dv = dvAs();
  const plan = await S.planSecurityRole(dv, valid(job({ privileges: [{ table: 'sbrm_guest', access: ['read'], depth: 'user' }] })), ctx());
  const file = path.join(HOME, 'z.json');
  fs.writeFileSync(file, '{}');
  // append at user depth on an ordinary table: not write-class, not organization depth, not protected. Only "read-only" stops it.
  const bad = { ...plan, created: new Date().toISOString(), privileges: [{ ...plan.privileges[0], access: 'append' }] };
  await applyRefused(S.applySecurityRole(bad, { access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }) }, { id: 'p', file, fs }), /append on a read-only role/, 'plan_tampered');
  assert.deepEqual(nonGets(dv), []);
});

// ---------- review C1 (11/9, run 20261109-121738-2cdbf1): written red first ----------

test('review F7: a holder added while the delete approval waits stops the delete', async () => {
  const dv = dvAs();
  const { res } = await applied(await S.planSecurityRole(dv, valid(job()), ctx()), dv);
  const undo = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  dv.calls.length = 0;
  await applyRefused(applied(undo, dv, { confirm: () => { dv.data.userroles.push({ user: IDS.tim, role: res.entry.rows[0].id }); return { approved: true }; } }),
    /while the approval was waiting.*held by Tim Molloy/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
  assert.ok(roleNamed(dv, NAME));
});

test('review F10: a privilege outside Dataverse\'s known baseline found before the add is a read-back mismatch, not baseline', async () => {
  const dv = dvAs();
  const plan = await S.planSecurityRole(dv, valid(job()), ctx());
  const realCreate = dv.createRole;
  dv.createRole = (...a) => { const r = realCreate(...a); dv.data.roleprivs[r.roleid].push({ name: 'prvDeletecontact', depth: 'Global' }); return r; };
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.entry.rows[0].outcome, /read-back mismatch:.*unexpected prvDeletecontact \(Global\)/);
});

test('review F12: a create whose response is lost after it committed is found by name, logged with its id, and revertable', async () => {
  const { DataverseError } = require('../lib/cli');
  const dv = dvAs();
  const plan = await S.planSecurityRole(dv, valid(job()), ctx());
  const realCreate = dv.createRole;
  dv.createRole = (...a) => { realCreate(...a); throw new DataverseError('The operation timed out', { code: 'timeout' }); };
  const { res } = await applied(plan, dv);
  const row = res.entry.rows[0];
  assert.match(row.outcome, /^failed: The operation timed out/);
  assert.equal(row.id, roleNamed(dv, NAME).roleid);
  assert.equal(row.after.role_id, row.id);
  const undo = await S.planSecurityRoleRevert(dv, entryFrom(res), ctx());
  assert.equal(undo.action, 'delete');
});

test('review F9: the summary and the prompt say the baseline carries Create and Write on SharePoint data', async () => {
  const plan = await S.planSecurityRole(dvAs(), valid(job()), ctx());
  assert.match(S.securityRoleSummary(plan), /Create and Write on SharePoint data/);
});

test('mutation gaps (11/9, round 2): a name taken while the approval waits is refused; a baseline privilege that only appears with the add is unexpected', async () => {
  let dv = dvAs();
  let plan = await S.planSecurityRole(dv, valid(job()), ctx());
  dv.calls.length = 0;
  await applyRefused(applied(plan, dv, { confirm: () => { dv.data.roles.push({ roleid: 'e5000000-0000-0000-0000-000000000009', name: NAME, _parentrootroleid_value: 'e5000000-0000-0000-0000-000000000009', _businessunitid_value: IDS.rootBu, ismanaged: false }); return { approved: true }; } }),
    /was made while the approval was waiting/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
  // The baseline is what the role held BEFORE the add: a known-baseline name that shows up only after it was not given by Dataverse at create.
  dv = dvAs();
  plan = await S.planSecurityRole(dv, valid(job()), ctx());
  const realCreate = dv.createRole;
  dv.createRole = (...a) => { const r = realCreate(...a); dv.data.roleprivs[r.roleid] = dv.data.roleprivs[r.roleid].filter((p) => p.name !== 'prvWriteSharePointData'); return r; };
  dv.privsExtra = 'prvWriteSharePointData';
  const { res } = await applied(plan, dv);
  assert.match(res.entry.rows[0].outcome, /unexpected prvWriteSharePointData \(Global\)/);
});
