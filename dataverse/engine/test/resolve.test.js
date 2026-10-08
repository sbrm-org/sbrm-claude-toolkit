'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateJob } = require('../lib/contract');
const { planJob, same, PlanRefused } = require('../lib/resolve');
const { fakeDv, IDS, ENVS, ACCESS } = require('./fake');

function job(raw) {
  const fields = [...new Set(raw.rows.flatMap((r) => Object.keys(r.body)))].sort();
  const full = {
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', source: 'test', reason: 'Test.',
    intent: { verb: raw.mode, count: raw.rows.length, table: raw.table || 'contacts', fields },
    ...raw,
  };
  if (raw.amount_field) full.intent.amount_total = raw.rows.reduce((s, r) => s + Number(r.body[raw.amount_field] || 0), 0);
  const res = validateJob(full, { envs: ENVS });
  assert.deepEqual(res.errors, []);
  return res.job;
}

function refused(fn, re) {
  assert.throws(fn, (e) => e instanceof PlanRefused && e.reasons.some((r) => re.test(r)), `expected a refusal matching ${re}`);
}

const run = (j, opts) => {
  const dv = fakeDv(opts);
  const plan = planJob(dv, j, { envs: ENVS, access: ACCESS });
  return { plan, dv };
};

test('the plan step only ever READS', () => {
  const { dv } = run(job({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }));
  assert.ok(dv.calls.length > 0);
  assert.ok(dv.calls.every((c) => c.method === 'GET'));
});

test('read access is refused before anything is resolved', () => {
  const dv = fakeDv({ email: 'someone@example.org' });
  const j = job({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'X' } }] });
  refused(() => planJob(dv, j, { envs: ENVS, access: ACCESS }), /has read access to the Donor App, not write/);
  assert.ok(!dv.calls.some((c) => c.path.startsWith('EntityDefinitions')), 'no metadata read for a refused person');
});

test('per-person max_rows', () => {
  const dv = fakeDv({ email: 'writer@example.org' });
  const rows = [IDS.jane, IDS.bob, IDS.inactive].map((id, i) => ({ name: `R${i}`, id, body: { address1_city: 'X' } }));
  refused(() => planJob(dv, job({ mode: 'update', rows }), { envs: ENVS, access: ACCESS }), /3 rows is over your limit of 2/);
});

test('unknown table, unknown column, computed column, read-only column refused', () => {
  refused(() => run(job({ mode: 'update', table: 'widgets', rows: [{ name: 'a', id: IDS.jane, body: { x: 1 } }] })), /no table "widgets"/);
  refused(() => run(job({ mode: 'update', rows: [{ name: 'a', id: IDS.jane, body: { nosuch: 1 } }] })), /no column by that name/);
  refused(() => run(job({ mode: 'update', rows: [{ name: 'a', id: IDS.jane, body: { yomifullname: 'x' } }] })), /computed from fullname/);
  refused(() => run(job({ mode: 'update', rows: [{ name: 'a', id: IDS.jane, body: { fullname: 'x' } }] })), /cannot be set on update/);
});

test('a lookup written as a plain column is refused; a mis-cased nav prop gets a hint', () => {
  refused(() => run(job({ mode: 'update', rows: [{ name: 'a', id: IDS.jane, body: { parentcustomerid: IDS.acme } }] })), /is a lookup; set it with/);
  refused(() => run(job({ mode: 'update', rows: [{ name: 'a', id: IDS.jane, body: { 'ParentCustomerId_account@odata.bind': `/accounts(${IDS.acme})` } }] })),
    /did you mean "parentcustomerid_account@odata.bind"/);
});

test('both arms of a polymorphic lookup in one body are refused', () => {
  refused(() => run(job({ mode: 'update', rows: [{ name: 'a', id: IDS.jane, body: {
    'parentcustomerid_account@odata.bind': `/accounts(${IDS.acme})`,
    'parentcustomerid_contact@odata.bind': `/contacts(${IDS.bob})`,
  } }] })), /both set Company Name/);
});

test('verify must cover every written column', () => {
  refused(() => run(job({ mode: 'update', verify: ['address1_line1'], rows: [{ name: 'a', id: IDS.jane, body: { address1_city: 'X' } }] })),
    /leaves out written column\(s\) address1_city/);
});

test('a choice value that is not an option is refused, before any record read', () => {
  refused(() => run(job({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { statuscode: 7 } }] })), /Status Reason has no option 7/);
  refused(() => run(job({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { donotemail: 1 } }] })), /must be true or false/);
});

