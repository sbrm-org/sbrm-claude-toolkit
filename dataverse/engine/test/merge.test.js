'use strict';
// Merges through the REAL CLI with a fake Dataverse (DESIGN.md §8, rulings §8f).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-merge-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });

const { fakeDv, IDS } = require('./fake');
fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'), JSON.stringify({
  donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false, closed_year: { msnfp_transactions: 'msnfp_bookdate' } },
}));

const cli = require('../dataverse-write');
const LOG = 'sbrm_dataversewritelogs';

function deps(dv, over = {}) {
  return {
    readConnection: () => dv, writeConnection: () => dv, confirm: () => ({ approved: true }),
    eventConnection: () => ({ createEvent: (b) => dv.create('sbrm_dataverseevents', b) }),
    cli: () => ({ version: '1.0.34' }), io: () => ({ home: HOME, cwd: HOME, read: () => null }),
    ...over,
  };
}

async function go(argv, d) {
  const real = console.log;
  console.log = () => {};
  try {
    const code = await cli.runCli(argv, d);
    return { code, run: cli.lastRun, out: cli.lastRun.output.join('\n') };
  } finally {
    console.log = real;
  }
}

let n = 0;
function jobFile(pairs, over = {}) {
  n += 1;
  const f = path.join(HOME, `merge-${n}.json`);
  fs.writeFileSync(f, JSON.stringify({
    contract: 'sbrm-dv-job/1', kind: 'merge', env: 'donorapp', table: 'accounts', source: 'test',
    reason: 'Givebutter intake made a copy of Acme.', intent: { verb: 'merge', pairs: pairs.length, table: 'accounts' }, pairs, ...over,
  }));
  return f;
}
const ACME = { keep: { id: IDS.acme, name: 'Acme Foundation' }, duplicate: { id: IDS.acme2, name: 'Acme Foundation, Inc.' }, fill_blank: ['telephone1'] };

async function planned(dv, pairs = [ACME], d = deps(dv)) {
  const r = await go(['plan', jobFile(pairs)], d);
  assert.equal(r.code, 0, r.out);
  return r;
}

// ---- the job file ----

test('the merge job file: typos, same record, chains, wrong table and intent mismatch are refused', async () => {
  const dv = fakeDv();
  const cases = [
    [[{ ...ACME, colour: 'red' }], {}, /unknown key "colour"/],
    [[{ keep: ACME.keep, duplicate: ACME.keep }], {}, /the same record/],
    [[ACME, { keep: { id: IDS.acme2, name: 'x' }, duplicate: { id: IDS.zeta, name: 'Zeta Corp' } }], {}, /both kept and merged away/],
    [[ACME], { table: 'msnfp_transactions', intent: { verb: 'merge', pairs: 1, table: 'msnfp_transactions' } }, /"table" must be one of: accounts, contacts/],
    [[ACME], { intent: { verb: 'merge', pairs: 2, table: 'accounts' } }, /intent does not match the pairs/],
  ];
  for (const [pairs, over, re] of cases) {
    const { code, out } = await go(['plan', jobFile(pairs, over)], deps(dv));
    assert.equal(code, 1);
    assert.match(out, re);
  }
  assert.ok(!dv.calls.some((c) => c.method !== 'GET' && c.path !== 'sbrm_dataverseevents'), 'no data written');
});

// ---- plan ----

test('plan: the pop-up is computed from live reads: children per table, fill-ins, closed-year gifts, how far an undo goes',async () => {
  const dv = fakeDv();
  const { out, run } = await planned(dv);
  assert.match(out, /^Merge 1 duplicate account into 1 in the Donor App/m);
  assert.match(out, /Acme Foundation \(2022\) {2}<- {2}1 duplicate\n {4}moves 2 transactions\n {4}fills blank on the kept record: Main Phone/);
  assert.match(out, /1 of the moved gifts are in closed fiscal years: their donor changes; amount, date and GL do not\./);
  assert.match(out, /Can be undone with revert: the duplicate comes back and the records listed here move back\./);
  const plan = JSON.parse(fs.readFileSync(path.join(process.env.SBRM_DV_HOME, 'plans', `${run.planId}.json`), 'utf8'));
  const p = plan.pairs[0];
  assert.deepEqual(Object.values(p.inventory).map((c) => [c.label, c.ids]), [['Transactions', [IDS.t1, IDS.t2]]], 'only the duplicate\'s children');
  assert.deepEqual(plan.relationships_skipped, ['Account_AsyncOperations'], 'system tables are named, not inventoried');
  assert.equal(p.keep_before.description, 'Long-time foundation donor.', 'the kept record in full');
  assert.equal(p.duplicate_before.telephone1, '805-555-0100', 'the duplicate in full');
  assert.equal(p.content.telephone1, '805-555-0100');
  assert.match(p.content.description, /^Long-time foundation donor\.\nMerged duplicate 'Acme Foundation, Inc\.' \(created 2026-08-26\) into this record on .* with Claude AI \(Test Person\)\.$/);
  assert.ok(!dv.calls.some((c) => c.method !== 'GET' && c.path !== 'sbrm_dataverseevents'), 'planning writes no data (only waiting events are sent)');
});

