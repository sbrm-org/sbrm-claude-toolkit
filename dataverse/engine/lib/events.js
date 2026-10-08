'use strict';
// Toolkit events (DESIGN.md §7). Every engine run gets a RUN; anything that is not a write (a refusal,
// a crash, a parked log row, a report, a health check) is recorded as an EVENT on that run.
//
//   1. record(): ALWAYS local first: one line appended to ~/.sbrm-dataverse/events/events.jsonl (the
//      history on this machine) plus one file in events/pending/ waiting to be sent. Local first because
//      the events that matter most (no CLI, not signed in) happen exactly when Dataverse is unreachable.
//   2. flush(): sends pending events to the `sbrm_dataverseevent` table of the environment the run is
//      connected to. An event about an environment goes only to that environment; an event about the
//      MACHINE (env 'machine') goes to whichever environment connects next. The event id is the table's
//      alternate key, so a re-send can never duplicate (a duplicate-key answer = it already landed).
//
// The send connection can create rows in ONE table, the event table, and nothing else: the plan step
// stays unable to write data (cli.js is read-only; write.js is apply's alone).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { request, resolveCli, DataverseError } = require('./cli');

const ENGINE_VERSION = '2026.10.08'; // 1.10.1: signed plans, third and fourth adversarial passes
const EVENT_SET = 'sbrm_dataverseevents';

// DESIGN.md §7 D2: signal (listed in the review, opens an issue) or routine (counted by reason).
// A code that is NOT in this table counts as signal: nothing is hidden by accident.
const SIGNAL = {
  // someone is stuck, or something is broken
  access_read: true, access_revoked: true, plan_tampered: true, different_person: true,
  no_identity: true, crash: true, engine_bug: true, cli_missing: true, dataverse_error: true,
  parked: true, report: true, health_failed: true, drift: true, not_permitted: true, cli_blocked: true, access_unreadable: true,
  too_big: true, // a job over what one apply can carry or log in full (not an access cap; there is none since 10/7)
  interrupted: true, // an apply cut off part-way (1.10.1): what landed may have no Write Log entry
  // the gate doing its job (counted, never listed)
  invalid_job: false, intent_mismatch: false, every_row_refused: false, every_row_moved: false,
  stale_plan: false, no_plan: false, nothing_to_undo: false, table_missing: false,
  client_info_exposed: false, usage: false, health_passed: false, not_found: false, not_open: false,
  // app development (DESIGN.md §10): a definition that moved since the person's read; a change that grew
  // between plan and apply; nothing left to change (a re-plan of an applied schema job)
  snapshot_moved: false, severity_grew: false, nothing_to_change: false,
};

function isSignal(code) {
  return Object.prototype.hasOwnProperty.call(SIGNAL, code) ? SIGNAL[code] : true;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newRun(argv = []) {
  return {
    id: `${stamp(new Date())}-${crypto.randomBytes(3).toString('hex')}`,
    command: argv.join(' ').slice(0, 300),
    seq: 0,
    env: null, // set by a command once it knows the environment
    person: null, // set once WhoAmI has answered
    planId: null,
    output: [], // what the run printed, attached to its events
    events: [],
    wroteLog: false, // an apply wrote a Write Log entry (its own record)
  };
}

let cachedVersions = null;
function versions() {
  if (cachedVersions) return cachedVersions;
  let cli = 'not found';
  try { cli = resolveCli().version || 'unknown'; } catch { /* recorded as not found */ }
  cachedVersions = `engine ${ENGINE_VERSION}; Dataverse CLI ${cli}; Node ${process.version}; ${os.type()} ${os.release()} ${os.arch()}`;
  return cachedVersions;
}

function pendingDir() {
  return store.dir(path.join('events', 'pending'));
}

// Record one event on the run. Local only; never throws for a send problem (nothing is sent here).
function record(run, { kind, code, headline, words = null, detail = null, env = null, signal }) {
  run.seq += 1;
  const e = {
    event_id: `${run.id}-${run.seq}`,
    run_id: run.id,
    time: new Date().toISOString(),
    kind,
    reason_code: code || null,
    signal: signal !== undefined ? !!signal : isSignal(code),
    env: env || run.env || 'machine',
    plan_id: run.planId,
    command: run.command,
    machine: os.hostname(),
    versions: versions(),
    person: run.person,
    headline: String(headline).replace(/\s+/g, ' ').trim().slice(0, 200),
    words,
    detail: detail !== null ? detail : run.output.join('\n'),
  };
  fs.appendFileSync(path.join(store.dir('events'), 'events.jsonl'), JSON.stringify(e) + '\n', 'utf8');
  fs.writeFileSync(path.join(pendingDir(), `${e.env}--${e.event_id}.json`), JSON.stringify(e), 'utf8');
  run.events.push(e);
  return e;
}

// The table row for an event. Signal events and reports open as issues; routine ones carry no status.
function rowFor(e) {
  const who = e.person ? `${e.person.fullname} <${e.person.email}>` : 'not known yet (recorded before sign-in)';
  const head = [`Time: ${e.time}`, `Person: ${who}`, `Command: ${e.command || '(none)'}`, ''];
  return {
    sbrm_name: e.headline || e.kind,
    sbrm_eventid: e.event_id,
    sbrm_runid: e.run_id,
    sbrm_kind: e.kind,
    sbrm_signal: e.signal,
    sbrm_reasoncode: e.reason_code,
    sbrm_envkey: e.env,
    sbrm_planid: e.plan_id,
    sbrm_machine: String(e.machine || '').slice(0, 100),
    sbrm_versions: String(e.versions || '').slice(0, 300),
    sbrm_words: e.words ? String(e.words).slice(0, 2000) : null,
    sbrm_detail: head.concat(String(e.detail || '')).join('\n').slice(0, 1000000),
    sbrm_status: e.signal ? 'open' : null,
  };
}

function isDuplicateKey(err) {
  return err instanceof DataverseError && (err.code === '0x80040237' || /matching key values|duplicate key/i.test(err.message));
}

// A connection that can create event rows and nothing else.
function eventConnection(host, cli = resolveCli()) {
  return {
    createEvent(body) {
      const tmp = path.join(store.dir('tmp'), `event-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
      try {
        return request(cli, host, EVENT_SET, { method: 'POST', headers: [], bodyFile: tmp });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
  };
}

function pendingFor(env) {
  return fs.readdirSync(pendingDir())
    .filter((f) => f.endsWith('.json') && (f.startsWith(`${env}--`) || f.startsWith('machine--')))
    .sort();
}

// Send this environment's pending events (and the machine's). Stops at the first failure (the rest
// would fail the same way) and leaves everything unsent in place. Returns { sent, left, error }.
function flush(conn, env) {
  const files = pendingFor(env);
  let sent = 0;
  for (const f of files) {
    const file = path.join(pendingDir(), f);
    try {
      conn.createEvent(rowFor(JSON.parse(fs.readFileSync(file, 'utf8'))));
    } catch (err) {
      if (!isDuplicateKey(err)) return { sent, left: files.length - sent, error: err.message };
    }
    fs.rmSync(file, { force: true });
    sent += 1;
  }
  return { sent, left: 0, error: null };
}

function pendingCount() {
  return fs.readdirSync(pendingDir()).filter((f) => f.endsWith('.json')).length;
}

module.exports = {
  newRun, record, flush, rowFor, eventConnection, isSignal, pendingFor, pendingCount, versions,
  SIGNAL, EVENT_SET, ENGINE_VERSION,
};
