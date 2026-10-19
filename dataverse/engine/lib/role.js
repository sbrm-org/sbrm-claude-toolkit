'use strict';
// Security roles (kind "role", 1.11.13; Dylan 10/17/26: "can we add role changes to toolkit?"): give or take ONE
// named security role for ONE user, several rows per job. Why it exists: the 10/17/26 direct-grants review
// (Power Apps Reference\direct_grants_review_2026-10-17.md) found role grants could only be changed by hand in
// the Power Platform admin center, outside the Write Log (a records job on systemusers or roles is refused,
// lib/access.js APP_DEFINITION_SETS).
//
//   plan   finds each person by work email and the role by name, picks the role's copy in the person's own
//          business unit (every role has one copy per business unit, and a user can hold only their own), reads
//          their direct roles and the teams they are in, and says for every removal either "access continues
//          through <team>" or "this ends their access" (a warning; Dylan 10/17: "I dont want to accidentally
//          shut off anyones access"). Reads only.
//   apply  re-reads each person, role and grant, refuses if any moved, works the warnings out again from live
//          reads, shows the pop-up, then one association call per row, each read back.
//   log    before and after per row; revert is the opposite change, only while each grant still is what the
//          plan left.
//
// Rulings (Dylan 10/19/26): System Administrator and System Customizer are never GIVEN here (an admin gives
// them by hand); only SBRM's own (unmanaged) roles are given. Any role may be taken away, except System
// Administrator from the last enabled person who holds it. Never refused by name: a role taken from a disabled
// account (tidy-up). Always refused: your own roles, and a role added to a disabled account.
// Out of scope: Entra-backed team membership (Entra is authoritative; whoever holds Entra rights changes it).

const { whoAmI, accessFor, PlanRefused } = require('./resolve');
const { resolveAccess } = require('./access');
const { ApplyRefused } = require('./apply');
const { DataverseError } = require('./cli');
const { GUID } = require('./contract');
const { atLeast } = require('./levels');
const severity = require('./severity');

const CONTRACT = 'sbrm-dv-job/1';
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_ROWS = 25;
const TOP_KEYS = new Set(['contract', 'kind', 'env', 'rows', 'source', 'reason', 'intent']);
const ROW_KEYS = new Set(['user', 'role', 'action']);
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const ACTIONS = new Set(['add', 'remove']);
// Given only by hand in the admin center (ruled 10/19/26): each gives full control of the app.
const NEVER_GIVEN = new Set(['system administrator', 'system customizer']);
const SYS_ADMIN = 'system administrator';
// Team types that carry roles: owner (0), Entra security group (2), Entra office group (3). An access team (1)
// shares single records and never gives a role.
const GRANTING_TEAMS = new Set([0, 2, 3]);
const USER_COLS = 'systemuserid,fullname,domainname,internalemailaddress,isdisabled,accessmode,_businessunitid_value';
const ROLE_COLS = 'roleid,name,_parentrootroleid_value,_businessunitid_value,ismanaged';

