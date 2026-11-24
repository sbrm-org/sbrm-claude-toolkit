'use strict';
// Kind "command" (1.11.43; Dylan 11/20/26, "Build both into the toolkit", after an operator deactivated three nights
// on the shelter waitlist): hide a built-in command-bar button (Deactivate, Activate, New) for ONE of SBRM's own
// tables in ONE model-driven app. Admin only.
//
// How the platform stores it (measured 11/20 and 11/23/26, Donor App Dev; Shared Dataverse Write STATUS.md): the
// generic buttons are GLOBAL template rows in `appactions` (name "Mscrm.HomepageGrid.{!EntityLogicalName}.Deactivate",
// context 0, one per place: 0 form, 1 main grid, 2 sub grid, 3 associated grid). A narrower row with the same name
// overrides the template. The row this kind makes is the one the maker portal's command designer sends for its own
// Hide: the template's name, context 1 with the table, the APP, hidden true, origin 2, an empty uniquename the server
// fills in, the template's label / icon / JavaScript action copied, and the template's classic visibility rules
// linked (so showing the button again brings it back with its rules).
//
// Job: `app` (the app's unique name), `table`, `hide` (buttons), optional `where` (places; default all four),
// `solution` (an existing unmanaged SBRM solution the new rows go in). The plan reads only. Apply re-reads the
// templates and any row already there before the prompt and after the approval, makes one row per button and place
// (or flips `hidden` on a row an earlier job made), links the rules, and reads each row back. Undo sets `hidden`
// back to false; a row is never deleted. What the read-back proves is the ROW, not the screen: the first live use
// showed no publish is needed (HGS 11/23/26), though a page that had the list open kept the old bar for minutes.

const { whoAmI, accessFor, PlanRefused } = require('./resolve');
const { resolveAccess } = require('./access');
const { ApplyRefused } = require('./apply');
const { planTooOld, STALE_TEXT } = require('./store');
const { GUID } = require('./contract');
const { isTimeout, DataverseError } = require('./cli');
const { atLeast } = require('./levels');
const severity = require('./severity');

const CONTRACT = 'sbrm-dv-job/1';
const MAX_AGE_MS = 24 * 3600 * 1000;
const TOP_KEYS = new Set(['contract', 'kind', 'env', 'app', 'table', 'hide', 'where', 'solution', 'source', 'reason', 'intent']);
// job word -> the template's last name part, and how the prompt says it
const BUTTONS = { deactivate: { part: 'Deactivate', label: 'Deactivate' }, activate: { part: 'Activate', label: 'Activate' }, new: { part: 'NewRecord', label: 'New' } };
// job word -> the template's place (appaction.location), its name's middle part, and how the prompt says it
const PLACES = {
  list: { location: 1, part: 'HomepageGrid', label: 'the list' },
  form: { location: 0, part: 'Form', label: 'the form' },
  subgrid: { location: 2, part: 'SubGrid', label: 'sub grids' },
  associated: { location: 3, part: 'SubGrid', label: 'associated views' },
};
const TABLE = /^sbrm_[a-z0-9_]{1,60}$/;
const UNIQUE = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const T_SELECT = 'appactionid,name,location,context,hidden,ismanaged,statecode,type,sequence,buttonlabeltext,buttontooltiptitle,buttonaccessibilitytext,buttontooltipdescription,fonticon,onclickeventtype,_onclickeventjavascriptwebresourceid_value,onclickeventjavascriptfunctionname,onclickeventjavascriptparameters,visibilitytype';
const R_SELECT = 'appactionid,name,location,context,contextvalue,hidden,ismanaged,statecode,uniquename,_appmoduleid_value';
const RULES = 'appaction_appactionrule_classicrules($select=appactionruleid)';

const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const q = (s) => String(s).replace(/'/g, "''");
const enc = (s) => encodeURIComponent(s);
const low = (s) => String(s || '').toLowerCase();
const same = (a, b) => low(a) === low(b);
const templateName = (button, where) => `Mscrm.${PLACES[where].part}.{!EntityLogicalName}.${BUTTONS[button].part}`;
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join(''));
const refuse = (msg, code) => { throw new ApplyRefused(`${msg} Nothing was written; make a new plan.`, code); };

// ---------- the job file ----------

function validateCommandJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!obj(raw)) return { errors: ['the job file must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be "${CONTRACT}"`);
  if (raw.kind !== 'command') err('"kind" must be "command"');
  if (typeof raw.env !== 'string' || !has(envs, raw.env)) err(`"env" must be one of ${Object.keys(envs).join(', ')}`);
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required (script path, or "claude-session")');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > 500 || /[\r\n]/.test(raw.reason)) err('"reason" must be one line, at most 500 characters');
  const app = typeof raw.app === 'string' ? raw.app.trim() : '';
  if (!UNIQUE.test(app)) err('"app" must be the model-driven app\'s unique name (e.g. sbrm_Homeless), not its display name');
  const table = typeof raw.table === 'string' ? raw.table.trim().toLowerCase() : '';
  if (!TABLE.test(table)) err('"table" must be the logical name of one of SBRM\'s own tables (sbrm_...); buttons on Microsoft\'s tables are changed in the maker portal');
  const solution = typeof raw.solution === 'string' ? raw.solution.trim() : '';
  if (!UNIQUE.test(solution)) err('"solution" must be the unique name of an existing SBRM solution (the new command rows go in it)');
  const list = (v, known, what) => {
    if (!Array.isArray(v) || !v.length) { err(`"${what}" must list one or more of ${Object.keys(known).join(', ')}`); return []; }
    const out = v.map((x) => String(x).toLowerCase());
    if (out.some((x) => !has(known, x)) || new Set(out).size !== out.length) { err(`"${what}" must list one or more of ${Object.keys(known).join(', ')}, none twice`); return []; }
    return out;
  };
  const hide = list(raw.hide, BUTTONS, 'hide');
  const where = raw.where === undefined ? Object.keys(PLACES) : list(raw.where, PLACES, 'where');
  const intent = raw.intent;
  if (!obj(intent)) err('"intent" is required: {verb: "command", action: "hide", app, table, buttons (how many buttons times places)}');
  else if (!errors.length) {
    const mism = [];
    for (const k of Object.keys(intent)) if (!['verb', 'action', 'app', 'table', 'buttons'].includes(k)) mism.push(`unknown key "${k}"`);
    if (intent.verb !== 'command') mism.push(`verb says "${intent.verb}"; hiding a button is "command"`);
    if (intent.action !== 'hide') mism.push(`action says "${intent.action}"; this kind only hides ("hide")`);
    if (typeof intent.app !== 'string' || intent.app.trim() !== app) mism.push(`intent names the app "${intent.app}", the file "${app}"`);
    if (typeof intent.table !== 'string' || intent.table.trim().toLowerCase() !== table) mism.push(`intent names the table "${intent.table}", the file "${table}"`);
    if (intent.buttons !== hide.length * where.length) mism.push(`intent says ${intent.buttons} buttons, the file hides ${hide.length * where.length} (${hide.length} in ${where.length} places)`);
    if (mism.length) err(`intent does not match the job (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  return { errors: [], job: { contract: CONTRACT, kind: 'command', env: raw.env, app, table, hide, where, solution, source: raw.source.trim(), reason: raw.reason.trim(), intent } };
}

// ---------- live reads ----------

function admin(dv, env, app, access) {
  const me = whoAmI(dv);
  if (!me.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, env), me.email, env);
  if (!atLeast(acc.level, 'admin')) {
    throw new PlanRefused([`hiding a button changes the ${app} for everyone who uses it, so it takes admin access; ${me.fullname} has ${acc.level}. Ask Dylan.`],
      atLeast(acc.level, 'write') ? 'not_permitted' : 'access_read');
  }
  return { me, level: acc.level };
}

// The global template for one button in one place, with its classic rules. Returns { template } or { problem }.
function readTemplate(dv, button, where) {
  const name = templateName(button, where);
  const loc = PLACES[where].location;
  const rows = dv.get(`appactions?$select=${T_SELECT}&$expand=${RULES}&$filter=${enc(`name eq '${q(name)}' and location eq ${loc} and context eq 0`)}`).value || [];
  const what = `the built-in ${BUTTONS[button].label} button on ${PLACES[where].label}`;
  if (rows.length !== 1) return { problem: `${what} has ${rows.length} global definitions here, not one; it is changed in the maker portal` };
  const t = rows[0];
  if (!t.ismanaged || t.hidden || t.statecode !== 0) return { problem: `${what} is not Microsoft's own, live, unhidden definition here; it is changed in the maker portal` };
  // A plain button the new row copies faithfully (review F32): type 0 (the row is written as 0), classic or plain
  // visibility (0-2), a JavaScript action.
  if (t.type !== 0 || ![0, 1, 2].includes(t.visibilitytype) || t.onclickeventtype !== 2 || !GUID.test(String(t._onclickeventjavascriptwebresourceid_value)) || typeof t.onclickeventjavascriptfunctionname !== 'string' || typeof t.sequence !== 'number') {
    return { problem: `${what} is not a plain JavaScript button here, so it cannot be copied; it is changed in the maker portal` };
  }
  const text = (v) => (typeof v === 'string' && v ? v : null);
  return {
    template: {
      id: low(t.appactionid), name,
      rules: (t.appaction_appactionrule_classicrules || []).map((r) => low(r.appactionruleid)).sort(),
      fields: {
        sequence: t.sequence, visibilitytype: t.visibilitytype,
        webresourceId: low(t._onclickeventjavascriptwebresourceid_value), functionName: t.onclickeventjavascriptfunctionname,
        parameters: text(t.onclickeventjavascriptparameters), label: text(t.buttonlabeltext), tooltipTitle: text(t.buttontooltiptitle),
        accessibility: text(t.buttonaccessibilitytext), tooltipDescription: text(t.buttontooltipdescription), fonticon: text(t.fonticon),
      },
    },
  };
}

// This app's own override rows for one button in one place on the table (rows made by this kind or by the designer).
function overrides(dv, table, button, where, appId) {
  const loc = PLACES[where].location;
  const rows = dv.get(`appactions?$select=${R_SELECT}&$filter=${enc(`context eq 1 and contextvalue eq '${q(table)}' and location eq ${loc} and name eq '${q(templateName(button, where))}'`)}`).value || [];
  return rows.filter((r) => same(r._appmoduleid_value, appId));
}

// Every button and place the job names, as it stands now: what to do, and what it rests on.
// Returns { steps, skipped, problems }. READS ONLY.
function readSteps(dv, { table, hide, where, appId }) {
  const steps = [];
  const skipped = [];
  const problems = [];
  for (const button of hide) {
    for (const w of where) {
      const what = `${BUTTONS[button].label} on ${PLACES[w].label}`;
      const t = readTemplate(dv, button, w);
      if (t.problem) { problems.push(t.problem); continue; }
      const own = overrides(dv, table, button, w, appId);
      if (own.length > 1) { problems.push(`${own.length} rows already override ${what} for ${table} in this app; sort them out in the maker portal first`); continue; }
      const row = own[0] || null;
      if (row && (row.ismanaged || row.statecode !== 0)) { problems.push(`the row that overrides ${what} for ${table} in this app is managed or inactive; it is changed in the maker portal`); continue; }
      if (row && row.hidden === true) { skipped.push(what); continue; }
      steps.push({ button, where: w, location: PLACES[w].location, action: row ? 'hide' : 'create', template: t.template, row: row ? { id: low(row.appactionid) } : null });
    }
  }
  return { steps, skipped, problems };
}

const facts = (steps) => JSON.stringify(steps.map((s) => [s.button, s.where, s.action, s.template, s.row]));

// ---------- plan ----------

async function planCommand(dv, job, { envs, access, warnRows = severity.DEFAULT_WARN_ROWS }) {
  const envInfo = envs[job.env];
  const identity = admin(dv, job.env, envInfo.name, access);
  const problems = [];
  const apps = dv.get(`appmodules?$select=appmoduleid,name,uniquename&$filter=${enc(`uniquename eq '${q(job.app)}'`)}`).value || [];
  if (apps.length !== 1) problems.push(`there ${apps.length ? `are ${apps.length} apps` : 'is no app'} with the unique name ${job.app} in the ${envInfo.name}`);
  let meta = null;
  try { meta = dv.get(`EntityDefinitions(LogicalName='${q(job.table)}')?$select=MetadataId,LogicalName,IsManaged`); } catch { meta = null; }
  if (!meta || !GUID.test(String(meta.MetadataId))) problems.push(`there is no table named ${job.table}`);
  // SBRM's own, unmanaged (review F18): a table that came in a managed solution is changed by whoever owns that solution.
  else if (meta.IsManaged !== false) problems.push(`${job.table} ${meta.IsManaged === true ? 'is a managed table' : 'could not be read as an unmanaged table'}; its buttons are changed in the maker portal`);
  const sols = dv.get(`solutions?$select=solutionid,ismanaged,friendlyname,uniquename,_publisherid_value&$filter=${enc(`uniquename eq '${q(job.solution)}'`)}`).value || [];
  if (sols.length !== 1 || sols[0].ismanaged) problems.push(`${job.solution} is not an existing unmanaged solution here`);
  // Under the SBRM publisher (review F19), as every other kind's solution is: never Default or someone else's.
  else if (!envInfo.publisher) problems.push(`envs.json names no SBRM publisher for the ${envInfo.name}`);
  else if (!same(sols[0]._publisherid_value, envInfo.publisher)) problems.push(`the solution ${job.solution} is not under the SBRM publisher; SBRM's own changes go only in SBRM-publisher solutions`);
  if (problems.length) throw new PlanRefused(problems, 'invalid_job');
  const app = { id: low(apps[0].appmoduleid), name: String(apps[0].name || job.app), uniquename: job.app };
  const r = readSteps(dv, { table: job.table, hide: job.hide, where: job.where, appId: app.id });
  if (r.problems.length) throw new PlanRefused(r.problems, 'invalid_job');
  if (!r.steps.length) throw new PlanRefused([`${andList(r.skipped)} ${r.skipped.length === 1 ? 'is' : 'are'} already hidden for ${job.table} in ${app.name}; there is nothing to do`], 'nothing_to_do');
  const plan = {
    contract: CONTRACT, kind: 'command', env: job.env, host: envInfo.host, app: envInfo.name, mode: 'command', action: 'hide',
    model_app: app, table: { name: job.table, metadata_id: low(meta.MetadataId) },
    solution: { uniquename: job.solution, id: low(sols[0].solutionid), name: String(sols[0].friendlyname || job.solution), publisher: low(sols[0]._publisherid_value) },
    buttons: job.hide, where: job.where, steps: r.steps, already_hidden: r.skipped,
    source: job.source, reason: job.reason, intent: job.intent, identity: identity.me, access: identity.level,
    cli_version: dv.cliVersion || null, need: 'admin', refused: [], reverts_plan_id: null,
  };
  plan.severity = severityFor(plan, warnRows);
  return plan;
}

function severityFor(plan, warnRows) {
  const made = plan.action === 'hide' ? plan.steps.filter((s) => s.action === 'create').length : 0;
  return severity.assess({
    count: plan.steps.length, noun: 'buttons',
    // The standard Lasting line adds "Undo cannot remove it": this says what undo DOES do, once.
    lasting: made ? [`${made} new command row${made === 1 ? '' : 's'} in the app '${plan.model_app.name}'; undo shows the button again but keeps the row${made === 1 ? '' : 's'}`] : [],
    // Claude Code's prompt shows the severity lines (round-2 review F17), so a short row is named there, not only in the summary.
    notes: plan.action === 'show' && plan.steps.some((s) => s.short_rules)
      ? [`${andList(plan.steps.filter((s) => s.short_rules).map(stepText))} come${plan.steps.filter((s) => s.short_rules).length === 1 ? 's' : ''} back with fewer visibility rules than the built-in button, so it may show where it normally would not`]
      : [],
  }, { warnRows });
}

// ---------- the prompt ----------

const stepText = (s) => `${BUTTONS[s.button].label} on ${PLACES[s.where].label}`;
const names = (plan) => andList([...new Set(plan.steps.map((s) => BUTTONS[s.button].label))]);
const places = (plan) => andList([...new Set(plan.steps.map((s) => PLACES[s.where].label))]);

function title(plan) {
  const verb = plan.action === 'show' ? 'Show' : 'Hide';
  return `${verb} the ${names(plan)} button${new Set(plan.steps.map((s) => s.button)).size === 1 ? '' : 's'} for ${plan.table.name} in the app '${plan.model_app.name}' (${plan.app}): ${places(plan)}`;
}

function commandSummary(plan) {
  const out = [...severity.block(plan.severity), title(plan), ''];
  if (plan.action === 'show') {
    const short = plan.steps.filter((s) => s.short_rules);
    out.push('  The button comes back for everyone who uses this app, with the visibility rules its row carries.',
      // A hide that stopped part-way may have linked only some of the button's rules (review F28).
      ...(short.length ? [`  ${andList(short.map(stepText))}: the row carries fewer rules than the built-in button has, so it may show where it normally would not.`] : []),
      ...((plan.already_showing || []).length ? [`  Already showing, left as they are: ${andList(plan.already_showing)}.`] : []),
      '  After this is applied, open the app and look; a page that already had the list open can show the old bar for a few minutes.', '',
      '  Not undone by revert: hide it again with a new job.');
  } else {
    out.push(`  The button disappears for EVERYONE who uses '${plan.model_app.name}', admins included. A security role does not bring it back.`,
      `  Other apps that show ${plan.table.name} keep the button; this change is for this app only.`,
      ...((plan.already_hidden || []).length ? [`  Already hidden, left as they are: ${andList(plan.already_hidden)}.`] : []),
      ...(plan.steps.some((s) => s.action === 'create') ? [`  New command rows go in solution ${plan.solution.name}.`] : []),
      '  After this is applied, open the app and look; no publish is needed, but a page that already had the list open can show the old bar for a few minutes.', '',
      '  Can be undone with revert (shows the button again; the rows stay).');
  }
  out.push('', `Reason given: ${plan.reason}`);
  return out.join('\n');
}

function commandDetail(plan, { id } = {}) {
  const out = [...severity.block(plan.severity), title(plan), '', `Requested by: ${plan.identity.fullname} (${plan.identity.email})`, `Reason given: ${plan.reason}`, `Made by: ${plan.source}`];
  if (id) out.push(`Plan: ${id}`);
  if (plan.reverts_plan_id) out.push(`Undoes plan: ${plan.reverts_plan_id}`);
  out.push(`Access needed: admin (it changes the app for everyone); ${plan.identity.fullname} has ${plan.access}`, '',
    `App: ${plan.model_app.name} (${plan.model_app.uniquename}, ${plan.model_app.id})`, `Table: ${plan.table.name} (${plan.table.metadata_id})`);
  if (plan.action === 'hide') out.push(`Solution: ${plan.solution.uniquename}`);
  for (const s of plan.steps) {
    if (plan.action === 'show') out.push(`  show ${stepText(s)}: row ${s.row.id}`);
    else out.push(`  ${s.action === 'create' ? 'new row for' : 'hide the existing row for'} ${stepText(s)}: template ${s.template.name} (${s.template.id}), ${s.template.rules.length} rule(s)${s.row ? `, row ${s.row.id}` : ''}`);
  }
  return out.join('\n');
}

// A plan file is data: every step must be one this kind makes.
function planShapeProblems(plan) {
  const bad = [];
  if (!plan || plan.mode !== 'command') return ['a plan that is not a command-bar change'];
  if (!obj(plan.model_app) || !GUID.test(String(plan.model_app.id))) bad.push('no app');
  if (!obj(plan.table) || !TABLE.test(String(plan.table.name)) || !GUID.test(String(plan.table.metadata_id))) bad.push('a table that is not one of SBRM\'s own');
  if (!Array.isArray(plan.steps) || !plan.steps.length) return [...bad, 'no buttons'];
  if (plan.action === 'hide') {
    if (!obj(plan.solution) || !UNIQUE.test(String(plan.solution.uniquename)) || !GUID.test(String(plan.solution.id)) || !GUID.test(String(plan.solution.publisher))) bad.push('no solution');
    for (const s of plan.steps) {
      const ok = obj(s) && has(BUTTONS, s.button) && has(PLACES, s.where) && s.location === PLACES[s.where].location && (s.action === 'create' || s.action === 'hide')
        && obj(s.template) && s.template.name === templateName(s.button, s.where) && GUID.test(String(s.template.id)) && Array.isArray(s.template.rules)
        && s.template.rules.every((r) => GUID.test(String(r))) && obj(s.template.fields) && GUID.test(String(s.template.fields.webresourceId))
        && (s.action === 'create' ? s.row === null : obj(s.row) && GUID.test(String(s.row.id)));
      if (!ok) { bad.push('a button step that is not one a plan makes'); break; }
    }
  } else if (plan.action === 'show') {
    if (!plan.reverts_plan_id) bad.push('a show that is not the undo of a logged hide');
    for (const s of plan.steps) {
      if (!(obj(s) && has(BUTTONS, s.button) && has(PLACES, s.where) && obj(s.row) && GUID.test(String(s.row.id)))) { bad.push('a button step that is not one a plan makes'); break; }
    }
  } else bad.push(`the action "${plan.action}"`);
  return bad;
}

// ---------- apply ----------

function readRow(dv, id) {
  return dv.get(`appactions(${id})?$select=${R_SELECT}&$expand=${RULES}`, { strong: true });
}

// A row as this kind expects to find it: this app's, this table's, unmanaged, live. Returns a problem or null.
function rowProblem(r, plan, s) {
  if (!r) return 'it is gone';
  if (r.ismanaged || r.statecode !== 0) return 'it is managed or inactive';
  if (r.context !== 1 || !same(r.contextvalue, plan.table.name) || !same(r._appmoduleid_value, plan.model_app.id)) return 'it is not this table\'s row in this app';
  if (r.location !== PLACES[s.where].location || r.name !== templateName(s.button, s.where)) return 'it is not this button in this place';
  return null;
}

function baseEntry(plan, me, id, now, view) {
  return {
    time: now.toISOString(), plan_id: id, person: me, env: plan.env, app: plan.app, table: 'appactions', mode: 'command', action: plan.action,
    model_app: plan.model_app, command_table: plan.table.name,
    source: plan.source, reason: plan.reason, approval: 'prompt', left_out: [], headline: title(view), reverts_plan_id: plan.reverts_plan_id || null,
  };
}

async function applyCommand(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date() } = deps;
  if (planTooOld(plan, now, MAX_AGE_MS)) throw new ApplyRefused(STALE_TEXT, 'stale_plan');
  const shapeBad = planShapeProblems(plan);
  if (shapeBad.length) throw new ApplyRefused(`this plan file asks to write ${shapeBad.join(', ')}, which no command-bar plan writes. It was changed after it was made; make a new plan. Nothing was written.`, 'plan_tampered');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  if (!atLeast(acc.level, 'admin')) throw new ApplyRefused(`hiding or showing a button takes admin access; you have ${acc.level}. Nothing was written.`, 'access_revoked');
  const c = { id, file, fs, confirm, now };
  return plan.action === 'show' ? applyShow(plan, dv, me, acc, c) : applyHide(plan, dv, me, acc, c);
}

// Everything the plan read, read again: the same steps on the same templates and rows, or nothing is written.
function hideChecks(dv, plan, waited) {
  const when = waited ? 'while the approval was waiting' : 'since the plan';
  // The app and the table, read again by name (advisor 11/23: what is written never rests on the plan's own account
  // of itself): the app's unique name still names this app id, the table's metadata id is still this one, unmanaged.
  const apps = dv.get(`appmodules?$select=appmoduleid,name,uniquename&$filter=${enc(`uniquename eq '${q(plan.model_app.uniquename)}'`)}`).value || [];
  if (apps.length !== 1 || !same(apps[0].appmoduleid, plan.model_app.id)) return { problem: `the app ${plan.model_app.uniquename} is not app ${plan.model_app.id} ${when}`, code: 'snapshot_moved' };
  let meta = null;
  try { meta = dv.get(`EntityDefinitions(LogicalName='${q(plan.table.name)}')?$select=MetadataId,LogicalName,IsManaged`); } catch { meta = null; }
  if (!meta || !same(meta.MetadataId, plan.table.metadata_id) || meta.IsManaged !== false) return { problem: `the table ${plan.table.name} is not the unmanaged table ${plan.table.metadata_id} ${when}`, code: 'snapshot_moved' };
  const sol = dv.get(`solutions?$select=solutionid,ismanaged,_publisherid_value&$filter=${enc(`uniquename eq '${q(plan.solution.uniquename)}'`)}`).value || [];
  // Still under the SBRM publisher the plan read (round-2 review F10).
  if (sol.length !== 1 || sol[0].ismanaged || !same(sol[0].solutionid, plan.solution.id) || !same(sol[0]._publisherid_value, plan.solution.publisher)) return { problem: `the solution ${plan.solution.uniquename} changed ${when} (gone, replaced, now managed or under another publisher)`, code: 'snapshot_moved' };
  const now = readSteps(dv, { table: plan.table.name, hide: plan.buttons, where: plan.where, appId: plan.model_app.id });
  if (now.problems.length) return { problem: `${now.problems.join('; ')} (changed ${when})`, code: 'snapshot_moved' };
  if (facts(now.steps) !== facts(plan.steps)) return { problem: `the buttons or the rows that override them changed ${when}, so this would work from a stale picture`, code: 'snapshot_moved' };
  return {};
}

function applyHide(plan, dv, me, acc, { id, file, fs, confirm, now }) {
  if (!Array.isArray(plan.buttons) || !Array.isArray(plan.where)) refuse('this plan does not say which buttons and places it covers.', 'plan_tampered');
  const c = hideChecks(dv, plan, false);
  if (c.problem) refuse(`${c.problem}.`, c.code);
  const view = { ...plan, access: acc.level };
  const answer = confirm({ summaryText: commandSummary(view), detailText: commandDetail(view, { id }), title: `SBRM: approve hiding this button in the ${plan.app}?` });
  const base = baseEntry(plan, me, id, now, view);
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };
  // The prompt can wait minutes: everything is read again after the Yes.
  const again = hideChecks(dv, plan, true);
  if (again.problem) refuse(`${again.problem}.`, again.code);

  const rows = [];
  let stopped = null;
  for (const s of plan.steps) {
    const row = { name: stepText(s), id: s.row ? s.row.id : null, action: s.action, button: s.button, where: s.where, before: s.row ? { hidden: false } : { exists: false }, after: null, notes: [] };
    rows.push(row);
    if (stopped) { row.outcome = `not attempted: an earlier button failed (${stopped})`; continue; }
    let linked = 0;
    let flipSent = false; // the flip's PATCH answered OK, or timed out (it may have landed)
    try {
      if (s.action === 'create') {
        const made = dv.createCommandHide({ name: s.template.name, location: s.location, table: plan.table.name, entityId: plan.table.metadata_id, appId: plan.model_app.id, fields: s.template.fields }, plan.solution.uniquename);
        let rid = made && GUID.test(String(made.appactionid)) ? low(made.appactionid) : null;
        if (!rid) {
          // No id came back: the row is found by what it is, only when exactly one is there now.
          const found = overrides(dv, plan.table.name, s.button, s.where, plan.model_app.id);
          if (found.length !== 1) throw new Error(`the new row's id did not come back and ${found.length} rows match it`);
          rid = low(found[0].appactionid);
        }
        row.id = rid;
        for (const rule of s.template.rules) { dv.linkCommandRule(rid, rule); linked += 1; }
      } else {
        const live = readRow(dv, s.row.id);
        const p = rowProblem(live, plan, s);
        if (p) throw new Error(`the row to hide changed: ${p}`);
        try { dv.setCommandHidden(s.row.id, true, live['@odata.etag']); } catch (ef) { if (isTimeout(ef)) flipSent = true; throw ef; }
        flipSent = true;
      }
      const back = readRow(dv, row.id);
      const rules = (back.appaction_appactionrule_classicrules || []).map((r) => low(r.appactionruleid)).sort();
      row.after = { id: row.id, hidden: back.hidden === true, uniquename: back.uniquename || null, rules };
      const bad = [];
      const p = rowProblem(back, plan, s);
      if (p) bad.push(p);
      if (back.hidden !== true) bad.push('the row does not read hidden');
      if (s.action === 'create' && JSON.stringify(rules) !== JSON.stringify(s.template.rules)) bad.push(`the row carries ${rules.length} of the button's ${s.template.rules.length} rules`);
      row.outcome = bad.length ? `read-back mismatch: ${bad.join('; ')}` : 'written';
    } catch (e) {
      // A create can commit and still lose its answer (a timeout; review F21): the row is looked for by what it is, and
      // taken as this apply's only when exactly one is there now (the plan read none).
      if (!row.id && s.action === 'create') {
        try {
          const found = overrides(dv, plan.table.name, s.button, s.where, plan.model_app.id);
          if (found.length === 1) row.id = low(found[0].appactionid);
        } catch { /* left unknown */ }
      }
      const made = row.id && s.action === 'create';
      row.outcome = `failed: ${e.message}${made ? ` (the new row ${row.id} was made${s.template.rules.length ? `, ${linked} of ${s.template.rules.length} rules linked` : ''}; revert shows the button again)` : ''}`;
      // Whatever the row reads now goes in the log, so revert can show it again: a row this apply made, or a flip that
      // answered OK (its read-back failed) or timed out. A flip refused before it landed leaves no after, so revert never
      // shows a row someone else hid.
      if (row.id && (made || flipSent)) {
        try { const back = readRow(dv, row.id); row.after = { id: row.id, hidden: back.hidden === true, uniquename: back.uniquename || null, rules: (back.appaction_appactionrule_classicrules || []).map((r) => low(r.appactionruleid)).sort() }; } catch { row.after = { id: row.id, hidden: null, uniquename: null, rules: null }; }
      }
      stopped = stepText(s);
    }
    row.changes = [{ label: 'Command bar', old_text: `${stepText(s)}: shown`, new_text: row.outcome === 'written' ? 'hidden' : row.outcome }];
    if (row.outcome === 'written') row.notes.push('The row reads hidden. Open the app and look; no publish is needed, but a page that already had the list open can show the old bar for a few minutes.');
  }
  fs.rmSync(file, { force: true });
  const ok = rows.filter((r) => r.outcome === 'written').length;
  const outcome = ok === rows.length ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows }, outcome, person: me, dv, written: ok, rows, left_out: [] };
}

