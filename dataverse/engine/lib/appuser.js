'use strict';
// Application users (kind "appuser", 1.11.31; Dylan 10/21/26: "Why cant we just do this through the toolkit?").
// Every job moved onto the SBRM server signs in as its OWN Entra app, and Dataverse lets that app in only through an
// APPLICATION USER: a systemusers row carrying the app's client id (Mail Sorting Guide AUTOMATION.md, ruled
// per-consumer 10/19 + 10/21). On 10/21 the first one had to be made by hand in the Power Platform admin center,
// outside the Write Log. This kind makes, switches off and switches back on one application user.
//
//   plan   finds any user carrying the client id; for create, picks the business unit (the root unless one is named);
//          for disable / enable, the one application user and its state. Reads only.
//   apply  re-reads all of it, refuses if anything moved, shows the pop-up, then one write, read back.
//   log    before and after; revert is the opposite (a create is undone by switching the user OFF: an application
//          user is never deleted here, an admin does that in the admin center).
//
// Rules: admin only (it decides who can sign in). Never switched off here: an application user that holds a
// Microsoft (managed) role, since that is a Microsoft or vendor integration, not one of ours (an admin does that by
// hand). The roles an application user holds are given with kind "role", naming it by `app_user`.
// Not checked, because Dataverse cannot see it: whether the client id is a real Entra app in this tenant. Dataverse
// answers that at apply (the create fails, and nothing is written).

const { whoAmI, accessFor, PlanRefused } = require('./resolve');
const { resolveAccess } = require('./access');
const { ApplyRefused } = require('./apply');
const { DataverseError } = require('./cli');
const { GUID } = require('./contract');
const { atLeast } = require('./levels');
const severity = require('./severity');

const CONTRACT = 'sbrm-dv-job/1';
const MAX_AGE_MS = 24 * 3600 * 1000;
const TOP_KEYS = new Set(['contract', 'kind', 'env', 'action', 'client_id', 'business_unit', 'source', 'reason', 'intent']);
const ACTIONS = new Set(['create', 'disable', 'enable']);
const NIL = '00000000-0000-0000-0000-000000000000';
const USER_COLS = 'systemuserid,fullname,applicationid,isdisabled,accessmode,_businessunitid_value';
const APP_ACCESS = 4; // systemusers.accessmode: 4 = non-interactive (an application user)

