'use strict';
// Security roles (kind "role", 1.11.13; Dylan 10/17/26: "can we add role changes to toolkit?"): give or take
// ONE named security role for ONE user, on a fake Dataverse (test/fake_role.js). Admin only. Rulings 10/19/26:
// System Administrator and System Customizer are never GIVEN here (the admin center, by hand), and only SBRM's
// own (unmanaged) roles may be given; any role may be taken away, except the last System Administrator.
// The worry the plan answers (Dylan 10/17: "I dont want to accidentally shut off anyones access"): for every
// removal it says whether a team still gives the person that role, or that this ends their access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Never touch the real store (CLAUDE.md trap), even though this file only plans and applies in-process.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-role-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const R = require('../lib/role');
const severity = require('../lib/severity');
const { fakeRoleDv, IDS, ENVS, ACCESS } = require('./fake_role');

const emailOf = { admin: 'admin@example.org', dev: 'dev@example.org', writer: 'writer@example.org', reader: 'nobody@example.org' };
const dvAs = (who = 'admin', over = {}) => fakeRoleDv({ email: emailOf[who], ...over });
const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, ...over });

const row = (user, roleName, action) => ({ user, role: roleName, action });
function job(rows = [row('tim@example.org', '#_ SBRM Normal', 'remove')], over = {}) {
  const add = rows.filter((r) => r.action === 'add').length;
  return {
    contract: 'sbrm-dv-job/1', kind: 'role', env: 'hgs', rows, source: 'claude-session',
    reason: 'Tim steps back; his direct HGS grant ends.', intent: { verb: 'roles', add, remove: rows.length - add }, ...over,
  };
}

function valid(raw) {
  const r = R.validateRoleJob(raw, { envs: ENVS });
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
const holds = (dv, uid, rid) => dv.data.userroles.some((g) => g.user === uid && g.role === rid);
const plannedFor = (plan, email) => plan.rows.find((r) => r.user.email === email);
const leftOutFor = (plan, email) => plan.refused.find((r) => r.user === email);

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await R.applyRole({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, ...over,
  }, { id: `20261019-1200${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown, fileGone: !fs.existsSync(file) };
}

// ---------- the job file ----------

test('validate: a good job passes; typos, missing pieces, duplicates and intent mismatch are refused', () => {
  const j = valid(job([row('Tim@Example.org ', '#_ SBRM Normal', 'remove'), row('daian@example.org', '#_ SBRM Clerical', 'add')]));
  assert.equal(j.kind, 'role');
  assert.deepEqual(j.rows[0], { user: 'tim@example.org', role: '#_ SBRM Normal', action: 'remove' });
  const good = [row('tim@example.org', '#_ SBRM Normal', 'remove')];
  const cases = [
    [{ colour: 'red' }, /unknown top-level key "colour"/],
    [{ contract: 'x' }, /"contract" must be exactly/],
    [{ kind: 'setting' }, /"kind" must be "role"/],
    [{ env: 'nowhere' }, /"env" must be one of/],
    [{ rows: [] }, /"rows" must list 1 to 25 role changes/],
    [{ rows: Array.from({ length: 26 }, (_, i) => row(`u${i}@example.org`, '#_ SBRM Normal', 'add')) }, /"rows" must list 1 to 25 role changes/],
    [{ rows: [{ ...good[0], colour: 1 }] }, /row 1: unknown key "colour"/],
    [{ rows: [row('tim', '#_ SBRM Normal', 'remove')] }, /row 1: "user" must be the person's work email/],
    [{ rows: [row("x'@example.org", '#_ SBRM Normal', 'remove')] }, /row 1: "user" must be the person's work email/],
    [{ rows: [row('tim@example.org', '', 'remove')] }, /row 1: "role" must be the role's name/],
    [{ rows: [row('tim@example.org', 'a\nb', 'remove')] }, /row 1: "role" must be the role's name/],
    [{ rows: [row('tim@example.org', '#_ SBRM Normal', 'grant')] }, /row 1: "action" must be "add" or "remove"/],
    [{ rows: [good[0], row('TIM@example.org', '#_ sbrm normal', 'add')] }, /row 2: tim@example.org and #_ sbrm normal appear more than once/],
    [{ source: '' }, /"source" is required/],
    [{ reason: 'two\nlines' }, /"reason" must be one line/],
    [{ intent: undefined }, /"intent" is required/],
    [{ intent: { verb: 'roles', add: 1, remove: 0 } }, /intent does not match the job.*1 to add, the file adds 0/],
    [{ intent: { verb: 'roles', add: 0, remove: 2 } }, /intent does not match the job.*2 to remove, the file removes 1/],
    [{ intent: { verb: 'grant', add: 0, remove: 1 } }, /intent does not match the job.*verb says "grant"/],
  ];
  for (const [over, re] of cases) {
    const base = over.rows ? job(over.rows) : job();
    const r = R.validateRoleJob({ ...base, ...over }, { envs: ENVS });
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(over).slice(0, 80)}: ${r.errors.join(' | ')}`);
  }
});

