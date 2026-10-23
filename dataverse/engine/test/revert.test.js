'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-revert-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const { validateJob } = require('../lib/contract');
const { planJob, PlanRefused } = require('../lib/resolve');
const { savePlan } = require('../lib/store');
const { applyPlan } = require('../lib/apply');
const { planRevert, findEntry } = require('../lib/revert');
const { summary, detail } = require('../lib/render');
const { fakeDv, IDS, ENVS, ACCESS } = require('./fake');
const { fileFor, entryText, flushPending } = require('../lib/log');
const { DataverseError } = require('../lib/cli');

const LOG = 'sbrm_dataversewritelogs';
const approve = () => ({ approved: true });
const writes = (dv) => dv.calls.filter((c) => c.method !== 'GET' && c.path !== LOG);

function makePlan(raw, dv) {
  const fields = [...new Set(raw.rows.flatMap((r) => Object.keys(r.body)))].sort();
  const res = validateJob({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', source: 'test', reason: 'Test.',
    intent: { verb: raw.mode, count: raw.rows.length, table: 'contacts', fields }, ...raw,
  }, { envs: ENVS });
  assert.deepEqual(res.errors, []);
  return savePlan(planJob(dv, res.job, { envs: ENVS, access: ACCESS })).id;
}

// Plan + apply a write, then return its plan id (its entry is now in the fake log table).
function applied(raw, dv) {
  const id = makePlan(raw, dv);
  const res = applyPlan(id, { access: ACCESS, connect: () => dv, confirm: approve });
  assert.equal(res.logged.rowOk, true);
  return { id, res };
}

// Plan the undo and save it the way the CLI does; returns { id, plan }.
function revertOf(origId, dv) {
  const { plan } = planRevert(dv, findEntry(dv, origId), { envs: ENVS, access: ACCESS });
  return { id: savePlan(plan).id, plan };
}

const run = (id, dv, confirm = approve) => applyPlan(id, { access: ACCESS, connect: () => dv, confirm });

test('update revert: every changed column goes back, through its own pop-up, logged as undoing the original', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara', 'parentcustomerid_account@odata.bind': `/accounts(${IDS.acme})` } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_city: 'Santa Barbara' } },
  ] }, dv);
  const before = writes(dv).length;

  const { id, plan } = revertOf(orig, dv);
  assert.equal(writes(dv).length, before, 'planning a revert writes nothing');
  assert.equal(plan.reverts_plan_id, orig);
  assert.equal(plan.source, `revert ${orig}`);
  assert.match(plan.reason, new RegExp(`^Undo plan ${orig} \\("Update 2 contacts in the Donor App", applied .* by Test Person\\)\\.$`));
  assert.deepEqual(plan.rows.find((r) => r.id === IDS.jane).body, { address1_city: null, 'parentcustomerid_account@odata.bind': null });
  assert.deepEqual(plan.rows.find((r) => r.id === IDS.bob).body, { address1_city: 'Goleta' });
  assert.match(detail(plan, { id }), new RegExp(`Undoes plan: ${orig}`));

  let shown = null;
  const res = run(id, dv, (x) => { shown = x; return { approved: true }; });
  assert.ok(shown, 'a revert is approved in the pop-up like any write');
  assert.match(shown.summaryText, /^Update 2 contacts in the Donor App/);
  assert.equal(res.outcome, 'applied');
  assert.equal(dv.data.contacts[IDS.jane].address1_city, null);
  assert.equal(dv.data.contacts[IDS.jane]._parentcustomerid_value, null);
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Goleta');
  const row = Object.values(dv.data[LOG]).find((r) => r.sbrm_planid === id);
  assert.equal(row.sbrm_revertsplanid, orig, 'the log row names the plan it undoes');
  assert.match(row.sbrm_entry, new RegExp(`- Undoes plan: ${orig}`));
});

test('a lookup cleared by the original write is restored to its old record (set from the relationship)', () => {
  const dv = fakeDv();
  dv.touch('contacts', IDS.bob, { _parentcustomerid_value: IDS.acme });
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Bob Sample', id: IDS.bob, body: { 'parentcustomerid_account@odata.bind': null } }] }, dv);
  assert.equal(dv.data.contacts[IDS.bob]._parentcustomerid_value, null);
  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { 'parentcustomerid_account@odata.bind': `/accounts(${IDS.acme})` });
  run(id, dv);
  assert.equal(dv.data.contacts[IDS.bob]._parentcustomerid_value, IDS.acme);
});

