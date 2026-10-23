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
const { fakeDv, IDS, ENVS, ACCESS } = require('./fake');
const { DataverseError } = require('../lib/cli');

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

test('an address change applies: the unasked address1_composite is not kept as a before-value (live 10/8)', () => {
  // Live 10/8 (GIK 858, Nicole Scott): Dataverse returned address1_composite unasked at plan, built from the
  // selected parts only; apply then SELECTED it and got the full text, so every address update was refused
  // as "changed since the plan" although nothing had changed.
  const dv = fakeDv();
  const id = makePlan({ mode: 'update', rows: [{ name: 'Bob Sample', id: IDS.bob, body: { address1_line1: '2028 Monterey St' } }] }, dv);
  assert.ok(!('address1_composite' in loadPlan(id).record.rows[0].before), 'only the columns the plan asked for are kept');
  const res = run(id, dv);
  assert.equal(res.outcome, 'applied');
  assert.equal(dv.data.contacts[IDS.bob].address1_line1, '2028 Monterey St');
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
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob && !d.hit) { d.hit = true; d.touch(set, id, { address1_city: 'Carpinteria' }); } } });
  const id = makePlan(twoRowUpdate, dv);
  const res = run(id, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[1].outcome, /changed between the check and the write \(changed since the plan \(Address 1: City: Goleta -> Carpinteria\)\); nothing was written/);
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Carpinteria', 'the other person\'s edit survives');
  assert.equal(writes(dv).filter((c) => c.path === `contacts(${IDS.bob})`).length, 1, 'a planned column that moved is never retried');
});

// 1.11.18 (#6hm9gfJr34wX8xxr): the version stamp moved but the planned columns did not (a rollup after a gift,
// two donor address updates, 10/13 and 10/15). Re-checked as step 1 does, and written once more.
test('a version stamp that moved without the planned columns moving is re-checked and written on a second try', () => {
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob && !d.hit) { d.hit = true; d.touch(set, id, { firstname: 'Robert' }); } } });
  const id = makePlan(twoRowUpdate, dv);
  const res = run(id, dv);
  assert.equal(res.outcome, 'applied');
  assert.equal(res.rows[1].outcome, 'written');
  assert.match(res.rows[1].note, /version stamp moved .* planned columns had not.* second try/);
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Santa Barbara');
  assert.equal(dv.data.contacts[IDS.bob].firstname, 'Robert', 'the unplanned change survives');
  const bobPatches = writes(dv).filter((c) => c.path === `contacts(${IDS.bob})`);
  assert.equal(bobPatches.length, 2);
  assert.notEqual(bobPatches[0].etag, bobPatches[1].etag, 'the retry carries the fresh version stamp');
  const [row] = logRows(dv);
  assert.match(row.sbrm_entry, /note: the version stamp moved/);
});

test('the version-stamp retry happens once: a stamp that moves again keeps the refusal', () => {
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob) d.touch(set, id, { firstname: `R${d.calls.length}` }); } });
  const id = makePlan(twoRowUpdate, dv);
  const res = run(id, dv);
  assert.match(res.rows[1].outcome, /changed between the check and the write; nothing was written/);
  assert.equal(writes(dv).filter((c) => c.path === `contacts(${IDS.bob})`).length, 2, 'one write and ONE retry, never a loop');
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Goleta');
});

// 1.11.18 (#6hpr4W9XWR2RXrcJ, D-1240): the CLI gave up on a PATCH after 120 s; whether it landed is read, never assumed.
const TIMEOUT_TEXT = (id) => `non-JSON response to PATCH api/data/v9.2/contacts(${id}): fail: DataverseCli.Api.ApiCatalog[0] Api HTTP failed. `
  + `target=dataverse method=PATCH path=/api/data/v9.2/contacts(${id}) durationMs=120010 errorType=TaskCanceledException`;
const timedOut = (id) => new DataverseError(TIMEOUT_TEXT(id));

test('a write that times out AFTER it landed is re-read and logged as written, with a note', () => {
  const dv = fakeDv({ afterWrite: (d, set, id) => { if (id === IDS.bob) throw timedOut(id); } });
  const id = makePlan(twoRowUpdate, dv);
  const slept = [];
  const res = run(id, dv, { sleep: (ms) => slept.push(ms) });
  assert.equal(res.outcome, 'applied');
  assert.equal(res.rows[1].outcome, 'written');
  assert.match(res.rows[1].note, /request timed out .* the change landed/);
  assert.equal(res.rows[1].after.address1_city, 'Santa Barbara', 'the re-read is the after-image, so undo works');
  assert.deepEqual(slept, [], 'it landed at the first re-read: no waiting');
  assert.equal(writes(dv).filter((c) => c.path === `contacts(${IDS.bob})`).length, 1, 'a timed-out write is never sent again');
  const [row] = logRows(dv);
  assert.match(row.sbrm_entry, /note: the request timed out/);
});