// Each row the undo shows, read now. Only "does not exist" counts as gone (round-2 review F21: any other read error is
// a problem, never "nothing to undo"). A row already showing is passed over (F16: one row shown by hand must not strand
// the rest hidden); a row that changed refuses the whole undo. Returns { live, steps, showing } or { problem, code }.
function showChecks(dv, plan) {
  const live = [];
  const steps = [];
  const showing = [];
  for (const s of plan.steps) {
    let row = null;
    try { row = readRow(dv, s.row.id); } catch (e) {
      if (!(e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`))) {
        return { problem: `the row for ${stepText(s)} could not be read (${String(e.message).slice(0, 160)}); try again`, code: 'snapshot_moved' };
      }
      row = null;
    }
    const p = rowProblem(row, plan, s);
    if (p) return { problem: `the row for ${stepText(s)} changed since plan ${plan.reverts_plan_id}: ${p}`, code: row ? 'snapshot_moved' : 'nothing_to_undo' };
    if (row.hidden !== true) { showing.push(stepText(s)); continue; }
    live.push(row);
    steps.push(s);
  }
  if (!steps.length) return { problem: `${andList(showing)} ${showing.length === 1 ? 'is' : 'are'} already showing`, code: 'nothing_to_undo' };
  return { live, steps, showing };
}

// A row carries fewer rules than its button's live template (round-2 review F8, F9): read from the rows, never from an
// outcome line. A template that cannot be read now is not judged (null).
function shortOfRules(dv, s, row) {
  const t = readTemplate(dv, s.button, s.where);
  if (t.problem) return null;
  const have = new Set((row.appaction_appactionrule_classicrules || []).map((r) => low(r.appactionruleid)));
  return t.template.rules.some((r) => !have.has(r));
}

function applyShow(plan, dv, me, acc, { id, file, fs, confirm, now }) {
  const c = showChecks(dv, plan);
  if (c.problem) refuse(`${c.problem}.`, c.code);
  if (c.steps.length !== plan.steps.length) refuse(`${andList(c.showing)} ${c.showing.length === 1 ? 'is' : 'are'} already showing since the plan.`, 'snapshot_moved');
  const view = { ...plan, access: acc.level };
  const answer = confirm({ summaryText: commandSummary(view), detailText: commandDetail(view, { id }), title: `SBRM: approve showing this button again in the ${plan.app}?` });
  const base = baseEntry(plan, me, id, now, view);
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };
  const again = showChecks(dv, plan);
  if (again.problem) refuse(`Something changed while the approval was waiting: ${again.problem}.`, again.code);
  if (again.steps.length !== plan.steps.length) refuse(`Something changed while the approval was waiting: ${andList(again.showing)} ${again.showing.length === 1 ? 'is' : 'are'} already showing.`, 'snapshot_moved');
  const rows = [];
  plan.steps.forEach((s, i) => {
    const row = { name: stepText(s), id: s.row.id, action: 'show', button: s.button, where: s.where, before: { hidden: true }, after: null, notes: [] };
    rows.push(row);
    try {
      dv.setCommandHidden(s.row.id, false, again.live[i]['@odata.etag']);
      const back = readRow(dv, s.row.id);
      row.after = { id: s.row.id, hidden: back.hidden === true, uniquename: back.uniquename || null };
      row.outcome = back.hidden === false ? 'written' : 'read-back mismatch: the row still reads hidden';
    } catch (e) {
      row.outcome = `failed: ${e.message}`;
    }
    row.changes = [{ label: 'Command bar', old_text: `${stepText(s)}: hidden`, new_text: row.outcome === 'written' ? 'shown' : row.outcome }];
  });
  fs.rmSync(file, { force: true });
  const ok = rows.filter((r) => r.outcome === 'written').length;
  const outcome = ok === rows.length ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows }, outcome, person: me, dv, written: ok, rows, left_out: [] };
}

// ---------- revert ----------
//
// Undo of a hide: every row that hide left hidden is shown again (hidden false). The rows stay. A log entry is data:
// each row it names must still be this table's row for this button in this app.

async function planCommandRevert(dv, entry, ctx) {
  if (!entry || entry.mode !== 'command') throw new PlanRefused(['that plan is not a command-bar change'], 'nothing_to_undo');
  if (!['applied', 'applied with problems'].includes(entry.outcome)) throw new PlanRefused([`that change's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  const { envs, access, warnRows = severity.DEFAULT_WARN_ROWS } = ctx;
  if (typeof entry.env !== 'string' || !has(envs || {}, entry.env)) throw new PlanRefused([`that log entry names an environment the toolkit does not know ("${entry.env}")`], 'invalid_job');
  if (dv.host && low(dv.host) !== low(envs[entry.env].host)) {
    throw new PlanRefused([`that change was made in the ${envs[entry.env].name}; this revert was planned against another environment. Revert it in the ${envs[entry.env].name}.`], 'invalid_job');
  }
  if (entry.action === 'show') throw new PlanRefused(['showing a button again is not undone here: hide it again with a new job'], 'nothing_to_undo');
  if (entry.action !== 'hide' || !obj(entry.model_app) || !GUID.test(String(entry.model_app.id)) || !TABLE.test(String(entry.command_table))) throw new PlanRefused(['that log entry has no valid app, table or action'], 'invalid_job');
  const hidden = (entry.rows || []).filter((r) => obj(r) && obj(r.after) && GUID.test(String(r.after.id)) && r.after.hidden !== false && /^(written|read-back mismatch|failed)/.test(String(r.outcome)));
  if (!hidden.length) throw new PlanRefused(['that change hid nothing (no row it made or changed is left hidden); there is nothing to undo'], 'nothing_to_undo');
  if (hidden.some((r) => !has(BUTTONS, r.button) || !has(PLACES, r.where))) throw new PlanRefused(['that log entry names a button or place this kind does not know'], 'invalid_job');
  const envInfo = envs[entry.env];
  const identity = admin(dv, entry.env, envInfo.name, access);
  let meta = null;
  try { meta = dv.get(`EntityDefinitions(LogicalName='${q(entry.command_table)}')?$select=MetadataId,LogicalName`); } catch { meta = null; }
  if (!meta || !GUID.test(String(meta.MetadataId))) throw new PlanRefused([`there is no table named ${entry.command_table} any more`], 'nothing_to_undo');
  const plan = {
    contract: CONTRACT, kind: 'command', env: entry.env, host: envInfo.host, app: envInfo.name, mode: 'command', action: 'show',
    model_app: { id: low(entry.model_app.id), name: String(entry.model_app.name || entry.model_app.uniquename || entry.model_app.id).slice(0, 200), uniquename: entry.model_app.uniquename || null },
    table: { name: entry.command_table, metadata_id: low(meta.MetadataId) },
    steps: hidden.map((r) => ({ button: r.button, where: r.where, location: PLACES[r.where].location, action: 'show', row: { id: low(r.after.id) } })),
    source: `revert ${entry.plan_id}`,
    reason: `Undo plan ${entry.plan_id} ("${entry.headline}", by ${entry.person ? entry.person.fullname : 'unknown'}).`.replace(/[\r\n]+/g, ' ').slice(0, 500),
    intent: { verb: 'command', action: 'show', table: entry.command_table }, identity: identity.me, access: identity.level,
    cli_version: dv.cliVersion || null, need: 'admin', refused: [], reverts_plan_id: entry.plan_id,
  };
  const c = showChecks(dv, plan);
  if (c.problem) throw new PlanRefused([c.problem], c.code);
  plan.steps = c.steps.map((s, i) => (shortOfRules(dv, s, c.live[i]) ? { ...s, short_rules: true } : s));
  plan.already_showing = c.showing;
  plan.severity = severityFor(plan, warnRows);
  return plan;
}

module.exports = {
  validateCommandJob, planCommand, commandSummary, commandDetail, applyCommand, planCommandRevert, planShapeProblems,
  BUTTONS, PLACES, templateName,
};