// ---------- plan ----------

test('plan: reads only; a removal no team backs says plainly that it ends their access, and warns', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job()), ctx());
  assert.deepEqual(nonGets(dv), []);
  assert.equal(plan.kind, 'role');
  assert.equal(plan.need, 'admin');
  const t = plannedFor(plan, 'tim@example.org');
  assert.equal(t.user.id, IDS.tim);
  assert.equal(t.role.id, IDS.normal);
  assert.equal(t.role.root, IDS.normal);
  assert.equal(t.action, 'remove');
  assert.deepEqual(t.before, { held: true });
  assert.deepEqual(t.roles_before, ['#_ SBRM Normal']);
  assert.deepEqual(t.roles_after, []);
  assert.deepEqual(t.via, []);
  assert.equal(t.ends_access, true);
  // Tim's access team carries Normal in the fake; access teams never give roles, so it is not "via".
  const text = R.roleSummary(plan);
  assert.match(text, /Remove '#_ SBRM Normal' from Tim Molloy \(tim@example\.org\)/);
  assert.match(text, /This ends their access to '#_ SBRM Normal' in the HGS apps: no team they are in gives it/);
  assert.match(text, /Roles held directly: #_ SBRM Normal -> \(none\)/);
  assert.ok(plan.severity.ends.some((x) => /Tim Molloy loses '#_ SBRM Normal'/.test(x)), JSON.stringify(plan.severity));
  assert.ok(plan.severity.lines.some((l) => /^Ends access: Tim Molloy loses '#_ SBRM Normal'/.test(l)), plan.severity.lines.join('\n'));
  assert.match(R.roleDetail(plan, { id: 'x' }), new RegExp(`User: ${IDS.tim}`));
});

test('plan: a removal a team still backs says the access continues through that team, and carries no warning', async () => {
  const plan = await R.planRole(dvAs('admin'), valid(job([row('daian@example.org', '#_ SBRM Normal', 'remove')])), ctx());
  const r = plannedFor(plan, 'daian@example.org');
  assert.deepEqual(r.via, ['Homeless Program']);
  assert.equal(r.ends_access, false);
  assert.deepEqual(plan.severity.lines, []);
  assert.match(R.roleSummary(plan), /Access to '#_ SBRM Normal' continues through the team Homeless Program/);
  assert.match(R.roleSummary(plan), /Team membership in Dataverse can lag Entra/);
});

