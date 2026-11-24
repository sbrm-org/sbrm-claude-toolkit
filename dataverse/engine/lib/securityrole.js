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
//
// Action "remove" (1.11.43; Dylan 11/20/26, "Build both into the toolkit", after an operator clicked New on the
// shelter waitlist and hit a duplicate): take privileges OFF an EXISTING SBRM role, e.g. Create on one table so its
// New button disappears for everyone who holds the role. Job: `role` (the existing "#_ " role's name) + `remove`
// ([{table, access}]). The plan names who holds the role and every OTHER role that gives the same privilege (a holder
// of one of those keeps it: privileges add up across roles). Apply removes exactly those, and the read-back must show
// them gone and every other privilege where it was. Undo ("restore") gives back exactly what that apply removed, at
// the depth it was held, while the role is still as the apply left it: the ONE place this kind adds write-class
// access at organization depth, and only as a restore of a logged removal, named privilege by privilege in the prompt.
// Never: a Microsoft (managed) role, System Administrator / Customizer, or the security and code tables.

const { whoAmI, accessFor, PlanRefused } = require('./resolve');
const { resolveAccess } = require('./access');
const { ApplyRefused } = require('./apply');
const { planTooOld, STALE_TEXT } = require('./store');
const { DataverseError } = require('./cli');
const { GUID } = require('./contract');
const { atLeast } = require('./levels');
const severity = require('./severity');

const CONTRACT = 'sbrm-dv-job/1';
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_TABLES = 50;
const TOP_KEYS = new Set(['contract', 'kind', 'env', 'name', 'description', 'privileges', 'writes', 'role', 'remove', 'source', 'reason', 'intent']);
const PRIV_KEYS = new Set(['table', 'access', 'depth']);
const REMOVE_KEYS = new Set(['table', 'access']);
const NEW_ROLE_KEYS = ['name', 'description', 'privileges', 'writes'];
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
  if (has(raw, 'role') || has(raw, 'remove')) return validateRemoveJob(raw, errors);
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

