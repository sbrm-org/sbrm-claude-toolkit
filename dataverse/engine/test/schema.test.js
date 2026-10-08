'use strict';
// kind "schema" (DESIGN.md §10b-10e, rulings §10j/§10k) on the fake metadata connection (fake_schema.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Every store/log path goes to a throwaway folder, set BEFORE the modules read it (CLAUDE.md trap).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-schema-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const S = require('../lib/schema');
const { PlanRefused } = require('../lib/resolve');
const { ApplyRefused } = require('../lib/apply');
const { entryText, rowFor } = require('../lib/log');
const { fakeSchemaDv, ENVS, ACCESS, PUB, USERS } = require('./fake_schema');
const { DataverseError } = require('../lib/cli');

const { validateSchemaJob, planSchema, schemaSummary, schemaDetail, applySchema, planSchemaRevert } = S;
const text = (lbl) => lbl.LocalizedLabels[0].Label;

function job(objects, over = {}) {
  const counts = Object.fromEntries(Object.entries(objects).map(([k, v]) => [k, v.length]));
  const solution = over.solution || { uniquename: 'SBRMAdHoc' };
  return {
    contract: 'sbrm-dv-job/1', kind: 'schema', env: 'fedev', solution, source: 'test', reason: 'Test change.',
    intent: { verb: 'develop', solution: solution.uniquename, objects: counts }, objects, ...over,
  };
}

function valid(raw) {
  const r = validateSchemaJob(raw, { envs: ENVS });
  assert.deepEqual(r.errors, [], 'the job validates');
  return r.job;
}

async function plan(dv, raw, ctx = {}) {
  const p = await planSchema(dv, valid(raw), { envs: ENVS, access: ACCESS, warnRows: 50, ...ctx });
  p.created = new Date().toISOString();
  return p;
}

async function refused(promise, Kind = PlanRefused) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof Kind, `expected ${Kind.name}, got ${e && e.stack}`);
    return e;
  }
  return assert.fail('expected a refusal');
}

let sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); };
let fileN = 0;
function planFile() {
  fileN += 1;
  const f = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(f, '{}');
  return f;
}
function apply(p, dv, over = {}, file = planFile()) {
  return applySchema(p, { access: ACCESS, connect: () => dv, confirm: () => ({ approved: true }), sleep, ...over }, { id: '20261007-200000-aaaaaaaa', file, fs });
}
const writes = (dv) => dv.calls.filter((c) => c.method !== 'GET');
const onlyGets = (dv) => assert.ok(dv.calls.every((c) => c.method === 'GET'), `plan issued a non-GET: ${JSON.stringify(writes(dv).map((c) => `${c.method} ${c.path}`))}`);

// ---------------------------------------------------------------------------------------------------
// Body builders, case for case against the earlier Python builder's tests, then the new ones.
// ---------------------------------------------------------------------------------------------------

test('builder: a date-only column sets BOTH Format and the DateOnly behavior (the 8/12 portal trap)', () => {
  const b = S.dateOnly('sbrm_InterviewDate', 'Interview Date', { required: true });
  assert.equal(b.Format, 'DateOnly');
  assert.deepEqual(b.DateTimeBehavior, { Value: 'DateOnly' });
  assert.equal(b.RequiredLevel.Value, 'ApplicationRequired');
});

test('builder: choice options get EXPLICIT values in the publisher\'s 33830 series, in order', () => {
  const b = S.choice('sbrm_Outcome', 'Outcome', ['Accepted', 'Denied', 'Pending']);
  const opts = b.OptionSet.Options;
  assert.deepEqual(opts.map((o) => o.Value), [338300000, 338300001, 338300002]);
  assert.deepEqual(opts.map((o) => text(o.Label)), ['Accepted', 'Denied', 'Pending']);
  assert.equal(b.OptionSet.IsGlobal, false);
  assert.equal(b.RequiredLevel.Value, 'None');
  assert.deepEqual(S.optionValues(['Accepted', 'Denied']), { Accepted: 338300000, Denied: 338300001 });
});

test('builder: schema names must carry the sbrm_ prefix; logical name is the lowercase', () => {
  assert.throws(() => S.memo('Comments', 'Comments'), /must start with sbrm_/);
  assert.equal(S.logical('sbrm_InterviewDate'), 'sbrm_interviewdate');
});

test('builder: table body is user-owned, quick create + audit + change tracking on, primary name required', () => {
  const b = S.table('sbrm_Interview', 'Interview', 'Interviews', 'desc', { schema_name: 'sbrm_Name', display: 'Applicant Name', max_length: 100 });
  assert.equal(b.OwnershipType, 'UserOwned');
  assert.equal(b.IsQuickCreateEnabled, true);
  assert.equal(b.ChangeTrackingEnabled, true);
  assert.equal(b.IsAuditEnabled.Value, true);
  assert.equal(b.Attributes.length, 1);
  const [p] = b.Attributes;
  assert.equal(p.IsPrimaryName, true);
  assert.equal(p.MaxLength, 100);
  assert.equal(p.RequiredLevel.Value, 'ApplicationRequired');
  assert.equal(b.HasActivities, false);
  assert.equal(b.HasNotes, false);
  assert.equal(S.table('sbrm_X', 'X', 'Xs', 'd', { schema_name: 'sbrm_Name', display: 'N' }, { quickCreate: false }).IsQuickCreateEnabled, false);
});

test('builder: lookup relationship REMOVES THE LINK on delete, never cascades a delete', () => {
  const b = S.lookup('sbrm_ClientId', 'Client', 'sbrm_client', 'sbrm_clientid', 'sbrm_interview', { showOnParent: 'Interviews' });
  assert.equal(b.CascadeConfiguration.Delete, 'RemoveLink');
  assert.equal(b.Lookup.SchemaName, 'sbrm_ClientId');
  assert.equal(b.ReferencedEntity, 'sbrm_client');
  assert.equal(b.ReferencingEntity, 'sbrm_interview');
  assert.equal(b.SchemaName, 'sbrm_sbrm_client_sbrm_interview_ClientId', 'named as the Python builder names it');
  assert.equal(b.AssociatedMenuConfiguration.Behavior, 'UseLabel');
  const hidden = S.lookup('sbrm_InterviewerId', 'Interviewer', 'systemuser', 'systemuserid', 'sbrm_interview', { required: true });
  assert.equal(hidden.AssociatedMenuConfiguration.Behavior, 'DoNotDisplay');
  assert.equal(hidden.Lookup.RequiredLevel.Value, 'ApplicationRequired');
});

