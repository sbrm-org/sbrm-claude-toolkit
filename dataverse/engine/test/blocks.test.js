'use strict';
// Guard blocks recorded and reported (1.11.6, DESIGN.md §11; lib/blocks.js). Dylan 10/9: reports should go in
// automatically when a hook blocks a legitimate action and the person's Claude notices. Every store here is a
// throwaway one (CLAUDE.md trap: a spawned guard or CLI without SBRM_DV_HOME writes to the real store).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-blocks-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });
fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'),
  JSON.stringify({ donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false } }));

const { fakeDv } = require('./fake');
const blocks = require('../lib/blocks');
const events = require('../lib/events');
const review = require('../lib/review');
const cli = require('../dataverse-write');

const ROOT = path.join(__dirname, '..', '..', '..'); // the plugin root (CLAUDE_PLUGIN_ROOT in the hook)
const GUARD = path.join(__dirname, '..', '..', 'guard', 'guard.js');
const RUN = path.join(__dirname, '..', '..', 'guard', 'run.sh');
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const EVENTS = 'sbrm_dataverseevents';
const RAW_WRITE = 'curl -X PATCH https://sbrmdonorapp.crm.dynamics.com/api/data/v9.2/contacts(1) -d @b.json';
const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:/work/project', session_id: 'sess-1', permission_mode: 'auto', ...extra });

function hook(input, env = {}, via = 'node') {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-hook-'));
  const full = { ...process.env, SBRM_DV_HOME: store, CLAUDE_PLUGIN_ROOT: ROOT, ...env };
  delete full.SBRM_GUARD_PROBE;
  if (env.SBRM_GUARD_PROBE) full.SBRM_GUARD_PROBE = env.SBRM_GUARD_PROBE;
  const r = via === 'bash'
    ? spawnSync(BASH, [RUN], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: full })
    : spawnSync(process.execPath, [GUARD], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: full });
  const evFile = path.join(store, 'events', 'events.jsonl');
  const lines = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const pend = fs.existsSync(path.join(store, 'events', 'pending')) ? fs.readdirSync(path.join(store, 'events', 'pending')) : [];
  return { ...r, store, lines, pend };
}

function go(argv, d) {
  const real = console.log;
  const said = [];
  console.log = (...a) => said.push(a.join(' '));
  try {
    const code = cli.runCli(argv, d);
    return { code, run: cli.lastRun, out: `${cli.lastRun.output.join('\n')}\n${said.join('\n')}` };
  } finally {
    console.log = real;
  }
}

function deps(dv) {
  return {
    readConnection: () => dv, writeConnection: () => dv, confirm: () => ({ approved: true }),
    eventConnection: () => ({ createEvent: (b) => dv.create(EVENTS, b) }),
    cli: () => ({ version: '1.0.34' }), io: () => ({ home: HOME, cwd: HOME, read: () => null }),
  };
}

// ---- the guard's half, through the real hook path ----

test('a block is recorded (call, rule, folder, mode, session, version) and queued as a routine event; the message gives the id and the report command', (t) => {
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  const r = hook(bash(RAW_WRITE), {}, 'bash');
  assert.equal(r.status, 2);
  assert.equal(r.lines.length, 1);
  const e = r.lines[0];
  assert.deepEqual([e.kind, e.reason_code, e.signal, e.env], ['blocked', 'blocked', false, 'donorapp'], 'routine; filed to the app the call named');
  assert.match(e.event_id, blocks.ID);
  assert.equal(e.block.call, RAW_WRITE, 'the call exactly as the guard saw it');
  assert.deepEqual([e.block.tool, e.block.cwd, e.block.session, e.block.mode], ['Bash', 'C:/work/project', 'sess-1', 'auto']);
  assert.match(e.versions, /^toolkit [^;]+; guard; Node /);
  assert.match(e.headline, /^Blocked \[[^\]]+\]: Bash$/);
  assert.deepEqual(r.pend, [`donorapp--${e.event_id}.json`]);
  const engine = path.join(ROOT, 'dataverse', 'engine', 'dataverse-write.js').replace(/\\/g, '/');
  assert.ok(r.stderr.includes(`Block ${e.event_id} is recorded on this machine.`), r.stderr);
  assert.ok(r.stderr.includes(`node "${engine}" report --blocked ${e.event_id} "<one plain sentence: what you were doing>"`), r.stderr);
  assert.match(r.stderr, /Report it yourself, without asking first/);
  assert.match(r.stderr, /Do not look for another way/, 'the old rule stands');
});