// Taking privileges off an existing role: `role` + `remove` only (the new-role keys are refused, so a job cannot mean
// both). `errors` already holds the common checks' findings.
function validateRemoveJob(raw, errors) {
  const err = (m) => errors.push(m);
  for (const k of NEW_ROLE_KEYS) if (has(raw, k)) err(`"${k}" belongs to a NEW role; taking privileges off an existing role uses "role" and "remove" only`);
  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  if (!oneLine(role, 100)) err('"role" must be the existing role\'s name, one line, at most 100 characters');
  else if (NEVER_NAMED.has(low(role))) err(`"role" may not be ${role}`);
  else if (!role.startsWith('#_ ')) err('"role" must be one of SBRM\'s own roles (named "#_ ..."); Microsoft\'s roles are changed by hand in the admin center');
  const remove = [];
  if (!Array.isArray(raw.remove) || raw.remove.length < 1 || raw.remove.length > MAX_TABLES) {
    err(`"remove" must list 1 to ${MAX_TABLES} tables, each {table, access}`);
  } else {
    const seen = new Set();
    raw.remove.forEach((p, i) => {
      const at = `remove ${i + 1}`;
      if (!obj(p)) { err(`${at}: must be an object {table, access}`); return; }
      for (const k of Object.keys(p)) if (!REMOVE_KEYS.has(k)) err(`${at}: unknown key "${k}"${k === 'depth' ? ' (a privilege is removed at whatever depth the role holds it)' : ''}`);
      const table = typeof p.table === 'string' ? p.table.trim().toLowerCase() : '';
      if (!TABLE.test(table)) err(`${at}: "table" must be the table's logical name (e.g. sbrm_guest)`);
      else if (seen.has(table)) err(`${at}: ${table} appears more than once (list every access for a table in one entry)`);
      seen.add(table);
      const access = Array.isArray(p.access) ? p.access.map((a) => String(a).toLowerCase()) : [];
      if (!access.length || access.some((a) => !has(ACCESS, a)) || new Set(access).size !== access.length) {
        err(`${at}: "access" must list one or more of ${Object.keys(ACCESS).join(', ')}, none twice`);
      }
      if (PROTECTED.has(table)) err(`${at}: ${table} decides who can do what or runs code; its privileges are changed by hand in the admin center`);
      remove.push({ table, access });
    });
  }
  const intent = raw.intent;
  const count = remove.reduce((n, p) => n + p.access.length, 0);
  if (!obj(intent)) err('"intent" is required: {verb: "securityrole", role, action: "remove", privileges (how many)}');
  else if (!errors.length) {
    const mism = [];
    for (const k of Object.keys(intent)) if (!['verb', 'role', 'action', 'privileges'].includes(k)) mism.push(`unknown key "${k}"`);
    if (intent.verb !== 'securityrole') mism.push(`verb says "${intent.verb}"; a security role change is "securityrole"`);
    if (intent.action !== 'remove') mism.push(`action says "${intent.action}"; taking privileges off a role is "remove"`);
    if (typeof intent.role !== 'string' || intent.role.trim() !== role) mism.push(`intent names the role "${intent.role}", the file "${role}"`);
    if (intent.privileges !== count) mism.push(`intent says ${intent.privileges} privileges, the file removes ${count}`);
    if (mism.length) err(`intent does not match the job (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  return { errors: [], job: { contract: CONTRACT, kind: 'securityrole', env: raw.env, action: 'remove', role, remove, source: raw.source.trim(), reason: raw.reason.trim(), intent } };
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

// A role's root and every business unit's copy of it. The root itself is always included (review F30): a root whose
// parent-root reads null (isRoot accepts that) would otherwise not be found by the filter.
function roleCopies(dv, rootId) {
  const ids = [low(rootId)];
  for (const c of dv.get(`roles?$select=roleid&$filter=${enc(`_parentrootroleid_value eq ${rootId}`)}`).value || []) {
    if (!ids.includes(low(c.roleid))) ids.push(low(c.roleid));
  }
  return ids;
}

// The people and teams that hold a role, through any business unit's copy of it.
function holders(dv, rootId) {
  const people = [];
  const teams = [];
  for (const rid of roleCopies(dv, rootId)) {
    for (const u of dv.get(`roles(${rid})/systemuserroles_association?$select=systemuserid,fullname`).value || []) people.push(String(u.fullname || u.systemuserid));
    for (const t of dv.get(`roles(${rid})/teamroles_association?$select=teamid,name`).value || []) teams.push(String(t.name || t.teamid));
  }
  return { people: [...new Set(people)].sort(), teams: [...new Set(teams)].sort() };
}

// The same, told apart for a removal's prompt (measured live in HGS 11/23/26: of 25 "people" holding '#_ SBRM Normal',
// 12 were disabled accounts and 1 an application user, so "25 people lose it" overstated who is affected): enabled
// people, enabled application users (an integration that loses a privilege stops working), teams, and how many
// disabled accounts also hold it. Only an account READ as disabled counts as disabled.
function holdersDetail(dv, rootId) {
  const people = [];
  const apps = [];
  const teams = [];
  const seen = new Set();
  let disabled = 0;
  const ids = [];
  for (const rid of roleCopies(dv, rootId)) {
    for (const u of dv.get(`roles(${rid})/systemuserroles_association?$select=systemuserid,fullname,isdisabled,applicationid`).value || []) {
      const k = low(u.systemuserid);
      if (seen.has(k)) continue;
      seen.add(k);
      ids.push(k);
      const name = String(u.fullname || u.systemuserid);
      if (u.isdisabled === true) disabled += 1;
      else if (u.applicationid) apps.push(name);
      else people.push(name);
    }
    for (const t of dv.get(`roles(${rid})/teamroles_association?$select=teamid,name`).value || []) { teams.push(String(t.name || t.teamid)); ids.push(`team:${low(t.teamid)}`); }
  }
  // `ids` (round-2 review F2): who holds it by id, so a holder swapped for another account of the same name is a change.
  return { people: people.sort(), apps: apps.sort(), teams: [...new Set(teams)].sort(), disabled, ids: [...new Set(ids)].sort() };
}

// A role's ROOT row (each business unit holds a copy; only the root carries the truth, and the copies read unmanaged
// even when the root is managed). Returns the root rows with that name.
const isRoot = (r) => !r._parentrootroleid_value || same(r._parentrootroleid_value, r.roleid);
function rootRolesNamed(dv, name) {
  return rolesNamed(dv, name).filter(isRoot);
}

// Every OTHER role (by its root) that gives this privilege, at what depth, with how many people and teams hold it:
// anyone holding one of them keeps the privilege after it is taken off this role, at THAT role's depth (review F22: a
// role giving it at user depth keeps it for their own records only). privilegedepthmask read live 11/23/26 in HGS.
const MASK = { 1: 'Basic', 2: 'Local', 4: 'Deep', 8: 'Global' };
function alsoGiven(dv, privilegeId, exceptRootId) {
  const roots = new Map();
  for (const rp of dv.get(`roleprivilegescollection?$select=roleid,privilegedepthmask&$filter=${enc(`privilegeid eq ${privilegeId}`)}`).value || []) {
    const r = readRole(dv, rp.roleid);
    if (!r) continue;
    const root = low(r._parentrootroleid_value || r.roleid);
    if (same(root, exceptRootId) || roots.has(root)) continue;
    roots.set(root, MASK[rp.privilegedepthmask] || null);
  }
  const out = [];
  for (const [root, depth] of roots) {
    const r = readRole(dv, root);
    const h = holdersDetail(dv, root);
    out.push({ name: r ? String(r.name) : root, managed: Boolean(r && r.ismanaged), depth, people: h.people.length, apps: h.apps.length, teams: h.teams });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// A privilege's name by its id, or null when there is none (undo checks the logged pair still matches).
function privilegeName(dv, id) {
  try {
    const p = dv.get(`privileges(${id})?$select=privilegeid,name`);
    return p && p.name ? String(p.name) : null;
  } catch (e) {
    if (e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

// The table a privilege name is about ("prvCreatesbrm_WaitlistCount" -> "sbrm_waitlistcount"), or null.
// The users table's privileges are named for "User", not "systemuser" (read live 11/23/26 in HGS: prvWriteUser; review
// F15), so the name is mapped before the security and code tables are checked.
const PRIVILEGE_TABLE_ALIAS = { user: 'systemuser' };
function privilegeTable(name) {
  const m = /^prv(?:Create|Read|Write|Delete|Assign|Share|AppendTo|Append)(.+)$/.exec(String(name));
  if (!m) return null;
  const t = m[1].toLowerCase();
  return PRIVILEGE_TABLE_ALIAS[t] || t;
}

const pkey = (p) => `${low(p.id)}|${p.depth}`;
const sameSet = (a, b) => {
  const x = a.map(pkey).sort();
  const y = b.map(pkey).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

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

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
// "12 people, 1 application user and 1 team": enabled holders only (disabled accounts are said separately).
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join(''));
const holderText = (h) => andList([
  h.people.length ? plural(h.people.length, 'person', 'people') : null,
  (h.apps || []).length ? plural(h.apps.length, 'application user') : null,
  h.teams.length ? plural(h.teams.length, 'team') : null,
].filter(Boolean)) || 'nobody';

// The severity lines are what Claude Code's prompt shows besides the headline (round-2 review F14, F6), so each one
// carries its own facts: who is affected, the application users by name, and every other role giving the privilege.
function othersText(plan) {
  const seen = new Map();
  for (const g of plan.also_given || []) for (const r of g.roles) if (!seen.has(r.name)) seen.set(r.name, r);
  const all = [...seen.values()];
  if (!all.length) return 'no other role gives it';
  const one = (r) => `${r.name}${r.depth ? ` (${WORD_FOR[r.depth] || r.depth})` : ''}`;
  return `also given by ${andList(all.slice(0, 5).map(one))}${all.length > 5 ? ` and ${all.length - 5} more roles` : ''}`;
}
const appsText = (h) => ((h.apps || []).length ? ` (application users: ${h.apps.join(', ')})` : '');
const anyHolder = (h) => Boolean(h && (h.people.length || (h.apps || []).length || h.teams.length));
function severityFor(plan, warnRows) {
  if (plan.action === 'delete') return severity.assess({ count: 1, noun: 'security roles', irreversible: [`deletes the role '${plan.name}'; re-creating it makes a new role with a new id`] }, { warnRows });
  if (plan.action === 'remove') {
    const h = plan.holders;
    const ends = anyHolder(h)
      ? [`${holderText(h)}${appsText(h)} holding '${plan.name}' lose ${plan.privileges.map((r) => `${r.access} on ${r.table}`).join(', ')} unless they hold another role giving it; ${othersText(plan)}`]
      : [];
    return severity.assess({ count: plan.privileges.length, noun: 'privileges', ends }, { warnRows });
  }
  if (plan.action === 'restore') {
    const h = plan.holders;
    const gives = anyHolder(h) ? [`${holderText(h)}${appsText(h)} holding '${plan.name}' gain ${plan.privileges.map(plainPrivilege).join(', ')}; ${othersText(plan)}`] : [];
    return severity.assess({ count: plan.privileges.length, noun: 'privileges', gives }, { warnRows });
  }
  return severity.assess({ count: plan.privileges.length, noun: 'privileges' }, { warnRows });
}

// "prvCreatesbrm_WaitlistCount" at Global -> "create on sbrm_waitlistcount (organization)" (round-2 review F25).
function plainPrivilege(p) {
  const m = /^prv(Create|Read|Write|Delete|Assign|Share|AppendTo|Append)(.+)$/.exec(String(p.name));
  const at = WORD_FOR[p.depth] || p.depth;
  return m ? `${m[1].toLowerCase()} on ${privilegeTable(p.name)} (${at})` : `${p.name} (${at})`;
}

// ---------- plan ----------

function title(plan) {
  if (plan.action === 'delete') return `Delete the security role '${plan.name}' in the ${plan.app}`;
  if (plan.action === 'remove') return `Take ${plural(plan.privileges.length, 'privilege')} off the security role '${plan.name}' in the ${plan.app}`;
  if (plan.action === 'restore') return `Give back ${plural(plan.privileges.length, 'privilege')} to the security role '${plan.name}' in the ${plan.app}`;
  return `Create the security role '${plan.name}' in the ${plan.app} (${plan.privileges.length} privilege${plan.privileges.length === 1 ? '' : 's'}${plan.writes ? ', WRITES' : ', read only'})`;
}

// The role's root row, checked: one root by that name, SBRM's own (unmanaged), never System Administrator /
// Customizer. Returns { root } or { problem }.
function editableRole(dv, name) {
  const roots = rootRolesNamed(dv, name);
  if (!roots.length) return { problem: `there is no security role named '${name}'` };
  if (roots.length > 1) return { problem: `${roots.length} security roles are named '${name}'; rename one first` };
  const root = roots[0];
  if (root.ismanaged) return { problem: `'${root.name}' is a Microsoft (managed) role; it is never changed here` };
  if (NEVER_NAMED.has(low(root.name)) || !String(root.name).startsWith('#_ ')) return { problem: `'${root.name}' is not one of SBRM's own "#_ " roles` };
  return { root };
}

async function planRemove(dv, job, envInfo, identity, warnRows) {
  const app = envInfo.name;
  const found = editableRole(dv, job.role);
  if (found.problem) throw new PlanRefused([found.problem], 'invalid_job');
  const root = found.root;
  const roleId = low(root.roleid);
  const held = rolePrivileges(dv, roleId);
  const problems = [];
  const rows = [];
  for (const e of job.remove) {
    const meta = tablePrivileges(dv, e.table);
    if (!meta) { problems.push(`there is no table named ${e.table}`); continue; }
    for (const a of e.access) {
      const p = meta.privileges.find((x) => x.PrivilegeType === ACCESS[a]);
      if (!p) { problems.push(`${e.table} has no ${a} privilege`); continue; }
      // A privilege named for another table is SHARED (activities share prvCreateActivity; round-2 review F15): taking it
      // off would take it off for every table that shares it, so it is refused.
      if (privilegeTable(p.Name) !== e.table) { problems.push(`${a} on ${e.table} is the privilege ${p.Name}, which is not ${e.table}'s own (it covers other tables too); change it in the admin center`); continue; }
      const h = held.find((x) => x.id === low(p.PrivilegeId));
      if (!h) { problems.push(`'${root.name}' does not give ${a} on ${e.table}, so there is nothing to take off`); continue; }
      rows.push({ table: e.table, access: a, privilege_id: low(p.PrivilegeId), privilege_name: String(p.Name), depth: h.depth, depth_word: WORD_FOR[h.depth] || h.depth });
    }
  }
  if (problems.length) throw new PlanRefused(problems, 'invalid_job');
  const plan = {
    contract: CONTRACT, kind: 'securityrole', env: job.env, host: envInfo.host, app, mode: 'securityrole', action: 'remove',
    name: String(root.name), role_id: roleId, unit: { id: low(root._businessunitid_value) }, privileges: rows,
    before: held.map(({ name, id, depth }) => ({ name, id, depth })),
    holders: holdersDetail(dv, roleId), also_given: rows.map((r) => ({ privilege_name: r.privilege_name, roles: alsoGiven(dv, r.privilege_id, roleId) })),
    source: job.source, reason: job.reason, intent: job.intent, identity: identity.me, access: identity.level,
    cli_version: dv.cliVersion || null, need: 'admin', refused: [], reverts_plan_id: null,
  };
  plan.severity = severityFor(plan, warnRows);
  return plan;
}

async function planSecurityRole(dv, job, { envs, access, warnRows = severity.DEFAULT_WARN_ROWS }) {
  const envInfo = envs[job.env];
  if (job.action === 'remove') return planRemove(dv, job, envInfo, admin(dv, job.env, envInfo.name, access), warnRows);
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

function editLines(plan) {
  return plan.privileges.map((r) => `    ${r.table}: ${r.access} (${WORD_FOR[r.depth] || r.depth})`);
}

// Every other role giving the privilege, held or not (review F9), each with the depth it gives it at (F22).
function alsoLines(plan) {
  const out = [];
  for (const g of plan.also_given || []) {
    const who = (r) => [r.people ? plural(r.people, 'person', 'people') : null, r.apps ? plural(r.apps, 'application user') : null, r.teams.length ? `teams: ${r.teams.join(', ')}` : null].filter(Boolean).join('; ') || 'held by nobody';
    const at = (r) => (r.depth ? `at ${WORD_FOR[r.depth] || r.depth} depth; ` : '');
    const text = g.roles.length ? g.roles.map((r) => `${r.name} (${at(r)}${who(r)})`).join(', ') : 'no other role';
    out.push(`    ${g.privilege_name}: ${text}`);
  }
  return out;
}

function securityRoleSummary(plan) {
  const out = [...severity.block(plan.severity), title(plan), ''];
  if (plan.action === 'remove') {
    const h = plan.holders;
    out.push('  Taking off:', ...editLines(plan),
      `  Held by: ${holderText(h)}${h.teams.length ? ` (teams: ${h.teams.join(', ')})` : ''}`,
      ...((h.apps || []).length ? [`  Application users holding it (an integration that loses this stops working): ${h.apps.join(', ')}`] : []),
      ...(h.disabled ? [`  ${plural(h.disabled, 'disabled account')} also hold${h.disabled === 1 ? 's' : ''} it; nothing changes for them.`] : []),
      '  Still given by other roles (anyone holding one keeps it at that role\'s depth, since privileges add up):', ...alsoLines(plan),
      '  People already signed in may keep it until they sign out and back in.', '',
      '  Can be undone with revert (it gives these privileges back at the same depth, while the role is as this leaves it).');
  } else if (plan.action === 'restore') {
    // The same disclosure as a removal (review F13, requirement 6): giving back ADDS access for everyone holding the role.
    const h = plan.holders || { people: [], apps: [], teams: [], disabled: 0 };
    out.push(`  Giving back, as the Write Log row for plan ${plan.reverts_plan_id} says it took them off:`, ...plan.privileges.map((p) => `    ${p.name} (${WORD_FOR[p.depth] || p.depth})`),
      `  Held by: ${holderText(h)}${h.teams.length ? ` (teams: ${h.teams.join(', ')})` : ''}; each of them gains these again.`,
      ...((h.apps || []).length ? [`  Application users holding it: ${h.apps.join(', ')}`] : []),
      ...(h.disabled ? [`  ${plural(h.disabled, 'disabled account')} also hold${h.disabled === 1 ? 's' : ''} it.`] : []),
      '  Also given by other roles:', ...alsoLines(plan), '',
      '  Not undone by revert: take them off again with a new job.');
  } else if (plan.action === 'delete') {
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
  if (plan.action === 'remove' || plan.action === 'restore') {
    out.push(`Role: ${plan.role_id}`);
    if (plan.action === 'remove') {
      for (const r of plan.privileges) out.push(`  remove ${r.privilege_name} (held at ${r.depth}; ${r.privilege_id})`);
      out.push(`Held by: ${plan.holders.people.join(', ') || 'no person'}${(plan.holders.apps || []).length ? `; application users: ${plan.holders.apps.join(', ')}` : ''}${plan.holders.teams.length ? `; teams: ${plan.holders.teams.join(', ')}` : ''}${plan.holders.disabled ? `; disabled accounts: ${plan.holders.disabled}` : ''}`);
      out.push('Other roles giving the same privilege:', ...alsoLines(plan));
    } else {
      for (const p of plan.privileges) out.push(`  add back ${p.name} at ${p.depth} (${p.id})`);
      const h = plan.holders || { people: [], apps: [], teams: [] };
      out.push(`Held by: ${h.people.join(', ') || 'no person'}${(h.apps || []).length ? `; application users: ${h.apps.join(', ')}` : ''}${h.teams.length ? `; teams: ${h.teams.join(', ')}` : ''}${h.disabled ? `; disabled accounts: ${h.disabled}` : ''}`);
      out.push('Other roles giving the same privilege:', ...alsoLines(plan));
    }
  } else if (plan.action === 'delete') {
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
  } else if (plan && plan.action === 'remove') {
    if (!GUID.test(String(plan.role_id)) || !Array.isArray(plan.before) || !obj(plan.holders)) bad.push('no role or before state');
    if (!Array.isArray(plan.privileges) || !plan.privileges.length) bad.push('no privileges');
    else {
      for (const r of plan.privileges) {
        if (!obj(r) || !GUID.test(String(r.privilege_id)) || !has(ACCESS, r.access) || !CAN[r.depth]) { bad.push('a privilege row that is not one a plan makes'); break; }
        if (PROTECTED.has(r.table)) { bad.push(`${r.access} on ${r.table}`); break; }
      }
    }
  } else if (plan && plan.action === 'restore') {
    // The one place write-class access at organization depth is ADDED here: only as a restore of a logged removal,
    // and only off the security and code tables.
    if (!GUID.test(String(plan.role_id)) || !obj(plan.unit) || !GUID.test(String(plan.unit.id)) || !Array.isArray(plan.expect_privileges)) bad.push('no role or before state');
    if (!plan.reverts_plan_id) bad.push('a restore that is not the undo of a logged removal');
    if (!Array.isArray(plan.privileges) || !plan.privileges.length) bad.push('no privileges');
    else {
      for (const p of plan.privileges) {
        if (!obj(p) || !GUID.test(String(p.id)) || !CAN[p.depth] || typeof p.name !== 'string') { bad.push('a privilege row that is not one a plan makes'); break; }
        const t = privilegeTable(p.name);
        if (!t || PROTECTED.has(t)) { bad.push(`${p.name}`); break; }
      }
    }
  } else bad.push(`the action "${plan && plan.action}"`);
  return bad;
}

const refuse = (msg, code) => { throw new ApplyRefused(`${msg} Nothing was written; make a new plan.`, code); };

async function applySecurityRole(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date() } = deps;
  if (planTooOld(plan, now, MAX_AGE_MS)) throw new ApplyRefused(STALE_TEXT, 'stale_plan');
  const shapeBad = planShapeProblems(plan);
  if (shapeBad.length) throw new ApplyRefused(`this plan file asks to write ${shapeBad.join(', ')}, which no security role plan writes. It was changed after it was made; make a new plan. Nothing was written.`, 'plan_tampered');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  if (!atLeast(acc.level, 'admin')) throw new ApplyRefused(`a security role takes admin access; you have ${acc.level}. Nothing was written.`, 'access_revoked');
  const c = { id, file, fs, confirm, now };
  if (plan.action === 'delete') return applyDelete(plan, dv, me, acc, c);
  if (plan.action === 'remove') return applyRemove(plan, dv, me, acc, c);
  if (plan.action === 'restore') return applyRestore(plan, dv, me, acc, c);
  return applyCreate(plan, dv, me, acc, c);
}

// The role as the plan saw it: same root, same name, still SBRM's own, and holding exactly `expect` (a list of
// {id, depth}). Returns the privileges read now, or { problem, code }.
function editChecks(dv, plan, expect, { revertOf = null } = {}) {
  const r = readRole(dv, plan.role_id);
  if (!r) return { problem: `the role '${plan.name}' is gone`, code: 'snapshot_moved' };
  if (!same(r.name, plan.name)) return { problem: `the role ${plan.role_id} is now named '${r.name}', not '${plan.name}'`, code: 'snapshot_moved' };
  if (!isRoot(r)) return { problem: `'${r.name}' ${plan.role_id} is a business unit's copy, not the role itself`, code: 'not_permitted' };
  if (r.ismanaged || NEVER_NAMED.has(low(r.name)) || !String(r.name).startsWith('#_ ')) return { problem: `'${r.name}' is not one of SBRM's own "#_ " roles`, code: 'not_permitted' };
  const now = rolePrivileges(dv, plan.role_id).map(({ name, id, depth }) => ({ name, id, depth }));
  if (!sameSet(now, expect)) return { problem: `'${r.name}''s privileges changed since ${revertOf ? `plan ${revertOf}` : 'the plan'}, so this would work from a stale picture`, code: 'snapshot_moved' };
  return { now, role: r };
}

// The prompt's holders and other roles, read again now (review F12): the plan may be up to a day old, and the person
// approved on Claude Code's prompt, which the guard builds from the PLAN before this runs. So any change to who holds the
// role, or to the other roles giving each privilege, is refused: what was approved is what the plan showed.
const canon = (x) => JSON.stringify(x);
function viewNow(dv, plan, acc, warnRows) {
  const view = { ...plan, ...disclosure(dv, plan), access: acc.level };
  view.severity = severityFor(view, warnRows);
  if (canon(view.holders) !== canon(plan.holders) || canon(view.also_given) !== canon(plan.also_given) || severity.grew(plan.severity, view.severity)) {
    refuse(`who holds the role '${plan.name}', or which other roles give these privileges, changed since the plan (now held by ${holderText(view.holders)}), so the approval was for another picture.`, 'snapshot_moved');
  }
  return view;
}

// Each privilege the removal takes off, worked out again from the table's metadata and the role as read now
// (advisor 11/23, the house rule that nothing a plan says about itself decides what is written): the same id and name
// for that table and access, held now at the depth that will be logged for the undo. Returns a problem or null.
function removeRowsProblem(dv, plan, held) {
  for (const r of plan.privileges) {
    const meta = tablePrivileges(dv, r.table);
    const p = meta && meta.privileges.find((x) => x.PrivilegeType === ACCESS[r.access]);
    if (!p || low(p.PrivilegeId) !== low(r.privilege_id) || String(p.Name) !== r.privilege_name || privilegeTable(p.Name) !== r.table) return `${r.access} on ${r.table} is not the privilege the plan names`;
    const h = held.find((x) => same(x.id, r.privilege_id));
    if (!h || h.depth !== r.depth) return `'${plan.name}' does not hold ${r.privilege_name} at ${r.depth} now`;
  }
  return null;
}

const heldBy = (v) => ({ people: v.holders.people, apps: v.holders.apps || [], teams: v.holders.teams, disabled: v.holders.disabled || 0 });

function applyRemove(plan, dv, me, acc, { id, file, fs, confirm, now }) {
  const c = editChecks(dv, plan, plan.before);
  if (c.problem) refuse(`${c.problem}.`, c.code);
  const rowsBad = removeRowsProblem(dv, plan, c.now);
  if (rowsBad) refuse(`${rowsBad}.`, 'plan_tampered');
  const view = viewNow(dv, plan, acc, plan.severity && plan.severity.warn_rows);
  const answer = confirm({ summaryText: securityRoleSummary(view), detailText: securityRoleDetail(view, { id }), title: `SBRM: approve taking privileges off this security role in the ${plan.app}?` });
  const base = baseEntry(plan, me, id, now, view);
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };
  // The prompt can wait minutes: the role is read again after the Yes.
  const again = editChecks(dv, plan, plan.before);
  if (again.problem) refuse(`Something changed while the approval was waiting: ${again.problem}.`, again.code);

  const removed = plan.privileges.map((r) => ({ name: r.privilege_name, id: r.privilege_id, depth: r.depth }));
  // `held_by` (round-2 review F20): who held the role at the approval, kept in the log (the plan file is deleted).
  const row = { name: `'${plan.name}'`, action: 'remove', id: plan.role_id, role: { name: plan.name }, unit: plan.unit, before: { privileges: removed }, after: null, held_by: heldBy(view) };
  const judge = (got) => {
    const gone = new Set(removed.map((p) => low(p.id)));
    const still = removed.filter((p) => got.some((g) => low(g.id) === low(p.id)));
    const expect = plan.before.filter((p) => !gone.has(low(p.id)));
    const gotK = new Set(got.map(pkey));
    const expK = new Set(expect.map(pkey));
    const lost = expect.filter((p) => !gotK.has(pkey(p)));
    const extra = got.filter((p) => !expK.has(pkey(p)) && !gone.has(low(p.id)));
    return !still.length && !lost.length && !extra.length ? 'written'
      : `read-back mismatch:${still.length ? ` still held ${still.map((p) => p.name).join(', ')}` : ''}${lost.length ? ` lost ${lost.map((p) => `${p.name} (${p.depth})`).join(', ')}` : ''}${extra.length ? ` unexpected ${extra.map((p) => `${p.name} (${p.depth})`).join(', ')}` : ''}`;
  };
  let sent = 0;
  try {
    for (const r of plan.privileges) { dv.removeRolePrivilege(plan.role_id, r.privilege_id); sent += 1; }
    const got = rolePrivileges(dv, plan.role_id).map(({ name, id: pid, depth }) => ({ name, id: pid, depth }));
    row.after = { privileges: got };
    row.outcome = judge(got);
  } catch (e) {
    row.outcome = `failed: ${e.message}${sent ? ` (${sent} of ${removed.length} taken off before it stopped)` : ''}`;
    try { row.after = { privileges: rolePrivileges(dv, plan.role_id).map(({ name, id: pid, depth }) => ({ name, id: pid, depth })) }; } catch { row.after = null; }
    // A call that landed but lost its answer (a timeout; round-2 review F11): the read-back decides, never the error.
    if (row.after && judge(row.after.privileges) === 'written') {
      row.outcome = 'written';
      row.notes = [`a call's answer was lost (${String(e.message).slice(0, 160)}), but the role reads back exactly as asked`];
    }
  }
  row.changes = [{ label: 'Security role', old_text: `${plan.name}: ${removed.map((p) => p.name).join(', ')}`, new_text: row.outcome === 'written' ? 'taken off' : row.outcome }];
  fs.rmSync(file, { force: true });
  const ok = row.outcome === 'written' ? 1 : 0;
  const outcome = ok ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows: [row] }, outcome, person: me, dv, written: ok, rows: [row], left_out: [] };
}