test('a write that times out and never lands is failed after the re-reads, saying it may still land', () => {
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob) throw timedOut(id); } });
  const id = makePlan(twoRowUpdate, dv);
  const slept = [];
  const res = run(id, dv, { sleep: (ms) => slept.push(ms) });
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[1].outcome, /^failed: the request timed out .* not on the record after 2 minutes.* may still land/);
  assert.match(res.rows[1].outcome, /TaskCanceledException/, 'the CLI error is kept');
  assert.equal(slept.reduce((a, b) => a + b, 0), 120000, 'two minutes of re-reads, then it stops');
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Goleta');
  assert.equal(writes(dv).filter((c) => c.path === `contacts(${IDS.bob})`).length, 1, 'never sent twice');
});

test('a write that times out and lands while the engine waits is logged as written', () => {
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob) throw timedOut(id); } });
  const id = makePlan(twoRowUpdate, dv);
  let n = 0;
  // the server finishes the PATCH during the second wait (D-1240's shape: slow synchronous work behind the update)
  const res = run(id, dv, { sleep: () => { n += 1; if (n === 2) dv.touch('contacts', IDS.bob, { address1_city: 'Santa Barbara' }); } });
  assert.equal(res.rows[1].outcome, 'written');
  assert.match(res.rows[1].note, /timed out/);
  assert.equal(n, 2);
});

test('a timed-out update whose re-reads all fail says it is NOT KNOWN whether it landed, never that it did not', () => {
  const dv = fakeDv({ afterWrite: (d, set, id) => { if (id === IDS.bob) throw timedOut(id); } });
  const id = makePlan(twoRowUpdate, dv);
  const get = dv.get.bind(dv);
  let armed = false;
  dv.update = ((update) => (...a) => { if (a[1] === IDS.bob) armed = true; return update(...a); })(dv.update.bind(dv));
  dv.get = (p, o) => { if (armed && p.startsWith(`contacts(${IDS.bob})`)) throw new DataverseError('Principal user is missing prvReadContact privilege'); return get(p, o); };
  const res = run(id, dv, { sleep: () => {} });
  assert.match(res.rows[1].outcome, /^failed: the request timed out .* could not be re-read .* not known/);
  assert.doesNotMatch(res.rows[1].outcome, /was not on the record/);
});

test('a create whose new id came back but whose read-back timed out is re-read by that id and keeps it', () => {
  const dv = fakeDv();
  const id = makePlan({ mode: 'create', rows: [{ name: 'New One', body: { lastname: 'One' } }] }, dv);
  const get = dv.get.bind(dv);
  let failed = false;
  dv.get = (p, o) => { if (!failed && p.startsWith('contacts(cccccccc')) { failed = true; throw new DataverseError('non-JSON response to GET: errorType=TaskCanceledException'); } return get(p, o); };
  const res = run(id, dv, { sleep: () => {} });
  assert.equal(res.rows[0].outcome, 'written');
  assert.match(res.rows[0].id, /^cccccccc-/, 'the new record id is logged, so undo can find it');
  assert.match(res.rows[0].note, /timed out/);
});

test('absence is claimed only from the LAST re-read: a write that lands after an early read, then cannot be read, is "not known"', () => {
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob) throw timedOut(id); } });
  const id = makePlan(twoRowUpdate, dv);
  const get = dv.get.bind(dv);
  let n = 0;
  let blind = false;
  dv.get = (p, o) => { if (blind && p.startsWith(`contacts(${IDS.bob})`)) throw new DataverseError('Principal user is missing prvReadContact privilege'); return get(p, o); };
  const res = run(id, dv, { sleep: () => { n += 1; if (n === 1) { dv.touch('contacts', IDS.bob, { address1_city: 'Santa Barbara' }); blind = true; } } });
  assert.match(res.rows[1].outcome, /could not be re-read .* not known/);
  assert.doesNotMatch(res.rows[1].outcome, /was not on the record/);
});

test('a create that went through but whose read-back timed out reports what the re-read shows (a mismatch stays a mismatch)', () => {
  const dv = fakeDv({ ignoreOnWrite: ['lastname'] });
  const id = makePlan({ mode: 'create', rows: [{ name: 'New One', body: { lastname: 'One' } }] }, dv);
  const get = dv.get.bind(dv);
  let failed = false;
  dv.get = (p, o) => { if (!failed && p.startsWith('contacts(cccccccc')) { failed = true; throw new DataverseError('non-JSON response to GET: errorType=TaskCanceledException'); } return get(p, o); };
  const res = run(id, dv, { sleep: () => {} });
  assert.match(res.rows[0].outcome, /^read-back mismatch: Last Name/);
  assert.match(res.rows[0].id, /^cccccccc-/);
  assert.ok(res.rows[0].after, 'the re-read is kept as the after-image');
});

