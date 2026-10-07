'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Every store/log path goes to a throwaway folder, set BEFORE the modules read it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-apply-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const { validateJob } = require('../lib/contract');
const { planJob } = require('../lib/resolve');
const { savePlan, loadPlan } = require('../lib/store');
const { applyPlan, ApplyRefused } = require('../lib/apply');
const { readEntries } = require('../lib/log');
const { confirm, timeoutSeconds } = require('../lib/dialog');
const { fakeDv, IDS, ENVS, ACCESS } = require('./fake');

const LOG = 'sbrm_dataversewritelogs';
const logRows = (dv) => Object.values(dv.data[LOG] || {});
const entryOf = (row) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(row.sbrm_entry)[1]);

function makePlan(raw, dv, { when = new Date() } = {}) {
  const fields = [...new Set(raw.rows.flatMap((r) => Object.keys(r.body)))].sort();
  const res = validateJob({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', source: 'test', reason: 'Test.',
    intent: { verb: raw.mode, count: raw.rows.length, table: 'contacts', fields }, ...raw,
  }, { envs: ENVS });
  assert.deepEqual(res.errors, []);
  return savePlan(planJob(dv, res.job, { envs: ENVS, access: ACCESS }), { now: when }).id;
}

const approve = () => ({ approved: true });
const cancel = () => ({ approved: false });
const run = (id, dv, over = {}) => applyPlan(id, { access: ACCESS, connect: () => dv, confirm: approve, ...over });
// DATA writes only: the log row is a POST too, and is checked separately.
const writes = (dv) => dv.calls.filter((c) => c.method !== 'GET' && c.path !== LOG);

const twoRowUpdate = {
  mode: 'update',
  rows: [
    { name: 'Jane Example', id: IDS.jane, body: { address1_city: 'Santa Barbara', 'parentcustomerid_account@odata.bind': `/accounts(${IDS.acme})` } },
    { name: 'Bob Sample', id: IDS.bob, body: { address1_city: 'Santa Barbara' } },
  ],
};

test('approve: writes, reads back, logs a Dataverse row AND locally, consumes the plan', () => {
  const dv = fakeDv();
  const id = makePlan(twoRowUpdate, dv);
  let shown = null;
  const res = run(id, dv, { confirm: (x) => { shown = x; return { approved: true }; } });
  assert.equal(res.outcome, 'applied');
  assert.equal(res.written, 2);
  assert.match(shown.summaryText, /^Update 2 contacts in the Donor App/);
  assert.match(shown.detailText, /Company Name: \(blank\) -> Acme Foundation/);
  assert.equal(dv.data.contacts[IDS.jane].address1_city, 'Santa Barbara');
  assert.equal(dv.data.contacts[IDS.jane]._parentcustomerid_value, IDS.acme);
  assert.ok(writes(dv).every((c) => c.method === 'PATCH' && /^W\/"\d+"$/.test(c.etag)), 'every PATCH carries If-Match');
  assert.throws(() => loadPlan(id), /no plan/, 'plan consumed: it cannot be applied twice');
  assert.equal(res.logged.rowOk, true);
  const rows = logRows(dv);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.sbrm_planid, id, 'an applied entry is keyed by its plan id (what revert looks up)');
  assert.equal(row.createdby, IDS.me, 'written through the person\'s own connection');
  assert.equal(row.sbrm_name, 'Update 2 contacts in the Donor App');
  assert.deepEqual([row.sbrm_outcome, row.sbrm_mode, row.sbrm_tablename, row.sbrm_written, row.sbrm_notwritten, row.sbrm_leftout],
    ['applied', 'update', 'contacts', 2, 0, 0]);
  assert.deepEqual(row.sbrm_recordids.split('\n').sort(), [IDS.jane, IDS.bob].sort());
  const e = entryOf(row);
  assert.equal(e.outcome, 'applied');
  assert.deepEqual(readEntries(res.logged.local).find((x) => x.plan_id === id), e, 'the local copy is the same entry');
  assert.equal(e.person.systemuserid, IDS.me);
  assert.equal(e.rows[0].before.address1_city, null, 'full before kept for revert');
  assert.equal(e.rows[0].after._parentcustomerid_value, IDS.acme);
  const text = fs.readFileSync(res.logged.local, 'utf8');
  assert.ok(text.includes(`"plan_id": "${id}"`));
  const t = new Date(e.time);
  const local = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  assert.ok(text.includes(`## ${local} - Update 2 contacts`), 'heading in local time');
});