test('builder: whole number is an Integer column with bounds, prefix enforced', () => {
  const w = S.wholeNumber('sbrm_Written', 'Written');
  assert.equal(w['@odata.type'], 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata');
  assert.deepEqual([w.MinValue, w.MaxValue, w.Format], [0, 2147483647, 'None']);
  assert.throws(() => S.wholeNumber('x_Bad', 'Bad'), /must start with sbrm_/);
});

test('builder: alternate key names its columns by logical name', () => {
  const k = S.alternateKey('sbrm_PlanIdKey', 'Plan Id', ['sbrm_planid']);
  assert.equal(k['@odata.type'], 'Microsoft.Dynamics.CRM.EntityKeyMetadata');
  assert.deepEqual(k.KeyAttributes, ['sbrm_planid']);
});

test('builder: yes/no is a Boolean column with explicit Yes/No options and a default', () => {
  const b = S.yesNo('sbrm_Signal', 'Signal', { defaultValue: false });
  assert.equal(b['@odata.type'], 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata');
  assert.equal(b.OptionSet.TrueOption.Value, 1);
  assert.equal(b.OptionSet.FalseOption.Value, 0);
  assert.equal(text(b.OptionSet.TrueOption.Label), 'Yes');
  assert.equal(b.DefaultValue, false);
  assert.throws(() => S.yesNo('x_Bad', 'Bad'), /must start with sbrm_/);
});

test('builder: autonumber is a text column carrying the format; a format without SEQNUM is refused', () => {
  const a = S.autonumber('sbrm_Number', 'Number', '#{SEQNUM:4}');
  assert.equal(a['@odata.type'], 'Microsoft.Dynamics.CRM.StringAttributeMetadata');
  assert.equal(a.AutoNumberFormat, '#{SEQNUM:4}');
  assert.ok(a.MaxLength >= 20);
  assert.throws(() => S.autonumber('sbrm_Number', 'Number', '#0001'), /SEQNUM/);
});

test('builder (new in the port): decimal, money, date and time, multi-select, global choice, many-to-many', () => {
  const d = S.decimal('sbrm_Rate', 'Rate', { precision: 4 });
  assert.equal(d['@odata.type'], 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata');
  assert.deepEqual([d.Precision, d.MinValue, d.MaxValue], [4, -100000000000, 100000000000]);
  const m = S.money('sbrm_Amount', 'Amount');
  assert.equal(m['@odata.type'], 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata');
  assert.equal(m.PrecisionSource, 2, 'follows the currency precision by default');
  assert.equal(m.Precision, undefined);
  assert.deepEqual([S.money('sbrm_A', 'A', { precision: 0 }).PrecisionSource, S.money('sbrm_A', 'A', { precision: 0 }).Precision], [0, 0]);
  const dt = S.dateTime('sbrm_When', 'When');
  assert.deepEqual([dt.Format, dt.DateTimeBehavior.Value], ['DateAndTime', 'UserLocal']);
  const mc = S.multiChoice('sbrm_Tags', 'Tags', ['A', 'B']);
  assert.equal(mc['@odata.type'], 'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata');
  assert.deepEqual(mc.OptionSet.Options.map((o) => o.Value), [338300000, 338300001]);
  const g = S.globalChoice('sbrm_Region', 'Region', 'abc-123');
  assert.equal(g['GlobalOptionSet@odata.bind'], '/GlobalOptionSetDefinitions(abc-123)');
  assert.equal(g.OptionSet, undefined, 'a global choice brings no options of its own');
  const nn = S.manyToMany('sbrm_contact_sbrm_widget', 'contact', 'sbrm_widget', { menu1: 'Widgets' });
  assert.equal(nn['@odata.type'], 'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata');
  assert.equal(nn.IntersectEntityName, 'sbrm_contact_sbrm_widget');
  assert.equal(nn.Entity1AssociatedMenuConfiguration.Behavior, 'UseLabel');
  assert.equal(nn.Entity2AssociatedMenuConfiguration.Behavior, 'DoNotDisplay');
});

test('columnBody dispatches every type with the job\'s settings and Python\'s defaults', () => {
  const j = valid(job({ columns: [
    { table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_A', display: 'A' },
    { table: 'sbrm_widget', type: 'memo', schema_name: 'sbrm_B', display: 'B', max_length: 5000 },
    { table: 'sbrm_widget', type: 'whole_number', schema_name: 'sbrm_C', display: 'C', min_value: -5, max_value: 5 },
    { table: 'sbrm_widget', type: 'yes_no', schema_name: 'sbrm_D', display: 'D', default: true, required: true },
    { table: 'sbrm_widget', type: 'autonumber', schema_name: 'sbrm_E', display: 'E', format: 'W-{SEQNUM:5}' },
    { table: 'sbrm_widget', type: 'date', schema_name: 'sbrm_F', display: 'F' },
  ] }));
  const [a, b, c, d, e, f] = j.objects.columns.map((x) => S.columnBody(x));
  assert.equal(a.MaxLength, 100);
  assert.equal(b.MaxLength, 5000);
  assert.deepEqual([c.MinValue, c.MaxValue], [-5, 5]);
  assert.deepEqual([d.DefaultValue, d.RequiredLevel.Value], [true, 'ApplicationRequired']);
  assert.deepEqual([e.AutoNumberFormat, e.MaxLength], ['W-{SEQNUM:5}', 40]);
  assert.equal(f.DateTimeBehavior.Value, 'DateOnly');
});

// ---------------------------------------------------------------------------------------------------
// The job file
// ---------------------------------------------------------------------------------------------------

test('validation refuses what is not exactly right, never repairs it', () => {
  const col = { table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Thing', display: 'Thing' };
  const cases = [
    [{ ...job({ columns: [col] }), contract: 'x' }, /"contract" must be exactly/],
    [{ ...job({ columns: [col] }), colour: 'red' }, /unknown top-level key "colour"/],
    [{ ...job({ columns: [col] }), source: '' }, /"source" is required/],
    [{ ...job({ columns: [col] }), reason: 'two\nlines' }, /one line/],
    [{ ...job({ columns: [col] }), solution: undefined }, /"solution" is required/],
    [job({ columns: [col] }, { solution: { uniquename: 'has space' } }), /letters, digits and _/],
    [job({ columns: [{ ...col, schema_name: 'new_Thing' }] }), /must start with sbrm_/],
    [job({ columns: [{ ...col, type: 'lookup' }] }), /a lookup is created as a relationship/],
    [job({ columns: [{ ...col, max_length: 5000 }] }), /"max_length" must be a whole number from 1 to 4000/],
    [job({ columns: [{ ...col, type: 'yes_no', max_length: 5 }] }), /"max_length" does not apply to a yes_no column/],
    [job({ columns: [{ ...col, type: 'choice', options: ['A'], global_choice: 'sbrm_regions' }] }), /either "options".*or "global_choice"/],
    [job({ columns: [{ ...col, type: 'choice', options: ['A', 'a'] }] }), /listed twice/],
    [job({ columns: [{ ...col, type: 'autonumber', format: '#0001' }] }), /no \{SEQNUM:n\}/],
    [job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { type: 'memo' } }] }), /set: "type" cannot be changed here/],
    [job({ columns: [{ action: 'rename', table: 'sbrm_widget', column: 'sbrm_code' }] }), /"action" must be one of create, update, delete/],
    [job({ columns: [col, col] }), /appears twice in the job/],
    [job({ tables: [{ action: 'delete', table: 'sbrm_widget' }], columns: [col] }), /its table sbrm_widget is deleted by this job/],
    [job({ columns: [{ ...col, type: 'choice', options: ['A'] }], options: [{ target: { table: 'sbrm_widget', column: 'sbrm_thing' }, label: 'B' }] }), /put its options in the column's "options" list/],
    [job({ options: [{ target: { table: 'sbrm_widget' }, label: 'B' }] }), /target must be \{table, column\}/],
    [job({ relationships: [{ type: 'one_to_many', schema_name: 'sbrm_X', display: 'X', referenced: 'contact', referencing: 'sbrm_widget', entity1: 'contact' }] }), /"entity1" is for a many_to_many/],
    [job({ keys: [] }), /lists nothing to change/],
    [{ ...job({ columns: [col] }), proven_in: 'yesterday' }, /"proven_in" must be the plan id/],
  ];
  for (const [raw, re] of cases) {
    const r = validateSchemaJob(raw, { envs: ENVS });
    assert.ok(r.errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(r.errors)}`);
    assert.equal(r.job, undefined);
  }
});

test('intent must equal the engine\'s count of what the job asks for (else "intent does not match")', () => {
  const col = { table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Thing', display: 'Thing' };
  const bad = [
    { verb: 'develop', solution: 'SBRMAdHoc', objects: { columns: 2 } },
    { verb: 'write', solution: 'SBRMAdHoc', objects: { columns: 1 } },
    { verb: 'develop', solution: 'Other', objects: { columns: 1 } },
    { verb: 'develop', solution: 'SBRMAdHoc', objects: { columns: 1, tables: 1 } },
    { verb: 'develop', solution: 'SBRMAdHoc', objects: { columns: 1, flows: 0 } },
  ];
  for (const intent of bad) {
    const r = validateSchemaJob({ ...job({ columns: [col] }), intent }, { envs: ENVS });
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors));
    assert.match(r.errors[0], /^intent does not match/);
  }
  assert.deepEqual(validateSchemaJob({ ...job({ columns: [col] }), intent: { verb: 'develop', solution: 'SBRMAdHoc', objects: { columns: 1, tables: 0 } } }, { envs: ENVS }).errors, []);
});

// ---------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------

// The 10h live test, on the fake: a new solution, one table, four columns (text, choice, yes/no, a lookup
// to contact), one option insert and one relabel.
const BUILD = () => job({
  tables: [{ schema_name: 'sbrm_SchemaTest', display: 'Schema Test', plural: 'Schema Tests', description: 'Throwaway.', primary: { schema_name: 'sbrm_Name', display: 'Name' }, quick_create: false }],
  columns: [
    { table: 'sbrm_schematest', type: 'text', schema_name: 'sbrm_Note', display: 'Note', max_length: 200 },
    { table: 'sbrm_schematest', type: 'choice', schema_name: 'sbrm_Stage', display: 'Stage', options: ['New', 'Done'] },
    { table: 'sbrm_schematest', type: 'yes_no', schema_name: 'sbrm_Flag', display: 'Flag' },
  ],
  relationships: [{ type: 'one_to_many', schema_name: 'sbrm_ContactId', display: 'Contact', referenced: 'contact', referencing: 'sbrm_schematest', show_on_parent: 'Schema Tests' }],
  options: [
    { target: { table: 'sbrm_widget', column: 'sbrm_size' }, label: 'Medium' },
    { action: 'update', target: { table: 'sbrm_widget', column: 'sbrm_size' }, value: 338300001, label: 'Big' },
  ],
}, { solution: { uniquename: 'SBRMToolkitSchemaTest', friendlyname: 'SBRM Toolkit Schema Test' } });

test('plan: a new build lists every step in dependency order, with the pop-up computed from live reads', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, BUILD());
  onlyGets(dv);
  assert.deepEqual(p.steps.map((s) => `${s.object}.${s.action}`), [
    'solution.create', 'table.create', 'column.create', 'column.create', 'column.create', 'relationship.create', 'option.create', 'option.update',
  ]);
  assert.equal(p.kind, 'schema');
  assert.equal(p.mode, 'schema');
  assert.equal(p.access, 'admin');
  assert.deepEqual(p.refused, []);
  assert.deepEqual(p.publish, { entities: ['contact', 'sbrm_schematest', 'sbrm_widget'], optionsets: [] });
  assert.equal(p.steps[0].body['publisherid@odata.bind'], `/publishers(${PUB})`, 'the publisher comes from envs.json, never the job');
  assert.ok(p.steps.slice(1).filter((s) => s.object !== 'option').every((s) => s.headers.includes('MSCRM.SolutionUniqueName: SBRMToolkitSchemaTest')));
  assert.equal(p.steps.find((s) => s.object === 'option' && s.action === 'create').value, 100000000, 'the first value in the Donor App publisher series (prefix 10000, read live 10/7)');
  const out = schemaSummary(p);
  assert.match(out, /^Before you approve:\n {2}! Lasting: creates the table Schema Test\. Undo cannot remove it; only an admin delete can\./);
  assert.match(out, /Lasting: creates the column Note on Schema Test\./);
  assert.match(out, /Lasting: adds the option 'Medium' to Size on Widget\./);
  assert.doesNotMatch(out, /Not tried/, 'Donor App Dev has no dev copy of its own');
  assert.match(out, /\nAdd 1 table, 3 columns, 1 relationship and 1 option; change 1 option in the Donor App Dev \(solution SBRM Toolkit Schema Test\)\n/);
  assert.match(out, / {2}1\. create the solution SBRM Toolkit Schema Test \(SBRMToolkitSchemaTest\) under the SBRM publisher\n {2}2\. create the table Schema Test \(sbrm_schematest\), primary column Name \(text, max 100\); auditing on, change tracking on, quick create off/);
  assert.match(out, /add the column Stage \(sbrm_stage\) to Schema Test: choice: New, Done, optional/);
  assert.match(out, /add the lookup Contact \(sbrm_contactid\) on Schema Test, pointing at Contact/);
  assert.match(out, /relabel option 338300001 of Size on Widget: 'Large' -> 'Big'/);
  assert.match(out, /Then publish: contact, sbrm_schematest, sbrm_widget/);
  assert.match(out, /If a step fails, the steps after it are not run\./);
  assert.match(out, /\n\nReason given: Test change\.$/);
  assert.ok(/^[\x20-\x7e\n]*$/.test(out), 'plain ASCII');
  assert.ok(!new RegExp('[\\u2013\\u2014]').test(out + schemaDetail(p, { id: 'X' })), 'no em or en dashes');
  assert.match(schemaDetail(p, { id: 'X' }), /POST EntityDefinitions {2}\[MSCRM\.SolutionUniqueName: SBRMToolkitSchemaTest\]/);
});

test('plan lists ONLY what is missing or differs; the rest is "already in place"', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({
    columns: [
      { table: 'sbrm_widget', type: 'memo', schema_name: 'sbrm_Notes', display: 'Notes' },
      { table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' },
      { action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Code', max_length: 50 } },
    ],
    options: [{ target: { table: 'sbrm_widget', column: 'sbrm_size' }, label: 'small' }],
  }));
  assert.deepEqual(p.steps.map((s) => s.name), ['column Fresh (sbrm_fresh) on Widget']);
  assert.deepEqual(p.already.map((x) => x.why).sort(), ['already exists', 'already has these settings', 'already there (value 338300000)']);
  assert.match(schemaSummary(p), /Already in place, not changed: 3/);
});

test('re-planning a fully applied job plans nothing and says so', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, BUILD());
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied', JSON.stringify(r.rows.filter((x) => x.outcome !== 'written')));
  dv.calls.length = 0;
  const e = await refused(plan(dv, BUILD()));
  assert.equal(e.code, 'nothing_to_change');
  assert.match(e.message, /^nothing to change: every object in this job is already in place in the Donor App Dev/);
  onlyGets(dv);
});

// ---------------------------------------------------------------------------------------------------
// Levels (ruled 10/7) and the refusals for everyone
// ---------------------------------------------------------------------------------------------------

const ONE_COL = () => job({ columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }] });

test('levels: read and write are refused; develop may create and update', async () => {
  const r = await refused(plan(fakeSchemaDv({ email: 'reader@example.org' }), ONE_COL()));
  assert.equal(r.code, 'access_read');
  const w = await refused(plan(fakeSchemaDv({ email: 'writer@example.org' }), ONE_COL()));
  assert.equal(w.code, 'not_permitted');
  assert.match(w.message, /takes develop access/);
  const nobody = await refused(plan(fakeSchemaDv({ email: 'stranger@example.org' }), ONE_COL()));
  assert.equal(nobody.code, 'access_read', 'no row = read');
  const d = await plan(fakeSchemaDv({ email: 'dev2@example.org' }), job({
    columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }, { action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { max_length: 80 } }],
  }));
  assert.equal(d.access, 'develop');
  assert.equal(d.admin_only, false);
});

test('levels: every delete, alternate keys and the toolkit\'s own tables are admin only', async () => {
  const dev2 = () => fakeSchemaDv({ email: 'dev2@example.org' });
  const cases = [
    [job({ columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_notes' }] }), /every delete takes admin/],
    [job({ tables: [{ action: 'delete', table: 'sbrm_lonely' }] }), /every delete takes admin/],
    [job({ options: [{ action: 'delete', target: { table: 'sbrm_widget', column: 'sbrm_size' }, value: 338300000 }] }), /every delete takes admin/],
    [job({ relationships: [{ action: 'delete', schema_name: 'sbrm_contact_sbrm_widget_ContactId' }] }), /every delete takes admin/],
    [job({ keys: [{ table: 'sbrm_widget', schema_name: 'sbrm_CodeKey', display: 'Code', columns: ['sbrm_code'] }] }), /alternate keys take admin/],
    [job({ columns: [{ table: 'sbrm_dataversewritelog', type: 'text', schema_name: 'sbrm_Extra', display: 'Extra' }] }), /toolkit's own tables/],
    [job({ tables: [{ action: 'update', table: 'sbrm_dataversewritelog', set: { audit: false } }] }), /toolkit's own tables/],
  ];
  for (const [raw, re] of cases) {
    const dv = dev2();
    const e = await refused(plan(dv, raw));
    assert.equal(e.code, 'not_permitted', e.message);
    assert.match(e.message, /take admin access in the Donor App Dev; dev2 has develop/);
    assert.match(e.message, re);
    onlyGets(dv);
    const admin = await plan(fakeSchemaDv(), raw);
    assert.equal(admin.admin_only, true);
  }
});

test('levels: raising required level is develop on a full column, admin when rows are blank (counted)', async () => {
  const dev2 = fakeSchemaDv({ email: 'dev2@example.org' });
  const ok = await plan(dev2, job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { required: true } }] }));
  assert.match(schemaSummary(ok), /Required: optional -> required \(0 rows are blank/);
  const e = await refused(plan(dev2, job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_notes', set: { required: true } }] })));
  assert.equal(e.code, 'not_permitted');
  assert.match(e.message, /make Notes on Widget required: 2 rows have no value and each would fail its next save on a form/);
  const admin = await plan(fakeSchemaDv(), job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_notes', set: { required: true } }] }));
  assert.match(schemaSummary(admin), /Required: optional -> required \(2 rows are blank and would fail their next save on a form\)/);
});

test('refused for everyone: managed components, foreign or managed solutions, type changes, max length down', async () => {
  const cases = [
    [job({ columns: [{ action: 'update', table: 'contact', column: 'fullname', set: { display: 'Name' } }] }), 'not_permitted', /is managed/],
    [job({ tables: [{ action: 'update', table: 'msnfp_transaction', set: { audit: false } }] }), 'not_permitted', /is managed/],
    [job({ options: [{ target: { table: 'msnfp_transaction', column: 'msnfp_type' }, label: 'Pledge' }] }), 'not_permitted', /is managed/],
    [job({ options: [{ target: { global: 'msnfp_paymenttypes' }, label: 'Card' }] }), 'not_permitted', /is managed/],
    [job({ columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'F' }] }, { solution: { uniquename: 'msdyn_Nonprofit' } }), 'not_permitted', /is managed \(imported\)/],
    [job({ columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'F' }] }, { solution: { uniquename: 'VendorStuff' } }), 'not_permitted', /belongs to another publisher/],
    [job({ columns: [{ table: 'sbrm_widget', type: 'whole_number', schema_name: 'sbrm_Code', display: 'Code' }] }), 'not_permitted', /already exists as String, not whole_number\. A type change/],
    [job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { max_length: 20 } }] }), 'not_permitted', /would cut off existing text; refused for everyone/],
    [job({ tables: [{ schema_name: 'sbrm_Lonely', display: 'Lonely', plural: 'Lonelies', description: 'x', primary: { schema_name: 'sbrm_Name', display: 'Name' } }] }), 'invalid_job', /already exists .* but is not in the solution SBRMAdHoc: someone else built it/],
    [job({ columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'F' }] }, { solution: { uniquename: 'SBRMNotThere' } }), 'invalid_job', /does not exist .* give solution\.friendlyname to create it/],
    [job({ columns: [{ table: 'sbrm_nope', type: 'text', schema_name: 'sbrm_Fresh', display: 'F' }] }), 'table_missing', /there is no table sbrm_nope/],
    [job({ options: [{ target: { table: 'sbrm_widget', column: 'sbrm_region' }, label: 'East' }] }), 'invalid_job', /uses the global choice sbrm_regions; name it as \{"global": "sbrm_regions"\}/],
    [job({ columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_contactid' }] }), 'invalid_job', /is a lookup; delete its relationship instead/],
    [job({ columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_name' }] }), 'not_permitted', /primary column/],
  ];
  for (const [raw, code, re] of cases) {
    const dv = fakeSchemaDv();
    const e = await refused(plan(dv, raw));
    assert.equal(e.code, code, `${re}: ${e.message}`);
    assert.match(e.message, re);
    onlyGets(dv);
  }
});

// ---------------------------------------------------------------------------------------------------
// Severity (§10j) and "not tried in the dev copy" (§10d)
// ---------------------------------------------------------------------------------------------------

test('severity: deletes are "Can\'t be fully undone" with what they take, counted from live rows', async () => {
  const p = await plan(fakeSchemaDv(), job({
    columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_notes' }],
    options: [{ action: 'delete', target: { table: 'sbrm_widget', column: 'sbrm_size' }, value: 338300001 }],
  }));
  assert.deepEqual(p.severity.irreversible.sort(), [
    'deleting the column Notes on Widget removes its values in 1 rows',
    "removing the option 'Large' from Size on Widget blanks it on 2 rows",
  ]);
  assert.match(schemaSummary(p), /! Can't be fully undone: deleting the column Notes on Widget removes its values in 1 rows\./);
  assert.deepEqual(p.steps.map((s) => `${s.object}.${s.action}`), ['option.delete', 'column.delete'], 'children before parents, deletes last');
  assert.ok(p.steps.every((s) => s.before || s.options_before), 'the full definition (or option list) before is carried for every delete');
});

test('severity: "Not tried in Donor App Dev first" only for updates of live things in an app with a dev copy', async () => {
  const update = (over = {}) => job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }] }, { env: 'donorapp', ...over });
  const devDv = fakeSchemaDv();
  const readEnv = () => devDv;
  const p = await plan(fakeSchemaDv(), update(), { readEnv });
  assert.equal(p.severity.unproven, 'Not tried in Donor App Dev first');
  assert.match(schemaSummary(p), /! Not tried in Donor App Dev first\./);
  // The same change applied in the dev copy, logged as the log module writes it.
  const logIn = async (raw, planId) => {
    const r = await apply(await plan(devDv, { ...raw, env: 'fedev' }), devDv);
    assert.equal(r.outcome, 'applied');
    devDv.data.records.sbrm_dataversewritelogs.push({ sbrm_planid: planId, sbrm_outcome: 'applied', sbrm_entry: entryText({ ...r.entry, plan_id: planId }) });
  };
  await logIn(update(), '20261007-190000-12345678');
  const proven = await plan(fakeSchemaDv(), update({ proven_in: '20261007-190000-12345678' }), { readEnv });
  assert.equal(proven.severity.unproven, null);
  const wrong = await plan(fakeSchemaDv(), update({ proven_in: '20261007-190000-99999999' }), { readEnv });
  assert.match(wrong.severity.unproven, /plan 20261007-190000-99999999 is not in its Write Log as applied/);
  const additive = await plan(fakeSchemaDv(), job({ columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'F' }] }, { env: 'donorapp' }), { readEnv });
  assert.equal(additive.severity.unproven, null, 'additive changes never get the line');
});

test('proven_in must be the SAME change: an unrelated applied plan, or a rows plan, does not silence the line', async () => {
  const devDv = fakeSchemaDv();
  const readEnv = () => devDv;
  const other = job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_notes', set: { display: 'Remarks' } }] });
  const r = await apply(await plan(devDv, other), devDv);
  devDv.data.records.sbrm_dataversewritelogs.push({ sbrm_planid: '20261007-190000-0000aaaa', sbrm_outcome: 'applied', sbrm_entry: entryText({ ...r.entry, plan_id: 'x' }) });
  devDv.data.records.sbrm_dataversewritelogs.push({ sbrm_planid: '20261007-190000-0000bbbb', sbrm_outcome: 'applied', sbrm_entry: entryText({ ...r.entry, mode: 'update', plan_id: 'y' }) });
  const mine = (pid) => job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }] }, { env: 'donorapp', proven_in: pid });
  const diff = await plan(fakeSchemaDv(), mine('20261007-190000-0000aaaa'), { readEnv });
  assert.match(diff.severity.unproven, /was a different change: it did not make the same change to column:sbrm_widget\.sbrm_code \(Label\)/);
  const rows = await plan(fakeSchemaDv(), mine('20261007-190000-0000bbbb'), { readEnv });
  assert.match(rows.severity.unproven, /was a different change: it was not an app \(schema\) change/);
});

test('severity: Large over warn_rows objects', async () => {
  const cols = Array.from({ length: 4 }, (_, i) => ({ table: 'sbrm_widget', type: 'text', schema_name: `sbrm_Col${i}`, display: `Col ${i}` }));
  const p = await plan(fakeSchemaDv(), job({ columns: cols }), { warnRows: 3 });
  assert.equal(p.severity.large, true);
  assert.match(schemaSummary(p), /! Large change: 4 objects\./);
});

// ---------------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------------

test('apply: dependency order, the provisioning wait, publish of the touched components only, read-back, log entry', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, BUILD());
  dv.calls.length = 0;
  dv.provisionReads = 3; // the new table answers "does not exist" three times, then is ready
  sleeps = [];
  let shown = null;
  const r = await apply(p, dv, { confirm: (x) => { shown = x; return { approved: true }; } });
  assert.equal(r.outcome, 'applied', JSON.stringify(r.rows.map((x) => x.outcome)));
  assert.equal(shown.typed, undefined, 'no typed name (ruled 10/8)');
  assert.match(shown.title, /approve this app change in the Donor App Dev/);
  assert.deepEqual(writes(dv).map((c) => `${c.method} ${c.path}`), [
    'POST solutions', 'POST EntityDefinitions',
    "POST EntityDefinitions(LogicalName='sbrm_schematest')/Attributes", "POST EntityDefinitions(LogicalName='sbrm_schematest')/Attributes", "POST EntityDefinitions(LogicalName='sbrm_schematest')/Attributes",
    'POST RelationshipDefinitions', 'POST InsertOptionValue', 'POST UpdateOptionValue', 'POST PublishXml',
  ]);
  assert.deepEqual(sleeps, [10000, 10000, 10000], 'polled every 10 s until the table answered');
  assert.equal(writes(dv).at(-1).body.ParameterXml, '<importexportxml><entities><entity>contact</entity><entity>sbrm_schematest</entity><entity>sbrm_widget</entity></entities></importexportxml>');
  const e = r.entry;
  assert.equal(e.mode, 'schema');
  assert.equal(e.solution, 'SBRMToolkitSchemaTest');
  assert.ok(e.table.length <= 100);
  assert.equal(e.rows.length, 8);
  assert.ok(e.rows.every((x) => x.outcome === 'written'));
  assert.ok(e.rows.filter((x) => x.object !== 'solution').every((x) => /^0{8}-0{4}-4000-8000-\d{12}$/.test(x.id)), 'id = the MetadataId read back');
  assert.equal(e.rows[1].body.SchemaName, 'sbrm_SchemaTest', 'every object as sent');
  const relabel = e.rows.find((x) => x.object === 'option' && x.action === 'update');
  assert.deepEqual(relabel.changes, [{ label: 'Option 338300001', old_text: 'Large', new_text: 'Big' }]);
  assert.ok(relabel.before.options, 'the option list before is logged');
  assert.equal(dv.data.entities.sbrm_schematest.IsQuickCreateEnabled, false);
  assert.ok(dv.data.components.some((c) => c.objectid === dv.data.entities.sbrm_schematest.MetadataId && c.solutionid === dv.data.solutions.SBRMToolkitSchemaTest.solutionid));
  // The log module renders and keys it.
  const txt = entryText({ ...e, plan_id: 'P' });
  assert.match(txt, /table Schema Test \(sbrm_schematest\) `0{8}-/);
  assert.equal(rowFor({ ...e, plan_id: 'P' }, txt).sbrm_mode, 'schema');
});

test('apply: a table create that times out but lands is waited for, not called failed (a live finding 10/7)', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, BUILD());
  dv.tableTimeout = true;
  sleeps = [];
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied');
  assert.match(r.rows[1].note, /timed out on this computer, but the table landed/);
});

test('apply: a table that never becomes ready stops the run at the 5 minute ceiling', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, BUILD());
  dv.provisionReads = 1000;
  sleeps = [];
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied with problems');
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 5 * 60 * 1000);
  assert.match(r.rows[1].outcome, /^failed: the table was created but was not ready for columns after 5 minutes/);
  assert.ok(r.rows.slice(2).every((x) => x.outcome === 'not attempted: an earlier step failed'));
  assert.ok(!writes(dv).some((c) => c.path.endsWith('/Attributes') || c.path === 'PublishXml'), 'no column, no publish');
});

