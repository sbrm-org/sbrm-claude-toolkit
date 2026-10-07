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
  has(v(updateJob({ kind: 'steps' })), /not in v1/);
  has(v(updateJob({ mode: 'delete' })), /there is no delete/);
  has(v(updateJob({ env: 'prod' })), /"env" must be one of: donorapp/);
  has(v(updateJob({ table: 'Contacts' })), /"table" must be an entity set name/);
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
