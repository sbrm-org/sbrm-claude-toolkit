'use strict';
// SBRM security roles (kind "securityrole", 1.11.31; Dylan 10/21/26: "Why cant we just do this through the
// toolkit?"). Every job on the SBRM server gets its own NARROW role (ruled per-consumer 10/19 + 10/21, Mail Sorting
// Guide AUTOMATION.md): Read on exactly the tables it reads, nothing else. On 10/21 the first ones had to be made by
// hand in the Power Platform admin center, outside the Write Log. This kind creates one SBRM role from an explicit
// privilege list, and its undo deletes it.
//
//   plan   checks the name is free, finds the root business unit (a role made there is copied to every business unit
//          by Dataverse), and resolves every table's privileges from its metadata, depth checked. Reads only.
//   apply  re-reads all of it, shows the pop-up, creates the role, reads the privileges Dataverse gives every new
//          role (its baseline), adds the asked-for privileges, and reads them all back.
//   log    the role id, the privileges asked for, the baseline and what was read back; revert deletes the role, only
//          while nobody holds it and its privileges are what the apply left.
//
// Rules (Dylan 11/9/26, with the build): Read unless the job says "writes": true. Never here: Create, Write, Delete,
// Assign or Share at organization depth; anything but Read on the security and code tables (roles, users, teams,
// business units, field security, solutions, flows, plug-ins, web resources, the Write Log); a name outside SBRM's
// "#_ " form. Giving the role to someone is kind "role" (an application user by `app_user`).

const { whoAmI, accessFor, PlanRefused } = require('./resolve');
const { resolveAccess } = require('./access');
const { ApplyRefused } = require('./apply');
const { DataverseError } = require('./cli');
const { GUID } = require('./contract');
const { atLeast } = require('./levels');
const severity = require('./severity');

const CONTRACT = 'sbrm-dv-job/1';
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_TABLES = 50;
const TOP_KEYS = new Set(['contract', 'kind', 'env', 'name', 'description', 'privileges', 'writes', 'source', 'reason', 'intent']);
const PRIV_KEYS = new Set(['table', 'access', 'depth']);
// access word -> Dataverse PrivilegeType
const ACCESS = { read: 'Read', create: 'Create', write: 'Write', delete: 'Delete', append: 'Append', appendto: 'AppendTo', assign: 'Assign', share: 'Share' };
// depth word -> Dataverse PrivilegeDepth, and the metadata flag that allows it
const DEPTH = { user: 'Basic', businessunit: 'Local', parentchild: 'Deep', organization: 'Global' };
const CAN = { Basic: 'CanBeBasic', Local: 'CanBeLocal', Deep: 'CanBeDeep', Global: 'CanBeGlobal' };
const WORD_FOR = Object.fromEntries(Object.entries(DEPTH).map(([w, d]) => [d, w]));
// Changes what records exist or who owns or sees them: never at organization depth here.
const WRITE_CLASS = new Set(['create', 'write', 'delete', 'assign', 'share']);
// Tables a role made here may only READ: who can do what, and code that runs as someone.
const PROTECTED = new Set(['role', 'roleprivileges', 'privilege', 'systemuser', 'systemuserroles', 'applicationuser', 'team',
  'teamroles', 'teammembership', 'teamprofiles', 'businessunit', 'organization', 'fieldsecurityprofile', 'fieldpermission',
  'systemuserprofiles', 'solution', 'solutioncomponent', 'publisher', 'workflow', 'pluginassembly', 'plugintype', 'pluginpackage',
  'sdkmessageprocessingstep', 'sdkmessageprocessingstepimage', 'serviceendpoint', 'customapi', 'webresource',
  'environmentvariabledefinition', 'environmentvariablevalue', 'connectionreference', 'sbrm_dataversewritelog']);