function applyRestore(plan, dv, me, acc, { id, file, fs, confirm, now }) {
  const c = editChecks(dv, plan, plan.expect_privileges, { revertOf: plan.reverts_plan_id });
  if (c.problem) refuse(`${c.problem}.`, c.code);
  for (const p of plan.privileges) if (privilegeName(dv, p.id) !== p.name) refuse(`the privilege ${p.id} is not ${p.name}.`, 'plan_tampered');
  const view = viewNow(dv, plan, acc, plan.severity && plan.severity.warn_rows);
  const answer = confirm({ summaryText: securityRoleSummary(view), detailText: securityRoleDetail(view, { id }), title: `SBRM: approve giving privileges back to this security role in the ${plan.app}?` });
  const base = baseEntry(plan, me, id, now, view);
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };
  const again = editChecks(dv, plan, plan.expect_privileges, { revertOf: plan.reverts_plan_id });
  if (again.problem) refuse(`Something changed while the approval was waiting: ${again.problem}.`, again.code);

  const added = plan.privileges.map((p) => ({ name: p.name, id: low(p.id), depth: p.depth }));
  const row = { name: `'${plan.name}'`, action: 'restore', id: plan.role_id, role: { name: plan.name }, before: { privileges: plan.expect_privileges }, after: null, added, held_by: heldBy(view) };
  const want = [...plan.expect_privileges, ...added];
  const judge = (got) => (sameSet(got, want) ? 'written'
    : `read-back mismatch: the role holds ${got.length} privileges, ${want.length} expected (${added.filter((p) => !got.some((g) => pkey(g) === pkey(p))).map((p) => `${p.name} (${p.depth}) missing`).join(', ') || 'others changed'})`);
  try {
    dv.addRolePrivileges(plan.role_id, added.map((p) => ({ PrivilegeId: p.id, Depth: p.depth, BusinessUnitId: plan.unit.id })));
    const got = rolePrivileges(dv, plan.role_id).map(({ name, id: pid, depth }) => ({ name, id: pid, depth }));
    row.after = { privileges: got };
    row.outcome = judge(got);
  } catch (e) {
    row.outcome = `failed: ${e.message}`;
    try { row.after = { privileges: rolePrivileges(dv, plan.role_id).map(({ name, id: pid, depth }) => ({ name, id: pid, depth })) }; } catch { row.after = null; }
    // The one call landed but lost its answer (round-2 review F11): the read-back decides.
    if (row.after && judge(row.after.privileges) === 'written') {
      row.outcome = 'written';
      row.notes = [`the call's answer was lost (${String(e.message).slice(0, 160)}), but the role reads back exactly as asked`];
    }
  }
  row.changes = [{ label: 'Security role', old_text: `${plan.name}: without ${added.map((p) => p.name).join(', ')}`, new_text: row.outcome === 'written' ? 'given back' : row.outcome }];
  fs.rmSync(file, { force: true });
  const ok = row.outcome === 'written' ? 1 : 0;
  const outcome = ok ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows: [row] }, outcome, person: me, dv, written: ok, rows: [row], left_out: [] };
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
  if (obj(r) && r.action === 'remove') return planRestore(dv, entry, r, ctx);
  if (obj(r) && r.action === 'restore') throw new PlanRefused(['giving privileges back is not undone here: take them off again with a new job'], 'nothing_to_undo');
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