test('plan: an add picks the copy of the role in the person\'s own business unit', async () => {
  const plan = await R.planRole(dvAs('admin'), valid(job([row('lb@example.org', '#_ SBRM Clerical', 'add')], { env: 'recovery' })), ctx());
  const r = plannedFor(plan, 'lb@example.org');
  assert.equal(r.role.id, IDS.clericalMens);
  assert.equal(r.role.root, IDS.clerical);
  assert.deepEqual(r.before, { held: false });
  assert.deepEqual(r.roles_after, ['#_ SBRM Clerical', '#_ SBRM Normal']);
  assert.deepEqual(r.via, ["Men's Clerical"]);
  assert.match(R.roleSummary(plan), /Add '#_ SBRM Clerical' to Larry Chandler \(lb@example\.org\)/);
  assert.match(R.roleSummary(plan), /They already have it through the team Men's Clerical; this adds a direct grant/);
});

test('plan: admin only; develop, write and read are refused', async () => {
  for (const who of ['dev', 'writer', 'reader']) {
    await refused(R.planRole(dvAs(who), valid(job()), ctx()), /changing who holds a security role takes admin access in the HGS apps/, who === 'reader' ? 'access_read' : 'not_permitted');
  }
});

test('plan: each row that cannot go is left out with its reason; the rest go ahead', async () => {
  const rows = [
    row('admin@example.org', '#_ SBRM Normal', 'add'),
    row('nobody-here@example.org', '#_ SBRM Normal', 'add'),
    row('twin@example.org', '#_ SBRM Normal', 'add'),
    row('gone@example.org', '#_ SBRM Clerical', 'add'),
    row('daian@example.org', 'System Administrator', 'add'),
    row('daian@example.org', 'System Customizer', 'add'),
    row('daian@example.org', 'Basic User', 'add'),
    row('lb@example.org', '#_ SBRM Root Only', 'add'),
    row('daian@example.org', '#_ SBRM Nope', 'add'),
    row('tim@example.org', '#_ SBRM Normal', 'add'),
    row('daian@example.org', '#_ SBRM Clerical', 'remove'),
    row('lb@example.org', '#_ SBRM Clerical', 'remove'),
    row('gone@example.org', '#_ SBRM Normal', 'remove'),
  ];
  const plan = await R.planRole(dvAs('admin'), valid(job(rows)), ctx({ envs: { ...ENVS } }));
  const why = (email, roleName) => (plan.refused.find((r) => r.user === email && r.role === roleName) || {}).why || '(not refused)';
  assert.match(why('admin@example.org', '#_ SBRM Normal'), /your own roles are never changed here/);
  assert.match(why('nobody-here@example.org', '#_ SBRM Normal'), /no user with the work email nobody-here@example\.org in the HGS apps/);
  assert.match(why('twin@example.org', '#_ SBRM Normal'), /2 users have the work email twin@example\.org/);
  assert.match(why('gone@example.org', '#_ SBRM Clerical'), /Gone Person's account is disabled; a role is never added to a disabled account/);
  assert.match(why('daian@example.org', 'System Administrator'), /System Administrator is never given through the toolkit.*admin center/);
  assert.match(why('daian@example.org', 'System Customizer'), /System Customizer is never given through the toolkit.*admin center/);
  assert.match(why('daian@example.org', 'Basic User'), /'Basic User' is a Microsoft \(managed\) role; only SBRM's own roles are given here/);
  assert.match(why('lb@example.org', '#_ SBRM Root Only'), /has no copy in Larry Chandler's business unit/);
  assert.match(why('daian@example.org', '#_ SBRM Nope'), /there is no role named '#_ SBRM Nope' in the HGS apps/);
  assert.match(why('tim@example.org', '#_ SBRM Normal'), /Tim Molloy already holds '#_ SBRM Normal' directly/);
  assert.match(why('daian@example.org', '#_ SBRM Clerical'), /Daian Martinez does not hold '#_ SBRM Clerical' directly/);
  assert.match(why('lb@example.org', '#_ SBRM Clerical'), /does not hold '#_ SBRM Clerical' directly \(they have it through the team Men's Clerical, which is changed in Entra or the team, not here\)/);
  // Taking a role from a disabled account is allowed: it is tidy-up, and it is the 10/17 review's section 5.
  const g = plannedFor(plan, 'gone@example.org');
  assert.equal(g.action, 'remove');
  assert.equal(plan.rows.length, 1);
  assert.match(R.roleSummary(plan), /Left out \(12\)/);
});

test('plan: every row refused refuses the plan', async () => {
  await refused(R.planRole(dvAs('admin'), valid(job([row('tim@example.org', '#_ SBRM Normal', 'add')])), ctx()), /nothing to change.*already holds/, 'every_row_refused');
});

test('plan: System Administrator may be taken away, but never from the last enabled person who holds it', async () => {
  const ok = await R.planRole(dvAs('admin'), valid(job([row('admin2@example.org', 'System Administrator', 'remove')])), ctx());
  assert.equal(plannedFor(ok, 'admin2@example.org').role.id, IDS.sa);
  // Without Other Admin, Test Admin (the planner, who cannot change their own roles) is the last PERSON; the
  // app user holding it does not count, since nobody can sign in as it.
  const dv = dvAs('admin');
  dv.data.userroles = dv.data.userroles.filter((g) => !(g.user === IDS.me && g.role === IDS.sa));
  await refused(R.planRole(dv, valid(job([row('admin2@example.org', 'System Administrator', 'remove')])), ctx()), /Other Admin is the last enabled person who holds System Administrator/, 'every_row_refused');
});

// ---------- severity ----------

test('severity: "ends access" is its own warning kind, and more of it at apply means the change grew', () => {
  const a = severity.assess({ count: 1, noun: 'role changes', ends: ['X loses Y'] });
  assert.deepEqual(a.lines, ['Ends access: X loses Y.']);
  const none = severity.assess({ count: 1, noun: 'role changes' });
  assert.deepEqual(none.ends, []);
  assert.equal(severity.grew(none, a), true);
  assert.equal(severity.grew(a, a), false);
  // a plan saved before the field existed reads as none
  const old = { ...none };
  delete old.ends;
  assert.equal(severity.grew(old, a), true);
});

// ---------- apply ----------

test('apply: one association call per row, read back, logged with before and after', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job([row('tim@example.org', '#_ SBRM Normal', 'remove'), row('daian@example.org', '#_ SBRM Clerical', 'add')])), ctx());
  const { res, shown, fileGone } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.ok(!holds(dv, IDS.tim, IDS.normal));
  assert.ok(holds(dv, IDS.daian, IDS.clerical));
  assert.deepEqual(nonGets(dv).map((c) => [c.verb, c.user, c.role]), [['revoke', IDS.tim, IDS.normal], ['grant', IDS.daian, IDS.clerical]]);
  assert.equal(shown.length, 1);
  assert.match(shown[0].title, /approve these role changes in the HGS apps/);
  assert.match(shown[0].summaryText, /Ends access: Tim Molloy loses/);
  assert.ok(fileGone);
  const e = res.entry;
  assert.equal(e.mode, 'role');
  assert.equal(e.table, 'systemuserroles_association');
  assert.equal(e.rows.length, 2);
  const t = e.rows.find((r) => r.user.id === IDS.tim);
  assert.equal(t.action, 'remove');
  assert.equal(t.id, IDS.tim);
  assert.equal(t.name, "tim@example.org: '#_ SBRM Normal'");
  assert.deepEqual(t.before, { held: true });
  assert.deepEqual(t.after, { held: false });
  assert.equal(t.outcome, 'written');
  assert.deepEqual(t.changes, [{ label: '#_ SBRM Normal', old_text: 'held', new_text: 'not held' }]);
});

test('apply: cancelled writes nothing and keeps the plan', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job()), ctx());
  const { res, fileGone } = await applied(plan, dv, { confirm: () => ({ approved: false }) });
  assert.equal(res.outcome, 'cancelled');
  assert.deepEqual(nonGets(dv), []);
  assert.ok(holds(dv, IDS.tim, IDS.normal));
  assert.ok(!fileGone);
});