const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const q = (s) => String(s).replace(/'/g, "''");
const enc = (s) => encodeURIComponent(s);
const low = (s) => String(s || '').toLowerCase();
const same = (a, b) => low(a) === low(b);
const roleName = (s) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(s);
const names = (xs) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- the job file ----------

function validateRoleJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!obj(raw)) return { errors: ['the job file must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be exactly "${CONTRACT}"`);
  if (raw.kind !== 'role') err('"kind" must be "role"');
  if (typeof raw.env !== 'string' || !has(envs, raw.env)) err(`"env" must be one of: ${Object.keys(envs).join(', ')}`);
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required (script path, or "claude-session")');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > 500 || /[\r\n]/.test(raw.reason)) err('"reason" must be one line, at most 500 characters');

  const rows = [];
  if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > MAX_ROWS) {
    err(`"rows" must list 1 to ${MAX_ROWS} role changes, each {user, role, action}`);
  } else {
    const seen = new Set();
    raw.rows.forEach((r, i) => {
      const at = `row ${i + 1}`;
      if (!obj(r)) { err(`${at}: must be an object {user, role, action}`); return; }
      for (const k of Object.keys(r)) if (!ROW_KEYS.has(k)) err(`${at}: unknown key "${k}"`);
      const user = typeof r.user === 'string' ? r.user.trim().toLowerCase() : '';
      if (!EMAIL.test(user)) err(`${at}: "user" must be the person's work email (their sign-in, e.g. name@sbrm.org)`);
      if (!roleName(r.role)) err(`${at}: "role" must be the role's name exactly as Dataverse shows it (one line, at most 100 characters)`);
      if (!ACTIONS.has(r.action)) err(`${at}: "action" must be "add" or "remove"`);
      if (EMAIL.test(user) && roleName(r.role)) {
        const key = `${user}|${low(r.role.trim())}`;
        if (seen.has(key)) err(`${at}: ${user} and ${r.role.trim()} appear more than once`);
        seen.add(key);
      }
      rows.push({ user, role: typeof r.role === 'string' ? r.role.trim() : r.role, action: r.action });
    });
  }

  // Intent: what Claude says the job does, checked against the file (the §6b.1 rule).
  const intent = raw.intent;
  if (!obj(intent)) err('"intent" is required: {verb: "roles", add, remove} (how many of each)');
  else if (!errors.length) {
    const adds = rows.filter((r) => r.action === 'add').length;
    const removes = rows.length - adds;
    const mism = [];
    for (const k of Object.keys(intent)) if (!['verb', 'add', 'remove'].includes(k)) mism.push(`unknown key "${k}"`);
    if (intent.verb !== 'roles') mism.push(`verb says "${intent.verb}"; a role job is "roles"`);
    if (intent.add !== adds) mism.push(`intent says ${intent.add} to add, the file adds ${adds}`);
    if (intent.remove !== removes) mism.push(`intent says ${intent.remove} to remove, the file removes ${removes}`);
    if (mism.length) err(`intent does not match the job (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  return {
    errors: [],
    job: { contract: CONTRACT, kind: 'role', env: raw.env, rows, source: raw.source.trim(), reason: raw.reason.trim(), intent },
  };
}

// ---------- live reads ----------

function usersWithEmail(dv, email) {
  return dv.get(`systemusers?$select=${USER_COLS}&$filter=${enc(`domainname eq '${q(email)}'`)}`).value || [];
}

function readUser(dv, id) {
  try {
    return dv.get(`systemusers(${id})?$select=${USER_COLS}`);
  } catch (e) {
    if (e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

function rolesNamed(dv, name) {
  return dv.get(`roles?$select=${ROLE_COLS}&$filter=${enc(`name eq '${q(name)}'`)}`).value || [];
}

function readRole(dv, id) {
  try {
    return dv.get(`roles(${id})?$select=${ROLE_COLS}`);
  } catch (e) {
    if (e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

function directRoles(dv, userId) {
  return dv.get(`systemusers(${userId})/systemuserroles_association?$select=${ROLE_COLS}`).value || [];
}

// The teams a person is in that can give roles, each with the ROOT ids of the roles it carries (a team in
// another business unit holds a different copy of the same role, so roles are compared by root).
function grantingTeams(dv, userId) {
  const teams = (dv.get(`systemusers(${userId})/teammembership_association?$select=teamid,name,teamtype`).value || [])
    .filter((t) => GRANTING_TEAMS.has(t.teamtype));
  return teams.map((t) => ({
    name: String(t.name || t.teamid),
    roots: new Set((dv.get(`teams(${t.teamid})/teamroles_association?$select=roleid,name,_parentrootroleid_value`).value || [])
      .map((r) => low(r._parentrootroleid_value || r.roleid))),
  }));
}

// The enabled PEOPLE (not app users, which nobody signs in as) who hold System Administrator directly, through
// any business unit's copy. Team grants are not counted, so this can only refuse more often, never less.
function adminPeople(dv, saRoot) {
  const out = new Map();
  for (const c of dv.get(`roles?$select=${ROLE_COLS}&$filter=${enc(`_parentrootroleid_value eq ${saRoot}`)}`).value || []) {
    for (const u of dv.get(`roles(${c.roleid})/systemuserroles_association?$select=systemuserid,fullname,isdisabled,accessmode`).value || []) {
      if (!u.isdisabled && u.accessmode === 0) out.set(low(u.systemuserid), u.fullname);
    }
  }
  return out;
}

const viaFor = (teams, root) => names(teams.filter((t) => t.roots.has(low(root))).map((t) => t.name));
const endsLine = (r, app) => `${r.user.fullname} loses '${r.role.name}' in the ${app} (no team they are in gives it)`;

function severityFor(rows, app, warnRows) {
  return severity.assess({ count: rows.length, noun: 'role changes', ends: rows.filter((r) => r.ends_access).map((r) => endsLine(r, app)) }, { warnRows });
}

// ---------- plan ----------

function title(plan) {
  if (plan.rows.length === 1) {
    const r = plan.rows[0];
    return `${r.action === 'add' ? 'Add' : 'Remove'} '${r.role.name}' ${r.action === 'add' ? 'to' : 'from'} ${r.user.fullname} in the ${plan.app}`;
  }
  const adds = plan.rows.filter((r) => r.action === 'add').length;
  const parts = [adds && `add ${adds}`, plan.rows.length - adds && `remove ${plan.rows.length - adds}`].filter(Boolean).join(', ');
  return `${plural(plan.rows.length, 'security role change', 'security role changes')} in the ${plan.app} (${parts})`;
}

async function planRole(dv, job, ctx) {
  return planCore(dv, job, ctx, {});
}

async function planCore(dv, job, { envs, access, warnRows = severity.DEFAULT_WARN_ROWS }, { revertOf = null, expect = null } = {}) {
  const envInfo = envs[job.env];
  const app = envInfo.name;
  const identity = whoAmI(dv);
  if (!identity.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, job.env), identity.email, job.env);
  if (!atLeast(acc.level, 'admin')) {
    throw new PlanRefused([`changing who holds a security role takes admin access in the ${app} (a role decides what someone can see and change); ${identity.fullname} has ${acc.level}. Ask Dylan.`],
      atLeast(acc.level, 'write') ? 'not_permitted' : 'access_read');
  }

  const rows = [];
  const refused = [];
  const takingAdmin = new Set(); // people losing System Administrator in this job (the last-one check)
  const cache = { users: new Map(), direct: new Map(), teams: new Map() };
  const once = (map, key, read) => (map.has(key) ? map.get(key) : (map.set(key, read()), map.get(key)));

  job.rows.forEach((jr, i) => {
    const leave = (why) => refused.push({ row: i + 1, user: jr.user, role: jr.role, action: jr.action, why });
    const found = once(cache.users, jr.user, () => usersWithEmail(dv, jr.user));
    if (!found.length) return leave(`there is no user with the work email ${jr.user} in the ${app}`);
    if (found.length > 1) return leave(`${found.length} users have the work email ${jr.user} in the ${app}; Ask Dylan`);
    const u = found[0];
    const uid = low(u.systemuserid);
    const who = String(u.fullname || jr.user);
    if (uid === low(identity.systemuserid)) return leave('your own roles are never changed here (another admin changes them)');

    const copies = rolesNamed(dv, jr.role);
    if (!copies.length) return leave(`there is no role named '${jr.role}' in the ${app}`);
    const rootIds = new Set(copies.map((c) => low(c._parentrootroleid_value || c.roleid)));
    if (rootIds.size > 1) return leave(`'${jr.role}' names ${rootIds.size} different roles in the ${app}; Ask Dylan`);
    const root = [...rootIds][0];
    const rootRow = copies.find((c) => low(c.roleid) === root) || copies[0];
    const name = String(rootRow.name);
    const managed = Boolean(rootRow.ismanaged);

    if (jr.action === 'add') {
      if (NEVER_GIVEN.has(low(name))) return leave(`${name} is never given through the toolkit (it gives full control of the app); an admin gives it by hand in the Power Platform admin center`);
      if (managed) return leave(`'${name}' is a Microsoft (managed) role; only SBRM's own roles are given here`);
      if (u.isdisabled) return leave(`${who}'s account is disabled; a role is never added to a disabled account`);
    }

    const direct = once(cache.direct, uid, () => directRoles(dv, uid));
    const heldRow = direct.find((r) => low(r._parentrootroleid_value || r.roleid) === root);
    const held = Boolean(heldRow);
    const teams = once(cache.teams, uid, () => grantingTeams(dv, uid));
    const via = viaFor(teams, root);

    if (revertOf) {
      const want = expect.get(`${jr.user}|${low(jr.role)}`);
      if (want !== held) return leave(`'${name}' for ${who} changed since plan ${revertOf} (it is ${held ? '' : 'not '}held directly now), so a revert would overwrite someone's later change`);
    }

    let copy;
    if (jr.action === 'add') {
      if (held) return leave(`${who} already holds '${name}' directly`);
      copy = copies.find((c) => same(c._businessunitid_value, u._businessunitid_value));
      if (!copy) return leave(`'${name}' has no copy in ${who}'s business unit, so it cannot be given to them; Ask Dylan`);
    } else {
      if (!held) return leave(`${who} does not hold '${name}' directly${via.length ? ` (they have it through the team ${via.join(', ')}, which is changed in Entra or the team, not here)` : ''}`);
      copy = heldRow;
      if (low(name) === SYS_ADMIN) {
        const others = adminPeople(dv, root);
        for (const x of [uid, ...takingAdmin]) others.delete(x);
        if (!others.size) return leave(`${who} is the last enabled person who holds System Administrator in the ${app}; it is never taken from the last one`);
        takingAdmin.add(uid);
      }
    }

    const before = names(direct.map((r) => String(r.name)));
    const after = jr.action === 'add' ? names([...before, name]) : before.filter((n) => low(n) !== low(name));
    rows.push({
      user: { id: uid, email: jr.user, fullname: who, bu: low(u._businessunitid_value), disabled: Boolean(u.isdisabled) },
      role: { name, root, id: low(copy.roleid), bu: low(copy._businessunitid_value), managed },
      action: jr.action, before: { held }, after: { held: !held },
      roles_before: before, roles_after: after, via,
      ends_access: jr.action === 'remove' && via.length === 0,
    });
  });

  if (!rows.length) {
    throw new PlanRefused([`nothing to change: ${refused.map((r) => `${r.user} / ${r.role}: ${r.why}`).join('; ')}`], 'every_row_refused');
  }
  return {
    contract: CONTRACT, kind: 'role', env: job.env, host: envInfo.host, app, mode: 'roles',
    source: job.source, reason: job.reason, intent: job.intent, identity, access: acc.level, cli_version: dv.cliVersion || null,
    severity: severityFor(rows, app, warnRows), refused, need: 'admin', rows,
    reverts_plan_id: revertOf || null,
  };
}