test('one moved record reads singular ("1 transaction", not "1 transactions")', async () => {
  const dv = fakeDv();
  delete dv.data.msnfp_transactions[IDS.t1];
  const { out } = await planned(dv);
  assert.match(out, /moves 1 transaction\n/);
});

test('names that do not match need a person\'s confirmation', async () => {
  const dv = fakeDv();
  const zeta = { keep: { id: IDS.acme, name: 'Acme Foundation' }, duplicate: { id: IDS.zeta, name: 'Zeta Corp' } };
  const refused = await go(['plan', jobFile([zeta])], deps(dv));
  assert.equal(refused.code, 1);
  assert.match(refused.out, /the names do not look like the same account: 'Acme Foundation' and 'Zeta Corp'/);
  const ok = await planned(dv, [{ ...zeta, name_override: 'Zeta is Acme\'s old trade name, per the donor team' }]);
  assert.match(ok.out, /names differ, confirmed: 'Zeta Corp' \(Zeta is Acme's old trade name, per the donor team\)/);
});

test('merging needs its own grant (ruled 10/7): write or develop alone is not enough; admin implies it', async () => {
  for (const email of ['writer@example.org', 'dev@example.org']) {
    const r = await go(['plan', jobFile([ACME])], deps(fakeDv({ email })));
    assert.equal(r.code, 1, email);
    assert.equal(r.run.events[0].reason_code, 'not_permitted');
    assert.match(r.out, /has no merge grant in the Donor App/);
  }
  await planned(fakeDv({ email: 'merger@example.org' }));
  await planned(fakeDv({ email: 'dgross@example.org' }));
});

test('the 500-children ceiling per approval', async () => {
  const dv = fakeDv();
  for (let i = 0; i < 501; i += 1) {
    const id = `cccccccc-0000-0000-0000-${String(i).padStart(12, '0')}`;
    dv.data.msnfp_transactions[id] = { msnfp_transactionid: id, msnfp_bookdate: '2099-01-01T08:00:00Z', _msnfp_customerid_value: IDS.acme2 };
  }
  const r = await go(['plan', jobFile([ACME])], deps(dv));
  assert.equal(r.code, 1);
  assert.match(r.out, /these merges move 503 records, over the ceiling of 500 per approval/);
});

// ---- apply ----

test('apply: one Merge, read back, and the log keeps BOTH records in full and every moved record', async () => {
  const dv = fakeDv();
  const { run } = await planned(dv);
  let shown = null;
  const r = await go(['apply', run.planId], deps(dv, { confirm: (x) => { shown = x; return { approved: true }; } }));
  assert.equal(r.code, 0, r.out);
  // A merge always heads with its severity (DESIGN.md §10j): it cannot be fully undone.
  assert.match(shown.summaryText, /^Before you approve:\n  ! Can't be fully undone: this merge moves linked records onto the kept record/);
  assert.match(shown.summaryText, /^Merge 1 duplicate account into 1/m);
  const dup = dv.data.accounts[IDS.acme2];
  assert.deepEqual([dup.merged, dup._masterid_value, dup.statecode], [true, IDS.acme, 1]);
  assert.equal(dv.data.msnfp_transactions[IDS.t1]._msnfp_customerid_value, IDS.acme, 'the closed-year gift moved too (ruled 10/7)');
  assert.equal(dv.data.accounts[IDS.acme].telephone1, '805-555-0100');
  assert.equal(dv.calls.filter((c) => c.path === 'Merge').length, 1);
  const row = Object.values(dv.data[LOG]).find((x) => x.sbrm_planid === run.planId);
  assert.equal(row.sbrm_mode, 'merge');
  assert.deepEqual(row.sbrm_recordids.split('\n').sort(), [IDS.acme, IDS.acme2, IDS.t1, IDS.t2].sort());
  const entry = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(row.sbrm_entry)[1]);
  const e = entry.rows[0];
  assert.equal(e.outcome, 'written');
  assert.equal(e.keep_before.description, 'Long-time foundation donor.');
  assert.equal(e.duplicate_before.name, 'Acme Foundation, Inc.');
  assert.deepEqual(Object.values(e.inventory)[0].ids, [IDS.t1, IDS.t2]);
  assert.match(row.sbrm_entry, /kept record `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`; moved: Transactions 2/);
});

test('apply re-takes the inventory: a child added since the plan leaves the pair out, nothing merged', async () => {
  const dv = fakeDv();
  const { run } = await planned(dv);
  const late = 'dddddddd-0000-0000-0000-000000000001';
  dv.data.msnfp_transactions[late] = { msnfp_transactionid: late, msnfp_bookdate: '2099-03-01T08:00:00Z', _msnfp_customerid_value: IDS.acme2 };
  const r = await go(['apply', run.planId], deps(dv, { confirm: () => { throw new Error('no pop-up'); } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /linked records changed since the plan \(2 then, 3 now\)/);
  assert.equal(dv.data.accounts[IDS.acme2].merged, false);
  assert.ok(!dv.calls.some((c) => c.path === 'Merge'));
});

test('apply: a kept record edited since the plan leaves the pair out (its fill-ins would be stale)', async () => {
  const dv = fakeDv();
  const { run } = await planned(dv);
  dv.touch('accounts', IDS.acme, { telephone1: '805-555-9999' });
  const r = await go(['apply', run.planId], deps(dv, { confirm: () => { throw new Error('no pop-up'); } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /the kept record changed since the plan \(telephone1\)/);
});

test('two duplicates into one kept record: the second is worked out against what the first leaves', async () => {
  const dv = fakeDv();
  const zeta = { keep: { id: IDS.acme, name: 'Acme Foundation' }, duplicate: { id: IDS.zeta, name: 'Zeta Corp' }, name_override: 'old trade name' };
  const { run } = await planned(dv, [ACME, zeta]);
  await go(['apply', run.planId], deps(dv));
  const desc = dv.data.accounts[IDS.acme].description;
  assert.match(desc, /Merged duplicate 'Acme Foundation, Inc\.'[\s\S]*Merged duplicate 'Zeta Corp'/, 'both stamps survive');
  assert.equal(dv.data.accounts[IDS.zeta].merged, true);
});

test('a child the platform did not move is caught by the read-back, never reported as merged', async () => {
  const dv = fakeDv();
  dv.mergeLeaves = ['msnfp_transactions'];
  const { run } = await planned(dv);
  const r = await go(['apply', run.planId], deps(dv));
  assert.equal(r.code, 1);
  assert.match(r.out, /read-back mismatch: Transactions: 2 not moved/);
});

test('cancel merges nothing and is logged', async () => {
  const dv = fakeDv();
  const { run } = await planned(dv);
  const c = await go(['apply', run.planId], deps(dv, { confirm: () => ({ approved: false }) }));
  assert.equal(c.code, 1);
  assert.ok(!dv.calls.some((x) => x.path === 'Merge'));
  assert.ok(Object.values(dv.data[LOG]).some((x) => x.sbrm_outcome === 'cancelled'));
});

// ---- undo (the rebuild) ----

async function merged(dv) {
  const { run } = await planned(dv);
  const r = await go(['apply', run.planId], deps(dv));
  assert.equal(r.code, 0, r.out);
  return run.planId;
}

test('undo: reactivates the duplicate, moves its children back, restores the filled fields, logged as undoing the merge', async () => {
  const dv = fakeDv();
  const mergeId = await merged(dv);
  const plan = await go(['revert', mergeId, 'donorapp'], deps(dv));
  assert.equal(plan.code, 0, plan.out);
  assert.match(plan.out, /Undo 1 merge in the Donor App\n\n {2}Acme Foundation, Inc\. {2}<- {2}back out of Acme Foundation\n {4}reactivates it\n {4}moves back 2 transactions\n {4}restores on Acme Foundation: Main Phone, Description/);
  assert.match(plan.out, /Reactivating the duplicate also clears its merged mark \(Dataverse does that itself\)\./);
  let shown = null;
  const r = await go(['apply', plan.run.planId], deps(dv, { confirm: (x) => { shown = x; return { approved: true }; } }));
  assert.equal(r.code, 0, r.out);
  assert.ok(shown);
  const dup = dv.data.accounts[IDS.acme2];
  assert.equal(dup.statecode, 0, 'reactivated');
  assert.equal(dup.merged, false, 'reactivating clears the merged mark (the platform does it; seen live 10/7)');
  assert.equal(dup._masterid_value, null);
  assert.equal(dv.data.msnfp_transactions[IDS.t1]._msnfp_customerid_value, IDS.acme2, 'the closed-year gift moved back too');
  assert.equal(dv.data.msnfp_transactions[IDS.t2]._msnfp_customerid_value, IDS.acme2);
  assert.equal(dv.data.msnfp_transactions[IDS.t3]._msnfp_customerid_value, IDS.acme, 'the kept record\'s own gift stays');
  assert.equal(dv.data.accounts[IDS.acme].telephone1, null, 'the filled phone is blank again');
  assert.equal(dv.data.accounts[IDS.acme].description, 'Long-time foundation donor.', 'the stamp line is gone');
  const row = Object.values(dv.data[LOG]).find((x) => x.sbrm_planid === plan.run.planId);
  assert.equal(row.sbrm_revertsplanid, mergeId);
  assert.equal(row.sbrm_mode, 'unmerge');
});

test('undo leaves alone what changed since the merge: a moved child and an edited field', async () => {
  const dv = fakeDv();
  const mergeId = await merged(dv);
  dv.touch('msnfp_transactions', IDS.t2, { _msnfp_customerid_value: IDS.zeta }); // someone re-pointed it on purpose
  dv.touch('accounts', IDS.acme, { telephone1: '805-555-7777' });               // someone edited the phone
  const plan = await go(['revert', mergeId, 'donorapp'], deps(dv));
  assert.match(plan.out, /moves back 1 transaction\n/);
  assert.match(plan.out, /leaves 1 record\(s\) where they are \(moved since the merge\)/);
  assert.match(plan.out, /leaves Main Phone as is \(edited since the merge\)/);
  await go(['apply', plan.run.planId], deps(dv));
  assert.equal(dv.data.msnfp_transactions[IDS.t2]._msnfp_customerid_value, IDS.zeta);
  assert.equal(dv.data.accounts[IDS.acme].telephone1, '805-555-7777');
  assert.equal(dv.data.msnfp_transactions[IDS.t1]._msnfp_customerid_value, IDS.acme2);
});

test('undo re-checks at apply: a child moved after the undo was planned is left out', async () => {
  const dv = fakeDv();
  const mergeId = await merged(dv);
  const plan = await go(['revert', mergeId, 'donorapp'], deps(dv));
  dv.touch('msnfp_transactions', IDS.t1, { _msnfp_customerid_value: IDS.zeta });
  await go(['apply', plan.run.planId], deps(dv));
  assert.equal(dv.data.msnfp_transactions[IDS.t1]._msnfp_customerid_value, IDS.zeta, 'left where it was moved');
  assert.equal(dv.data.msnfp_transactions[IDS.t2]._msnfp_customerid_value, IDS.acme2);
});

test('undo needs the merge grant, and an undone merge has nothing left to undo', async () => {
  const dv = fakeDv();
  const mergeId = await merged(dv);
  const writer = fakeDv({ email: 'writer@example.org', data: dv.data });
  const w = await go(['revert', mergeId, 'donorapp'], deps(writer));
  assert.equal(w.code, 1);
  assert.match(w.out, /has no merge grant in the Donor App; undoing a merge needs the same grant/);
  const plan = await go(['revert', mergeId, 'donorapp'], deps(dv));
  await go(['apply', plan.run.planId], deps(dv));
  const again = await go(['revert', mergeId, 'donorapp'], deps(dv));
  assert.equal(again.code, 1);
  assert.match(again.out, /nothing left to put back/);
});

test('show and check understand a merge plan', async () => {
  const dv = fakeDv();
  const f = jobFile([ACME]);
  const chk = await go(['check', f], deps(dv));
  assert.match(chk.out, /The job file is valid: merge 1 pair\(s\) of accounts/);
  const { run } = await planned(dv);
  const shown = await go(['show', run.planId], deps(dv));
  assert.match(shown.out, /1\. Acme Foundation, Inc\. \(aaaaaaaa-aaaa-aaaa-aaaa-000000000002\) into Acme Foundation[\s\S]*Transactions: 2[\s\S]*fills telephone1: 805-555-0100/);
});