const NEVER_NAMED = new Set(['system administrator', 'system customizer']);
// What Dataverse gives every new role, as read live 11/9/26 (the 10/21 reference role, HGS), all at Global. A
// privilege on a fresh role outside this list is NOT treated as baseline (review F10 11/9): if Microsoft changes the
// baseline, the read-back says "unexpected" and the role stays revertable, rather than accepting it silently.
const KNOWN_BASELINE = new Set(['prvreadpluginassembly', 'prvreadplugintype', 'prvreadsdkmessage', 'prvreadsdkmessageprocessingstep',
  'prvreadsdkmessageprocessingstepimage', 'prvreadsharepointdata', 'prvreadsharepointdocument', 'prvcreatesharepointdata',
  'prvwritesharepointdata']);
const TABLE = /^[a-z][a-z0-9_]{0,63}$/;

const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const q = (s) => String(s).replace(/'/g, "''");
const enc = (s) => encodeURIComponent(s);
const low = (s) => String(s || '').toLowerCase();
const same = (a, b) => low(a) === low(b);
const oneLine = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
const key = (name, depth) => `${low(name)}|${depth}`;

// ---------- the job file ----------

function validateSecurityRoleJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!obj(raw)) return { errors: ['the job file must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be exactly "${CONTRACT}"`);
  if (raw.kind !== 'securityrole') err('"kind" must be "securityrole"');
  if (typeof raw.env !== 'string' || !has(envs, raw.env)) err(`"env" must be one of: ${Object.keys(envs).join(', ')}`);
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required (script path, or "claude-session")');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > 500 || /[\r\n]/.test(raw.reason)) err('"reason" must be one line, at most 500 characters');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!oneLine(name, 100)) err('"name" must be the new role\'s name, one line, at most 100 characters');
  else if (!name.startsWith('#_ ')) err('"name" must start with "#_ " (SBRM\'s own roles are named "#_ ...", so they sort apart from Microsoft\'s)');
  else if (NEVER_NAMED.has(low(name))) err(`"name" may not be ${name}`);
  if (raw.description !== undefined && !oneLine(raw.description, 2000)) err('"description" must be one line, at most 2000 characters');
  if (raw.writes !== undefined && raw.writes !== true) err('"writes" is either true or left out');

  const privileges = [];
  let anyWrite = false;
  if (!Array.isArray(raw.privileges) || raw.privileges.length < 1 || raw.privileges.length > MAX_TABLES) {
    err(`"privileges" must list 1 to ${MAX_TABLES} tables, each {table, access, depth}`);
  } else {
    const seen = new Set();
    raw.privileges.forEach((p, i) => {
      const at = `privilege ${i + 1}`;
      if (!obj(p)) { err(`${at}: must be an object {table, access, depth}`); return; }
      for (const k of Object.keys(p)) if (!PRIV_KEYS.has(k)) err(`${at}: unknown key "${k}"`);
      const table = typeof p.table === 'string' ? p.table.trim().toLowerCase() : '';
      if (!TABLE.test(table)) err(`${at}: "table" must be the table's logical name (e.g. sbrm_guest)`);
      else if (seen.has(table)) err(`${at}: ${table} appears more than once (list every access for a table in one entry)`);
      seen.add(table);
      const access = Array.isArray(p.access) ? p.access.map((a) => String(a).toLowerCase()) : [];
      if (!access.length || access.some((a) => !has(ACCESS, a)) || new Set(access).size !== access.length) {
        err(`${at}: "access" must list one or more of ${Object.keys(ACCESS).join(', ')}, none twice`);
      }
      if (!has(DEPTH, p.depth)) err(`${at}: "depth" must be one of ${Object.keys(DEPTH).join(', ')}`);
      const writes = access.filter((a) => a !== 'read');
      if (writes.length) anyWrite = true;
      if (writes.length && raw.writes !== true) err(`${at}: ${writes.join(', ')} on ${table || 'this table'} needs "writes": true on the job (a role made here reads only unless the job says otherwise)`);
      const wc = access.filter((a) => WRITE_CLASS.has(a));
      if (wc.length && p.depth === 'organization') err(`${at}: ${wc.join(', ')} at organization depth is never given here (a role made here changes only what its own user owns, its business unit's at most); Ask Dylan`);
      if (writes.length && PROTECTED.has(table)) err(`${at}: ${table} decides who can do what or runs code, so a role made here may only read it`);
      privileges.push({ table, access, depth: p.depth });
    });
  }
  if (raw.writes === true && !anyWrite && Array.isArray(raw.privileges) && raw.privileges.length) err('"writes": true but every privilege is read: leave "writes" out');

  const intent = raw.intent;
  const count = privileges.reduce((n, p) => n + p.access.length, 0);
  if (!obj(intent)) err('"intent" is required: {verb: "securityrole", name, privileges (how many), writes}');
  else if (!errors.length) {
    const mism = [];
    for (const k of Object.keys(intent)) if (!['verb', 'name', 'privileges', 'writes'].includes(k)) mism.push(`unknown key "${k}"`);
    if (intent.verb !== 'securityrole') mism.push(`verb says "${intent.verb}"; a new security role is "securityrole"`);
    if (typeof intent.name !== 'string' || intent.name.trim() !== name) mism.push(`intent names the role "${intent.name}", the file "${name}"`);
    if (intent.privileges !== count) mism.push(`intent says ${intent.privileges} privileges, the file asks for ${count}`);
    if (intent.writes !== anyWrite) mism.push(`intent says writes ${intent.writes}, the file ${anyWrite ? 'writes' : 'only reads'}`);
    if (mism.length) err(`intent does not match the job (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  const job = { contract: CONTRACT, kind: 'securityrole', env: raw.env, name, privileges, writes: anyWrite, source: raw.source.trim(), reason: raw.reason.trim(), intent };
  if (raw.description !== undefined) job.description = raw.description.trim();
  return { errors: [], job };
}

// ---------- live reads ----------

function rolesNamed(dv, name) {
  return dv.get(`roles?$select=roleid,name,_parentrootroleid_value,_businessunitid_value,ismanaged&$filter=${enc(`name eq '${q(name)}'`)}`).value || [];
}

function readRole(dv, id) {
  try {
    return dv.get(`roles(${id})?$select=roleid,name,_parentrootroleid_value,_businessunitid_value,ismanaged`);
  } catch (e) {
    if (e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

function rootUnit(dv) {
  return dv.get(`businessunits?$select=businessunitid,name&$filter=${enc('_parentbusinessunitid_value eq null')}`).value || [];
}

function readUnit(dv, id) {
  try {
    return dv.get(`businessunits(${id})?$select=businessunitid,name`);
  } catch (e) {
    if (e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

// A table's privileges from its metadata, or null when there is no such table.
function tablePrivileges(dv, table) {
  try {
    const m = dv.get(`EntityDefinitions(LogicalName='${table}')?$select=LogicalName,OwnershipType,Privileges`);
    return { ownership: m.OwnershipType || null, privileges: Array.isArray(m.Privileges) ? m.Privileges : [] };
  } catch (e) {
    if (e instanceof DataverseError && /0x80060888|0x8004431a|0x80040217|not found|does not exist|could not find/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

// Every privilege a role holds, with its depth ("Basic" ... "Global").
function rolePrivileges(dv, roleId) {
  const r = dv.get(`RetrieveRolePrivilegesRole(RoleId=${roleId})`, { strong: true });
  return (r.RolePrivileges || []).map((p) => ({ name: String(p.PrivilegeName || p.PrivilegeId), id: low(p.PrivilegeId), depth: String(p.Depth) }));
}

// The people and teams that hold a role, through any business unit's copy of it.
function holders(dv, rootId) {
  const people = [];
  const teams = [];
  for (const c of dv.get(`roles?$select=roleid&$filter=${enc(`_parentrootroleid_value eq ${rootId}`)}`).value || []) {
    for (const u of dv.get(`roles(${c.roleid})/systemuserroles_association?$select=systemuserid,fullname`).value || []) people.push(String(u.fullname || u.systemuserid));
    for (const t of dv.get(`roles(${c.roleid})/teamroles_association?$select=teamid,name`).value || []) teams.push(String(t.name || t.teamid));
  }
  return { people: [...new Set(people)].sort(), teams: [...new Set(teams)].sort() };
}

// Resolve the job's table entries to privilege rows; returns { rows, problems }.
function resolvePrivileges(dv, entries) {
  const rows = [];
  const problems = [];
  for (const e of entries) {
    const meta = tablePrivileges(dv, e.table);
    if (!meta) { problems.push(`there is no table named ${e.table}`); continue; }
    const depth = DEPTH[e.depth];
    for (const a of e.access) {
      const p = meta.privileges.find((x) => x.PrivilegeType === ACCESS[a]);
      if (!p) { problems.push(`${e.table} has no ${a} privilege`); continue; }
      if (!p[CAN[depth]]) {
        const ok = Object.entries(CAN).filter(([, flag]) => p[flag]).map(([d]) => WORD_FOR[d]);
        problems.push(`${a} on ${e.table} cannot be given at ${e.depth} depth${meta.ownership === 'OrganizationOwned' ? ' (an organization-owned table)' : ''}; it allows ${ok.join(', ') || 'none'}`);
        continue;
      }
      rows.push({ table: e.table, access: a, depth_word: e.depth, depth, privilege_id: low(p.PrivilegeId), privilege_name: String(p.Name) });
    }
  }
  return { rows, problems };
}

function severityFor(plan, warnRows) {
  if (plan.action === 'delete') return severity.assess({ count: 1, noun: 'security roles', irreversible: [`deletes the role '${plan.name}'; re-creating it makes a new role with a new id`] }, { warnRows });
  return severity.assess({ count: plan.privileges.length, noun: 'privileges' }, { warnRows });
}

// ---------- plan ----------

function title(plan) {
  if (plan.action === 'delete') return `Delete the security role '${plan.name}' in the ${plan.app}`;
  return `Create the security role '${plan.name}' in the ${plan.app} (${plan.privileges.length} privilege${plan.privileges.length === 1 ? '' : 's'}${plan.writes ? ', WRITES' : ', read only'})`;
}

async function planSecurityRole(dv, job, { envs, access, warnRows = severity.DEFAULT_WARN_ROWS }) {
  const envInfo = envs[job.env];
  const app = envInfo.name;
  const identity = admin(dv, job.env, app, access);
  const problems = [];
  const clash = rolesNamed(dv, job.name);
  if (clash.length) problems.push(`a role named '${clash[0].name}' already exists in the ${app}; choose another name`);
  const units = rootUnit(dv);
  if (units.length !== 1) problems.push(`could not read the ${app}'s root business unit (${units.length} found)`);
  const { rows, problems: p2 } = resolvePrivileges(dv, job.privileges);
  problems.push(...p2);
  if (problems.length) throw new PlanRefused(problems, 'invalid_job');
  const plan = {
    contract: CONTRACT, kind: 'securityrole', env: job.env, host: envInfo.host, app, mode: 'securityrole', action: 'create',
    name: job.name, description: job.description || null, writes: job.writes, unit: { id: low(units[0].businessunitid), name: String(units[0].name) },
    privileges: rows, source: job.source, reason: job.reason, intent: job.intent, identity: identity.me, access: identity.level,
    cli_version: dv.cliVersion || null, need: 'admin', refused: [], reverts_plan_id: null,
  };
  plan.severity = severityFor(plan, warnRows);
  return plan;
}

function admin(dv, env, app, access) {
  const me = whoAmI(dv);
  if (!me.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, env), me.email, env);
  if (!atLeast(acc.level, 'admin')) {
    throw new PlanRefused([`a security role decides what someone can see and change in the ${app}, so it takes admin access; ${me.fullname} has ${acc.level}. Ask Dylan.`],
      atLeast(acc.level, 'write') ? 'not_permitted' : 'access_read');
  }
  return { me, level: acc.level };
}

// ---------- the pop-up ----------

function privLines(plan) {
  const byTable = new Map();
  for (const r of plan.privileges) {
    if (!byTable.has(r.table)) byTable.set(r.table, []);
    byTable.get(r.table).push(`${r.access} (${r.depth_word})`);
  }
  return [...byTable].map(([t, xs]) => `    ${t}: ${xs.join(', ')}`);
}

function securityRoleSummary(plan) {
  const out = [...severity.block(plan.severity), title(plan), ''];
  if (plan.action === 'delete') {
    out.push(`  Nobody holds it. Its ${plan.expect_privileges.length} privileges are what the plan that made it left.`, '', '  Not undone by revert: re-create it with a new job.');
  } else {
    out.push('  Privileges:', ...privLines(plan), `  Business unit: ${plan.unit.name} (Dataverse copies the role to every business unit)`,
      '  Dataverse also gives every new role its baseline at organization depth: Read on plug-ins and SDK messages, and Read,',
      '  Create and Write on SharePoint data (the 10/21 hand-made role carries the same). The read-back lists it.', '',
      '  Can be undone with revert (it deletes the role, while nobody holds it).');
  }
  out.push('', `Reason given: ${plan.reason}`);
  return out.join('\n');
}

function securityRoleDetail(plan, { id } = {}) {
  const out = [...severity.block(plan.severity), title(plan), '', `Requested by: ${plan.identity.fullname} (${plan.identity.email})`, `Reason given: ${plan.reason}`, `Made by: ${plan.source}`];
  if (id) out.push(`Plan: ${id}`);
  if (plan.reverts_plan_id) out.push(`Undoes plan: ${plan.reverts_plan_id}`);
  out.push(`Access needed: admin (a security role decides what someone can see and change); ${plan.identity.fullname} has ${plan.access}`, '');
  if (plan.action === 'delete') {
    out.push(`Role: ${plan.role_id}`, ...plan.expect_privileges.map((p) => `  ${p.name} (${p.depth})`));
  } else {
    if (plan.description) out.push(`Description: ${plan.description}`);
    out.push(`Business unit: ${plan.unit.name} (${plan.unit.id})`);
    for (const r of plan.privileges) out.push(`  ${r.privilege_name} at ${r.depth} (${r.privilege_id})`);
  }
  return out.join('\n');
}

// ---------- apply ----------

function planShapeProblems(plan) {
  const bad = [];
  if (!plan || plan.mode !== 'securityrole') bad.push(`the mode "${plan && plan.mode}"`);
  if (!plan || !oneLine(plan.name, 100) || !String(plan.name).startsWith('#_ ')) bad.push('a role name outside the "#_ " form');
  if (plan && plan.action === 'create') {
    if (!obj(plan.unit) || !GUID.test(String(plan.unit.id))) bad.push('a business unit that is not a GUID');
    if (!Array.isArray(plan.privileges) || !plan.privileges.length) bad.push('no privileges');
    else {
      for (const r of plan.privileges) {
        if (!obj(r) || !GUID.test(String(r.privilege_id)) || !has(ACCESS, r.access) || DEPTH[r.depth_word] !== r.depth) { bad.push('a privilege row that is not one a plan makes'); break; }
        if (!plan.writes && r.access !== 'read') { bad.push(`${r.access} on a read-only role`); break; }
        if (WRITE_CLASS.has(r.access) && r.depth === 'Global') { bad.push(`${r.access} at organization depth`); break; }
        if (r.access !== 'read' && PROTECTED.has(r.table)) { bad.push(`${r.access} on ${r.table}`); break; }
      }
    }
  } else if (plan && plan.action === 'delete') {
    if (!GUID.test(String(plan.role_id)) || !Array.isArray(plan.expect_privileges)) bad.push('no role or before state');
  } else bad.push(`the action "${plan && plan.action}"`);
  return bad;
}

const refuse = (msg, code) => { throw new ApplyRefused(`${msg} Nothing was written; make a new plan.`, code); };

async function applySecurityRole(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date() } = deps;
  if (now - new Date(plan.created) > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old. Make a new plan.', 'stale_plan');
  const shapeBad = planShapeProblems(plan);
  if (shapeBad.length) throw new ApplyRefused(`this plan file asks to write ${shapeBad.join(', ')}, which no security role plan writes. It was changed after it was made; make a new plan. Nothing was written.`, 'plan_tampered');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  if (!atLeast(acc.level, 'admin')) throw new ApplyRefused(`a security role takes admin access; you have ${acc.level}. Nothing was written.`, 'access_revoked');
  return plan.action === 'delete' ? applyDelete(plan, dv, me, acc, { id, file, fs, confirm, now }) : applyCreate(plan, dv, me, acc, { id, file, fs, confirm, now });
}

function baseEntry(plan, me, id, now, view) {
  return {
    time: now.toISOString(), plan_id: id, person: me, env: plan.env, app: plan.app, table: 'roles', mode: 'securityrole', action: plan.action,
    source: plan.source, reason: plan.reason, approval: 'prompt', left_out: [], headline: title(view), reverts_plan_id: plan.reverts_plan_id || null,
  };
}

function applyCreate(plan, dv, me, acc, { id, file, fs, confirm, now }) {
  if (rolesNamed(dv, plan.name).length) refuse(`a role named '${plan.name}' exists since the plan.`, 'snapshot_moved');
  if (!readUnit(dv, plan.unit.id)) refuse(`the business unit ${plan.unit.name} is gone since the plan.`, 'snapshot_moved');
  // The privileges again from metadata: the same ids, the depth still allowed.
  const entries = [];
  for (const r of plan.privileges) {
    let e = entries.find((x) => x.table === r.table);
    if (!e) { e = { table: r.table, access: [], depth: r.depth_word }; entries.push(e); }
    if (e.depth !== r.depth_word) refuse(`the plan gives ${r.table} two depths.`, 'plan_tampered');
    e.access.push(r.access);
  }
  const again = resolvePrivileges(dv, entries);
  if (again.problems.length) refuse(`the tables changed since the plan: ${again.problems.join('; ')}.`, 'snapshot_moved');
  for (const r of plan.privileges) {
    if (!again.rows.some((x) => x.privilege_id === r.privilege_id && x.depth === r.depth)) refuse(`${r.privilege_name} is not what the table's metadata says since the plan.`, 'snapshot_moved');
  }
  const view = { ...plan, access: acc.level };
  const answer = confirm({ summaryText: securityRoleSummary(view), detailText: securityRoleDetail(view, { id }), title: `SBRM: approve this new security role in the ${plan.app}?` });
  const base = baseEntry(plan, me, id, now, view);
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };
  if (rolesNamed(dv, plan.name).length) refuse(`a role named '${plan.name}' was made while the approval was waiting.`, 'snapshot_moved');

  const asked = plan.privileges.map((r) => ({ name: r.privilege_name, depth: r.depth }));
  const row = { name: `'${plan.name}'`, action: 'create', id: null, role: { name: plan.name, unit: plan.unit }, asked, writes: plan.writes, before: { exists: false }, after: null, baseline: null };
  let roleId = null;
  try {
    const made = dv.createRole(plan.name, plan.unit.id, plan.description || undefined) || {};
    roleId = GUID.test(String(made.roleid)) ? low(made.roleid) : null;
    if (!roleId) {
      const found = rolesNamed(dv, plan.name).filter((r) => same(r._businessunitid_value, plan.unit.id));
      if (found.length === 1) roleId = low(found[0].roleid);
    }
    if (!roleId) throw new Error('the role was sent but could not be found by its name afterwards');
    row.id = roleId;
    row.baseline = rolePrivileges(dv, roleId).map(({ name, depth }) => ({ name, depth }));
    dv.addRolePrivileges(roleId, plan.privileges.map((r) => ({ PrivilegeId: r.privilege_id, Depth: r.depth, BusinessUnitId: plan.unit.id })));
    const got = rolePrivileges(dv, roleId).map(({ name, depth }) => ({ name, depth }));
    row.after = { role_id: roleId, privileges: got };
    const gotKeys = new Set(got.map((p) => key(p.name, p.depth)));
    const missing = asked.filter((p) => !gotKeys.has(key(p.name, p.depth)));
    const allowed = new Set([...asked, ...row.baseline.filter((p) => KNOWN_BASELINE.has(low(p.name)) && p.depth === 'Global')].map((p) => key(p.name, p.depth)));
    const extra = got.filter((p) => !allowed.has(key(p.name, p.depth)));
    row.outcome = !missing.length && !extra.length ? 'written'
      : `read-back mismatch:${missing.length ? ` missing ${missing.map((p) => `${p.name} (${p.depth})`).join(', ')}` : ''}${extra.length ? ` unexpected ${extra.map((p) => `${p.name} (${p.depth})`).join(', ')}` : ''}`;
  } catch (e) {
    row.outcome = `failed: ${e.message}`;
    // A create can commit and still lose its answer (a timeout): look for the role by its name in its unit, so the
    // log carries its id and revert can delete it (review F12 11/9).
    if (!roleId) {
      try {
        const found = rolesNamed(dv, plan.name).filter((r) => same(r._businessunitid_value, plan.unit.id));
        if (found.length === 1) { roleId = low(found[0].roleid); row.id = roleId; }
      } catch { /* leave it unknown */ }
    }
    if (roleId) {
      try { row.after = { role_id: roleId, privileges: rolePrivileges(dv, roleId).map(({ name, depth }) => ({ name, depth })) }; } catch { row.after = { role_id: roleId, privileges: null }; }
    }
  }
  row.changes = [{ label: 'Security role', old_text: 'none', new_text: roleId ? `${plan.name} (${asked.length} asked, ${row.after && row.after.privileges ? row.after.privileges.length : '?'} held)` : 'not made' }];
  fs.rmSync(file, { force: true });
  const ok = row.outcome === 'written' ? 1 : 0;
  const outcome = ok ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows: [row] }, outcome, person: me, dv, written: ok, rows: [row], left_out: [] };
}