test('apply: a grant changed since the plan is refused, nothing written', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job()), ctx());
  dv.data.userroles = dv.data.userroles.filter((g) => !(g.user === IDS.tim && g.role === IDS.normal));
  await applyRefused(applied(plan, dv), /Tim Molloy's roles changed since the plan/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: a person moved to another business unit, or disabled, since the plan is refused', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job([row('daian@example.org', '#_ SBRM Clerical', 'add')])), ctx());
  dv.data.systemusers.find((u) => u.systemuserid === IDS.daian)._businessunitid_value = IDS.mensBu;
  await applyRefused(applied(plan, dv), /Daian Martinez changed since the plan/, 'snapshot_moved');
  const dv2 = dvAs('admin');
  const plan2 = await R.planRole(dv2, valid(job([row('daian@example.org', '#_ SBRM Clerical', 'add')])), ctx());
  dv2.data.systemusers.find((u) => u.systemuserid === IDS.daian).isdisabled = true;
  await applyRefused(applied(plan2, dv2), /Daian Martinez changed since the plan/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
  assert.deepEqual(nonGets(dv2), []);
});

test('apply: the team that kept someone\'s access was dropped since the plan, so the change grew and is refused', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job([row('daian@example.org', '#_ SBRM Normal', 'remove')])), ctx());
  assert.deepEqual(plan.severity.lines, []);
  dv.data.members = dv.data.members.filter((m) => !(m.user === IDS.daian && m.team === IDS.programTeam));
  await applyRefused(applied(plan, dv), /more serious than when it was planned/, 'severity_grew');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: another person, or access lowered since the plan, is refused', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job()), ctx());
  await applyRefused(applied(plan, fakeRoleDv({ email: 'admin2@example.org', userId: IDS.admin2, d: dv.data })), /this plan was made by Test Admin/, 'different_person');
  await applyRefused(applied(plan, dv, { access: { people: { 'admin@example.org': { envs: { hgs: 'develop' } } } } }), /takes admin access/, 'access_revoked');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: a plan file edited to write something else is refused', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job()), ctx());
  const r0 = plan.rows[0];
  const tampered = [
    { rows: [{ ...r0, user: { ...r0.user, id: 'not-a-guid' } }] },
    { rows: [{ ...r0, role: { ...r0.role, id: "x'" } }] },
    { rows: [{ ...r0, action: 'delete' }] },
    { rows: [] },
    { mode: 'delete' },
    // a hand edit that turns the removal into giving System Administrator
    { rows: [{ ...r0, action: 'add', role: { ...r0.role, id: IDS.sa, root: IDS.sa, name: 'System Administrator' } }] },
  ];
  for (const over of tampered) {
    await applyRefused(applied({ ...plan, ...over }, dv), /changed after it was made|never given through the toolkit/, null);
  }
  assert.deepEqual(nonGets(dv), []);
});