// ---------- the pop-up ----------

function rowLines(r, app) {
  const out = [`  ${r.action === 'add' ? 'Add' : 'Remove'} '${r.role.name}' ${r.action === 'add' ? 'to' : 'from'} ${r.user.fullname} (${r.user.email})${r.user.disabled ? ', a disabled account' : ''}`];
  out.push(`    Roles held directly: ${r.roles_before.join(', ') || '(none)'} -> ${r.roles_after.join(', ') || '(none)'}`);
  if (r.action === 'remove') {
    out.push(r.via.length
      ? `    Access to '${r.role.name}' continues through the team ${r.via.join(', ')}.`
      : `    This ends their access to '${r.role.name}' in the ${app}: no team they are in gives it.`);
  } else if (r.via.length) {
    out.push(`    They already have it through the team ${r.via.join(', ')}; this adds a direct grant.`);
  }
  return out;
}

function roleSummary(plan) {
  const out = [...severity.block(plan.severity), title(plan), ''];
  for (const r of plan.rows) out.push(...rowLines(r, plan.app));
  if (plan.rows.some((r) => r.via.length)) out.push('', '  Team membership in Dataverse can lag Entra; check the Entra group before relying on a team for access.');
  if ((plan.refused || []).length) {
    out.push('', `  Left out (${plan.refused.length}):`);
    for (const x of plan.refused) out.push(`    ${x.user} / ${x.role} (${x.action}): ${x.why}`);
  }
  out.push('', '  Can be undone with revert (the opposite change, while nothing has moved since).', '', `Reason given: ${plan.reason}`);
  return out.join('\n');
}