test('the report command the message gives passes the guard (with ordinary sentences, quotes and symbols in it)', () => {
  const engine = path.join(ROOT, 'dataverse', 'engine', 'dataverse-write.js').replace(/\\/g, '/');
  const id = 'B-20261009-142233-a1b2c3';
  for (const s of [
    'I was reading a log file to count its lines; nothing was written.',
    "I was searching the guard's own docs for the word delete",
    'checking which version of the toolkit is installed (a read)',
    'comparing two folders: a > b in size, nothing changed',
  ]) {
    const r = hook(bash(`node "${engine}" report --blocked ${id} "${s}"`));
    assert.equal(r.status, 0, `${s}\n${r.stderr}`);
    assert.equal(r.lines.length, 0);
  }
});

test('Edit and Write calls are recorded with the file and a bounded excerpt', () => {
  const big = 'x'.repeat(10000);
  const text = blocks.callText({ tool_name: 'Write', tool_input: { file_path: 'C:/a/b.js', content: big } });
  assert.match(text, /^C:\/a\/b\.js\n--- content \(10000 characters\) ---\n/);
  assert.match(text, /\[\.\.\. 7000 more characters\]$/);
  const ed = blocks.callText({ tool_name: 'Edit', tool_input: { file_path: 'C:/a/b.js', old_string: 'one', new_string: 'two' } });
  assert.equal(ed, 'C:/a/b.js\n--- old ---\none\n--- new ---\ntwo');
});

test('nothing is recorded for doctor\'s probes; a failure to record still blocks, without an id', () => {
  const probe = hook(bash(RAW_WRITE), { SBRM_GUARD_PROBE: '1' });
  assert.equal(probe.status, 2);
  assert.equal(probe.lines.length, 0);
  assert.deepEqual(probe.pend, []);
  assert.ok(!probe.stderr.includes('report --blocked'));
  // A store that cannot be written (a FILE where the folder should be).
  const f = path.join(HOME, 'not-a-folder');
  fs.writeFileSync(f, 'x');
  const broken = hook(bash(RAW_WRITE), { SBRM_DV_HOME: f });
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /^BLOCKED by the SBRM toolkit Dataverse guard/);
  assert.ok(!broken.stderr.includes('report --blocked'));
  const garbled = hook('{not json');
  assert.equal(garbled.status, 2);
  assert.equal(garbled.lines.length, 0);
});

test('a block about Recovery is filed to Recovery (the HIPAA app), even when another app is named too', () => {
  const envs = { donorapp: { host: 'https://sbrmdonorapp.crm.dynamics.com' }, recovery: { host: 'https://sbrmrec.crm.dynamics.com' }, _about: 'x' };
  assert.equal(blocks.envOf('curl https://sbrmrec.crm.dynamics.com/api', envs), 'recovery');
  assert.equal(blocks.envOf('mcp__plugin_sbrm-toolkit_dataverse-recovery__update_record', envs), 'recovery');
  assert.equal(blocks.envOf('sbrmdonorapp.crm.dynamics.com and sbrmrec.crm.dynamics.com', envs), 'recovery');
  assert.equal(blocks.envOf('ls -la', envs), 'machine');
});

test('the rule comes from the message: the named rule and token, else the reason up to its first bracket', () => {
  assert.deepEqual(blocks.ruleOf('keystroke injection [rule: injection; matched: "SendWait" in a call that sends input]'), { rule: 'injection', matched: 'SendWait' });
  assert.deepEqual(blocks.ruleOf("changing the engine's own store (plans, log, events)"), { rule: "changing the engine's own store", matched: null });
});

// ---- the engine's half ----

function recordOne(command = RAW_WRITE) {
  return blocks.record(bash(command), "changing the engine's own store (plans, log, events)", { envs: {} });
}