test('apply STOPS at the first failed step; the rest are not attempted; nothing is published', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, BUILD());
  dv.failOn = (c) => (c.body && c.body.SchemaName === 'sbrm_Stage' ? 'An unexpected error occurred.' : null);
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied with problems');
  assert.deepEqual(r.rows.map((x) => x.outcome.split(':')[0]), ['written', 'written', 'written', 'failed', 'not attempted', 'not attempted', 'not attempted', 'not attempted']);
  assert.equal(r.entry.publish.outcome, 'not attempted: an earlier step failed');
  assert.ok(!dv.data.attrs.sbrm_schematest.sbrm_flag);
  // Approving the same job again finishes it: the new plan lists only what is missing.
  dv.failOn = null;
  const again = await plan(dv, BUILD());
  assert.deepEqual(again.steps.map((s) => s.name), [
    'column Stage (sbrm_stage) on Schema Test', 'column Flag (sbrm_flag) on Schema Test', 'lookup Contact (sbrm_contactid) on Schema Test',
    "option 'Medium' of Size on Widget", 'option 338300001 of Size on Widget',
  ]);
});

test('apply: a read-back that misses right after the write is retried once after 45 s', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, ONE_COL());
  dv.hideOnce.add('sbrm_widget.sbrm_fresh');
  sleeps = [];
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied');
  assert.deepEqual(sleeps, [45000]);
  assert.match(r.rows[0].note, /ok after retry; first read: column not found/);
});