function roleDetail(plan, { id } = {}) {
  const out = [...severity.block(plan.severity), title(plan), '', `Requested by: ${plan.identity.fullname} (${plan.identity.email})`, `Reason given: ${plan.reason}`, `Made by: ${plan.source}`];
  if (id) out.push(`Plan: ${id}`);
  if (plan.reverts_plan_id) out.push(`Undoes plan: ${plan.reverts_plan_id}`);
  out.push(`Access needed: admin (a role decides what someone can see and change); ${plan.identity.fullname} has ${plan.access}`);
  for (const r of plan.rows) {
    out.push('', ...rowLines(r, plan.app).map((l) => l.replace(/^ {2}/, '')));
    out.push(`  User: ${r.user.id} (business unit ${r.user.bu})`, `  Role copy: ${r.role.id} (root ${r.role.root}, business unit ${r.role.bu})${r.role.managed ? ', managed' : ''}`);
  }
  for (const x of plan.refused || []) out.push('', `Left out, row ${x.row}: ${x.user} / ${x.role} (${x.action}): ${x.why}`);
  return out.join('\n');
}

// ---------- apply ----------

// What a plan may ask apply to write: per row, one role (a GUID) added to or removed from one user (a GUID).
// Anything else in a plan file was put there by hand, and apply refuses it (plan_tampered).
function planShapeProblems(plan) {
  const bad = [];
  if (!plan || plan.mode !== 'roles') bad.push(`the mode "${plan && plan.mode}"`);
  const rows = plan && plan.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) return [...bad, 'no role changes'];
  rows.forEach((r, i) => {
    const at = `row ${i + 1}`;
    if (!obj(r) || !obj(r.user) || !obj(r.role) || !obj(r.before)) { bad.push(`${at} with no user, role or before state`); return; }
    if (!GUID.test(String(r.user.id))) bad.push(`${at}: a user that is not a GUID`);
    if (!GUID.test(String(r.role.id)) || !GUID.test(String(r.role.root))) bad.push(`${at}: a role that is not a GUID`);
    if (!ACTIONS.has(r.action)) bad.push(`${at}: the action "${r.action}"`);
    if (typeof r.before.held !== 'boolean') bad.push(`${at}: no before state`);
    if (typeof r.user.email !== 'string' || typeof r.role.name !== 'string') bad.push(`${at}: no names`);
  });
  return bad;
}

