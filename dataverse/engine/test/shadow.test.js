'use strict';
// The guard's shadow record (lib/shadow.js; guard_review/DESIGN.md §6d, §7). 1.11.10-1.11.13: the old guard decided
// and guard_next.js watched. From the 1.11.14 cut-over guard_next.js decides and the old verdict watches; a
// disagreement is recorded (old = the watcher, next = the decision made), never acted on.
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
  assert.match(e.headline, /^Shadow \[old block \/ next allow\]: Bash \(ran; only the old model would have stopped it\)$/);
  // since the 1.11.14 cut-over the NEXT model decides (#6hr2m7pRppqwGmvr item 4: the detail said "Old (decided)")
  assert.match(e.detail, /^The guard's old model \(watching only since the 1\.11\.14 cut-over\) disagreed with the next model, which decided/);
  assert.match(e.detail, /\nNext \(decided\): allow\nOld \(watching only\): block/);
  assert.doesNotMatch(e.detail, /Old \(decided\)|1\.11\.11 candidate|shadow only/);
  assert.ok(pending().some((f) => f.endsWith(`${e.event_id}.json`)), 'queued for the app\'s event table');
});

test('old allow / next block opens an item for the review, at most DAILY_OPEN a day', () => {
  for (let i = 0; i < shadow.DAILY_OPEN + 2; i += 1) shadow.record(bash(`ls x${i}`), { kind: 'allow', why: null }, { kind: 'block', why: 'x' });
  const today = shadowEvents().filter((e) => /next block/.test(e.headline));
  assert.equal(today.filter((e) => e.signal).length, shadow.DAILY_OPEN);
  assert.equal(today.length, shadow.DAILY_OPEN + 2, 'the rest are still counted');
  assert.match(today[0].headline, /\(stopped; the old model would have let it run\)$/);
});

// The cut-over (1.11.14, guard_review/DESIGN.md §7): the NEXT model decides; the old verdict watches for two weeks.
test('the hook: the NEXT model decides; the old verdict\'s disagreement is recorded, an agreement is not', () => {
  const n0 = shadow.lines().length;
  // old blocks (the variable name in a grep), next allows: it RUNS now, and the old guard's block is recorded
  const r1 = run(bash('grep -c "SBRM_DV_CONFIG" CLAUDE.md'));
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(shadow.lines().length, n0 + 1);
  const l = shadow.lines().pop();
  assert.deepEqual([l.old.kind, l.next.kind], ['block', 'allow'], 'old = the watcher, next = the decision made');
  // both allow: nothing recorded
  const r2 = run(bash('ls'));
  assert.equal(r2.status, 0);
  assert.equal(shadow.lines().length, n0 + 1);
  // both block: blocked, nothing recorded
  const r3 = run(bash(['r', 'm -rf ~/.sbrm-dataverse/plans'].join('')));
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /engine's own store/);
  assert.equal(shadow.lines().length, n0 + 1);
  // doctor's probes are not recorded
  const r4 = run(bash('grep -c "SBRM_DV_CONFIG" CLAUDE.md'), { SBRM_GUARD_PROBE: '1' });
  assert.equal(r4.status, 0);
  assert.equal(shadow.lines().length, n0 + 1);
});

test('the hook: the next model\'s question (a plugin install, fork 5) reaches Claude Code as an ask, with no ticket', () => {
  const tickets = () => { try { return fs.readdirSync(path.join(process.env.SBRM_DV_HOME, 'config', 'tickets')).length; } catch { return 0; } };
  const t0 = tickets();
  const r = run(bash('claude plugin install foo@bar'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /adding a plugin to Claude Code/);
  assert.equal(tickets(), t0, 'an ask that is not an apply mints nothing');
});

test('the hook: the approval layer is the next model\'s too (the apply words as data pass, Group A)', () => {
  const { approvalCases } = guard.selftestCases();
  const grep = approvalCases.find(([l]) => l.startsWith('grep for the words'));
  assert.ok(guard.approvalVerdict(grep[1]) && guard.approvalVerdict(grep[1]).block, 'the old approval layer refuses it');
  const r = run({ ...grep[1], cwd: os.tmpdir(), session_id: 's1' });
  assert.equal(r.status, 0, r.stderr);
});

test('a crash in the old verdict never changes the decision; it is recorded as a disagreement', () => {
  const n0 = shadow.lines().length;
  const boom = { decideOld() { throw new Error('old boom'); } };
  assert.doesNotThrow(() => guard.shadowOld(bash('ls'), { kind: 'allow', why: null }, { next: boom }));
  const l = shadow.lines().pop();
  assert.equal(shadow.lines().length, n0 + 1);
  assert.deepEqual([l.old.kind, l.next.kind], ['crash', 'allow']);
  assert.match(l.old.why, /old boom/);
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
  assert.match(review.render(s), /Guard shadow \(old model watching\): 3 disagreements \(2 ran that the old model would have stopped, 1 stopped that the old model would have allowed: each is an Open item to judge\)/);
  // events recorded before 1.11.24 carry the old suffix and still count by their prefix
  const s2 = review.summarize({ now, access: { people: {} }, logs: [], events: [ev('Shadow [old allow / next block]: Bash (stopped; the old model would have let it run)', true), ev('Shadow [old block / next allow]: Bash (ran; only the old model would have stopped it)')] });
  assert.deepEqual(s2.shadow, { total: 2, unblocked: 1, newStops: 1 });
});
