'use strict';
// Duplicate-detection rules (kind "duperule", Dylan 11/16/26: "lets do the duplicate-rule job"; admin, his ruling the
// same day). Why it exists: the Fundraise Up connector matches donors through the donor app's PUBLISHED duplicate
// rules and takes the first record returned, so the name-only contact rule could put a new donor's gift on someone
// else with the same name (Daian's email 11/16; Dylan chose first + last + ZIP). Nothing could change a rule: a
// records job on duplicaterules is refused (lib/access.js, app definitions), and the 10/7 email-rule fix ran through
// root dataverse_write.py, switched off 10/14. Scope and rulings: Shared Dataverse Write\duperule\SCOPE.md.
//
//   modes  update (the rule's own fields and/or its whole condition list), create (a new rule, published),
//          off (unpublish), on (publish). A rule is never deleted; undo of a create turns it off.
//   plan   reads the rule and its conditions, checks every attribute against the table's metadata and every match
//          type against the attribute's type; refuses a managed rule, a cross-table rule, a name another rule has,
//          and no change. Reads only.
//   apply  re-reads the rule and its conditions and refuses if either moved; then, in the order the platform
//          demands (learned 10/7, email_case_fix.py): UNPUBLISH (an UNBOUND action, body {DuplicateRuleId}; the bound
//          form answers "Resource not found"), wait until it reads unpublished, PATCH the rule, replace the
//          conditions (create the new rows FIRST, then delete the old ones by the ids and version tags read before
//          the prompt; a condition is part of the rule's definition, not a record), PUBLISH (bound to the rule, an
//          async job), wait until it reads published, read everything back. A change while the prompt was open
//          stops the apply before anything is written.
//   log    before and after (rule fields, conditions, published or not); revert puts the before back by the same
//          sequence, only while the rule still reads what the apply left.
//
// While a rule is unpublished nobody gets its duplicate warning, and the connector does not match on it; the plan
// says so. A publish that has not finished inside the wait is reported, not failed: the platform finishes it.

const { whoAmI, accessFor, PlanRefused } = require('./resolve');
const { resolveAccess } = require('./access');
const { ApplyRefused } = require('./apply');
const { DataverseError } = require('./cli');
const { GUID } = require('./contract');
const { atLeast } = require('./levels');
const severity = require('./severity');

const CONTRACT = 'sbrm-dv-job/1';
const MAX_AGE_MS = 24 * 3600 * 1000;
const RULE_SET = 'duplicaterules';
const COND_SET = 'duplicateruleconditions';
const MODES = ['update', 'create', 'off', 'on'];
const TOP_KEYS = new Set(['contract', 'kind', 'env', 'mode', 'rule', 'definition', 'source', 'reason', 'intent']);
const DEF_KEYS = new Set(['name', 'description', 'iscasesensitive', 'excludeinactiverecords', 'conditions']);
const COND_KEYS = new Set(['attribute', 'operatorcode', 'operatorparam', 'ignoreblankvalues']);
const IDENT = /^[a-z_][a-z0-9_]{0,127}$/;
const MAX_NAME = 100; // duplicaterule.name (read live 11/16/26: uniquerulename on a condition is 100 too)
const MAX_DESC = 2000;
const MAX_CONDITIONS = 10;
// duplicaterulecondition.operatorcode (read live 11/16/26, donorapp).
const OPERATORS = {
  0: 'Exact Match', 1: 'Same First Characters', 2: 'Same Last Characters', 3: 'Same Date', 4: 'Same Date and Time',
  5: 'Exact Match (Pick List Label)', 6: 'Exact Match (Pick List Value)',
};
const TEXT_TYPES = new Set(['String', 'Memo']);
const OPERATOR_TYPES = { 1: TEXT_TYPES, 2: TEXT_TYPES, 3: new Set(['DateTime']), 4: new Set(['DateTime']), 5: new Set(['Picklist', 'State', 'Status']), 6: new Set(['Picklist', 'State', 'Status']) };
// duplicaterule statuscode: 0 Unpublished, 1 Publishing, 2 Published.
const STATUS = { 0: 'unpublished', 1: 'publishing', 2: 'published' };
const POLL_MS = 5000;
const UNPUBLISH_CEILING_MS = 5 * 60 * 1000; // email_case_fix.py (10/7) saw it land inside 90 s; 5 min leaves room (F1)
const PUBLISH_CEILING_MS = 10 * 60 * 1000; // the match codes rebuild over every row (~39K contacts in the donor app)
// Apps whose contact/account rules the Fundraise Up connector matches through (Daian's PLAN.md §5).
const CONNECTOR_APPS = new Set(['donorapp', 'fedev']);