// R-1035: the old owner comes back as a pointer at ITS table (the before image keeps only the id, and the abstract
// owner table cannot be pointed at), a team as surely as a user.
test('an owner change is undone back to the old owner, a team or a user', () => {
  const dv = fakeDv();
  dv.touch('contacts', IDS.jane, { _ownerid_value: IDS.team });
  dv.touch('contacts', IDS.bob, { _ownerid_value: IDS.cm });
  const { id: orig } = applied({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { 'ownerid@odata.bind': `/systemusers(${IDS.cm})` } },
    { name: 'Bob Sample', id: IDS.bob, body: { 'ownerid@odata.bind': `/teams(${IDS.team})` } },
  ] }, dv);
  assert.equal(dv.data.contacts[IDS.jane]._ownerid_value, IDS.cm);
  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows.find((r) => r.id === IDS.jane).body, { 'ownerid@odata.bind': `/teams(${IDS.team})` });
  assert.deepEqual(plan.rows.find((r) => r.id === IDS.bob).body, { 'ownerid@odata.bind': `/systemusers(${IDS.cm})` });
  run(id, dv);
  assert.equal(dv.data.contacts[IDS.jane]._ownerid_value, IDS.team);
  assert.equal(dv.data.contacts[IDS.bob]._ownerid_value, IDS.cm);
});

test('RULED 10/7: a record whose undone column changed since is LEFT OUT; the rest is undone', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_city: 'Santa Barbara' } },
  ] }, dv);
  dv.touch('contacts', IDS.bob, { address1_city: 'Carpinteria' }); // someone corrected it after us

  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows.map((r) => r.id), [IDS.jane]);
  const out = plan.refused.find((x) => x.id === IDS.bob);
  assert.match(out.why, new RegExp(`changed since plan ${orig}, so it is left as it is \\(Address 1: City: Santa Barbara -> Carpinteria\\)`));
  assert.match(summary(plan), /Left out, will NOT be written \(1\):\n {2}Bob Sample: changed since plan/);
  run(id, dv);
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Carpinteria', 'the later edit survives');
  assert.equal(dv.data.contacts[IDS.jane].address1_city, null);
});

test('an UNRELATED later edit does not block (the check is per column being undone)', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }, dv);
  dv.touch('contacts', IDS.jane, { address1_line1: '77 New St' });
  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.refused, []);
  run(id, dv);
  assert.equal(dv.data.contacts[IDS.jane].address1_city, null);
  assert.equal(dv.data.contacts[IDS.jane].address1_line1, '77 New St');
});

test('two undone columns, one moved: the WHOLE record is left out, never half-undone', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara', address1_line1: '5 Main St' } }] }, dv);
  dv.touch('contacts', IDS.jane, { address1_line1: '6 Main St' });
  assert.throws(() => revertOf(orig, dv), (e) => e instanceof PlanRefused && /every record changed since the original write/.test(e.message)
    && /Address 1: Street 1: 5 Main St -> 6 Main St/.test(e.message));
  assert.equal(dv.data.contacts[IDS.jane].address1_city, 'Santa Barbara');
});

test('a record changed after the revert is PLANNED is still caught at apply (re-check), nothing lands', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }, dv);
  const { id } = revertOf(orig, dv);
  dv.touch('contacts', IDS.jane, { address1_city: 'Ventura' });
  const asked = () => { throw new Error('no pop-up when every row moved'); };
  assert.throws(() => run(id, dv, asked), /every row changed since the plan/);
  assert.equal(dv.data.contacts[IDS.jane].address1_city, 'Ventura');
});

test('already undone: refused, nothing planned', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }, dv);
  run(revertOf(orig, dv).id, dv);
  assert.throws(() => revertOf(orig, dv), PlanRefused);
});

test('create revert: the new record is marked inactive (state + the inactive status), never deleted', () => {
  const dv = fakeDv();
  const { id: orig, res } = applied({ mode: 'create', rows: [{ name: 'New One', body: { lastname: 'One' } }] }, dv);
  const newId = res.rows[0].id;
  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { statecode: 1, statuscode: 2 });
  assert.equal(plan.rows[0].id, newId);
  assert.match(summary(plan), /^Mark 1 contact inactive in the Donor App/);
  run(id, dv);
  assert.equal(dv.data.contacts[newId].statecode, 1);
  assert.equal(dv.data.contacts[newId].statuscode, 2);
  assert.ok(writes(dv).every((c) => c.method !== 'DELETE'));
});