function deleteChecks(dv, plan, { revertOf }) {
  const r = readRole(dv, plan.role_id);
  if (!r) return { problem: `the role '${plan.name}' is already gone`, code: 'nothing_to_undo' };
  if (!same(r.name, plan.name)) return { problem: `the role ${plan.role_id} is now named '${r.name}', not '${plan.name}'${revertOf ? `, so it changed since plan ${revertOf}` : ''}`, code: 'snapshot_moved' };
  if (r.ismanaged) return { problem: `'${r.name}' is a Microsoft (managed) role; it is never deleted here`, code: 'not_permitted' };
  if (r._parentrootroleid_value && !same(r._parentrootroleid_value, r.roleid)) return { problem: `'${r.name}' ${plan.role_id} is a business unit's copy, not the role itself`, code: 'not_permitted' };
  const h = holders(dv, plan.role_id);
  if (h.people.length || h.teams.length) {
    return { problem: `'${r.name}' is held by ${[...h.people, ...h.teams.map((t) => `the team ${t}`)].join(', ')}; take it from them first (kind "role")`, code: 'not_permitted' };
  }
  const now = rolePrivileges(dv, plan.role_id).map((p) => key(p.name, p.depth)).sort();
  const want = plan.expect_privileges.map((p) => key(p.name, p.depth)).sort();
  if (now.join('\n') !== want.join('\n')) return { problem: `'${r.name}''s privileges changed since ${revertOf ? `plan ${revertOf}` : 'the plan'}, so deleting it would throw away someone's later change`, code: 'snapshot_moved' };
  return { role: r };
}