test('apply: a read-back that still misses after the retry is "read-back mismatch", never "written"', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ options: [{ action: 'update', target: { table: 'sbrm_widget', column: 'sbrm_size' }, value: 338300000, label: 'Tiny' }] }));
  dv.failOn = null;
  const orig = dv.metadata;
  dv.metadata = (m, pth, b, h) => (pth === 'UpdateOptionValue' ? orig(m, pth, { ...b, Label: { LocalizedLabels: [{ Label: 'Wrong', LanguageCode: 1033 }] } }, h) : orig(m, pth, b, h));
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied with problems');
  assert.match(r.rows[0].outcome, /^read-back mismatch: option 338300000 does not read 'Tiny'/);
});

test('apply: a delete runs on the approval alone (no typed name, ruled 10/8)', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_notes' }] }));
  let typed;
  const r = await apply(p, dv, { confirm: (x) => { typed = x.typed; return { approved: true }; } });
  assert.equal(typed, undefined, 'no typed name (ruled 10/8)');
  assert.equal(r.outcome, 'applied');
  assert.equal(dv.data.attrs.sbrm_widget.sbrm_notes, undefined);
  assert.equal(r.rows[0].before.LogicalName, 'sbrm_notes', 'the full definition before is logged');
  const dv2 = fakeSchemaDv();
  const p2 = await plan(dv2, job({ columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_notes' }, { action: 'delete', table: 'sbrm_widget', column: 'sbrm_code' }] }));
  await apply(p2, dv2, { confirm: (x) => { typed = x.typed; return { approved: false }; } });
  assert.equal(typed, undefined, 'no typed name (ruled 10/8)');
});

test('apply re-checks identity, age and level before anything is written', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, ONE_COL());
  const noPopup = () => { throw new Error('no pop-up'); };
  const someoneElse = fakeSchemaDv({ email: 'dev2@example.org', data: dv.data });
  let e = await refused(apply(p, someoneElse, { confirm: noPopup }), ApplyRefused);
  assert.equal(e.code, 'different_person');
  e = await refused(apply({ ...p, created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, dv, { confirm: noPopup }), ApplyRefused);
  assert.equal(e.code, 'stale_plan');
  const demoted = { people: { 'dgross@example.org': { envs: { fedev: 'write' } } } };
  e = await refused(apply(p, dv, { access: demoted, confirm: noPopup }), ApplyRefused);
  assert.equal(e.code, 'access_revoked');
  // An admin-only plan needs admin at apply too.
  const dp = await plan(dv, job({ columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_notes' }] }));
  e = await refused(apply(dp, dv, { access: { people: { 'dgross@example.org': { envs: { fedev: 'develop' } } } }, confirm: noPopup }), ApplyRefused);
  assert.equal(e.code, 'access_revoked');
  assert.match(e.message, /this change needs admin/);
  assert.deepEqual(writes(dv), []);
});

test('apply refuses the WHOLE change when anything the plan read has moved (snapshot_moved)', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({
    columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }, { action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }],
  }));
  dv.data.attrs.sbrm_widget.sbrm_code.Description = { LocalizedLabels: [{ Label: 'edited in the portal', LanguageCode: 1033 }], UserLocalizedLabel: { Label: 'edited in the portal', LanguageCode: 1033 } };
  const file = planFile();
  const e = await refused(apply(p, dv, { confirm: () => { throw new Error('no pop-up'); } }, file), ApplyRefused);
  assert.equal(e.code, 'snapshot_moved');
  assert.match(e.message, /column Code \(sbrm_code\) on Widget: changed since the plan/);
  assert.deepEqual(writes(dv), [], 'not even the unaffected create ran');
  assert.ok(!fs.existsSync(file), 'the stale plan is consumed');
  // An object created by hand since the plan moves too.
  const dv2 = fakeSchemaDv();
  const p2 = await plan(dv2, ONE_COL());
  dv2.data.attrs.sbrm_widget.sbrm_fresh = { ...dv2.data.attrs.sbrm_widget.sbrm_code, LogicalName: 'sbrm_fresh' };
  assert.equal((await refused(apply(p2, dv2), ApplyRefused)).code, 'snapshot_moved');
});

test('apply: a column made required while rows went blank since the plan takes admin', async () => {
  const dv = fakeSchemaDv({ email: 'dev2@example.org' });
  const p = await plan(dv, job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { required: true } }] }));
  dv.data.records.sbrm_widgets[0].sbrm_code = null;
  const e = await refused(apply(p, dv), ApplyRefused);
  assert.equal(e.code, 'not_permitted');
  assert.match(e.message, /this change needs admin access .*\n {2}make Code on sbrm_widget required: 1 rows have no value/);
  assert.deepEqual(writes(dv), []);
});

test('apply refuses severity_grew: the change written is never more serious than the one approved', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, ONE_COL());
  const smaller = { ...p, severity: { ...p.severity, lasting: [], lines: [] } }; // as if the plan had said "routine"
  const e = await refused(apply(smaller, dv, { confirm: () => { throw new Error('no pop-up'); } }), ApplyRefused);
  assert.equal(e.code, 'severity_grew');
  assert.deepEqual(writes(dv), []);
});

test('cancel writes nothing and returns a cancelled entry', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, ONE_COL());
  const r = await apply(p, dv, { confirm: () => ({ approved: false, note: 'not now' }) });
  assert.equal(r.outcome, 'cancelled');
  assert.equal(r.entry.outcome, 'cancelled');
  assert.deepEqual(r.entry.rows, []);
  assert.equal(r.entry.note, 'not now');
  assert.deepEqual(writes(dv), []);
});

test('options: add then reorder in one job is worked out against the running list', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ options: [
    { target: { global: 'sbrm_regions' }, label: 'East' },
    { action: 'reorder', target: { global: 'sbrm_regions' }, order: [100000000, 338300000, 338300001] },
  ] }));
  assert.match(schemaSummary(p), /add the option 'East' \(100000000\) to the global choice Regions \(sbrm_regions\), shared by every column that uses it/);
  assert.match(schemaSummary(p), /reorder the global choice Regions .*: East, North, South/);
  assert.deepEqual(p.publish, { entities: [], optionsets: ['sbrm_regions'] });
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied');
  assert.deepEqual(dv.data.globals.sbrm_regions.Options.map((o) => o.Value), [100000000, 338300000, 338300001]);
  const bad = await refused(plan(fakeSchemaDv(), job({ options: [{ action: 'reorder', target: { global: 'sbrm_regions' }, order: [338300001] }] })));
  assert.match(bad.message, /must list every option value exactly once/);
});

test('keys (admin): created, read back with the index status reported', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ keys: [{ table: 'sbrm_widget', schema_name: 'sbrm_CodeKey', display: 'Code', columns: ['sbrm_code'] }] }));
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied with problems', 'an index still building is not done');
  assert.equal(r.rows[0].outcome, 'pending (index building)');
  assert.equal(r.rows[0].index_status, 'Pending');
  const dvA = fakeSchemaDv();
  dvA.keyStatus = 'Active';
  assert.equal((await apply(await plan(dvA, job({ keys: [{ table: 'sbrm_widget', schema_name: 'sbrm_CodeKey', display: 'Code', columns: ['sbrm_code'] }] })), dvA)).rows[0].outcome, 'written');
  const dv2 = fakeSchemaDv();
  dv2.keyStatus = 'Failed';
  const r2 = await apply(await plan(dv2, job({ keys: [{ table: 'sbrm_widget', schema_name: 'sbrm_CodeKey', display: 'Code', columns: ['sbrm_code'] }] })), dv2);
  assert.match(r2.rows[0].outcome, /read-back mismatch: Dataverse could not build the index/);
});

test('relationships: many-to-many create, and an admin delete of a lookup relationship', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ relationships: [{ type: 'many_to_many', schema_name: 'sbrm_contact_sbrm_widget', entity1: 'contact', entity2: 'sbrm_widget' }] }));
  assert.equal((await apply(p, dv)).outcome, 'applied');
  const d = await plan(dv, job({ relationships: [{ action: 'delete', schema_name: 'sbrm_contact_sbrm_widget_ContactId' }] }));
  assert.match(schemaSummary(d), /DELETE the relationship sbrm_contact_sbrm_widget_ContactId and its lookup column sbrm_contactid on sbrm_widget, with the links in 1 rows/);
  const r = await apply(d, dv, { confirm: (x) => { assert.equal(x.typed, undefined, 'no typed name (ruled 10/8)'); return { approved: true }; } });
  assert.equal(r.outcome, 'applied');
  assert.equal(dv.data.attrs.sbrm_widget.sbrm_contactid, undefined);
});

