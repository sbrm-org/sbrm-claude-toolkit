'use strict';
// App development, kind "schema" (DESIGN.md §10b, §10c, §10e; rulings §10j and §10k, 10/7/26): tables,
// columns, relationships, alternate keys and choice options, in a named SBRM solution. Replaces the Python
// StepJob path (the earlier Python write path + the earlier Python schema builder + schema\the earlier table builder) for
// everyone, Dylan included, with the one approval path (§6f).
//
// The job says what each OBJECT should be; the engine computes the steps, the checks and the pop-up from
// live reads (the §8b principle: show only effects the engine can compute). A job never carries raw HTTP.
//
//   plan    READS ONLY. Lists only what is missing or differs, so a re-plan of an applied job plans nothing
//           and a stopped apply is finished by approving the same job again (the earlier table builder's resumability).
//   apply   re-checks everything the plan read (any move refuses the whole apply: the step order was
//           worked out against it), shows the pop-up (deletes need their name typed, ruled 10/7), runs the
//           steps in dependency order, STOPS at the first failure (the earlier Python write path), publishes
//           only the touched components, reads every written object back with one 45 s retry.
//   revert  settings changes go back by PUT of the logged definition; creates stay (only an admin delete
//           removes them); a delete is refused (the definition before is in the log, not rebuildable here).
//
// Levels (ruled 10/7, the build brief): develop = create and update of every object here. Admin only:
// every delete, alternate keys, raising a column's required level on a table with blank rows, and (Claude's
// reading, 10/7 build) any change to the toolkit's own tables. Refused for everyone: managed components, a
// solution that is managed or not under the environment's SBRM publisher, type changes, max length down.

const { whoAmI, accessFor, PlanRefused } = require('./resolve');
const { GUID } = require('./contract');
const { resolveAccess } = require('./access');
const { ApplyRefused } = require('./apply');
const { DataverseError } = require('./cli');
const { atLeast } = require('./levels');
const severity = require('./severity');
const { unprovenPhrase, parseEntry } = require('./proven');
const { entryText } = require('./log');

const CONTRACT = 'sbrm-dv-job/1';
const MAX_ENTRY = 1000000; // characters of the logged entry text; sbrm_entry holds 1,048,576 (DESIGN.md §10e). Over it the plan refuses (§8f).
const MAX_AGE_MS = 24 * 3600 * 1000;
// Every free-text field apply writes into a log row is capped at these lengths, and the plan's size check
// pads to the same caps, so a plan that passes the check cannot overflow the row however its steps end
// (10/7 blind re-verify: a failed step's outcome reached ~408 characters, the check assumed 120).
const OUTCOME_MAX = 600;
const NOTE_MAX = 600;
const capText = (t, n) => (String(t).length > n ? `${String(t).slice(0, n - 3)}...` : String(t));
// A new table is not ready for columns for ~90 s (a live finding 10/6, recovery). The engine waits for it
// itself (§10e), so one approval covers the whole build instead of the earlier table builder's two runs.
const PROVISION_POLL_MS = 10000;
const PROVISION_CEILING_MS = 5 * 60 * 1000;
// Metadata reads lag a publish by seconds (10/6: a correct lookup read back "Targets: None"); a miss gets
// one more read this long after (the earlier Python write path check_retry_seconds = 45).
const READBACK_RETRY_MS = 45000;
// Any other request that times out client side is re-read for this long before it is called "unknown"
// (a live finding 10/7: the CLI gives up at 100 s while Dataverse finishes the work).
const TIMEOUT_RECHECK_MS = 2 * 60 * 1000;
// One run starts no new step after this long (10/7 re-verify: apply may now run in the background, so
// nothing kills it at 10 minutes). What landed is logged; the job is resumable, so "run it again" finishes.
const RUN_LIMIT_MS = 25 * 60 * 1000;

// The toolkit's own tables (who may write, the Write Log, the events): their rows are admin-only (§9), so
// their DEFINITIONS are too. Without this a developer could turn the Write Log's auditing off or make a
// log column required and break every apply. Claude's reading of "admin runs the toolkit", 10/7 build.
const TOOLKIT_TABLES = new Set(['sbrm_dataversewritelog', 'sbrm_dataverseevent', 'sbrm_dataversewriteaccess']);

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- body builders (ported from the earlier Python schema builder, case for case) ----------
//
// Conventions baked in there, each a silent failure otherwise (the Python builder docstring, 10/6):
//   - every schema name carries the sbrm_ prefix (the SBRM publisher's);
//   - date-only columns set Format AND DateTimeBehavior=DateOnly (the 8/12 FairShare portal trap; one-way);
//   - choice values are EXPLICIT, from the publisher's option value prefix upward (prefix * 10000: 33830 ->
//     338300000 in HGS and Sober Living; the Donor App's SBRM publisher is 10000 -> 100000000, read live
//     10/7 re-verify), so a backfill can map to them and they never depend on portal order;
//   - lookups REMOVE THE LINK on delete; nothing cascades a delete.
// Added in the port (10/7): decimal, money, date and time, multi-select choice, a column on a global choice,
// many-to-many relationships.

const LANG = 1033;
// The Python builder's default series (prefix 33830). The ENGINE never assumes it: plan reads the prefix
// of the environment's SBRM publisher and passes optionBase = prefix * 10000 to the builders.
const OPTION_BASE = 338300000;
const OPTION_SPAN = 10000; // one publisher's series: base to base + 9999
const PREFIX = 'sbrm_';

function label(text) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.Label',
    LocalizedLabels: [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: LANG }],
  };
}

function logical(schemaName) {
  return String(schemaName).toLowerCase();
}

function checkPrefix(schemaName) {
  if (!String(schemaName).toLowerCase().startsWith(PREFIX)) throw new Error(`schema name "${schemaName}" must start with ${PREFIX}`);
}

function req(required) {
  return { Value: required ? 'ApplicationRequired' : 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' };
}

function base(odataType, schemaName, display, description, required) {
  checkPrefix(schemaName);
  return {
    '@odata.type': `Microsoft.Dynamics.CRM.${odataType}`,
    SchemaName: schemaName, DisplayName: label(display),
    Description: label(description || display), RequiredLevel: req(required),
  };
}

function textCol(schemaName, display, { maxLength = 100, required = false, description = null } = {}) {
  return { ...base('StringAttributeMetadata', schemaName, display, description, required), MaxLength: maxLength, FormatName: { Value: 'Text' } };
}

function memo(schemaName, display, { maxLength = 10000, required = false, description = null } = {}) {
  return { ...base('MemoAttributeMetadata', schemaName, display, description, required), Format: 'TextArea', MaxLength: maxLength };
}

function wholeNumber(schemaName, display, { minValue = 0, maxValue = 2147483647, required = false, description = null } = {}) {
  return { ...base('IntegerAttributeMetadata', schemaName, display, description, required), Format: 'None', MinValue: minValue, MaxValue: maxValue };
}

// Decimal: Dataverse's bounds are +/- 100,000,000,000 and 0-10 places.
function decimal(schemaName, display, { precision = 2, minValue = -100000000000, maxValue = 100000000000, required = false, description = null } = {}) {
  return { ...base('DecimalAttributeMetadata', schemaName, display, description, required), Precision: precision, MinValue: minValue, MaxValue: maxValue };
}

// Money: with no precision given it follows the currency's precision (PrecisionSource 2), as the maker
// portal does. The first money column on a table makes Dataverse add Currency + Exchange Rate itself.
function money(schemaName, display, { precision = null, minValue = -922337203685477, maxValue = 922337203685477, required = false, description = null } = {}) {
  const b = { ...base('MoneyAttributeMetadata', schemaName, display, description, required), MinValue: minValue, MaxValue: maxValue };
  if (precision === null || precision === undefined) b.PrecisionSource = 2;
  else Object.assign(b, { PrecisionSource: 0, Precision: precision });
  return b;
}

function yesNo(schemaName, display, { defaultValue = false, required = false, description = null } = {}) {
  return {
    ...base('BooleanAttributeMetadata', schemaName, display, description, required),
    DefaultValue: Boolean(defaultValue),
    OptionSet: {
      '@odata.type': 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata',
      TrueOption: { Value: 1, Label: label('Yes') },
      FalseOption: { Value: 0, Label: label('No') },
    },
  };
}

// A format with no {SEQNUM:n} would give every row the same value, so it is refused (the Python builder 10/7).
function autonumber(schemaName, display, fmt, { maxLength = 40, required = false, description = null } = {}) {
  if (!String(fmt).includes('{SEQNUM:')) throw new Error(`autonumber format "${fmt}" has no {SEQNUM:n}`);
  return { ...textCol(schemaName, display, { maxLength, required, description }), AutoNumberFormat: fmt };
}

// Dataverse builds the index ASYNC: EntityKeyIndexStatus goes Pending -> Active (or Failed).
function alternateKey(schemaName, display, columns) {
  checkPrefix(schemaName);
  return { '@odata.type': 'Microsoft.Dynamics.CRM.EntityKeyMetadata', SchemaName: schemaName, DisplayName: label(display), KeyAttributes: [...columns] };
}

function dateOnly(schemaName, display, { required = false, description = null } = {}) {
  return { ...base('DateTimeAttributeMetadata', schemaName, display, description, required), Format: 'DateOnly', DateTimeBehavior: { Value: 'DateOnly' } };
}

function dateTime(schemaName, display, { required = false, description = null } = {}) {
  return { ...base('DateTimeAttributeMetadata', schemaName, display, description, required), Format: 'DateAndTime', DateTimeBehavior: { Value: 'UserLocal' } };
}

function localOptionSet(options, optionBase = OPTION_BASE) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata', IsGlobal: false, OptionSetType: 'Picklist',
    Options: options.map((o, i) => ({ Value: optionBase + i, Label: label(o) })),
  };
}

function choice(schemaName, display, options, { required = false, description = null, optionBase = OPTION_BASE } = {}) {
  return { ...base('PicklistAttributeMetadata', schemaName, display, description, required), OptionSet: localOptionSet(options, optionBase) };
}

function multiChoice(schemaName, display, options, { required = false, description = null, optionBase = OPTION_BASE } = {}) {
  return { ...base('MultiSelectPicklistAttributeMetadata', schemaName, display, description, required), OptionSet: localOptionSet(options, optionBase) };
}

// A column on an EXISTING global choice, bound by the set's MetadataId (read at plan).
function globalChoice(schemaName, display, globalId, { multi = false, required = false, description = null } = {}) {
  const t = multi ? 'MultiSelectPicklistAttributeMetadata' : 'PicklistAttributeMetadata';
  return { ...base(t, schemaName, display, description, required), 'GlobalOptionSet@odata.bind': `/GlobalOptionSetDefinitions(${globalId})` };
}

// {label: value} exactly as `choice` assigns them, for backfill mapping.
function optionValues(options, optionBase = OPTION_BASE) {
  return Object.fromEntries(options.map((o, i) => [o, optionBase + i]));
}

function table(schemaName, display, plural, description, primary, { quickCreate = true, changeTracking = true, audit = true } = {}) {
  checkPrefix(schemaName);
  const p = textCol(primary.schema_name, primary.display, { maxLength: primary.max_length || 100, required: true });
  p.IsPrimaryName = true;
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
    SchemaName: schemaName, DisplayName: label(display), DisplayCollectionName: label(plural), Description: label(description),
    OwnershipType: 'UserOwned', IsActivity: false, HasActivities: false, HasNotes: false,
    IsQuickCreateEnabled: quickCreate, ChangeTrackingEnabled: changeTracking,
    IsAuditEnabled: { Value: audit, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyauditsettings' },
    Attributes: [p],
  };
}

function menu(text) {
  return text ? { Behavior: 'UseLabel', Group: 'Details', Label: label(text), Order: 10000 } : { Behavior: 'DoNotDisplay' };
}

// The relationship's own schema name for a lookup, as the Python builder names it.
function lookupRelName(schemaName, referenced, referencing) {
  return `${PREFIX}${referenced}_${referencing}_${String(schemaName).slice(PREFIX.length)}`;
}

// N:1 lookup on `referencing` -> `referenced`. showOnParent = the label of the related list on the parent's
// form; null hides it (a user record should not grow an Interviews menu).
function lookup(schemaName, display, referenced, referencedKey, referencing, { required = false, showOnParent = null, description = null } = {}) {
  checkPrefix(schemaName);
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
    SchemaName: lookupRelName(schemaName, referenced, referencing),
    ReferencedEntity: referenced, ReferencedAttribute: referencedKey, ReferencingEntity: referencing,
    CascadeConfiguration: { Assign: 'NoCascade', Delete: 'RemoveLink', Merge: 'NoCascade', Reparent: 'NoCascade', Share: 'NoCascade', Unshare: 'NoCascade', RollupView: 'NoCascade' },
    AssociatedMenuConfiguration: menu(showOnParent),
    Lookup: base('LookupAttributeMetadata', schemaName, display, description, required),
  };
}

function manyToMany(schemaName, entity1, entity2, { menu1 = null, menu2 = null } = {}) {
  checkPrefix(schemaName);
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata',
    SchemaName: schemaName, IntersectEntityName: logical(schemaName),
    Entity1LogicalName: entity1, Entity2LogicalName: entity2,
    Entity1AssociatedMenuConfiguration: menu(menu1), Entity2AssociatedMenuConfiguration: menu(menu2),
  };
}

// The body for one validated column spec. `globalId` = the global choice's MetadataId when it names one.
function columnBody(c, { globalId = null, optionBase = OPTION_BASE } = {}) {
  const o = { required: c.required, description: c.description };
  switch (c.type) {
    case 'text': return textCol(c.schema_name, c.display, { ...o, maxLength: c.max_length });
    case 'memo': return memo(c.schema_name, c.display, { ...o, maxLength: c.max_length });
    case 'whole_number': return wholeNumber(c.schema_name, c.display, { ...o, minValue: c.min_value, maxValue: c.max_value });
    case 'decimal': return decimal(c.schema_name, c.display, { ...o, precision: c.precision, minValue: c.min_value, maxValue: c.max_value });
    case 'money': return money(c.schema_name, c.display, { ...o, precision: c.precision, minValue: c.min_value, maxValue: c.max_value });
    case 'yes_no': return yesNo(c.schema_name, c.display, { ...o, defaultValue: c.default });
    case 'date': return dateOnly(c.schema_name, c.display, o);
    case 'datetime': return dateTime(c.schema_name, c.display, o);
    case 'choice':
    case 'multi_choice':
      if (c.global_choice) return globalChoice(c.schema_name, c.display, globalId, { ...o, multi: c.type === 'multi_choice' });
      return (c.type === 'choice' ? choice : multiChoice)(c.schema_name, c.display, c.options, { ...o, optionBase });
    case 'autonumber': return autonumber(c.schema_name, c.display, c.format, { ...o, maxLength: c.max_length });
    default: throw new Error(`no body builder for column type ${c.type}`);
  }
}

// ---------- the job file (pure) ----------

const KINDS = ['tables', 'columns', 'relationships', 'keys', 'options'];
const TOP_KEYS = new Set(['contract', 'kind', 'env', 'solution', 'source', 'reason', 'intent', 'objects', 'proven_in']);
const IDENT = /^[a-z_][a-z0-9_]*$/;
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOLUTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/; // write.js refuses anything else in the header
const PLAN_ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

// Column type -> what Dataverse calls it (AttributeType, plus AttributeTypeName for a multi-select).
const COLUMN_TYPES = {
  text: 'String', memo: 'Memo', whole_number: 'Integer', decimal: 'Decimal', money: 'Money', yes_no: 'Boolean',
  date: 'DateTime', datetime: 'DateTime', choice: 'Picklist', multi_choice: 'Virtual', autonumber: 'String',
};
const COLUMN_EXTRA = {
  text: ['max_length'], memo: ['max_length'], whole_number: ['min_value', 'max_value'], decimal: ['precision', 'min_value', 'max_value'],
  money: ['precision', 'min_value', 'max_value'], yes_no: ['default'], date: [], datetime: [], choice: ['options', 'global_choice'],
  multi_choice: ['options', 'global_choice'], autonumber: ['format', 'max_length'],
};
const LIMITS = {
  text: { max_length: [1, 4000, 100] }, memo: { max_length: [1, 1048576, 10000] }, autonumber: { max_length: [1, 4000, 40] },
  whole_number: { min_value: [-2147483648, 2147483647, 0], max_value: [-2147483648, 2147483647, 2147483647] },
  decimal: { precision: [0, 10, 2], min_value: [-100000000000, 100000000000, -100000000000], max_value: [-100000000000, 100000000000, 100000000000] },
  money: { precision: [0, 4, null], min_value: [-922337203685477, 922337203685477, -922337203685477], max_value: [-922337203685477, 922337203685477, 922337203685477] },
};

