'use strict';
// The round-1 blind review of the role edit and the button hide (11/23/26, reviews\2026-11-23_role_edit_command): one
// test per fixed finding, on the same fakes as securityrole_remove.test.js and command.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-r1-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const S = require('../lib/securityrole');
const C = require('../lib/command');
const { DataverseError } = require('../lib/cli');
const FI = require('./fake_identity');
const FC = require('./fake_command');

const nonGets = (dv) => dv.calls.filter((c) => c.method !== 'GET');
const entryFrom = (res) => JSON.parse(JSON.stringify(res.entry));
async function rejects(promise, name, re, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, name, e.stack);
    assert.match(e.message, re);
    if (code) assert.equal(e.code, code);
    return true;
  });
}
let fileN = 0;
async function applied(applyFn, plan, dv, access, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await applyFn({ ...plan, created: new Date().toISOString() }, {
    access, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, ...over,
  }, { id: `20261123-1700${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown };
}

// ---------- role edit ----------

const ROLE = '#_ SBRM Normal';
const roleDv = (over = {}) => FI.fakeIdentityDv({ email: 'admin@example.org', d: FI.withNormal(), ...over });
const roleCtx = () => ({ envs: FI.ENVS, access: FI.ACCESS, warnRows: 50 });
function roleJob(remove = [{ table: 'sbrm_guest', access: ['create'] }]) {
  const n = remove.reduce((k, p) => k + p.access.length, 0);
  const raw = { contract: 'sbrm-dv-job/1', kind: 'securityrole', env: 'hgs', role: ROLE, remove, source: 'claude-session',
    reason: 'Operators should not make guest rows by hand.', intent: { verb: 'securityrole', role: ROLE, action: 'remove', privileges: n } };
  const r = S.validateSecurityRoleJob(raw, { envs: FI.ENVS });
  assert.deepEqual(r.errors, []);
  return r.job;
}
const roleApply = (plan, dv, over) => applied(S.applySecurityRole, plan, dv, FI.ACCESS, over);
function addPerson(dv, name) {
  const id = `a1000000-0000-0000-0000-0000000000${String(dv.data.systemusers.length).padStart(2, '0')}`;
  dv.data.systemusers.push({ systemuserid: id, fullname: name, applicationid: null, accessmode: 0, isdisabled: false, _businessunitid_value: FI.IDS.rootBu });
  dv.data.userroles.push({ user: id, role: FI.IDS.normal });
}

// The person approves on the guard's prompt, built from the PLAN before apply runs, so any change is refused.
test('review F12: who holds the role, and the other roles, are read again at apply; any change since the plan is refused', async () => {
  const changes = [
    ['a new holder', (dv) => addPerson(dv, 'New Operator'), /now held by 2 people and 1 team/],
    ['a holder gone', (dv) => { dv.data.userroles = dv.data.userroles.filter((g) => g.user !== FI.IDS.tim); }, /now held by 1 team/],
    ['another role now gives it', (dv) => {
      const r = '95d443f4-0000-0000-0000-0000000000c1';
      dv.data.roles.push({ roleid: r, name: '#_ Late Role', _parentrootroleid_value: r, _businessunitid_value: FI.IDS.rootBu, ismanaged: false });
      dv.data.roleprivs[r] = [{ name: 'prvCreatesbrm_guest', depth: 'Global' }];
    }, /changed since the plan/],
  ];
  for (const [what, change, re] of changes) {
    const dv = roleDv();
    const plan = await S.planSecurityRole(dv, roleJob(), roleCtx());
    change(dv);
    await rejects(roleApply(plan, dv), 'ApplyRefused', re, 'snapshot_moved');
    assert.deepEqual(nonGets(dv), [], `nothing was written (${what})`);
  }
  // nothing changed: it goes through, and the prompt is the plan's
  const dv = roleDv();
  const plan = await S.planSecurityRole(dv, roleJob(), roleCtx());
  const { res, shown } = await roleApply(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.entry.rows));
  assert.equal(shown[0].summaryText, S.securityRoleSummary({ ...plan, access: 'admin' }));
});

test('advisor 11/23: the privileges taken off are worked out again from the table and the role, never from the plan alone', async () => {
  const cases = [
    ['another privilege id under the same table and access', (p) => { p.privileges[0].privilege_id = FI.pid('prvReadrole'); }, /create on sbrm_guest is not the privilege the plan names/],
    ['another name', (p) => { p.privileges[0].privilege_name = 'prvCreatecontact'; }, /is not the privilege the plan names/],
    ['a wider logged depth', (p) => { p.privileges[0].depth = 'Basic'; }, /does not hold prvCreatesbrm_guest at Basic now/],
  ];
  for (const [what, edit, re] of cases) {
    const dv = roleDv();
    const plan = JSON.parse(JSON.stringify(await S.planSecurityRole(dv, roleJob(), roleCtx())));
    edit(plan);
    await rejects(roleApply(plan, dv), 'ApplyRefused', re, 'plan_tampered');
    assert.deepEqual(nonGets(dv), [], `nothing was written (${what})`);
  }
});

test('review F13: the undo of a removal shows who holds the role and which other roles give it, read again at apply', async () => {
  const dv = roleDv();
  const { res } = await roleApply(await S.planSecurityRole(dv, roleJob(), roleCtx()), dv);
  const undo = await S.planSecurityRoleRevert(dv, entryFrom(res), roleCtx());
  assert.deepEqual(undo.holders.people, ['Tim Molloy']);
  const s = S.securityRoleSummary(undo);
  assert.match(s, new RegExp(`Giving back, as the Write Log row for plan ${res.entry.plan_id} says it took them off:`));
  assert.match(s, /Held by: 1 person and 1 team \(teams: Homeless Program\); each of them gains these again\./);
  assert.match(s, /Also given by other roles:\n {4}prvCreatesbrm_guest: System Administrator \(at organization depth; 1 person; 1 application user\)/);
  assert.match(S.securityRoleDetail(undo), /Held by: Tim Molloy; teams: Homeless Program/);
  addPerson(dv, 'New Operator');
  await rejects(roleApply(undo, dv), 'ApplyRefused', /changed since the plan \(now held by 2 people and 1 team\)/, 'snapshot_moved');
});

test('review F30: a root role whose parent-root reads null still counts its own holders', async () => {
  const dv = roleDv();
  dv.data.roles.find((r) => r.roleid === FI.IDS.normal)._parentrootroleid_value = null;
  const plan = await S.planSecurityRole(dv, roleJob(), roleCtx());
  assert.deepEqual(plan.holders.people, ['Tim Molloy']);
  assert.deepEqual(plan.holders.teams, ['Homeless Program']);
});

test('review F9 + F22: every other role giving the privilege is listed, held or not, with the depth it gives it at', async () => {
  const dv = roleDv();
  const basic = '95d443f4-0000-0000-0000-0000000000b1';
  dv.data.roles.push({ roleid: basic, name: '#_ SBRM Own Rows', _parentrootroleid_value: basic, _businessunitid_value: FI.IDS.rootBu, ismanaged: false });
  dv.data.roleprivs[basic] = [{ name: 'prvCreatesbrm_guest', depth: 'Basic' }];
  const plan = await S.planSecurityRole(dv, roleJob(), roleCtx());
  const s = S.securityRoleSummary(plan);
  assert.match(s, /anyone holding one keeps it at that role's depth/);
  assert.match(s, /#_ SBRM Own Rows \(at user depth; held by nobody\)/);
  assert.match(s, /System Administrator \(at organization depth; 1 person; 1 application user\)/);
});

test('review F15: the users table\'s privileges (prvWriteUser) are a security table for an undo', async () => {
  const dv = roleDv();
  const { res } = await roleApply(await S.planSecurityRole(dv, roleJob(), roleCtx()), dv);
  const e = entryFrom(res);
  e.rows[0].before.privileges[0] = { name: 'prvWriteUser', id: FI.pid('prvWriteUser'), depth: 'Global' };
  await rejects(S.planSecurityRoleRevert(dv, e, roleCtx()), 'PlanRefused', /prvWriteUser is on a security or code table; it is never given back here/, 'invalid_job');
});

// ---------- button hide ----------

const TABLE = 'sbrm_waitlistcount';
const cmdDv = () => FC.fakeCommandDv({ email: 'admin@example.org' });
const cmdCtx = (over = {}) => ({ envs: FC.ENVS, access: FC.ACCESS, warnRows: 50, ...over });
function cmdJob(over = {}) {
  const where = over.where || ['list'];
  const raw = { contract: 'sbrm-dv-job/1', kind: 'command', env: 'hgs', app: 'sbrm_Homeless', table: TABLE, hide: ['deactivate'], where, solution: 'SBRMWaitlistCount',
    source: 'claude-session', reason: 'Nightly rows.', intent: { verb: 'command', action: 'hide', app: 'sbrm_Homeless', table: TABLE, buttons: where.length }, ...over };
  const r = C.validateCommandJob(raw, { envs: FC.ENVS });
  assert.deepEqual(r.errors, []);
  return r.job;
}
const cmdApply = (plan, dv, over) => applied(C.applyCommand, plan, dv, FC.ACCESS, over);
const tmpl = (dv, button, location) => dv.data.appactions.find((r) => r.context === 0 && r.location === location && r.name.endsWith(`.${button}`));

test('review F18 + F19 + F32: a managed table, a solution not under the SBRM publisher, and a template that is not a plain button are refused', async () => {
  let dv = cmdDv();
  const ok = await C.planCommand(dv, cmdJob(), cmdCtx());
  assert.equal(ok.steps[0].template.fields.visibilitytype, 2);
  dv.data.managedTables = [TABLE];
  await rejects(C.planCommand(dv, cmdJob(), cmdCtx()), 'PlanRefused', /sbrm_waitlistcount is a managed table; its buttons are changed in the maker portal/, 'invalid_job');
  dv = cmdDv();
  await rejects(C.planCommand(dv, cmdJob({ solution: 'Default' }), cmdCtx()), 'PlanRefused', /the solution Default is not under the SBRM publisher/, 'invalid_job');
  await rejects(C.planCommand(dv, cmdJob(), cmdCtx({ envs: { hgs: { host: 'https://hgs.invalid', name: 'HGS apps' } } })), 'PlanRefused', /envs\.json names no SBRM publisher for the HGS apps/, 'invalid_job');
  for (const [field, value] of [['type', 1], ['visibilitytype', 5]]) {
    dv = cmdDv();
    tmpl(dv, 'Deactivate', 1)[field] = value;
    await rejects(C.planCommand(dv, cmdJob(), cmdCtx()), 'PlanRefused', /is not a plain JavaScript button here, so it cannot be copied/, 'invalid_job');
  }
  assert.deepEqual(nonGets(dv), []);
});

test('review F21: a new row that lands but loses its answer is found, logged, and can be shown again', async () => {
  const dv = cmdDv();
  const plan = await C.planCommand(dv, cmdJob(), cmdCtx());
  const make = dv.createCommandHide;
  dv.createCommandHide = (...a) => { make(...a); throw new DataverseError('The request timed out', { code: 'timeout' }); };
  const { res } = await cmdApply(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  const row = res.entry.rows[0];
  assert.match(row.outcome, /^failed: The request timed out \(the new row [0-9a-f-]{36} was made, 0 of 2 rules linked; revert shows the button again\)$/);
  assert.equal(row.after.hidden, true);
  dv.createCommandHide = make;
  const undo = await C.planCommandRevert(dv, entryFrom(res), cmdCtx());
  assert.deepEqual(undo.steps.map((s) => s.row.id), [row.id]);
  const back = await cmdApply(undo, dv);
  assert.equal(back.res.outcome, 'applied', JSON.stringify(back.res.entry.rows));
  assert.equal(dv.data.appactions.find((r) => r.appactionid === row.id).hidden, false);
});

test('review F21: a flip that landed but could not be read back is logged; a flip refused before it landed is not', async () => {
  let dv = cmdDv();
  let o = FC.override(dv.data, { hidden: false });
  let plan = await C.planCommand(dv, cmdJob(), cmdCtx());
  let flipped = false;
  let thrown = false;
  const flip = dv.setCommandHidden;
  dv.setCommandHidden = (...a) => { const r = flip(...a); flipped = true; return r; };
  const get = dv.get;
  dv.get = (p, opts) => {
    if (flipped && !thrown && p.startsWith(`appactions(${o.appactionid})`)) { thrown = true; throw new DataverseError('Service unavailable', { status: 503 }); }
    return get(p, opts);
  };
  let { res } = await cmdApply(plan, dv);
  assert.match(res.entry.rows[0].outcome, /^failed: Service unavailable$/);
  assert.deepEqual([res.entry.rows[0].after.id, res.entry.rows[0].after.hidden], [o.appactionid, true]);
  const undo = await C.planCommandRevert(dv, entryFrom(res), cmdCtx());
  assert.deepEqual(undo.steps.map((s) => s.row.id), [o.appactionid]);

  dv = cmdDv();
  o = FC.override(dv.data, { hidden: false });
  plan = await C.planCommand(dv, cmdJob(), cmdCtx());
  dv.failOn = 'setCommandHidden';
  ({ res } = await cmdApply(plan, dv));
  assert.match(res.entry.rows[0].outcome, /^failed: setCommandHidden failed$/);
  assert.equal(res.entry.rows[0].after, null);
  await rejects(C.planCommandRevert(dv, entryFrom(res), cmdCtx()), 'PlanRefused', /hid nothing/, 'nothing_to_undo');
});

test('advisor 11/23: the app and the table are read again at apply; another app id or table id under the plan\'s names is refused', async () => {
  for (const edit of [(p) => { p.model_app.id = FC.IDS.otherApp; }, (p) => { p.table.metadata_id = 'e7000000-0000-0000-0000-000000000009'; }]) {
    const dv = cmdDv();
    const plan = JSON.parse(JSON.stringify(await C.planCommand(dv, cmdJob(), cmdCtx())));
    edit(plan);
    await rejects(cmdApply(plan, dv), 'ApplyRefused', /is not (app|the unmanaged table)/, 'snapshot_moved');
    assert.deepEqual(nonGets(dv), []);
  }
  const dv = cmdDv();
  const plan = await C.planCommand(dv, cmdJob(), cmdCtx());
  dv.data.managedTables = [TABLE]; // imported in a managed solution since the plan
  await rejects(cmdApply(plan, dv), 'ApplyRefused', /is not the unmanaged table/, 'snapshot_moved');
});

test('advisor 11/23: a hide that failed after linking every rule is not called short of rules', async () => {
  const dv = cmdDv();
  const plan = await C.planCommand(dv, cmdJob(), cmdCtx());
  let linked = 0;
  const link = dv.linkCommandRule;
  dv.linkCommandRule = (...a) => { const r = link(...a); linked += 1; if (linked === 2) throw new DataverseError('The request timed out', { code: 'timeout' }); return r; };
  const { res } = await cmdApply(plan, dv);
  assert.match(res.entry.rows[0].outcome, /1 of 2 rules linked/, 'the second link timed out before it was counted');
  // a full link then a failed read-back:
  const d2 = cmdDv();
  const p2 = await C.planCommand(d2, cmdJob(), cmdCtx());
  let made = null;
  const mk = d2.createCommandHide;
  d2.createCommandHide = (...a) => { const r = mk(...a); made = r.appactionid; return r; };
  const g2 = d2.get;
  let n = 0;
  d2.get = (p, o) => { if (made && p.startsWith(`appactions(${made})`) && n++ === 0) throw new DataverseError('Service unavailable', { status: 503 }); return g2(p, o); };
  const r2 = await cmdApply(p2, d2);
  assert.match(r2.res.entry.rows[0].outcome, /2 of 2 rules linked/);
  const undo = await C.planCommandRevert(d2, entryFrom(r2.res), cmdCtx());
  assert.doesNotMatch(C.commandSummary(undo), /stopped part-way/);
});

test('base mutation pass 11/23: an undo refuses a row that is now another button or place, and a show that does not land is a mismatch', async () => {
  for (const change of [(r) => { r.location = 0; }, (r) => { r.name = 'Mscrm.HomepageGrid.{!EntityLogicalName}.Activate'; }]) {
    const dv = cmdDv();
    const { res } = await cmdApply(await C.planCommand(dv, cmdJob(), cmdCtx()), dv);
    change(dv.data.appactions.find((r) => r.appactionid === res.entry.rows[0].id));
    await rejects(C.planCommandRevert(dv, entryFrom(res), cmdCtx()), 'PlanRefused', /it is not this button in this place/, 'snapshot_moved');
  }
  const dv = cmdDv();
  const { res } = await cmdApply(await C.planCommand(dv, cmdJob(), cmdCtx()), dv);
  const undo = await C.planCommandRevert(dv, entryFrom(res), cmdCtx());
  dv.ignoreHidden = true; // the platform answers OK but the row stays hidden
  const back = await cmdApply(undo, dv);
  assert.equal(back.res.outcome, 'applied with problems');
  assert.equal(back.res.entry.rows[0].outcome, 'read-back mismatch: the row still reads hidden');
});

test('review F28: the undo of a hide that stopped part-way says the row has fewer rules than the button', async () => {
  const dv = cmdDv();
  const plan = await C.planCommand(dv, cmdJob(), cmdCtx());
  dv.failOn = 'linkCommandRule';
  const { res } = await cmdApply(plan, dv);
  assert.match(res.entry.rows[0].outcome, /0 of 2 rules linked/);
  const undo = await C.planCommandRevert(dv, entryFrom(res), cmdCtx());
  assert.match(C.commandSummary(undo), /Deactivate on the list: the row carries fewer rules than the built-in button has, so it may show where it normally would not\./);
  // and in what Claude Code's prompt shows: the severity lines (round-2 review F17)
  assert.ok(undo.severity.lines.some((l) => /^Note: Deactivate on the list comes back with fewer visibility rules than the built-in button/.test(l)), JSON.stringify(undo.severity.lines));
});

// ---------- round 2 (blind review 11/23/26, reviews\2026-11-23_role_edit_command_r2) ----------

test('round-2 F2: a holder swapped for another account with the same name is a change, and refused', async () => {
  const dv = roleDv();
  const plan = await S.planSecurityRole(dv, roleJob(), roleCtx());
  const twin = 'a1000000-0000-0000-0000-0000000000f2';
  dv.data.systemusers.push({ systemuserid: twin, fullname: 'Tim Molloy', applicationid: null, accessmode: 0, isdisabled: false, _businessunitid_value: FI.IDS.rootBu });
  dv.data.userroles = dv.data.userroles.filter((g) => g.user !== FI.IDS.tim).concat([{ user: twin, role: FI.IDS.normal }]);
  await rejects(roleApply(plan, dv), 'ApplyRefused', /changed since the plan/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
});

test('round-2 F6 + F14 + F25: the prompt lines carry who is affected and the other roles; the undo says what it gives, in plain words', async () => {
  const dv = roleDv();
  const plan = await S.planSecurityRole(dv, roleJob(), roleCtx());
  assert.deepEqual(plan.severity.lines, ["Ends access: 1 person and 1 team holding '#_ SBRM Normal' lose create on sbrm_guest unless they hold another role giving it; also given by System Administrator (organization)."]);
  const { res } = await roleApply(plan, dv);
  assert.deepEqual(res.entry.rows[0].held_by, { people: ['Tim Molloy'], apps: [], teams: ['Homeless Program'], disabled: 0 }, 'round-2 F20: the log keeps who held it');
  const undo = await S.planSecurityRoleRevert(dv, entryFrom(res), roleCtx());
  assert.deepEqual(undo.severity.lines, ["Gives access: 1 person and 1 team holding '#_ SBRM Normal' gain create on sbrm_guest (organization); also given by System Administrator (organization)."]);
  assert.equal(undo.privileges[0].plain, 'create on sbrm_guest (organization)');
});

test('round-2 F15: a privilege shared by several tables is refused, at the plan and at apply', async () => {
  const dv = roleDv();
  dv.data.tables.email = { LogicalName: 'email', OwnershipType: 'UserOwned', Privileges: [{ Name: 'prvCreateActivity', PrivilegeId: FI.pid('prvCreateActivity'), PrivilegeType: 'Create', CanBeBasic: true, CanBeLocal: true, CanBeDeep: true, CanBeGlobal: true }] };
  dv.data.roleprivs[FI.IDS.normal].push({ name: 'prvCreateActivity', depth: 'Global' });
  await rejects(S.planSecurityRole(dv, roleJob([{ table: 'email', access: ['create'] }]), roleCtx()), 'PlanRefused', /create on email is the privilege prvCreateActivity, which is not email's own \(it covers other tables too\)/, 'invalid_job');
});

test('round-2 F11: a removal whose answer is lost but which landed reads written, with a note', async () => {
  const dv = roleDv();
  const plan = await S.planSecurityRole(dv, roleJob(), roleCtx());
  const take = dv.removeRolePrivilege;
  dv.removeRolePrivilege = (...a) => { take(...a); throw new DataverseError('The request timed out', { code: 'timeout' }); };
  const { res } = await roleApply(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.entry.rows));
  assert.match(res.entry.rows[0].notes[0], /answer was lost \(The request timed out\), but the role reads back exactly as asked/);
  // one that did NOT land stays failed
  const d2 = roleDv();
  const p2 = await S.planSecurityRole(d2, roleJob(), roleCtx());
  d2.removeRolePrivilege = () => { throw new DataverseError('The request timed out', { code: 'timeout' }); };
  const r2 = await roleApply(p2, d2);
  assert.match(r2.res.entry.rows[0].outcome, /^failed: The request timed out/);
});

test('round-2 F10: a solution moved to another publisher while the plan waited is refused', async () => {
  const dv = cmdDv();
  const plan = await C.planCommand(dv, cmdJob(), cmdCtx());
  dv.data.solutions.find((s) => s.uniquename === 'SBRMWaitlistCount')._publisherid_value = FC.IDS.msPublisher;
  await rejects(cmdApply(plan, dv), 'ApplyRefused', /under another publisher/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
});

test('round-2 F16 + F21: an undo passes over a row already showing; a read error is never "gone"', async () => {
  const dv = cmdDv();
  const { res } = await cmdApply(await C.planCommand(dv, cmdJob({ where: ['list', 'form'] }), cmdCtx()), dv);
  const shownByHand = res.entry.rows[1].id;
  dv.data.appactions.find((r) => r.appactionid === shownByHand).hidden = false;
  const undo = await C.planCommandRevert(dv, entryFrom(res), cmdCtx());
  assert.deepEqual(undo.steps.map((s) => s.row.id), [res.entry.rows[0].id]);
  assert.match(C.commandSummary(undo), /Already showing, left as they are: Deactivate on the form\./);
  const back = await cmdApply(undo, dv);
  assert.equal(back.res.outcome, 'applied', JSON.stringify(back.res.entry.rows));
  // a read that fails for another reason refuses the undo plan as "could not be read", not "nothing to undo"
  const d2 = cmdDv();
  const r2 = await cmdApply(await C.planCommand(d2, cmdJob(), cmdCtx()), d2);
  const get = d2.get;
  d2.get = (p, o) => { if (p.startsWith(`appactions(${r2.res.entry.rows[0].id})`)) throw new DataverseError('Service unavailable', { status: 503 }); return get(p, o); };
  await rejects(C.planCommandRevert(d2, entryFrom(r2.res), cmdCtx()), 'PlanRefused', /could not be read \(Service unavailable\); try again/, 'snapshot_moved');
});

test('round-2 F8 + F9: short of rules is judged from the live rows: a flipped short row warns, a fully linked row does not', async () => {
  // a row an earlier stopped hide left showing with no rules, flipped by this hide
  let dv = cmdDv();
  FC.override(dv.data, { hidden: false });
  let { res } = await cmdApply(await C.planCommand(dv, cmdJob(), cmdCtx()), dv);
  let undo = await C.planCommandRevert(dv, entryFrom(res), cmdCtx());
  assert.ok(undo.severity.lines.some((l) => /^Note: Deactivate on the list comes back with fewer visibility rules/.test(l)), JSON.stringify(undo.severity.lines));
  // every rule landed, the last link lost its answer: the outcome says 1 of 2, the row has both, the undo does not warn
  dv = cmdDv();
  const plan = await C.planCommand(dv, cmdJob(), cmdCtx());
  let n = 0;
  const link = dv.linkCommandRule;
  dv.linkCommandRule = (...a) => { const r = link(...a); n += 1; if (n === 2) throw new DataverseError('The request timed out', { code: 'timeout' }); return r; };
  ({ res } = await cmdApply(plan, dv));
  assert.match(res.entry.rows[0].outcome, /1 of 2 rules linked/);
  dv.linkCommandRule = link;
  undo = await C.planCommandRevert(dv, entryFrom(res), cmdCtx());
  assert.doesNotMatch(C.commandSummary(undo), /fewer rules/);
  assert.equal(undo.severity.notes.length, 0);
});
