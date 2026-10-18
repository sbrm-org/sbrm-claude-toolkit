'use strict';
// App settings (kind "setting", 1.11.12; Dylan 10/18/26: "Lets build that into the toolkit"): change the
// CURRENT VALUE of an environment variable. Why it exists: on 12/4/2024 a solution import carried a dev
// environment's "no" into HGS's sbrm_SharePointDocumentsEnable, and the flow behind the guest "Create Documents
// folder" button, which reads that switch and quietly stops on "no", did nothing for ~22 months. Turning it back
// on had no path through the toolkit (a records job on environmentvariablevalues is refused, lib/access.js
// APP_DEFINITION_SETS), so it would have gone through the maker portal, outside the Write Log.
//
//   plan   reads the setting's definition (type, default) and its one current value row; refuses a Secret or a
//          Data source setting, a setting with no current value (its default applies; the first value is made
//          in the maker portal), a managed value row, a value that does not fit the type, and the value it
//          already has; names every cloud flow whose definition names the setting (on or off) and every
//          solution the value row sits in (an import of one of those can set it back). Reads only.
//   apply  re-reads the definition and the value row, refuses if either moved, works the warnings out again
//          from live reads, shows the pop-up, then ONE PATCH of `value` with If-Match, and reads it back.
//   log    before and after value; revert sets the before value back, only while the setting still holds
//          what the plan wrote.
//
// Admin only: a setting can switch live automation on or off for everyone (the HGS case was exactly that).
// Out of scope for now: creating a first value row (none exists, the default applies) and removing a value.

const { whoAmI, accessFor, PlanRefused } = require('./resolve');
const { resolveAccess } = require('./access');
const { ApplyRefused } = require('./apply');
const { DataverseError } = require('./cli');
const { GUID } = require('./contract');
const { atLeast } = require('./levels');
const severity = require('./severity');

const CONTRACT = 'sbrm-dv-job/1';
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_VALUE = 2000; // environmentvariablevalue.value is a memo of 2,000 (read live 10/18/26)
const SCHEMA = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const TOP_KEYS = new Set(['contract', 'kind', 'env', 'setting', 'value', 'source', 'reason', 'intent']);
const DEF_SET = 'environmentvariabledefinitions';
const VALUE_SET = 'environmentvariablevalues';
// Environment variable types (Dataverse `type`). Data source and Secret are never changed here.
const TYPES = { 100000000: 'Text', 100000001: 'Number', 100000002: 'Yes/No', 100000003: 'JSON', 100000004: 'Data source', 100000005: 'Secret' };
const PORTAL_ONLY = new Set([100000004, 100000005]);
// Solutions every component sits in; naming them says nothing about an import risk.
const SYSTEM_SOLUTIONS = new Set(['default', 'active', 'basic']);