test('a table settings change PUTs the FULL definition read at plan, with MergeLabels', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ tables: [{ action: 'update', table: 'sbrm_widget', set: { plural: 'Widgetry', quick_create: true } }] }));
  const s = p.steps[0];
  assert.deepEqual(s.headers, ['MSCRM.SolutionUniqueName: SBRMAdHoc', 'MSCRM.MergeLabels: true']);
  assert.equal(s.body.PrimaryIdAttribute, 'sbrm_widgetid', 'not a partial body');
  assert.equal(s.body['@odata.type'], 'Microsoft.Dynamics.CRM.EntityMetadata');
  assert.equal(s.body['@odata.context'], undefined);
  assert.match(schemaSummary(p), /Plural label: Widgets -> Widgetry\n {7}Quick create: off -> on/);
  assert.equal((await apply(p, dv)).outcome, 'applied');
  assert.equal(dv.data.entities.sbrm_widget.DisplayCollectionName.UserLocalizedLabel.Label, 'Widgetry');
});

// ---------------------------------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------------------------------

const roundTrip = (entry) => JSON.parse(JSON.stringify({ ...entry, plan_id: '20261007-200000-aaaaaaaa' }));

test('revert of a column settings change: PUT of the logged before, applied through the same pop-up', async () => {
  const dv = fakeSchemaDv({ email: 'dev2@example.org' });
  const p = await plan(dv, job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code', max_length: 80 } }] }));
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied');
  assert.equal(dv.data.attrs.sbrm_widget.sbrm_code.MaxLength, 80);
  dv.calls.length = 0;
  const rp = await planSchemaRevert(dv, roundTrip(r.entry), { envs: ENVS, access: ACCESS });
  onlyGets(dv);
  rp.created = new Date().toISOString();
  assert.equal(rp.reverts_plan_id, '20261007-200000-aaaaaaaa');
  assert.match(schemaSummary(rp), /^Undo plan 20261007-200000-aaaaaaaa: Change 1 column in the Donor App Dev \(solution SBRM Ad-Hoc Changes\)/);
  assert.match(schemaSummary(rp), /Label: Widget Code -> Code\n/);
  assert.doesNotMatch(schemaSummary(rp), /Max length: 80 -> 50/, 'an undo never lowers max length (it could cut off text)');
  assert.match(schemaSummary(rp), /Left out, will NOT be changed \(1\):\n {2}column Widget Code \(sbrm_code\) on sbrm_widget: its max length stays 80/);
  const back = await apply(rp, dv);
  assert.equal(back.outcome, 'applied', JSON.stringify(back.rows));
  assert.equal(back.entry.reverts_plan_id, '20261007-200000-aaaaaaaa');
  assert.equal(dv.data.attrs.sbrm_widget.sbrm_code.MaxLength, 80);
  assert.equal(dv.data.attrs.sbrm_widget.sbrm_code.DisplayName.UserLocalizedLabel.Label, 'Code');
});

test('revert of an option relabel and a reorder uses the reverse actions; creates stay', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({
    columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }],
    options: [
      { action: 'update', target: { table: 'sbrm_widget', column: 'sbrm_size' }, value: 338300000, label: 'Tiny' },
      { action: 'reorder', target: { table: 'sbrm_widget', column: 'sbrm_size' }, order: [338300001, 338300000] },
    ],
  }));
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied');
  const rp = await planSchemaRevert(dv, roundTrip(r.entry), { envs: ENVS, access: ACCESS });
  rp.created = new Date().toISOString();
  assert.deepEqual(rp.steps.map((s) => s.path), ['UpdateOptionValue', 'OrderOption']);
  assert.match(schemaSummary(rp), /Stays as it is \(1\): undo does not delete; only an admin delete removes it\.\n {4}the column sbrm_widget: stays; only an admin delete removes it/, 'named from the request, never the row text');
  assert.equal((await apply(rp, dv)).outcome, 'applied');
  assert.deepEqual(dv.data.optionSets['sbrm_widget.sbrm_size'].Options.map((o) => [o.Value, o.Label.UserLocalizedLabel.Label]), [[338300000, 'Small'], [338300001, 'Large']]);
});

test('revert leaves out what changed since, and refuses when that leaves nothing', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }] }));
  const r = await apply(p, dv);
  dv.data.attrs.sbrm_widget.sbrm_code.MaxLength = 75; // someone changed it in the portal since
  const e = await refused(planSchemaRevert(dv, roundTrip(r.entry), { envs: ENVS, access: ACCESS }));
  assert.equal(e.code, 'nothing_to_undo');
  assert.match(e.message, /changed since that change was made, so it is left as it is/);
});

test('revert refuses a delete, naming where the definition before is kept', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_notes' }] }));
  const r = await apply(p, dv);
  dv.calls.length = 0;
  const e = await refused(planSchemaRevert(dv, roundTrip(r.entry), { envs: ENVS, access: ACCESS }));
  assert.equal(e.code, 'nothing_to_undo');
  assert.match(e.message, /A delete cannot be undone by revert/);
  assert.match(e.message, /Dataverse Write Log entry \(row "20261007-200000-aaaaaaaa", rows\[\]\.before\)/);
  onlyGets(dv);
});

test('revert refuses a plan that is not a schema change or that wrote nothing', async () => {
  const dv = fakeSchemaDv();
  assert.equal((await refused(planSchemaRevert(dv, { mode: 'update', outcome: 'applied', rows: [] }, { envs: ENVS, access: ACCESS }))).code, 'nothing_to_undo');
  assert.equal((await refused(planSchemaRevert(dv, { mode: 'schema', outcome: 'cancelled', rows: [] }, { envs: ENVS, access: ACCESS }))).code, 'nothing_to_undo');
});

test('the plan step never issues a non-GET, across every kind and action', async () => {
  const dv = fakeSchemaDv();
  await plan(dv, BUILD());
  await plan(dv, job({
    tables: [{ action: 'update', table: 'sbrm_widget', set: { audit: false } }],
    columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_notes' }],
    relationships: [{ action: 'delete', schema_name: 'sbrm_contact_sbrm_widget_ContactId' }],
    keys: [{ table: 'sbrm_widget', schema_name: 'sbrm_CodeKey', display: 'Code', columns: ['sbrm_code'] }],
    options: [{ target: { global: 'sbrm_regions' }, label: 'West' }],
  }));
  assert.ok(dv.calls.length > 20);
  onlyGets(dv);
});

// ---------------------------------------------------------------------------------------------------
// The 10/7 blind review: apply re-derives from the steps, recounts, logs a table whole, measures the
// real entry, fingerprints the read it built from, never drops the typed name, publishes no one's drafts
// silently.
// ---------------------------------------------------------------------------------------------------

const DEL_NOTES = () => job({ columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_notes' }] });
const asDevelop = { people: { 'dgross@example.org': { envs: { fedev: 'develop' } } } };

test('review 1: apply works out the level from the STEPS, never from plan.admin_only', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, DEL_NOTES());
  const lying = { ...p, admin_only: false, admin_why: [], access: 'develop' };
  const e = await refused(apply(lying, dv, { access: asDevelop, confirm: () => { throw new Error('no pop-up'); } }), ApplyRefused);
  assert.equal(e.code, 'not_permitted');
  assert.match(e.message, /this change needs admin access .*\n {2}column Notes \(sbrm_notes\) on Widget: every delete takes admin/);
  // The same for a key and for the toolkit's own tables.
  const kp = await plan(dv, job({ keys: [{ table: 'sbrm_widget', schema_name: 'sbrm_CodeKey', display: 'Code', columns: ['sbrm_code'] }] }));
  assert.match((await refused(apply({ ...kp, admin_only: false }, dv, { access: asDevelop }), ApplyRefused)).message, /alternate keys take admin/);
  const tp = await plan(dv, job({ columns: [{ table: 'sbrm_dataversewritelog', type: 'text', schema_name: 'sbrm_Extra', display: 'Extra' }] }));
  assert.match((await refused(apply({ ...tp, admin_only: false }, dv, { access: asDevelop }), ApplyRefused)).message, /sbrm_dataversewritelog is one of the toolkit's own tables/);
  assert.deepEqual(writes(dv), []);
});

test('review 1: a step whose label does not match its request is refused as tampered', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, DEL_NOTES());
  const relabelled = { ...p, steps: p.steps.map((s) => ({ ...s, action: 'update' })) };
  const e = await refused(apply(relabelled, dv), ApplyRefused);
  assert.equal(e.code, 'plan_tampered');
  assert.deepEqual(writes(dv), []);
});

test('review 1 + 6: a delete with blank labels still applies from the live names; no typed name (ruled 10/8)', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, DEL_NOTES());
  let typed;
  await apply({ ...p, steps: p.steps.map((s) => ({ ...s, display: '', name: '' })) }, dv, { confirm: (x) => { typed = x.typed; return { approved: false }; } });
  assert.equal(typed, undefined, 'no typed name (ruled 10/8)');
  const dv2 = fakeSchemaDv();
  dv2.data.attrs.sbrm_widget.sbrm_notes.DisplayName = { LocalizedLabels: [{ Label: '', LanguageCode: 1033 }], UserLocalizedLabel: { Label: '', LanguageCode: 1033 } };
  const p2 = await plan(dv2, DEL_NOTES());
  assert.equal(p2.steps[0].display, 'sbrm_notes');
  await apply(p2, dv2, { confirm: (x) => { typed = x.typed; return { approved: false }; } });
  assert.equal(typed, undefined, 'no typed name (ruled 10/8)');
});

test('review 2: a delete that takes MORE at apply than at plan is refused (severity_grew), with the counts', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, DEL_NOTES());
  assert.equal(p.steps[0].count, 1);
  for (const r of dv.data.records.sbrm_widgets) r.sbrm_notes = 'filled in since';
  const file = planFile();
  const e = await refused(apply(p, dv, { confirm: () => { throw new Error('no pop-up'); } }, file), ApplyRefused);
  assert.equal(e.code, 'severity_grew');
  assert.match(e.message, /column Notes \(sbrm_notes\) on Widget: 1 at plan, 3 now/);
  assert.deepEqual(writes(dv), []);
  // An option delete and a relationship delete are recounted the same way.
  const dv2 = fakeSchemaDv();
  const p2 = await plan(dv2, job({ options: [{ action: 'delete', target: { table: 'sbrm_widget', column: 'sbrm_size' }, value: 338300000 }] }));
  dv2.data.records.sbrm_widgets[1].sbrm_size = 338300000;
  assert.equal((await refused(apply(p2, dv2), ApplyRefused)).code, 'severity_grew');
  const dv3 = fakeSchemaDv();
  const p3 = await plan(dv3, job({ relationships: [{ action: 'delete', schema_name: 'sbrm_contact_sbrm_widget_ContactId' }] }));
  dv3.data.records.sbrm_widgets[2]._sbrm_contactid_value = 'c1';
  assert.equal((await refused(apply(p3, dv3), ApplyRefused)).code, 'severity_grew');
  // A count that went DOWN is fine, and the pop-up shows the live one.
  const dv4 = fakeSchemaDv();
  const p4 = await plan(dv4, DEL_NOTES());
  dv4.data.records.sbrm_widgets[0].sbrm_notes = null;
  let shown;
  await apply(p4, dv4, { confirm: (x) => { shown = x.summaryText; return { approved: false }; } });
  assert.match(shown, /removes its values in 0 rows/);
});

test('review 3: a table delete logs the WHOLE table: columns, keys, relationships, choice options', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ tables: [{ action: 'delete', table: 'sbrm_widget' }] }));
  const b = p.steps[0].before;
  assert.equal(b.LogicalName, 'sbrm_widget');
  assert.deepEqual(b.Attributes.map((a) => a.LogicalName).sort(), ['sbrm_code', 'sbrm_contactid', 'sbrm_name', 'sbrm_notes', 'sbrm_region', 'sbrm_size', 'sbrm_widgetid']);
  assert.ok(Array.isArray(b.Keys));
  assert.deepEqual(b.ManyToOneRelationships.map((r) => r.SchemaName), ['sbrm_contact_sbrm_widget_ContactId']);
  assert.deepEqual(b.OptionSets.sbrm_size.Options.map((o) => o.Value), [338300000, 338300001]);
  const r = await apply(p, dv, { confirm: (x) => { assert.equal(x.typed, undefined, 'no typed name (ruled 10/8)'); return { approved: true }; } });
  assert.equal(r.outcome, 'applied');
  assert.equal(r.entry.rows[0].before.Attributes.length, 7, 'the log row carries it');
});

