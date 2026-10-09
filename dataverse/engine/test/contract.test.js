'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateJob } = require('../lib/contract');
const { IDS, ENVS } = require('./fake');

function updateJob(over = {}) {
  return {
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'update',
    source: 'test', reason: 'Fix two addresses from returned mail.',
    intent: { verb: 'update', count: 2, table: 'contacts', fields: ['address1_city', 'address1_line1'] },
    rows: [
      { name: 'Jane Example', id: IDS.jane, body: { address1_line1: '123 Main St', address1_city: 'Santa Barbara' } },
      { name: 'Bob Sample', id: IDS.bob, body: { address1_line1: '9 Elm St', address1_city: 'Santa Barbara' } },
    ],
    ...over,
  };
}

function createJob(over = {}) {
  return {
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'create',
    source: 'test', reason: 'Add a new donor.', amount_field: 'creditlimit',
    intent: { verb: 'create', count: 1, table: 'contacts', fields: ['creditlimit', 'lastname'], amount_total: 50 },
    rows: [{ name: 'New Person', body: { lastname: 'Person', creditlimit: 50 }, dup_filter: "lastname eq 'Person'" }],
    ...over,
  };
}

const v = (j) => validateJob(j, { envs: ENVS });
const has = (res, re) => assert.ok(res.errors.some((e) => re.test(e)), `expected an error matching ${re}, got:\n${res.errors.join('\n')}`);

test('a valid update and a valid create pass and normalize', () => {
  const u = v(updateJob());
  assert.deepEqual(u.errors, []);
  assert.equal(u.job.rows[0].id, IDS.jane);
  assert.deepEqual(u.job.bodyKeys, ['address1_city', 'address1_line1']);
  const c = v(createJob());
  assert.deepEqual(c.errors, []);
});

test('unknown keys are refused, top-level and per row', () => {
  has(v(updateJob({ extra: 1 })), /unknown top-level key "extra"/);
  const j = updateJob();
  j.rows[0].bdy = {};
  has(v(j), /row 1: unknown key "bdy"/);
});

test('wrong contract, steps, delete, unknown env all refused', () => {
  has(v(updateJob({ contract: 'sbrm-dv-job/2' })), /"contract" must be exactly/);
  has(v(updateJob({ kind: 'steps' })), /"kind": "steps" is retired/);
  has(v(updateJob({ mode: 'merge' })), /"mode" must be "create" or "update"/);
  has(v(updateJob({ env: 'prod' })), /"env" must be one of: donorapp/);
  has(v(updateJob({ table: 'Contacts' })), /"table" must be an entity set name/);
});

test('records are never deleted (ruled 10/8): a delete job is refused and says how to make the record inactive', () => {
  const del = updateJob({ mode: 'delete', intent: { verb: 'delete', count: 1, table: 'contacts', fields: [] }, rows: [{ name: 'Jane Example', id: '11111111-1111-1111-1111-111111111111' }] });
  has(v(del), /records are never deleted, only made inactive/);
  has(v(del), /"statecode": 1/);
});

test('reason is required and one line', () => {
  has(v(updateJob({ reason: '' })), /"reason" is required/);
  has(v(updateJob({ reason: 'a\nb' })), /must be one line/);
});