test('report --blocked: filed as an OPEN item with the block attached, labelled as Claude\'s description; a second report of the same block files nothing', () => {
  const dv = fakeDv();
  const b = recordOne('ls ~/notes | wc -l');
  const sentence = 'I was counting files in my notes folder; nothing was changed';
  const { code, run, out } = go(['report', '--blocked', b.block_id, sentence], deps(dv));
  assert.equal(code, 0, out);
  const rows = Object.values(dv.data[EVENTS] || {});
  const row = rows.find((x) => x.sbrm_eventid === run.events[0].event_id);
  assert.deepEqual([row.sbrm_kind, row.sbrm_reasoncode, row.sbrm_signal, row.sbrm_status], ['blocked by guard', 'false_block', true, 'open']);
  assert.equal(row.sbrm_words, `Claude: ${sentence}`, 'never presented as the person\'s words');
  assert.match(row.sbrm_detail, /The description is Claude's, not the person's words\./);
  assert.ok(row.sbrm_detail.includes(`Guard block ${b.block_id}`));
  assert.ok(row.sbrm_detail.includes('The call, as the guard saw it:\nls ~/notes | wc -l'));
  assert.match(row.sbrm_detail, /Rule: changing the engine's own store/);
  assert.match(row.sbrm_name, /^Guard block looks wrong \[changing the engine's own store\]: Bash, toolkit /);
  assert.match(out, new RegExp(`Reported as ${row.sbrm_number}: the blocked call`));
  // the routine block event went up with it (same machine, same send)
  assert.ok(rows.some((x) => x.sbrm_eventid === b.block_id && x.sbrm_kind === 'blocked' && x.sbrm_signal === false && x.sbrm_status === null));
  const again = go(['report', '--blocked', b.block_id, 'again'], deps(dv));
  assert.equal(again.code, 0);
  assert.match(again.out, /already reported/);
  assert.equal(Object.values(dv.data[EVENTS]).filter((x) => x.sbrm_reasoncode === 'false_block').length, 1);
});

test('report --blocked refuses an id this machine never recorded, and a missing id', () => {
  assert.equal(go(['report', '--blocked', 'B-20000101-000000-000000', 'x'], deps(fakeDv())).code, 2);
  assert.equal(go(['report', '--blocked', 'not-an-id', 'x'], deps(fakeDv())).code, 2);
  assert.equal(go(['report', '--blocked'], deps(fakeDv())).code, 2);
});

test('a person\'s own report carries the recent guard blocks too, and their words stay verbatim', () => {
  const dv = fakeDv();
  const b = recordOne('cat notes.md');
  const { run } = go(['report', 'it keeps blocking me'], deps(dv));
  const row = Object.values(dv.data[EVENTS]).find((x) => x.sbrm_eventid === run.events[0].event_id);
  assert.equal(row.sbrm_words, 'it keeps blocking me');
  assert.match(row.sbrm_detail, /Guard blocks on this machine, last 24 hours \(newest first\):/);
  assert.ok(row.sbrm_detail.includes(b.block_id));
});

test('every event names the toolkit version (the engine constant alone did not move across 1.11.1 to 1.11.5)', () => {
  assert.match(events.versions(), /^toolkit [^;]+; engine /);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-plugin-'));
  fs.mkdirSync(path.join(root, '.claude-plugin'));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '\uFEFF{"name":"sbrm-toolkit","version":"9.9.9"}');
  assert.equal(blocks.toolkitVersion(root), '9.9.9');
  assert.equal(blocks.toolkitVersion(path.join(root, 'nowhere')), 'unknown');
});

test('review: guard blocks are counted by rule on their own line, not as routine refusals; versions show the toolkit', () => {
  const now = new Date('2026-10-09T17:00:00');
  const ev = (o) => ({ env: 'donorapp', email: 'a@example.org', name: 'Alex Rivera', time: '2026-10-09T10:00:00', signal: false, status: null, ...o });
  const s = review.summarize({ now, logs: [], events: [
    ev({ kind: 'blocked', code: 'blocked', headline: 'Blocked [injection]: Bash' }),
    ev({ kind: 'blocked', code: 'blocked', headline: 'Blocked [injection]: Write' }),
    ev({ kind: 'blocked', code: 'blocked', headline: "Blocked [changing the engine's own store]: Bash" }),
    ev({ kind: 'refused', code: 'usage', headline: 'x', time: '2026-10-09T11:00:00', versions: 'toolkit 1.11.6; engine 2026.10.09.1; Dataverse CLI 1.0.81; Node v24' }),
  ] });
  assert.deepEqual(s.routine, { usage: 1 });
  assert.deepEqual(s.blocks, { injection: 2, "changing the engine's own store": 1 });
  const text = review.render(s);
  assert.match(text, /Guard blocks: 3 {3}\(injection 2, changing the engine's own store 1; any Claude judged wrong are under Open\)/);
  assert.match(text, /toolkit 1\.11\.6 {2}CLI 1\.0\.81/);
});

// ---- the other automatic reports (DESIGN.md §11, candidates 1-5, Dylan 10/9: "Ill take your 5 recommendations") ----

const note = require('../lib/note');
const ofCode = (code) => note.history().filter((x) => x.reason_code === code);

test('1. the THIRD block by one rule in a day opens one item; a fourth adds nothing; a rule Claude already reported opens none', () => {
  const what = (r) => `a test rule [rule: ${r}; matched: "x"]`;
  const at = new Date();
  blocks.record(bash('ls a'), what('alpha'), { envs: {}, now: at });
  blocks.record(bash('ls b'), what('alpha'), { envs: {}, now: at });
  assert.equal(ofCode('repeat_block').filter((x) => x.rule === 'alpha').length, 0, 'two is not yet a pattern');
  blocks.record(bash('ls c'), what('alpha'), { envs: {}, now: at });
  const items = ofCode('repeat_block').filter((x) => x.rule === 'alpha');
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].kind, items[0].signal, items[0].env], ['repeated block', true, 'machine']);
  assert.match(items[0].headline, /^Blocked 3 times today by one rule \[alpha\], and Claude has not reported it$/);
  for (const c of ['ls a', 'ls b', 'ls c']) assert.ok(items[0].detail.includes(`The call, as the guard saw it:\n${c}`));
  blocks.record(bash('ls d'), what('alpha'), { envs: {}, now: at });
  assert.equal(ofCode('repeat_block').filter((x) => x.rule === 'alpha').length, 1, 'one item per rule per day');
  // beta: Claude reported the first block, so the third opens nothing more
  const first = blocks.record(bash('ls e'), what('beta'), { envs: {}, now: at });
  assert.equal(go(['report', '--blocked', first.block_id, 'listing a folder'], deps(fakeDv())).code, 0);
  blocks.record(bash('ls f'), what('beta'), { envs: {}, now: at });
  blocks.record(bash('ls g'), what('beta'), { envs: {}, now: at });
  assert.equal(ofCode('repeat_block').filter((x) => x.rule === 'beta').length, 0);
});

test('2. review: someone whose latest event names an older toolkit (or none) is listed as behind; the newest version seen is current', () => {
  const now = new Date('2026-10-09T17:00:00');
  const ev = (email, name, versions, time = '2026-10-09T10:00:00') => ({ env: 'donorapp', email, name, time, kind: 'refused', code: 'usage', signal: false, status: null, headline: 'x', versions });
  const s = review.summarize({ now, logs: [], toolkit: '1.11.5', events: [
    ev('d@example.org', 'Dana Example', 'toolkit 1.11.6; engine 2026.10.09.1; Dataverse CLI 1.0.81'),
    ev('a@example.org', 'Alex Rivera', 'toolkit 1.11.4; engine x; Dataverse CLI 1.0.81'),
    ev('k@example.org', 'Kim Lee', 'engine 2026.10.08.4; Dataverse CLI 1.0.81'),
    ev('k@example.org', 'Kim Lee', 'toolkit 1.11.10; engine y; Dataverse CLI 1.0.81', '2026-10-08T10:00:00'),
  ] });
  assert.equal(s.toolkit, '1.11.10', 'numeric, not text, order; the reviewer\'s own older install does not set it');
  assert.deepEqual(s.behind.map((p) => [p.name, p.version]), [['Alex Rivera', '1.11.4'], ['Dana Example', '1.11.6'], ['Kim Lee', null]], 'Kim\'s LATEST event is the one that counts');
  const text = review.render(s);
  assert.match(text, /Behind on the toolkit \(now 1\.11\.10\): Alex Rivera \(last seen 10\/9 on 1\.11\.4\); Dana Example \(last seen 10\/9 on 1\.11\.6\); Kim Lee \(last seen 10\/9 on a version before 1\.11\.6\)\. If they have not updated since: quit Claude Code completely and reopen it/);
  assert.match(review.brief(s), /Alex, Dana, Kim behind on the toolkit \(now 1\.11\.10\)/);
  const even = review.summarize({ now, logs: [], toolkit: '1.11.6', events: [ev('d@example.org', 'Dana Example', 'toolkit 1.11.6; engine z; Dataverse CLI 1')] });
  assert.match(review.render(even), /Toolkit: everyone seen is on 1\.11\.6\./);
  assert.ok(!/behind/.test(review.brief(even)));
});

test('3. the guard could not run: run.sh leaves a plain line (blocked or not), and the next engine run turns the lines into ONE open item', (t) => {
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-down-'));
  const env = { ...process.env, SBRM_DV_HOME: store, SBRM_GUARD_TEST_NO_NODE: '1' };
  const a = spawnSync(BASH, [RUN], { input: JSON.stringify(bash(RAW_WRITE)), encoding: 'utf8', env });
  const b = spawnSync(BASH, [RUN], { input: JSON.stringify(bash('ls')), encoding: 'utf8', env });
  assert.deepEqual([a.status, b.status], [2, 0], 'the fallback still decides as before');
  const lines = fs.readFileSync(path.join(store, 'events', 'guard_down.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tNode was not found \(test\)\tBash$/);
  // The engine's half, in this file's own store.
  const own = path.join(process.env.SBRM_DV_HOME, 'events', 'guard_down.log');
  fs.copyFileSync(path.join(store, 'events', 'guard_down.log'), own);
  const dv = fakeDv();
  go(['report', 'anything'], deps(dv));
  assert.ok(!fs.existsSync(own), 'claimed');
  assert.deepEqual(fs.readdirSync(path.dirname(own)).filter((n) => n.startsWith('guard_down')), [], 'and the claimed copy removed');
  const items = Object.values(dv.data[EVENTS]).filter((x) => x.sbrm_reasoncode === 'guard_down');
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].sbrm_signal, items[0].sbrm_status, items[0].sbrm_envkey], [true, 'open', 'machine']);
  assert.match(items[0].sbrm_name, /^The guard could not run on this machine 2 time\(s\) \(Node was not found \(test\)\)/);
  assert.match(items[0].sbrm_detail, /Tools: Bash/);
  go(['report', 'again'], deps(dv));
  assert.equal(Object.values(dv.data[EVENTS]).filter((x) => x.sbrm_reasoncode === 'guard_down').length, 1, 'nothing new without new lines');
});

