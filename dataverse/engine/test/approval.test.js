'use strict';
// The approval through the REAL command path (DESIGN.md §10n, 1.11.0): with no `confirm` injected, apply
// writes only on a good one-time ticket (minted by the guard when Claude Code asks the person), and a batch
// runs each plan on its own ticket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-approval-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });

const { fakeDv, IDS } = require('./fake');
fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'),
  JSON.stringify({ donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false } }));

const cli = require('../dataverse-write');
const ticket = require('../lib/ticket');

const EVENTS = 'sbrm_dataverseevents';
// No `confirm`: the ticket path is the one that runs.
const deps = (dv) => ({ readConnection: () => dv, writeConnection: () => dv, eventConnection: () => ({ createEvent: (b) => dv.create(EVENTS, b) }) });
const writes = (dv) => dv.calls.filter((c) => c.method !== 'GET' && !/^sbrm_dataverse(writelogs|events)/.test(c.path));

async function quiet(fn) {
  const real = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = real; }
}

let n = 0;
async function planId(dv, who = IDS.jane, name = 'Jane Example') {
  n += 1;
  const f = path.join(HOME, `job-${n}.json`);
  fs.writeFileSync(f, JSON.stringify({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'update', source: 'test', reason: 'Test.',
    intent: { verb: 'update', count: 1, table: 'contacts', fields: ['address1_city'] },
    rows: [{ name, id: who, body: { address1_city: `Town ${n}` } }],
  }));
  assert.equal(await quiet(() => cli.runCli(['plan', f], deps(dv))), 0);
  return cli.lastRun.planId;
}

test('no ticket: apply is refused as a signal event and nothing is written', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await planId(dv);
  const code = await quiet(() => cli.runCli(['apply', id], deps(dv)));
  assert.equal(code, 1);
  assert.deepEqual(writes(dv), []);
  const e = cli.lastRun.events.find((x) => x.reason_code === 'no_approval');
  assert.ok(e, 'recorded as no_approval');
  assert.equal(e.signal, true);
  assert.match(e.detail, /not approved in Claude Code's permission prompt/);
});

test('a good ticket: the apply writes and uses the ticket up; the same apply again is refused', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await planId(dv);
  ticket.mint(id);
  assert.equal(await quiet(() => cli.runCli(['apply', id], deps(dv))), 0);
  assert.equal(writes(dv).length, 1);
  assert.equal(ticket.check(id).ok, false, 'used up');
});

test('a ticket for another plan does not approve this one', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const a = await planId(dv);
  const b = await planId(dv);
  ticket.mint(a);
  assert.equal(await quiet(() => cli.runCli(['apply', b], deps(dv))), 1);
  assert.deepEqual(writes(dv), []);
  ticket.take(a);
});

test('a batch: each plan runs on its own ticket, in order; one without a ticket fails alone', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  // a and b change Jane and Bob; c changes Bob too, which still stands because b (no ticket) never writes.
  const a = await planId(dv);
  const b = await planId(dv, IDS.bob, 'Bob Sample');
  const c = await planId(dv, IDS.bob, 'Bob Sample');
  ticket.mint(a);
  ticket.mint(c);
  const code = await quiet(() => cli.runBatch(['apply', a, b, c], deps(dv)));
  assert.equal(code, 1, 'the worst exit code');
  assert.equal(writes(dv).length, 2, 'a and c written, b refused');
});

test('an approval answered after the ticket ran out is refused as routine approval_expired, not a bypass', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await planId(dv);
  ticket.mint(id, { now: Date.now() - ticket.TTL_MS - 1000 });
  assert.equal(await quiet(() => cli.runCli(['apply', id], deps(dv))), 1);
  assert.deepEqual(writes(dv), []);
  const e = cli.lastRun.events.find((x) => x.reason_code === 'approval_expired');
  assert.ok(e, 'recorded as approval_expired');
  assert.equal(e.signal, false);
});

test('a batch takes every ticket as it starts, so a slow early plan cannot make a later one expire', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const a = await planId(dv);
  const b = await planId(dv, IDS.bob, 'Bob Sample');
  ticket.mint(a);
  ticket.mint(b);
  let firstTake = null;
  const spy = { take: (k) => { if (!firstTake) firstTake = k; return ticket.take(k); }, check: ticket.check };
  assert.equal(await quiet(() => cli.runBatch(['apply', a, b], { ...deps(dv), ticket: spy })), 0);
  assert.equal(ticket.check(a).ok || ticket.check(b).ok, false, 'both used');
  assert.equal(firstTake, a);
  assert.equal(writes(dv).length, 2);
});