const refuse = (msg, code) => { throw new ApplyRefused(`${msg} Nothing was written; make a new plan.`, code); };

async function applyRole(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date() } = deps;
  if (now - new Date(plan.created) > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old. Make a new plan.', 'stale_plan');
  const shapeBad = planShapeProblems(plan);
  if (shapeBad.length) throw new ApplyRefused(`this plan file asks to write ${shapeBad.join(', ')}, which no role plan writes. It was changed after it was made; make a new plan. Nothing was written.`, 'plan_tampered');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  if (!atLeast(acc.level, 'admin')) throw new ApplyRefused(`changing who holds a security role takes admin access; you have ${acc.level}. Nothing was written.`, 'access_revoked');

  // Re-check every row against live reads: the person, the role, the grant, and the teams.
  const taking = new Set();
  const live = plan.rows.map((r) => {
    if (low(r.user.id) === low(me.systemuserid)) refuse('this plan changes your own roles, which are never changed here.', 'not_permitted');
    const u = readUser(dv, r.user.id);
    if (!u || !same(u._businessunitid_value, r.user.bu) || Boolean(u.isdisabled) !== Boolean(r.user.disabled)) refuse(`${r.user.fullname} changed since the plan (gone, moved to another business unit, or the account switched on or off).`, 'snapshot_moved');
    const role = readRole(dv, r.role.id);
    if (!role || low(role._parentrootroleid_value || role.roleid) !== low(r.role.root) || !same(role._businessunitid_value, u._businessunitid_value)) {
      refuse(`'${r.role.name}' is gone, or is not ${r.user.fullname}'s business unit's copy of the role, since the plan.`, 'snapshot_moved');
    }
    if (r.action === 'add') {
      if (NEVER_GIVEN.has(low(role.name))) throw new ApplyRefused(`${role.name} is never given through the toolkit; an admin gives it by hand in the Power Platform admin center. Nothing was written.`, 'not_permitted');
      if (role.ismanaged) throw new ApplyRefused(`'${role.name}' is a Microsoft (managed) role; only SBRM's own roles are given here. Nothing was written.`, 'not_permitted');
    }
    const held = directRoles(dv, r.user.id).some((x) => low(x._parentrootroleid_value || x.roleid) === low(r.role.root));
    if (held !== r.before.held) refuse(`${r.user.fullname}'s roles changed since the plan ('${r.role.name}' is ${held ? 'now' : 'no longer'} held directly).`, 'snapshot_moved');
    if (r.action === 'remove' && low(role.name) === SYS_ADMIN) {
      const others = adminPeople(dv, r.role.root);
      for (const x of [low(r.user.id), ...taking]) others.delete(x);
      if (!others.size) refuse(`${r.user.fullname} is now the last enabled person who holds System Administrator.`, 'snapshot_moved');
      taking.add(low(r.user.id));
    }
    const via = viaFor(grantingTeams(dv, r.user.id), r.role.root);
    return { ...r, via, ends_access: r.action === 'remove' && via.length === 0 };
  });

  // The warnings again, from live reads, never the plan's own account (blind review 10/7).
  const sevNow = severityFor(live, plan.app, plan.severity.warn_rows);
  if (severity.grew(plan.severity, sevNow)) {
    throw new ApplyRefused(['this change is more serious than when it was planned, so it is not shown for approval:', ...sevNow.lines.map((l) => `  ! ${l}`), 'Make a new plan.'].join('\n'), 'severity_grew');
  }
  const view = { ...plan, rows: live, severity: sevNow, access: acc.level };
  const answer = confirm({ summaryText: roleSummary(view), detailText: roleDetail(view, { id }), title: `SBRM: approve these role changes in the ${plan.app}?` });
  const base = {
    time: now.toISOString(), plan_id: id, person: me, env: plan.env, app: plan.app, table: 'systemuserroles_association', mode: 'role', action: 'roles',
    source: plan.source, reason: plan.reason, approval: 'prompt', left_out: plan.refused || [], headline: title(view), reverts_plan_id: plan.reverts_plan_id || null,
  };
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };

  // One association call per row, each read back.
  const heldNow = (r) => directRoles(dv, r.user.id).some((x) => low(x._parentrootroleid_value || x.roleid) === low(r.role.root));
  const out = live.map((r) => {
    const want = !r.before.held;
    const row = {
      name: `${r.user.email}: '${r.role.name}'`, id: r.user.id, action: r.action, user: r.user, role: r.role,
      changes: [{ label: r.role.name, old_text: r.before.held ? 'held' : 'not held', new_text: want ? 'held' : 'not held' }],
      before: { held: r.before.held }, after: null, via: r.via, ends_access: r.ends_access,
    };
    try {
      if (r.action === 'add') dv.grantRole(r.user.id, r.role.id);
      else dv.revokeRole(r.user.id, r.role.id);
      const got = heldNow(r);
      row.after = { held: got };
      row.outcome = got === want ? 'written' : `read-back mismatch: ${r.user.fullname} ${got ? 'still holds' : 'does not hold'} '${r.role.name}'`;
    } catch (e) {
      row.outcome = `failed: ${e.message}`;
      try { row.after = { held: heldNow(r) }; } catch { row.after = null; }
    }
    return row;
  });
  fs.rmSync(file, { force: true });
  const ok = out.filter((r) => r.outcome === 'written').length;
  const outcome = ok === out.length ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows: out }, outcome, person: me, dv, written: ok, rows: out, left_out: plan.refused || [] };
}

