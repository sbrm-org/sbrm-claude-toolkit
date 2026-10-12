'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, render, brief } = require('../lib/review');

const NOW = new Date('2026-10-06T08:14:00');
const at = (s) => new Date(s).toISOString();
const ACCESS = {
  people: {
    'dgross@example.org': { envs: { donorapp: 'schema' } },
    'arivera@example.org': { envs: { donorapp: 'write' } },
    'slee@example.org': { envs: { donorapp: 'write' } },
    'jpark@example.org': { envs: { donorapp: 'write' } },
  },
};
const PEOPLE = { 'dgross@example.org': 'Dylan Gross', 'arivera@example.org': 'Alex Rivera', 'slee@example.org': 'Sam Lee', 'jpark@example.org': 'Jordan Park' };
const V = 'engine 2026.10.07; Dataverse CLI 1.0.81; Node v24.16.0; Darwin 25.6.0 arm64';

const log = (email, name, time, over = {}) => ({ env: 'donorapp', email, name, time: at(time), planid: `p-${time}`, headline: 'Update 1 contact in the Donor App', outcome: 'applied', written: 1, notwritten: 0, leftout: 0, ...over });
const ev = (email, name, time, over = {}) => ({ env: 'donorapp', email, name, time: at(time), number: 'D-1000', kind: 'refused', code: 'no_change', signal: false, status: null, headline: 'Refused', words: null, planid: null, versions: V, ...over });

function week() {
  return {
    now: NOW, days: 7, access: ACCESS, people: PEOPLE,
    logs: [
      log('arivera@example.org', 'Alex Rivera', '2026-10-03T14:08:00', { planid: '20261003-140801-3c9e2f1a', headline: 'Add 1 gift to the Donor App' }),
      log('arivera@example.org', 'Alex Rivera', '2026-10-04T09:11:00', { written: 40 }),
      log('arivera@example.org', 'Alex Rivera', '2026-10-05T10:00:00', { outcome: 'cancelled', written: 0 }),
      log('dgross@example.org', 'Dylan Gross', '2026-10-05T16:00:00', { outcome: 'applied with problems', written: 1, notwritten: 1, planid: 'p-prob' }),
      log('slee@example.org', 'Sam Lee', '2026-09-10T10:00:00'), // last seen weeks ago
    ],
    events: [
      ev('arivera@example.org', 'Alex Rivera', '2026-10-03T14:12:00', { number: 'D-1007', kind: 'report', code: 'report', signal: true, status: 'open',
        words: "the gift I just added for the Examples isn't showing in batch 1234", headline: 'Report', planid: '20261003-140801-3c9e2f1a' }),
      ev('arivera@example.org', 'Alex Rivera', '2026-10-02T09:00:00', { code: 'no_change' }),
      ev('arivera@example.org', 'Alex Rivera', '2026-10-02T09:05:00', { code: 'no_change' }),
      ev('dgross@example.org', 'Dylan Gross', '2026-10-01T09:00:00', { code: 'every_row_moved' }),
      ev('arivera@example.org', 'Alex Rivera', '2026-10-05T11:00:00', { kind: 'health check', code: 'health_passed', signal: false }),
      ev('dgross@example.org', 'Dylan Gross', '2026-09-20T09:00:00', { code: 'no_change' }), // outside the week: not counted
    ],
  };
}

test('people: writes and rows this period, cancels, open, versions; never-seen is "not set up"', () => {
  const s = summarize(week());
  const alex = s.people.find((p) => p.email === 'arivera@example.org');
  assert.deepEqual([alex.writes, alex.rows, alex.cancels, alex.open], [2, 41, 1, 1]);
  assert.equal(s.people.find((p) => p.email === 'jpark@example.org').lastSeen, null);
  const out = render(s);
  assert.match(out, /Jordan Park\s+never\s+not set up/);
  assert.match(out, /Alex Rivera\s+seen 10\/5\s+2 writes \(41 rows\), 1 cancel, 1 open\s+engine 2026\.10\.07 {2}CLI 1\.0\.81/);
});