// Undo of a removal: give back exactly the privileges that apply took off (read back gone), at the depth the role
// held them, while the role holds exactly what that apply's read-back showed. A log entry is data: every privilege it
// names must still be that privilege, off the security and code tables, at a real depth.
const goodPriv = (p) => obj(p) && GUID.test(String(p.id)) && typeof p.name === 'string' && typeof p.depth === 'string';
function planRestore(dv, entry, r, ctx) {
  if (!GUID.test(String(r.id)) || !obj(r.role) || !oneLine(r.role.name, 100) || !String(r.role.name).startsWith('#_ ') || NEVER_NAMED.has(low(r.role.name))) {
    throw new PlanRefused(['that log entry has no valid role'], 'invalid_job');
  }
  if (!obj(r.before) || !Array.isArray(r.before.privileges) || !r.before.privileges.length || !r.before.privileges.every(goodPriv)) throw new PlanRefused(['that log entry has no valid list of what it took off'], 'invalid_job');
  if (!obj(r.after) || !Array.isArray(r.after.privileges) || !r.after.privileges.every(goodPriv)) {
    throw new PlanRefused(["that log entry has no read-back of the role's privileges, so it cannot show nothing changed since; an admin restores them by hand"], 'invalid_job');
  }
  const back = r.before.privileges.filter((p) => !r.after.privileges.some((g) => same(g.id, p.id)));
  if (!back.length) throw new PlanRefused(['that change took nothing off (every privilege it named was still held afterwards); there is nothing to undo'], 'nothing_to_undo');
  for (const p of back) {
    const t = privilegeTable(p.name);
    if (!CAN[p.depth]) throw new PlanRefused([`that log entry gives ${p.name} the depth "${p.depth}"`], 'invalid_job');
    if (!t || PROTECTED.has(t)) throw new PlanRefused([`${p.name} is on a security or code table; it is never given back here`], 'invalid_job');
  }
  const { envs, access, warnRows = severity.DEFAULT_WARN_ROWS } = ctx;
  const envInfo = envs[entry.env];
  const app = envInfo.name;
  const identity = admin(dv, entry.env, app, access);
  const live = readRole(dv, r.id);
  const plan = {
    contract: CONTRACT, kind: 'securityrole', env: entry.env, host: envInfo.host, app, mode: 'securityrole', action: 'restore',
    name: r.role.name.trim(), role_id: low(r.id), unit: { id: live && live._businessunitid_value ? low(live._businessunitid_value) : null },
    privileges: back.map((p) => ({ name: p.name, id: low(p.id), depth: p.depth, plain: plainPrivilege(p) })), expect_privileges: r.after.privileges.map((p) => ({ name: p.name, id: low(p.id), depth: p.depth })),
    source: `revert ${entry.plan_id}`,
    reason: `Undo plan ${entry.plan_id} ("${entry.headline}", by ${entry.person ? entry.person.fullname : 'unknown'}).`.replace(/[\r\n]+/g, ' ').slice(0, 500),
    intent: { verb: 'securityrole', role: r.role.name.trim(), action: 'restore' }, identity: identity.me, access: identity.level,
    cli_version: dv.cliVersion || null, need: 'admin', refused: [], reverts_plan_id: entry.plan_id,
  };
  const c = editChecks(dv, plan, plan.expect_privileges, { revertOf: entry.plan_id });
  if (c.problem) throw new PlanRefused([c.problem], c.code === 'snapshot_moved' && !live ? 'nothing_to_undo' : c.code);
  if (!GUID.test(String(plan.unit.id))) throw new PlanRefused([`could not read the business unit of '${plan.name}'`], 'snapshot_moved');
  for (const p of plan.privileges) {
    if (privilegeName(dv, p.id) !== p.name) throw new PlanRefused([`the privilege ${p.id} is not ${p.name} in the ${app}`], 'invalid_job');
  }
  Object.assign(plan, disclosure(dv, plan));
  plan.severity = severityFor(plan, warnRows);
  return plan;
}

// Who holds the role and which other roles give each privilege, read live (plan, and again at apply before the prompt:
// review F12, requirement 4). For a removal and for its undo alike.
function disclosure(dv, plan) {
  const privs = plan.action === 'restore' ? plan.privileges.map((p) => ({ privilege_name: p.name, privilege_id: p.id })) : plan.privileges;
  return {
    holders: holdersDetail(dv, plan.role_id),
    also_given: privs.map((r) => ({ privilege_name: r.privilege_name, roles: alsoGiven(dv, r.privilege_id, plan.role_id) })),
  };
}

module.exports = {
  validateSecurityRoleJob, planSecurityRole, securityRoleSummary, securityRoleDetail, applySecurityRole, planSecurityRoleRevert,
  planShapeProblems, PROTECTED, WRITE_CLASS,
};