test('apply: a hand-edited plan that reaches your own roles, another business unit\'s copy, or a Microsoft role is refused', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job()), ctx());
  const r0 = plan.rows[0];
  // the row pointed at the planner: never their own roles, even when the plan file says so
  await applyRefused(applied({ ...plan, rows: [{ ...r0, user: { ...r0.user, id: IDS.me } }] }, dv), /your own roles, which are never changed here/, 'not_permitted');
  // the role's copy in ANOTHER business unit (same root): not the copy Tim can hold
  await applyRefused(applied({ ...plan, rows: [{ ...r0, role: { ...r0.role, id: IDS.normalMens } }] }, dv), /is not Tim Molloy's business unit's copy of the role/, 'snapshot_moved');
  // an add turned into a Microsoft role
  const add = await R.planRole(dv, valid(job([row('daian@example.org', '#_ SBRM Clerical', 'add')])), ctx());
  const a0 = add.rows[0];
  await applyRefused(applied({ ...add, rows: [{ ...a0, role: { ...a0.role, id: IDS.basic, root: IDS.basic, name: 'Basic User' } }] }, dv), /'Basic User' is a Microsoft \(managed\) role/, 'not_permitted');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: System Administrator is not taken from someone who became the last person holding it since the plan', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job([row('admin2@example.org', 'System Administrator', 'remove')])), ctx());
  dv.data.userroles = dv.data.userroles.filter((g) => !(g.user === IDS.me && g.role === IDS.sa));
  await applyRefused(applied(plan, dv), /Other Admin is now the last enabled person who holds System Administrator/, 'snapshot_moved');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: a grant the platform did not keep is "applied with problems"; a failed call is recorded', async () => {
  const dv = dvAs('admin');
  dv.readBackDrops = true;
  const plan = await R.planRole(dv, valid(job()), ctx());
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /read-back mismatch: Tim Molloy still holds '#_ SBRM Normal'/);
  const dv2 = dvAs('admin');
  const plan2 = await R.planRole(dv2, valid(job()), ctx());
  dv2.failNext = new (require('../lib/cli').DataverseError)('boom', { code: '0x1' });
  const { res: res2 } = await applied(plan2, dv2);
  assert.equal(res2.outcome, 'applied with problems');
  assert.match(res2.rows[0].outcome, /^failed: boom/);
});