test('cancel: nothing written, plan kept, the cancel is logged', () => {
  const dv = fakeDv();
  const id = makePlan(twoRowUpdate, dv);
  const res = run(id, dv, { confirm: cancel });
  assert.equal(res.outcome, 'cancelled');
  assert.deepEqual(writes(dv), []);
  assert.equal(loadPlan(id).intact, true);
  assert.equal(readEntries(res.logged.local).find((x) => x.plan_id === id).outcome, 'cancelled');
  const [row] = logRows(dv);
  assert.equal(row.sbrm_outcome, 'cancelled');
  assert.match(row.sbrm_planid, new RegExp(`^${id}-c\\d{6}$`), 'a cancel is keyed plan id + time');
  // The kept plan applied later: a SECOND row, keyed by the plan id, no duplicate-key clash.
  const later = run(id, dv);
  assert.equal(later.outcome, 'applied');
  assert.equal(later.logged.rowOk, true);
  assert.deepEqual(logRows(dv).map((r) => r.sbrm_outcome).sort(), ['applied', 'cancelled']);
  assert.ok(logRows(dv).some((r) => r.sbrm_planid === id));
});

test('refusals before any pop-up: edited plan, stale plan, different person, access revoked', () => {
  const asked = () => { throw new Error('the pop-up must not be shown'); };
  const dv = fakeDv();

  const edited = makePlan(twoRowUpdate, dv);
  const f = path.join(process.env.SBRM_DV_HOME, 'plans', `${edited}.json`);
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  rec.rows[1].id = IDS.inactive;
  fs.writeFileSync(f, JSON.stringify(rec));
  assert.throws(() => run(edited, dv, { confirm: asked }), (e) => e instanceof ApplyRefused && /changed after it was made/.test(e.message));

  const old = makePlan(twoRowUpdate, dv, { when: new Date(Date.now() - 25 * 3600 * 1000) });
  assert.throws(() => run(old, dv, { confirm: asked }), /more than 24 hours old/);

  const mine = makePlan(twoRowUpdate, dv);
  assert.throws(() => run(mine, fakeDv({ userId: IDS.bob }), { confirm: asked }), /made by Test Person; you are signed in as/);
  assert.throws(() => run(mine, dv, { confirm: asked, access: { people: {} } }), /now read, not write/);
  assert.deepEqual(writes(dv), []);
});

test('a record changed since the plan is left out and shown; the rest is written', () => {
  const dv = fakeDv();
  const id = makePlan(twoRowUpdate, dv);
  dv.touch('contacts', IDS.bob, { address1_city: 'Carpinteria' });
  let shown = null;
  const res = run(id, dv, { confirm: (x) => { shown = x; return { approved: true }; } });
  assert.equal(res.written, 1);
  assert.match(shown.summaryText, /^Update 1 contact in the Donor App/);
  assert.match(shown.summaryText, /Bob Sample: changed since the plan \(Address 1: City: Goleta -> Carpinteria\)/);
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Carpinteria', 'the other person\'s edit survives');
});

test('a change between the check and the write is refused by If-Match, nothing lands', () => {
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob && !d.hit) { d.hit = true; d.touch(set, id, { firstname: 'Robert' }); } } });
  const id = makePlan(twoRowUpdate, dv);
  const res = run(id, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[1].outcome, /changed between the check and the write; nothing was written/);
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Goleta');
});

test('a read-back that disagrees is flagged, never reported as written', () => {
  const dv = fakeDv({ ignoreOnWrite: ['address1_city'] });
  const id = makePlan(twoRowUpdate, dv);
  const res = run(id, dv);
  assert.match(res.rows[0].outcome, /read-back mismatch: Address 1: City/);
  assert.equal(res.written, 0);
});