test('records are made inactive, never deleted (ruled 10/8), so a deactivation must UNDO: the record is active again', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { statecode: 1, statuscode: 2 } }] }, dv);
  assert.equal(dv.data.contacts[IDS.jane].statecode, 1);
  const { id, plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { statecode: 0, statuscode: 1 });
  assert.deepEqual(plan.refused, []);
  run(id, dv);
  assert.equal(dv.data.contacts[IDS.jane].statecode, 0);
  assert.equal(dv.data.contacts[IDS.jane].statuscode, 1);
});

test('a created record edited since is left out too', () => {
  const dv = fakeDv();
  const { id: orig, res } = applied({ mode: 'create', rows: [{ name: 'New One', body: { lastname: 'One' } }] }, dv);
  dv.touch('contacts', res.rows[0].id, { lastname: 'Uno' });
  assert.throws(() => revertOf(orig, dv), /Last Name: One -> Uno/);
});

test('rows the original did not write are not undone, and are listed', () => {
  const dv = fakeDv({ ignoreOnWrite: ['address1_line1'] }); // Bob's write reads back wrong
  const { id: orig } = applied({ mode: 'update', rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_line1: '1 Elm St' } },
  ] }, dv);
  const { plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows.map((r) => r.id), [IDS.jane]);
  assert.match(plan.refused.find((x) => x.id === IDS.bob).why, /not undone: the original write reported "read-back mismatch/);
});

test('nothing to undo: an unknown or cancelled plan', () => {
  const dv = fakeDv();
  assert.equal(findEntry(dv, '20261007-000000-00000000'), null);
  assert.throws(() => planRevert(dv, null, { envs: ENVS, access: ACCESS }), /no applied entry for that plan/);
  const id = makePlan({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'X' } }] }, dv);
  run(id, dv, () => ({ approved: false }));
  assert.equal(findEntry(dv, id), null, 'a cancel is keyed plan id + time, so it is never found as an applied entry');
});

test('a reverter without write access is refused at plan', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }, dv);
  const reader = fakeDv({ email: 'reader@example.org', data: dv.data });
  assert.throws(() => planRevert(reader, findEntry(reader, orig), { envs: ENVS, access: ACCESS }), /has read access to the Donor App, not write/);
});

// D-1174 (10/17): an entry over Dataverse's 1,048,576-character limit never landed, and was retried unchanged forever.
const ENTRY_LIMIT = 1048576;
const localLog = () => fs.readFileSync(fileFor(path.join(process.env.SBRM_DV_HOME, 'log'), 'dgross@example.org'), 'utf8');

test('a Write Log entry over the 1 MB limit lands trimmed to what undo needs, and undo still works from it', () => {
  const dv = fakeDv();
  const big = 'x'.repeat(300000); // body + changes (new and its text) + read-back: about 1.2 million characters in full
  const { id: orig, res } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: big } }] }, dv);
  assert.equal(res.logged.rowOk, true, 'the row lands');
  const row = Object.values(dv.data[LOG]).find((r) => r.sbrm_planid === orig);
  assert.ok(row.sbrm_entry.length <= ENTRY_LIMIT);
  assert.match(row.sbrm_entry, /Over Dataverse's 1 MB limit/);
  const entry = findEntry(dv, orig);
  assert.equal(entry.log_trimmed, 'bodies');
  assert.equal(entry.rows[0].body, undefined, 'the body copy is left out of the row');
  assert.ok(localLog().includes(`"plan_id": "${orig}"`) && localLog().length > row.sbrm_entry.length, 'the local log keeps the full entry');
  const { plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { address1_line1: '12 Old Rd' }, 'undo is planned from the trimmed row');
});

test('a NEW value over the limit is kept as its hash: undo writes back the old value and still sees a later change', () => {
  const dv = fakeDv();
  const big = 'y'.repeat(1100000); // the new value alone is over the limit; the old one is short
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: big } }] }, dv);
  const entry = findEntry(dv, orig);
  assert.equal(entry.log_trimmed, 'hashed');
  assert.equal(entry.rows[0].changes[0].old, '12 Old Rd', 'the value undo writes back is kept in full');
  assert.equal(entry.rows[0].changes[0].new, undefined);
  const { plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { address1_line1: '12 Old Rd' });
  dv.touch('contacts', IDS.jane, { address1_line1: `${big}!` }); // changed since: the hash no longer matches
  assert.throws(() => revertOf(orig, dv), /changed since/);
});