function applyDelete(plan, dv, me, acc, { id, file, fs, confirm, now }) {
  const c = deleteChecks(dv, plan, { revertOf: null });
  if (c.problem) refuse(`${c.problem}.`, c.code === 'nothing_to_undo' ? 'snapshot_moved' : c.code);
  const etag = c.role['@odata.etag'];
  if (!etag) refuse(`could not read the role's version tag.`, 'snapshot_moved');
  const view = { ...plan, access: acc.level };
  const answer = confirm({ summaryText: securityRoleSummary(view), detailText: securityRoleDetail(view, { id }), title: `SBRM: approve deleting this security role in the ${plan.app}?` });
  const base = baseEntry(plan, me, id, now, view);
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };
  // The prompt can wait minutes: who holds the role, and its privileges, are read again after the Yes (review F7 11/9).
  const again = deleteChecks(dv, plan, { revertOf: null });
  if (again.problem) refuse(`Something changed while the approval was waiting: ${again.problem}.`, 'snapshot_moved');
  const row = { name: `'${plan.name}'`, action: 'delete', id: plan.role_id, role: { name: plan.name }, before: { exists: true, privileges: plan.expect_privileges }, after: null };
  try {
    dv.deleteRole(plan.role_id, etag);
    const gone = !readRole(dv, plan.role_id);
    row.after = { exists: !gone };
    row.outcome = gone ? 'written' : `read-back mismatch: '${plan.name}' is still there`;
  } catch (e) {
    row.outcome = `failed: ${e.message}`;
    try { row.after = { exists: Boolean(readRole(dv, plan.role_id)) }; } catch { row.after = null; }
  }
  row.changes = [{ label: 'Security role', old_text: plan.name, new_text: row.after && row.after.exists === false ? 'deleted' : 'still there' }];
  fs.rmSync(file, { force: true });
  const ok = row.outcome === 'written' ? 1 : 0;
  const outcome = ok ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows: [row] }, outcome, person: me, dv, written: ok, rows: [row], left_out: [] };
}