const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const q = (s) => String(s).replace(/'/g, "''");
const enc = (s) => encodeURIComponent(s);
const oneLine = (s, n) => typeof s === 'string' && s.trim().length > 0 && s.length <= n && !/[\x00-\x1f\x7f]/.test(s);
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------- canonical shapes ----------

// One condition as the engine keeps it: same-table rules only, so base and matching attribute are one name.
function condOf(c) {
  const code = Number(c.operatorcode);
  return {
    attribute: String(c.attribute !== undefined ? c.attribute : c.baseattributename).toLowerCase(),
    operatorcode: code,
    operatorparam: code === 1 || code === 2 ? Number(c.operatorparam) : null,
    ignoreblankvalues: Boolean(c.ignoreblankvalues),
  };
}
const condKey = (c) => `${c.attribute}|${c.operatorcode}|${c.operatorparam === null ? '' : c.operatorparam}|${c.ignoreblankvalues ? 1 : 0}`;
const sortConds = (cs) => [...cs].sort((a, b) => condKey(a).localeCompare(condKey(b)));
const sameConds = (a, b) => a.length === b.length && sortConds(a).every((c, i) => condKey(c) === condKey(sortConds(b)[i]));

function condText(c) {
  const op = c.operatorcode === 1 || c.operatorcode === 2 ? `${OPERATORS[c.operatorcode]} (${c.operatorparam})` : OPERATORS[c.operatorcode];
  return `${c.attribute}: ${op}, blanks ${c.ignoreblankvalues ? 'ignored' : 'NOT ignored'}`;
}

// "Publishing" (1) counts as published: the platform finishes it, and an apply that logged it mid-publish must still
// be undoable once it lands (advisor review 11/16). A plan refuses a rule that reads publishing (liveRule).
function stateOf(rule) {
  return { name: rule.name, description: rule.description || '', iscasesensitive: Boolean(rule.iscasesensitive), excludeinactiverecords: Boolean(rule.excludeinactiverecords), published: rule.statuscode === 2 || rule.statuscode === 1 };
}

// ---------- the job file ----------

function validateCondition(c, i, err) {
  if (!obj(c)) return err(`definition.conditions[${i}] must be an object {attribute, operatorcode, operatorparam?, ignoreblankvalues}`);
  for (const k of Object.keys(c)) if (!COND_KEYS.has(k)) err(`definition.conditions[${i}]: unknown key "${k}" (base and matching attribute are the same column: name it once as "attribute")`);
  if (typeof c.attribute !== 'string' || !IDENT.test(c.attribute)) err(`definition.conditions[${i}].attribute must be a column's logical name (lowercase), e.g. "address1_postalcode"`);
  if (!Number.isInteger(c.operatorcode) || !has(OPERATORS, c.operatorcode)) err(`definition.conditions[${i}].operatorcode must be one of ${Object.entries(OPERATORS).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  else if (c.operatorcode === 1 || c.operatorcode === 2) {
    if (!Number.isInteger(c.operatorparam) || c.operatorparam < 1 || c.operatorparam > 100) err(`definition.conditions[${i}]: ${OPERATORS[c.operatorcode]} needs "operatorparam", how many characters (1 to 100)`);
  } else if (c.operatorparam !== undefined && c.operatorparam !== null) err(`definition.conditions[${i}]: ${OPERATORS[c.operatorcode]} takes no "operatorparam"`);
  if (typeof c.ignoreblankvalues !== 'boolean') err(`definition.conditions[${i}].ignoreblankvalues must be true or false (true: a blank value never counts as a match)`);
  return null;
}

function validateDupeRuleJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!obj(raw)) return { errors: ['the job file must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be exactly "${CONTRACT}"`);
  if (raw.kind !== 'duperule') err('"kind" must be "duperule"');
  if (typeof raw.env !== 'string' || !has(envs, raw.env)) err(`"env" must be one of: ${Object.keys(envs).join(', ')}`);
  if (raw.mode === 'delete') err('a duplicate rule is never deleted: turn it off with "mode": "off" (undo turns it back on)');
  else if (!MODES.includes(raw.mode)) err(`"mode" must be one of: ${MODES.join(', ')}`);
  const rule = raw.rule;
  if (!obj(rule)) err('"rule" is required: {id, name} for update, off and on; {name, table} for create');
  else if (raw.mode === 'create') {
    for (const k of Object.keys(rule)) if (!['name', 'table'].includes(k)) err(`rule: unknown key "${k}" for a create`);
    if (!oneLine(rule.name, MAX_NAME)) err(`rule.name must be one line, at most ${MAX_NAME} characters`);
    if (typeof rule.table !== 'string' || !IDENT.test(rule.table)) err('rule.table must be the table\'s logical name (singular, lowercase), e.g. "contact"');
  } else if (MODES.includes(raw.mode)) {
    for (const k of Object.keys(rule)) if (!['id', 'name'].includes(k)) err(`rule: unknown key "${k}"`);
    if (typeof rule.id !== 'string' || !GUID.test(rule.id)) err('rule.id must be the rule\'s GUID (duplicaterules.duplicateruleid)');
    if (!oneLine(rule.name, MAX_NAME)) err('rule.name must be the rule\'s current name (one line)');
  }
  const d = raw.definition;
  if (raw.mode === 'off' || raw.mode === 'on') {
    if (d !== undefined) err(`"mode": "${raw.mode}" takes no "definition"`);
  } else if (MODES.includes(raw.mode)) {
    if (!obj(d) || !Object.keys(d).length) err('"definition" is required: what the rule should be (only the keys that change, for an update)');
    else {
      for (const k of Object.keys(d)) if (!DEF_KEYS.has(k)) err(`definition: unknown key "${k}"`);
      if (has(d, 'name') && !oneLine(d.name, MAX_NAME)) err(`definition.name must be one line, at most ${MAX_NAME} characters`);
      if (has(d, 'description') && (typeof d.description !== 'string' || d.description.length > MAX_DESC)) err(`definition.description must be text, at most ${MAX_DESC} characters`);
      for (const k of ['iscasesensitive', 'excludeinactiverecords']) if (has(d, k) && typeof d[k] !== 'boolean') err(`definition.${k} must be true or false`);
      if (raw.mode === 'create' && has(d, 'name')) err('a create names the rule in rule.name, not definition.name');
      if (raw.mode === 'create' && !has(d, 'conditions')) err('a new rule needs definition.conditions');
      if (has(d, 'conditions')) {
        if (!Array.isArray(d.conditions) || !d.conditions.length || d.conditions.length > MAX_CONDITIONS) err(`definition.conditions must list 1 to ${MAX_CONDITIONS} conditions (the WHOLE list: it replaces the rule's conditions)`);
        else {
          d.conditions.forEach((c, i) => validateCondition(c, i, err));
          if (!errors.length) {
            const keys = d.conditions.map((c) => condKey(condOf(c)));
            if (new Set(keys).size !== keys.length) err('definition.conditions lists the same condition twice');
            // The platform allows one condition per column + match type on a rule (measured 11/16/26).
            const pairs = d.conditions.map((c) => `${String(c.attribute).toLowerCase()}|${c.operatorcode}`);
            if (new Set(pairs).size !== pairs.length) err('definition.conditions has two conditions on the same column with the same match type; a rule holds only one');
          }
        }
      }
    }
  }
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required (script path, or "claude-session")');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > 500 || /[\r\n]/.test(raw.reason)) err('"reason" must be one line, at most 500 characters');

  // Intent: what Claude says the job does, checked against the file (the §6b.1 rule). `changed` (update only) is
  // checked against the engine's own diff at plan.
  const intent = raw.intent;
  if (!obj(intent)) err('"intent" is required: {verb, rule, changed (update only)}');
  else if (!errors.length) {
    const mism = [];
    for (const k of Object.keys(intent)) if (!['verb', 'rule', 'changed'].includes(k)) mism.push(`unknown key "${k}"`);
    if (intent.verb !== raw.mode) mism.push(`verb says "${intent.verb}", the file's mode is "${raw.mode}"`);
    if (intent.rule !== rule.name) mism.push(`rule says "${intent.rule}", the file names "${rule.name}"`);
    if (raw.mode === 'update') {
      if (!Array.isArray(intent.changed) || !intent.changed.length || intent.changed.some((x) => !CHANGED.includes(x))) mism.push(`changed must list what changes, from: ${CHANGED.join(', ')}`);
    } else if (has(intent, 'changed')) mism.push(`"changed" is for an update only`);
    if (mism.length) err(`intent does not match the job (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  const job = { contract: CONTRACT, kind: 'duperule', env: raw.env, mode: raw.mode, rule: { ...rule }, source: raw.source.trim(), reason: raw.reason.trim(), intent };
  if (d !== undefined) job.definition = { ...d, ...(d.conditions ? { conditions: d.conditions.map(condOf) } : {}) };
  return { errors: [], job };
}

const CHANGED = ['name', 'description', 'case', 'inactive', 'conditions'];

// ---------- live reads ----------

function readRule(dv, id, { strong = false } = {}) {
  try {
    return dv.get(`${RULE_SET}(${id})?$select=name,description,baseentityname,matchingentityname,iscasesensitive,excludeinactiverecords,statecode,statuscode,ismanaged`, { strong });
  } catch (e) {
    if (e instanceof DataverseError && /0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return null;
    throw e;
  }
}

function readConditions(dv, id) {
  return (dv.get(`${COND_SET}?$select=duplicateruleconditionid,baseattributename,matchingattributename,operatorcode,operatorparam,ignoreblankvalues,ismanaged&$filter=${enc(`_regardingobjectid_value eq ${id}`)}`).value || []);
}

function rulesNamed(dv, name) {
  return (dv.get(`${RULE_SET}?$select=duplicateruleid,name&$filter=${enc(`name eq '${q(name)}'`)}`).value || [])
    .filter((r) => String(r.name).toLowerCase() === String(name).toLowerCase());
}

// The attribute's type from the table's metadata, or null when the table has no such column.
function attributeType(dv, table, attribute) {
  try {
    const r = dv.get(`EntityDefinitions(LogicalName='${q(table)}')/Attributes(LogicalName='${q(attribute)}')?$select=LogicalName,AttributeType`);
    return r && r.AttributeType ? String(r.AttributeType) : null;
  } catch (e) {
    if (e instanceof DataverseError) return null;
    throw e;
  }
}

function tableExists(dv, table) {
  try {
    return Boolean(dv.get(`EntityDefinitions(LogicalName='${q(table)}')?$select=LogicalName`));
  } catch (e) {
    if (e instanceof DataverseError) return false;
    throw e;
  }
}

function conditionProblems(dv, table, conds) {
  const bad = [];
  for (const c of conds) {
    const t = attributeType(dv, table, c.attribute);
    if (!t) { bad.push(`${table} has no column "${c.attribute}"`); continue; }
    const need = OPERATOR_TYPES[c.operatorcode];
    if (need && !need.has(t)) bad.push(`${c.attribute} is a ${t} column; ${OPERATORS[c.operatorcode]} works on ${[...need].join(' or ')} columns only`);
  }
  return bad;
}

// What a plan reads of one existing rule, checked: same-table, unmanaged, conditions it understands.
function liveRule(dv, id, envName) {
  const r = readRule(dv, id);
  if (!r) throw new PlanRefused([`there is no duplicate rule ${id} in the ${envName}`], 'invalid_job');
  if (r.ismanaged) throw new PlanRefused([`'${r.name}' is a managed rule (Microsoft's or a vendor's layer); managed components are never changed`], 'not_permitted');
  if (r.statuscode === 1) throw new PlanRefused([`'${r.name}' is still publishing (rebuilding its match codes); plan again in a few minutes`], 'snapshot_moved');
  if (String(r.baseentityname) !== String(r.matchingentityname)) throw new PlanRefused([`'${r.name}' matches ${r.baseentityname} against ${r.matchingentityname}; this engine changes same-table rules only. Ask Dylan.`], 'invalid_job');
  const raw = readConditions(dv, id);
  if (raw.some((c) => c.ismanaged)) throw new PlanRefused([`'${r.name}' has a managed condition; managed components are never changed`], 'not_permitted');
  if (raw.some((c) => String(c.baseattributename) !== String(c.matchingattributename) || !has(OPERATORS, c.operatorcode))) {
    throw new PlanRefused([`'${r.name}' has a condition this engine does not handle (two different columns, or an unknown match type). Ask Dylan.`], 'invalid_job');
  }
  return { rule: r, conditions: sortConds(raw.map(condOf)), conditionIds: raw.map((c) => String(c.duplicateruleconditionid).toLowerCase()) };
}

// ---------- plan ----------

function title(plan) {
  const n = plan.rule.name;
  if (plan.mode === 'create') return `Create the duplicate rule '${n}' on ${plan.rule.table} in the ${plan.app} (published)`;
  if (plan.mode === 'off') return `Turn off (unpublish) the duplicate rule '${n}' in the ${plan.app}`;
  if (plan.mode === 'on') return `Turn on (publish) the duplicate rule '${n}' in the ${plan.app}`;
  return `Change the duplicate rule '${n}' in the ${plan.app}: ${plan.changed.join(', ')}`;
}

function diff(before, after) {
  const out = [];
  if (before.name !== after.name) out.push('name');
  if ((before.description || '') !== (after.description || '')) out.push('description');
  if (before.iscasesensitive !== after.iscasesensitive) out.push('case');
  if (before.excludeinactiverecords !== after.excludeinactiverecords) out.push('inactive');
  if (!sameConds(before.conditions, after.conditions)) out.push('conditions');
  if (before.published !== after.published) out.push('published'); // only an undo changes it inside an update
  return out;
}

async function planDupeRule(dv, job, ctx) {
  return planCore(dv, job, ctx, {});
}

async function planCore(dv, job, { envs, access, warnRows = severity.DEFAULT_WARN_ROWS }, { revertOf = null, expect = null } = {}) {
  const envInfo = envs[job.env];
  const identity = whoAmI(dv);
  if (!identity.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, job.env), identity.email, job.env);
  if (!atLeast(acc.level, 'admin')) {
    throw new PlanRefused([`changing a duplicate rule takes admin access in the ${envInfo.name} (a rule decides which record an integration matches, and every user's duplicate warning); ${identity.fullname} has ${acc.level}. Ask Dylan.`],
      atLeast(acc.level, 'write') ? 'not_permitted' : 'access_read');
  }

  let before;
  let table;
  let ruleId = null;
  let conditionIds = [];
  if (job.mode === 'create') {
    table = job.rule.table;
    if (!tableExists(dv, table)) throw new PlanRefused([`there is no table "${table}" in the ${envInfo.name}`], 'invalid_job');
    if (rulesNamed(dv, job.rule.name).length) throw new PlanRefused([`a duplicate rule named '${job.rule.name}' already exists in the ${envInfo.name}`], 'invalid_job');
    before = null;
  } else {
    const live = liveRule(dv, job.rule.id, envInfo.name);
    if (String(live.rule.name) !== job.rule.name) throw new PlanRefused([`the job calls rule ${job.rule.id} '${job.rule.name}', but it is named '${live.rule.name}'`], 'invalid_job');
    table = String(live.rule.baseentityname);
    ruleId = job.rule.id.toLowerCase();
    conditionIds = live.conditionIds;
    before = { ...stateOf(live.rule), conditions: live.conditions };
  }

  // A revert runs only while the rule still reads what the apply left (else someone changed it since).
  if (revertOf) {
    const now = before ? JSON.stringify({ ...before, conditions: sortConds(before.conditions) }) : null;
    const left = expect ? JSON.stringify({ ...expect, conditions: sortConds(expect.conditions || []) }) : null;
    if (now !== left) throw new PlanRefused([`the rule has changed since plan ${revertOf} left it, so an undo would overwrite someone's later change. Read it again and decide what it should be.`], 'snapshot_moved');
  }

  let after;
  let changed = [];
  if (job.mode === 'create') {
    const d = job.definition;
    after = { name: job.rule.name, description: d.description || '', iscasesensitive: Boolean(d.iscasesensitive), excludeinactiverecords: d.excludeinactiverecords === undefined ? true : d.excludeinactiverecords, published: true, conditions: sortConds(d.conditions) };
  } else if (job.mode === 'update') {
    const d = job.definition;
    after = {
      name: has(d, 'name') ? d.name : before.name,
      description: has(d, 'description') ? d.description : before.description,
      iscasesensitive: has(d, 'iscasesensitive') ? d.iscasesensitive : before.iscasesensitive,
      excludeinactiverecords: has(d, 'excludeinactiverecords') ? d.excludeinactiverecords : before.excludeinactiverecords,
      published: before.published,
      conditions: has(d, 'conditions') ? sortConds(d.conditions) : before.conditions,
    };
    // An update may also turn a rule back on when it was off (a revert of a create's "off" never comes here).
    if (has(d, '_published')) after.published = d._published;
    changed = diff(before, after);
    if (!changed.length) throw new PlanRefused([`'${before.name}' already reads exactly that (nothing to change)`], 'every_row_refused');
    // An undo names what it actually changes (review F13); a job's own intent must agree with the diff.
    if (revertOf) job = { ...job, intent: { ...job.intent, changed: [...changed] } };
    const said = [...(job.intent.changed || [])].sort();
    if (!revertOf && JSON.stringify(said) !== JSON.stringify([...changed].sort())) {
      throw new PlanRefused([`intent.changed says ${said.join(', ') || 'nothing'}, but the job changes ${changed.join(', ')}`], 'intent_mismatch');
    }
    if (after.name !== before.name && rulesNamed(dv, after.name).some((r) => String(r.duplicateruleid).toLowerCase() !== ruleId)) {
      throw new PlanRefused([`another duplicate rule is already named '${after.name}'`], 'invalid_job');
    }
  } else {
    const want = job.mode === 'on';
    if (before.published === want) throw new PlanRefused([`'${before.name}' is already ${want ? 'published' : 'unpublished'} (nothing to change)`], 'every_row_refused');
    after = { ...before, published: want };
  }
  if (job.mode === 'create' || job.mode === 'update') {
    const bad = conditionProblems(dv, table, after.conditions);
    if (bad.length) throw new PlanRefused(bad, 'invalid_job');
  }

  const lasting = job.mode === 'create' ? [`a new duplicate rule '${job.rule.name}' (undo turns it off)`] : [];
  return {
    contract: CONTRACT, kind: 'duperule', env: job.env, host: envInfo.host, app: envInfo.name, mode: job.mode,
    source: job.source, reason: job.reason, intent: job.intent, identity, access: acc.level, cli_version: dv.cliVersion || null,
    severity: severity.assess({ count: 1, noun: 'duplicate rules', lasting }, { warnRows }), refused: [], need: 'admin',
    rule: { id: ruleId, name: job.rule.name, table }, condition_ids: conditionIds, changed,
    before, after, connector: CONNECTOR_APPS.has(job.env) && ['contact', 'account'].includes(table),
    reverts_plan_id: revertOf || null,
  };
}

// ---------- the pop-up ----------

function stateLines(s) {
  return [
    `    ${s.published ? 'Published' : 'Unpublished (not checking for duplicates)'}; ${s.iscasesensitive ? 'case-sensitive' : 'case-insensitive'}; inactive records ${s.excludeinactiverecords ? 'ignored' : 'included'}`,
    ...s.conditions.map((c) => `    - ${condText(c)}`),
  ];
}

function dupeRuleSummary(plan) {
  const out = [...severity.block(plan.severity), title(plan), ''];
  if (plan.before) out.push('  Now:', ...stateLines(plan.before));
  out.push(`  ${plan.before ? 'After' : 'New rule'}:`, ...stateLines(plan.after));
  if (plan.mode !== 'on' && plan.mode !== 'create' && plan.before && plan.before.published) {
    out.push('', `  While it ${plan.mode === 'off' ? 'is off' : 'is unpublished and republishing (minutes on a large table)'}, nobody gets this rule's duplicate warning${plan.connector ? ' and the Fundraise Up connector does not match donors on it' : ''}.`);
  }
  if (plan.connector) out.push('', '  The Fundraise Up connector matches donors through this app\'s published contact and account rules and takes the first record returned.');
  out.push('', plan.mode === 'create' ? '  Undo turns it off (unpublishes it); a rule is never deleted.' : '  Can be undone with revert (puts back what it reads now).', '', `Reason given: ${plan.reason}`);
  return out.join('\n');
}

function dupeRuleDetail(plan, { id } = {}) {
  const out = [...severity.block(plan.severity), title(plan), '', `Requested by: ${plan.identity.fullname} (${plan.identity.email})`, `Reason given: ${plan.reason}`, `Made by: ${plan.source}`];
  if (id) out.push(`Plan: ${id}`);
  if (plan.reverts_plan_id) out.push(`Undoes plan: ${plan.reverts_plan_id}`);
  out.push(`Rule: ${plan.rule.id || '(new)'} on ${plan.rule.table}`, `Access needed: admin; ${plan.identity.fullname} has ${plan.access}`);
  if (plan.before) {
    out.push('', `Before: name '${plan.before.name}', description "${plan.before.description}"`, ...stateLines(plan.before));
    if (plan.condition_ids.length) out.push(`  condition rows replaced: ${plan.condition_ids.join(', ')}`);
  }
  out.push('', `After: name '${plan.after.name}', description "${plan.after.description}"`, ...stateLines(plan.after));
  return out.join('\n');
}

// ---------- apply ----------

function planShapeProblems(plan) {
  const bad = [];
  if (!plan || !MODES.includes(plan.mode)) bad.push(`the mode "${plan && plan.mode}"`);
  const r = plan && plan.rule;
  if (!obj(r)) return [...bad, 'no rule'];
  if (plan.mode === 'create' ? r.id !== null : (typeof r.id !== 'string' || !GUID.test(r.id))) bad.push('a rule id that does not fit the mode');
  if (typeof r.table !== 'string' || !IDENT.test(r.table)) bad.push('a table that is not a logical name');
  const a = plan.after;
  if (!obj(a) || !oneLine(a.name, MAX_NAME) || typeof a.description !== 'string' || a.description.length > MAX_DESC
    || typeof a.iscasesensitive !== 'boolean' || typeof a.excludeinactiverecords !== 'boolean' || typeof a.published !== 'boolean'
    || !Array.isArray(a.conditions) || !a.conditions.length || a.conditions.length > MAX_CONDITIONS) bad.push('an after-state that is not a rule');
  else {
    for (const c of a.conditions) {
      const errs = [];
      validateCondition(c, 0, (m) => errs.push(m));
      if (errs.length) { bad.push('a condition that is not valid'); break; }
    }
  }
  if (plan.mode !== 'create' && !obj(plan.before)) bad.push('no before-state');
  if (!Array.isArray(plan.condition_ids) || plan.condition_ids.some((x) => typeof x !== 'string' || !GUID.test(x))) bad.push('condition rows that are not GUIDs');
  return bad;
}

// Waits for the rule's statuscode to reach `want` (0 or 2); returns the last read, or null when it never came.
function waitFor(dv, id, want, ceiling, sleep) {
  let r = readRule(dv, id, { strong: true });
  for (let waited = 0; r && r.statuscode !== want && waited < ceiling; waited += POLL_MS) {
    sleep(POLL_MS);
    r = readRule(dv, id, { strong: true });
  }
  return r;
}

function readState(dv, id) {
  const r = readRule(dv, id, { strong: true });
  if (!r) return null;
  return { ...stateOf(r), status: STATUS[r.statuscode] || `status ${r.statuscode}`, conditions: sortConds(readConditions(dv, id).map(condOf)) };
}

const sameState = (a, b) => Boolean(a && b) && a.name === b.name && (a.description || '') === (b.description || '')
  && a.iscasesensitive === b.iscasesensitive && a.excludeinactiverecords === b.excludeinactiverecords && a.published === b.published && sameConds(a.conditions, b.conditions);

async function applyDupeRule(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date(), sleep = defaultSleep } = deps;
  // A missing or unreadable `created` is refused, not read as fresh (review F8: NaN > MAX_AGE_MS is false).
  const age = now - new Date(plan && plan.created);
  if (!Number.isFinite(age) || age > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old, or says nothing about when it was made. Make a new plan.', 'stale_plan');
  const shapeBad = planShapeProblems(plan);
  if (shapeBad.length) throw new ApplyRefused(`this plan file asks to write ${shapeBad.join(', ')}, which no duplicate-rule plan writes. It was changed after it was made; make a new plan. Nothing was written.`, 'plan_tampered');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  if (!atLeast(acc.level, 'admin')) throw new ApplyRefused(`changing a duplicate rule takes admin access; you have ${acc.level}. Nothing was written.`, 'access_revoked');

  // What the plan read must still be true. MEASURED LIVE 11/16/26 (Donor App Dev, probe_dupecond_etag.js): neither
  // duplicaterules nor duplicateruleconditions carries a version (no @odata.etag, no versionnumber column), so Dataverse
  // cannot protect these writes and they go with If-Match * (review F3's tag-only rule refused every update live). The
  // protection is this check instead: the rule's settings, every condition's values AND the condition row ids, read
  // before the prompt and again after it; any difference stops the apply before a write (review F4). What remains is
  // the seconds between the second read and the writes (accepted residual, Dylan 11/16/26).
  let ruleId = plan.rule.id;
  let oldRows = []; // the rule's condition rows as read at the check: {id, attribute, operatorcode, operatorparam, ignoreblankvalues}
  const check = () => {
    if (plan.mode === 'create') {
      if (rulesNamed(dv, plan.rule.name).length) throw new ApplyRefused(`a duplicate rule named '${plan.rule.name}' exists now. Nothing was written; make a new plan.`, 'snapshot_moved');
      return '';
    }
    const live = readRule(dv, ruleId, { strong: true });
    if (!live || live.ismanaged) throw new ApplyRefused(`'${plan.rule.name}' is gone or now managed. Nothing was written.`, 'snapshot_moved');
    if (live.statuscode === 1) throw new ApplyRefused(`'${plan.rule.name}' is still publishing. Nothing was written; apply again in a few minutes.`, 'snapshot_moved');
    const raw = readConditions(dv, ruleId);
    const nowState = { ...stateOf(live), conditions: sortConds(raw.map(condOf)) };
    if (!sameState(nowState, plan.before)) throw new ApplyRefused(`'${plan.rule.name}' has changed since the plan. Nothing was written; make a new plan.`, 'snapshot_moved');
    const ids = raw.map((c) => String(c.duplicateruleconditionid).toLowerCase()).sort();
    if (JSON.stringify(ids) !== JSON.stringify([...plan.condition_ids].sort())) throw new ApplyRefused(`'${plan.rule.name}''s conditions were replaced since the plan. Nothing was written; make a new plan.`, 'snapshot_moved');
    oldRows = raw.map((c) => ({ id: String(c.duplicateruleconditionid).toLowerCase(), ...condOf(c) })).sort((x, y) => x.id.localeCompare(y.id));
    return JSON.stringify({ state: nowState, rows: oldRows });
  };
  const checked = check();

  // The connector warning is worked out again here from the app and the table, never taken from the plan file (F7).
  const view = { ...plan, connector: CONNECTOR_APPS.has(plan.env) && ['contact', 'account'].includes(plan.rule.table) };
  const answer = confirm({ summaryText: dupeRuleSummary(view), detailText: dupeRuleDetail(view, { id }), title: `SBRM: approve this duplicate rule change in the ${plan.app}?` });
  const base = {
    time: now.toISOString(), plan_id: id, person: me, env: plan.env, app: plan.app, table: RULE_SET, mode: 'duperule', action: plan.mode,
    rule: plan.rule, source: plan.source, reason: plan.reason, approval: 'prompt', left_out: [], headline: title(plan), reverts_plan_id: plan.reverts_plan_id || null,
  };
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };
  // A change while the prompt was open (another admin) stops the apply before anything is written (F4).
  let again;
  try { again = check(); } catch (e) { if (e instanceof ApplyRefused && e.code === 'snapshot_moved') again = null; else throw e; }
  if (again !== checked) {
    throw new ApplyRefused(`'${plan.rule.name}' was changed while the approval was open. Nothing was written; make a new plan.`, 'snapshot_moved');
  }

  // The condition row ids go in the log: the ones removed, made and changed in place (F9).
  const row = { name: plan.rule.name, id: ruleId, action: plan.mode, before: plan.before, after: null, steps: [], conditions_removed: [], conditions_added: [], conditions_changed: [] };
  const step = (s) => row.steps.push(s);
  const b = plan.before;
  const a = plan.after;
  try {
    if (plan.mode === 'create') {
      const made = dv.create(RULE_SET, { name: a.name, description: a.description, baseentityname: plan.rule.table, matchingentityname: plan.rule.table, iscasesensitive: a.iscasesensitive, excludeinactiverecords: a.excludeinactiverecords });
      ruleId = String((made && made.duplicateruleid) || '').toLowerCase();
      if (!GUID.test(ruleId)) throw new Error('the new rule came back with no id');
      row.id = ruleId;
      step('created the rule');
    } else if (b.published) {
      dv.unpublishDuplicateRule(ruleId);
      step('unpublish sent');
      const r = waitFor(dv, ruleId, 0, UNPUBLISH_CEILING_MS, sleep);
      // The unpublish is an async job that may still land after the wait (F1): never say "nothing changed".
      if (!r || r.statuscode !== 0) throw new Error(`the rule did not read unpublished within ${UNPUBLISH_CEILING_MS / 60000} min (status ${r ? r.statuscode : 'gone'}). Its conditions and settings were NOT changed, but the unpublish job may still land and turn it off: read it again, and if it reads unpublished, turn it back on with mode "on"`);
      step('unpublished');
    }
    if (plan.mode === 'update') {
      const patch = {};
      if (a.name !== b.name) patch.name = a.name;
      if ((a.description || '') !== (b.description || '')) patch.description = a.description;
      if (a.iscasesensitive !== b.iscasesensitive) patch.iscasesensitive = a.iscasesensitive;
      if (a.excludeinactiverecords !== b.excludeinactiverecords) patch.excludeinactiverecords = a.excludeinactiverecords;
      if (Object.keys(patch).length) {
        dv.update(RULE_SET, ruleId, patch, '*'); // no version on duplicaterules (measured 11/16); see the check above
        step(`changed ${Object.keys(patch).join(', ')}`);
      }
    }
    // MEASURED LIVE 11/16/26 (Donor App Dev, plan 20261116-152306-14fbe523): a rule holds at most ONE condition per
    // column + match type ("violates a database constraint ... uniquerulename, operatorcode, matchingattributename,
    // baseattributename ... use update"). So a wanted condition whose column and match type the rule already has CHANGES
    // that row in place; only a new column + match type is added; then the rows no longer wanted are removed. Changes
    // and adds come FIRST (advisor review 11/16): a failure part-way never leaves a rule with fewer conditions.
    if (plan.mode === 'create' || (plan.mode === 'update' && !sameConds(a.conditions, b.conditions))) {
      const kept = new Set();
      for (const c of a.conditions) {
        const same = oldRows.find((o) => o.attribute === c.attribute && o.operatorcode === c.operatorcode && !kept.has(o.id));
        if (same) {
          kept.add(same.id);
          if (same.operatorparam !== c.operatorparam || same.ignoreblankvalues !== c.ignoreblankvalues) {
            const body = { ignoreblankvalues: c.ignoreblankvalues };
            if (c.operatorparam !== null) body.operatorparam = c.operatorparam;
            dv.update(COND_SET, same.id, body, '*'); // no version on a condition (measured 11/16)
            row.conditions_changed.push(same.id);
          }
          continue;
        }
        const body = { baseattributename: c.attribute, matchingattributename: c.attribute, operatorcode: c.operatorcode, ignoreblankvalues: c.ignoreblankvalues, 'regardingobjectid@odata.bind': `/${RULE_SET}(${ruleId})` };
        if (c.operatorparam !== null) body.operatorparam = c.operatorparam;
        const made = dv.create(COND_SET, body);
        row.conditions_added.push(String((made && made.duplicateruleconditionid) || '').toLowerCase() || null);
      }
      if (row.conditions_changed.length) step(`changed ${row.conditions_changed.length} condition(s) in place`);
      if (row.conditions_added.length) step(`added ${row.conditions_added.length} condition(s)`);
      // The rows no longer wanted, by the ids both checks confirmed (no version exists to send; see the check).
      for (const o of oldRows.filter((x) => !kept.has(x.id))) {
        dv.remove(COND_SET, o.id, '*');
        row.conditions_removed.push(o.id);
      }
      if (row.conditions_removed.length) step(`removed ${row.conditions_removed.length} condition(s)`);
    }
    if (a.published) {
      dv.publishDuplicateRule(ruleId);
      const r = waitFor(dv, ruleId, 2, PUBLISH_CEILING_MS, sleep);
      step(r && r.statuscode === 2 ? 'published' : `publish sent; still ${r ? STATUS[r.statuscode] || r.statuscode : 'unreadable'} after ${PUBLISH_CEILING_MS / 60000} min (the platform finishes it)`);
    }
  } catch (e) {
    row.outcome = `failed: ${e.message}`;
  }
  try { row.after = readState(dv, ruleId); } catch { row.after = null; }
  if (!row.outcome) {
    const got = row.after;
    if (sameState(got, a)) row.outcome = got.status === 'publishing' ? 'written; still publishing (the platform finishes it)' : 'written';
    else row.outcome = 'read-back mismatch: the rule does not read what was written';
  }
  // The UNPUBLISHED warning also when the read-back itself failed after an unpublish (F5): the steps say what was sent.
  if (!/^written/.test(row.outcome) && b && b.published) {
    if (row.after && !row.after.published) row.outcome += '. The rule is UNPUBLISHED now: nobody gets its duplicate warning until it is fixed (revert puts the before back)';
    else if (!row.after && row.steps.includes('unpublished')) row.outcome += '. The rule was UNPUBLISHED and could not be read back: read it, then turn it back on with mode "on" (revert needs a read-back)';
  }
  fs.rmSync(file, { force: true });
  const ok = /^written/.test(row.outcome);
  const outcome = ok ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows: [row] }, outcome, person: me, dv, written: ok ? 1 : 0, rows: [row], left_out: [] };
}