test('update: changes carry labels and old -> new; formatted old values are used', () => {
  const { plan } = run(job({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_line1: '123 Main St', address1_city: 'Santa Barbara', statuscode: 2 } },
  ] }));
  const r = plan.rows[0];
  assert.deepEqual(r.changes.map((c) => [c.label, c.old_text, c.new_text]), [
    ['Address 1: Street 1', '12 Old Rd', '123 Main St'],
    ['Address 1: City', '(blank)', 'Santa Barbara'],
    ['Status Reason', 'Active', 'Inactive'],
  ]);
  assert.equal(r.before.address1_line1, '12 Old Rd');
  assert.ok(!Object.keys(r.before).some((k) => k.includes('@')), 'no annotations in before');
  assert.equal(plan.identity.email, 'dgross@example.org');
});

test('update: a row with nothing to change is left out, not written', () => {
  const { plan } = run(job({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_line1: '12 Old Rd' } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_line1: '10 Elm St' } },
  ] }));
  assert.equal(plan.rows.length, 1);
  assert.deepEqual(plan.refused.map((x) => [x.name, x.why]), [['Jane Example', 'already has these values (nothing to change)']]);
});

test('update: missing and inactive targets are refused row by row', () => {
  const { plan } = run(job({ mode: 'update', rows: [
    { name: 'Gone', id: IDS.gone, body: { address1_city: 'X' } },
    { name: 'Ina Active', id: IDS.inactive, body: { address1_city: 'X' } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_city: 'X' } },
  ] }));
  assert.deepEqual(plan.refused.map((x) => x.why), [`record ${IDS.gone} was not found in contacts`, 'the record is inactive']);
  assert.equal(plan.rows.length, 1);
});

test('update: the row name is checked against the real record name (wrong-GUID guard)', () => {
  const { plan } = run(job({ mode: 'update', rows: [{ name: 'Janet Exampel', id: IDS.jane, body: { address1_city: 'X' } }] }));
  assert.match(plan.rows[0].warnings[0], /calls this row "Janet Exampel", but the record is named "Jane Example"/);
});

test('every row refused = no plan at all', () => {
  refused(() => run(job({ mode: 'update', rows: [{ name: 'Gone', id: IDS.gone, body: { address1_city: 'X' } }] })), /every row was refused/);
});

test('lookup binds: wrong table refused, missing target refused, good target shown by name', () => {
  const { plan } = run(job({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { 'parentcustomerid_account@odata.bind': `/accounts(${IDS.acme})` } },
    { name: 'Bob Sample', id: IDS.bob, body: { 'parentcustomerid_account@odata.bind': `/contacts(${IDS.jane})` } },
  ] }));
  assert.equal(plan.rows[0].changes[0].new_text, 'Acme Foundation');
  assert.equal(plan.rows[0].changes[0].new, IDS.acme);
  assert.match(plan.refused[0].why, /must point at accounts \(accounts\), not contacts/);
  const second = run(job({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { 'parentcustomerid_account@odata.bind': `/accounts(${IDS.gone})` } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_city: 'Z' } },
  ] }));
  assert.match(second.plan.refused[0].why, /the linked account .* does not exist/);
});

test('create: a duplicate hit is refused; a broken dup_filter refuses the row loudly', () => {
  const { plan } = run(job({ mode: 'create', rows: [
    { name: 'Dup', body: { lastname: 'Dup' }, dup_filter: "lastname eq 'Dup'" },
    { name: 'Bad', body: { lastname: 'Bad' }, dup_filter: "BAD eq 'x'" },
    { name: 'New', body: { lastname: 'New', creditlimit: 25.5 }, dup_filter: "lastname eq 'New'" },
  ], amount_field: 'creditlimit' }), { dupHits: ["lastname eq 'Dup'"] });
  assert.deepEqual(plan.refused.map((x) => x.name), ['Dup', 'Bad']);
  assert.match(plan.refused[1].why, /duplicate check could not run/);
  assert.equal(plan.rows[0].changes.find((c) => c.column === 'creditlimit').new_text, '$25.50');
  assert.equal(plan.amount_total, 25.5);
});

test('same(): an empty string is blank, as Dataverse reads it back (found 10/7 planning the first live merge test)', () => {
  assert.ok(same('', null));
  assert.ok(same(null, ''));
  assert.ok(same('', undefined));
  assert.ok(!same('', 'x'));
  assert.ok(!same(' ', null), 'a space is not blank');
});

test('same(): narrow date rule, GUID case, numbers', () => {
  assert.ok(same('2026-04-30', '2026-04-30T00:00:00Z'));
  assert.ok(!same('2026-04-30', '2026-05-01T00:00:00Z'));
  assert.ok(!same('2026-04-30', '2026-04-30T08:00:00Z'));
  assert.ok(same(IDS.acme.toUpperCase(), IDS.acme));
  assert.ok(same(10, '10.00'));
  assert.ok(same(null, ''), 'reversed 10/7: Dataverse stores "" as null, so they are the same value');
  assert.ok(same(undefined, null));
});