// ---------- revert ----------
//
// A create is undone by deleting the role, only while nobody holds it and its privileges are what the apply left.
// A delete is not undone here (re-create it with a new job). A log entry is data: a forged or damaged one is refused.

async function planSecurityRoleRevert(dv, entry, ctx) {
  if (!entry || entry.mode !== 'securityrole') throw new PlanRefused(['that plan is not a security role change'], 'nothing_to_undo');
  if (!['applied', 'applied with problems'].includes(entry.outcome)) throw new PlanRefused([`that change's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  const envs = (ctx && ctx.envs) || {};
  if (typeof entry.env !== 'string' || !has(envs, entry.env)) throw new PlanRefused([`that log entry names an environment the toolkit does not know ("${entry.env}")`], 'invalid_job');
  if (dv.host && low(dv.host) !== low(envs[entry.env].host)) {
    throw new PlanRefused([`that change was made in the ${envs[entry.env].name}; this revert was planned against another environment. Revert it in the ${envs[entry.env].name}.`], 'invalid_job');
  }
  const r = (entry.rows || [])[0];
  if (!obj(r) || r.action === 'delete') throw new PlanRefused(['a deleted role is not brought back here: re-create it with a new job'], 'nothing_to_undo');
  if (r.action !== 'create' || !obj(r.role) || !oneLine(r.role.name, 100) || !String(r.role.name).startsWith('#_ ')) throw new PlanRefused(['that log entry has no valid role or action'], 'invalid_job');
  if (!obj(r.after) || !GUID.test(String(r.after.role_id))) throw new PlanRefused([`that change did not make a role (${r.outcome}); there is nothing to undo`], 'nothing_to_undo');
  if (!Array.isArray(r.after.privileges) || r.after.privileges.some((p) => !obj(p) || typeof p.name !== 'string' || typeof p.depth !== 'string')) {
    throw new PlanRefused(["that log entry has no read-back of the role's privileges, so it cannot show nothing changed since; an admin deletes it by hand"], 'invalid_job');
  }
  const { envs: e2, access, warnRows = severity.DEFAULT_WARN_ROWS } = ctx;
  const envInfo = e2[entry.env];
  const app = envInfo.name;
  const identity = admin(dv, entry.env, app, access);
  const plan = {
    contract: CONTRACT, kind: 'securityrole', env: entry.env, host: envInfo.host, app, mode: 'securityrole', action: 'delete',
    name: r.role.name.trim(), role_id: low(r.after.role_id), expect_privileges: r.after.privileges.map((p) => ({ name: p.name, depth: p.depth })),
    source: `revert ${entry.plan_id}`,
    reason: `Undo plan ${entry.plan_id} ("${entry.headline}", by ${entry.person ? entry.person.fullname : 'unknown'}).`.replace(/[\r\n]+/g, ' ').slice(0, 500),
    intent: { verb: 'securityrole', name: r.role.name.trim(), action: 'delete' }, identity: identity.me, access: identity.level,
    cli_version: dv.cliVersion || null, need: 'admin', refused: [], reverts_plan_id: entry.plan_id,
  };
  const c = deleteChecks(dv, plan, { revertOf: entry.plan_id });
  if (c.problem) throw new PlanRefused([c.problem], c.code);
  plan.severity = severityFor(plan, warnRows);
  return plan;
}

module.exports = {
  validateSecurityRoleJob, planSecurityRole, securityRoleSummary, securityRoleDetail, applySecurityRole, planSecurityRoleRevert,
  planShapeProblems, PROTECTED, WRITE_CLASS,
};