const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const q = (s) => String(s).replace(/'/g, "''");
const enc = (s) => encodeURIComponent(s);
const low = (s) => String(s || '').toLowerCase();
const same = (a, b) => low(a) === low(b);
const buName = (s) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 160 && !/[\x00-\x1f\x7f]/.test(s);

// ---------- the job file ----------

function validateAppUserJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!obj(raw)) return { errors: ['the job file must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be exactly "${CONTRACT}"`);
  if (raw.kind !== 'appuser') err('"kind" must be "appuser"');
  if (typeof raw.env !== 'string' || !has(envs, raw.env)) err(`"env" must be one of: ${Object.keys(envs).join(', ')}`);
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required (script path, or "claude-session")');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > 500 || /[\r\n]/.test(raw.reason)) err('"reason" must be one line, at most 500 characters');
  if (!ACTIONS.has(raw.action)) err('"action" must be "create", "disable" or "enable"');
  const clientId = typeof raw.client_id === 'string' ? raw.client_id.trim().toLowerCase() : '';
  if (!GUID.test(clientId) || clientId === NIL) err('"client_id" must be the Entra app\'s Application (client) ID, a GUID');
  if (raw.business_unit !== undefined) {
    if (raw.action !== 'create') err('"business_unit" is only for "create" (an existing application user keeps its business unit)');
    else if (!buName(raw.business_unit)) err('"business_unit" must be the business unit\'s name exactly as Dataverse shows it (one line, at most 160 characters)');
  }

  const intent = raw.intent;
  if (!obj(intent)) err('"intent" is required: {verb: "appuser", action, client_id}');
  else if (!errors.length) {
    const mism = [];
    for (const k of Object.keys(intent)) if (!['verb', 'action', 'client_id'].includes(k)) mism.push(`unknown key "${k}"`);
    if (intent.verb !== 'appuser') mism.push(`verb says "${intent.verb}"; an application user job is "appuser"`);
    if (intent.action !== raw.action) mism.push(`intent says "${intent.action}", the file says "${raw.action}"`);
    if (low(intent.client_id).trim() !== clientId) mism.push(`intent names the app ${intent.client_id}, the file names ${clientId}`);
    if (mism.length) err(`intent does not match the job (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  const job = { contract: CONTRACT, kind: 'appuser', env: raw.env, action: raw.action, client_id: clientId, source: raw.source.trim(), reason: raw.reason.trim(), intent };
  if (raw.business_unit !== undefined) job.business_unit = raw.business_unit.trim();
  return { errors: [], job };
}

// ---------- live reads ----------

function usersWithApp(dv, clientId, { strong = false } = {}) {
  return dv.get(`systemusers?$select=${USER_COLS}&$filter=${enc(`applicationid eq ${clientId}`)}`, strong ? { strong: true } : undefined).value || [];
}

function readUser(dv, id) {
  try {
    return dv.get(`systemusers(${id})?$select=${USER_COLS}`);
  } catch (e) {
    if (e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

function rootUnit(dv) {
  return dv.get(`businessunits?$select=businessunitid,name&$filter=${enc('_parentbusinessunitid_value eq null')}`).value || [];
}

function unitsNamed(dv, name) {
  return dv.get(`businessunits?$select=businessunitid,name&$filter=${enc(`name eq '${q(name)}'`)}`).value || [];
}

function readUnit(dv, id) {
  try {
    return dv.get(`businessunits(${id})?$select=businessunitid,name`);
  } catch (e) {
    if (e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

// The Microsoft (managed) roles an application user holds, directly or through a team that gives roles (owner 0,
// Entra security group 2, Entra office group 3; review F5 11/9). Any one of them means a Microsoft or vendor
// integration, which is never switched off here.
const GRANTING_TEAMS = new Set([0, 2, 3]);
function managedRoles(dv, userId) {
  const out = (dv.get(`systemusers(${userId})/systemuserroles_association?$select=roleid,name,ismanaged`).value || [])
    .filter((r) => r.ismanaged).map((r) => String(r.name));
  for (const t of dv.get(`systemusers(${userId})/teammembership_association?$select=teamid,name,teamtype`).value || []) {
    if (!GRANTING_TEAMS.has(t.teamtype)) continue;
    for (const r of dv.get(`teams(${t.teamid})/teamroles_association?$select=roleid,name,ismanaged`).value || []) {
      if (r.ismanaged) out.push(`${r.name} (through the team ${t.name || t.teamid})`);
    }
  }
  return [...new Set(out)];
}

const label = (u) => String((u && u.fullname) || 'the application user');

function severityFor(plan, warnRows) {
  const lasting = plan.action === 'create' ? [`a new application user for the Entra app ${plan.client_id} in the ${plan.app} (undo switches it off)`] : [];
  const ends = plan.action === 'disable' ? [`${label(plan.user)} can no longer sign in to the ${plan.app}; every job that runs as it stops`] : [];
  return severity.assess({ count: 1, noun: 'application users', lasting, ends }, { warnRows });
}

// ---------- plan ----------

function title(plan) {
  if (plan.action === 'create') return `Create an application user for the Entra app ${plan.client_id} in the ${plan.app}`;
  return `${plan.action === 'disable' ? 'Switch off' : 'Switch on'} the application user ${label(plan.user)} in the ${plan.app}`;
}

async function planAppUser(dv, job, ctx) {
  return planCore(dv, job, ctx, {});
}

async function planCore(dv, job, { envs, access, warnRows = severity.DEFAULT_WARN_ROWS }, { revertOf = null, expect = null, expectId = null } = {}) {
  const envInfo = envs[job.env];
  const app = envInfo.name;
  const identity = whoAmI(dv);
  if (!identity.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, job.env), identity.email, job.env);
  if (!atLeast(acc.level, 'admin')) {
    throw new PlanRefused([`an application user decides which app can sign in to the ${app}, so it takes admin access; ${identity.fullname} has ${acc.level}. Ask Dylan.`],
      atLeast(acc.level, 'write') ? 'not_permitted' : 'access_read');
  }
  const found = usersWithApp(dv, job.client_id);
  let unit = null;
  let user = null;
  if (job.action === 'create') {
    if (found.length) {
      const u = found[0];
      throw new PlanRefused([`the Entra app ${job.client_id} already has an application user in the ${app}: ${label(u)} (${u.isdisabled ? 'switched off; use action "enable"' : 'on'})`], 'already_exists');
    }
    const units = job.business_unit ? unitsNamed(dv, job.business_unit) : rootUnit(dv);
    if (!units.length) throw new PlanRefused([job.business_unit ? `there is no business unit named '${job.business_unit}' in the ${app}` : `could not read the ${app}'s root business unit`], 'invalid_job');
    if (units.length > 1) throw new PlanRefused([`${units.length} business units match in the ${app}; name one exactly. Ask Dylan.`], 'invalid_job');
    unit = { id: low(units[0].businessunitid), name: String(units[0].name) };
  } else {
    if (!found.length) throw new PlanRefused([`the Entra app ${job.client_id} has no application user in the ${app}`], 'nothing_to_change');
    if (found.length > 1) throw new PlanRefused([`${found.length} users carry the Entra app ${job.client_id} in the ${app}; Ask Dylan`], 'invalid_job');
    const u = found[0];
    if (u.accessmode !== APP_ACCESS) throw new PlanRefused([`${label(u)} is not an application user (access mode ${u.accessmode}); people are switched off in the admin center`], 'not_permitted');
    if (same(u.systemuserid, identity.systemuserid)) throw new PlanRefused(['you are signed in as that user; it is never changed by itself'], 'not_permitted');
    const want = job.action === 'disable';
    // A revert acts on the very user its plan made or switched, never on another that now carries the client id
    // (review F4 11/9).
    if (revertOf && expectId && !same(u.systemuserid, expectId)) {
      throw new PlanRefused([`${label(u)} carries the Entra app ${job.client_id} now, but it is not the user plan ${revertOf} made or changed (${expectId}), so a revert would act on the wrong user`], 'snapshot_moved');
    }
    if (revertOf && expect !== null && Boolean(u.isdisabled) !== expect) {
      throw new PlanRefused([`${label(u)} changed since plan ${revertOf} (it is ${u.isdisabled ? 'off' : 'on'} now), so a revert would overwrite someone's later change`], 'snapshot_moved');
    }
    if (Boolean(u.isdisabled) === want) throw new PlanRefused([`${label(u)} is already ${want ? 'switched off' : 'on'}`], 'nothing_to_change');
    if (want) {
      const ms = managedRoles(dv, u.systemuserid);
      if (ms.length) throw new PlanRefused([`${label(u)} holds the Microsoft role ${ms.join(', ')}, so it is a Microsoft or vendor integration, which is never switched off here; an admin does that in the admin center`], 'not_permitted');
    }
    user = { id: low(u.systemuserid), fullname: String(u.fullname || ''), bu: low(u._businessunitid_value), disabled: Boolean(u.isdisabled) };
  }
  const plan = {
    contract: CONTRACT, kind: 'appuser', env: job.env, host: envInfo.host, app, mode: 'appuser', action: job.action, client_id: job.client_id,
    source: job.source, reason: job.reason, intent: job.intent, identity, access: acc.level, cli_version: dv.cliVersion || null,
    need: 'admin', unit, user, refused: [], reverts_plan_id: revertOf || null,
  };
  plan.severity = severityFor(plan, warnRows);
  return plan;
}

// ---------- the pop-up ----------

function lines(plan) {
  if (plan.action === 'create') {
    return [`  Entra app (client id): ${plan.client_id}`, `  Business unit: ${plan.unit.name}`,
      '  Dataverse names it after the Entra app. It holds no role until one is given (kind "role", app_user).'];
  }
  return [`  ${label(plan.user)} (Entra app ${plan.client_id}): ${plan.user.disabled ? 'off' : 'on'} -> ${plan.action === 'disable' ? 'off' : 'on'}`];
}

function appUserSummary(plan) {
  const undo = plan.action === 'create' ? 'Can be undone with revert (it switches the new application user off).' : 'Can be undone with revert (the opposite switch, while nothing has moved since).';
  return [...severity.block(plan.severity), title(plan), '', ...lines(plan), '', `  ${undo}`, '', `Reason given: ${plan.reason}`].join('\n');
}

function appUserDetail(plan, { id } = {}) {
  const out = [...severity.block(plan.severity), title(plan), '', `Requested by: ${plan.identity.fullname} (${plan.identity.email})`, `Reason given: ${plan.reason}`, `Made by: ${plan.source}`];
  if (id) out.push(`Plan: ${id}`);
  if (plan.reverts_plan_id) out.push(`Undoes plan: ${plan.reverts_plan_id}`);
  out.push(`Access needed: admin (an application user decides which app can sign in); ${plan.identity.fullname} has ${plan.access}`, '');
  out.push(...lines(plan).map((l) => l.replace(/^ {2}/, '')));
  if (plan.unit) out.push(`Business unit id: ${plan.unit.id}`);
  if (plan.user) out.push(`User id: ${plan.user.id} (business unit ${plan.user.bu})`);
  return out.join('\n');
}

// ---------- apply ----------

function planShapeProblems(plan) {
  const bad = [];
  if (!plan || plan.mode !== 'appuser') bad.push(`the mode "${plan && plan.mode}"`);
  if (!plan || !ACTIONS.has(plan.action)) bad.push(`the action "${plan && plan.action}"`);
  if (!plan || !GUID.test(String(plan.client_id)) || plan.client_id === NIL) bad.push('a client id that is not a GUID');
  if (plan && plan.action === 'create') {
    if (!obj(plan.unit) || !GUID.test(String(plan.unit.id))) bad.push('a business unit that is not a GUID');
    if (plan.user) bad.push('a user on a create');
  } else if (plan && ACTIONS.has(plan.action)) {
    if (!obj(plan.user) || !GUID.test(String(plan.user.id)) || typeof plan.user.disabled !== 'boolean') bad.push('no user, or no before state');
    if (plan.unit) bad.push('a business unit on a switch');
  }
  return bad;
}

const refuse = (msg, code) => { throw new ApplyRefused(`${msg} Nothing was written; make a new plan.`, code); };

async function applyAppUser(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date() } = deps;
  if (now - new Date(plan.created) > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old. Make a new plan.', 'stale_plan');
  const shapeBad = planShapeProblems(plan);
  if (shapeBad.length) throw new ApplyRefused(`this plan file asks to write ${shapeBad.join(', ')}, which no application user plan writes. It was changed after it was made; make a new plan. Nothing was written.`, 'plan_tampered');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  if (!atLeast(acc.level, 'admin')) throw new ApplyRefused(`an application user takes admin access; you have ${acc.level}. Nothing was written.`, 'access_revoked');

  // Re-check against live reads.
  let etag = null;
  let liveUser = plan.user;
  if (plan.action === 'create') {
    if (usersWithApp(dv, plan.client_id).length) refuse(`the Entra app ${plan.client_id} has an application user since the plan.`, 'snapshot_moved');
    const unit = readUnit(dv, plan.unit.id);
    if (!unit) refuse(`the business unit ${plan.unit.name} is gone since the plan.`, 'snapshot_moved');
  } else {
    const u = readUser(dv, plan.user.id);
    if (!u || !same(u.applicationid, plan.client_id) || u.accessmode !== APP_ACCESS || Boolean(u.isdisabled) !== plan.user.disabled) {
      refuse(`${label(plan.user)} changed since the plan (gone, another app, or switched on or off).`, 'snapshot_moved');
    }
    if (low(u.systemuserid) === low(me.systemuserid)) refuse('this plan changes the user you are signed in as.', 'not_permitted');
    if (plan.action === 'disable') {
      const ms = managedRoles(dv, u.systemuserid);
      if (ms.length) throw new ApplyRefused(`${label(u)} now holds the Microsoft role ${ms.join(', ')}; it is never switched off here. Nothing was written.`, 'not_permitted');
    }
    etag = u['@odata.etag'];
    if (!etag) refuse(`could not read ${label(u)}'s version tag.`, 'snapshot_moved');
    liveUser = { ...plan.user, fullname: String(u.fullname || plan.user.fullname) };
  }
  const view = { ...plan, user: liveUser, access: acc.level };
  const sevNow = severityFor(view, plan.severity.warn_rows);
  if (severity.grew(plan.severity, sevNow)) {
    throw new ApplyRefused(['this change is more serious than when it was planned, so it is not shown for approval:', ...sevNow.lines.map((l) => `  ! ${l}`), 'Make a new plan.'].join('\n'), 'severity_grew');
  }
  view.severity = sevNow;
  const answer = confirm({ summaryText: appUserSummary(view), detailText: appUserDetail(view, { id }), title: `SBRM: approve this application user change in the ${plan.app}?` });
  const base = {
    time: now.toISOString(), plan_id: id, person: me, env: plan.env, app: plan.app, table: 'systemusers', mode: 'appuser', action: plan.action,
    source: plan.source, reason: plan.reason, approval: 'prompt', left_out: [], headline: title(view), reverts_plan_id: plan.reverts_plan_id || null,
  };
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };

  // The prompt can wait minutes: what protects a switch-off is read again after the Yes (review F6 11/9).
  if (plan.action === 'disable') {
    const ms = managedRoles(dv, plan.user.id);
    if (ms.length) throw new ApplyRefused(`${label(liveUser)} was given the Microsoft role ${ms.join(', ')} while the approval was waiting; it is never switched off here. Nothing was written; make a new plan.`, 'snapshot_moved');
  }
  if (plan.action === 'create' && usersWithApp(dv, plan.client_id).length) {
    refuse(`the Entra app ${plan.client_id} got an application user while the approval was waiting.`, 'snapshot_moved');
  }

  const row = { name: plan.action === 'create' ? `application user for ${plan.client_id}` : `${label(liveUser)} (${plan.client_id})`, action: plan.action, client_id: plan.client_id, after: null };
  try {
    if (plan.action === 'create') {
      row.id = null;
      row.before = { exists: false };
      row.unit = plan.unit;
      dv.createAppUser(plan.client_id, plan.unit.id);
      const got = usersWithApp(dv, plan.client_id, { strong: true });
      const u = got[0];
      if (got.length === 1) {
        row.id = low(u.systemuserid);
        row.after = { exists: true, id: low(u.systemuserid), fullname: String(u.fullname || ''), disabled: Boolean(u.isdisabled), bu: low(u._businessunitid_value) };
        row.name = `${label(u)} (${plan.client_id})`;
      }
      const ok = got.length === 1 && !u.isdisabled && same(u._businessunitid_value, plan.unit.id) && u.accessmode === APP_ACCESS;
      row.outcome = ok ? 'written' : `read-back mismatch: ${got.length} user(s) carry the app${u ? `, ${u.isdisabled ? 'off' : 'on'}, business unit ${u._businessunitid_value}` : ''}`;
      row.changes = [{ label: 'Application user', old_text: 'none', new_text: row.after ? `${row.after.fullname}, on, ${plan.unit.name}` : 'not read back' }];
    } else {
      const want = plan.action === 'disable';
      row.id = plan.user.id;
      row.before = { disabled: plan.user.disabled };
      dv.setUserDisabled(plan.user.id, want, etag);
      const u = readUser(dv, plan.user.id);
      row.after = u ? { disabled: Boolean(u.isdisabled) } : null;
      row.outcome = u && Boolean(u.isdisabled) === want ? 'written' : `read-back mismatch: ${label(liveUser)} is ${u ? (u.isdisabled ? 'off' : 'on') : 'gone'}`;
      row.changes = [{ label: 'Status', old_text: plan.user.disabled ? 'off' : 'on', new_text: want ? 'off' : 'on' }];
    }
  } catch (e) {
    row.outcome = `failed: ${e.message}`;
    row.changes = row.changes || [];
    try {
      if (plan.action === 'create') {
        const got = usersWithApp(dv, plan.client_id, { strong: true });
        if (got.length === 1) row.after = { exists: true, id: low(got[0].systemuserid), fullname: String(got[0].fullname || ''), disabled: Boolean(got[0].isdisabled), bu: low(got[0]._businessunitid_value) };
      } else {
        const u = readUser(dv, plan.user.id);
        row.after = u ? { disabled: Boolean(u.isdisabled) } : null;
      }
    } catch { /* leave after as it is */ }
  }
  fs.rmSync(file, { force: true });
  const ok = row.outcome === 'written' ? 1 : 0;
  const outcome = ok ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows: [row] }, outcome, person: me, dv, written: ok, rows: [row], left_out: [] };
}