test('create: written with its new id; a duplicate that appears after the plan is left out', () => {
  const dupHits = [];
  const dv = fakeDv({ dupHits });
  const id = makePlan({ mode: 'create', rows: [
    { name: 'New One', body: { lastname: 'One' }, dup_filter: "lastname eq 'One'" },
    { name: 'New Two', body: { lastname: 'Two' }, dup_filter: "lastname eq 'Two'" },
  ] }, dv);
  dupHits.push("lastname eq 'Two'");
  const res = run(id, dv);
  assert.equal(res.written, 1);
  assert.match(res.rows[0].id, /^cccccccc-/);
  assert.match(res.left_out[0].why, /already recorded since the plan/);
  assert.equal(writes(dv).filter((c) => c.method === 'POST').length, 1);
});

test('a log row that cannot be written is parked, and lands at the next apply in that environment', () => {
  const pending = path.join(process.env.SBRM_DV_HOME, 'pending');
  const dv = fakeDv();
  dv.logFails = true;
  const id = makePlan({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: '1 First St' } }] }, dv);
  const res = run(id, dv);
  assert.equal(res.outcome, 'applied', 'the data write stands even when its log row fails');
  assert.equal(res.logged.rowOk, false);
  assert.match(res.logged.error, /missing prvCreatesbrm_dataversewritelog/);
  assert.ok(fs.readdirSync(pending).includes(`donorapp--${id}.json`));
  assert.equal(logRows(dv).length, 0);

  dv.logFails = false;
  const id2 = makePlan({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: '2 Second St' } }] }, dv);
  const res2 = run(id2, dv);
  assert.equal(res2.logged.flushed, 1);
  assert.deepEqual(fs.readdirSync(pending), []);
  assert.deepEqual(logRows(dv).map((r) => r.sbrm_planid).sort(), [id, id2].sort());
});

test('re-sending a row that already landed is not an error and makes no duplicate', () => {
  const pending = path.join(process.env.SBRM_DV_HOME, 'pending');
  const dv = fakeDv();
  const id = makePlan({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: '3 Third St' } }] }, dv);
  run(id, dv);
  const [row] = logRows(dv);
  fs.writeFileSync(path.join(pending, `donorapp--${id}.json`), JSON.stringify(row)); // e.g. a timeout after the row landed
  const id2 = makePlan({ mode: 'update', rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_line1: '4 Fourth St' } }] }, dv);
  run(id2, dv);
  assert.deepEqual(fs.readdirSync(pending), []);
  assert.equal(logRows(dv).filter((r) => r.sbrm_planid === id).length, 1);
});

test('dialog: only an exact APPROVE approves; Show every change opens the detail and asks again', () => {
  const answers = ['SHOW', 'APPROVE'];
  const opened = [];
  const r = confirm({ summaryText: 's', detailText: 'd', title: 't' }, { ask: () => ({ answer: answers.shift() }), open: (f) => opened.push([f, fs.readFileSync(f, 'utf8')]) });
  assert.equal(r.approved, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0][1], 'd');
  assert.ok(opened[0][0].startsWith(process.env.SBRM_DV_HOME), 'detail written inside the store, not a shared temp folder');
  assert.equal(fs.existsSync(opened[0][0]), false, 'detail deleted once the pop-up closes');
  for (const a of ['approve', 'Approve', 'OK', '', undefined, 'CANCEL']) {
    assert.equal(confirm({ summaryText: 's', detailText: 'd', title: 't' }, { ask: () => ({ answer: a }), open: () => {} }).approved, false, `answer ${a}`);
  }
});

test('the timeout knob can only shorten the wait (and a timeout is always Cancel)', () => {
  assert.equal(timeoutSeconds({ SBRM_DV_DIALOG_TIMEOUT: '5' }), 5);
  assert.equal(timeoutSeconds({ SBRM_DV_DIALOG_TIMEOUT: '999999' }), 600);
  assert.equal(timeoutSeconds({ SBRM_DV_DIALOG_TIMEOUT: '-1' }), 600);
  assert.equal(timeoutSeconds({}), 600);
});