test('open items carry the person\'s own words and the plan they name', () => {
  const out = render(summarize(week()));
  assert.match(out, /Open \(1\)\n {2}D-1007 +10\/3 2:12 PM +Alex +REPORT\n {10}"the gift I just added for the Examples isn't showing in batch 1234"/);
  assert.match(out, /Plan 20261003-140801-3c9e2f1a: Add 1 gift to the Donor App, applied\./);
});

test('routine refusals are counts by reason, this period only; problems and health are listed', () => {
  const out = render(summarize(week()));
  assert.match(out, /Routine refusals: 3 {3}\(no_change 2, every_row_moved 1\)/);
  assert.match(out, /Writes with problems \(1\)\n {2}10\/5 {2}Dylan +Update 1 contact in the Donor App: 1 written, 1 not written {2}\(plan p-prob\)/);
  assert.match(out, /Health checks: Alex 10\/5 pass/);
});

test('silence: a writer active before and quiet 14+ days is flagged with the one action', () => {
  const out = render(summarize(week()));
  assert.match(out, /Silent 14\+ days: Sam Lee \(last seen 9\/10\): ask them to run the health check/);
  const quiet = week();
  quiet.logs = quiet.logs.filter((l) => l.email !== 'slee@example.org');
  assert.match(render(summarize(quiet)), /Nobody silent \(14-day rule\)\./);
});

test('the Monday line', () => {
  assert.equal(brief(summarize(week())),
    'Dataverse toolkit, 9/29 to 10/6: 2 people active, 3 writes (Alex 2, Dylan 1), 1 cancel, 1 open (D-1007, Alex, 10/3), Jordan not set up, Sam silent 14+ days. "dataverse review" for detail.');
});

test('a quiet, healthy week reads as such', () => {
  const s = summarize({ now: NOW, days: 7, access: { people: {} }, people: {}, logs: [], events: [] });
  assert.equal(brief(s), 'Dataverse toolkit, 9/29 to 10/6: 0 people active, 0 writes, nothing open. "dataverse review" for detail.');
  assert.match(render(s), /Open \(0\)\n {2}nothing open/);
});

test('repeated health checks on one machine fold into the latest; a later pass is noted; other machines stay separate', () => {
  const hc = (n, time, over = {}) => ev('dgross@example.org', 'Dylan Gross', time, { number: n, kind: 'health check', code: 'drift', signal: true, status: 'open', headline: 'Health check: 6 problem(s)', machine: 'LAPTOP', ...over });
  const events = [
    hc('D-1002', '2026-10-05T09:00:00'), hc('D-1003', '2026-10-05T10:00:00'), hc('D-1004', '2026-10-05T11:00:00'),
    hc('D-1005', '2026-10-05T12:00:00', { machine: 'DESKTOP' }),
    ev('dgross@example.org', 'Dylan Gross', '2026-10-05T13:00:00', { number: 'D-1006', kind: 'report', code: 'report', signal: true, status: 'open', words: 'odd' }),
  ];
  const s = summarize({ now: NOW, days: 7, access: ACCESS, logs: [], events, people: PEOPLE });
  assert.deepEqual(s.open.map((e) => e.number), ['D-1004', 'D-1005', 'D-1006'], 'one item per machine, plus the report');
  assert.deepEqual(s.open[0].repeats, ['D-1002', 'D-1003']);
  assert.equal(s.open[0].clearedAt, null);
  assert.equal(s.people.find((p) => p.email === 'dgross@example.org').open, 3);
  const out = render(s);
  assert.match(out, /Open \(3\)/);
  assert.match(out, /Same check, earlier runs still open: D-1002, D-1003 \(resolving D-1004 closes them too\)/);
  // A later PASS on LAPTOP (routine, not open): the open drift item is marked cleared, not hidden.
  const passed = summarize({ now: NOW, days: 7, access: ACCESS, logs: [], people: PEOPLE,
    events: [...events, hc('D-1007', '2026-10-05T14:00:00', { code: 'health_passed', signal: false, status: null })] });
  assert.equal(passed.open.find((e) => e.number === 'D-1004').clearedAt, at('2026-10-05T14:00:00'));
  assert.match(render(passed), /Cleared since: a later health check on this machine passed/);
  assert.equal(passed.open.find((e) => e.number === 'D-1005').clearedAt, null, 'the other machine is untouched');
});

