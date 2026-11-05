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
const { toolkitVersion } = require('./note');

const ENGINE_VERSION = '2026.10.09.1'; // 1.11.6: guard blocks recorded, `report --blocked`; versions name the toolkit
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
  no_approval: true, // an apply ran without Claude Code's approval prompt (1.11.0): the guard should have asked
  false_block: true, // the person's Claude judged a guard block wrong and reported it (1.11.6, lib/blocks.js)
  // recorded on their own (1.11.6, DESIGN.md §11): no person has to notice
  repeat_block: true, // one rule blocked 3 times in a day on a machine and Claude reported none of them
  guard_down: true, // the guard could not run (no node, or it crashed); the fallback's line, sent by the engine
  mcp_failed: true, // an app's read connection could not start (once per app per machine per day)
  // the gate doing its job (counted, never listed)
  invalid_job: false, intent_mismatch: false, every_row_refused: false, every_row_moved: false,
  stale_plan: false, no_plan: false, nothing_to_undo: false, table_missing: false,
  client_info_exposed: false, usage: false, health_passed: false, not_found: false, not_open: false,
  // app development (DESIGN.md §10): a definition that moved since the person's read; a change that grew
  // between plan and apply; nothing left to change (a re-plan of an applied schema job)
  snapshot_moved: false, severity_grew: false, nothing_to_change: false,
  approval_expired: false, // the person answered Claude Code's prompt after the ticket's time (three minutes in 1.11.0, ten from 1.11.7)
  blocked: false, // a guard block (1.11.6): counted by rule in the review; a report about one is false_block
  approval_unused: false, // Claude Code asked and the change never ran (declined or left): counted (1.11.6)
  checkin: false, // a version check-in (1.11.9, DESIGN.md §12): graded in the review's Toolkit block, never counted
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
  cachedVersions = `toolkit ${toolkitVersion()}; engine ${ENGINE_VERSION}; Dataverse CLI ${cli}; Node ${process.version}; ${os.type()} ${os.release()} ${os.arch()}`;
  return cachedVersions;
}

function pendingDir() {
  return store.dir(path.join('events', 'pending'));
}

// Record one event on the run. Local only; never throws for a send problem (nothing is sent here).
// `extra` = fields kept on this machine only (rowFor builds the table row and never carries them).
function record(run, { kind, code, headline, words = null, detail = null, env = null, signal, extra = null }) {
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
    ...(extra || {}),
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
// timeoutMs (1.11.9): the version check-in's send gives up sooner than an engine run's.
function eventConnection(host, cli = resolveCli(), { timeoutMs = 300000 } = {}) {
  return {
    createEvent(body) {
      const tmp = path.join(store.dir('tmp'), `event-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
      try {
        return request(cli, host, EVENT_SET, { method: 'POST', headers: [], bodyFile: tmp, timeoutMs });
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

const PARK_AFTER = 3;
const PROBE_AHEAD = 5; // how many later files a failure is probed against before the app counts as down
const parkedDir = () => store.dir(path.join('events', 'parked'));
const triesFile = () => path.join(store.dir('events'), 'tries.json');
function readTries() {
  try { return JSON.parse(fs.readFileSync(triesFile(), 'utf8')); } catch { return {}; }
}

// Send this environment's pending events (and the machine's), in name order. A failure is PROBED against the next
// file (D-1255 .. D-1482, 10/29/26: one check-in that could never send held every later check-in on that machine):
//   - the next file sends: the failure is that file's own (too big, malformed), so it is skipped, a try is counted,
//     and the queue goes on; at PARK_AFTER such tries it moves to events/parked/ (kept here, counted by the health
//     check, never sent again by itself);
//   - none of the next PROBE_AHEAD files sends, or there is none: the app or the connection is down, so stop and count nothing (the
//     rest would fail the same way).
// Returns { sent, left, error, skipped, parked }; `error` is set only when the queue stopped.
function flush(conn, env) {
  const files = pendingFor(env);
  const tries = readTries();
  const skipped = [];
  const parked = [];
  let sent = 0;
  let stopped = null;
  const send = (f) => {
    const file = path.join(pendingDir(), f);
    try {
      conn.createEvent(rowFor(JSON.parse(fs.readFileSync(file, 'utf8'))));
    } catch (err) {
      if (!isDuplicateKey(err)) return err;
    }
    fs.rmSync(file, { force: true });
    delete tries[f];
    sent += 1;
    return null;
  };
  for (let i = 0; i < files.length; i++) {
    const err = send(files[i]);
    if (!err) continue;
    // Probe ahead (1.11.27 review F2: two bad files in a row used to read as an outage): the first later file that
    // sends shows every failure before it is that file's own; if none of the next PROBE_AHEAD sends, the app is down.
    const failed = [[files[i], err]];
    let ok = -1;
    for (let j = i + 1; j < files.length && j <= i + PROBE_AHEAD; j++) {
      const e = send(files[j]);
      if (!e) { ok = j; break; }
      failed.push([files[j], e]);
    }
    if (ok < 0) { stopped = err.message; break; }
    i = ok; // the probe that sent
    for (const [f, e] of failed) {
      const n = ((tries[f] && tries[f].n) || 0) + 1;
      tries[f] = { n, error: String(e.message).slice(0, 300), at: new Date().toISOString() };
      if (n >= PARK_AFTER) {
        fs.renameSync(path.join(pendingDir(), f), path.join(parkedDir(), f));
        delete tries[f];
        parked.push(f);
      } else skipped.push(f);
    }
  }
  try { fs.writeFileSync(triesFile(), JSON.stringify(tries), 'utf8'); } catch { /* counting is best effort */ }
  const left = pendingFor(env).length;
  return { sent, left, error: stopped, skipped, parked };
}

function pendingCount() {
  return fs.readdirSync(pendingDir()).filter((f) => f.endsWith('.json')).length;
}

function parkedCount() {
  return fs.readdirSync(parkedDir()).filter((f) => f.endsWith('.json')).length;
}

module.exports = {
  newRun, record, flush, rowFor, eventConnection, isSignal, pendingFor, pendingCount, parkedCount, versions,
  SIGNAL, EVENT_SET, ENGINE_VERSION, PARK_AFTER,
};
