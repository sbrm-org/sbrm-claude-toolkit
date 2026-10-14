'use strict';
// The next guard model in SHADOW (1.11.10, lib/shadow.js; guard_review/DESIGN.md §6d): the old guard decides every
// call; a disagreement with guard_next.js is recorded, never acted on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-shadow-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store'); // never the real store (CLAUDE.md trap)
delete process.env.SBRM_GUARD_PROBE;

const shadow = require('../lib/shadow');
const note = require('../lib/note');
const guard = require('../../guard/guard');
const review = require('../lib/review');

const GUARD = path.join(__dirname, '..', '..', 'guard', 'guard.js');
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: os.tmpdir(), permission_mode: 'default', session_id: 's1' });
const run = (input, env = {}) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
const pending = () => fs.readdirSync(path.join(process.env.SBRM_DV_HOME, 'events', 'pending'));
const shadowEvents = () => note.history().filter((e) => e.reason_code === 'guard_shadow');

test('record: the call and both verdicts go to guard_shadow.jsonl and to an event; old block / next allow is routine', () => {
  const before = shadow.lines().length;
  shadow.record(bash('grep -c "SBRM_DV_CONFIG" CLAUDE.md'), { kind: 'block', why: 'moving the store' }, { kind: 'allow', why: null });
  const lines = shadow.lines();
  assert.equal(lines.length, before + 1);
  const l = lines[lines.length - 1];
  assert.deepEqual([l.old.kind, l.next.kind, l.tool], ['block', 'allow', 'Bash']);
  assert.match(l.call, /SBRM_DV_CONFIG/);
  const e = shadowEvents().pop();
  assert.equal(e.signal, false, 'what the redesign is for: counted, not opened');
  assert.match(e.headline, /^Shadow \[old block \/ next allow\]: Bash$/);
  assert.ok(pending().some((f) => f.endsWith(`${e.event_id}.json`)), 'queued for the app\'s event table');
});

test('old allow / next block opens an item for the review, at most DAILY_OPEN a day', () => {
  for (let i = 0; i < shadow.DAILY_OPEN + 2; i += 1) shadow.record(bash(`ls x${i}`), { kind: 'allow', why: null }, { kind: 'block', why: 'x' });
  const today = shadowEvents().filter((e) => /next block/.test(e.headline));
  assert.equal(today.filter((e) => e.signal).length, shadow.DAILY_OPEN);
  assert.equal(today.length, shadow.DAILY_OPEN + 2, 'the rest are still counted');
  assert.match(today[0].headline, /the redesign would stop this call/);
});

test('the hook: the OLD guard decides; a disagreement is recorded, an agreement is not', () => {
  const n0 = shadow.lines().length;
  // old blocks (the variable name in a grep), next allows
  const r1 = run(bash('grep -c "SBRM_DV_CONFIG" CLAUDE.md'));
  assert.equal(r1.status, 2, 'still blocked: the shadow has no authority');
  assert.equal(shadow.lines().length, n0 + 1);
  // both allow: nothing recorded
  const r2 = run(bash('ls'));
  assert.equal(r2.status, 0);
  assert.equal(shadow.lines().length, n0 + 1);
  // doctor's probes are not recorded
  const r3 = run(bash('grep -c "SBRM_DV_CONFIG" CLAUDE.md'), { SBRM_GUARD_PROBE: '1' });
  assert.equal(r3.status, 2);
  assert.equal(shadow.lines().length, n0 + 1);
});

test('a crash in the next model never changes the decision; it is recorded as a disagreement', () => {
  const n0 = shadow.lines().length;
  const boom = { decideNext() { throw new Error('boom'); } };
  assert.doesNotThrow(() => guard.shadow(bash('ls'), { kind: 'allow', why: null }, { next: boom }));
  const l = shadow.lines().pop();
  assert.equal(shadow.lines().length, n0 + 1);
  assert.equal(l.next.kind, 'crash');
  assert.match(l.next.why, /boom/);
});

test('the review counts shadow disagreements on a line of their own, apart from routine refusals', () => {
  const now = new Date();
  const ev = (headline, signal = false) => ({ time: now.toISOString(), code: 'guard_shadow', kind: 'guard shadow', signal, headline, email: 'a@example.org' });
  const s = review.summarize({
    now, access: { people: {} }, logs: [],
    events: [ev('Shadow [old block / next allow]: Bash'), ev('Shadow [old block / next allow]: Bash'), ev('Shadow [old allow / next block]: Bash (the redesign would stop this call)', true)],
  });
  assert.equal(s.routine.guard_shadow, undefined);
  assert.deepEqual(s.shadow, { total: 3, unblocked: 2, newStops: 1 });
  assert.match(review.render(s), /Guard shadow \(next model\): 3 disagreements \(2 the redesign unblocks, 1 it would newly stop/);
});