// Per object kind and action: the keys a job may use. Anything else is refused, never ignored.
const SHAPES = {
  tables: {
    create: ['action', 'schema_name', 'display', 'plural', 'description', 'primary', 'audit', 'change_tracking', 'quick_create'],
    update: ['action', 'table', 'set'],
    delete: ['action', 'table'],
  },
  columns: {
    create: ['action', 'table', 'type', 'schema_name', 'display', 'description', 'required', 'max_length', 'min_value', 'max_value', 'precision', 'default', 'options', 'global_choice', 'format'],
    update: ['action', 'table', 'column', 'set'],
    delete: ['action', 'table', 'column'],
  },
  relationships: {
    create: ['action', 'type', 'schema_name', 'display', 'description', 'required', 'referenced', 'referencing', 'show_on_parent', 'entity1', 'entity2', 'menu1', 'menu2'],
    delete: ['action', 'schema_name'],
  },
  keys: {
    create: ['action', 'table', 'schema_name', 'display', 'columns'],
    delete: ['action', 'table', 'key'],
  },
  options: {
    create: ['action', 'target', 'label', 'value'],
    update: ['action', 'target', 'value', 'label'],
    reorder: ['action', 'target', 'order'],
    delete: ['action', 'target', 'value'],
  },
};
const TABLE_SET = { display: 'DisplayName', plural: 'DisplayCollectionName', description: 'Description', audit: 'IsAuditEnabled', change_tracking: 'ChangeTrackingEnabled', quick_create: 'IsQuickCreateEnabled' };
const COLUMN_SET = { display: 'DisplayName', description: 'Description', required: 'RequiredLevel', max_length: 'MaxLength' };
const FIELD_LABEL = {
  DisplayName: 'Label', DisplayCollectionName: 'Plural label', Description: 'Description', IsAuditEnabled: 'Auditing',
  ChangeTrackingEnabled: 'Change tracking', IsQuickCreateEnabled: 'Quick create', RequiredLevel: 'Required', MaxLength: 'Max length',
};
const SINGULAR = { tables: 'table', columns: 'column', relationships: 'relationship', keys: 'key', options: 'option' };

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateSchemaJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(raw)) return { errors: ['the job file must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be exactly "${CONTRACT}"`);
  if (raw.kind !== 'schema') err('"kind" must be "schema"');
  if (typeof raw.env !== 'string' || !Object.prototype.hasOwnProperty.call(envs, raw.env)) err(`"env" must be one of: ${Object.keys(envs).join(', ')}`);
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required (script path, or "claude-session")');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > 500 || /[\r\n]/.test(raw.reason)) err('"reason" must be one line, at most 500 characters');
  const sol = raw.solution;
  if (!isObj(sol)) err('"solution" is required: {uniquename, friendlyname?} (every change lands in a named SBRM solution)');
  else {
    for (const k of Object.keys(sol)) if (!['uniquename', 'friendlyname'].includes(k)) err(`solution: unknown key "${k}"`);
    if (typeof sol.uniquename !== 'string' || !SOLUTION_NAME.test(sol.uniquename)) err('solution: "uniquename" must be letters, digits and _ (no spaces)');
    if (sol.friendlyname !== undefined && sol.friendlyname !== null && (typeof sol.friendlyname !== 'string' || !sol.friendlyname.trim())) err('solution: "friendlyname" must be text');
  }
  if (raw.proven_in !== undefined && raw.proven_in !== null && (typeof raw.proven_in !== 'string' || !PLAN_ID.test(raw.proven_in))) {
    err('"proven_in" must be the plan id of the same change applied in the dev copy (e.g. 20261007-201500-1a2b3c4d), or null');
  }
  const objs = raw.objects;
  const out = { tables: [], columns: [], relationships: [], keys: [], options: [] };
  if (!isObj(objs)) err('"objects" is required: {tables, columns, relationships, keys, options}');
  else {
    for (const k of Object.keys(objs)) if (!KINDS.includes(k)) err(`objects: unknown kind "${k}" (allowed: ${KINDS.join(', ')})`);
    for (const kind of KINDS) {
      const list = objs[kind];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) { err(`objects.${kind} must be a list`); continue; }
      list.forEach((o, i) => {
        const at = `${SINGULAR[kind]} ${i + 1}`;
        const got = validateObject(kind, o, at, err);
        if (got) out[kind].push(got);
      });
    }
    if (!KINDS.some((k) => Array.isArray(objs[k]) && objs[k].length)) err('"objects" lists nothing to change');
  }
  if (!errors.length) crossCheck(out, err);

  const intent = raw.intent;
  if (!isObj(intent)) err('"intent" is required: {verb: "develop", solution, objects: {tables, columns, relationships, keys, options}}');
  else if (!errors.length) {
    const mism = [];
    for (const k of Object.keys(intent)) if (!['verb', 'solution', 'objects'].includes(k)) mism.push(`unknown key "${k}"`);
    if (intent.verb !== 'develop') mism.push(`verb says "${intent.verb}", an app change is "develop"`);
    if (intent.solution !== sol.uniquename) mism.push(`solution says "${intent.solution}", the job uses "${sol.uniquename}"`);
    if (!isObj(intent.objects)) mism.push('objects is missing');
    else {
      for (const k of Object.keys(intent.objects)) if (!KINDS.includes(k)) mism.push(`objects: unknown key "${k}"`);
      for (const k of KINDS) {
        const said = intent.objects[k] === undefined ? 0 : intent.objects[k];
        if (said !== out[k].length) mism.push(`${k} says ${said}, the job has ${out[k].length}`);
      }
    }
    if (mism.length) err(`intent does not match the objects (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  return {
    errors: [],
    job: {
      contract: CONTRACT, kind: 'schema', env: raw.env, source: raw.source.trim(), reason: raw.reason.trim(), intent,
      solution: { uniquename: sol.uniquename, friendlyname: sol.friendlyname ? sol.friendlyname.trim() : null },
      proven_in: raw.proven_in || null,
      objects: out,
    },
  };
}

function validateObject(kind, o, at, err) {
  if (!isObj(o)) { err(`${at} is not an object`); return null; }
  const action = o.action === undefined ? 'create' : o.action;
  const shape = SHAPES[kind][action];
  if (!shape) { err(`${at}: "action" must be one of ${Object.keys(SHAPES[kind]).join(', ')}`); return null; }
  for (const k of Object.keys(o)) if (!shape.includes(k)) err(`${at}: unknown key "${k}" for ${action}`);
  const text = (k, { optional = false } = {}) => {
    const v = o[k];
    if (v === undefined || v === null) { if (!optional) err(`${at}: "${k}" is required`); return null; }
    if (typeof v !== 'string' || !v.trim()) { err(`${at}: "${k}" must be text`); return null; }
    return v.trim();
  };
  const ident = (k) => {
    const v = o[k];
    if (typeof v !== 'string' || !IDENT.test(v)) { err(`${at}: "${k}" must be a logical name (lowercase), e.g. "sbrm_interview"`); return null; }
    return v;
  };
  const schemaName = (k) => {
    const v = o[k];
    if (typeof v !== 'string' || !SCHEMA_NAME.test(v)) { err(`${at}: "${k}" must be a schema name (letters, digits, _)`); return null; }
    if (!v.toLowerCase().startsWith(PREFIX)) { err(`${at}: "${k}" ${v} must start with ${PREFIX} (the SBRM publisher's prefix)`); return null; }
    return v;
  };
  const bool = (k, dflt) => {
    const v = o[k];
    if (v === undefined || v === null) return dflt;
    if (typeof v !== 'boolean') { err(`${at}: "${k}" must be true or false`); return dflt; }
    return v;
  };
  const out = { kind: SINGULAR[kind], action };

  if (kind === 'tables') {
    if (action === 'create') {
      out.schema_name = schemaName('schema_name');
      out.table = out.schema_name ? logical(out.schema_name) : null;
      out.display = text('display');
      out.plural = text('plural');
      out.description = text('description');
      const p = o.primary;
      if (!isObj(p)) err(`${at}: "primary" is required: {schema_name, display, max_length?} (the primary name column)`);
      else {
        for (const k of Object.keys(p)) if (!['schema_name', 'display', 'max_length'].includes(k)) err(`${at}: primary: unknown key "${k}"`);
        if (typeof p.schema_name !== 'string' || !SCHEMA_NAME.test(p.schema_name) || !p.schema_name.toLowerCase().startsWith(PREFIX)) err(`${at}: primary.schema_name must be a schema name starting with ${PREFIX}`);
        if (typeof p.display !== 'string' || !p.display.trim()) err(`${at}: primary.display is required`);
        const ml = p.max_length === undefined || p.max_length === null ? 100 : p.max_length;
        if (!Number.isInteger(ml) || ml < 1 || ml > 4000) err(`${at}: primary.max_length must be a whole number from 1 to 4000`);
        out.primary = { schema_name: p.schema_name, display: typeof p.display === 'string' ? p.display.trim() : p.display, max_length: ml };
      }
      out.audit = bool('audit', true);
      out.change_tracking = bool('change_tracking', true);
      out.quick_create = bool('quick_create', true);
    } else {
      out.table = ident('table');
      if (action === 'update') out.set = validateSet(o.set, TABLE_SET, at, err, { audit: 'bool', change_tracking: 'bool', quick_create: 'bool' });
    }
  } else if (kind === 'columns') {
    out.table = ident('table');
    if (action === 'create') {
      const type = o.type;
      if (!Object.prototype.hasOwnProperty.call(COLUMN_TYPES, type)) {
        err(`${at}: "type" must be one of ${Object.keys(COLUMN_TYPES).join(', ')} (a lookup is created as a relationship)`);
        return null;
      }
      out.type = type;
      out.schema_name = schemaName('schema_name');
      out.column = out.schema_name ? logical(out.schema_name) : null;
      out.display = text('display');
      out.description = text('description', { optional: true });
      out.required = bool('required', false);
      for (const k of ['max_length', 'min_value', 'max_value', 'precision', 'default', 'options', 'global_choice', 'format']) {
        if (o[k] !== undefined && !COLUMN_EXTRA[type].includes(k)) err(`${at}: "${k}" does not apply to a ${type} column`);
      }
      for (const [k, [lo, hi, dflt]] of Object.entries(LIMITS[type] || {})) {
        const v = o[k] === undefined || o[k] === null ? dflt : o[k];
        if (v !== null && (!Number.isInteger(v) || v < lo || v > hi)) err(`${at}: "${k}" must be a whole number from ${lo} to ${hi}`);
        out[k] = v;
      }
      if (out.min_value !== undefined && out.max_value !== undefined && out.min_value > out.max_value) err(`${at}: "min_value" is above "max_value"`);
      if (type === 'yes_no') out.default = bool('default', false);
      if (type === 'autonumber') {
        out.format = text('format');
        if (out.format && !out.format.includes('{SEQNUM:')) err(`${at}: autonumber "format" has no {SEQNUM:n}, so every row would get the same value`);
      }
      if (type === 'choice' || type === 'multi_choice') {
        const hasOpts = o.options !== undefined && o.options !== null;
        const hasGlobal = o.global_choice !== undefined && o.global_choice !== null;
        if (hasOpts === hasGlobal) err(`${at}: a choice column takes either "options" (its own list) or "global_choice" (an existing global choice's name), not both or neither`);
        else if (hasGlobal) out.global_choice = ident('global_choice');
        else if (!Array.isArray(o.options) || !o.options.length || o.options.some((x) => typeof x !== 'string' || !x.trim())) err(`${at}: "options" must be a non-empty list of labels`);
        else {
          const seen = new Set();
          for (const x of o.options) {
            if (seen.has(x.trim().toLowerCase())) err(`${at}: option "${x}" is listed twice`);
            seen.add(x.trim().toLowerCase());
          }
          if (o.options.length > OPTION_SPAN) err(`${at}: too many options`);
          out.options = o.options.map((x) => x.trim());
        }
      }
    } else {
      out.column = ident('column');
      if (action === 'update') out.set = validateSet(o.set, COLUMN_SET, at, err, { required: 'bool', max_length: 'int' });
    }
  } else if (kind === 'relationships') {
    if (action === 'create') {
      out.type = o.type;
      if (o.type === 'one_to_many') {
        for (const k of ['entity1', 'entity2', 'menu1', 'menu2']) if (o[k] !== undefined) err(`${at}: "${k}" is for a many_to_many relationship`);
        out.schema_name = schemaName('schema_name');
        out.column = out.schema_name ? logical(out.schema_name) : null;
        out.display = text('display');
        out.description = text('description', { optional: true });
        out.required = bool('required', false);
        out.referenced = ident('referenced');
        out.referencing = ident('referencing');
        out.show_on_parent = text('show_on_parent', { optional: true });
        out.rel_schema = out.schema_name && out.referenced && out.referencing ? lookupRelName(out.schema_name, out.referenced, out.referencing) : null;
      } else if (o.type === 'many_to_many') {
        for (const k of ['display', 'description', 'required', 'referenced', 'referencing', 'show_on_parent']) if (o[k] !== undefined) err(`${at}: "${k}" is for a one_to_many relationship`);
        out.schema_name = schemaName('schema_name');
        out.rel_schema = out.schema_name;
        out.entity1 = ident('entity1');
        out.entity2 = ident('entity2');
        out.menu1 = text('menu1', { optional: true });
        out.menu2 = text('menu2', { optional: true });
      } else {
        err(`${at}: "type" must be "one_to_many" (a lookup) or "many_to_many"`);
        return null;
      }
    } else {
      out.rel_schema = typeof o.schema_name === 'string' && SCHEMA_NAME.test(o.schema_name) ? o.schema_name : (err(`${at}: "schema_name" must be the relationship's schema name`), null);
    }
  } else if (kind === 'keys') {
    out.table = ident('table');
    if (action === 'create') {
      out.schema_name = schemaName('schema_name');
      out.key = out.schema_name ? logical(out.schema_name) : null;
      out.display = text('display');
      if (!Array.isArray(o.columns) || !o.columns.length || o.columns.some((c) => typeof c !== 'string' || !IDENT.test(c))) err(`${at}: "columns" must be a non-empty list of column logical names`);
      else if (new Set(o.columns).size !== o.columns.length) err(`${at}: a column is listed twice in "columns"`);
      else out.columns = [...o.columns];
    } else out.key = ident('key');
  } else if (kind === 'options') {
    const t = o.target;
    if (!isObj(t)) err(`${at}: "target" is required: {table, column} for a column's own choice, or {global} for a global choice`);
    else if (t.global !== undefined) {
      if (Object.keys(t).length !== 1 || typeof t.global !== 'string' || !IDENT.test(t.global)) err(`${at}: target {global} takes only the global choice's name`);
      else out.target = { global: t.global };
    } else if (Object.keys(t).length !== 2 || typeof t.table !== 'string' || !IDENT.test(t.table) || typeof t.column !== 'string' || !IDENT.test(t.column)) {
      err(`${at}: target must be {table, column} (logical names) or {global}`);
    } else out.target = { table: t.table, column: t.column };
    const val = (k) => {
      const v = o[k];
      if (!Number.isInteger(v)) { err(`${at}: "${k}" must be an option value (a whole number)`); return null; }
      return v;
    };
    if (action === 'create') {
      out.label = text('label');
      out.value = o.value === undefined || o.value === null ? null : val('value');
    } else if (action === 'update') {
      out.value = val('value');
      out.label = text('label');
    } else if (action === 'reorder') {
      if (!Array.isArray(o.order) || !o.order.length || o.order.some((v) => !Number.isInteger(v))) err(`${at}: "order" must be the full list of option values in the new order`);
      else if (new Set(o.order).size !== o.order.length) err(`${at}: a value is listed twice in "order"`);
      else out.order = [...o.order];
    } else out.value = val('value');
  }
  return out;
}
function validateSet(set, map, at, err, types) {
  if (!isObj(set) || !Object.keys(set).length) { err(`${at}: "set" must name what changes: ${Object.keys(map).join(', ')}`); return {}; }
  const out = {};
  for (const [k, v] of Object.entries(set)) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) {
      // A type, ownership or logical-name change is a delete plus a recreate in Dataverse (data loss): the job
      // shape has no way to ask for it (DESIGN.md §10c).
      err(`${at}: set: "${k}" cannot be changed here (allowed: ${Object.keys(map).join(', ')})`);
      continue;
    }
    const t = types[k] || 'text';
    if (t === 'bool' && typeof v !== 'boolean') err(`${at}: set.${k} must be true or false`);
    else if (t === 'int' && (!Number.isInteger(v) || v < 1 || v > 1048576)) err(`${at}: set.${k} must be a whole number`);
    else if (t === 'text' && typeof v !== 'string') err(`${at}: set.${k} must be text`);
    else if (t === 'text' && k !== 'description' && !v.trim()) err(`${at}: set.${k} cannot be blank`);
    else out[k] = t === 'text' ? v.trim() : v;
  }
  return out;
}

// Conflicts inside one job: the same object twice, or an object that leans on one the job deletes.
function crossCheck(o, err) {
  const seen = new Map();
  const once = (key, what) => {
    if (seen.has(key)) err(`${what} appears twice in the job (${seen.get(key)} and ${what}); one entry per object`);
    else seen.set(key, what);
  };
  const deletedTables = new Set(o.tables.filter((t) => t.action === 'delete').map((t) => t.table));
  const deletedCols = new Set(o.columns.filter((c) => c.action === 'delete').map((c) => `${c.table}.${c.column}`));
  const createdCols = new Set(o.columns.filter((c) => c.action === 'create').map((c) => `${c.table}.${c.column}`));
  o.tables.forEach((t, i) => once(`table:${t.table}`, `table ${i + 1}`));
  o.columns.forEach((c, i) => {
    once(`column:${c.table}.${c.column}`, `column ${i + 1}`);
    if (deletedTables.has(c.table)) err(`column ${i + 1}: its table ${c.table} is deleted by this job`);
  });
  o.relationships.forEach((r, i) => {
    once(`rel:${r.rel_schema}`, `relationship ${i + 1}`);
    if (r.action !== 'create') return;
    if (r.type === 'one_to_many') {
      once(`column:${r.referencing}.${r.column}`, `relationship ${i + 1} (its lookup column)`);
      for (const t of [r.referenced, r.referencing]) if (deletedTables.has(t)) err(`relationship ${i + 1}: table ${t} is deleted by this job`);
    } else for (const t of [r.entity1, r.entity2]) if (deletedTables.has(t)) err(`relationship ${i + 1}: table ${t} is deleted by this job`);
  });
  o.keys.forEach((k, i) => {
    once(`key:${k.table}.${k.key}`, `key ${i + 1}`);
    if (deletedTables.has(k.table)) err(`key ${i + 1}: its table ${k.table} is deleted by this job`);
    for (const c of k.columns || []) if (deletedCols.has(`${k.table}.${c}`)) err(`key ${i + 1}: column ${c} is deleted by this job`);
  });
  o.options.forEach((x, i) => {
    if (!x.target || x.target.global) return;
    const key = `${x.target.table}.${x.target.column}`;
    if (deletedTables.has(x.target.table) || deletedCols.has(key)) err(`option ${i + 1}: its column ${key} is deleted by this job`);
    if (createdCols.has(key)) err(`option ${i + 1}: ${key} is created by this job; put its options in the column's "options" list`);
  });
}

// ---------- reads (all GETs; the plan's connection cannot do anything else) ----------

function enc(filter) {
  return encodeURIComponent(filter);
}

