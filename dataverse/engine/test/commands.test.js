'use strict';
// doctor, report, review, resolve through the REAL CLI with a fake Dataverse (DESIGN.md §7).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-cmd-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });

const { fakeDv, IDS } = require('./fake');
fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'),
  JSON.stringify({ donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false } }));

const cli = require('../dataverse-write');
const store = require('../lib/store');

const EVENTS = 'sbrm_dataverseevents';
const eventRows = (dv) => Object.values(dv.data[EVENTS] || {});
const pending = () => fs.readdirSync(store.dir(path.join('events', 'pending')));
const cleanIo = () => ({ home: path.join(HOME, 'h'), cwd: path.join(HOME, 'h'), read: () => null });

function deps(dv, over = {}) {
  return {
    readConnection: () => dv, writeConnection: () => dv, confirm: () => ({ approved: true }),
    eventConnection: () => ({ createEvent: (b) => dv.create(EVENTS, b) }),
    cli: () => ({ version: '1.0.34' }), io: cleanIo,
    ...over,
  };
}

function go(argv, d) {
  const real = console.log;
  console.log = () => {};
  try {
    const code = cli.runCli(argv, d);
    return { code, run: cli.lastRun, out: cli.lastRun.output.join('\n') };
  } finally {
    console.log = real;
  }
}

let n = 0;
function jobFile() {
  n += 1;
  const f = path.join(HOME, `job-${n}.json`);
  fs.writeFileSync(f, JSON.stringify({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'update', source: 'test', reason: 'Test.',
    intent: { verb: 'update', count: 1, table: 'contacts', fields: ['address1_city'] },
    rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: `Town ${n}` } }],
  }));
  return f;
}

// ---- doctor ----

test('doctor on a healthy machine: passes, prints plain lines, and records the heartbeat', () => {
  const dv = fakeDv();
  const { code, run, out } = go(['doctor'], deps(dv));
  assert.equal(code, 0);
  assert.match(out, /Dataverse health check[\s\S]*ok {4}Dataverse CLI: version 1\.0\.34[\s\S]*Everything checked is working\./);
  assert.deepEqual([run.events[0].kind, run.events[0].reason_code, run.events[0].signal], ['health check', 'health_passed', false]);
  const row = eventRows(dv).find((r) => r.sbrm_eventid === run.events[0].event_id);
  assert.equal(row.sbrm_status, null, 'a pass is a heartbeat, not an issue');
});

test('doctor sends what was waiting before it counts, so a recovered machine passes', () => {
  const dv = fakeDv();
  go(['apply', '20261007-000000-00001234'], deps(dv)); // refused with no connection: waits locally
  assert.ok(pending().length >= 1);
  const { code } = go(['doctor'], deps(dv));
  assert.equal(code, 0);
  assert.deepEqual(pending(), []);
});

test('doctor --apps refuses an app key that does not exist', () => {
  const r = go(['doctor', '--apps', 'donorapp,nowhere'], deps(fakeDv()));
  assert.equal(r.code, 2);
  assert.match(r.out, /--apps takes app keys separated by commas[\s\S]*unknown: nowhere/);
  assert.equal(go(['doctor', '--apps', 'donorapp'], deps(fakeDv())).code, 0);
});

test('doctor finds drift and records it as signal', () => {
  const dv = fakeDv();
  const home = path.join(HOME, 'h');
  const files = { [path.join(home, '.claude.json')]: { projects: { [home]: { mcpServers: { 'dataverse-donorapp': { command: 'dataverse', args: ['mcp', 'https://sbrmdonorapp.crm.dynamics.com'] } } } } } };
  const io = () => ({ home, cwd: home, read: (f) => files[f] || null });
  const { code, run, out } = go(['doctor'], deps(dv, { io }));
  assert.equal(code, 1);
  assert.equal(run.events[0].reason_code, 'drift');
  assert.equal(run.events[0].env, 'machine', 'a health check is about the machine');
  assert.equal(run.events[0].headline, 'Health check: 1 problem(s): Extra Dataverse connection');
  assert.match(out, /Extra Dataverse connection: dataverse-donorapp \(local scope, home folder\)/);
  assert.equal(eventRows(dv).find((r) => r.sbrm_eventid === run.events[0].event_id).sbrm_status, 'open');
});

// ---- report ----

test('report: the person\'s words verbatim, context attached, and a number to quote', () => {
  const dv = fakeDv();
  const words = "the gift I just added for the Examples isn't showing in the batch";
  const { code, run, out } = go(['report', words], deps(dv));
  assert.equal(code, 0);
  const row = eventRows(dv).find((r) => r.sbrm_eventid === run.events[0].event_id);
  assert.equal(row.sbrm_words, words, 'never restated');
  assert.equal(row.sbrm_kind, 'report');
  assert.equal(row.sbrm_status, 'open');
  assert.match(row.sbrm_detail, /Recent events on this machine/);
  assert.match(out, new RegExp(`Reported as ${row.sbrm_number}\\.[\\s\\S]*mention ${row.sbrm_number}`));
  assert.ok(!out.includes("(Recorded for Dylan's review"), 'report says where it went itself');
});