// RULED 10/23 (Dylan, "Split into rows"): when even the undo form does not fit one row, it goes across numbered rows.
test('an entry whose OLD values exceed the limit is split across Write Log rows, and undo joins them and works', () => {
  const dv = fakeDv();
  const big = 'y'.repeat(1100000);
  applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: big } }] }, dv);
  // now move it away: the OLD value, which undo writes back, is the huge one
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: '1 New St' } }] }, dv);
  const mine = Object.values(dv.data[LOG]).filter((r) => r.sbrm_planid === orig || r.sbrm_planid.startsWith(`${orig}-p`));
  assert.ok(mine.length >= 2, `split into ${mine.length} rows`);
  assert.ok(mine.every((r) => r.sbrm_entry.length <= ENTRY_LIMIT), 'every part fits');
  const parts = mine.filter((r) => r.sbrm_planid !== orig);
  assert.ok(parts.every((r) => r.sbrm_outcome === 'log part' && r.sbrm_written === 0 && r.sbrm_notwritten === 0), 'a part is not counted as a write');
  const entry = findEntry(dv, orig);
  assert.equal(entry.rows[0].changes[0].old, big, 'the joined entry holds the huge old value whole');
  const { plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { address1_line1: big });
});

test('a split entry\'s first row lands only after every part: a part that fails holds it back, on write and on retry', () => {
  const dv = fakeDv();
  const big = 'v'.repeat(1100000);
  applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: big } }] }, dv);
  const id = makePlan({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: '3 New St' } }] }, dv);
  const create = dv.create.bind(dv);
  let failPart = 2; // the write of part 2 fails twice: at the apply, then at the first retry
  dv.create = (set, body) => { if (set === LOG && body.sbrm_planid === `${id}-p2` && failPart > 0) { failPart -= 1; throw new DataverseError('timeout'); } return create(set, body); };
  run(id, dv);
  assert.equal(findEntry(dv, id), null, 'the first row is not written while a part is missing');
  flushPending(dv, 'donorapp');
  assert.equal(findEntry(dv, id), null, 'nor at a retry where the part fails again');
  flushPending(dv, 'donorapp');
  assert.equal(findEntry(dv, id).rows[0].changes[0].old, big, 'all land at the next retry, and undo joins them');
});

test('slices respect escaping: a value full of quotes and backslashes still splits into rows that each fit', () => {
  const { fitRows, ENTRY_MAX } = require('../lib/log');
  const person = { fullname: 'Test Person', email: 'dgross@example.org', systemuserid: IDS.me };
  const big = '"\\'.repeat(600000); // escapes to four times its length, twice over
  const entry = { time: new Date().toISOString(), headline: 'Update 1 contact', outcome: 'applied', plan_id: '20261023-120000-abcdef15', person, env: 'donorapp', app: 'Donor App', table: 'contacts', mode: 'update', source: 'test', reason: 'Test.', approval: 'prompt', left_out: [],
    rows: [{ name: 'Jane Example', id: IDS.jane, outcome: 'written', changes: [{ column: 'address1_line1', label: 'Street 1', old: big, new: '1 New St', old_text: big, new_text: '1 New St' }] }] };
  const texts = fitRows(entry);
  assert.ok(texts.length > 2 && texts.every((t) => t.length <= ENTRY_MAX), `${texts.length} parts, each under the limit`);
  const joined = JSON.parse(texts.map((t) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(t)[1]).chunk).join(''));
  assert.equal(joined.rows[0].changes[0].old, big);
});

test('a backtick-heavy value still splits into rows that each fit, and joins back whole (round 4)', () => {
  const { fitRows, ENTRY_MAX } = require('../lib/log');
  const person = { fullname: 'Test Person', email: 'dgross@example.org', systemuserid: IDS.me };
  const big = '`'.repeat(1100000); // each backtick is written as a six-character escape in the row
  const entry = { time: new Date().toISOString(), headline: 'Update 1 contact', outcome: 'applied', plan_id: '20261023-120000-abcdef16', person, env: 'donorapp', app: 'Donor App', table: 'contacts', mode: 'update', source: 'test', reason: 'Test.', approval: 'prompt', left_out: [],
    rows: [{ name: 'Jane Example', id: IDS.jane, outcome: 'written', changes: [{ column: 'address1_line1', label: 'Street 1', old: big, new: '1 New St', old_text: big, new_text: '1 New St' }] }] };
  const texts = fitRows(entry);
  assert.ok(texts.length > 1 && texts.every((t) => t.length <= ENTRY_MAX), `${texts.length} parts: ${texts.map((t) => t.length).join(', ')}`);
  const joined = JSON.parse(texts.map((t) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(t)[1]).chunk).join(''));
  assert.equal(joined.rows[0].changes[0].old, big);
});