test('review 4: the size check measures the entry text the log writes, with room for the after', async () => {
  const big = (n) => {
    const dv = fakeSchemaDv();
    const t = 'x'.repeat(n);
    dv.data.attrs.sbrm_widget.sbrm_code.Description = { LocalizedLabels: [{ Label: t, LanguageCode: 1033 }], UserLocalizedLabel: { Label: t, LanguageCode: 1033 } };
    return dv;
  };
  const upd = job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }] });
  // ~200k characters per copy: the compact plan (before + body, ~800k) fits under the old 900k check,
  // but the log entry (before + body + after) does not fit the 1,000,000 a row holds.
  const e = await refused(plan(big(200000), upd));
  assert.equal(e.code, 'too_big');
  assert.match(e.message, /log entry .* would be [\d,]+ characters, over the 1,000,000 one Write Log row holds/);
  await plan(big(50000), upd); // fits
});

test('review 5: the fingerprint is the read the PUT was built from; a change landing mid-plan is caught', async () => {
  const dv = fakeSchemaDv();
  let reads = 0;
  dv.afterGet = (p) => {
    if (p === "EntityDefinitions(LogicalName='sbrm_widget')/Attributes(LogicalName='sbrm_code')" && (reads += 1) === 1) {
      // someone's portal edit lands right after the read (a field no rule looks at: only the fingerprint can catch it)
      dv.data.attrs.sbrm_widget.sbrm_code.Description = { LocalizedLabels: [{ Label: 'portal edit', LanguageCode: 1033 }], UserLocalizedLabel: { Label: 'portal edit', LanguageCode: 1033 } };
    }
  };
  // The body was built from the first read; the plan reads again to show it and sees the move: refused,
  // never a plan that would PUT the old description back over the portal edit.
  const e = await refused(plan(dv, job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }] })));
  assert.equal(e.code, 'snapshot_moved');
  assert.match(e.message, /the app changed while this plan was being made/);
  dv.afterGet = null;
  assert.deepEqual(writes(dv), []);
  // A move AFTER the plan is caught by apply's fingerprint of that same first read.
  const p = await plan(dv, job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }] }));
  dv.data.attrs.sbrm_widget.sbrm_code.Description = { LocalizedLabels: [{ Label: 'second edit', LanguageCode: 1033 }], UserLocalizedLabel: { Label: 'second edit', LanguageCode: 1033 } };
  assert.equal((await refused(apply(p, dv), ApplyRefused)).code, 'snapshot_moved');
  assert.equal(dv.data.attrs.sbrm_widget.sbrm_code.Description.UserLocalizedLabel.Label, 'second edit');
});

test('review 7: a delete read back with a non-404 error is "could not confirm", never written', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, DEL_NOTES());
  dv.getFails = (path) => (dv.calls.some((c) => c.method === 'DELETE') && /Attributes\(LogicalName='sbrm_notes'\)$/.test(path) ? 'Too many requests' : null);
  sleeps = [];
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied with problems');
  assert.match(r.rows[0].outcome, /^read-back mismatch: could not confirm it is gone \(.*Too many requests/);
  assert.deepEqual(sleeps, [45000], 'retried once first');
});

test('review 9: publishing a table names anyone\'s unpublished form or view edits on it, re-checked at apply', async () => {
  const col = () => job({ columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }] });
  const dv = fakeSchemaDv();
  dv.data.forms[0].draft = '<form>main, half-edited</form>';
  dv.data.views.push({ savedqueryid: 'v0000000-0000-0000-0000-000000000002', name: 'New Draft View', returnedtypecode: 'sbrm_widget', fetchxml: '<fetch/>', layoutxml: '<grid/>', unpublishedOnly: true });
  const p = await plan(dv, col());
  assert.match(schemaSummary(p), /! Can't be fully undone: publishing sbrm_widget also publishes unpublished edits to: form Widget main, view New Draft View\./);
  onlyGets(dv);
  const unread = fakeSchemaDv();
  unread.formsUnreadable = true;
  assert.match(schemaSummary(await plan(unread, col())), /publishing sbrm_widget may also publish unpublished edits to its forms or views \(they could not be checked\)/);
  // A draft left after the plan grows the change: refused.
  const dv2 = fakeSchemaDv();
  const p2 = await plan(dv2, col());
  assert.doesNotMatch(schemaSummary(p2), /unpublished/);
  dv2.data.views[0].draft = '<fetch top="5"/>';
  const e = await refused(apply(p2, dv2, { confirm: () => { throw new Error('no pop-up'); } }), ApplyRefused);
  assert.equal(e.code, 'severity_grew');
  assert.deepEqual(writes(dv2), []);
  // A table this plan creates has no drafts to check.
  const b = await plan(fakeSchemaDv(), BUILD());
  assert.ok(!b.severity.irreversible.some((x) => /sbrm_schematest/.test(x)));
});

// ---------------------------------------------------------------------------------------------------
// The 10/7 blind re-verify (round 2)
// ---------------------------------------------------------------------------------------------------

const CODE_LABEL = () => job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }] });
const noPopup = () => { throw new Error('no pop-up'); };

test('re-verify 1: a PUT body that changes more than the plan shows is refused (plan_tampered)', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, CODE_LABEL());
  const s = p.steps[0];
  const sneaky = { ...p, steps: [{ ...s, body: { ...s.body, IsAuditEnabled: { ...s.body.IsAuditEnabled, Value: false } } }] };
  const e = await refused(apply(sneaky, dv, { confirm: noPopup }), ApplyRefused);
  assert.equal(e.code, 'plan_tampered');
  assert.match(e.message, /column Code \(sbrm_code\) on Widget: what the plan shows is not what it would send/);
  assert.deepEqual(writes(dv), []);
  // A body changing a field the pop-up never lists (outside the shown fields) is refused too.
  const hidden = { ...p, steps: [{ ...s, body: { ...s.body, IsSecured: true } }] };
  assert.match((await refused(apply(hidden, dv, { confirm: noPopup }), ApplyRefused)).message, /its request changes more than the plan would show/);
});

test('re-verify 1: stored lines and "old -> new" must match what the requests do; the pop-up shows the rendered ones', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({
    columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }, { action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }],
    options: [{ action: 'update', target: { table: 'sbrm_widget', column: 'sbrm_size' }, value: 338300000, label: 'Tiny' }],
  }));
  const edit = (i, patch) => ({ ...p, steps: p.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const create = p.steps.findIndex((s) => s.object === 'column' && s.action === 'create');
  const upd = p.steps.findIndex((s) => s.object === 'column' && s.action === 'update');
  const opt = p.steps.findIndex((s) => s.object === 'option');
  const cases = [
    edit(create, { line: 'add a harmless note' }),
    edit(create, { body: { ...p.steps[create].body, MaxLength: 4000 } }), // the line says max 100
    edit(create, { lasting: 'nothing lasting' }),
    edit(upd, { changes: [{ field: 'DisplayName', label: 'Label', old: 'Code', new: 'Something else', old_text: 'Code', new_text: 'Something else' }] }),
    edit(opt, { body: { ...p.steps[opt].body, Label: S.label('Huge') } }), // the line says 'Tiny'
  ];
  for (const t of cases) {
    const e = await refused(apply(t, dv, { confirm: noPopup }), ApplyRefused);
    assert.equal(e.code, 'plan_tampered', e.message);
  }
  let shown;
  const r = await apply(p, dv, { confirm: (x) => { shown = x.summaryText; return { approved: true }; } });
  assert.equal(r.outcome, 'applied');
  assert.match(shown, /add the column Fresh \(sbrm_fresh\) to Widget: text, max 100 characters, optional/);
  assert.match(shown, /change the column Code \(sbrm_code\) on Widget\n {7}Label: Code -> Widget Code/);
  assert.match(shown, /relabel option 338300000 of Size on Widget: 'Small' -> 'Tiny'/);
});

test('re-verify 1: options run in job order, so "delete, add, then reorder" runs as it was planned', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ options: [
    { action: 'delete', target: { global: 'sbrm_regions' }, value: 338300000 },
    { target: { global: 'sbrm_regions' }, label: 'East' },
    { action: 'reorder', target: { global: 'sbrm_regions' }, order: [100000000, 338300001] },
  ] }));
  assert.deepEqual(p.steps.map((s) => s.path), ['DeleteOptionValue', 'InsertOptionValue', 'OrderOption']);
  const r = await apply(p, dv);
  assert.equal(r.outcome, 'applied', JSON.stringify(r.rows.map((x) => x.outcome)));
  assert.deepEqual(dv.data.globals.sbrm_regions.Options.map((o) => o.Value), [100000000, 338300001]);
});

test('re-verify 2: proven_in matches on CONTENT: a dev label change does not prove a live "make it required"', async () => {
  const devDv = fakeSchemaDv();
  const readEnv = () => devDv;
  const log = async (raw, pid) => {
    const r = await apply(await plan(devDv, raw), devDv);
    assert.equal(r.outcome, 'applied');
    devDv.data.records.sbrm_dataversewritelogs.push({ sbrm_planid: pid, sbrm_outcome: 'applied', sbrm_entry: entryText({ ...r.entry, plan_id: pid }) });
  };
  await log(CODE_LABEL(), '20261007-190000-00000001');
  await log(job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { required: true } }] }), '20261007-190000-00000002');
  const live = (set, pid) => job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set }] }, { env: 'donorapp', proven_in: pid });
  const req = await plan(fakeSchemaDv(), live({ required: true }, '20261007-190000-00000001'), { readEnv });
  assert.match(req.severity.unproven, /was a different change: it did not make the same change to column:sbrm_widget\.sbrm_code \(Required\)/);
  assert.equal((await plan(fakeSchemaDv(), live({ required: true }, '20261007-190000-00000002'), { readEnv })).severity.unproven, null);
  const otherLabel = await plan(fakeSchemaDv(), live({ display: 'Code Number' }, '20261007-190000-00000001'), { readEnv });
  assert.match(otherLabel.severity.unproven, /did not make the same change .*\(Label\)/, 'same column, different new label');
});

test('re-verify 3: the size probe pads every row to at least what apply can ever write into it', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, BUILD());
  const probe = S.entryProbe(p, p.identity);
  assert.ok(probe.rows.every((r) => r.outcome.length >= S.OUTCOME_MAX && r.note.length >= S.NOTE_MAX));
  assert.ok(probe.publish.outcome.length >= S.OUTCOME_MAX);
  // ...and apply never writes more than that, however long Dataverse's error is.
  dv.failOn = (c) => (/\/Attributes$/.test(c.path) ? `Bad request ${'z'.repeat(5000)}` : null);
  sleeps = [];
  const r = await apply(p, dv);
  for (const row of r.rows) {
    assert.ok(row.outcome.length <= S.OUTCOME_MAX, `${row.outcome.length}`);
    assert.ok(!row.note || row.note.length <= S.NOTE_MAX);
  }
  assert.match(r.rows[2].outcome, /^failed: Bad request z+\.\.\.$/);
});