// ---------- revert ----------
//
// The opposite change for every row that landed, only while each grant still is what that plan left (else it
// moved, and a revert would overwrite someone's later change). A log entry is data: a forged or damaged one is
// refused. Undoing the removal of System Administrator or a Microsoft role is refused like any such add: an
// admin gives those back by hand.

async function planRoleRevert(dv, entry, ctx) {
  if (!entry || entry.mode !== 'role') throw new PlanRefused(['that plan is not a security role change'], 'nothing_to_undo');
  if (!['applied', 'applied with problems'].includes(entry.outcome)) throw new PlanRefused([`that change's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  const envs = (ctx && ctx.envs) || {};
  if (typeof entry.env !== 'string' || !has(envs, entry.env)) throw new PlanRefused([`that log entry names an environment the toolkit does not know ("${entry.env}")`], 'invalid_job');
  if (dv.host && low(dv.host) !== low(envs[entry.env].host)) {
    throw new PlanRefused([`that change was made in the ${envs[entry.env].name}; this revert was planned against another environment. Revert it in the ${envs[entry.env].name}.`], 'invalid_job');
  }
  const landed = (entry.rows || []).filter((r) => obj(r) && obj(r.after) && /^(written|read-back mismatch)/.test(String(r.outcome)));
  if (!landed.length) {
    const r = (entry.rows || [])[0];
    throw new PlanRefused([`that change did not land (${r ? r.outcome : 'no rows'}); there is nothing to undo`], 'nothing_to_undo');
  }
  const rows = [];
  const expect = new Map();
  for (const r of landed) {
    const email = obj(r.user) && typeof r.user.email === 'string' ? r.user.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || !obj(r.role) || !roleName(r.role.name) || !ACTIONS.has(r.action) || typeof r.after.held !== 'boolean') {
      throw new PlanRefused(['that log entry has no valid user, role or action on a row'], 'invalid_job');
    }
    const name = r.role.name.trim();
    rows.push({ user: email, role: name, action: r.action === 'add' ? 'remove' : 'add' });
    expect.set(`${email}|${low(name)}`, r.after.held);
  }
  const adds = rows.filter((r) => r.action === 'add').length;
  const job = {
    contract: CONTRACT, kind: 'role', env: entry.env, rows,
    source: `revert ${entry.plan_id}`,
    reason: `Undo plan ${entry.plan_id} ("${entry.headline}", by ${entry.person ? entry.person.fullname : 'unknown'}).`.replace(/[\r\n]+/g, ' ').slice(0, 500),
    intent: { verb: 'roles', add: adds, remove: rows.length - adds },
  };
  return planCore(dv, job, ctx, { revertOf: entry.plan_id, expect });
}

module.exports = {
  validateRoleJob, planRole, roleSummary, roleDetail, applyRole, planRoleRevert, planShapeProblems, NEVER_GIVEN,
};