test('an entry whose undo form fits one row only in compact form is still undoable (round 4: a one-part split)', () => {
  const dv = fakeDv();
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara' } }] }, dv);
  const key = Object.keys(dv.data[LOG]).find((k) => dv.data[LOG][k].sbrm_planid === orig);
  const entry = findEntry(dv, orig);
  entry.left_out = Array.from({ length: 20000 }, () => ({ name: 'x', id: null, why: 'x' })); // pretty-printed, over the limit
  const { fitRows } = require('../lib/log');
  const texts = fitRows(entry);
  assert.equal(texts.length, 1);
  dv.data[LOG][key].sbrm_entry = texts[0];
  assert.equal(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(texts[0])[1]).parts, 1, 'a one-part split');
  const { plan } = revertOf(orig, dv);
  assert.deepEqual(plan.rows[0].body, { address1_city: null }, 'Jane\'s city was blank before');
});

test('a split entry with a part missing or from another plan is refused, naming the part', () => {
  const dv = fakeDv();
  const big = 'y'.repeat(1100000);
  applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: big } }] }, dv);
  const { id: orig } = applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: '1 New St' } }] }, dv);
  const part2 = Object.entries(dv.data[LOG]).find(([, r]) => r.sbrm_planid === `${orig}-p2`);
  const saved = part2[1].sbrm_entry;
  part2[1].sbrm_entry = saved.replace(`"plan_id": "${orig}"`, '"plan_id": "20261001-000000-00000000"');
  assert.throws(() => findEntry(dv, orig), /part 2 of \d+ .*another plan|does not match/);
  part2[1].sbrm_entry = saved;
  delete dv.data[LOG][part2[0]];
  assert.throws(() => findEntry(dv, orig), /part 2 of \d+ .*missing/);
});

test('past the most parts allowed, the row keeps ids and outcomes only, and undo says where the full entry is', () => {
  const { fitRows } = require('../lib/log');
  const person = { fullname: 'Test Person', email: 'dgross@example.org', systemuserid: IDS.me };
  const big = 'y'.repeat(1100000);
  const entry = { time: new Date().toISOString(), headline: 'Update 1 contact', outcome: 'applied', plan_id: '20261023-120000-abcdef14', person, env: 'donorapp', app: 'Donor App', table: 'contacts', mode: 'update', source: 'test', reason: 'Test.', approval: 'prompt', left_out: [],
    rows: [{ name: 'Jane Example', id: IDS.jane, outcome: 'written', changes: [{ column: 'address1_line1', label: 'Address 1: Street 1', old: big, new: '1 New St', old_text: big, new_text: '1 New St' }] }] };
  const texts = fitRows(entry, undefined, { maxParts: 1 });
  assert.equal(texts.length, 1);
  const dv = fakeDv();
  dv.data[LOG] = { 'dddddddd-0000-0000-0000-000000000099': { sbrm_planid: entry.plan_id, sbrm_entry: texts[0] } };
  const got = findEntry(dv, entry.plan_id);
  assert.equal(got.log_trimmed, 'rows');
  assert.throws(() => planRevert(dv, got, { envs: ENVS, access: ACCESS }), (e) => e instanceof PlanRefused && /too large .* local log/.test(e.message + e.reasons.join(' ')));
});

test('a parked row over the limit (the 10/17 import) is trimmed when it is retried, and lands', () => {
  const dv = fakeDv();
  const id = makePlan({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: 'z'.repeat(300000) } }] }, dv);
  dv.logFails = true; // the row cannot be written now, so it is parked
  run(id, dv);
  dv.logFails = false;
  const pending = path.join(process.env.SBRM_DV_HOME, 'pending');
  const file = path.join(pending, `donorapp--${id}.json`);
  // As 1.11.18 and earlier parked it: the untrimmed text.
  const parked = JSON.parse(fs.readFileSync(file, 'utf8'));
  parked.sbrm_entry = entryText(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(localLog().slice(localLog().lastIndexOf('\n## ')))[1]));
  assert.ok(parked.sbrm_entry.length > ENTRY_LIMIT, 'the test row is over the limit, as the real one was');
  fs.writeFileSync(file, JSON.stringify(parked));
  assert.equal(flushPending(dv, 'donorapp'), 1);
  assert.ok(!fs.existsSync(file), 'nothing left parked');
  assert.equal(findEntry(dv, id).log_trimmed, 'bodies');
});