// 1.11.9 (DESIGN.md §12d): the Toolkit block grades each person's latest check-in per machine against main.
const ci = (email, name, time, machine, running, installed, main, state) => ({ email, name, time: at(time), machine, running, installed, main, state });
function toolkitWeek(checkins, over = {}) {
  return { now: new Date('2026-10-14T09:00:00'), days: 7, access: ACCESS, people: PEOPLE, logs: [], events: [], checkins, main: { version: '1.11.9', fetched: true }, ...over };
}

test('toolkit: each state graded against the main the review fetched; worst machine wins; first seen is the earliest row', () => {
  const s = summarize(toolkitWeek([
    ci('arivera@example.org', 'Alex Rivera', '2026-10-13T16:10:00', 'ALEX-MAC', '1.11.9', '1.11.9', '1.11.9', 'current'),
    ci('dgross@example.org', 'Dylan Gross', '2026-10-13T16:11:00', 'DESKTOP', '1.11.8', '1.11.9', '1.11.9', 'restart-needed'),
    ci('dgross@example.org', 'Dylan Gross', '2026-10-13T17:30:00', 'LAPTOP', '1.11.9', '1.11.9', '1.11.9', 'current'),
    ci('slee@example.org', 'Sam Lee', '2026-10-13T18:00:00', 'SAM-MAC', '1.11.8', '1.11.8', '1.11.9', 'stale'),
    ci('jpark@example.org', 'Jordan Park', '2026-10-13T08:00:00', 'JP', '1.11.8', '1.11.8', '1.11.8', 'current'),
    ci('jpark@example.org', 'Jordan Park', '2026-10-14T08:00:00', 'JP', '1.11.8', '1.11.8', '1.11.9', 'pending'),
  ]));
  const out = render(s);
  assert.match(out, /Toolkit \(main 1\.11\.9, fetched now; out since 10\/13 4:10 PM\)/, 'first seen = the earliest row naming it');
  assert.match(out, /Alex Rivera +current 1\.11\.9 +ALEX-MAC, checked 10\/13 4:10 PM/);
  assert.match(out, /Dylan Gross +DESKTOP: restart needed: running 1\.11\.8, 1\.11\.9 installed 10\/13 4:11 PM; LAPTOP: current 1\.11\.9/, 'two machines named, worst first');
  assert.match(out, /Sam Lee +WARN auto-update not pulling: 1\.11\.8 installed, 1\.11\.9 out since 10\/13; a session ran 1h\+ without it/);
  assert.match(out, /Jordan Park +1\.11\.9 pending \(out since 10\/13 4:10 PM; last check-in 10\/14 8:00 AM\)/, 'the LATEST row per machine counts');
  assert.ok(!/Behind on the toolkit/.test(out), 'the sighting line is gone');
  assert.equal(brief(s).match(/toolkit 1\.11\.9: [^.]*/)[0], 'toolkit 1.11.9: Alex current, Dylan restart needed, Jordan pending, Sam AUTO-UPDATE NOT PULLING');
});

test('toolkit: three days after a release with no stale proof = not updated; no check-in; quiet machines; ahead of main; install record missing', () => {
  const s = summarize(toolkitWeek([
    ci('arivera@example.org', 'Alex Rivera', '2026-10-10T09:00:00', 'ALEX-MAC', '1.11.9', '1.11.9', '1.11.9', 'current'),
    ci('arivera@example.org', 'Alex Rivera', '2026-10-13T09:00:00', 'ALEX-MAC', '1.11.8', '1.11.8', '1.11.9', 'pending'),
    ci('slee@example.org', 'Sam Lee', '2026-09-20T09:00:00', 'OLD-PC', '1.11.2', '1.11.2', '1.11.2', 'current'),
    ci('dgross@example.org', 'Dylan Gross', '2026-10-13T09:00:00', 'DEV', '1.11.10', '1.11.10', '1.11.9', 'current'),
    ci('jpark@example.org', 'Jordan Park', '2026-10-13T09:00:00', 'JP', '1.11.8', 'unknown', '1.11.9', 'unknown'),
  ]));
  const out = render(s);
  assert.match(out, /Alex Rivera +WARN not updated 4 days after 1\.11\.9 shipped \(no session open 1h\+ since; ask them to update by hand\)/);
  assert.match(out, /Sam Lee +no check-in since 9\/20 \(OLD-PC\)/);
  assert.match(out, /Dylan Gross +ahead of main \(1\.11\.10\)/, 'numeric order; never "current"');
  assert.match(out, /Jordan Park +install record missing \(JP\): a dev copy, or installed_plugins\.json unreadable; ask/);
  const none = summarize(toolkitWeek([]));
  assert.match(render(none), /Alex Rivera +no check-in \(not set up, or a toolkit before 1\.11\.9\)/);
});