const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const q = (s) => String(s).replace(/'/g, "''");
const enc = (s) => encodeURIComponent(s);
const shown = (v, n = 80) => {
  if (v === null || v === undefined) return '(none)';
  if (v === '') return '(blank)';
  const s = String(v).replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n)}... (${String(v).length} characters)` : s;
};
const list = (xs, n = 8) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '));

// ---------- the job file ----------

function validateSettingJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!obj(raw)) return { errors: ['the job file must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be exactly "${CONTRACT}"`);
  if (raw.kind !== 'setting') err('"kind" must be "setting"');
  if (typeof raw.env !== 'string' || !has(envs, raw.env)) err(`"env" must be one of: ${Object.keys(envs).join(', ')}`);
  if (typeof raw.setting !== 'string' || !SCHEMA.test(raw.setting)) err('"setting" must be the setting\'s schema name (the environment variable\'s Name, e.g. sbrm_SharePointDocumentsEnable)');
  if (typeof raw.value !== 'string') err('"value" must be text: the new value exactly as the setting stores it (a Yes/No setting stores "yes" or "no")');
  else if (raw.value.length > MAX_VALUE) err(`"value" is ${raw.value.length} characters; a setting holds at most ${MAX_VALUE} characters`);
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required (script path, or "claude-session")');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > 500 || /[\r\n]/.test(raw.reason)) err('"reason" must be one line, at most 500 characters');

  // Intent: what Claude says the job does, checked against the file (the §6b.1 rule).
  const intent = raw.intent;
  if (!obj(intent)) err('"intent" is required: {verb: "set", setting, value}');
  else if (!errors.length) {
    const mism = [];
    for (const k of Object.keys(intent)) if (!['verb', 'setting', 'value'].includes(k)) mism.push(`unknown key "${k}"`);
    if (intent.verb !== 'set') mism.push(`verb says "${intent.verb}"; a setting job sets a value ("set")`);
    if (intent.setting !== raw.setting) mism.push(`setting says "${intent.setting}", the file changes "${raw.setting}"`);
    if (intent.value !== raw.value) mism.push(`value says "${shown(intent.value)}", the file sets "${shown(raw.value)}"`);
    if (mism.length) err(`intent does not match the job (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  return {
    errors: [],
    job: { contract: CONTRACT, kind: 'setting', env: raw.env, setting: raw.setting, value: raw.value, source: raw.source.trim(), reason: raw.reason.trim(), intent },
  };
}

// ---------- live reads ----------

// The value must fit the type. Yes/No settings store "yes" or "no" (read across all five apps 10/18/26: no
// other spelling exists), so "true" or "Yes" is refused rather than guessed at.
function typeProblem(type, value) {
  if (type === 100000002) return value === 'yes' || value === 'no' ? null : `a Yes/No setting takes "yes" or "no" (how every Yes/No setting in SBRM's apps stores it), not "${shown(value)}"`;
  if (type === 100000001) return /^-?\d+(?:\.\d+)?$/.test(value) ? null : `a Number setting takes a number, not "${shown(value)}"`;
  if (type === 100000003) {
    try { JSON.parse(value); return null; } catch (e) { return `a JSON setting takes valid JSON (${e.message})`; }
  }
  if (type === 100000000) return null;
  return `a setting of type ${type} is not one this engine knows`;
}

function readDefinition(dv, schemaname) {
  const rows = dv.get(`${DEF_SET}?$select=environmentvariabledefinitionid,schemaname,displayname,type,defaultvalue,ismanaged,statecode&$filter=${enc(`schemaname eq '${q(schemaname)}'`)}`).value || [];
  return rows.filter((r) => String(r.schemaname) === schemaname);
}

function readValues(dv, defId) {
  return (dv.get(`${VALUE_SET}?$select=environmentvariablevalueid,value,ismanaged,statecode&$filter=${enc(`_environmentvariabledefinitionid_value eq ${defId}`)}`).value || [])
    .filter((r) => r.statecode === 0 || r.statecode === undefined || r.statecode === null);
}

function readValueRow(dv, id) {
  try {
    return dv.get(`${VALUE_SET}(${id})?$select=value,ismanaged,statecode,_environmentvariabledefinitionid_value`, { strong: true });
  } catch (e) {
    if (e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

// Every cloud flow whose definition names the setting (proved live 10/18/26 on HGS: `contains` on clientdata
// finds exactly the one flow that reads sbrm_SharePointDocumentsEnable). A longer name that starts the same is
// counted too, which can only over-warn.
function flowsReading(dv, schemaname) {
  return (dv.get(`workflows?$select=workflowid,name,statecode&$filter=${enc(`category eq 5 and contains(clientdata,'${q(schemaname)}')`)}`).value || [])
    .map((w) => ({ id: String(w.workflowid).toLowerCase(), name: String(w.name || w.workflowid), on: w.statecode === 1 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The solutions the value row sits in, other than the system ones; null when they could not be read. An
// import of one of these carries ITS copy of the value and overwrites this one (the 12/4/2024 HGS case).
function solutionsCarrying(dv, valueId) {
  try {
    const ids = [...new Set((dv.get(`solutioncomponents?$select=_solutionid_value&$filter=${enc(`objectid eq ${valueId} and componenttype eq 381`)}`).value || [])
      .map((c) => String(c._solutionid_value || '').toLowerCase()).filter((x) => GUID.test(x)))];
    const out = [];
    for (const id of ids) {
      for (const s of dv.get(`solutions?$select=solutionid,uniquename,friendlyname,ismanaged&$filter=${enc(`solutionid eq ${id}`)}`).value || []) {
        if (!SYSTEM_SOLUTIONS.has(String(s.uniquename).toLowerCase())) out.push({ uniquename: s.uniquename, name: s.friendlyname, managed: Boolean(s.ismanaged) });
      }
    }
    return out.sort((a, b) => a.uniquename.toLowerCase().localeCompare(b.uniquename.toLowerCase()));
  } catch (e) {
    if (e instanceof DataverseError) return null;
    throw e;
  }
}

function severityFor(flows, warnRows) {
  const on = (flows || []).filter((f) => f.on).map((f) => f.name);
  const irreversible = on.length ? [`flows that read it (${list(on)}) act on the new value from their next run; whatever they do before an undo stays done`] : [];
  return severity.assess({ count: 1, noun: 'settings', irreversible }, { warnRows });
}

// ---------- plan ----------

function title(plan) {
  const s = plan.setting;
  return `Set '${s.displayname}' (${s.schemaname}) in the ${plan.app}: ${shown(plan.before.value)} -> ${shown(plan.after.value)}`;
}

async function planSetting(dv, job, ctx) {
  return planCore(dv, job, ctx, {});
}

async function planCore(dv, job, { envs, access, warnRows = severity.DEFAULT_WARN_ROWS }, { revertOf = null, expect = null } = {}) {
  const envInfo = envs[job.env];
  const identity = whoAmI(dv);
  if (!identity.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, job.env), identity.email, job.env);
  if (!atLeast(acc.level, 'admin')) {
    throw new PlanRefused([`changing an app setting takes admin access in the ${envInfo.name} (a setting can switch live automation on or off for everyone); ${identity.fullname} has ${acc.level}. Ask Dylan.`],
      atLeast(acc.level, 'write') ? 'not_permitted' : 'access_read');
  }

  const defs = readDefinition(dv, job.setting);
  if (!defs.length) throw new PlanRefused([`there is no setting "${job.setting}" in the ${envInfo.name} (the schema name is the environment variable's Name; check its spelling and case)`], 'invalid_job');
  if (defs.length > 1) throw new PlanRefused([`"${job.setting}" names ${defs.length} settings in the ${envInfo.name}; Ask Dylan.`], 'invalid_job');
  const d = defs[0];
  const display = String(d.displayname || d.schemaname);
  if (d.statecode !== 0 && d.statecode !== undefined && d.statecode !== null) throw new PlanRefused([`'${display}' is inactive`], 'invalid_job');
  const typeName = TYPES[d.type] || `type ${d.type}`;
  if (PORTAL_ONLY.has(d.type)) {
    throw new PlanRefused([`'${display}' is a ${typeName} setting; those are changed in the maker portal (the toolkit never handles a secret or a data connection)`], 'not_permitted');
  }
  if (!TYPES[d.type]) throw new PlanRefused([`'${display}' is of ${typeName}, which this engine does not know`], 'invalid_job');

  const values = readValues(dv, String(d.environmentvariabledefinitionid).toLowerCase());
  if (!values.length) {
    throw new PlanRefused([`'${display}' has no current value (it uses its default, "${shown(d.defaultvalue)}"). Giving it a first value is done in the maker portal for now: Solutions > Default Solution > Environment variables > ${display} > New value.`], 'invalid_job');
  }
  if (values.length > 1) throw new PlanRefused([`'${display}' has ${values.length} current values in the ${envInfo.name}, so which one applies is unclear; Ask Dylan.`], 'invalid_job');
  const v = values[0];
  if (v.ismanaged) throw new PlanRefused([`the current value of '${display}' is managed (Microsoft's or a vendor's layer); managed components are never changed`], 'not_permitted');
  const before = v.value === undefined ? null : v.value;

  if (revertOf && before !== expect) {
    throw new PlanRefused([`'${display}' has changed since plan ${revertOf} set it (now "${shown(before)}", that plan left "${shown(expect)}"), so a revert would overwrite someone's later change. Read it again and decide what it should be.`], 'snapshot_moved');
  }
  const bad = typeProblem(d.type, job.value);
  if (bad) throw new PlanRefused([`'${display}': ${bad}`], 'invalid_job');
  if (before === job.value) throw new PlanRefused([`'${display}' is already "${shown(before)}" (nothing to change)`], 'every_row_refused');

  const valueId = String(v.environmentvariablevalueid).toLowerCase();
  const flows = flowsReading(dv, d.schemaname);
  const solutions = solutionsCarrying(dv, valueId);
  return {
    contract: CONTRACT, kind: 'setting', env: job.env, host: envInfo.host, app: envInfo.name, mode: 'set',
    source: job.source, reason: job.reason, intent: job.intent, identity, access: acc.level, cli_version: dv.cliVersion || null,
    severity: severityFor(flows, warnRows), refused: [], need: 'admin',
    setting: {
      schemaname: d.schemaname, displayname: display, definition_id: String(d.environmentvariabledefinitionid).toLowerCase(), value_id: valueId,
      type: d.type, type_name: typeName, default: d.defaultvalue === undefined ? null : d.defaultvalue, definition_managed: Boolean(d.ismanaged),
    },
    before: { value: before }, after: { value: job.value }, flows, solutions,
    reverts_plan_id: revertOf || null,
  };
}

// ---------- the pop-up ----------

function settingSummary(plan) {
  const s = plan.setting;
  const out = [...severity.block(plan.severity), title(plan), '', `  Type: ${s.type_name}; default "${shown(s.default)}".`];
  const flows = plan.flows || [];
  out.push(flows.length
    ? `  Flows that read it: ${list(flows.map((f) => `${f.name} (${f.on ? 'on' : 'off'})`))}`
    : '  No cloud flow names it (canvas apps and plug-ins are not checked).');
  if (plan.solutions === null) out.push('  Could not check which solutions carry its value.');
  else if (plan.solutions.length) out.push(`  Its value is carried in solution(s) ${list(plan.solutions.map((x) => x.uniquename))}: importing one of them again can set it back (an import did exactly that to HGS's documents switch on 12/4/2024).`);
  out.push('', `  Can be undone with revert (sets it back to "${shown(plan.before.value)}").${flows.some((f) => f.on) ? ' Anything a flow does with the new value before then stays done.' : ''}`, '', `Reason given: ${plan.reason}`);
  return out.join('\n');
}

function settingDetail(plan, { id } = {}) {
  const s = plan.setting;
  const out = [...severity.block(plan.severity), title(plan), '', `Requested by: ${plan.identity.fullname} (${plan.identity.email})`, `Reason given: ${plan.reason}`, `Made by: ${plan.source}`];
  if (id) out.push(`Plan: ${id}`);
  if (plan.reverts_plan_id) out.push(`Undoes plan: ${plan.reverts_plan_id}`);
  out.push(`Setting: ${s.schemaname} ('${s.displayname}'), ${s.type_name}, default "${shown(s.default, 400)}"${s.definition_managed ? ', a managed definition' : ''}`);
  out.push(`Definition: ${s.definition_id}`, `Value row: ${s.value_id}`);
  out.push(`Access needed: admin (a setting can switch live automation on or off for everyone); ${plan.identity.fullname} has ${plan.access}`);
  out.push('', `Before: ${shown(plan.before.value, MAX_VALUE)}`, `After:  ${shown(plan.after.value, MAX_VALUE)}`, '');
  const flows = plan.flows || [];
  if (flows.length) for (const f of flows) out.push(`Flow that reads it: ${f.name} (${f.on ? 'on' : 'off'}) ${f.id}`);
  else out.push('No cloud flow names it (canvas apps and plug-ins are not checked).');
  if (plan.solutions === null) out.push('Solutions carrying its value: could not be read.');
  else for (const x of plan.solutions) out.push(`Solution carrying its value: ${x.uniquename} (${x.name})${x.managed ? ', managed' : ''}`);
  return out.join('\n');
}

// ---------- apply ----------

// What a plan may ask apply to write: one value, as text, to one value row. Anything else in a plan file was
// put there by hand, and apply refuses it (plan_tampered).
function planShapeProblems(plan) {
  const bad = [];
  const s = plan && plan.setting;
  if (!plan || plan.mode !== 'set') bad.push(`the mode "${plan && plan.mode}"`);
  if (!obj(s)) return [...bad, 'no setting'];
  if (typeof s.value_id !== 'string' || !GUID.test(s.value_id)) bad.push('a value row that is not a GUID');
  if (typeof s.definition_id !== 'string' || !GUID.test(s.definition_id)) bad.push('a definition that is not a GUID');
  if (typeof s.schemaname !== 'string' || !SCHEMA.test(s.schemaname)) bad.push('a setting name that is not a schema name');
  if (!obj(plan.after) || typeof plan.after.value !== 'string' || plan.after.value.length > MAX_VALUE) bad.push('a value that is not text of at most 2000 characters');
  if (!obj(plan.before) || !(plan.before.value === null || typeof plan.before.value === 'string')) bad.push('no before value');
  return bad;
}

async function applySetting(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date() } = deps;
  if (now - new Date(plan.created) > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old. Make a new plan.', 'stale_plan');
  const shapeBad = planShapeProblems(plan);
  if (shapeBad.length) throw new ApplyRefused(`this plan file asks to write ${shapeBad.join(', ')}, which no setting plan writes. It was changed after it was made; make a new plan. Nothing was written.`, 'plan_tampered');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  if (!atLeast(acc.level, 'admin')) throw new ApplyRefused(`changing an app setting takes admin access; you have ${acc.level}. Nothing was written.`, 'access_revoked');
  const s = plan.setting;

  // Re-check that what the plan read is still true: the definition (its name and type) and the value row.
  let d;
  try {
    d = dv.get(`${DEF_SET}(${s.definition_id})?$select=schemaname,displayname,type,defaultvalue,statecode`, { strong: true });
  } catch (e) {
    if (!(e instanceof DataverseError)) throw e;
    d = null;
  }
  if (!d || d.schemaname !== s.schemaname || d.type !== s.type) throw new ApplyRefused(`'${s.displayname}' changed since the plan (gone, renamed, or a different type). Nothing was written; make a new plan.`, 'snapshot_moved');
  if (PORTAL_ONLY.has(d.type)) throw new ApplyRefused(`'${s.displayname}' is a ${TYPES[d.type]} setting; those are changed in the maker portal. Nothing was written.`, 'not_permitted');
  const bad = typeProblem(d.type, plan.after.value);
  if (bad) throw new ApplyRefused(`'${s.displayname}': ${bad}. Nothing was written.`, 'invalid_job');
  const live = readValueRow(dv, s.value_id);
  if (!live || String(live._environmentvariabledefinitionid_value || '').toLowerCase() !== s.definition_id) throw new ApplyRefused(`the current value of '${s.displayname}' is gone or moved since the plan. Nothing was written; make a new plan.`, 'snapshot_moved');
  if (live.ismanaged) throw new ApplyRefused(`the current value of '${s.displayname}' is now managed; managed components are never changed. Nothing was written.`, 'not_permitted');
  const liveValue = live.value === undefined ? null : live.value;
  if (liveValue !== plan.before.value) throw new ApplyRefused(`'${s.displayname}' has changed since the plan (now "${shown(liveValue)}", the plan read "${shown(plan.before.value)}"). Nothing was written; make a new plan.`, 'snapshot_moved');
  const etag = live['@odata.etag'];
  if (!etag) throw new ApplyRefused('no version tag came back, so the write could not be protected. Nothing was written.', 'snapshot_moved');

  // The warnings again, from a live read, never the plan's own account (blind review 10/7).
  const flows = flowsReading(dv, s.schemaname);
  const sevNow = severityFor(flows, plan.severity.warn_rows);
  if (severity.grew(plan.severity, sevNow)) {
    throw new ApplyRefused(['this change is more serious than when it was planned, so it is not shown for approval:', ...sevNow.lines.map((l) => `  ! ${l}`), 'Make a new plan.'].join('\n'), 'severity_grew');
  }
  const view = { ...plan, flows, severity: sevNow, access: acc.level };
  const answer = confirm({ summaryText: settingSummary(view), detailText: settingDetail(view, { id }), title: `SBRM: approve this setting change in the ${plan.app}?` });
  const base = {
    time: now.toISOString(), plan_id: id, person: me, env: plan.env, app: plan.app, table: VALUE_SET, mode: 'setting', action: 'set',
    setting: s, source: plan.source, reason: plan.reason, approval: 'prompt', left_out: [], headline: title(view), reverts_plan_id: plan.reverts_plan_id || null,
  };
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };

  // The one write, then the read-back.
  const row = {
    name: s.schemaname, id: s.value_id, action: 'set',
    changes: [{ label: 'value', old_text: plan.before.value, new_text: plan.after.value }],
    before: { value: plan.before.value }, after: null,
  };
  let wrote = false;
  try {
    dv.update(VALUE_SET, s.value_id, { value: plan.after.value }, etag);
    wrote = true;
    const rb = readValueRow(dv, s.value_id);
    const got = rb ? (rb.value === undefined ? null : rb.value) : null;
    row.after = { value: got };
    row.outcome = rb && got === plan.after.value ? 'written' : `read-back mismatch: the value reads "${shown(got)}", not "${shown(plan.after.value)}"`;
  } catch (e) {
    if (!wrote && e && e.code === '0x80060882') row.outcome = 'failed: the setting changed between the check and the write; nothing was written to it';
    else row.outcome = `failed: ${e.message}`;
    try { const rb = readValueRow(dv, s.value_id); row.after = rb ? { value: rb.value === undefined ? null : rb.value } : null; } catch { row.after = null; }
  }
  fs.rmSync(file, { force: true });
  const ok = row.outcome === 'written';
  const outcome = ok ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows: [row] }, outcome, person: me, dv, written: ok ? 1 : 0, rows: [row], left_out: [] };
}

// ---------- revert ----------
//
// Sets the logged before value back, only while the setting still holds what that plan left (else it moved, and
// a revert would overwrite someone's later change). A log entry is data: a forged or damaged one is refused.

async function planSettingRevert(dv, entry, ctx) {
  if (!entry || entry.mode !== 'setting') throw new PlanRefused(['that plan is not an app setting change'], 'nothing_to_undo');
  if (!['applied', 'applied with problems'].includes(entry.outcome)) throw new PlanRefused([`that change's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  const row = (entry.rows || [])[0];
  if (!row || !obj(row.after) || !/^(written|read-back mismatch)/.test(String(row.outcome))) {
    throw new PlanRefused([`that change did not land (${row ? row.outcome : 'no row'}); there is nothing to undo`], 'nothing_to_undo');
  }
  const envs = (ctx && ctx.envs) || {};
  if (typeof entry.env !== 'string' || !has(envs, entry.env)) throw new PlanRefused([`that log entry names an environment the toolkit does not know ("${entry.env}")`], 'invalid_job');
  if (dv.host && String(dv.host).toLowerCase() !== String(envs[entry.env].host).toLowerCase()) {
    throw new PlanRefused([`that change was made in the ${envs[entry.env].name}; this revert was planned against another environment. Revert it in the ${envs[entry.env].name}.`], 'invalid_job');
  }
  if (typeof row.name !== 'string' || !SCHEMA.test(row.name)) throw new PlanRefused(['that log entry has no valid setting name'], 'invalid_job');
  const prev = obj(row.before) ? row.before.value : undefined;
  if (typeof prev !== 'string') throw new PlanRefused(['the log does not say what the value was before'], 'nothing_to_undo');
  const after = row.after.value === undefined ? null : row.after.value;
  const job = {
    contract: CONTRACT, kind: 'setting', env: entry.env, setting: row.name, value: prev,
    source: `revert ${entry.plan_id}`,
    reason: `Undo plan ${entry.plan_id} ("${entry.headline}", by ${entry.person ? entry.person.fullname : 'unknown'}).`.replace(/[\r\n]+/g, ' ').slice(0, 500),
    intent: { verb: 'set', setting: row.name, value: prev },
  };
  return planCore(dv, job, ctx, { revertOf: entry.plan_id, expect: after });
}

module.exports = {
  validateSettingJob, planSetting, settingSummary, settingDetail, applySetting, planSettingRevert,
  planShapeProblems, typeProblem, TYPES, MAX_VALUE,
};