test('re-verify 1: the pop-up shows the "old -> new" worked out at apply (a live blank count), not the plan\'s', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { required: true } }] }));
  assert.match(schemaSummary(p), /required \(0 rows are blank/);
  dv.data.records.sbrm_widgets[0].sbrm_code = null;
  dv.data.records.sbrm_widgets[1].sbrm_code = null;
  let shown;
  await apply(p, dv, { confirm: (x) => { shown = x.summaryText; return { approved: false }; } });
  assert.match(shown, /Required: optional -> required \(2 rows are blank and would fail their next save on a form\)/);
});

test('re-verify 4: unpublished table or column LABEL edits on a published table are named; unreadable says so', async () => {
  const col = () => job({ columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }] });
  const dv = fakeSchemaDv();
  dv.data.labelDrafts = { 'sbrm_widget.sbrm_notes': 'Remarks (draft)', sbrm_widget: 'Gadget' };
  assert.match(schemaSummary(await plan(dv, col())), /publishing sbrm_widget also publishes unpublished edits to: column label Remarks \(draft\) \(sbrm_notes\), table label Gadget\./);
  const unread = fakeSchemaDv();
  unread.labelsUnreadable = true;
  assert.match(schemaSummary(await plan(unread, col())), /publishing sbrm_widget may also publish unpublished edits to its table or column labels \(they could not be checked\)/);
  // A label draft left after the plan grows the change.
  const dv2 = fakeSchemaDv();
  const p2 = await plan(dv2, col());
  dv2.data.labelDrafts = { 'sbrm_widget.sbrm_code': 'Draft Code' };
  assert.equal((await refused(apply(p2, dv2, { confirm: noPopup }), ApplyRefused)).code, 'severity_grew');
  assert.deepEqual(writes(dv2), []);
});

// ---------------------------------------------------------------------------------------------------
// Round 3 (blind adversarial pass on 1.10.0)
// ---------------------------------------------------------------------------------------------------

const FRESH_CHOICE = () => ({ table: 'sbrm_widget', type: 'choice', schema_name: 'sbrm_Tier', display: 'Tier', options: ['Low', 'High'] });

test('r3-1: choice values come from the env publisher prefix (Donor App 10000, HGS 33830), never a constant', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, job({ columns: [FRESH_CHOICE()] }));
  assert.deepEqual(p.steps[0].body.OptionSet.Options.map((o) => o.Value), [100000000, 100000001]);
  assert.equal((await apply(p, dv)).outcome, 'applied', 'read back against the same series');
  const hgs = fakeSchemaDv();
  const h = await plan(hgs, job({ columns: [FRESH_CHOICE()] }, { env: 'hgs', solution: { uniquename: 'SBRMHgsTest', friendlyname: 'SBRM HGS Test' } }));
  assert.deepEqual(h.steps.find((s) => s.object === 'column').body.OptionSet.Options.map((o) => o.Value), [338300000, 338300001]);
  const none = fakeSchemaDv();
  delete none.data.publishers[PUB];
  assert.equal((await refused(plan(none, job({ columns: [FRESH_CHOICE()] })))).code, 'engine_bug');
});

test('r3-2: deletes log what a rebuild needs: options, the lookup column, other tables lookups a table takes', async () => {
  const dv = fakeSchemaDv();
  const c = await plan(dv, job({ columns: [{ action: 'delete', table: 'sbrm_widget', column: 'sbrm_size' }, { action: 'delete', table: 'sbrm_widget', column: 'sbrm_region' }] }));
  const size = c.steps.find((s) => /sbrm_size/.test(s.path)).before;
  assert.deepEqual(size.OptionSet.Options.map((o) => o.Value), [338300000, 338300001]);
  assert.equal(c.steps.find((s) => /sbrm_region/.test(s.path)).before.GlobalOptionSet.Name, 'sbrm_regions');
  const r = await plan(dv, job({ relationships: [{ action: 'delete', schema_name: 'sbrm_contact_sbrm_widget_ContactId' }] }));
  assert.equal(r.steps[0].before.LookupAttribute.LogicalName, 'sbrm_contactid');
  assert.ok(r.steps[0].before.LookupAttribute.RequiredLevel && r.steps[0].before.LookupAttribute.DisplayName);
  const t = await plan(dv, job({ tables: [{ action: 'delete', table: 'sbrm_widget' }] }));
  assert.match(schemaSummary(t), /Can't be fully undone: deleting the table Widget removes it and its 3 rows, and the lookup columns on other tables that point at it: sbrm_favoritewidgetid on contact \(1 rows linked\)\./);
  assert.equal(t.steps[0].before.LookupsElsewhere[0].definition.LogicalName, 'sbrm_favoritewidgetid');
  const done = await apply(t, dv);
  assert.equal(done.outcome, 'applied');
  assert.equal(dv.data.attrs.contact.sbrm_favoritewidgetid, undefined, 'Dataverse took the other table lookup with it');
  const e = await refused(planSchemaRevert(dv, roundTrip(done.entry), { envs: ENVS, access: ACCESS }));
  assert.match(e.message, /the log does not keep data/);
  assert.match(e.message, /the other tables' lookup columns it took with it/);
});

test('r3-3: a NEW required column or required lookup on a table with rows is admin; on a new table it is not', async () => {
  const dev = () => fakeSchemaDv({ email: 'dev2@example.org' });
  const col = await refused(plan(dev(), job({ columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh', required: true }] })));
  assert.equal(col.code, 'not_permitted');
  assert.match(col.message, /create Fresh as required on sbrm_widget: its 3 existing rows would have no value/);
  const lk = await refused(plan(dev(), job({ relationships: [{ type: 'one_to_many', schema_name: 'sbrm_OwnerContactId', display: 'Owner Contact', referenced: 'contact', referencing: 'sbrm_widget', required: true }] })));
  assert.match(lk.message, /create Owner Contact as required on sbrm_widget/);
  await plan(fakeSchemaDv(), job({ columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh', required: true }] })); // admin
  const fresh = job({
    tables: [{ schema_name: 'sbrm_Gizmo', display: 'Gizmo', plural: 'Gizmos', description: 'x', primary: { schema_name: 'sbrm_Name', display: 'Name' } }],
    columns: [{ table: 'sbrm_gizmo', type: 'text', schema_name: 'sbrm_Must', display: 'Must', required: true }],
  });
  assert.equal((await plan(dev(), fresh)).admin_only, false, 'a table this plan creates has no rows');
});

test('r3-4: every read after the first write asks for Consistency: Strong', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, BUILD());
  dv.calls.length = 0;
  await apply(p, dv);
  const first = dv.calls.findIndex((x) => x.method !== 'GET');
  const after = dv.calls.slice(first).filter((x) => x.method === 'GET');
  assert.ok(after.length > 10);
  assert.ok(after.every((x) => x.strong === true), after.filter((x) => !x.strong).map((x) => x.path).join('\n'));
});

test('r3-5: a delete or create that times out is re-read: landed = written, still missing = unknown, never "failed" blind', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, DEL_NOTES());
  dv.timeoutOn = (c) => (c.method === 'DELETE' ? 'lands' : null);
  const r = await apply(p, dv);
  assert.equal(r.rows[0].outcome, 'written');
  assert.match(r.rows[0].note, /timed out on this computer, but it landed/);
  const dv2 = fakeSchemaDv();
  const p2 = await plan(dv2, ONE_COL());
  dv2.timeoutOn = (c) => (/\/Attributes$/.test(c.path) ? 'lost' : null);
  sleeps = [];
  const r2 = await apply(p2, dv2);
  assert.match(r2.rows[0].outcome, /^failed: the request timed out on this computer and has not shown up in 2 minutes\. It may still land: make a new plan/);
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 2 * 60 * 1000);
});

test('r3-5: a re-run of the SAME job adopts the table its earlier run made but never put in the solution', async () => {
  const lonely = () => job({ tables: [{ schema_name: 'sbrm_Lonely', display: 'Lonely', plural: 'Lonelies', description: 'x', primary: { schema_name: 'sbrm_Name', display: 'Name' } }] });
  const dv = fakeSchemaDv();
  assert.match((await refused(plan(dv, lonely()))).message, /someone else built it/, 'no earlier run: still refused');
  dv.data.entities.sbrm_lonely.CreatedOn = '2026-10-07T20:05:00Z';
  const earlier = { mode: 'schema', solution: 'SBRMAdHoc', time: '2026-10-07T20:04:00Z', rows: [{ name: 'table', method: 'POST', path: 'EntityDefinitions', body: { SchemaName: 'sbrm_Lonely' }, outcome: 'failed: TaskCanceledException' }] };
  const logRow = (by) => ({
    sbrm_planid: '20261007-200400-00000abc', sbrm_outcome: 'applied with problems', sbrm_mode: 'schema', _createdby_value: by,
    sbrm_entry: entryText({ ...earlier, plan_id: 'p', person: { fullname: 'x', email: 'x', systemuserid: by }, env: 'fedev', app: 'Donor App Dev', table: 't', source: 's', reason: 'r', approval: 'dialog', left_out: [], headline: 'h', outcome: 'applied with problems' }),
  });
  dv.data.records.sbrm_dataversewritelogs.push(logRow(USERS['dev2@example.org']));
  assert.match((await refused(plan(dv, lonely()))).message, /someone else built it/, 'another person run does not count');
  // My own runs that are NOT this job's earlier attempt do not count either.
  const mine = (patch) => {
    const e = { ...earlier, ...patch };
    return { ...logRow(USERS['dgross@example.org']), sbrm_entry: entryText({ ...e, plan_id: 'p', person: { fullname: 'x', email: 'x', systemuserid: USERS['dgross@example.org'] }, env: 'fedev', app: 'Donor App Dev', table: 't', source: 's', reason: 'r', approval: 'dialog', left_out: [], headline: 'h', outcome: 'applied with problems' }) };
  };
  for (const patch of [
    { solution: 'VendorStuff' }, // another solution
    { time: '2026-10-07T20:30:00Z' }, // after the table was made
    { rows: [{ ...earlier.rows[0], outcome: 'written' }] }, // that create finished
    { rows: [{ ...earlier.rows[0], body: { SchemaName: 'sbrm_Other' } }] }, // another table
  ]) {
    const t = fakeSchemaDv();
    t.data.entities.sbrm_lonely.CreatedOn = '2026-10-07T20:05:00Z';
    t.data.records.sbrm_dataversewritelogs.push(mine(patch));
    assert.match((await refused(plan(t, lonely()))).message, /someone else built it/, JSON.stringify(patch));
  }
  dv.data.records.sbrm_dataversewritelogs.push(logRow(USERS['dgross@example.org']));
  const p = await plan(dv, lonely());
  assert.deepEqual(p.steps.map((s) => `${s.object}.${s.action}`), ['table.adopt']);
  assert.match(schemaSummary(p), /put the existing table Lonely \(sbrm_lonely\) into the solution SBRMAdHoc, with its columns/);
  assert.equal((await apply(p, dv)).outcome, 'applied');
  assert.equal((await refused(plan(dv, lonely()))).code, 'nothing_to_change');
  // In another solution: someone else's, still refused.
  const dv2 = fakeSchemaDv();
  dv2.data.entities.sbrm_lonely.CreatedOn = '2026-10-07T20:05:00Z';
  dv2.data.records.sbrm_dataversewritelogs.push(logRow(USERS['dgross@example.org']));
  dv2.data.components.push({ solutionid: dv2.data.solutions.VendorStuff.solutionid, objectid: dv2.data.entities.sbrm_lonely.MetadataId });
  assert.match((await refused(plan(dv2, lonely()))).message, /someone else built it/);
});

test('r3-6: a key over values that already repeat is refused with the count; re-checked at apply; blanks are not repeats', async () => {
  const key = (col) => job({ keys: [{ table: 'sbrm_widget', schema_name: 'sbrm_TheKey', display: 'The Key', columns: [col] }] });
  const e = await refused(plan(fakeSchemaDv(), key('sbrm_size')));
  assert.equal(e.code, 'invalid_job');
  assert.match(e.message, /the alternate key The Key on sbrm_widget: 1 value combination already repeat \(2 rows\), so Dataverse cannot build its index/);
  await plan(fakeSchemaDv(), key('sbrm_notes')); // one value and two blanks: fine
  const broken = fakeSchemaDv();
  broken.aggregateFails = true;
  assert.match((await refused(plan(broken, key('sbrm_code')))).message, /could not be checked for repeated values/);
  const dv = fakeSchemaDv();
  const p = await plan(dv, key('sbrm_code'));
  dv.data.records.sbrm_widgets[1].sbrm_code = 'A';
  const a = await refused(apply(p, dv, { confirm: noPopup }), ApplyRefused);
  assert.equal(a.code, 'snapshot_moved');
  assert.match(a.message, /already repeat \(2 rows\)/);
});

test('r3-7: right before a PUT the definition is re-read; a change since the pop-up stops it, nothing written', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, CODE_LABEL());
  const r = await apply(p, dv, { confirm: () => { dv.data.attrs.sbrm_widget.sbrm_code.MaxLength = 75; return { approved: true }; } });
  assert.match(r.rows[0].outcome, /^failed: it changed in the moments before the write/);
  assert.ok(!dv.calls.some((c) => c.method === 'PUT'));
  assert.equal(dv.data.attrs.sbrm_widget.sbrm_code.MaxLength, 75);
});

test('r3-7: PUT bodies drop DatabaseLength, send an explicit empty label for a cleared description, and name every type', async () => {
  const dv = fakeSchemaDv();
  dv.data.attrs.sbrm_widget.sbrm_code.DatabaseLength = 100;
  dv.data.attrs.sbrm_widget.sbrm_code.Description = { LocalizedLabels: [{ Label: 'old words', LanguageCode: 1033 }], UserLocalizedLabel: { Label: 'old words', LanguageCode: 1033 } };
  const p = await plan(dv, job({ columns: [{ action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { description: '', max_length: 80 } }] }));
  const s = p.steps[0];
  assert.equal(s.body.DatabaseLength, undefined, 'Dataverse derives it');
  assert.equal(s.before.DatabaseLength, 100, 'the log keeps it');
  assert.deepEqual(s.body.Description.LocalizedLabels, [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: '', LanguageCode: 1033 }]);
  assert.equal((await apply(p, dv)).outcome, 'applied');
  assert.equal(S.attrTypeName({ AttributeType: 'Uniqueidentifier' }), 'Microsoft.Dynamics.CRM.UniqueIdentifierAttributeMetadata');
  assert.equal(S.attrTypeName({ AttributeType: 'Virtual', AttributeTypeName: { Value: 'MultiSelectPicklistType' } }), 'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata');
  const odd = fakeSchemaDv();
  Object.assign(odd.data.attrs.sbrm_widget.sbrm_code, { AttributeType: 'Virtual', AttributeTypeName: { Value: 'VirtualType' } });
  delete odd.data.attrs.sbrm_widget.sbrm_code['@odata.type'];
  assert.match((await refused(plan(odd, CODE_LABEL()))).message, /whose type this engine cannot name/);
});

test('r3-8: a malformed query (0x80060888 "Could not find a property") is an error, never "does not exist"', async () => {
  const bad = new DataverseError("Could not find a property named 'DatabaseLength' on type 'Microsoft.Dynamics.CRM.AttributeMetadata'.", { code: '0x80060888' });
  assert.equal(S.isNotFound(bad), false);
  assert.equal(S.isNotFound(new DataverseError("EntityMetadata With Id = LogicalName='x' does not exist.", { code: '0x80060888' })), true);
  const dv = fakeSchemaDv();
  dv.getFails = (path) => (path === "EntityDefinitions(LogicalName='sbrm_widget')/Attributes(LogicalName='sbrm_code')" ? { message: bad.message, code: '0x80060888' } : null);
  await assert.rejects(plan(dv, CODE_LABEL()), /Could not find a property named/);
});

test('r3-9: a run starts no new step after 25 minutes; what landed is logged; run the same job again', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, BUILD());
  const clock = () => writes(dv).length * 10 * 60 * 1000; // each write "takes" ten minutes
  const r = await apply(p, dv, { clock });
  assert.deepEqual(r.rows.map((x) => x.outcome.split(':')[0]), ['written', 'written', 'written', 'not started', 'not started', 'not started', 'not started', 'not started']);
  assert.match(r.rows[3].outcome, /25-minute limit\. Run the same job again to finish/);
  assert.match(r.entry.publish.outcome, /not attempted: the run reached its time limit/);
  assert.match(r.entry.note, /run the same job again to finish/);
  const again = await plan(dv, BUILD());
  assert.equal(again.steps.length, 5, 'resumable: only what is missing');
});