test('toolkit: GitHub unreachable = main is the newest version seen anywhere, and says so; everyone current reads as one clause', () => {
  const rows = [
    ci('arivera@example.org', 'Alex Rivera', '2026-10-13T16:10:00', 'A', '1.11.9', '1.11.9', '1.11.9', 'current'),
    ci('dgross@example.org', 'Dylan Gross', '2026-10-13T16:11:00', 'D', '1.11.9', '1.11.9', '1.11.9', 'current'),
  ];
  const s = summarize(toolkitWeek(rows, { main: { error: 'offline' }, toolkit: '1.11.8' }));
  assert.match(render(s), /Toolkit \(main 1\.11\.9, newest seen; GitHub not reachable; out since/);
  const quiet = summarize({ ...toolkitWeek(rows), access: { people: {} }, people: {} });
  assert.match(brief(quiet), /toolkit: everyone checked in is on 1\.11\.9/);
  assert.ok(!/not set up/.test(brief(quiet)), 'a check-in is a sighting: someone who only checked in is set up');
});

test('toolkit: a machine whose own idea of main is old is graded against the REVIEW\'s main, never marked current by it', () => {
  const s = summarize(toolkitWeek([ci('arivera@example.org', 'Alex Rivera', '2026-10-14T08:00:00', 'A', '1.11.8', '1.11.8', '1.11.8', 'current')]));
  assert.match(render(s), /Alex Rivera +1\.11\.9 pending/);
});

test('toolkit: check-ins never count as routine refusals', () => {
  const s = summarize(toolkitWeek([], { now: NOW, events: [ev('arivera@example.org', 'Alex Rivera', '2026-10-05T09:00:00', { kind: 'version check-in', code: 'checkin', signal: false })] }));
  assert.match(render(s), /Routine refusals: none/);
});

test('parseCheckin reads the strict lines a check-in row leads with', () => {
  const { parseCheckin } = require('../lib/review');
  const d = 'Time: x\nPerson: y\nCommand: (none)\n\nrunning: 1.11.8\ninstalled: 1.11.9\nmain: 1.11.9\nstate: restart-needed\ninstalled_since: 2026-10-13T16:05:00.000Z\nmain_fetched_at: never\nsession_uptime_min: 3\n\ntrigger: start';
  assert.deepEqual(parseCheckin(d), { running: '1.11.8', installed: '1.11.9', main: '1.11.9', state: 'restart-needed', installed_since: '2026-10-13T16:05:00.000Z', session_uptime_min: '3' });
});

test('someone granted write with no activity yet shows by the name on their access row, not their email', () => {
  const s = summarize({ now: NOW, days: 7, access: { people: { 'new@example.org': { envs: { donorapp: 'write' }, name: 'New Person' } } }, logs: [], events: [], people: {} });
  assert.match(render(s), /New Person\s+never\s+not set up/);
});

test('the Access section lists each granted person by level, old schema read as admin, merge shown', () => {
  const s = summarize({ ...week(), access: { people: {
    ...ACCESS.people,
    'dmartinez@example.org': { envs: { donorapp: 'write', fedev: 'develop', hgs: 'read' }, merge: { donorapp: true }, name: 'Dana Martin' },
  } } });
  const out = render(s);
  assert.match(out, /\nAccess\n/);
  assert.match(out, /Dylan Gross +admin: donorapp/);
  assert.match(out, /Dana Martin +write \+ merge: donorapp; develop: fedev/);
  assert.ok(!/Dana Martin.*hgs/.test(out), 'read is not listed');
});