// ---------- revert ----------
//
// A create is undone by switching the new user OFF (never a delete); a disable by switching it on; an enable by
// switching it off. Only while the user is still in the state that plan left. A log entry is data: a forged or
// damaged one is refused.

async function planAppUserRevert(dv, entry, ctx) {
  if (!entry || entry.mode !== 'appuser') throw new PlanRefused(['that plan is not an application user change'], 'nothing_to_undo');
  if (!['applied', 'applied with problems'].includes(entry.outcome)) throw new PlanRefused([`that change's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  const envs = (ctx && ctx.envs) || {};
  if (typeof entry.env !== 'string' || !has(envs, entry.env)) throw new PlanRefused([`that log entry names an environment the toolkit does not know ("${entry.env}")`], 'invalid_job');
  if (dv.host && low(dv.host) !== low(envs[entry.env].host)) {
    throw new PlanRefused([`that change was made in the ${envs[entry.env].name}; this revert was planned against another environment. Revert it in the ${envs[entry.env].name}.`], 'invalid_job');
  }
  const r = (entry.rows || [])[0];
  const clientId = obj(r) && typeof r.client_id === 'string' ? r.client_id.trim().toLowerCase() : '';
  if (!obj(r) || !GUID.test(clientId) || clientId === NIL || !ACTIONS.has(r.action)) throw new PlanRefused(['that log entry has no valid application user, client id or action'], 'invalid_job');
  let action;
  let expect;
  let expectId;
  if (r.action === 'create') {
    if (!obj(r.after) || r.after.exists !== true) throw new PlanRefused([`that change did not land (${r.outcome}); there is nothing to undo`], 'nothing_to_undo');
    action = 'disable';
    expect = false;
    expectId = r.after.id;
  } else {
    // Landed only if the user ended in the state the switch asked for; otherwise there is nothing to undo, and the
    // "opposite" would repeat the original switch (review F3 11/9).
    const asked = r.action === 'disable';
    if (!obj(r.after) || r.after.disabled !== asked) throw new PlanRefused([`that change did not land (${r.outcome}); there is nothing to undo`], 'nothing_to_undo');
    action = asked ? 'enable' : 'disable';
    expect = asked;
    expectId = r.id;
  }
  if (!GUID.test(String(expectId))) throw new PlanRefused(['that log entry does not say which user it made or changed'], 'invalid_job');
  const job = {
    contract: CONTRACT, kind: 'appuser', env: entry.env, action, client_id: clientId,
    source: `revert ${entry.plan_id}`,
    reason: `Undo plan ${entry.plan_id} ("${entry.headline}", by ${entry.person ? entry.person.fullname : 'unknown'}).`.replace(/[\r\n]+/g, ' ').slice(0, 500),
    intent: { verb: 'appuser', action, client_id: clientId },
  };
  return planCore(dv, job, ctx, { revertOf: entry.plan_id, expect, expectId: low(expectId) });
}

module.exports = {
  validateAppUserJob, planAppUser, appUserSummary, appUserDetail, applyAppUser, planAppUserRevert, planShapeProblems,
};