// ---------- revert ----------
//
// Puts the logged before back, only while the rule still reads what the apply left (row.after). A create is undone
// by turning the rule off. A log entry is data: a forged or damaged one is refused.

async function planDupeRuleRevert(dv, entry, ctx) {
  if (!entry || entry.mode !== 'duperule') throw new PlanRefused(['that plan is not a duplicate rule change'], 'nothing_to_undo');
  if (!['applied', 'applied with problems'].includes(entry.outcome)) throw new PlanRefused([`that change's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  const row = (entry.rows || [])[0];
  if (!row || !obj(row.after) || typeof row.id !== 'string' || !GUID.test(row.id)) throw new PlanRefused([`that change did not leave a rule to undo (${row ? row.outcome : 'no row'})`], 'nothing_to_undo');
  const envs = (ctx && ctx.envs) || {};
  if (typeof entry.env !== 'string' || !has(envs, entry.env)) throw new PlanRefused([`that log entry names an environment the toolkit does not know ("${entry.env}")`], 'invalid_job');
  if (dv.host && String(dv.host).toLowerCase() !== String(envs[entry.env].host).toLowerCase()) {
    throw new PlanRefused([`that change was made in the ${envs[entry.env].name}; this revert was planned against another environment. Revert it in the ${envs[entry.env].name}.`], 'invalid_job');
  }
  const left = row.after;
  if (!oneLine(left.name, MAX_NAME) || !Array.isArray(left.conditions)) throw new PlanRefused(['that log entry has no readable after-state'], 'invalid_job');
  const reason = `Undo plan ${entry.plan_id} ("${entry.headline}", by ${entry.person ? entry.person.fullname : 'unknown'}).`.replace(/[\r\n]+/g, ' ').slice(0, 500);
  const common = { contract: CONTRACT, kind: 'duperule', env: entry.env, source: `revert ${entry.plan_id}`, reason };
  const rule = { id: row.id, name: left.name };
  let job;
  if (entry.action === 'create' || (entry.action === 'on' && left.published)) {
    job = { ...common, mode: 'off', rule, intent: { verb: 'off', rule: left.name } };
  } else if (entry.action === 'off') {
    job = { ...common, mode: 'on', rule, intent: { verb: 'on', rule: left.name } };
  } else {
    const prev = row.before;
    if (!obj(prev) || !Array.isArray(prev.conditions) || !oneLine(prev.name, MAX_NAME)) throw new PlanRefused(['the log does not say what the rule was before'], 'nothing_to_undo');
    const definition = { name: prev.name, description: prev.description || '', iscasesensitive: Boolean(prev.iscasesensitive), excludeinactiverecords: Boolean(prev.excludeinactiverecords), conditions: prev.conditions.map(condOf), _published: Boolean(prev.published) };
    job = { ...common, mode: 'update', rule, definition, intent: { verb: 'update', rule: left.name, changed: ['conditions'] } };
  }
  return planCore(dv, job, ctx, { revertOf: entry.plan_id, expect: { name: left.name, description: left.description || '', iscasesensitive: Boolean(left.iscasesensitive), excludeinactiverecords: Boolean(left.excludeinactiverecords), published: Boolean(left.published), conditions: left.conditions.map(condOf) } });
}

module.exports = {
  validateDupeRuleJob, planDupeRule, dupeRuleSummary, dupeRuleDetail, applyDupeRule, planDupeRuleRevert,
  planShapeProblems, condOf, condText, OPERATORS, POLL_MS, UNPUBLISH_CEILING_MS, PUBLISH_CEILING_MS,
};
