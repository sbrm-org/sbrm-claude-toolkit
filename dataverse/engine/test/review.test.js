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