test('apply: a plan more than 24 hours old is refused', async () => {
  const dv = dvAs('admin');
  const plan = await R.planRole(dv, valid(job()), ctx());
  await assert.rejects(R.applyRole({ ...plan, created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }),
  }, { id: 'x', file: path.join(HOME, 'nofile.json'), fs }), /more than 24 hours old/);
});

// ---------- revert ----------

async function appliedEntry(dv, plan) {
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  return JSON.parse(JSON.stringify({ ...res.entry, plan_id: '20261019-120000-abcdef01' })); // as read back from the Write Log
}

test('revert: does the opposite change, only while each grant still is what the plan left', async () => {
  const dv = dvAs('admin');
  const entry = await appliedEntry(dv, await R.planRole(dv, valid(job()), ctx()));
  const rp = await R.planRoleRevert(dv, entry, ctx());
  assert.equal(rp.reverts_plan_id, '20261019-120000-abcdef01');
  assert.equal(rp.rows[0].action, 'add');
  assert.match(R.roleSummary(rp), /Add '#_ SBRM Normal' to Tim Molloy/);
  const { res } = await applied(rp, dv);
  assert.equal(res.outcome, 'applied');
  assert.ok(holds(dv, IDS.tim, IDS.normal));
  assert.equal(res.entry.reverts_plan_id, '20261019-120000-abcdef01');

  const moved = dvAs('admin');
  const e2 = await appliedEntry(moved, await R.planRole(moved, valid(job()), ctx()));
  moved.data.userroles.push({ user: IDS.tim, role: IDS.normal }); // someone gave it back by hand
  await refused(R.planRoleRevert(moved, e2, ctx()), /changed since plan .* a revert would overwrite someone's later change/, 'every_row_refused');
});

test('revert: refuses an entry of another kind, a cancelled one, a damaged one, or one from another environment', async () => {
  const dv = dvAs('admin');
  const entry = await appliedEntry(dv, await R.planRole(dv, valid(job()), ctx()));
  await refused(R.planRoleRevert(dv, { ...entry, mode: 'setting' }, ctx()), /not a security role change/, 'nothing_to_undo');
  await refused(R.planRoleRevert(dv, { ...entry, outcome: 'cancelled' }, ctx()), /nothing to undo/, 'nothing_to_undo');
  await refused(R.planRoleRevert(dv, { ...entry, rows: [{ ...entry.rows[0], outcome: 'failed: x' }] }, ctx()), /did not land/, 'nothing_to_undo');
  await refused(R.planRoleRevert(dv, { ...entry, rows: [{ ...entry.rows[0], user: { ...entry.rows[0].user, email: "x'" } }] }, ctx()), /no valid user/, 'invalid_job');
  await refused(R.planRoleRevert(dv, { ...entry, env: 'nowhere' }, ctx()), /names an environment the toolkit does not know/, 'invalid_job');
  await refused(R.planRoleRevert(dv, { ...entry, env: 'recovery' }, ctx()), /was made in the Recovery app/, 'invalid_job');
});