function q(s) {
  return String(s).replace(/'/g, "''");
}

// A missing object answers with an error, not an empty list, on a by-key metadata read (read live 10/7:
// 0x80060888 for a table, 0x80040217 for a global choice). ONLY those codes (or an HTTP 404) mean "not
// there"; anything else (throttling, sign-in, a network fault) is a real failure and propagates. Narrowed
// after the 10/7 blind review: a loose message match let a failed read-back pass as "deleted".
// ALSO 10/7 re-verify (read live): a malformed $select answers 0x80060888 too ("Could not find a property
// named ..."); that is a broken query, never "does not exist", so it propagates.
function isNotFound(e) {
  return e instanceof DataverseError && (['0x80060888', '0x80040217'].includes(e.code) || e.status === 404)
    && !/Could not find a property named/i.test(String(e.message));
}

function orNull(fn) {
  try {
    return fn();
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function text(lbl) {
  if (!lbl) return '';
  if (lbl.UserLocalizedLabel && lbl.UserLocalizedLabel.Label !== undefined) return lbl.UserLocalizedLabel.Label;
  const l = (lbl.LocalizedLabels || []).find((x) => x.LanguageCode === LANG) || (lbl.LocalizedLabels || [])[0];
  return l ? l.Label : '';
}

const ENTITY_SELECT = 'LogicalName,SchemaName,MetadataId,IsManaged,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,DisplayName,DisplayCollectionName,CreatedOn';
const ATTR_SELECT = 'LogicalName,SchemaName,MetadataId,IsManaged,AttributeType,AttributeTypeName,DisplayName,RequiredLevel,IsPrimaryId,IsPrimaryName,AttributeOf';

function readSolution(dv, name) {
  const v = dv.get(`solutions?$select=solutionid,uniquename,friendlyname,ismanaged,_publisherid_value&$filter=${enc(`uniquename eq '${q(name)}'`)}`).value || [];
  return v[0] || null;
}

// The listing answers even while a new table is still provisioning (a live finding 10/6), so existence is read here.
function readEntity(dv, t) {
  const v = dv.get(`EntityDefinitions?$select=${ENTITY_SELECT}&$filter=${enc(`LogicalName eq '${q(t)}'`)}`).value || [];
  return v[0] || null;
}

function readEntityDef(dv, t) {
  return orNull(() => dv.get(`EntityDefinitions(LogicalName='${q(t)}')`));
}

// A table's WHOLE definition, what a table delete logs (10/7 blind review: the entity alone cannot rebuild
// it): the entity with its columns, keys and relationships (one $expand, read live 10/7 in Donor App Dev:
// 149 KB for a 45-column table), plus the options of its own choice columns (the expand leaves them out).
function readEntityFull(dv, t) {
  const d = orNull(() => dv.get(`EntityDefinitions(LogicalName='${q(t)}')?$expand=Attributes,Keys,OneToManyRelationships,ManyToOneRelationships,ManyToManyRelationships`));
  if (!d) return null;
  const sets = {};
  for (const cast of ['PicklistAttributeMetadata', 'MultiSelectPicklistAttributeMetadata']) {
    for (const a of dv.get(`EntityDefinitions(LogicalName='${q(t)}')/Attributes/Microsoft.Dynamics.CRM.${cast}?$select=LogicalName&$expand=OptionSet`).value || []) {
      sets[a.LogicalName] = a.OptionSet || null;
    }
  }
  // Lookups on OTHER tables that point at this one: Dataverse deletes them (and their values) with the
  // table, so they are logged in full too (10/7 re-verify).
  const elsewhere = lookupsInto(dv, t).map((r) => ({ ...r, definition: readAttrFull(dv, r.table, r.column) }));
  return { ...d, OptionSets: sets, LookupsElsewhere: elsewhere };
}

// The custom lookup columns on other tables that point at `t` (system relationships such as async
// operations are polymorphic, keep their column, and are not listed).
function lookupsInto(dv, t) {
  const rels = orNull(() => dv.get(`EntityDefinitions(LogicalName='${q(t)}')/OneToManyRelationships?$select=SchemaName,ReferencingEntity,ReferencingAttribute,IsCustomRelationship`).value) || [];
  return rels.filter((r) => r.IsCustomRelationship === true && r.ReferencingEntity !== t)
    .map((r) => ({ relationship: r.SchemaName, table: r.ReferencingEntity, column: r.ReferencingAttribute }))
    .sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

// The Web API type name of a column, for a PUT body or a cast. A column whose type cannot be named is
// refused rather than guessed (10/7 re-verify: `${AttributeType}AttributeMetadata` misspelled
// UniqueIdentifier and had no answer for a multi-select).
const ATTR_CAST = {
  String: 'StringAttributeMetadata', Memo: 'MemoAttributeMetadata', Integer: 'IntegerAttributeMetadata', BigInt: 'BigIntAttributeMetadata',
  Decimal: 'DecimalAttributeMetadata', Double: 'DoubleAttributeMetadata', Money: 'MoneyAttributeMetadata', Boolean: 'BooleanAttributeMetadata',
  DateTime: 'DateTimeAttributeMetadata', Picklist: 'PicklistAttributeMetadata', State: 'StateAttributeMetadata', Status: 'StatusAttributeMetadata',
  Lookup: 'LookupAttributeMetadata', Customer: 'LookupAttributeMetadata', Owner: 'LookupAttributeMetadata',
  Uniqueidentifier: 'UniqueIdentifierAttributeMetadata', EntityName: 'EntityNameAttributeMetadata', Image: 'ImageAttributeMetadata', File: 'FileAttributeMetadata',
};

function attrTypeName(def) {
  const given = String((def && def['@odata.type']) || '').replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
  if (given) return `Microsoft.Dynamics.CRM.${given}`;
  if (!def) return null;
  if (def.AttributeType === 'Virtual') return def.AttributeTypeName && def.AttributeTypeName.Value === 'MultiSelectPicklistType' ? 'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata' : null;
  return ATTR_CAST[def.AttributeType] ? `Microsoft.Dynamics.CRM.${ATTR_CAST[def.AttributeType]}` : null;
}

// A column's whole definition, with the options (or the global choice) a choice column uses: what a
// column delete logs, so a rebuild can bring the options back (10/7 re-verify).
function readAttrFull(dv, t, c) {
  const d = readAttrDef(dv, t, c);
  if (!d) return null;
  const type = attrTypeName(d);
  if (/(Picklist|MultiSelectPicklist)AttributeMetadata$/.test(type || '')) {
    const r = dv.get(`EntityDefinitions(LogicalName='${q(t)}')/Attributes(LogicalName='${q(c)}')/${type}?$select=LogicalName,IsManaged&$expand=OptionSet,GlobalOptionSet`);
    return { ...d, OptionSet: r.OptionSet || null, GlobalOptionSet: r.GlobalOptionSet || null };
  }
  return d;
}

// A relationship's definition plus, for a lookup, the lookup column's own (label, required level,
// description): what a relationship delete logs.
function readRelFull(dv, schema) {
  const d = readRelDef(dv, schema);
  if (!d) return null;
  if (!d.ReferencingAttribute) return d;
  return { ...d, LookupAttribute: readAttrFull(dv, d.ReferencingEntity, d.ReferencingAttribute) };
}

// Forms and views of a table with UNPUBLISHED edits: PublishXml on a table publishes every pending
// customization on it, someone else's included (10/7 blind review). RetrieveUnpublishedMultiple answers
// every form/view in its draft state (read live 10/7 in Donor App Dev), so a draft is one whose XML differs
// from the published copy, or that has no published copy. null = could not be read.
function readDrafts(dv, t) {
  const kinds = [
    { set: 'systemforms', id: 'formid', by: 'objecttypecode', xml: ['formxml'] },
    { set: 'savedqueries', id: 'savedqueryid', by: 'returnedtypecode', xml: ['fetchxml', 'layoutxml'] },
  ];
  try {
    const names = [];
    for (const k of kinds) {
      const tail = `?$filter=${enc(`${k.by} eq '${q(t)}'`)}&$select=${[k.id, 'name', ...k.xml].join(',')}`;
      const draft = dv.get(`${k.set}/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()${tail}`).value || [];
      const live = new Map((dv.get(`${k.set}${tail}`).value || []).map((r) => [r[k.id], r]));
      for (const d of draft) {
        const p = live.get(d[k.id]);
        if (!p || k.xml.some((x) => (d[x] || '') !== (p[x] || ''))) names.push(`${k.set === 'systemforms' ? 'form' : 'view'} ${d.name}`);
      }
    }
    return names.sort();
  } catch {
    return null;
  }
}

function readAttr(dv, t, c) {
  return orNull(() => (dv.get(`EntityDefinitions(LogicalName='${q(t)}')/Attributes?$select=${ATTR_SELECT}&$filter=${enc(`LogicalName eq '${q(c)}'`)}`).value || [])[0] || null);
}

function readAttrDef(dv, t, c) {
  return orNull(() => dv.get(`EntityDefinitions(LogicalName='${q(t)}')/Attributes(LogicalName='${q(c)}')`));
}

function readRel(dv, schema) {
  const v = dv.get(`RelationshipDefinitions?$select=SchemaName,MetadataId,IsManaged,RelationshipType&$filter=${enc(`SchemaName eq '${q(schema)}'`)}`).value || [];
  return v[0] || null;
}

function readRelDef(dv, schema) {
  return orNull(() => dv.get(`RelationshipDefinitions(SchemaName='${q(schema)}')`));
}

function readKey(dv, t, k) {
  return orNull(() => (dv.get(`EntityDefinitions(LogicalName='${q(t)}')/Keys?$select=LogicalName,SchemaName,MetadataId,IsManaged,KeyAttributes,EntityKeyIndexStatus,DisplayName`).value || [])
    .find((x) => x.LogicalName === k) || null);
}

function readGlobal(dv, name) {
  return orNull(() => dv.get(`GlobalOptionSetDefinitions(Name='${q(name)}')`));
}

function inSolution(dv, solutionId, metadataId) {
  if (!solutionId || !metadataId) return false;
  const v = dv.get(`solutioncomponents?$select=objectid&$filter=${enc(`_solutionid_value eq ${solutionId} and objectid eq ${metadataId}`)}`).value || [];
  return v.length > 0;
}

function optionList(opts) {
  return (opts || []).map((o) => ({ value: o.Value, label: text(o.Label) }));
}

// A choice's options and where they live: { global, name, managed, metadata_id, type, options: [{value, label}] }.
function readOptions(dv, target) {
  if (target.global) {
    const g = readGlobal(dv, target.global);
    if (!g) return null;
    return { global: true, name: g.Name, managed: g.IsManaged === true, metadata_id: g.MetadataId, display: text(g.DisplayName) || g.Name, options: optionList(g.Options) };
  }
  const a = readAttr(dv, target.table, target.column);
  if (!a) return null;
  const multi = a.AttributeType === 'Virtual' && a.AttributeTypeName && a.AttributeTypeName.Value === 'MultiSelectPicklistType';
  if (a.AttributeType !== 'Picklist' && !multi) return { not_choice: true, type: a.AttributeType };
  const cast = multi ? 'MultiSelectPicklistAttributeMetadata' : 'PicklistAttributeMetadata';
  const r = dv.get(`EntityDefinitions(LogicalName='${q(target.table)}')/Attributes(LogicalName='${q(target.column)}')/Microsoft.Dynamics.CRM.${cast}?$select=LogicalName,IsManaged&$expand=OptionSet,GlobalOptionSet`);
  const os = r.OptionSet || r.GlobalOptionSet || {};
  return {
    global: os.IsGlobal === true, name: os.Name || null, managed: a.IsManaged === true || os.IsManaged === true, metadata_id: os.MetadataId || a.MetadataId,
    multi, display: text(a.DisplayName) || target.column, options: optionList(os.Options),
  };
}

// Rows in a table, optionally filtered. null when they could not be counted. Dataverse counts to 5,000.
function countRows(dv, ent, filter = null) {
  if (!ent || !ent.EntitySetName) return null;
  try {
    const r = dv.get(`${ent.EntitySetName}?$select=${ent.PrimaryIdAttribute}&$count=true&$top=1${filter ? `&$filter=${enc(filter)}` : ''}`);
    return typeof r['@odata.count'] === 'number' ? r['@odata.count'] : null;
  } catch {
    return null;
  }
}

function rowsText(n) {
  if (n === null || n === undefined) return 'an unknown number of';
  return n >= 5000 ? '5,000 or more' : n.toLocaleString('en-US');
}

// ---------- definitions: compare, simplify, rebuild for PUT ----------

// Sorted-key JSON of a definition as read, minus what is not part of the definition: the response
// annotations, HasChanged, and '@odata.type' (a GET of a table carries none, a GET of a column says
// "#Microsoft...", a PUT body says "Microsoft..."; the type itself is AttributeType and never changes here).
const NOT_DEFINITION = new Set(['@odata.context', '@odata.etag', '@odata.type', 'HasChanged']);

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => !NOT_DEFINITION.has(k)).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

// A definition as a PUT body: the full definition read at plan (Dataverse replaces it whole; with
// MSCRM.MergeLabels other languages' labels are kept), never a partial one.
// DatabaseLength is left out: Dataverse derives it from MaxLength, and sending the old one back with a new
// MaxLength contradicts it (10/7 re-verify).
function putBody(def, fallbackType) {
  const out = defBefore(def, fallbackType);
  delete out.DatabaseLength;
  return out;
}

// A definition as read, kept whole for the log (only the response annotations dropped).
function defBefore(def, fallbackType) {
  const type = String(def['@odata.type'] || fallbackType).replace(/^#/, '');
  const out = JSON.parse(JSON.stringify(def));
  delete out['@odata.context'];
  delete out['@odata.etag'];
  out['@odata.type'] = type;
  return out;
}

const LABEL_FIELDS = new Set(['DisplayName', 'DisplayCollectionName', 'Description']);

function simplify(def) {
  return {
    DisplayName: text(def.DisplayName), DisplayCollectionName: text(def.DisplayCollectionName), Description: text(def.Description),
    IsAuditEnabled: def.IsAuditEnabled ? def.IsAuditEnabled.Value : undefined, ChangeTrackingEnabled: def.ChangeTrackingEnabled,
    IsQuickCreateEnabled: def.IsQuickCreateEnabled, RequiredLevel: def.RequiredLevel ? def.RequiredLevel.Value : undefined, MaxLength: def.MaxLength,
  };
}

function applyFields(def, fields) {
  const out = JSON.parse(JSON.stringify(def));
  for (const [k, v] of Object.entries(fields)) {
    if (LABEL_FIELDS.has(k)) out[k] = label(v);
    else if (k === 'IsAuditEnabled' || k === 'RequiredLevel') out[k] = { ...(out[k] || {}), Value: v };
    else out[k] = v;
  }
  return out;
}

const REQ_TEXT = { None: 'optional', Recommended: 'recommended', ApplicationRequired: 'required', SystemRequired: 'required by the system' };

function show(field, v) {
  if (v === undefined || v === null || v === '') return '(blank)';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (field === 'RequiredLevel') return REQ_TEXT[v] || String(v);
  if (typeof v === 'number') return v.toLocaleString('en-US');
  return String(v);
}

// The changes `want` makes to `def`: [{field, label, old, new, old_text, new_text}], only what differs.
function diffFields(def, want) {
  const now = simplify(def);
  const out = [];
  for (const [k, v] of Object.entries(want)) {
    if (now[k] === v) continue;
    out.push({ field: k, label: FIELD_LABEL[k], old: now[k] === undefined ? null : now[k], new: v, old_text: show(k, now[k]), new_text: show(k, v) });
  }
  return out;
}

// ---------- fingerprints: what the plan read, re-read identically at apply ----------

function probeRead(dv, p) {
  switch (p.type) {
    case 'solution': return readSolution(dv, p.name);
    case 'entity': return readEntity(dv, p.table);
    case 'entityDef': return readEntityDef(dv, p.table);
    case 'entityFull': return readEntityFull(dv, p.table);
    case 'attr': return readAttr(dv, p.table, p.column);
    case 'attrDef': return readAttrDef(dv, p.table, p.column);
    case 'rel': return readRel(dv, p.schema);
    case 'relDef': return readRelDef(dv, p.schema);
    case 'relFull': return readRelFull(dv, p.schema);
    case 'attrFull': return readAttrFull(dv, p.table, p.column);
    case 'membership': { const e = readEntity(dv, p.table); const sr = readSolution(dv, p.solution); return { in: Boolean(e && sr && inSolution(dv, sr.solutionid, e.MetadataId)) }; }
    case 'key': return readKey(dv, p.table, p.key);
    case 'options': return readOptions(dv, p.target);
    case 'global': { const g = readGlobal(dv, p.name); return g ? { MetadataId: g.MetadataId, IsManaged: g.IsManaged } : null; }
    default: throw new Error(`engine bug: unknown probe ${p.type}`);
  }
}

function fingerprint(dv, probes) {
  return canonical(probes.map((p) => probeRead(dv, p)));
}

// ---------- what a step IS, from the request it sends (never from the plan's own labels) ----------
//
// 10/7 blind review: apply used to trust plan fields (`admin_only`, a step's `action`, its display name).
// A plan file is hash-checked by the CLI, but if that were ever bypassed, apply must still not be talked
// into less than the steps do. So the level, the typed delete phrase and the severity at apply are all
// re-derived HERE from each step's method, path and body, plus live reads.

const T_PATH = /^EntityDefinitions\(LogicalName='([a-z0-9_]+)'\)/;

function stepKind(s) {
  const p = String(s.path || '');
  const m = String(s.method || '').toUpperCase();
  const tail = p.replace(T_PATH, '');
  const onTable = T_PATH.test(p);
  if (p === 'solutions') return m === 'POST' ? 'solution.create' : null;
  if (p === 'EntityDefinitions') return m === 'POST' ? 'table.create' : null;
  if (onTable && tail === '') return { PUT: 'table.update', DELETE: 'table.delete' }[m] || null;
  if (onTable && tail === '/Attributes') return m === 'POST' ? 'column.create' : null;
  if (onTable && /^\/Attributes\(LogicalName='[a-z0-9_]+'\)$/.test(tail)) return { PUT: 'column.update', DELETE: 'column.delete' }[m] || null;
  if (onTable && tail === '/Keys') return m === 'POST' ? 'key.create' : null;
  if (onTable && /^\/Keys\(LogicalName='[a-z0-9_]+'\)$/.test(tail)) return m === 'DELETE' ? 'key.delete' : null;
  if (p === 'RelationshipDefinitions') return m === 'POST' ? 'relationship.create' : null;
  if (p === 'AddSolutionComponent') return m === 'POST' && (s.body || {}).ComponentType === 1 ? 'table.adopt' : null;
  if (/^RelationshipDefinitions\(SchemaName='[A-Za-z0-9_]+'\)$/.test(p)) return m === 'DELETE' ? 'relationship.delete' : null;
  const opt = { InsertOptionValue: 'option.create', UpdateOptionValue: 'option.update', OrderOption: 'option.reorder', DeleteOptionValue: 'option.delete' }[p];
  return opt && m === 'POST' ? opt : null;
}

function pathParts(s) {
  const p = String(s.path || '');
  const t = (T_PATH.exec(p) || [])[1] || null;
  return {
    table: t,
    column: (/\/Attributes\(LogicalName='([a-z0-9_]+)'\)$/.exec(p) || [])[1] || null,
    key: (/\/Keys\(LogicalName='([a-z0-9_]+)'\)$/.exec(p) || [])[1] || null,
    schema: (/^RelationshipDefinitions\(SchemaName='([A-Za-z0-9_]+)'\)$/.exec(p) || [])[1] || null,
  };
}

function optionTargetOf(body) {
  const b = body || {};
  return b.OptionSetName ? { global: b.OptionSetName } : { table: b.EntityLogicalName, column: b.AttributeLogicalName };
}

// Every table a step's request touches, read from the request (and, for a relationship delete, the live
// relationship it names).
function tablesOfStep(dv, s) {
  const k = stepKind(s);
  const b = s.body || {};
  const out = new Set();
  const { table } = pathParts(s);
  if (table) out.add(table);
  if (k === 'table.create' && b.SchemaName) out.add(String(b.SchemaName).toLowerCase());
  if (k === 'table.adopt') { const e = orNull(() => dv.get(`EntityDefinitions(${b.ComponentId})?$select=LogicalName`)); if (e) out.add(e.LogicalName); }
  if (k === 'relationship.create') for (const x of [b.ReferencedEntity, b.ReferencingEntity, b.Entity1LogicalName, b.Entity2LogicalName]) if (x) out.add(x);
  if (k === 'relationship.delete') {
    const d = readRelDef(dv, pathParts(s).schema);
    if (d) for (const x of [d.ReferencedEntity, d.ReferencingEntity, d.Entity1LogicalName, d.Entity2LogicalName]) if (x) out.add(x);
  }
  if (k && k.startsWith('option.') && b.EntityLogicalName) out.add(b.EntityLogicalName);
  return out;
}

// The blank-row filter for a column made required, from the LIVE column (a lookup filters on _x_value).
function blankFilter(attrDef, column) {
  return `${['Lookup', 'Customer', 'Owner'].includes(attrDef.AttributeType) ? `_${column}_value` : column} eq null`;
}

// Before an alternate key: do existing rows already repeat a value combination it would make unique?
// Then Dataverse cannot build its index (10/7 re-verify). Counted with one grouped query (groupby, read
// live 10/7). null = fine (or nothing to check: a table or column this plan creates has no values yet);
// otherwise the refusal text. Combinations with a blank are not counted as repeats.
function keyDupesText(dv, steps, s) {
  const { table } = pathParts(s);
  const b = s.body || {};
  const cols = b.KeyAttributes || [];
  const created = new Set(steps.filter((x) => stepKind(x) === 'table.create').map((x) => String(x.body.SchemaName).toLowerCase()));
  const newCols = new Set(steps.filter((x) => stepKind(x) === 'column.create' && pathParts(x).table === table).map((x) => String(x.body.SchemaName).toLowerCase()));
  if (created.has(table) || cols.some((c) => newCols.has(c))) return null;
  const e = readEntity(dv, table);
  if (!e) return null;
  const name = `the alternate key ${text(b.DisplayName) || b.SchemaName} on ${table}`;
  const fields = cols.map((c) => {
    const a = readAttr(dv, table, c);
    return a && ['Lookup', 'Customer', 'Owner'].includes(a.AttributeType) ? `_${c}_value` : c;
  });
  let got;
  try {
    got = dv.get(`${e.EntitySetName}?$apply=groupby((${fields.join(',')}),aggregate($count%20as%20n))`);
  } catch (err) {
    return `${name}: the existing rows could not be checked for repeated values (${String(err.message).slice(0, 120)}), so it is not created`;
  }
  if (got['@odata.nextLink']) return `${name}: too many value combinations to check in one read, so it is not created`;
  const dup = (got.value || []).filter((g) => g.n > 1 && fields.every((f) => g[f] !== null && g[f] !== undefined));
  if (!dup.length) return null;
  const rows = dup.reduce((t, g) => t + g.n, 0);
  return `${name}: ${dup.length} value combination${dup.length === 1 ? '' : 's'} already repeat (${rows} rows), so Dataverse cannot build its index. Clean those rows up first`;
}

// A table this person's earlier run of the SAME job created, that then stopped before the table was in the
// solution (10/7 re-verify: the "someone else built it" refusal trapped that re-run). Evidence, all read
// live: an earlier Write Log entry of this person, in this solution, whose table create for it did not end
// "written", made before the table's CreatedOn; and the table in no solution but Default / Active.
function adoptable(dv, identity, sol, t, e) {
  const comps = orNull(() => dv.get(`solutioncomponents?$select=_solutionid_value&$filter=${enc(`objectid eq ${e.MetadataId}`)}&$expand=solutionid($select=uniquename,ismanaged)`).value) || [];
  if (comps.some((c) => !['Default', 'Active'].includes((c.solutionid || {}).uniquename))) return false;
  let logs = [];
  try {
    logs = dv.get(`sbrm_dataversewritelogs?$select=sbrm_planid,sbrm_entry&$filter=${enc(`sbrm_mode eq 'schema' and _createdby_value eq ${identity.systemuserid}`)}&$top=50`).value || [];
  } catch {
    return false;
  }
  const made = Date.parse(e.CreatedOn || '');
  return logs.some((row) => {
    let entry;
    try { entry = parseEntry(row.sbrm_entry); } catch { entry = null; }
    if (!entry || entry.solution !== sol) return false;
    const tried = (entry.rows || []).some((r) => r.method === 'POST' && r.path === 'EntityDefinitions' && String((r.body || {}).SchemaName).toLowerCase() === t && r.outcome !== 'written');
    return tried && Number.isFinite(made) && Date.parse(entry.time) <= made + 60000;
  });
}

// ---------- the rules every plan obeys, forward, revert or apply (10/7 final re-verify) ----------
//
// A revert is built from a Write Log row, and anyone with Create on the log table can write one. So the
// rules a forward plan enforces are checked HERE, from the steps' requests and live reads alone, by the
// forward plan, the revert plan and apply: managed objects are never changed, locked settings stay locked,
// max length never goes down, a shared global choice is never edited as one column's own, and every step
// lands in the plan's solution, which must be unmanaged and under the environment's SBRM publisher.

function solutionProblems(solRow, publisher, name) {
  if (!solRow) return [`the solution ${name} does not exist here`];
  const out = [];
  if (solRow.ismanaged) out.push(`the solution ${name} is managed (imported); changes go into an unmanaged SBRM solution`);
  if (String(solRow._publisherid_value || '').toLowerCase() !== String(publisher || '').toLowerCase()) out.push(`the solution ${name} belongs to another publisher (${solRow._publisherid_value}), not SBRM's`);
  return out;
}

function stepRuleProblems(dv, steps, sol) {
  const out = [];
  for (const s of steps) {
    const k = stepKind(s);
    if (!k) { out.push(`${s.name}: not a request this engine makes`); continue; }
    const b = s.body || {};
    // Every step lands in THE plan's solution, never another one named in a header or body.
    const hdr = (s.headers || []).map((h) => /^MSCRM\.SolutionUniqueName:\s*(.*)$/i.exec(h)).filter(Boolean).map((m) => m[1].trim());
    const named = [...hdr, ...(b.SolutionUniqueName !== undefined ? [b.SolutionUniqueName] : []), ...(k === 'solution.create' ? [b.uniquename] : [])];
    if (named.some((n) => n !== sol)) out.push(`${s.name}: names a solution other than ${sol}`);
    const { table, column, key, schema } = pathParts(s);
    if (k === 'table.update' || k === 'column.update') {
      const live = column ? readAttrDef(dv, table, column) : readEntityDef(dv, table);
      if (!live) continue; // gone: the fingerprint check refuses it
      if (live.IsManaged) { out.push(`${s.name}: ${column || table} is managed (shipped by someone else); it is not changed here`); continue; }
      const now = simplify(live);
      const sent = simplify(b);
      if (now.RequiredLevel !== sent.RequiredLevel && live.RequiredLevel && (live.RequiredLevel.Value === 'SystemRequired' || live.RequiredLevel.CanBeChanged === false)) out.push(`${s.name}: its required level is locked`);
      if (now.IsAuditEnabled !== sent.IsAuditEnabled && live.IsAuditEnabled && live.IsAuditEnabled.CanBeChanged === false) out.push(`${s.name}: its auditing is locked`);
      if (typeof now.MaxLength === 'number' && typeof sent.MaxLength === 'number' && sent.MaxLength < now.MaxLength) out.push(`${s.name}: lowering max length from ${now.MaxLength} to ${sent.MaxLength} would cut off existing text; refused for everyone`);
    } else if (k.startsWith('option.')) {
      const target = optionTargetOf(b);
      const info = readOptions(dv, target);
      if (info && info.managed) out.push(`${s.name}: the choice is managed (shipped by someone else); its options are not changed here`);
      if (info && !target.global && info.global) out.push(`${s.name}: that column uses the global choice ${info.name}; it is changed only as the global choice`);
    } else if (k.endsWith('.delete')) {
      const live = k === 'table.delete' ? readEntity(dv, table) : k === 'column.delete' ? readAttr(dv, table, column)
        : k === 'key.delete' ? readKey(dv, table, key) : readRel(dv, schema);
      if (live && live.IsManaged) out.push(`${s.name}: it is managed; it is never deleted here`);
    }
  }
  return [...new Set(out)];
}

// What level the steps need, from the steps and live reads (the build brief levels, ruled 10/7):
// admin for every delete, every alternate key, anything on the toolkit's own tables, and a column made
// required while rows are blank. Returns { level, why: [...] }.
function levelNeeded(dv, steps) {
  const why = [];
  const created = new Set(steps.filter((s) => stepKind(s) === 'table.create').map((s) => String((s.body || {}).SchemaName).toLowerCase()));
  for (const s of steps) {
    const k = stepKind(s);
    if (!k) { why.push(`a step this engine does not recognise (${s.method} ${String(s.path).slice(0, 80)})`); continue; }
    if (k.endsWith('.delete')) why.push(`${s.name}: every delete takes admin (ruled 10/7)`);
    if (k === 'key.create') why.push(`${s.name}: alternate keys take admin (they change what a new record may collide with)`);
    for (const t of tablesOfStep(dv, s)) if (TOOLKIT_TABLES.has(t)) why.push(`${s.name}: ${t} is one of the toolkit's own tables`);
    if (k === 'column.update' && s.body && s.body.RequiredLevel && s.body.RequiredLevel.Value === 'ApplicationRequired') {
      const { table, column } = pathParts(s);
      const live = readAttrDef(dv, table, column);
      if (live && (live.RequiredLevel || {}).Value !== 'ApplicationRequired') {
        const n = countRows(dv, readEntity(dv, table), blankFilter(live, column));
        if (n === null || n > 0) why.push(`make ${text(live.DisplayName) || column} on ${table} required: ${rowsText(n)} rows have no value and each would fail its next save on a form`);
      }
    }
    // A NEW required column (or required lookup) on a table that already has rows: every existing row starts
    // blank and fails its next save on a form, the same as raising required (10/7 re-verify). A table this
    // plan creates has no rows.
    const b = s.body || {};
    const newReq = (k === 'column.create' && (b.RequiredLevel || {}).Value === 'ApplicationRequired') ? { table: pathParts(s).table, name: text(b.DisplayName) }
      : (k === 'relationship.create' && b.Lookup && (b.Lookup.RequiredLevel || {}).Value === 'ApplicationRequired') ? { table: b.ReferencingEntity, name: text(b.Lookup.DisplayName) } : null;
    if (newReq && !created.has(newReq.table)) {
      const n = countRows(dv, readEntity(dv, newReq.table));
      if (n === null || n > 0) why.push(`create ${newReq.name} as required on ${newReq.table}: its ${rowsText(n)} existing rows would have no value and each would fail its next save on a form`);
    }
  }
  return { level: why.length ? 'admin' : 'develop', why: [...new Set(why)] };
}

// A delete step's live facts: the name to type (never blank: the logical or schema name stands in), the
// count it takes (rows, values, links; null = not counted), and its plain lines. Plan and apply both call
// this, so the count the pop-up shows at apply is a fresh one (10/7 blind review: a column planned at 0 rows
// and applied at 4,000 must not go through on the old number).
function deleteFacts(dv, s) {
  const k = stepKind(s);
  const { table, column, key, schema } = pathParts(s);
  const tEnt = table ? readEntity(dv, table) : null;
  const tName = (tEnt && text(tEnt.DisplayName)) || table;
  if (k === 'table.delete') {
    const n = countRows(dv, tEnt);
    // Dataverse also deletes the lookups on OTHER tables that point at it, with their values (10/7 re-verify):
    // named here, so the warning says so.
    const away = lookupsInto(dv, table).map((r) => {
      const links = countRows(dv, readEntity(dv, r.table), `_${r.column}_value ne null`);
      return { ...r, links, text: `${r.column} on ${r.table} (${rowsText(links)} rows linked)` };
    });
    const also = away.length ? `, and the lookup columns on other tables that point at it: ${away.map((x) => x.text).join(', ')}` : '';
    const linkTotal = away.reduce((t, x) => (t === null || x.links === null ? null : t + x.links), 0);
    return {
      name: tName, count: n === null || linkTotal === null ? null : n + linkTotal,
      line: `DELETE the table ${tName} (${table}) and its ${rowsText(n)} rows${also}`,
      phrase: `deleting the table ${tName} removes it and its ${rowsText(n)} rows${also}`,
    };
  }
  if (k === 'column.delete') {
    const a = readAttr(dv, table, column);
    const name = (a && text(a.DisplayName)) || column;
    const n = countRows(dv, tEnt, `${column} ne null`);
    return { name, count: n, line: `DELETE the column ${name} (${column}) on ${tName} (${rowsText(n)} rows hold a value)`, phrase: `deleting the column ${name} on ${tName} removes its values in ${rowsText(n)} rows` };
  }
  if (k === 'relationship.delete') {
    const d = readRelDef(dv, schema);
    const oneMany = d && (d.RelationshipType === 'OneToManyRelationship' || /OneToMany/.test(String(d['@odata.type'])));
    if (!oneMany) {
      const what = d ? `between ${d.Entity1LogicalName} and ${d.Entity2LogicalName} (every link between them)` : '';
      return { name: schema, count: null, line: `DELETE the relationship ${schema} ${what}`.trim(), phrase: `deleting the relationship ${schema} removes it ${what}`.trim() };
    }
    const n = countRows(dv, readEntity(dv, d.ReferencingEntity), `_${d.ReferencingAttribute}_value ne null`);
    const what = `and its lookup column ${d.ReferencingAttribute} on ${d.ReferencingEntity}, with the links in ${rowsText(n)} rows`;
    return { name: schema, count: n, line: `DELETE the relationship ${schema} ${what}`, phrase: `deleting the relationship ${schema} removes it ${what}` };
  }
  if (k === 'key.delete') {
    const have = readKey(dv, table, key);
    const name = (have && text(have.DisplayName)) || key;
    return { name, count: null, line: `DELETE the alternate key ${name} (${key}) on ${tName}`, phrase: `deleting the alternate key ${name} on ${tName} lets duplicate rows in until it is rebuilt` };
  }
  if (k === 'option.delete') {
    const target = optionTargetOf(s.body);
    const info = readOptions(dv, target);
    const cur = info && !info.not_choice ? info.options.find((x) => x.value === s.body.Value) : null;
    const name = (cur && cur.label) || String(s.body.Value);
    const where = target.global ? `the global choice ${(info && info.display) || target.global} (${target.global}), shared by every column that uses it`
      : `${(info && info.display) || target.column} on ${(readEntity(dv, target.table) && text(readEntity(dv, target.table).DisplayName)) || target.table}`;
    // Rows holding it go blank. Counted for a column's own single choice; a global choice or a
    // multi-select is not counted here (said so, never shown as zero).
    const n = !target.global && info && !info.multi ? countRows(dv, readEntity(dv, target.table), `${target.column} eq ${s.body.Value}`) : null;
    return { name, count: n, line: `DELETE the option '${name}' (${s.body.Value}) from ${where} (${rowsText(n)} rows hold it and go blank)`, phrase: `removing the option '${name}' from ${where} blanks it on ${rowsText(n)} rows` };
  }
  throw new Error(`engine bug: ${s.method} ${s.path} is not a delete`);
}

// Unpublished table and column LABEL edits on a table: the same publish ships them. RetrieveEntity
// answers both as published (RetrieveAsIfPublished=false) and as it would be after a publish (true); read
// live 10/7 in Donor App Dev, two GETs per table (~131 KB each with columns). A label that differs between
// the two is someone's unpublished edit. (Live, the two answers were identical on a table with no pending
// edits; that they DIFFER on a pending label edit could not be seen without a write. The engine treats a
// difference as a draft, and an unreadable answer as "could not be checked".) null = could not be read.
function readLabelDrafts(dv, t) {
  const read = (asIf) => dv.get(`RetrieveEntity(EntityFilters=Microsoft.Dynamics.CRM.EntityFilters'Attributes',LogicalName='${q(t)}',MetadataId=00000000-0000-0000-0000-000000000000,RetrieveAsIfPublished=${asIf})`).EntityMetadata;
  try {
    const pub = read(false);
    const next = read(true);
    if (!pub || !next) return null;
    const names = [];
    const lbl = (o) => ['DisplayName', 'DisplayCollectionName', 'Description'].map((k) => text(o[k])).join('\u0001');
    if (lbl(pub) !== lbl(next)) names.push(`table label ${text(next.DisplayName) || t}`);
    const was = new Map((pub.Attributes || []).map((a) => [a.LogicalName, lbl(a)]));
    for (const a of next.Attributes || []) {
      if (was.has(a.LogicalName) && was.get(a.LogicalName) !== lbl(a)) names.push(`column label ${text(a.DisplayName) || a.LogicalName} (${a.LogicalName})`);
    }
    return names.sort();
  } catch {
    return null;
  }
}

// "Can't be fully undone" lines for the tables a publish will touch that have someone's unpublished edits:
// forms, views, and table or column labels.
function draftLines(dv, entities) {
  const out = [];
  for (const t of entities) {
    const d = readDrafts(dv, t);
    const l = readLabelDrafts(dv, t);
    const named = [...(d || []), ...(l || [])];
    const unknown = [d === null ? 'its forms or views' : null, l === null ? 'its table or column labels' : null].filter(Boolean);
    if (named.length) out.push(`publishing ${t} also publishes unpublished edits to: ${named.join(', ')}${unknown.length ? ` (and ${unknown.join(' and ')} could not be checked)` : ''}`);
    else if (unknown.length) out.push(`publishing ${t} may also publish unpublished edits to ${unknown.join(' or ')} (they could not be checked)`);
  }
  return out;
}

// ---------- what the pop-up shows, from the request and live reads (10/7 blind re-verify) ----------
//
// Every line and every "old -> new" the person approves is rendered HERE from the step's request (method,
// path, body) and live reads, at plan AND at apply; apply refuses a plan whose stored lines or changes
// differ (plan_tampered). So a plan cannot show "Label: A -> B" while its PUT turns auditing off: for a
// settings change the shown fields are the diff of the live definition against the body actually sent, and
// a body that changes anything beyond those fields is refused.

const SHOWN_FIELDS = ['DisplayName', 'DisplayCollectionName', 'Description', 'IsAuditEnabled', 'ChangeTrackingEnabled', 'IsQuickCreateEnabled', 'RequiredLevel', 'MaxLength'];
const MONEY_TEXT = 'currency (Dataverse adds Currency and Exchange Rate columns to a table that has none)';

function columnKindOf(b, globalName) {
  const n = (v) => Number(v).toLocaleString('en-US');
  const t = String(b['@odata.type'] || '').replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
  const opts = () => ((b.OptionSet && b.OptionSet.Options) || []).map((o) => text(o.Label)).join(', ');
  const glob = b['GlobalOptionSet@odata.bind'];
  switch (t) {
    case 'StringAttributeMetadata': return b.AutoNumberFormat ? `autonumber ${b.AutoNumberFormat}` : `text, max ${n(b.MaxLength)} characters`;
    case 'MemoAttributeMetadata': return `multiple lines of text, max ${n(b.MaxLength)} characters`;
    case 'IntegerAttributeMetadata': return `whole number, ${n(b.MinValue)} to ${n(b.MaxValue)}`;
    case 'DecimalAttributeMetadata': return `decimal, ${b.Precision} places`;
    case 'MoneyAttributeMetadata': return MONEY_TEXT;
    case 'BooleanAttributeMetadata': return `yes/no, default ${b.DefaultValue ? 'Yes' : 'No'}`;
    case 'DateTimeAttributeMetadata': return b.Format === 'DateOnly' && (b.DateTimeBehavior || {}).Value === 'DateOnly' ? 'date only' : 'date and time';
    case 'PicklistAttributeMetadata': return glob ? `choice, the global choice ${globalName}` : `choice: ${opts()}`;
    case 'MultiSelectPicklistAttributeMetadata': return glob ? `multi-select choice, the global choice ${globalName}` : `multi-select choice: ${opts()}`;
    default: return t || 'unknown type';
  }
}

// { line, lasting, changes, bad } per step (null for a delete: deleteFacts renders those).
function renderSteps(dv, steps, { publisher }) {
  const created = new Map(steps.filter((s) => stepKind(s) === 'table.create').map((s) => [String(s.body.SchemaName).toLowerCase(), text(s.body.DisplayName)]));
  const ents = new Map();
  const nameOf = (t) => {
    if (created.has(t)) return created.get(t) || t;
    if (!ents.has(t)) ents.set(t, readEntity(dv, t));
    return (ents.get(t) && text(ents.get(t).DisplayName)) || t;
  };
  const chosen = new Map(); // a choice's running option list, so "add, then reorder" renders as it will run
  const choiceOf = (target) => {
    const k = target.global ? `global:${target.global}` : `${target.table}.${target.column}`;
    if (!chosen.has(k)) {
      const info = readOptions(dv, target);
      chosen.set(k, info && !info.not_choice ? { info, options: info.options.map((o) => ({ ...o })) } : null);
    }
    return chosen.get(k);
  };
  const whereOf = (target, info) => (target.global
    ? `the global choice ${info.display} (${info.name}), shared by every column that uses it`
    : `${info.display} on ${nameOf(target.table)}`);
  const onOff = (v) => (v ? 'on' : 'off');

  return steps.map((s) => {
    const k = stepKind(s);
    const b = s.body || {};
    try {
      if (!k) return { bad: 'not a request this engine makes' };
      if (k === 'option.delete') {
        const w = choiceOf(optionTargetOf(b));
        if (w) w.options = w.options.filter((o) => o.value !== b.Value);
        return null;
      }
      if (k.endsWith('.delete')) return null;
      if (k === 'solution.create') {
        const pub = (/\(([^)]+)\)/.exec(b['publisherid@odata.bind'] || '') || [])[1] || '';
        const under = pub.toLowerCase() === String(publisher || '').toLowerCase() ? 'the SBRM publisher' : `the publisher ${pub}`;
        return { line: `create the solution ${b.friendlyname} (${b.uniquename}) under ${under}` };
      }
      if (k === 'table.adopt') {
        const e = orNull(() => dv.get(`EntityDefinitions(${b.ComponentId})?$select=LogicalName`));
        const t = e ? e.LogicalName : String(b.ComponentId);
        return { line: `put the existing table ${nameOf(t)} (${t}) into the solution ${b.SolutionUniqueName}, with its columns: an earlier run of this same change created it and stopped before adding it` };
      }
      if (k === 'table.create') {
        const t = String(b.SchemaName).toLowerCase();
        const p = (b.Attributes || [])[0] || {};
        const owned = b.OwnershipType === 'UserOwned' ? '' : `; ownership ${b.OwnershipType}`;
        return {
          line: `create the table ${text(b.DisplayName)} (${t}), primary column ${text(p.DisplayName)} (text, max ${p.MaxLength}); auditing ${onOff((b.IsAuditEnabled || {}).Value)}, change tracking ${onOff(b.ChangeTrackingEnabled)}, quick create ${onOff(b.IsQuickCreateEnabled)}${owned}`,
          lasting: `creates the table ${text(b.DisplayName)}`,
        };
      }
      if (k === 'column.create') {
        const { table } = pathParts(s);
        const c = String(b.SchemaName).toLowerCase();
        let globalName = null;
        let bad = null;
        if (b['GlobalOptionSet@odata.bind']) {
          // The bind is an id; the name shown must be the set that id IS (read live by the name the plan
          // gave, and its id compared).
          const probe = (s.probes || []).find((x) => x.type === 'global');
          const g = probe ? readGlobal(dv, probe.name) : null;
          globalName = probe ? probe.name : '(unknown)';
          if (!g || `/GlobalOptionSetDefinitions(${g.MetadataId})` !== b['GlobalOptionSet@odata.bind']) bad = 'its global choice is not the one named';
        }
        return {
          bad,
          line: `add the column ${text(b.DisplayName)} (${c}) to ${nameOf(table)}: ${columnKindOf(b, globalName)}, ${(b.RequiredLevel || {}).Value === 'ApplicationRequired' ? 'required' : 'optional'}`,
          lasting: `creates the column ${text(b.DisplayName)} on ${nameOf(table)}`,
        };
      }
      if (k === 'relationship.create') {
        if (b.Lookup) {
          const cc = b.CascadeConfiguration || {};
          const del = cc.Delete === 'RemoveLink' ? 'clears the link, never deletes' : `does: ${cc.Delete}`;
          const odd = Object.entries(cc).filter(([x, v]) => x !== 'Delete' && v !== 'NoCascade').map(([x, v]) => `${x}=${v}`);
          const ref = nameOf(b.ReferencedEntity);
          return {
            line: `add the lookup ${text(b.Lookup.DisplayName)} (${String(b.Lookup.SchemaName).toLowerCase()}) on ${nameOf(b.ReferencingEntity)}, pointing at ${ref} (relationship ${b.SchemaName}); deleting a ${ref} record ${del}${odd.length ? `; also cascades ${odd.join(', ')}` : ''}`,
            lasting: `creates the lookup ${text(b.Lookup.DisplayName)} on ${nameOf(b.ReferencingEntity)}`,
          };
        }
        return { line: `add the many-to-many relationship ${b.SchemaName} between ${nameOf(b.Entity1LogicalName)} and ${nameOf(b.Entity2LogicalName)}`, lasting: `creates the relationship ${b.SchemaName}` };
      }
      if (k === 'key.create') {
        const { table } = pathParts(s);
        return {
          line: `add the alternate key ${text(b.DisplayName)} (${String(b.SchemaName).toLowerCase()}) on ${nameOf(table)} over ${(b.KeyAttributes || []).join(', ')}; Dataverse builds its index in the background, and a create that matches an existing row is refused from then on`,
          lasting: `creates the alternate key ${text(b.DisplayName)} on ${nameOf(table)}`,
        };
      }
      if (k === 'table.update' || k === 'column.update') {
        const { table, column } = pathParts(s);
        const live = column ? readAttrDef(dv, table, column) : readEntityDef(dv, table);
        if (!live) return { bad: 'it no longer exists' };
        const now = simplify(live);
        const sent = simplify(b);
        const fields = Object.fromEntries(SHOWN_FIELDS.filter((f) => now[f] !== sent[f]).map((f) => [f, sent[f]]));
        const type = live['@odata.type'] || 'Microsoft.Dynamics.CRM.EntityMetadata';
        // The body must be the live definition with exactly the shown fields changed, nothing else.
        const bad = canonical(applyFields(putBody(live, type), fields)) !== canonical(b) ? 'its request changes more than the pop-up would show' : null;
        const changes = diffFields(live, fields);
        const up = changes.find((x) => x.field === 'RequiredLevel' && x.new === 'ApplicationRequired');
        if (up) {
          const n = countRows(dv, readEntity(dv, table), blankFilter(live, column));
          up.new_text = `required (${rowsText(n)} rows are blank and would fail their next save on a form)`;
        }
        const line = column ? `change the column ${text(live.DisplayName) || column} (${column}) on ${nameOf(table)}` : `change the table ${text(live.DisplayName) || table} (${table})`;
        return { bad, line, changes };
      }
      // option create / update / reorder
      const target = optionTargetOf(b);
      const w = choiceOf(target);
      if (!w) return { bad: 'the choice no longer exists' };
      const where = whereOf(target, w.info);
      if (k === 'option.create') {
        w.options.push({ value: b.Value, label: text(b.Label) });
        return { line: `add the option '${text(b.Label)}' (${b.Value}) to ${where}`, lasting: `adds the option '${text(b.Label)}' to ${where}` };
      }
      if (k === 'option.update') {
        const cur = w.options.find((o) => o.value === b.Value);
        if (!cur) return { bad: `no option ${b.Value}` };
        const old = cur.label;
        cur.label = text(b.Label);
        return {
          line: `relabel option ${b.Value} of ${where}: '${old}' -> '${cur.label}'`,
          changes: [{ field: 'Label', label: `Option ${b.Value}`, old, new: cur.label, old_text: old, new_text: cur.label }],
        };
      }
      const vals = w.options.map((o) => o.value);
      const order = b.Values || [];
      if (order.length !== vals.length || !order.every((v) => vals.includes(v))) return { bad: 'its new order does not list every option once' };
      const oldText = w.options.map((o) => o.label).join(', ');
      w.options = order.map((v) => w.options.find((o) => o.value === v));
      const newText = w.options.map((o) => o.label).join(', ');
      return { line: `reorder ${where}: ${newText}`, changes: [{ field: 'Order', label: 'Order', old: vals, new: [...order], old_text: oldText, new_text: newText }] };
    } catch (e) {
      return { bad: `could not be shown (${String(e.message).slice(0, 120)})` };
    }
  });
}

// The comparable part of a change list: which field, from what, to what (never the wording).
function changeKey(changes) {
  return canonical((changes || []).map((c) => [c.field, c.old === undefined ? null : c.old, c.new === undefined ? null : c.new]));
}

// Plan: store what renderSteps shows. Apply: compare, and use only the rendered text.
function renderInto(dv, steps, opts) {
  const r = renderSteps(dv, steps, opts);
  const bad = [];
  steps.forEach((s, i) => {
    if (!r[i]) return;
    if (r[i].bad) bad.push(`${s.name}: ${r[i].bad}`);
    s.line = r[i].line;
    if (r[i].lasting !== undefined) s.lasting = r[i].lasting;
    if (r[i].changes !== undefined) s.changes = r[i].changes;
  });
  return bad;
}

function renderMismatch(dv, steps, opts) {
  const r = renderSteps(dv, steps, opts);
  const out = [];
  steps.forEach((s, i) => {
    if (!r[i]) return;
    if (r[i].bad) out.push(`${s.name}: ${r[i].bad}`);
    else if (r[i].line !== s.line || (r[i].lasting !== undefined && r[i].lasting !== s.lasting) || changeKey(r[i].changes) !== changeKey(s.changes)) {
      out.push(`${s.name}: what the plan shows is not what it would send`);
    }
  });
  return { out, rendered: r };
}

// What a step changes on a LIVE object, and to what: { key, fields }. Read from the request (and the
// definition before it), so the same signature comes out of a plan step and out of a Write Log row (rows keep
// method, path, body, before). "Proven in the dev copy" (lib/proven.js `matches`) then requires the dev plan
// to have made the SAME change: the same objects, and the same new value for every field this job changes
// (labels compared by text, options by value). 10/7 blind re-verify: matching by object alone let a dev
// LABEL change "prove" a live change that made the same column REQUIRED.
function changeSig(s) {
  const k = stepKind(s);
  const { table, column } = pathParts(s);
  const b = s.body || {};
  if (k === 'table.update' || k === 'column.update') {
    const was = simplify(s.before || {});
    const now = simplify(b);
    const fields = Object.fromEntries(SHOWN_FIELDS.filter((f) => was[f] !== now[f]).map((f) => [f, now[f]]));
    return { key: k === 'table.update' ? `table:${table}` : `column:${table}.${column}`, fields };
  }
  if (k === 'option.update' || k === 'option.reorder') {
    const t = optionTargetOf(b);
    const base = `option:${t.global ? `global ${t.global}` : `${t.table}.${t.column}`}`;
    return k === 'option.update' ? { key: `${base} value ${b.Value}`, fields: { Label: text(b.Label) } } : { key: `${base} order`, fields: { Order: canonical(b.Values || []) } };
  }
  return null;
}

function sameChange(sigs) {
  return (entry) => {
    if (!entry || entry.mode !== 'schema') return 'it was not an app (schema) change';
    const done = (entry.rows || []).filter((r) => r.outcome === 'written').map((r) => { try { return changeSig(r); } catch { return null; } }).filter(Boolean);
    const missed = sigs.filter((sig) => !done.some((d) => d.key === sig.key && Object.entries(sig.fields).every(([f, v]) => d.fields[f] === v)));
    return missed.length
      ? `it did not make the same change to ${missed.map((m) => `${m.key} (${Object.keys(m.fields).map((f) => FIELD_LABEL[f] || f).join(', ')})`).join('; ')}`
      : true;
  };
}

// ---------- plan ----------

// Dependency order (DESIGN.md §10e): solution, tables, (the provisioning wait), columns, relationships, keys,
// options; deletes last, children before parents, so a failure among the creates stops before any delete.
const ORDER = [
  'solution.create', 'table.adopt', 'table.create', 'table.update', 'column.create', 'column.update', 'relationship.create', 'key.create',
  'option.create', 'option.update', 'option.reorder', 'option.delete', 'key.delete', 'relationship.delete', 'column.delete', 'table.delete',
];
// Option steps keep the job's order among themselves (one rank): they are worked out in that order, so an
// "add, then reorder" or "delete, then reorder" must run in it (found 10/7 re-verify).
const rankOf = (s) => (s.object === 'option' ? ORDER.indexOf('option.create') : ORDER.indexOf(`${s.object}.${s.action}`));

function levelGate(level, identity, envInfo) {
  if (!atLeast(level, 'write')) {
    throw new PlanRefused([`${identity.fullname} (${identity.email}) has read access to the ${envInfo.name}. Changing the app takes develop access; ask Dylan.`], 'access_read');
  }
  if (!atLeast(level, 'develop')) {
    throw new PlanRefused([`${identity.fullname} has write access to the ${envInfo.name} (can change records). Changing the app (tables, columns, choices) takes develop access; ask Dylan.`], 'not_permitted');
  }
}

function colKind(c) {
  const n = (v) => Number(v).toLocaleString('en-US');
  switch (c.type) {
    case 'text': return `text, max ${n(c.max_length)} characters`;
    case 'memo': return `multiple lines of text, max ${n(c.max_length)} characters`;
    case 'whole_number': return `whole number, ${n(c.min_value)} to ${n(c.max_value)}`;
    case 'decimal': return `decimal, ${c.precision} places`;
    case 'money': return 'currency (Dataverse adds Currency and Exchange Rate columns to a table that has none)';
    case 'yes_no': return `yes/no, default ${c.default ? 'Yes' : 'No'}`;
    case 'date': return 'date only';
    case 'datetime': return 'date and time';
    case 'choice': return c.global_choice ? `choice, the global choice ${c.global_choice}` : `choice: ${c.options.join(', ')}`;
    case 'multi_choice': return c.global_choice ? `multi-select choice, the global choice ${c.global_choice}` : `multi-select choice: ${c.options.join(', ')}`;
    case 'autonumber': return `autonumber ${c.format}`;
    default: return c.type;
  }
}

function clipList(names, n = 100) {
  const s = [...new Set(names)].join(', ');
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

async function planSchema(dv, job, { envs, access, warnRows, readEnv, now = new Date() } = {}) { // eslint-disable-line no-unused-vars
  const envInfo = envs[job.env];
  const identity = whoAmI(dv);
  if (!identity.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, job.env), identity.email, job.env);
  levelGate(acc.level, identity, envInfo);
  if (!envInfo.publisher) throw new PlanRefused([`envs.json names no SBRM publisher for the ${envInfo.name}, so no solution can be checked`], 'engine_bug');
  // Choice values come from the publisher's option value prefix (prefix * 10000), read live: the Donor App's
  // SBRM publisher is 10000, HGS and Sober Living 33830 (10/7 re-verify). Never assumed.
  const pub = orNull(() => dv.get(`publishers(${envInfo.publisher})?$select=customizationprefix,customizationoptionvalueprefix`));
  if (!pub || pub.customizationprefix !== 'sbrm' || !Number.isInteger(pub.customizationoptionvalueprefix)) {
    throw new PlanRefused([`the SBRM publisher ${envInfo.publisher} in the ${envInfo.name} could not be read, or its prefix is not sbrm`], 'engine_bug');
  }
  const optionBase = pub.customizationoptionvalueprefix * 10000;
  const isAdmin = atLeast(acc.level, 'admin');

  const invalid = []; // the job asks for something that is not there or does not fit: invalid_job
  const missing = []; // a table the job leans on does not exist: table_missing
  const forbidden = []; // refused for everyone (managed, foreign solution, max length down, ...): not_permitted
  const adminWhy = []; // allowed only at admin
  const already = [];
  const steps = [];
  const sol = job.solution.uniquename;
  const solHdr = `MSCRM.SolutionUniqueName: ${sol}`;

  // The solution (the earlier table builder): ours, unmanaged, under this environment's SBRM publisher.
  const solRow = readSolution(dv, sol);
  if (solRow) {
    if (solRow.ismanaged) forbidden.push(`the solution ${sol} is managed (imported); changes go into an unmanaged SBRM solution`);
    if (String(solRow._publisherid_value || '').toLowerCase() !== envInfo.publisher.toLowerCase()) {
      forbidden.push(`the solution ${sol} belongs to another publisher (${solRow._publisherid_value}), not SBRM's; name an SBRM solution`);
    }
  } else if (!job.solution.friendlyname) {
    invalid.push(`the solution ${sol} does not exist in the ${envInfo.name}; give solution.friendlyname to create it, or name an existing SBRM solution`);
  } else {
    steps.push({
      object: 'solution', action: 'create', name: `solution ${job.solution.friendlyname}`, display: job.solution.friendlyname,
      method: 'POST', path: 'solutions', headers: [],
      body: {
        uniquename: sol, friendlyname: job.solution.friendlyname, version: '1.0.0.0',
        description: `Made through the SBRM toolkit's app development path (Shared Dataverse Write). First change: ${job.reason}`.slice(0, 2000),
        'publisherid@odata.bind': `/publishers(${envInfo.publisher})`,
      },
      line: `create the solution ${job.solution.friendlyname} (${sol}) under the SBRM publisher`,
      probes: [{ type: 'solution', name: sol }], expect: canonical([solRow]), check: { publisher: envInfo.publisher },
    });
  }

  const o = job.objects;
  // Tables THIS PLAN creates (filled by the tables pass below, which runs first). Not the job's list: on a
  // re-plan the job still names the table, but it exists, and its columns must be read like any other's.
  const createdTables = new Map();
  const createdCols = new Map(o.columns.filter((c) => c.action === 'create').map((c) => [`${c.table}.${c.column}`, c]));
  for (const r of o.relationships) if (r.action === 'create' && r.type === 'one_to_many') createdCols.set(`${r.referencing}.${r.column}`, { display: r.display });
  const deletedTables = new Set(o.tables.filter((t) => t.action === 'delete').map((t) => t.table));

  const entCache = new Map();
  const ent = (t) => {
    if (!entCache.has(t)) entCache.set(t, readEntity(dv, t));
    return entCache.get(t);
  };
  const tableExists = (t) => createdTables.has(t) || Boolean(ent(t));
  const tableName = (t) => (createdTables.has(t) ? createdTables.get(t).display : (ent(t) ? text(ent(t).DisplayName) || t : t));
  const toolkit = (t, what) => { if (TOOLKIT_TABLES.has(t)) adminWhy.push(`${what}: ${t} is one of the toolkit's own tables`); };
  const lasting = [];
  const irreversible = [];
  // `expect` is what apply re-reads and compares. For a change to an existing object it is set by the
  // caller from the SAME read the PUT body and the logged before were built from (10/7 blind review: a
  // second read after building could pick up a change made in between, which the stale PUT would then
  // overwrite). For a create it is taken here, right after the existence check that decided it.
  const add = (s) => {
    if (s.expect === undefined) s.expect = fingerprint(dv, s.probes);
    if (s.object !== 'solution' && s.action === 'create') lasting.push(s.lasting);
    if (s.action === 'delete') {
      const f = deleteFacts(dv, s);
      Object.assign(s, { display: f.name, count: f.count, line: f.line, irreversible: f.phrase });
      irreversible.push(f.phrase);
      adminWhy.push(`${f.line.replace(/^DELETE/, 'delete')}: every delete takes admin (ruled 10/7)`);
    }
    steps.push(s);
  };

  // ---- tables ----
  for (const t of o.tables) {
    if (t.action === 'create') {
      const e = ent(t.table);
      if (e) {
        // the earlier table builder: a table that is there but not in this solution was built by someone else; stop.
        if (solRow && inSolution(dv, solRow.solutionid, e.MetadataId)) already.push({ object: 'table', name: `table ${t.display} (${t.table})`, why: 'already exists' });
        else if (solRow && adoptable(dv, identity, sol, t.table, e)) {
          toolkit(t.table, `put table ${t.table} into the solution`);
          add({
            object: 'table', action: 'adopt', name: `table ${text(e.DisplayName) || t.table} (${t.table})`, logical: { table: t.table },
            method: 'POST', path: 'AddSolutionComponent', headers: [],
            body: { ComponentId: e.MetadataId, ComponentType: 1, SolutionUniqueName: sol, AddRequiredComponents: false, DoNotIncludeSubcomponents: false },
            probes: [{ type: 'entity', table: t.table }, { type: 'membership', table: t.table, solution: sol }],
          });
        } else invalid.push(`the table ${t.table} already exists in the ${envInfo.name} but is not in the solution ${sol}: someone else built it. Stop and ask Dylan.`);
        continue;
      }
      toolkit(t.table, `create table ${t.table}`);
      createdTables.set(t.table, t);
      const body = table(t.schema_name, t.display, t.plural, t.description, t.primary, { quickCreate: t.quick_create, changeTracking: t.change_tracking, audit: t.audit });
      add({
        object: 'table', action: 'create', name: `table ${t.display} (${t.table})`, display: t.display, logical: { table: t.table },
        method: 'POST', path: 'EntityDefinitions', headers: [solHdr], body,
        line: `create the table ${t.display} (${t.table}), primary column ${t.primary.display} (text, max ${t.primary.max_length}); auditing ${t.audit ? 'on' : 'off'}, change tracking ${t.change_tracking ? 'on' : 'off'}, quick create ${t.quick_create ? 'on' : 'off'}`,
        lasting: `creates the table ${t.display}`,
        probes: [{ type: 'entity', table: t.table }],
        check: { primary: logical(t.primary.schema_name), audit: t.audit, change_tracking: t.change_tracking, quick_create: t.quick_create, solution: sol },
      });
    } else if (t.action === 'update') {
      const d = readEntityDef(dv, t.table);
      if (!d) { missing.push(`there is no table ${t.table} in the ${envInfo.name}`); continue; }
      if (d.IsManaged) { forbidden.push(`the table ${text(d.DisplayName) || t.table} (${t.table}) is managed (shipped by someone else, e.g. Microsoft's donor tables); its settings are not changed here`); continue; }
      const want = Object.fromEntries(Object.entries(t.set).map(([k, v]) => [TABLE_SET[k], v]));
      if ('IsAuditEnabled' in want && d.IsAuditEnabled && d.IsAuditEnabled.CanBeChanged === false) forbidden.push(`auditing on ${t.table} cannot be changed (locked by its solution)`);
      const changes = diffFields(d, want);
      if (!changes.length) { already.push({ object: 'table', name: `table ${text(d.DisplayName)} (${t.table})`, why: 'already has these settings' }); continue; }
      toolkit(t.table, `change table ${t.table}`);
      const fields = Object.fromEntries(changes.map((c) => [c.field, c.new]));
      add({
        object: 'table', action: 'update', name: `table ${text(d.DisplayName)} (${t.table})`, display: text(d.DisplayName), logical: { table: t.table },
        method: 'PUT', path: `EntityDefinitions(LogicalName='${t.table}')`, headers: [solHdr, 'MSCRM.MergeLabels: true'],
        body: applyFields(putBody(d, 'Microsoft.Dynamics.CRM.EntityMetadata'), fields), before: putBody(d, 'Microsoft.Dynamics.CRM.EntityMetadata'),
        fields, changes, metadata_id: d.MetadataId,
        line: `change the table ${text(d.DisplayName)} (${t.table})`,
        probes: [{ type: 'entityDef', table: t.table }], expect: canonical([d]),
      });
    } else {
      const e = ent(t.table);
      if (!e) { already.push({ object: 'table', name: `table ${t.table}`, why: 'already gone' }); continue; }
      if (e.IsManaged) { forbidden.push(`the table ${t.table} is managed; it is never deleted here`); continue; }
      const full = readEntityFull(dv, t.table);
      if (!full) { invalid.push(`the table ${t.table} could not be read in full, so its delete could not be logged`); continue; }
      add({
        object: 'table', action: 'delete', name: `table ${text(e.DisplayName) || t.table} (${t.table})`, logical: { table: t.table },
        method: 'DELETE', path: `EntityDefinitions(LogicalName='${t.table}')`, headers: [],
        before: defBefore(full, 'Microsoft.Dynamics.CRM.EntityMetadata'), metadata_id: e.MetadataId,
        probes: [{ type: 'entityFull', table: t.table }], expect: canonical([full]),
      });
    }
  }

  // ---- columns ----
  for (const c of o.columns) {
    if (!tableExists(c.table)) { missing.push(`there is no table ${c.table} in the ${envInfo.name} (and this job does not create it)`); continue; }
    const tName = tableName(c.table);
    if (c.action === 'create') {
      let globalId = null;
      if (!createdTables.has(c.table)) {
        const a = readAttr(dv, c.table, c.column);
        if (a) {
          const want = COLUMN_TYPES[c.type];
          const isMulti = a.AttributeTypeName && a.AttributeTypeName.Value === 'MultiSelectPicklistType';
          const same = a.AttributeType === want && (c.type !== 'multi_choice' || isMulti);
          if (!same) forbidden.push(`the column ${c.column} on ${c.table} already exists as ${a.AttributeType}, not ${c.type}. A type change is a delete plus a recreate (data loss) and is refused`);
          else already.push({ object: 'column', name: `column ${c.display} (${c.column}) on ${tName}`, why: 'already exists' });
          continue;
        }
      }
      const probes = [{ type: 'entity', table: c.table }, { type: 'attr', table: c.table, column: c.column }];
      if (c.global_choice) {
        const g = readGlobal(dv, c.global_choice);
        if (!g) { invalid.push(`there is no global choice ${c.global_choice} in the ${envInfo.name}`); continue; }
        globalId = g.MetadataId;
        probes.push({ type: 'global', name: c.global_choice });
      }
      toolkit(c.table, `add column ${c.column}`);
      add({
        object: 'column', action: 'create', name: `column ${c.display} (${c.column}) on ${tName}`, display: c.display, logical: { table: c.table, column: c.column },
        method: 'POST', path: `EntityDefinitions(LogicalName='${c.table}')/Attributes`, headers: [solHdr], body: columnBody(c, { globalId, optionBase }),
        line: `add the column ${c.display} (${c.column}) to ${tName}: ${colKind(c)}, ${c.required ? 'required' : 'optional'}`,
        lasting: `creates the column ${c.display} on ${tName}`,
        probes, check: { spec: c, option_base: optionBase },
      });
    } else if (c.action === 'update') {
      const d = createdTables.has(c.table) ? null : readAttrDef(dv, c.table, c.column);
      if (!d) { invalid.push(`there is no column ${c.column} on ${c.table} to change`); continue; }
      const cName = text(d.DisplayName) || c.column;
      if (d.IsManaged) { forbidden.push(`the column ${cName} (${c.column}) on ${tName} is managed (shipped by someone else); it is not changed here`); continue; }
      const want = {};
      for (const [k, v] of Object.entries(c.set)) {
        if (k === 'required') want.RequiredLevel = v ? 'ApplicationRequired' : 'None';
        else if (k === 'max_length') {
          if (!['String', 'Memo'].includes(d.AttributeType)) { invalid.push(`${cName} (${c.column}) is ${d.AttributeType}; max length is for text columns`); continue; }
          // DESIGN.md §10c: max length DOWN truncates what is there; refused for everyone.
          if (v < d.MaxLength) { forbidden.push(`lowering the max length of ${cName} (${c.column}) from ${d.MaxLength} to ${v} would cut off existing text; refused for everyone`); continue; }
          want.MaxLength = v;
        } else want[COLUMN_SET[k]] = v;
      }
      const changes = diffFields(d, want);
      if (!changes.length) { already.push({ object: 'column', name: `column ${cName} (${c.column}) on ${tName}`, why: 'already has these settings' }); continue; }
      const reqChange = changes.find((x) => x.field === 'RequiredLevel');
      let blanks = null;
      if (reqChange) {
        if (d.RequiredLevel && d.RequiredLevel.Value === 'SystemRequired') { forbidden.push(`${cName} (${c.column}) is required by the system; its required level is not changed here`); continue; }
        if (d.RequiredLevel && d.RequiredLevel.CanBeChanged === false) { forbidden.push(`the required level of ${cName} (${c.column}) is locked by its solution`); continue; }
        if (reqChange.new === 'ApplicationRequired') {
          // DESIGN.md §10c: every blank row fails its next save on a form, so blanks make it admin's call.
          const lk = ['Lookup', 'Customer', 'Owner'].includes(d.AttributeType);
          blanks = countRows(dv, ent(c.table), `${lk ? `_${c.column}_value` : c.column} eq null`);
          if (blanks === null || blanks > 0) adminWhy.push(`make ${cName} on ${tName} required: ${rowsText(blanks)} rows have no value and each would fail its next save on a form`);
          reqChange.new_text = `required (${rowsText(blanks)} rows are blank and would fail their next save on a form)`;
        }
      }
      toolkit(c.table, `change column ${c.column}`);
      const fields = Object.fromEntries(changes.map((x) => [x.field, x.new]));
      const type = attrTypeName(d);
      if (!type) { forbidden.push(`${cName} (${c.column}) is a ${d.AttributeType} column whose type this engine cannot name; it is not changed here`); continue; }
      const before = defBefore(d, type);
      add({
        object: 'column', action: 'update', name: `column ${cName} (${c.column}) on ${tName}`, display: cName, logical: { table: c.table, column: c.column },
        method: 'PUT', path: `EntityDefinitions(LogicalName='${c.table}')/Attributes(LogicalName='${c.column}')`, headers: [solHdr, 'MSCRM.MergeLabels: true'],
        body: applyFields(putBody(d, type), fields), before, fields, changes, metadata_id: d.MetadataId, blanks,
        line: `change the column ${cName} (${c.column}) on ${tName}`,
        probes: [{ type: 'attrDef', table: c.table, column: c.column }], expect: canonical([d]),
      });
    } else {
      const a = readAttr(dv, c.table, c.column);
      if (!a) { already.push({ object: 'column', name: `column ${c.column} on ${tName}`, why: 'already gone' }); continue; }
      const cName = text(a.DisplayName) || c.column;
      if (a.IsManaged) { forbidden.push(`the column ${cName} (${c.column}) is managed; it is never deleted here`); continue; }
      if (a.IsPrimaryId || a.IsPrimaryName) { forbidden.push(`${cName} (${c.column}) is the table's primary column; it goes only with the table`); continue; }
      if (a.AttributeOf) { forbidden.push(`${c.column} is a helper column of ${a.AttributeOf}; it goes with that column`); continue; }
      if (['Lookup', 'Customer', 'Owner'].includes(a.AttributeType)) { invalid.push(`${cName} (${c.column}) is a lookup; delete its relationship instead (that removes the column)`); continue; }
      const def = readAttrFull(dv, c.table, c.column);
      if (!def) { already.push({ object: 'column', name: `column ${c.column} on ${tName}`, why: 'already gone' }); continue; }
      add({
        object: 'column', action: 'delete', name: `column ${cName} (${c.column}) on ${tName}`, logical: { table: c.table, column: c.column },
        method: 'DELETE', path: `EntityDefinitions(LogicalName='${c.table}')/Attributes(LogicalName='${c.column}')`, headers: [],
        before: defBefore(def, attrTypeName(def) || 'Microsoft.Dynamics.CRM.AttributeMetadata'), metadata_id: a.MetadataId,
        probes: [{ type: 'attrFull', table: c.table, column: c.column }], expect: canonical([def]),
      });
    }
  }

  // ---- relationships ----
  for (const r of o.relationships) {
    if (r.action === 'create') {
      const ends = r.type === 'one_to_many' ? [r.referenced, r.referencing] : [r.entity1, r.entity2];
      const gone = ends.filter((t) => !tableExists(t));
      if (gone.length) { missing.push(`relationship ${r.rel_schema}: there is no table ${gone.join(' or ')} in the ${envInfo.name}`); continue; }
      if (readRel(dv, r.rel_schema)) { already.push({ object: 'relationship', name: `relationship ${r.rel_schema}`, why: 'already exists' }); continue; }
      for (const t of ends) toolkit(t, `relationship ${r.rel_schema}`);
      if (r.type === 'one_to_many') {
        if (!createdTables.has(r.referencing) && readAttr(dv, r.referencing, r.column)) {
          invalid.push(`${r.referencing} already has a column ${r.column} but no relationship ${r.rel_schema}; pick another lookup name`);
          continue;
        }
        const refKey = createdTables.has(r.referenced) ? `${r.referenced}id` : ent(r.referenced).PrimaryIdAttribute;
        add({
          object: 'relationship', action: 'create', name: `lookup ${r.display} (${r.column}) on ${tableName(r.referencing)}`, display: r.display,
          logical: { schema: r.rel_schema, table: r.referencing, column: r.column },
          method: 'POST', path: 'RelationshipDefinitions', headers: [solHdr],
          body: lookup(r.schema_name, r.display, r.referenced, refKey, r.referencing, { required: r.required, showOnParent: r.show_on_parent, description: r.description }),
          line: `add the lookup ${r.display} (${r.column}) on ${tableName(r.referencing)}, pointing at ${tableName(r.referenced)} (relationship ${r.rel_schema}); deleting a ${tableName(r.referenced)} record clears the link, never deletes`,
          lasting: `creates the lookup ${r.display} on ${tableName(r.referencing)}`,
          probes: [{ type: 'rel', schema: r.rel_schema }, ...ends.map((t) => ({ type: 'entity', table: t }))],
        });
      } else {
        add({
          object: 'relationship', action: 'create', name: `relationship ${r.rel_schema}`, display: r.rel_schema, logical: { schema: r.rel_schema },
          method: 'POST', path: 'RelationshipDefinitions', headers: [solHdr],
          body: manyToMany(r.schema_name, r.entity1, r.entity2, { menu1: r.menu1, menu2: r.menu2 }),
          line: `add the many-to-many relationship ${r.rel_schema} between ${tableName(r.entity1)} and ${tableName(r.entity2)}`,
          lasting: `creates the relationship ${r.rel_schema}`,
          probes: [{ type: 'rel', schema: r.rel_schema }, ...ends.map((t) => ({ type: 'entity', table: t }))],
        });
      }
    } else {
      const d = readRelFull(dv, r.rel_schema);
      if (!d) { already.push({ object: 'relationship', name: `relationship ${r.rel_schema}`, why: 'already gone' }); continue; }
      if (d.IsManaged) { forbidden.push(`the relationship ${r.rel_schema} is managed; it is never deleted here`); continue; }
      const oneMany = d.RelationshipType === 'OneToManyRelationship' || /OneToMany/.test(String(d['@odata.type']));
      add({
        object: 'relationship', action: 'delete', name: `relationship ${r.rel_schema}`, logical: { schema: r.rel_schema },
        method: 'DELETE', path: `RelationshipDefinitions(SchemaName='${r.rel_schema}')`, headers: [],
        before: defBefore(d, oneMany ? 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata' : 'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata'), metadata_id: d.MetadataId,
        probes: [{ type: 'relFull', schema: r.rel_schema }], expect: canonical([d]),
      });
    }
  }

  // ---- alternate keys: admin only (DESIGN.md §10b: a key changes what a create may collide with) ----
  for (const k of o.keys) {
    if (!tableExists(k.table)) { missing.push(`there is no table ${k.table} in the ${envInfo.name}`); continue; }
    const tName = tableName(k.table);
    const have = createdTables.has(k.table) ? null : readKey(dv, k.table, k.key);
    if (k.action === 'create') {
      if (have) {
        if (canonical([...(have.KeyAttributes || [])].sort()) === canonical([...k.columns].sort())) already.push({ object: 'key', name: `alternate key ${k.display} on ${tName}`, why: 'already exists' });
        else forbidden.push(`the alternate key ${k.key} on ${k.table} exists over ${(have.KeyAttributes || []).join(', ')}, not ${k.columns.join(', ')}; changing a key's columns is a delete plus a create`);
        continue;
      }
      const absent = k.columns.filter((col) => !createdCols.has(`${k.table}.${col}`) && (createdTables.has(k.table) || !readAttr(dv, k.table, col)));
      if (absent.length) { invalid.push(`alternate key ${k.key}: ${k.table} has no column ${absent.join(', ')}`); continue; }
      const dupes = keyDupesText(dv, steps, { method: 'POST', path: `EntityDefinitions(LogicalName='${k.table}')/Keys`, body: alternateKey(k.schema_name, k.display, k.columns) });
      if (dupes) { invalid.push(dupes); continue; }
      adminWhy.push(`alternate key ${k.display} on ${tName}: alternate keys take admin (they change what a new record may collide with)`);
      add({
        object: 'key', action: 'create', name: `alternate key ${k.display} (${k.key}) on ${tName}`, display: k.display, logical: { table: k.table, key: k.key },
        method: 'POST', path: `EntityDefinitions(LogicalName='${k.table}')/Keys`, headers: [solHdr], body: alternateKey(k.schema_name, k.display, k.columns),
        line: `add the alternate key ${k.display} (${k.key}) on ${tName} over ${k.columns.join(', ')}; Dataverse builds its index in the background, and a create that matches an existing row is refused from then on`,
        lasting: `creates the alternate key ${k.display} on ${tName}`,
        probes: [{ type: 'entity', table: k.table }, { type: 'key', table: k.table, key: k.key }],
        check: { columns: k.columns },
      });
    } else {
      if (!have) { already.push({ object: 'key', name: `alternate key ${k.key} on ${tName}`, why: 'already gone' }); continue; }
      if (have.IsManaged) { forbidden.push(`the alternate key ${k.key} on ${k.table} is managed; it is never deleted here`); continue; }
      add({
        object: 'key', action: 'delete', name: `alternate key ${text(have.DisplayName) || k.key} (${k.key}) on ${tName}`, logical: { table: k.table, key: k.key },
        method: 'DELETE', path: `EntityDefinitions(LogicalName='${k.table}')/Keys(LogicalName='${k.key}')`, headers: [],
        before: have, metadata_id: have.MetadataId,
        probes: [{ type: 'key', table: k.table, key: k.key }], expect: canonical([have]),
      });
    }
  }

  // ---- choice options: worked out in job order against a running copy, so "add, then reorder" works ----
  const working = new Map();
  for (const x of o.options) {
    if (!x.target) continue;
    const tkey = x.target.global ? `global:${x.target.global}` : `${x.target.table}.${x.target.column}`;
    if (!working.has(tkey)) {
      const info = readOptions(dv, x.target);
      let why = null;
      if (!info) why = x.target.global ? `there is no global choice ${x.target.global}` : `there is no column ${x.target.column} on ${x.target.table}`;
      else if (info.not_choice) why = `${x.target.table}.${x.target.column} is ${info.type}, not a choice; options are changed on choice columns only`;
      else if (info.managed) forbidden.push(`the choice ${tkey} is managed (shipped by someone else); its options are not changed here`);
      else if (!x.target.global && info.global) why = `${x.target.table}.${x.target.column} uses the global choice ${info.name}; name it as {"global": "${info.name}"} so the pop-up says every column sharing it changes`;
      if (why) invalid.push(why);
      working.set(tkey, info && !why && !info.managed ? { info, options: info.options.map((v) => ({ ...v })), first: true } : null);
    }
    const w = working.get(tkey);
    if (!w) continue;
    const info = w.info;
    if (!x.target.global) toolkit(x.target.table, `options of ${tkey}`);
    const where = x.target.global
      ? `the global choice ${info.display} (${info.name}), shared by every column that uses it`
      : `${info.display} on ${tableName(x.target.table)}`;
    const ref = x.target.global ? { OptionSetName: x.target.global } : { EntityLogicalName: x.target.table, AttributeLogicalName: x.target.column };
    const probes = [{ type: 'options', target: x.target }];
    const before = w.options.map((v) => ({ ...v }));
    const findVal = (v) => w.options.find((y) => y.value === v);
    // expect: from the same first read of this choice the running list started from.
    const common = { object: 'option', logical: { target: x.target, global: Boolean(x.target.global) }, probes, expect: canonical([info]), metadata_id: info.metadata_id, options_before: before, method: 'POST', headers: [] };
    if (x.action === 'create') {
      const same = w.options.find((y) => y.label.toLowerCase() === x.label.toLowerCase());
      if (same) { already.push({ object: 'option', name: `option '${x.label}' of ${where}`, why: `already there (value ${same.value})` }); continue; }
      let value = x.value;
      if (value !== null && findVal(value)) { invalid.push(`option value ${value} of ${tkey} is already '${findVal(value).label}'`); continue; }
      if (value === null) {
        // The publisher's series (optionBase upward): the next value after the highest one already in it.
        const ours = w.options.map((y) => y.value).filter((v) => v >= optionBase && v < optionBase + OPTION_SPAN);
        value = ours.length ? Math.max(...ours) + 1 : optionBase;
      }
      w.options.push({ value, label: x.label });
      add({
        ...common, action: 'create', name: `option '${x.label}' of ${where}`, display: x.label, value,
        path: 'InsertOptionValue', body: { ...ref, Value: value, Label: label(x.label), SolutionUniqueName: sol },
        line: `add the option '${x.label}' (${value}) to ${where}`,
        lasting: `adds the option '${x.label}' to ${where}`,
        expect_options: w.options.map((v) => ({ ...v })),
      });
    } else if (x.action === 'update') {
      const cur = findVal(x.value);
      if (!cur) { invalid.push(`${tkey} has no option ${x.value} to relabel`); continue; }
      if (cur.label === x.label) { already.push({ object: 'option', name: `option ${x.value} of ${where}`, why: `already '${x.label}'` }); continue; }
      const old = cur.label;
      cur.label = x.label;
      add({
        ...common, action: 'update', name: `option ${x.value} of ${where}`, display: x.label, value: x.value,
        path: 'UpdateOptionValue', body: { ...ref, Value: x.value, Label: label(x.label), MergeLabels: true, SolutionUniqueName: sol },
        changes: [{ field: 'Label', label: `Option ${x.value}`, old, new: x.label, old_text: old, new_text: x.label }],
        line: `relabel option ${x.value} of ${where}: '${old}' -> '${x.label}'`,
        expect_options: w.options.map((v) => ({ ...v })),
      });
    } else if (x.action === 'reorder') {
      const vals = w.options.map((y) => y.value);
      if (x.order.length !== vals.length || !x.order.every((v) => vals.includes(v))) {
        invalid.push(`reorder of ${tkey}: "order" must list every option value exactly once (it has ${vals.join(', ')})`);
        continue;
      }
      if (canonical(x.order) === canonical(vals)) { already.push({ object: 'option', name: `order of ${where}`, why: 'already in this order' }); continue; }
      const oldText = w.options.map((y) => y.label).join(', ');
      w.options = x.order.map((v) => findVal(v));
      const newText = w.options.map((y) => y.label).join(', ');
      add({
        ...common, action: 'reorder', name: `order of ${where}`, display: where, order: [...x.order], order_before: vals,
        path: 'OrderOption', body: { ...ref, Values: [...x.order], SolutionUniqueName: sol },
        changes: [{ field: 'Order', label: 'Order', old: vals, new: [...x.order], old_text: oldText, new_text: newText }],
        line: `reorder ${where}: ${newText}`,
        expect_options: w.options.map((v) => ({ ...v })),
      });
    } else {
      const cur = findVal(x.value);
      if (!cur) { already.push({ object: 'option', name: `option ${x.value} of ${where}`, why: 'already gone' }); continue; }
      w.options = w.options.filter((y) => y.value !== x.value);
      add({
        ...common, action: 'delete', name: `option '${cur.label || x.value}' of ${where}`, value: x.value, removed: { ...cur },
        path: 'DeleteOptionValue', body: { ...ref, Value: x.value, SolutionUniqueName: sol },
        expect_options: w.options.map((v) => ({ ...v })),
      });
    }
  }

  const refuseWith = (list, code) => { if (list.length) throw new PlanRefused([...new Set(list)], code); };
  refuseWith(invalid, 'invalid_job');
  refuseWith(missing, 'table_missing');
  refuseWith(forbidden, 'not_permitted');
  // The plan's own reasons, plus whatever the steps themselves need (the same check apply runs).
  const adminOnly = [...new Set([...adminWhy, ...levelNeeded(dv, steps).why])];
  if (adminOnly.length && !isAdmin) {
    throw new PlanRefused([`these changes take admin access in the ${envInfo.name}; ${identity.fullname} has ${acc.level}. Ask Dylan:`, ...adminOnly.map((x) => `  ${x}`)], 'not_permitted');
  }
  const objectSteps = steps.filter((s) => s.object !== 'solution');
  if (!objectSteps.length) {
    throw new PlanRefused([`nothing to change: every object in this job is already in place in the ${envInfo.name}${steps.length ? '' : ` (and the solution ${sol} exists)`}.`,
      ...already.slice(0, 10).map((x) => `  ${x.name}: ${x.why}`)], 'nothing_to_change');
  }

  steps.sort((a, b) => rankOf(a) - rankOf(b));
  const unshowable = renderInto(dv, steps, { publisher: envInfo.publisher });
  // A step that cannot be shown as built means the app moved while this plan was being made (the render
  // reads live again after the bodies were built from an earlier read).
  if (unshowable.length) throw new PlanRefused(['the app changed while this plan was being made; make the plan again:', ...unshowable.map((x) => `  ${x}`)], 'snapshot_moved');
  const ruled = stepRuleProblems(dv, steps, sol);
  if (ruled.length) throw new PlanRefused(ruled, 'not_permitted');

  // Publish what was touched, never everything (PublishAllXml would ship everyone's drafts, §10b).
  const touched = new Set();
  const optionsets = new Set();
  for (const s of steps) {
    const l = s.logical || {};
    if (l.table && !(s.object === 'table' && s.action === 'delete')) touched.add(l.table);
    if (s.object === 'relationship' && s.action === 'create') {
      const r = o.relationships.find((x) => x.rel_schema === l.schema);
      for (const t of r.type === 'one_to_many' ? [r.referenced, r.referencing] : [r.entity1, r.entity2]) touched.add(t);
    }
    if (s.object === 'option') {
      if (l.global) optionsets.add(l.target.global);
      else touched.add(l.target.table);
    }
  }
  for (const t of deletedTables) touched.delete(t);

  // unproven: only for changes to something live (an update); additive changes never get the line (§10d).
  const updates = objectSteps.filter((s) => s.action === 'update' || s.action === 'reorder');
  let unproven = null;
  if (updates.length) {
    try {
      unproven = unprovenPhrase({ env: job.env, envs, provenIn: job.proven_in, readEnv, matches: sameChange(updates.map(changeSig).filter(Boolean)) });
    } catch {
      unproven = `Not tried in ${(envs[(envInfo || {}).dev] || {}).name || 'the dev copy'} first (its Write Log could not be read)`;
    }
  }
  // Publishing a table publishes EVERY pending edit on it, someone else's included (10/7 blind review): a
  // table this plan creates has none; any other is checked, and its drafts named.
  const drafts = draftLines(dv, [...touched].filter((t) => !createdTables.has(t)).sort());
  const sev = severity.assess({
    count: objectSteps.length, noun: 'objects',
    lasting: objectSteps.filter((s) => s.action === 'create').map((s) => s.lasting),
    irreversible: [...objectSteps.filter((s) => s.action === 'delete').map((s) => s.irreversible), ...drafts],
    unproven,
  }, { warnRows: warnRows || severity.DEFAULT_WARN_ROWS });

  const touchedNames = [...touched, ...[...optionsets].map((n) => `global choice ${n}`)];
  const plan = {
    contract: job.contract, kind: 'schema', env: job.env, host: envInfo.host, app: envInfo.name, mode: 'schema',
    source: job.source, reason: job.reason, intent: job.intent, identity, access: acc.level, cli_version: dv.cliVersion || null,
    severity: sev, refused: [],
    table: clipList(touchedNames.length ? touchedNames : deletedTables.size ? [...deletedTables] : [sol]),
    solution: {
      uniquename: sol, friendlyname: solRow ? solRow.friendlyname : job.solution.friendlyname, exists: Boolean(solRow),
      id: solRow ? solRow.solutionid : null, publisher: envInfo.publisher, expect: canonical([solRow]),
    },
    proven_in: job.proven_in,
    admin_only: adminOnly.length > 0, admin_why: adminOnly,
    steps, already, stays: [],
    publish: { entities: [...touched].sort(), optionsets: [...optionsets].sort() },
  };
  checkEntrySize(plan, identity);
  return plan;
}

// The log keeps every object as sent, every definition before and (for an update) after. Measure the
// entry text the log will actually write (lib/log.js, pretty-printed), with each update's after taken as
// big as its before, against what one Write Log row holds; refuse rather than log less (ruled 10/7, §8f).
// 10/7 blind review: the compact plan JSON under-measured by ~15% and left out the after.
// The largest entry the log could hold for this plan (exported so a test can hold it to apply's caps).
function entryProbe(plan, identity) {
  return {
    ...entryBase(plan, { time: new Date().toISOString(), id: '00000000-000000-00000000', me: identity }),
    outcome: 'applied with problems',
    publish: { ...plan.publish, outcome: 'x'.repeat(OUTCOME_MAX) },
    rows: plan.steps.map((s) => ({
      ...rowOf(s), id: '00000000-0000-0000-0000-000000000000', outcome: 'x'.repeat(OUTCOME_MAX),
      after: s.action === 'update' ? s.before : (s.options_before ? s.options_before : null), note: 'x'.repeat(NOTE_MAX), index_status: 'Pending',
    })),
  };
}

function checkEntrySize(plan, identity) {
  const size = entryText(entryProbe(plan, identity)).length;
  if (size > MAX_ENTRY) {
    throw new PlanRefused([`this change's log entry (every object as sent, every definition before and after) would be ${size.toLocaleString('en-US')} characters, over the ${MAX_ENTRY.toLocaleString('en-US')} one Write Log row holds. Split the job (the log never keeps less, ruled 10/7).`], 'too_big');
  }
}

// ---------- the pop-up ----------

const NOUNS = {
  table: ['table', 'tables'], column: ['column', 'columns'], relationship: ['relationship', 'relationships'], key: ['alternate key', 'alternate keys'],
  option: ['option', 'options'], solution: ['solution', 'solutions'],
};

function countPhrase(list) {
  const by = new Map();
  for (const s of list) by.set(s.object, (by.get(s.object) || 0) + 1);
  const parts = [...by].map(([k, n]) => `${n} ${n === 1 ? NOUNS[k][0] : NOUNS[k][1]}`);
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function schemaHeadline(plan) {
  const objs = plan.steps.filter((s) => s.object !== 'solution');
  const groups = [
    ['Add', objs.filter((s) => s.action === 'create')],
    ['change', objs.filter((s) => s.action === 'update' || s.action === 'reorder')],
    ['delete', objs.filter((s) => s.action === 'delete')],
    ['put into the solution', objs.filter((s) => s.action === 'adopt')],
  ].filter(([, l]) => l.length);
  let h = groups.map(([v, l]) => `${v} ${countPhrase(l)}`).join('; ');
  h = h.charAt(0).toUpperCase() + h.slice(1);
  const lead = plan.reverts_plan_id ? `Undo plan ${plan.reverts_plan_id}: ` : '';
  return `${lead}${h} in the ${plan.app} (solution ${plan.solution.friendlyname || plan.solution.uniquename})`;
}

function stepLines(s, i) {
  const out = [`  ${i + 1}. ${s.line}`];
  if (s.object !== 'option') for (const c of s.changes || []) out.push(`       ${c.label}: ${c.old_text} -> ${c.new_text}`);
  return out;
}

function schemaSummary(plan) {
  const out = [...severity.block(plan.severity), schemaHeadline(plan), '', '  In this order:'];
  plan.steps.forEach((s, i) => out.push(...stepLines(s, i)));
  const pub = [...plan.publish.entities, ...plan.publish.optionsets.map((n) => `global choice ${n}`)];
  if (pub.length) out.push(`  Then publish: ${pub.join(', ')}`);
  out.push('', '  If a step fails, the steps after it are not run. Approving the same job again finishes it (a new plan lists only what is missing).');
  if (plan.already.length) {
    out.push(`  Already in place, not changed: ${plan.already.length}`);
    for (const x of plan.already.slice(0, 5)) out.push(`    ${x.name} (${x.why})`);
  }
  if ((plan.stays || []).length) {
    out.push('', `  Stays as it is (${plan.stays.length}): undo does not delete; only an admin delete removes it.`);
    for (const x of plan.stays.slice(0, 5)) out.push(`    ${x.name}`);
  }
  if (plan.refused.length) {
    out.push('', `Left out, will NOT be changed (${plan.refused.length}):`);
    for (const x of plan.refused.slice(0, 5)) out.push(`  ${x.name}: ${x.why}`);
  }
  out.push('', `Reason given: ${plan.reason}`);
  return out.join('\n');
}

function schemaDetail(plan, { id } = {}) {
  const out = [schemaHeadline(plan), '', `Requested by: ${plan.identity.fullname} (${plan.identity.email})`, `Reason given: ${plan.reason}`, `Made by: ${plan.source}`];
  if (id) out.push(`Plan: ${id}`);
  out.push(`Solution: ${plan.solution.friendlyname || ''} (${plan.solution.uniquename})${plan.solution.exists ? '' : ', created by this change'}`);
  if (plan.proven_in) out.push(`Proven in the dev copy: plan ${plan.proven_in}`);
  out.push('');
  plan.steps.forEach((s, i) => {
    out.push(...stepLines(s, i));
    out.push(`       ${s.method} ${s.path}${s.headers && s.headers.length ? `  [${s.headers.join('; ')}]` : ''}`);
  });
  const pub = [...plan.publish.entities, ...plan.publish.optionsets];
  if (pub.length) out.push(`  Publish (PublishXml): ${pub.join(', ')}`);
  if (plan.already.length) { out.push('', 'Already in place:'); for (const x of plan.already) out.push(`  - ${x.name}: ${x.why}`); }
  if ((plan.stays || []).length) { out.push('', 'Stays (undo does not delete):'); for (const x of plan.stays) out.push(`  - ${x.name}`); }
  if (plan.refused.length) { out.push('', 'Left out, will NOT be changed:'); for (const x of plan.refused) out.push(`  - ${x.name}: ${x.why}`); }
  return out.join('\n');
}

// ---------- apply ----------

function isTimeout(e) {
  return /timed? ?out|TaskCanceled|HttpClient\.Timeout/i.test(String(e && e.message));
}

// Poll until the new table answers a by-name read (a live finding 10/6: until provisioning finishes it says
// it does not exist, and a column POSTed sooner fails "An unexpected error occurred.").
// Reads after a write ask for Consistency: Strong (write.js, 10/7 re-verify), so a PUT that landed is not
// read back from a stale cache and recorded as a mismatch.
function strongDv(dv) {
  const o = Object.create(dv);
  o.get = (path, opts = {}) => dv.get(path, { ...opts, strong: true });
  return o;
}

async function waitForTable(dv, t, sleep) {
  const sdv = strongDv(dv);
  for (let waited = 0; ; waited += PROVISION_POLL_MS) {
    try {
      sdv.get(`EntityDefinitions(LogicalName='${q(t)}')?$select=LogicalName`);
      return true;
    } catch { /* not ready yet */ }
    if (waited >= PROVISION_CEILING_MS) return false;
    await sleep(PROVISION_POLL_MS);
  }
}

// After a client-side timeout: has the request landed? Re-read (strong) every 10 s for up to 2 minutes.
async function landedAfterTimeout(dv, plan, s, sleep) {
  const sdv = strongDv(dv);
  for (let waited = 0; ; waited += PROVISION_POLL_MS) {
    let r;
    try { r = checkStep(sdv, plan, s); } catch { r = { ok: false }; }
    if (r.ok) return true;
    if (waited >= TIMEOUT_RECHECK_MS) return false;
    await sleep(PROVISION_POLL_MS);
  }
}

async function runStep(dv, plan, s, sleep) {
  if (stepKind(s) === 'table.update' || stepKind(s) === 'column.update') {
    // Metadata takes no If-Match, so this is the substitute (10/7 re-verify): re-read right before the PUT
    // and refuse if the definition moved since the person approved; the PUT replaces it whole.
    if (fingerprint(strongDv(dv), s.probes) !== s.expect) {
      throw new Error('it changed in the moments before the write (someone else edited it), so nothing was written to it. Make a new plan.');
    }
  }
  if (s.object === 'table' && s.action === 'create') {
    let note = null;
    try {
      dv.metadata(s.method, s.path, s.body, s.headers);
    } catch (e) {
      // a live finding 10/7: the CLI gives up at 100 s while Dataverse finishes the create. A timeout is
      // "unknown", not "failed": look for the table before calling it either.
      if (!isTimeout(e)) throw e;
      if (!(await waitForTable(dv, s.logical.table, sleep))) {
        throw new Error(`the create timed out on this computer and the table has not appeared in 5 minutes. It may still land: make a new plan before trying again (a new plan lists only what is missing). (${String(e.message).slice(0, 160)})`);
      }
      return { note: 'the create timed out on this computer, but the table landed' };
    }
    if (!(await waitForTable(dv, s.logical.table, sleep))) {
      throw new Error('the table was created but was not ready for columns after 5 minutes. Approve the same job again in a few minutes (a new plan lists only what is missing).');
    }
    return { note };
  }
  try {
    dv.metadata(s.method, s.path, s.method === 'DELETE' ? undefined : s.body, s.headers);
  } catch (e) {
    // A delete or a slow create that times out is "unknown", not "failed": re-read before calling it.
    if (!isTimeout(e)) throw e;
    if (await landedAfterTimeout(dv, plan, s, sleep)) return { note: 'the request timed out on this computer, but it landed' };
    throw new Error(`the request timed out on this computer and has not shown up in 2 minutes. It may still land: make a new plan before trying again (a new plan lists only what is missing). (${String(e.message).slice(0, 160)})`);
  }
  return {};
}

function optionsEqual(a, b) {
  return canonical(a.map((x) => [x.value, x.label])) === canonical(b.map((x) => [x.value, x.label]));
}

// One read-back for one written step: { ok, why, id, after, index_status }.
function checkStep(dv, plan, s) {
  const l = s.logical || {};
  if (stepKind(s).endsWith('.delete')) {
    // Gone means a real "does not exist" answer (isNotFound). Any other read error is "could not confirm",
    // never "written" (10/7 blind review).
    try {
      if (stepKind(s) === 'option.delete') {
        const info = readOptions(dv, optionTargetOf(s.body));
        return info && !info.not_choice && info.options.some((x) => x.value === s.body.Value) ? { ok: false, why: 'still there' } : { ok: true };
      }
      return probeRead(dv, s.probes[0]) !== null ? { ok: false, why: 'still there' } : { ok: true };
    } catch (e) {
      return { ok: false, why: `could not confirm it is gone (${String(e.message).slice(0, 160)})` };
    }
  }
  switch (s.object) {
    case 'solution': {
      const r = readSolution(dv, plan.solution.uniquename);
      if (!r) return { ok: false, why: 'solution not found' };
      if (r.ismanaged || String(r._publisherid_value).toLowerCase() !== s.check.publisher.toLowerCase()) return { ok: false, why: `solution is managed or under publisher ${r._publisherid_value}` };
      return { ok: true, id: r.solutionid };
    }
    case 'table': {
      if (s.action === 'adopt') {
        const sr = readSolution(dv, s.body.SolutionUniqueName);
        return sr && inSolution(dv, sr.solutionid, s.body.ComponentId) ? { ok: true, id: s.body.ComponentId } : { ok: false, why: `not in the solution ${s.body.SolutionUniqueName}` };
      }
      const d = readEntityDef(dv, l.table);
      if (!d) return { ok: false, why: 'table not found' };
      if (s.action === 'update') return fieldsCheck(d, s.fields);
      const bad = [];
      if (d.OwnershipType !== 'UserOwned') bad.push(`ownership ${d.OwnershipType}`);
      if ((d.IsAuditEnabled || {}).Value !== s.check.audit) bad.push(`auditing ${show('', (d.IsAuditEnabled || {}).Value)}`);
      if (d.ChangeTrackingEnabled !== s.check.change_tracking) bad.push(`change tracking ${show('', d.ChangeTrackingEnabled)}`);
      if (d.IsQuickCreateEnabled !== s.check.quick_create) bad.push(`quick create ${show('', d.IsQuickCreateEnabled)}`);
      if (d.PrimaryNameAttribute !== s.check.primary) bad.push(`primary name ${d.PrimaryNameAttribute}`);
      const solRow = readSolution(dv, s.check.solution);
      if (!solRow || !inSolution(dv, solRow.solutionid, d.MetadataId)) bad.push(`not in the solution ${s.check.solution}`);
      return bad.length ? { ok: false, why: bad.join('; ') } : { ok: true, id: d.MetadataId, after: { EntitySetName: d.EntitySetName } };
    }
    case 'column': {
      const d = readAttrDef(dv, l.table, l.column);
      if (!d) return { ok: false, why: 'column not found' };
      if (s.action === 'update') return fieldsCheck(d, s.fields);
      const c = s.check.spec;
      const bad = [];
      const typeName = d.AttributeTypeName && d.AttributeTypeName.Value;
      if (d.AttributeType !== COLUMN_TYPES[c.type] || (c.type === 'multi_choice' && typeName !== 'MultiSelectPicklistType')) bad.push(`type ${d.AttributeType}`);
      const wantReq = c.required ? 'ApplicationRequired' : 'None';
      if ((d.RequiredLevel || {}).Value !== wantReq) bad.push(`required level ${(d.RequiredLevel || {}).Value}`);
      if (c.max_length !== undefined && c.max_length !== null && ['text', 'memo', 'autonumber'].includes(c.type) && d.MaxLength !== c.max_length) bad.push(`max length ${d.MaxLength}`);
      if (c.type === 'autonumber' && d.AutoNumberFormat !== c.format) bad.push(`autonumber format ${d.AutoNumberFormat}`);
      if (c.type === 'date' && (d.Format !== 'DateOnly' || (d.DateTimeBehavior || {}).Value !== 'DateOnly')) bad.push(`date format ${d.Format}/${(d.DateTimeBehavior || {}).Value} (wanted DateOnly/DateOnly)`);
      if (c.type === 'choice' || c.type === 'multi_choice') {
        const info = readOptions(dv, { table: l.table, column: l.column });
        if (c.global_choice) { if (!info || info.name !== c.global_choice) bad.push(`not on the global choice ${c.global_choice}`); }
        else if (!info || !optionsEqual(info.options, c.options.map((x, i) => ({ value: s.check.option_base + i, label: x })))) bad.push('options differ from what was asked');
      }
      return bad.length ? { ok: false, why: bad.join('; ') } : { ok: true, id: d.MetadataId };
    }
    case 'relationship': {
      const r = readRel(dv, l.schema);
      if (!r) return { ok: false, why: 'relationship not found' };
      if (l.column && !readAttr(dv, l.table, l.column)) return { ok: false, why: `lookup column ${l.column} not found on ${l.table}` };
      return { ok: true, id: r.MetadataId };
    }
    case 'key': {
      const k = readKey(dv, l.table, l.key);
      if (!k) return { ok: false, why: 'key not found' };
      if (canonical([...(k.KeyAttributes || [])].sort()) !== canonical([...s.check.columns].sort())) return { ok: false, why: `key covers ${(k.KeyAttributes || []).join(', ')}` };
      // An index that failed to build means duplicates already exist: a real problem, said plainly.
      if (k.EntityKeyIndexStatus === 'Failed') return { ok: false, why: 'Dataverse could not build the index (rows that already match each other?)' };
      return { ok: true, id: k.MetadataId, index_status: k.EntityKeyIndexStatus || null };
    }
    case 'option': {
      const info = readOptions(dv, l.target);
      if (!info) return { ok: false, why: 'choice not found' };
      if (s.action === 'create' && !info.options.some((x) => x.value === s.value && x.label === s.display)) return { ok: false, why: `option ${s.value} '${s.display}' not found` };
      if (s.action === 'update' && !info.options.some((x) => x.value === s.value && x.label === s.display)) return { ok: false, why: `option ${s.value} does not read '${s.display}'` };
      if (s.action === 'reorder' && canonical(info.options.map((x) => x.value)) !== canonical(s.order)) return { ok: false, why: `order is ${info.options.map((x) => x.value).join(', ')}` };
      return { ok: true, id: info.metadata_id, after: info.options };
    }
    default: return { ok: false, why: `engine bug: no read-back for ${s.object}` };
  }
}

function fieldsCheck(d, fields) {
  const now = simplify(d);
  const bad = Object.entries(fields).filter(([k, v]) => now[k] !== v).map(([k]) => `${FIELD_LABEL[k] || k} reads ${show(k, now[k])}`);
  return bad.length ? { ok: false, why: bad.join('; ') } : { ok: true, id: d.MetadataId, after: defBefore(d, 'Microsoft.Dynamics.CRM.EntityMetadata') };
}

async function readBack(dv, plan, s, sleep) {
  const sdv = strongDv(dv);
  const once = () => {
    try { return checkStep(sdv, plan, s); } catch (e) { return { ok: false, why: `read-back raised: ${String(e.message).slice(0, 160)}` }; }
  };
  const first = once();
  if (first.ok) return first;
  await sleep(READBACK_RETRY_MS);
  const second = once();
  if (second.ok) second.note = `ok after retry; first read: ${first.why}`;
  return second;
}

// The severity of what the steps would do NOW, from the steps' requests and live reads (§10j; 10/7 blind
// review): creates counted from the requests, every delete's count re-read, drafts on the tables to be
// published re-checked. Returns { sev, facts } (facts: the live delete facts, step by step).
function severityNow(dv, plan) {
  const objs = plan.steps.filter((s) => stepKind(s) !== 'solution.create');
  const facts = new Map();
  for (const s of objs) if (stepKind(s).endsWith('.delete')) facts.set(s, deleteFacts(dv, s));
  const created = new Set(plan.steps.filter((s) => stepKind(s) === 'table.create').map((s) => String(s.body.SchemaName).toLowerCase()));
  const pub = (plan.publish && plan.publish.entities) || [];
  const sev = severity.assess({
    count: objs.length, noun: 'objects',
    lasting: objs.filter((s) => /\.create$/.test(stepKind(s))).map((s) => s.lasting || s.name),
    irreversible: [...[...facts.values()].map((f) => f.phrase), ...draftLines(dv, pub.filter((t) => !created.has(t)))],
    unproven: plan.severity ? plan.severity.unproven : null,
  }, { warnRows: plan.severity ? plan.severity.warn_rows : severity.DEFAULT_WARN_ROWS });
  return { sev, facts };
}

function entryBase(plan, { time, id, me }) {
  return {
    time, plan_id: id, person: me, env: plan.env, app: plan.app, table: String(plan.table || '').slice(0, 100), mode: 'schema',
    source: plan.source, reason: plan.reason, approval: 'dialog', left_out: plan.refused, headline: schemaHeadline(plan),
    solution: plan.solution.uniquename, reverts_plan_id: plan.reverts_plan_id || null,
  };
}

// One log row per object: everything needed to undo it, and every object as sent.
function rowOf(s) {
  return {
    name: s.name, object: s.object, action: s.action, id: s.metadata_id || null,
    changes: (s.changes || []).map(({ label: l, old_text: o, new_text: n }) => ({ label: l, old_text: o, new_text: n })),
    before: s.before || (s.options_before ? { options: s.options_before } : null), method: s.method, path: s.path, body: s.body === undefined ? null : s.body,
  };
}

async function applySchema(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date(), sleep = realSleep, clock = Date.now } = deps;
  if (now - new Date(plan.created) > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old. Make a new plan.', 'stale_plan');
  // Every step's labels must say what its request does: the level, the typed phrase and the severity
  // below are worked out from the requests, and the pop-up prints the labels.
  const odd = plan.steps.filter((s) => stepKind(s) !== `${s.object}.${s.action}`);
  if (odd.length) throw new ApplyRefused(`this plan's steps do not match what they would send (${odd.map((s) => `${s.method} ${String(s.path).slice(0, 60)}`).join('; ')}). Nothing was written. Make a new plan.`, 'plan_tampered');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  if (!atLeast(acc.level, 'develop')) throw new ApplyRefused(`your access to the ${plan.app} is now ${acc.level}; this change needs develop. Nothing was written.`, 'access_revoked');

  // Live re-check: everything the plan read must still be true. The step order was worked out against it,
  // so ONE move refuses the whole apply (a new plan is cheap and lists only what is still missing).
  const moved = [];
  if (fingerprint(dv, [{ type: 'solution', name: plan.solution.uniquename }]) !== plan.solution.expect) moved.push(`the solution ${plan.solution.uniquename} changed since the plan`);
  for (const s of plan.steps) {
    let fp;
    try { fp = fingerprint(dv, s.probes); } catch (e) { moved.push(`${s.name}: could not be re-read (${String(e.message).slice(0, 120)})`); continue; }
    if (fp !== s.expect) moved.push(`${s.name}: changed since the plan`);
  }
  if (moved.length) {
    fs.rmSync(file, { force: true });
    throw new ApplyRefused(['the app changed since the plan, so nothing was written. Make a new plan:', ...moved.map((m) => `  ${m}`)].join('\n'), 'snapshot_moved');
  }
  // What the pop-up shows is rendered again from the requests and live reads; a plan whose stored lines or
  // "old -> new" differ from what its requests would do is refused (10/7 blind re-verify).
  const { out: unlike, rendered } = renderMismatch(dv, plan.steps, { publisher: plan.solution.publisher });
  if (unlike.length) {
    fs.rmSync(file, { force: true });
    throw new ApplyRefused(['this plan shows something other than what it would send. Nothing was written. Make a new plan:', ...unlike.map((m) => `  ${m}`)].join('\n'), 'plan_tampered');
  }
  // The rules every plan obeys (managed, locked, max length, the plan's own solution, unmanaged and under
  // the SBRM publisher), checked again here from the requests: a revert's steps came from a log row.
  const creating = plan.steps.some((s) => stepKind(s) === 'solution.create');
  const rules = [
    ...(creating ? [] : solutionProblems(readSolution(dv, plan.solution.uniquename), plan.solution.publisher, plan.solution.uniquename)),
    ...stepRuleProblems(dv, plan.steps, plan.solution.uniquename),
  ];
  if (rules.length) {
    fs.rmSync(file, { force: true });
    throw new ApplyRefused(['this change breaks a rule every change here follows. Nothing was written:', ...rules.map((r) => `  ${r}`)].join('\n'), 'not_permitted');
  }
  // The level the STEPS need, from their requests and live reads (never the plan's admin_only).
  const need = levelNeeded(dv, plan.steps);
  if (!atLeast(acc.level, need.level)) {
    throw new ApplyRefused([`this change needs ${need.level} access in the ${plan.app}; you have ${acc.level}. Nothing was written:`, ...need.why.map((w) => `  ${w}`)].join('\n'),
      atLeast(plan.access, need.level) ? 'access_revoked' : 'not_permitted');
  }
  // Severity now: a delete that takes more than the plan said (rows, values, links), or a new draft that a
  // publish would carry, means the person would approve less than is written.
  const { sev: sevNow, facts } = severityNow(dv, plan);
  const grewCounts = [...facts].filter(([s, f]) => typeof s.count === 'number' && (f.count === null || f.count > s.count))
    .map(([s, f]) => `${s.name}: ${rowsText(s.count)} at plan, ${rowsText(f.count)} now`);
  if (grewCounts.length || severity.grew(plan.severity, sevNow)) {
    fs.rmSync(file, { force: true });
    throw new ApplyRefused(['this change is more serious than the plan the person was told about. Nothing was written. Make a new plan:', ...grewCounts.map((g) => `  ${g}`)].join('\n'), 'severity_grew');
  }

  // A new alternate key over values that already repeat cannot build its index: refused, re-checked here.
  const dupes = plan.steps.filter((s) => stepKind(s) === 'key.create').map((s) => keyDupesText(dv, plan.steps, s)).filter(Boolean);
  if (dupes.length) {
    fs.rmSync(file, { force: true });
    throw new ApplyRefused(['the data changed since the plan, so nothing was written:', ...dupes.map((d) => `  ${d}`)].join('\n'), 'snapshot_moved');
  }

  // The pop-up shows the live severity and the live delete lines; the typed phrase is the deleted objects'
  // names as read now (never blank: a logical or schema name stands in).
  const view = {
    ...plan, severity: sevNow,
    steps: plan.steps.map((s, i) => (facts.has(s) ? { ...s, line: facts.get(s).line, display: facts.get(s).name }
      : { ...s, line: rendered[i].line, changes: rendered[i].changes !== undefined ? rendered[i].changes : s.changes })),
  };
  const typed = facts.size ? severity.typedPhrase([...facts.values()].map((f) => f.name)) : null;
  const answer = confirm({ summaryText: schemaSummary(view), detailText: schemaDetail(view, { id }), title: `SBRM: approve this app change in the ${plan.app}?`, typed });
  const base = entryBase(plan, { time: now.toISOString(), id, me });
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv };

  // Write in order; STOP at the first failure (the pop-up listed the order), and start nothing new after
  // the run limit.
  const rows = [];
  let failedAt = null;
  let stoppedAt = null;
  const started = clock();
  for (let i = 0; i < plan.steps.length; i += 1) {
    const s = plan.steps[i];
    const row = rowOf(s);
    if (failedAt !== null) { row.outcome = 'not attempted: an earlier step failed'; rows.push(row); continue; }
    if (stoppedAt === null && clock() - started > RUN_LIMIT_MS) stoppedAt = i;
    if (stoppedAt !== null) { row.outcome = 'not started: this run reached its 25-minute limit. Run the same job again to finish (a new plan lists only what is missing)'; rows.push(row); continue; }
    try {
      const r = await runStep(dv, plan, s, sleep);
      row.ran = true;
      if (r.note) row.note = capText(r.note, NOTE_MAX);
    } catch (e) {
      row.outcome = capText(`failed: ${e.message}`, OUTCOME_MAX);
      failedAt = i;
    }
    rows.push(row);
  }
  let publish = null;
  const pub = plan.publish || { entities: [], optionsets: [] };
  if (pub.entities.length || pub.optionsets.length) {
    if (failedAt !== null) publish = { ...pub, outcome: 'not attempted: an earlier step failed' };
    else if (stoppedAt !== null) publish = { ...pub, outcome: 'not attempted: the run reached its time limit; the next run publishes' };
    else {
      try {
        dv.publish({ entities: pub.entities, optionsets: pub.optionsets });
        publish = { ...pub, outcome: 'published' };
      } catch (e) {
        publish = { ...pub, outcome: capText(`failed: ${e.message}`, OUTCOME_MAX) };
      }
    }
  }
  // Read every written object back (after the publish: metadata reads lag it), one 45 s retry each.
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row.ran) continue;
    delete row.ran;
    const r = await readBack(dv, plan, plan.steps[i], sleep);
    if (r.id) row.id = r.id;
    if (r.after !== undefined) row.after = r.after;
    if (r.index_status) row.index_status = r.index_status;
    if (r.note) row.note = capText(row.note ? `${row.note}; ${r.note}` : r.note, NOTE_MAX);
    // A key whose index is still building is not done yet: said so, never "written" (10/7 re-verify).
    if (r.ok && r.index_status === 'Pending') row.outcome = 'pending (index building)';
    else row.outcome = r.ok ? 'written' : capText(`read-back mismatch: ${r.why}`, OUTCOME_MAX);
  }
  fs.rmSync(file, { force: true });
  const written = rows.filter((r) => r.outcome === 'written').length;
  const clean = written === rows.length && (!publish || publish.outcome === 'published');
  const outcome = clean ? 'applied' : 'applied with problems';
  const entry = { ...base, outcome, rows, publish };
  if (stoppedAt !== null) entry.note = 'stopped at the 25-minute limit for one run; run the same job again to finish';
  return { entry, outcome, person: me, dv, written, rows, left_out: plan.refused };
}

// ---------- revert (CONTRACT.md §10, DESIGN.md §10e) ----------
//
// A settings change goes back by PUT of the logged full definition, a relabel and a reorder by the reverse
// action, each ONLY if the object still reads exactly as the change left it (else left out: someone changed
// it since, and undoing would wipe that without them knowing; the 10/7 rows ruling). A create is not undone
// (the object stays; only an admin delete removes it). A delete is refused: its definition before is in the
// log entry, but rebuilding a deleted object is not a revert (its data is gone).

const UNDOABLE = new Set(['applied', 'applied with problems']);

// A Write Log row is DATA anyone with Create on the log table can write (10/7 final re-verify): every value
// a revert takes from it is checked for shape before it reaches a path or a body, the names it shows are
// derived from the requests and live reads (never the row's text), and the result is held to the same
// rules as a forward change (stepRuleProblems, solutionProblems, levelNeeded) at plan AND apply.
function rowLabel(r) {
  const k = stepKind(r);
  if (!k) return 'a row of that entry';
  const { table, column } = pathParts(r);
  if (k.startsWith('option.')) {
    const t = optionTargetOf(r.body);
    return `an option change on ${t.global ? `the global choice ${t.global}` : `${t.table}.${t.column}`}`;
  }
  return `the ${k.split('.')[0]} ${column ? `${table}.${column}` : table || (r.body || {}).SchemaName || ''}`.trim();
}

function revertRowShape(r) {
  if (r.id !== undefined && r.id !== null && !GUID.test(String(r.id))) return 'its id is not a GUID';
  const k = stepKind(r);
  if (k === 'table.update' || k === 'column.update') {
    const { table, column } = pathParts(r);
    if (!IDENT.test(table || '') || (k === 'column.update' && !IDENT.test(column || ''))) return 'its path is not a table or column name';
    if (!r.before || typeof r.before !== 'object' || !r.after || typeof r.after !== 'object') return 'it does not hold the definition before and after';
    return null;
  }
  if (k === 'option.update' || k === 'option.reorder') {
    const b = r.body || {};
    if (b.OptionSetName !== undefined ? !IDENT.test(String(b.OptionSetName)) : !(IDENT.test(String(b.EntityLogicalName)) && IDENT.test(String(b.AttributeLogicalName)))) return 'its choice is not a valid name';
    if (k === 'option.update') {
      const ch = (r.changes || [])[0];
      if (!Number.isInteger(b.Value) || !ch || typeof ch.old_text !== 'string' || typeof ch.new_text !== 'string' || ch.old_text.length > 500) return 'its option change is not well formed';
    } else {
      const back = ((r.before && r.before.options) || []).map((x) => x && x.value);
      if (!Array.isArray(b.Values) || !b.Values.every(Number.isInteger) || !back.length || !back.every(Number.isInteger)) return 'its option order is not well formed';
    }
    return null;
  }
  return 'this kind of change has no undo here';
}

async function planSchemaRevert(dv, entry, { envs, access, warnRows, env = null } = {}) {
  if (!entry || entry.mode !== 'schema') throw new PlanRefused(['that plan is not an app (schema) change'], 'nothing_to_undo');
  if (!UNDOABLE.has(entry.outcome)) throw new PlanRefused([`that change's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  if (typeof entry.env !== 'string' || !Object.prototype.hasOwnProperty.call(envs, entry.env)) throw new PlanRefused(['that log entry names no known environment'], 'invalid_job');
  // The entry must belong to the environment this revert is planned in (its log row could be copied to another).
  const here = env || null;
  const hostHere = String(dv.host || '').replace(/\/+$/, '').toLowerCase();
  const hostThere = String(envs[entry.env].host || '').replace(/\/+$/, '').toLowerCase();
  if ((here && here !== entry.env) || (hostHere && hostHere !== hostThere) || (!here && !hostHere)) {
    throw new PlanRefused([`that log entry is for the ${envs[entry.env].name}, not the environment this undo is planned in`], 'invalid_job');
  }
  if (typeof entry.plan_id !== 'string' || !PLAN_ID.test(entry.plan_id)) throw new PlanRefused(['that log entry has no valid plan id'], 'invalid_job');
  if (typeof entry.solution !== 'string' || !SOLUTION_NAME.test(entry.solution)) throw new PlanRefused(['that log entry does not name a valid solution'], 'invalid_job');
  const envInfo = envs[entry.env];
  const identity = whoAmI(dv);
  if (!identity.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, entry.env), identity.email, entry.env);
  levelGate(acc.level, identity, envInfo);
  const written = (entry.rows || []).filter((r) => r.outcome === 'written');
  const dels = written.filter((r) => r.action === 'delete');
  if (dels.length) {
    throw new PlanRefused([
      `plan ${entry.plan_id} deleted ${dels.map(rowLabel).join(', ')}. A delete cannot be undone by revert: the data it held is gone, and the log does not keep data.`,
      `What that plan's Dataverse Write Log entry (row "${entry.plan_id}", rows[].before) does keep is the deleted object's DEFINITION as it stood: for a column its settings and its options or global choice; for a relationship its settings and its lookup column; for a table its columns, keys, relationships, its choices' options, and the other tables' lookup columns it took with it. Rebuilding from that is a new change, made with Dylan.`,
    ], 'nothing_to_undo');
  }
  const sol = entry.solution;
  const solHdr = `MSCRM.SolutionUniqueName: ${sol}`;
  const solRow = readSolution(dv, sol);
  if (!solRow) throw new PlanRefused([`the solution ${sol} is no longer in the ${envInfo.name}`], 'table_missing');
  const solBad = solutionProblems(solRow, envInfo.publisher, sol);
  if (solBad.length) throw new PlanRefused(solBad, 'not_permitted');

  const steps = [];
  const stays = [];
  const refused = [];
  const adminWhy = [];
  for (const r of written) {
    if (r.action === 'create' || r.action === 'adopt') { stays.push({ name: `${rowLabel(r)}: stays; only an admin delete removes it` }); continue; }
    const shape = revertRowShape(r);
    if (shape) { refused.push({ name: rowLabel(r), id: GUID.test(String(r.id)) ? r.id : null, why: shape }); continue; }
    const path = r.path;
    if (r.object === 'table' || r.object === 'column') {
      const m = /^EntityDefinitions\(LogicalName='([a-z0-9_]+)'\)(?:\/Attributes\(LogicalName='([a-z0-9_]+)'\))?$/.exec(path || '');
      if (!m || !r.before || !r.after) { refused.push({ name: r.name, id: r.id, why: 'the log entry does not hold the definition before and after' }); continue; }
      const [, t, c] = m;
      const probes = [c ? { type: 'attrDef', table: t, column: c } : { type: 'entityDef', table: t }];
      const live = probeRead(dv, probes[0]);
      const rname = rowLabel(r);
      if (!live) { refused.push({ name: rname, id: r.id, why: 'no longer exists' }); continue; }
      const name = c ? `column ${text(live.DisplayName) || c} (${c}) on ${t}` : `table ${text(live.DisplayName) || t} (${t})`;
      if (TOOLKIT_TABLES.has(t)) adminWhy.push(`${name}: one of the toolkit's own tables`);
      if (canonical(live) !== canonical(r.after)) { refused.push({ name, id: r.id, why: 'changed since that change was made, so it is left as it is' }); continue; }
      // The fields that change put back to their logged before values, onto the LIVE definition (which
      // equals what the change left): nothing else in the request moves, so the pop-up shows all of it.
      const was = simplify(r.before);
      const sent = simplify(r.body || {});
      const fields = Object.fromEntries(SHOWN_FIELDS.filter((f) => was[f] !== sent[f]).map((f) => [f, was[f]]));
      // Max length never goes down, an undo included (it would cut off text written since): it stays.
      if (typeof fields.MaxLength === 'number' && typeof live.MaxLength === 'number' && fields.MaxLength < live.MaxLength) {
        refused.push({ name, id: r.id, why: `its max length stays ${live.MaxLength} (lowering it to ${fields.MaxLength} could cut off text)` });
        delete fields.MaxLength;
      }
      const changes = diffFields(live, fields);
      if (!changes.length) { refused.push({ name, id: r.id, why: 'nothing else to put back' }); continue; }
      const liveType = c ? attrTypeName(live) : 'Microsoft.Dynamics.CRM.EntityMetadata';
      if (!liveType) { refused.push({ name, id: r.id, why: 'its column type cannot be named by this engine' }); continue; }
      const liveBody = putBody(live, liveType);
      steps.push({
        object: c ? 'column' : 'table', action: 'update', name, display: text(live.DisplayName), logical: c ? { table: t, column: c } : { table: t },
        method: 'PUT', path, headers: [solHdr, 'MSCRM.MergeLabels: true'], body: applyFields(liveBody, fields), before: defBefore(live, liveType),
        fields, changes, metadata_id: r.id, probes, expect: canonical([live]),
      });
    } else if (r.object === 'option' && (r.action === 'update' || r.action === 'reorder')) {
      const b = r.body || {};
      const target = b.OptionSetName ? { global: b.OptionSetName } : { table: b.EntityLogicalName, column: b.AttributeLogicalName };
      const ref = b.OptionSetName ? { OptionSetName: b.OptionSetName } : { EntityLogicalName: b.EntityLogicalName, AttributeLogicalName: b.AttributeLogicalName };
      const oname = rowLabel(r);
      if (!target.global && TOOLKIT_TABLES.has(target.table)) adminWhy.push(`${oname}: one of the toolkit's own tables`);
      const info = readOptions(dv, target);
      if (!info || info.not_choice) { refused.push({ name: oname, id: null, why: 'the choice no longer exists' }); continue; }
      const probes = [{ type: 'options', target }];
      const common = { object: 'option', logical: { target, global: Boolean(target.global) }, probes, expect: canonical([info]), metadata_id: info.metadata_id, options_before: info.options, method: 'POST', headers: [] };
      if (r.action === 'update') {
        const ch = r.changes[0];
        const cur = info.options.find((x) => x.value === b.Value);
        if (!cur || cur.label !== ch.new_text) { refused.push({ name: oname, id: null, why: 'relabelled or removed since, so it is left as it is' }); continue; }
        steps.push({
          ...common, action: 'update', name: `option ${b.Value} of ${info.display}`, display: ch.old_text, value: b.Value,
          path: 'UpdateOptionValue', body: { ...ref, Value: b.Value, Label: label(ch.old_text), MergeLabels: true, SolutionUniqueName: sol },
          changes: [{ field: 'Label', label: `Option ${b.Value}`, old: cur.label, new: ch.old_text, old_text: cur.label, new_text: ch.old_text }],
          line: `relabel option ${b.Value} back: '${cur.label}' -> '${ch.old_text}'`,
        });
      } else {
        const back = ((r.before && r.before.options) || []).map((x) => x.value);
        const nowVals = info.options.map((x) => x.value);
        if (canonical(nowVals) !== canonical(b.Values) || back.length !== nowVals.length || !back.every((v) => nowVals.includes(v))) {
          refused.push({ name: oname, id: null, why: 'reordered or changed since, so it is left as it is' });
          continue;
        }
        const byVal = new Map(info.options.map((x) => [x.value, x.label]));
        steps.push({
          ...common, action: 'reorder', name: `order of ${info.display}`, display: info.display, order: back, order_before: nowVals,
          path: 'OrderOption', body: { ...ref, Values: back, SolutionUniqueName: sol },
          changes: [{ field: 'Order', label: 'Order', old: nowVals, new: back, old_text: nowVals.map((v) => byVal.get(v)).join(', '), new_text: back.map((v) => byVal.get(v)).join(', ') }],
          line: `put the order of ${info.display} back: ${back.map((v) => byVal.get(v)).join(', ')}`,
        });
      }
    } else {
      refused.push({ name: rowLabel(r), id: null, why: 'this kind of change has no undo here' });
    }
  }
  if (!steps.length) {
    throw new PlanRefused(['nothing to undo:', ...stays.map((x) => `  ${x.name}`), ...refused.map((x) => `  ${x.name}: ${x.why}`)], 'nothing_to_undo');
  }
  // Shown exactly as apply will re-render and check it (the same renderer as a forward plan).
  const unshowable = renderInto(dv, steps, { publisher: envInfo.publisher });
  if (unshowable.length) throw new PlanRefused(['engine bug: these undo steps could not be shown as they would run:', ...unshowable.map((x) => `  ${x}`)], 'engine_bug');
  const ruled = stepRuleProblems(dv, steps, sol);
  if (ruled.length) throw new PlanRefused(ruled, 'not_permitted');
  const adminOnly = [...new Set([...adminWhy, ...levelNeeded(dv, steps).why])];
  if (adminOnly.length && !atLeast(acc.level, 'admin')) {
    throw new PlanRefused([`undoing this takes admin access in the ${envInfo.name}; ${identity.fullname} has ${acc.level}. Ask Dylan:`, ...adminOnly.map((x) => `  ${x}`)], 'not_permitted');
  }
  const touched = new Set();
  const optionsets = new Set();
  for (const s of steps) {
    if (s.logical.table) touched.add(s.logical.table);
    if (s.object === 'option') { if (s.logical.global) optionsets.add(s.logical.target.global); else touched.add(s.logical.target.table); }
  }
  const counts = Object.fromEntries(KINDS.map((k) => [k, steps.filter((s) => s.object === SINGULAR[k]).length]));
  // No "not tried in dev" line on an undo: it puts back a state the app already ran on.
  const sev = severity.assess({ count: steps.length, noun: 'objects', lasting: [], irreversible: [], unproven: null }, { warnRows: warnRows || severity.DEFAULT_WARN_ROWS });
  return {
    contract: CONTRACT, kind: 'schema', env: entry.env, host: envInfo.host, app: envInfo.name, mode: 'schema',
    source: `revert ${entry.plan_id}`, reason: `Undo plan ${entry.plan_id} (its Dataverse Write Log entry).`,
    intent: { verb: 'develop', solution: sol, objects: counts }, identity, access: acc.level, cli_version: dv.cliVersion || null,
    severity: sev, refused, reverts_plan_id: entry.plan_id,
    table: clipList([...touched, ...[...optionsets].map((n) => `global choice ${n}`)]),
    solution: { uniquename: sol, friendlyname: solRow.friendlyname, exists: true, id: solRow.solutionid, publisher: envInfo.publisher, expect: fingerprint(dv, [{ type: 'solution', name: sol }]) },
    proven_in: null, admin_only: adminOnly.length > 0, admin_why: adminOnly,
    steps, already: [], stays,
    publish: { entities: [...touched].sort(), optionsets: [...optionsets].sort() },
  };
}

module.exports = {
  validateSchemaJob, planSchema, schemaSummary, schemaDetail, applySchema, planSchemaRevert,
  // pure helpers, exported for tests
  schemaHeadline, label, logical, textCol, memo, wholeNumber, decimal, money, yesNo, autonumber, alternateKey, dateOnly, dateTime,
  choice, multiChoice, globalChoice, optionValues, table, lookup, lookupRelName, manyToMany, columnBody, canonical, putBody,
  ORDER, OPTION_BASE, TOOLKIT_TABLES, PROVISION_POLL_MS, PROVISION_CEILING_MS, READBACK_RETRY_MS, OUTCOME_MAX, NOTE_MAX, entryProbe, attrTypeName, isNotFound, RUN_LIMIT_MS, renderInto, stepRuleProblems,
};