test('a parked row that needs splitting lands as all its parts when retried, and undo joins them', () => {
  const dv = fakeDv();
  const big = 'w'.repeat(1100000);
  applied({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: big } }] }, dv);
  const id = makePlan({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: '2 New St' } }] }, dv);
  dv.logFails = true;
  run(id, dv);
  dv.logFails = false;
  const pending = path.join(process.env.SBRM_DV_HOME, 'pending');
  for (const f of fs.readdirSync(pending).filter((x) => x.includes(id))) fs.rmSync(path.join(pending, f));
  // As 1.11.18 and earlier parked it: ONE untrimmed row.
  const last = localLog().slice(localLog().lastIndexOf('\n## '));
  const full = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(last)[1]);
  fs.writeFileSync(path.join(pending, `donorapp--${id}.json`), JSON.stringify({ sbrm_planid: id, sbrm_name: 'x', sbrm_outcome: 'applied', sbrm_entry: entryText(full) }));
  assert.equal(flushPending(dv, 'donorapp'), 1);
  assert.deepEqual(fs.readdirSync(pending).filter((x) => x.includes(id)), [], 'nothing left parked');
  assert.equal(findEntry(dv, id).rows[0].changes[0].old, big);
});

test('a huge reason or name never pushes out a small undo payload, and never breaks the limit (review round 2)', () => {
  const { fitForRow, ENTRY_MAX } = require('../lib/log');
  const person = { fullname: 'p'.repeat(1100000), email: 'dgross@example.org', systemuserid: IDS.me };
  const rows = [{ name: 'Jane Example', id: IDS.jane, outcome: 'written', changes: [{ column: 'address1_city', label: 'City', old: 'Goleta', new: 'Santa Barbara', old_text: 'Goleta', new_text: 'Santa Barbara' }] }];
  const entry = { time: new Date().toISOString(), headline: 'Update 1 contact', outcome: 'applied', plan_id: '20261023-120000-abcdef13', person, env: 'donorapp', app: 'Donor App', table: 'contacts', mode: 'update', source: 's'.repeat(1100000), reason: 'r'.repeat(1100000), approval: 'prompt', left_out: [], rows };
  const text = fitForRow(entry);
  assert.ok(text.length <= ENTRY_MAX, `fits (${text.length})`);
  const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);
  assert.equal(json.log_trimmed, 'bodies', 'the small undo payload stays');
  assert.equal(json.rows[0].changes[0].old, 'Goleta');
  // a huge row NAME does not push it out either (round 3)
  const named = { ...entry, person: { ...person, fullname: 'Test Person' }, rows: [{ ...rows[0], name: 'n'.repeat(1100000) }] };
  const t2 = fitForRow(named);
  assert.ok(t2.length <= ENTRY_MAX);
  assert.equal(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(t2)[1]).rows[0].changes[0].old, 'Goleta');
});

test('the last fallback always fits and its counts match the row: a huge reason, thousands of rows', () => {
  const { fitForRow, ENTRY_MAX, rowFor } = require('../lib/log');
  const person = { fullname: 'Test Person', email: 'dgross@example.org', systemuserid: IDS.me };
  const rows = Array.from({ length: 6000 }, (_, i) => ({ name: `${'n'.repeat(200)}${i}`, id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, outcome: 'written' }));
  const entry = { time: new Date().toISOString(), headline: 'Update 6000 contacts', outcome: 'applied', plan_id: '20261023-120000-abcdef12', person, env: 'donorapp', app: 'Donor App', table: 'contacts', mode: 'update', source: 'test', reason: 'r'.repeat(1100000), approval: 'prompt', left_out: [], rows };
  const text = fitForRow(entry);
  assert.ok(text.length <= ENTRY_MAX, `fits (${text.length})`);
  const row = rowFor(entry, text);
  assert.equal(row.sbrm_written, 6000);
  assert.match(text, /Rows: 6000 written, 0 not written/, 'the text tells the same count as the row');
  const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);
  assert.equal(json.log_trimmed, 'all');
  assert.equal(json.rows_total, 6000);
});

test('the revert module cannot write: it never imports the write connection', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'revert.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/write['"]\)/.test(src));
  assert.ok(!/require\(['"]\.\/apply['"]\)/.test(src));
});
