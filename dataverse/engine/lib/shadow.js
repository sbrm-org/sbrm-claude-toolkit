'use strict';
// The guard's next decision model running in SHADOW (1.11.10; guard_review/DESIGN.md §6d, ruled 10/13: "two
// releases"). guard.js decides every call exactly as before; it also asks guard_next.js and, when the two DISAGREE,
// records it here. Nothing here can change a decision.
//
//   events/guard_shadow.jsonl   every disagreement on this machine, the call as the guard saw it, both verdicts
//   an event of kind "guard shadow" (code guard_shadow), sent to the app's event table like a block:
//     - old blocked, next allows: what the redesign is FOR; routine, counted in the review
//     - old allowed, next blocks or asks (or next crashed): a possible NEW false positive; opens an item for
//       Dylan's review (at most DAILY_OPEN a day per machine; past that, counted)
// The shadow week's done-condition: no "next blocks" item that is ordinary work, and every "old blocks" line one of
// the recorded false-positive shapes or a new one Dylan accepts. Doctor's own probes are not recorded.
// From the 1.11.14 cut-over the roles swapped: the NEXT model decides and the old one watches (guard.js shadowOld),
// with the same fields. The words say so since 1.11.24 (#6hr2m7pRppqwGmvr item 4: "Old (decided)" sent the 10/26
// review after a block that never blocked); the headline's "[old x / next y]" prefix is kept, the review counts by it.

const fs = require('fs');
const path = require('path');
const note = require('./note');
const store = require('./store');
const blocks = require('./blocks');

const DAILY_OPEN = 5;
const DAILY_MAX = 60; // events sent per machine per day; the local file keeps every line
const TAIL = 512 * 1024;

const cut = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)} [... ${t.length - n} more characters]` : t; };

function file() {
  return path.join(store.dir('events'), 'guard_shadow.jsonl');
}

// old / next: { kind: 'allow' | 'block' | 'ask' | 'crash', why }
function record(input, old, next, { now = new Date() } = {}) {
  if (process.env.SBRM_GUARD_PROBE === '1') return null;
  const call = blocks.callText(input || {});
  const line = {
    time: now.toISOString(),
    tool: String((input && input.tool_name) || ''),
    cwd: (input && input.cwd) || null,
    mode: (input && input.permission_mode) || null,
    session: (input && input.session_id) || null,
    toolkit: note.toolkitVersion(),
    old: { kind: old.kind, why: cut(old.why, 600) },
    next: { kind: next.kind, why: cut(next.why, 600) },
    call,
  };
  fs.appendFileSync(file(), JSON.stringify(line) + '\n', 'utf8');
  const today = note.history({ tailBytes: TAIL }).filter((x) => x.reason_code === 'guard_shadow' && note.sameDay(x.time, now));
  if (today.length >= DAILY_MAX) return line;
  const newStop = old.kind === 'allow' && next.kind !== 'allow';
  const open = newStop && today.filter((x) => x.signal).length < DAILY_OPEN;
  note.note({
    id: note.newId('S', now), time: now, kind: 'guard shadow', code: 'guard_shadow', signal: open,
    env: blocks.envOf(call, blocks.readEnvs()), by: 'guard', command: cut(call, 300),
    headline: `Shadow [old ${old.kind} / next ${next.kind}]: ${line.tool}${newStop ? ' (stopped; the old model would have let it run)' : next.kind === 'allow' ? ' (ran; only the old model would have stopped it)' : ''}`,
    detail: [
      `The guard's old model (watching only since the 1.11.14 cut-over) disagreed with the next model, which decided (toolkit ${line.toolkit}).`,
      `Next (decided): ${next.kind}${next.why ? `: ${next.why}` : ''}`,
      `Old (watching only): ${old.kind}${old.why ? `: ${old.why}` : ''}`,
      `Tool: ${line.tool}   Mode: ${line.mode || 'not given'}   Folder: ${line.cwd || 'not given'}`,
      'The call, as the guard saw it:',
      call,
    ].join('\n'),
    extra: { shadow: { old: line.old, next: line.next } },
  });
  return line;
}

// This machine's disagreements, oldest first.
function lines() {
  try {
    return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = { record, lines, file, DAILY_OPEN, DAILY_MAX };