test('report with no connection is saved on the machine and the person is told to message Dylan', () => {
  const dv = fakeDv();
  const missing = () => { throw Object.assign(new Error('no CLI'), { code: 'cli_missing' }); };
  const { code, run, out } = go(['report', 'it froze'], deps(dv, { readConnection: missing }));
  assert.equal(code, 0);
  assert.equal(run.events[0].kind, 'report');
  assert.ok(pending().some((f) => f.includes(run.events[0].event_id)));
  assert.match(out, /saved on this machine[\s\S]*message Dylan directly: nothing here can notify him/);
  go(['doctor'], deps(dv)); // the next working run delivers it
});

test('report with no words is refused', () => {
  const { code, run } = go(['report'], deps(fakeDv()));
  assert.equal(code, 2);
  assert.equal(run.events[0].reason_code, 'usage');
});

// ---- review ----

test('review reads the Write Log and events and prints the view; --brief prints the Monday line', () => {
  const dv = fakeDv();
  const plan = go(['plan', jobFile()], deps(dv)).run.planId;
  go(['apply', plan], deps(dv));
  go(['report', 'something looks off'], deps(dv));
  const full = go(['review'], deps(dv));
  assert.equal(full.code, 0);
  assert.match(full.out, /DATAVERSE TOOLKIT REVIEW/);
  assert.match(full.out, /Test Person\s+seen \d+\/\d+\s+1 write \(1 rows\)/);
  assert.match(full.out, /REPORT\n {10}"something looks off"/);
  const brief = go(['review', '--brief'], deps(dv));
  assert.match(brief.out, /^Dataverse toolkit, \d+\/\d+ to \d+\/\d+: 1 person active, 1 write \(Test 1\), 1 open/);
  assert.deepEqual(brief.run.events, [], 'a review records nothing');
});

// ---- resolve ----

function openReport(dv) {
  const { run } = go(['report', 'please look'], deps(dv));
  return eventRows(dv).find((r) => r.sbrm_eventid === run.events[0].event_id);
}

test('resolve: Dylan closes an open item, after the pop-up, and it reads back resolved', () => {
  const dv = fakeDv();
  const row = openReport(dv);
  let shown = null;
  const { code, out } = go(['resolve', row.sbrm_number, 'fixed', 'gift skill now asks for the batch', '--fixed-in', '1.9.0'],
    deps(dv, { confirm: (x) => { shown = x; return { approved: true }; } }));
  assert.equal(code, 0);
  assert.match(shown.summaryText, new RegExp(`^Resolve ${row.sbrm_number} in the Donor App`));
  assert.deepEqual([row.sbrm_status, row.sbrm_resolution, row.sbrm_resolutionnote, row.sbrm_fixedinversion],
    ['resolved', 'fixed', 'gift skill now asks for the batch', '1.9.0']);
  assert.match(out, /resolved: fixed/);
  assert.ok(dv.calls.some((c) => c.method === 'PATCH' && c.path.startsWith(`${EVENTS}(`) && /^W\/"\d+"$/.test(c.etag)), 'If-Match on the write');
});

test('resolve: cancel leaves it open; a second resolve of a closed item is refused', () => {
  const dv = fakeDv();
  const row = openReport(dv);
  assert.equal(go(['resolve', row.sbrm_number, 'not a bug', 'x'], deps(dv, { confirm: () => ({ approved: false }) })).code, 1);
  assert.equal(row.sbrm_status, 'open');
  go(['resolve', row.sbrm_number, 'not a bug', 'the gate was right'], deps(dv));
  const again = go(['resolve', row.sbrm_number, 'fixed', 'x'], deps(dv));
  assert.equal(again.code, 1);
  assert.equal(again.run.events[0].reason_code, 'not_open');
});

test('resolve: only schema access may resolve (staff cannot close anything, ruled 10/7)', () => {
  const dv = fakeDv();
  const row = openReport(dv);
  const writer = fakeDv({ email: 'writer@example.org', data: dv.data });
  const { code, run } = go(['resolve', row.sbrm_number, 'fixed', 'x'], deps(writer));
  assert.equal(code, 1);
  assert.deepEqual([run.events[0].reason_code, run.events[0].signal], ['not_permitted', true]);
  assert.equal(row.sbrm_status, 'open');
});

test('resolve: bad arguments are a usage refusal', () => {
  for (const argv of [['resolve'], ['resolve', 'X-1', 'fixed', 'n'], ['resolve', 'D-1003', 'maybe', 'n'], ['resolve', 'D-1003', 'fixed']]) {
    assert.equal(go(argv, deps(fakeDv())).code, 2, argv.join(' '));
  }
  assert.equal(go(['resolve', 'D-1003', 'duplicate of D-1001', 'same as the first'], deps(fakeDv())).run.events[0].reason_code, 'not_found');
});