test('4. a read connection that cannot start is recorded once per app per day, filed as the machine\'s', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-mcpfail-'));
  const LAUNCH = path.join(__dirname, '..', '..', 'mcp', 'launch.js');
  const env = { ...process.env, SBRM_DV_HOME: store, SBRM_DATAVERSE_CLI: path.join(os.tmpdir(), 'no-such-dataverse.exe') };
  for (const app of ['donorapp', 'donorapp', 'hgs']) assert.equal(spawnSync(process.execPath, [LAUNCH, app], { input: '', encoding: 'utf8', env }).status, 1);
  const got = fs.readFileSync(path.join(store, 'events', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(got.map((x) => [x.reason_code, x.app, x.signal, x.env]), [['mcp_failed', 'donorapp', true, 'machine'], ['mcp_failed', 'hgs', true, 'machine']]);
  assert.match(got[0].headline, /^The Donor App read connection could not start: SBRM_DATAVERSE_CLI points at a missing file/);
  assert.equal(fs.readdirSync(path.join(store, 'events', 'pending')).length, 2);
});

test('5. an approval Claude Code asked for that never ran is counted once (routine); one given too late is not counted again', () => {
  const ticket = require('../lib/ticket');
  const PLAN = '20261009-100000-0a1b2c3d';
  const LATE = '20261009-100100-0a1b2c3e';
  const then = Date.now() - 10 * 60 * 1000;
  ticket.mint(PLAN, { now: then });
  ticket.mint(LATE, { now: then });
  // The sweep judges by the FILE's age: make both files as old as their tickets.
  const tdir = path.join(process.env.SBRM_DV_HOME, 'config', 'tickets');
  for (const k of [PLAN, LATE]) fs.utimesSync(path.join(tdir, `${k}.json`), then / 1000, then / 1000);
  assert.equal(ticket.take(LATE).why, 'expired', 'approved after three minutes');
  ticket.sweep();
  ticket.sweep();
  const got = ofCode('approval_unused');
  assert.equal(got.length, 1, 'the declined one, once; the late one is already approval_expired');
  assert.deepEqual([got[0].kind, got[0].signal, got[0].env], ['approval not used', false, 'machine']);
  assert.match(got[0].headline, new RegExp(`plan ${PLAN} and it never ran \\(declined or not answered\\)`));
  assert.deepEqual(fs.readdirSync(path.join(process.env.SBRM_DV_HOME, 'config', 'tickets')).filter((n) => n.includes(PLAN)), []);
});
