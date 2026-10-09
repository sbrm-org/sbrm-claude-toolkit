'use strict';
// Events recorded OUTSIDE an engine run (1.11.6, DESIGN.md §11): by the guard (a block, a repeated block, an
// approval nobody used) and by the read-connection launcher (an app's connection failed to start). Same
// shape and the same two files as lib/events.js record(): one line in events/events.jsonl (this machine's
// history) and one file in events/pending/ that the next engine run sends to the app's event table. No run,
// no person (the table's createdby names them when it lands), and no Dataverse CLI lookup for the versions,
// so it is cheap enough for a hook.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const DAY = 24 * 3600 * 1000;

// The toolkit's own version, from the plugin's plugin.json (this file sits in <root>/dataverse/engine/lib).
// The engine's version string was a hand-set constant that did not move across 1.11.1 to 1.11.5.
function toolkitVersion(root = path.join(__dirname, '..', '..', '..')) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8').replace(/^﻿/, '')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newId(prefix, now = new Date()) {
  return `${prefix}-${stamp(now)}-${crypto.randomBytes(3).toString('hex')}`;
}

function versions(by) {
  return `toolkit ${toolkitVersion()}; ${by}; Node ${process.version}; ${os.type()} ${os.release()} ${os.arch()}`;
}

// Record one event. `by` names the recorder in the versions string (guard, launcher).
function note({ id, time = new Date(), kind, code, signal, env = 'machine', headline, detail = '', command = null, by, extra = null }) {
  const e = {
    event_id: id,
    run_id: id,
    time: time.toISOString(),
    kind,
    reason_code: code,
    signal: !!signal,
    env,
    plan_id: null,
    command,
    machine: os.hostname(),
    versions: versions(by),
    person: null,
    headline: String(headline).replace(/\s+/g, ' ').trim().slice(0, 200),
    words: null,
    detail,
    ...(extra || {}),
  };
  fs.appendFileSync(path.join(store.dir('events'), 'events.jsonl'), JSON.stringify(e) + '\n', 'utf8');
  fs.writeFileSync(path.join(store.dir(path.join('events', 'pending')), `${e.env}--${e.event_id}.json`), JSON.stringify(e), 'utf8');
  return e;
}

// This machine's event history, oldest first. `tailBytes` reads only the end of the file (a hook must stay
// quick however long the history grows); the first, possibly cut, line is dropped.
function history({ tailBytes = null } = {}) {
  const file = path.join(store.dir('events'), 'events.jsonl');
  let text;
  try {
    if (tailBytes) {
      const size = fs.statSync(file).size;
      const start = Math.max(0, size - tailBytes);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } else {
      text = fs.readFileSync(file, 'utf8');
    }
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Same calendar day, local time (what "today" means to the person).
function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

module.exports = { note, history, newId, toolkitVersion, sameDay, DAY };
