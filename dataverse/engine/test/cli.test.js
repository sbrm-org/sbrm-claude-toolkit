'use strict';
// The CLI wrapper and the event record (DESIGN.md §7). Drives the REAL command paths through
// runCli() with a fake Dataverse injected, so what is tested is what a person runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-cli-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });

const { fakeDv, IDS } = require('./fake');
fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'),
  JSON.stringify({ donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false } }));

const { runCli } = require('../dataverse-write');
const cli = require('../dataverse-write');
const events = require('../lib/events');

const EVENTS = 'sbrm_dataverseevents';
const approve = () => ({ approved: true });
const eventRows = (dv) => Object.values(dv.data[EVENTS] || {});
const pendingPath = () => require('../lib/store').dir(path.join('events', 'pending'));
const pending = () => fs.readdirSync(pendingPath());
const clearPending = () => { for (const f of pending()) fs.rmSync(path.join(pendingPath(), f)); };

function deps(dv, over = {}) {
  return {
    readConnection: () => dv,
    writeConnection: () => dv,
    confirm: approve,
    eventConnection: () => ({ createEvent: (b) => dv.create(EVENTS, b) }),
    ...over,
  };
}

// Run quietly; return { code, run }.
function go(argv, d) {
  const real = console.log;
  console.log = () => {};
  try {
    const code = runCli(argv, d);
    return { code, run: cli.lastRun };
  } finally {
    console.log = real;
  }
}

let jobN = 0;
function jobFile(over = {}) {
  const job = {
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'update', source: 'test', reason: 'Test.',
    intent: { verb: 'update', count: 1, table: 'contacts', fields: ['address1_city'] },
    rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: `Town ${jobN}` } }],
    ...over,
  };
  jobN += 1;
  const f = path.join(HOME, `job-${jobN}.json`);
  fs.writeFileSync(f, JSON.stringify(job));
  return f;
}

function planId(dv) {
  const { code, run } = go(['plan', jobFile()], deps(dv));
  assert.equal(code, 0);
  return run.planId;
}

test('a SIGNAL refusal (read access) is printed, recorded, and lands in the event table as an open issue', () => {
  clearPending();
  const dv = fakeDv({ email: 'reader@example.org' });
  const { code, run } = go(['plan', jobFile()], deps(dv));
  assert.equal(code, 1);
  assert.equal(run.events.length, 1);
  const e = run.events[0];
  assert.deepEqual([e.kind, e.reason_code, e.signal, e.env], ['refused', 'access_read', true, 'donorapp']);
  const [row] = eventRows(dv);
  assert.equal(row.sbrm_eventid, e.event_id);
  assert.equal(row.sbrm_runid, run.id);
  assert.equal(row.sbrm_status, 'open', 'signal events open as issues');
  assert.equal(row.sbrm_signal, true);
  assert.equal(row.createdby, IDS.me, 'written through the person\'s own connection');
  assert.match(row.sbrm_name, /has read access to the Donor App, not write/);
  assert.match(row.sbrm_detail, /REFUSED: the plan\. Nothing was planned\./, 'the detail is what the person saw');
  assert.deepEqual(pending(), [], 'sent, so nothing waits on the machine');
});

test('a ROUTINE refusal (intent mismatch, invalid job) is recorded with no status', () => {
  clearPending();
  const dv = fakeDv();
  const bad = go(['plan', jobFile({ intent: { verb: 'update', count: 2, table: 'contacts', fields: ['address1_city'] } })], deps(dv));
  assert.equal(bad.code, 1);
  assert.deepEqual([bad.run.events[0].reason_code, bad.run.events[0].signal], ['intent_mismatch', false]);
  const typo = go(['plan', jobFile({ colour: 'red' })], deps(dv));
  assert.equal(typo.run.events[0].reason_code, 'invalid_job');
  // Neither connected (refused before any Dataverse call), so they wait locally until a run connects.
  assert.equal(pending().length, 2);
  go(['whoami', 'donorapp'], deps(dv));
  assert.deepEqual(pending(), []);
  const rows = eventRows(dv).filter((r) => [bad.run.id, typo.run.id].includes(r.sbrm_runid));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.sbrm_status === null && r.sbrm_signal === false));
});

