'use strict';
// Guard blocks, kept on this machine (1.11.6, DESIGN.md §11). Dylan 10/9: "it would be great if reports could
// get submitted automatically when the hooks are blocking legitimate actions and someone's Claude notices
// that." Before this, a block printed to the session and vanished: the guard recorded nothing, so a report
// carried the person's words and nothing about the call that tripped the rule.
//
//   record(): the GUARD's half. Each block becomes one event of kind `blocked` (routine: counted in the
//     review, never opened), appended to events/events.jsonl and queued in events/pending/ like any engine
//     event. It carries the call as the guard saw it, the rule, the folder, the mode and the toolkit version.
//     The block id it returns goes into the block message, so the person's Claude can file
//     `report --blocked <id>` when it judges the block wrong; the engine attaches this record.
//   find() / recent(): the ENGINE's half, reading the same history.
//
// Best effort on the guard side: the caller ignores a failure here, and a block is a block either way.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const ID = /^B-\d{8}-\d{6}-[0-9a-f]{6}$/;
const CALL_MAX = 8000; // a shell command; a file write keeps its first CONTENT_MAX characters
const CONTENT_MAX = 3000;

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

function cut(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n)} [... ${t.length - n} more characters]` : t;
}

// What the tool was asked to do, as the guard saw it.
function callText(input) {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  if (tool === 'Bash' || tool === 'PowerShell') return cut(ti.command, CALL_MAX);
  if (tool === 'Write') return `${ti.file_path}\n--- content (${String(ti.content || '').length} characters) ---\n${cut(ti.content, CONTENT_MAX)}`;
  if (tool === 'Edit') return `${ti.file_path}\n--- old ---\n${cut(ti.old_string, CONTENT_MAX / 2)}\n--- new ---\n${cut(ti.new_string, CONTENT_MAX / 2)}`;
  return cut(JSON.stringify(ti), CALL_MAX);
}

// The rule: what the message names ("[rule: x; matched: "y" ...]", 1.11.5), else the reason up to its first
// bracket or colon ("changing the engine's own store").
function ruleOf(what) {
  const m = /\[rule: ([^;\]]+)(?:; matched: "([^"]*)")?/.exec(String(what));
  if (m) return { rule: m[1].trim(), matched: m[2] || null };
  return { rule: String(what).split(/[(:[]/)[0].trim().slice(0, 80) || 'unknown', matched: null };
}

// Which app the call is about, so the event goes to that app's table (a call about Recovery stays in
// Recovery's). Named by its host or its connection name; none named, or more than one, = the machine,
// except that Recovery wins whenever it is named (the one HIPAA app).
function envOf(text, envs) {
  const t = String(text).toLowerCase();
  const hit = Object.entries(envs || {}).filter(([key, e]) => {
    const host = String((e && e.host) || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    return (host && t.includes(host)) || t.includes(`dataverse-${key}`);
  }).map(([key]) => key);
  if (hit.includes('recovery')) return 'recovery';
  return hit.length === 1 ? hit[0] : 'machine';
}

function readEnvs() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'envs.json'), 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}

function describe(b) {
  return [
    `Guard block ${b.block_id}`,
    `Time: ${b.time}`,
    `Tool: ${b.tool}   Mode: ${b.mode || 'not given'}   Session: ${b.session || 'not given'}`,
    `Folder: ${b.cwd || 'not given'}`,
    `Toolkit: ${b.toolkit}`,
    `Rule: ${b.rule}${b.matched ? `   Matched: "${b.matched}"` : ''}`,
    `Why the guard blocked it: ${b.why}`,
    'The call, as the guard saw it:',
    b.call,
  ].join('\n');
}

// The guard's half. Returns the block record (with its id).
function record(input, what, { now = new Date(), envs = readEnvs() } = {}) {
  const call = callText(input || {});
  const { rule, matched } = ruleOf(what);
  const b = {
    block_id: `B-${stamp(now)}-${crypto.randomBytes(3).toString('hex')}`,
    time: now.toISOString(),
    tool: String((input && input.tool_name) || ''),
    session: (input && input.session_id) || null,
    cwd: (input && input.cwd) || null,
    mode: (input && input.permission_mode) || null,
    rule, matched,
    why: cut(what, 1000),
    call,
    toolkit: toolkitVersion(),
    env: envOf(call, envs),
  };
  const e = {
    event_id: b.block_id,
    run_id: b.block_id,
    time: b.time,
    kind: 'blocked',
    reason_code: 'blocked',
    signal: false,
    env: b.env,
    plan_id: null,
    command: cut(call, 300),
    machine: os.hostname(),
    versions: `toolkit ${b.toolkit}; guard; Node ${process.version}; ${os.type()} ${os.release()} ${os.arch()}`,
    person: null,
    headline: `Blocked [${rule}]: ${b.tool}`.slice(0, 200),
    words: null,
    detail: describe(b),
    block: b,
  };
  fs.appendFileSync(path.join(store.dir('events'), 'events.jsonl'), JSON.stringify(e) + '\n', 'utf8');
  fs.writeFileSync(path.join(store.dir(path.join('events', 'pending')), `${e.env}--${e.event_id}.json`), JSON.stringify(e), 'utf8');
  return b;
}

// The engine's half: every event line on this machine (newest last).
function history() {
  try {
    return fs.readFileSync(path.join(store.dir('events'), 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function find(id, all = history()) {
  if (!ID.test(String(id))) return null;
  const e = all.find((x) => x.kind === 'blocked' && x.event_id === id);
  return e ? e.block || null : null;
}

// Blocks on this machine, newest first, within `hours`.
function recent(n, { hours = 24, now = Date.now(), all = history() } = {}) {
  return all.filter((x) => x.kind === 'blocked' && x.block && now - Date.parse(x.time) <= hours * 3600 * 1000)
    .reverse().slice(0, n).map((x) => x.block);
}

// The report already filed for this block, if any (one report per block).
function reported(id, all = history()) {
  return all.find((x) => x.reason_code === 'false_block' && x.block_id === id) || null;
}

function line(b) {
  return `  ${b.time}  ${b.block_id}  ${b.tool}  [${b.rule}]  ${cut(String(b.call).replace(/\s+/g, ' '), 160)}`;
}

module.exports = { record, find, recent, reported, describe, line, toolkitVersion, callText, ruleOf, envOf, ID };