test('a write that went through but could never be read back says so, and is not called failed', () => {
  const dv = fakeDv();
  const id = makePlan(twoRowUpdate, dv);
  const get = dv.get.bind(dv);
  let written = false;
  dv.update = ((update) => (...a) => { const r = update(...a); if (a[1] === IDS.bob) written = true; return r; })(dv.update.bind(dv));
  dv.get = (p, o) => { if (written && p.startsWith(`contacts(${IDS.bob})`)) throw new DataverseError('non-JSON response to GET: errorType=TaskCanceledException'); return get(p, o); };
  const res = run(id, dv, { sleep: () => {} });
  assert.match(res.rows[1].outcome, /^read-back failed: the write went through but the record could not be read back/);
  assert.equal(dv.data.contacts[IDS.bob].address1_city, 'Santa Barbara');
  const [row] = logRows(dv);
  assert.match(row.sbrm_entry, /Rows: 1 written, 1 not written \(1 of them went through but could not be verified\)/, 'the totals do not hide that it went through');
});

test('the re-reads after a timeout stop at two minutes of WALL time, even when each read is slow', () => {
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob) throw timedOut(id); } });
  const id = makePlan(twoRowUpdate, dv);
  let clock = Date.parse('2026-10-23T12:00:00Z');
  const get = dv.get.bind(dv);
  dv.get = (p, o) => { if (p.startsWith(`contacts(${IDS.bob})`)) clock += 60000; return get(p, o); }; // each read takes a minute
  const reads = () => dv.calls.filter((c) => c.method === 'GET' && c.path.startsWith(`contacts(${IDS.bob})`)).length;
  const before = { n: 0 };
  const res = run(id, dv, { sleep: () => {}, clock: () => clock, confirm: (x) => { before.n = reads(); return { approved: true }; } });
  assert.match(res.rows[1].outcome, /not on the record after 2 minutes/);
  assert.ok(reads() - before.n <= 4, `stopped by the clock, not after 13 reads (${reads() - before.n} reads)`);
});

test('a write that lands during the last wait is seen: the wait that crosses the deadline is followed by ONE final read', () => {
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob) throw timedOut(id); } });
  const id = makePlan(twoRowUpdate, dv);
  const t0 = Date.parse('2026-10-23T12:00:00Z');
  let clock = t0;
  let landed = false;
  // reads take no time; each wait advances the clock; the PATCH finishes 115 s in, inside the 110 -> 120 s wait
  const sleep = (ms) => { clock += ms; if (!landed && clock - t0 >= 115000) { landed = true; dv.touch('contacts', IDS.bob, { address1_city: 'Santa Barbara' }); } };
  const res = run(id, dv, { sleep, clock: () => clock });
  assert.equal(res.rows[1].outcome, 'written');
});

test('no re-read starts after the two-minute deadline except the one final read: a slow first read ends the re-reads', () => {
  const dv = fakeDv({ beforeWrite: (d, set, id) => { if (id === IDS.bob) throw timedOut(id); } });
  const id = makePlan(twoRowUpdate, dv);
  let clock = Date.parse('2026-10-23T12:00:00Z');
  const get = dv.get.bind(dv);
  let after = 0;
  let armed = false;
  dv.get = (p, o) => { if (armed && p.startsWith(`contacts(${IDS.bob})`)) { after += 1; clock += 119000; } return get(p, o); }; // the first re-read takes 119 s
  dv.update = ((update) => (...a) => { if (a[1] === IDS.bob) armed = true; return update(...a); })(dv.update.bind(dv));
  run(id, dv, { sleep: (ms) => { clock += ms; }, clock: () => clock });
  assert.equal(after, 2, 'the wait after the first re-read crosses the deadline, so only the one final read follows');
});

test('a create that times out is failed with a warning not to re-run blind (a second create would duplicate it)', () => {
  const dv = fakeDv();
  const id = makePlan({ mode: 'create', rows: [{ name: 'New One', body: { lastname: 'One' } }] }, dv);
  const create = dv.create.bind(dv);
  dv.create = (set, body) => { if (set === LOG) return create(set, body); create(set, body); throw new DataverseError('non-JSON response to POST api/data/v9.2/contacts: errorType=TaskCanceledException'); };
  const res = run(id, dv, { sleep: () => {} });
  assert.match(res.rows[0].outcome, /^failed: the request timed out .* may have been created: check before running it again/);
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

test('records are never deleted (ruled 10/8): a delete plan from an earlier toolkit is refused at apply, nothing written', () => {
  const dv = fakeDv();
  const id = makePlan(twoRowUpdate, dv);
  // A 1.10.x delete plan still on disk: the same signed shape, mode delete.
  const { record } = loadPlan(id);
  const { id: old } = savePlan({ ...record, mode: 'delete', id: undefined, hash: undefined, nonce: undefined, created: undefined });
  let asked = false;
  assert.throws(() => run(old, dv, { confirm: () => { asked = true; return { approved: true }; } }), (e) => e instanceof ApplyRefused && /never deleted/.test(e.message) && e.code === 'not_permitted');
  assert.equal(asked, false, 'refused before any approval is used');
  assert.deepEqual(writes(dv), []);
});