test('a MACHINE event (no plan, before any connection) waits locally, then goes to the next environment that connects', () => {
  clearPending();
  const dv = fakeDv();
  const { code, run } = go(['apply', '20261007-000000-0000abcd'], deps(dv));
  assert.equal(code, 1);
  assert.deepEqual([run.events[0].reason_code, run.events[0].env], ['no_plan', 'machine']);
  assert.equal(eventRows(dv).filter((r) => r.sbrm_runid === run.id).length, 0, 'nothing connected, nothing sent');
  assert.equal(pending().length, 1);
  go(['whoami', 'donorapp'], deps(dv));
  const [row] = eventRows(dv).filter((r) => r.sbrm_runid === run.id);
  assert.equal(row.sbrm_envkey, 'machine');
});

test('the CLI missing: a setup problem, kept on the machine, and the person is told it was not sent', () => {
  clearPending();
  const missing = () => { throw Object.assign(new Error('The Dataverse CLI was not found on this machine. Run /dataverse-setup.'), { code: 'cli_missing' }); };
  const dv = fakeDv();
  const { code, run } = go(['whoami', 'donorapp'], deps(dv, { readConnection: missing }));
  assert.equal(code, 1);
  assert.deepEqual([run.events[0].kind, run.events[0].reason_code, run.events[0].signal], ['setup problem', 'cli_missing', true]);
  assert.match(run.output.join('\n'), /saved on this machine, and sent the next time it can reach Dataverse\. If it's urgent, message Dylan/);
  assert.equal(pending().length, 1);
  go(['whoami', 'donorapp'], deps(dv));
  assert.equal(eventRows(dv).filter((r) => r.sbrm_runid === run.id).length, 1, 'arrives once the machine works again');
});

test('a CLI the security software blocks (EPERM) is named plainly, with the fix, as a setup problem', () => {
  clearPending();
  const { launchError } = require('../lib/cli');
  const e = launchError('C:/x/dataverse.exe', Object.assign(new Error('spawnSync C:/x/dataverse.exe EPERM'), { code: 'EPERM' }));
  assert.equal(e.code, 'cli_blocked');
  assert.match(e.message, /security software blocked the Dataverse CLI \(C:\/x\/dataverse\.exe\)[\s\S]*ThreatLocker[\s\S]*Rapid Check-in/);
  assert.equal(launchError('x', Object.assign(new Error('nope'), { code: 'ENOENT' })).code, null, 'other launch errors stay generic');
  const blocked = () => { throw e; };
  const { code, run } = go(['whoami', 'donorapp'], deps(fakeDv(), { readConnection: blocked }));
  assert.equal(code, 1);
  assert.deepEqual([run.events[0].kind, run.events[0].reason_code, run.events[0].signal], ['setup problem', 'cli_blocked', true]);
  assert.match(run.output.join('\n'), /ERROR: this computer's security software blocked the Dataverse CLI/);
});

test('a crash is recorded with its stack, and the person is told', () => {
  clearPending();
  const dv = fakeDv();
  const broken = { ...dv, get() { throw new TypeError('cannot read properties of undefined'); } };
  const { code, run } = go(['whoami', 'donorapp'], deps(dv, { readConnection: () => broken }));
  assert.equal(code, 1);
  const e = run.events[0];
  assert.deepEqual([e.kind, e.reason_code, e.signal], ['crash', 'crash', true]);
  assert.match(e.detail, /TypeError: cannot read properties of undefined\n\s+at /);
  assert.match(run.output.join('\n'), /Recorded for Dylan's review/);
});

test('a send that fails never changes the outcome; the event is sent later, exactly once', () => {
  clearPending();
  const dv = fakeDv({ email: 'reader@example.org' });
  dv.eventFails = true;
  const first = go(['plan', jobFile()], deps(dv));
  assert.equal(first.code, 1);
  assert.equal(pending().length, 1);
  dv.eventFails = false;
  const id = first.run.events[0].event_id;
  // simulate a send that landed but whose answer was lost: the same event sent again
  dv.create(EVENTS, events.rowFor(first.run.events[0]));
  go(['whoami', 'donorapp'], deps(dv));
  assert.deepEqual(pending(), []);
  assert.equal(eventRows(dv).filter((r) => r.sbrm_eventid === id).length, 1, 'the event id key makes a re-send harmless');
});

test('a parked Write Log row is recorded as a signal event', () => {
  clearPending();
  const dv = fakeDv();
  const id = planId(dv);
  dv.logFails = true;
  const { code, run } = go(['apply', id], deps(dv));
  assert.equal(code, 0, 'the data write stands');
  assert.deepEqual([run.events[0].kind, run.events[0].reason_code, run.events[0].plan_id], ['parked', 'parked', id]);
  assert.ok(eventRows(dv).some((r) => r.sbrm_eventid === run.events[0].event_id && r.sbrm_status === 'open'));
});

test('a successful run records nothing and sends nothing', () => {
  clearPending();
  const dv = fakeDv();
  const before = eventRows(dv).length;
  const id = planId(dv);
  const { code, run } = go(['apply', id], deps(dv));
  assert.equal(code, 0);
  assert.deepEqual(run.events, []);
  assert.equal(eventRows(dv).length, before);
  assert.ok(!run.output.join('\n').includes('Recorded for'));
});

test('show on a tampered plan records plan_tampered', () => {
  clearPending();
  const dv = fakeDv();
  const id = planId(dv);
  const f = path.join(process.env.SBRM_DV_HOME, 'plans', `${id}.json`);
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  rec.rows[0].id = IDS.bob;
  fs.writeFileSync(f, JSON.stringify(rec));
  const { code, run } = go(['show', id], deps(dv));
  assert.equal(code, 1);
  assert.equal(run.events[0].reason_code, 'plan_tampered');
});

test('INVARIANT: every run that does not succeed leaves a record (an event, or its Write Log entry)', () => {
  clearPending();
  const dv = fakeDv();
  const reader = fakeDv({ email: 'reader@example.org' });
  const missing = () => { throw Object.assign(new Error('no CLI'), { code: 'cli_missing' }); };
  const stale = (() => {
    const id = planId(dv);
    const f = path.join(process.env.SBRM_DV_HOME, 'plans', `${id}.json`);
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { id, f, rec };
  })();
  const scenarios = [
    ['no arguments', [], deps(dv)],
    ['unknown command', ['frobnicate', 'x'], deps(dv)],
    ['unreadable job file', ['plan', path.join(HOME, 'missing.json')], deps(dv)],
    // (`check` refusals are Claude's own lint and deliberately leave no event: see the test below.)
    ['plan, read access', ['plan', jobFile()], deps(reader)],
    ['plan, every row refused', ['plan', jobFile({ rows: [{ name: 'Ina Active', id: IDS.inactive, body: { address1_city: 'Z' } }] })], deps(dv)],
    ['apply, no such plan', ['apply', '20261007-000000-0000ffff'], deps(dv)],
    ['apply, not a plan id', ['apply', 'nonsense'], deps(dv)],
    ['apply, cancelled', ['apply', planId(dv)], deps(dv, { confirm: () => ({ approved: false }) })],
    ['apply, signed in as someone else', ['apply', planId(dv)], deps(fakeDv({ userId: IDS.bob }))],
    ['revert, unknown plan', ['revert', '20261007-000000-0000eeee'], deps(dv)],
    ['revert, bad id', ['revert', 'nope'], deps(dv)],
    ['whoami, unknown env', ['whoami', 'nowhere'], deps(dv)],
    ['whoami, CLI missing', ['whoami', 'donorapp'], deps(dv, { readConnection: missing })],
    ['whoami, crash', ['whoami', 'donorapp'], deps(dv, { readConnection: () => { throw new Error('boom'); } })],
  ];
  // and a stale plan
  stale.rec.created = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  fs.writeFileSync(stale.f, JSON.stringify(stale.rec));
  scenarios.push(['apply, stale or edited plan', ['apply', stale.id], deps(dv)]);

  for (const [name, argv, d] of scenarios) {
    const { code, run } = go(argv, d);
    assert.notEqual(code, 0, `${name}: expected a failure`);
    assert.ok(run.events.length > 0 || run.wroteLog, `${name}: failed with no record`);
    for (const e of run.events) assert.ok(e.reason_code && e.reason_code !== 'unclassified', `${name}: event has no reason code`);
  }
});

test('a usage error says nothing was DONE (not "planned")', () => {
  const { run } = go(['whoami', 'nowhere'], deps(fakeDv()));
  assert.match(run.output.join('\n'), /REFUSED: whoami\. Nothing was done\./);
});

test('a reason code missing from the table counts as SIGNAL (nothing is hidden by accident)', () => {
  assert.equal(events.isSignal('some_new_code'), true);
  assert.equal(events.isSignal('no_change'), true, 'not in the table, so signal');
  assert.equal(events.isSignal('invalid_job'), false);
});

test('the send connection can only create rows in the event table', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'events.js'), 'utf8');
  const calls = src.match(/request\([^)]*\)/g) || [];
  assert.deepEqual(calls, ["request(cli, host, EVENT_SET, { method: 'POST', headers: [], bodyFile: tmp })"]);
  assert.equal(events.EVENT_SET, 'sbrm_dataverseevents');
  assert.ok(!/require\(['"]\.\/write['"]\)/.test(src));
});

test('a refused `check` is Claude\'s own lint: it prints why and records no event (10/7 review)', () => {
  clearPending();
  const dv = fakeDv();
  const r = go(['check', jobFile({ mode: 'merge' })], deps(dv));
  assert.equal(r.code, 1);
  assert.equal(r.run.events.length, 0, 'no event for a check refusal');
  const crash = go(['check', jobFile()], deps(dv, {}));
  assert.equal(crash.code, 0, 'a valid check still passes');
});

test('an apply cut off part-way leaves a marker; the next run files it as a signal event (1.10.1)', () => {
  clearPending();
  const pending = path.join(process.env.SBRM_DV_HOME, 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const marker = path.join(pending, 'inflight--20261007-120000-abcdef12.marker');
  fs.writeFileSync(marker, JSON.stringify({ plan_id: '20261007-120000-abcdef12', env: 'donorapp', app: 'Donor App', kind: 'rows', table: 'contacts' }));
  const old = new Date(Date.now() - 7 * 3600 * 1000);
  fs.utimesSync(marker, old, old);
  const r = go(['whoami', 'donorapp'], deps(fakeDv()));
  const ev = r.run.events.find((e) => e.reason_code === 'interrupted');
  assert.ok(ev, 'an interrupted event is recorded');
  assert.equal(ev.signal, true);
  assert.match(ev.headline, /plan 20261007-120000-abcdef12 .* was cut off part-way/);
  assert.equal(fs.existsSync(marker), false, 'the marker is consumed');
  // A fresh marker (an apply still running in another window) is left alone.
  fs.writeFileSync(marker, '{}');
  go(['whoami', 'donorapp'], deps(fakeDv()));
  assert.equal(fs.existsSync(marker), true);
  fs.rmSync(marker);
});

test('every apply clears its own marker, applied or refused', () => {
  const pending = path.join(process.env.SBRM_DV_HOME, 'pending');
  const dv = fakeDv();
  go(['apply', planId(dv)], deps(dv));
  go(['apply', planId(dv)], deps(dv, { confirm: () => ({ approved: false }) }));
  go(['apply', planId(dv)], deps(fakeDv({ userId: IDS.bob })));
  assert.deepEqual(fs.readdirSync(pending).filter((f) => f.startsWith('inflight--')), []);
});

test('the real CLI refuses apply and resolve with a substitute Dataverse CLI named (final re-verify)', () => {
  const { spawnSync } = require('child_process');
  const engine = path.join(__dirname, '..', 'dataverse-write.js');
  for (const verb of ['apply', 'resolve']) {
    const r = spawnSync(process.execPath, [engine, verb, 'x'], { encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: '', SBRM_DV_CONFIG: '', SBRM_DATAVERSE_CLI: 'C:/tmp/fake' } });
    assert.equal(r.status, 1, verb);
    assert.match(r.stdout, /runs only with the engine's own store, settings and Dataverse CLI/);
  }
});