// ---------------------------------------------------------------------------------------------------
// Round 4 (final re-verify): a revert built from a FORGED Write Log row obeys every forward rule
// ---------------------------------------------------------------------------------------------------

// A forged "applied" entry that "changed" a column: its before carries what the forger wants put back.
function forged(dv, { table = 'sbrm_widget', column = 'sbrm_code', solution = 'SBRMAdHoc', env = 'fedev', planId = '20261007-200000-aaaaaaaa', path, id, before } = {}) {
  const live = JSON.parse(JSON.stringify(dv.data.attrs[table][column]));
  const was = before || { ...live, DisplayName: { LocalizedLabels: [{ Label: 'Forged', LanguageCode: 1033 }], UserLocalizedLabel: { Label: 'Forged', LanguageCode: 1033 } } };
  return {
    mode: 'schema', outcome: 'applied', env, plan_id: planId, solution, headline: 'Totally harmless', person: { fullname: 'Someone Trusted' },
    rows: [{
      name: 'Harmless label fix', object: 'column', action: 'update', outcome: 'written', id: id === undefined ? live.MetadataId : id,
      method: 'PUT', path: path || `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='${column}')`,
      body: live, before: was, after: live, changes: [{ label: 'Label', old_text: 'Forged', new_text: 'x' }],
    }],
  };
}
const revertOf = (dv, entry, ctx = {}) => planSchemaRevert(dv, entry, { envs: ENVS, access: ACCESS, ...ctx });

test('r4: a forged revert of a MANAGED column is refused for everyone, admin included', async () => {
  const dv = fakeSchemaDv();
  const e = await refused(revertOf(dv, forged(dv, { table: 'contact', column: 'fullname' })));
  assert.equal(e.code, 'not_permitted');
  assert.match(e.message, /fullname is managed/);
  onlyGets(dv);
});

test('r4: a forged revert into a managed or foreign solution is refused', async () => {
  const dv = fakeSchemaDv();
  assert.match((await refused(revertOf(dv, forged(dv, { solution: 'msdyn_Nonprofit' })))).message, /is managed \(imported\)/);
  assert.match((await refused(revertOf(dv, forged(dv, { solution: 'VendorStuff' })))).message, /belongs to another publisher/);
});

test('r4: the entry must belong to the environment the revert is planned in', async () => {
  const dv = fakeSchemaDv();
  const e = await refused(revertOf(dv, forged(dv, { env: 'donorapp' })));
  assert.equal(e.code, 'invalid_job');
  assert.match(e.message, /is for the Donor App, not the environment this undo is planned in/);
  assert.match((await refused(revertOf(dv, forged(dv), { env: 'hgs' }))).message, /not the environment this undo is planned in/);
  const nowhere = fakeSchemaDv({ host: '' });
  assert.equal((await refused(revertOf(nowhere, forged(nowhere)))).code, 'invalid_job', 'unknown here: refused, not assumed');
});

test('r4: every id and name taken from the entry is shape-checked before it reaches a path', async () => {
  const dv = fakeSchemaDv();
  const bad = [
    forged(dv, { planId: "x') or 1 eq 1" }),
    forged(dv, { solution: 'SBRMAdHoc; DROP' }),
    forged(dv, { path: "EntityDefinitions(LogicalName='sbrm_widget')/Attributes(LogicalName='sbrm_code')?$x=1" }),
    forged(dv, { id: 'not-a-guid' }),
  ];
  for (const entry of bad) {
    const e = await refused(revertOf(dv, entry));
    assert.ok(['invalid_job', 'nothing_to_undo'].includes(e.code), e.message);
  }
  const opt = forged(dv);
  opt.rows[0] = { name: 'x', object: 'option', action: 'update', outcome: 'written', method: 'POST', path: 'UpdateOptionValue', body: { EntityLogicalName: "sbrm_widget') or (1", AttributeLogicalName: 'sbrm_size', Value: 338300000 }, changes: [{ old_text: 'a', new_text: 'b' }] };
  assert.match((await refused(revertOf(dv, opt))).message, /its choice is not a valid name/);
  onlyGets(dv);
});

test('r4: a revert never shows the log row\'s own text: names come from the requests, reason from the plan id', async () => {
  const dv = fakeSchemaDv();
  const r = await apply(await plan(dv, CODE_LABEL()), dv);
  const entry = roundTrip(r.entry);
  entry.rows[0].name = 'Harmless label fix';
  entry.headline = 'Totally harmless';
  const rp = await revertOf(dv, entry);
  const shown = schemaSummary(rp) + schemaDetail(rp, { id: 'X' });
  assert.doesNotMatch(shown, /Harmless label fix|Totally harmless/);
  assert.ok(rp.steps.every((s) => !/Harmless/.test(s.name)), 'nor in the names the new log row and its messages carry');
  assert.equal(rp.steps[0].name, 'column Widget Code (sbrm_code) on sbrm_widget');
  assert.equal(rp.reason, 'Undo plan 20261007-200000-aaaaaaaa (its Dataverse Write Log entry).');
});

test('r4: apply holds every plan to the same rules: the plan\'s own solution only, and never a managed object', async () => {
  const dv = fakeSchemaDv();
  const p = await plan(dv, ONE_COL());
  const elsewhere = { ...p, steps: p.steps.map((s) => ({ ...s, headers: ['MSCRM.SolutionUniqueName: VendorStuff'] })) };
  const e = await refused(apply(elsewhere, dv, { confirm: noPopup }), ApplyRefused);
  assert.equal(e.code, 'not_permitted');
  assert.match(e.message, /names a solution other than SBRMAdHoc/);
  // A hand-built step on a managed column, fingerprinted and rendered so every other check passes.
  const dv2 = fakeSchemaDv();
  const base = await plan(dv2, CODE_LABEL());
  const live = dv2.data.attrs.contact.fullname;
  const body = S.putBody(live, 'Microsoft.Dynamics.CRM.StringAttributeMetadata');
  body.DisplayName = S.label('Hacked');
  const step = {
    ...base.steps[0], name: 'column Full Name (fullname) on Contact', logical: { table: 'contact', column: 'fullname' },
    path: "EntityDefinitions(LogicalName='contact')/Attributes(LogicalName='fullname')", body, before: live,
    probes: [{ type: 'attrDef', table: 'contact', column: 'fullname' }], expect: S.canonical([{ '@odata.context': 'fake#attribute', ...live }]),
  };
  S.renderInto(dv2, [step], { publisher: PUB });
  const e2 = await refused(apply({ ...base, steps: [step], publish: { entities: ['contact'], optionsets: [] } }, dv2, { confirm: noPopup }), ApplyRefused);
  assert.equal(e2.code, 'not_permitted');
  assert.match(e2.message, /fullname is managed/);
  assert.ok(!dv2.calls.some((c) => c.method === 'PUT'));
});