test('update rows need a GUID and one row per record', () => {
  const j = updateJob();
  j.rows[0].id = 'not-a-guid';
  has(v(j), /"id" must be the target record's GUID/);
  const k = updateJob();
  k.rows[1].id = IDS.jane.toUpperCase();
  has(v(k), /same record id as row 1/);
});

test('a create row may not carry an id; identical create bodies refused', () => {
  const j = createJob();
  j.rows[0].id = IDS.jane;
  has(v(j), /must not carry an "id"/);
  const k = createJob({ intent: { verb: 'create', count: 2, table: 'contacts', fields: ['creditlimit', 'lastname'], amount_total: 100 } });
  k.rows.push({ name: 'Twin', body: { creditlimit: 50, lastname: 'Person' } });
  has(v(k), /identical body to row 1/);
});

test('deep insert, stray annotations and malformed binds are refused', () => {
  const deep = updateJob();
  deep.rows[0].body = { address1_line1: { nested: true } };
  deep.intent.fields = ['address1_line1'];
  has(v(deep), /nested writes \(deep insert\)/);
  const ann = updateJob();
  ann.rows[0].body['address1_city@OData.Community.Display.V1.FormattedValue'] = 'x';
  has(v(ann), /only "<NavigationProperty>@odata.bind"/);
  const bind = updateJob();
  bind.rows[0].body['parentcustomerid_account@odata.bind'] = 'accounts(abc)';
  has(v(bind), /must be "\/<entityset>\(<guid>\)" or null/);
});

test('dup_filter cannot smuggle extra query options', () => {
  const j = createJob();
  j.rows[0].dup_filter = "lastname eq 'x'&$select=*";
  has(v(j), /may not contain & \? #/);
  const u = updateJob();
  u.rows[0].dup_filter = "lastname eq 'x'";
  has(v(u), /"dup_filter" is for creates only/);
});

test('intent must match the rows exactly (DESIGN.md 6b.1)', () => {
  const cases = [
    [{ verb: 'create' }, /verb says "create"/],
    [{ count: 40 }, /count says 40, the file has 2/],
    [{ table: 'accounts' }, /table says "accounts"/],
    [{ fields: ['address1_line1'] }, /fields say \[address1_line1\]/],
  ];
  for (const [patch, re] of cases) {
    const j = updateJob();
    j.intent = { ...j.intent, ...patch };
    has(v(j), re);
  }
  has(v(updateJob({ intent: undefined })), /"intent" is required/);
});

// 1.11.7: a lookup is SET through its navigation property ("msnfp_AppealId@odata.bind"; a lookup that can point
// at more than one table carries the target, "msnfp_CustomerId_contact@odata.bind"), and Claude names the COLUMN
// in the intent. The same column, so they agree. Three of the first five intent refusals were only this
// (D-1026, D-1037, D-1050, read from the event table 10/9); the shapes below are theirs.
test('intent: a lookup named by its column agrees with the row\'s @odata.bind key; anything else still has to match', () => {
  const G = '/msnfp_appeals(11111111-1111-1111-1111-111111111111)';
  const job = (fields, body) => updateJob({
    table: 'msnfp_transactions',
    intent: { verb: 'update', count: 1, table: 'msnfp_transactions', fields },
    rows: [{ name: 'Gift 1', id: IDS.jane, body }],
  });
  const ok = (j) => assert.deepEqual(v(j).errors, []);
  // D-1050: the column names, lowercase
  ok(job(['msnfp_appealid', 'msnfp_designationid', 'msnfp_packageid'],
    { 'msnfp_AppealId@odata.bind': G, 'msnfp_DesignationId@odata.bind': G, 'msnfp_PackageId@odata.bind': G }));
  // D-1037: a lookup with a target (the column without it)
  ok(job(['msnfp_customerid'], { 'msnfp_CustomerId_contact@odata.bind': G }));
  // D-1026: the navigation properties without the annotation, mixed with plain columns
  ok(job(['msnfp_amount', 'msnfp_AppealId', 'msnfp_CustomerId_account', 'sbrm_addsoftcredittf'],
    { msnfp_amount: 5, 'msnfp_AppealId@odata.bind': G, 'msnfp_CustomerId_account@odata.bind': G, sbrm_addsoftcredittf: true }));
  // the exact key still works
  ok(job(['msnfp_AppealId@odata.bind'], { 'msnfp_AppealId@odata.bind': G }));
  // still refused: a field the rows do not set, a lookup the intent leaves out, a different column, and a plain
  // column's name is never stretched into another plain column
  has(v(job(['msnfp_appealid', 'msnfp_amount'], { 'msnfp_AppealId@odata.bind': G })), /fields say \[msnfp_appealid, msnfp_amount\]/);
  has(v(job(['msnfp_amount'], { msnfp_amount: 5, 'msnfp_AppealId@odata.bind': G })), /fields say \[msnfp_amount\]/);
  has(v(job(['msnfp_packageid'], { 'msnfp_AppealId@odata.bind': G })), /fields say \[msnfp_packageid\]/);
  has(v(job(['msnfp_customer'], { 'msnfp_CustomerId_contact@odata.bind': G })), /fields say \[msnfp_customer\]/);
  has(v(job(['address1'], { address1_city: 'x' })), /fields say \[address1\]/);
});

test('intent amount_total must equal the computed total to the cent', () => {
  const j = createJob();
  j.intent.amount_total = 50.01;
  has(v(j), /amount_total says 50.01, the rows total 50.00/);
  const k = updateJob();
  k.intent.amount_total = 5;
  has(v(k), /no amount_field/);
});

test('amount_field must be a column some row sets', () => {
  const j = createJob({ amount_field: 'address1_city' });
  has(v(j), /amount_field" address1_city is not set by any row/);
});
