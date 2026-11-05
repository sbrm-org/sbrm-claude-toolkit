'use strict';
// events.flush (D-1255 .. D-1482, 10/29/26 review): one event file that fails on its own (too big, malformed) used to stop
// the queue at its place, so every later check-in on that machine waited behind it while the app's other events, sorted
// earlier, still went up. Now a failure is PROBED against the next file: the next one sends = the failure is the file's
// own, so the queue goes on and the file gets a try counted; three such tries park it (kept on the machine, shown by the
// health check). The next one fails too = the app or the connection is down: stop, count nothing (as before).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-flush-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
const events = require('../lib/events');
const store = require('../lib/store');

const pendingDir = () => store.dir(path.join('events', 'pending'));
function reset() {
  for (const d of ['pending', 'parked']) fs.rmSync(path.join(store.dir('events'), d), { recursive: true, force: true });
  fs.rmSync(path.join(store.dir('events'), 'tries.json'), { force: true });
}
// n check-ins, in send order; returns their event ids. One run per test (two runs in the same second sort by a random
// suffix, while real later check-ins come from later runs and sort after).
let RUN = null;
function checkins(n, fresh = false) {
  if (fresh || !RUN) RUN = events.newRun(['test']);
  return Array.from({ length: n }, (_, i) => events.record(RUN, { kind: 'version check-in', headline: `c${i}`, env: 'machine', signal: false }).event_id);
}
// A connection that fails for the named event ids (or for everything).
function conn({ bad = [], all = false } = {}) {
  const got = [];
  return {
    got,
    createEvent(body) {
      if (all || bad.includes(body.sbrm_eventid)) throw new Error(all ? 'connect ECONNREFUSED' : 'The length of the entry exceeds the limit');
      got.push(body.sbrm_eventid);
    },
  };
}
const left = () => fs.readdirSync(pendingDir()).filter((f) => f.endsWith('.json'));

test('a file that fails on its own no longer blocks the check-ins behind it', () => {
  reset();
  const [a, b, c] = checkins(3, true);
  const k = conn({ bad: [a] });
  const r = events.flush(k, 'donorapp');
  assert.deepEqual(k.got, [b, c]);
  assert.equal(r.sent, 2);
  assert.equal(r.error, null);
  assert.deepEqual(r.skipped, [`machine--${a}.json`]);
  assert.deepEqual(left(), [`machine--${a}.json`], 'the failing file stays for a later try');
});

test('three failures of its own park the file: off the queue, kept on the machine, counted for the health check', () => {
  reset();
  const [a] = checkins(2, true);
  for (let i = 0; i < 2; i++) {
    checkins(1);
    events.flush(conn({ bad: [a] }), 'donorapp');
    assert.ok(left().includes(`machine--${a}.json`), `still pending after try ${i + 1}`);
  }
  checkins(1);
  const r = events.flush(conn({ bad: [a] }), 'donorapp');
  assert.deepEqual(r.parked, [`machine--${a}.json`]);
  assert.deepEqual(left(), []);
  assert.equal(events.parkedCount(), 1);
  assert.ok(fs.existsSync(path.join(store.dir('events'), 'parked', `machine--${a}.json`)));
});

test('the app unreachable (every file fails): stops at the first, counts no try, parks nothing', () => {
  reset();
  checkins(3, true);
  for (let i = 0; i < 5; i++) {
    const r = events.flush(conn({ all: true }), 'donorapp');
    assert.equal(r.sent, 0);
    assert.match(r.error, /ECONNREFUSED/);
  }
  assert.equal(left().length, 3);
  assert.equal(events.parkedCount(), 0);
});

test('a lone failing file (nothing behind it to probe with) stops as before and counts no try', () => {
  reset();
  const [a] = checkins(1, true);
  for (let i = 0; i < 4; i++) assert.match(events.flush(conn({ bad: [a] }), 'donorapp').error, /exceeds/);
  assert.deepEqual(left(), [`machine--${a}.json`]);
  assert.equal(events.parkedCount(), 0);
});

// 1.11.27 review F2: two failing files in a row read as the app being down (the probe of the next file failed too), so
// the queue stopped behind them for good. The probe now looks further ahead: any later file that sends shows the
// failures before it are their own; only when every file it tries fails is the app down.
test('two failing files in a row no longer block the queue behind them; each counts a try', () => {
  reset();
  const [a, b, c, d] = checkins(4, true);
  const k = conn({ bad: [a, b] });
  const r = events.flush(k, 'donorapp');
  assert.deepEqual(k.got, [c, d]);
  assert.equal(r.error, null);
  assert.deepEqual(r.skipped, [`machine--${a}.json`, `machine--${b}.json`]);
  assert.deepEqual(left(), [`machine--${a}.json`, `machine--${b}.json`]);
});

test('failing files with nothing sendable behind them stop the queue and count nothing', () => {
  reset();
  const [a, b] = checkins(2, true);
  const r = events.flush(conn({ bad: [a, b] }), 'donorapp');
  assert.match(r.error, /exceeds/);
  assert.equal(r.sent, 0);
  assert.deepEqual(r.skipped, []);
  assert.equal(events.parkedCount(), 0);
});
