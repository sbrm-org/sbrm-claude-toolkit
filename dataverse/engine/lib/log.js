'use strict';
// The write log (CONTRACT.md §9). RULED 10/6/26 (Dylan): the shared log is a Dataverse TABLE in each
// environment, `sbrm_dataversewritelog` (DESIGN.md §5). One row per apply or cancel, written through the
// person's own connection, so Dataverse stamps `createdby` itself. Staff hold Create + Read only.
//
// Order: the LOCAL copy first (~/.sbrm-dataverse/log/<email>.md, the backup on this machine), then the
// row. A row that cannot be written is parked in ~/.sbrm-dataverse/pending/ and retried at the next
// apply in the same environment. The row key (`sbrm_planid`) makes a retry idempotent: a duplicate-key
// answer means the row already landed.
//
// Replaced 10/6 (F16): per-person markdown files in a synced SharePoint folder, which needed a local
// sync path nobody guarantees.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { DataverseError } = require('./cli');

const LOG_SET = 'sbrm_dataversewritelogs';
const LOG_ID = 'sbrm_dataversewritelogid';

function localStamp(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function clip(v, n = 200) {
  const s = v === null || v === undefined ? '(blank)' : String(v);
  return s.length > n ? `${s.slice(0, n)}... (${s.length} characters)` : s;
}

function fileFor(dir, email) {
  return path.join(dir, `${email.replace(/[^a-z0-9@._-]/gi, '_')}.md`);
}

// entry = { time, headline, outcome, plan_id, person, env, app, table, mode, source, reason,
//           approval, rows: [{name, id, outcome, changes, before, after}], left_out: [{name, id, why}] }
function entryText(entry) {
  const p = entry.person;
  const written = entry.rows.filter((r) => r.outcome === 'written').length;
  const out = [
    '',
    // Heading in the writer's LOCAL time (people read it); the JSON keeps exact UTC.
    `## ${localStamp(entry.time)} - ${entry.headline} (${entry.outcome.toUpperCase()})`,
    '',
    `- Person: ${p.fullname} <${p.email}> (systemuserid ${p.systemuserid})`,
    `- Where: ${entry.app} (${entry.env}), table ${entry.table}, ${entry.mode}`,
    `- Plan: ${entry.plan_id}; approval: ${entry.approval}; made by: ${entry.source}`,
    ...(entry.reverts_plan_id ? [`- Undoes plan: ${entry.reverts_plan_id}`] : []),
    `- Reason given: ${entry.reason}`,
    `- Rows: ${written} written, ${entry.rows.length - written} not written, ${entry.left_out.length} left out`,
    '',
  ];
  entry.rows.forEach((r, i) => {
    out.push(`${i + 1}. ${r.name} \`${r.id || 'new'}\`: ${r.outcome}`);
    if (entry.mode === 'merge') {
      // The JSON block below holds BOTH records in full as they stood before, and every child id (DESIGN.md §8f).
      const moved = Object.values(r.inventory || {}).map((c) => `${c.label} ${c.ids.length}`).join(', ') || 'none';
      out.push(`   - kept record \`${r.keep_id}\`; moved: ${moved}`);
      const fills = Object.keys(r.content || {}).filter((c) => c !== 'description');
      if (fills.length) out.push(`   - filled on the kept record: ${fills.join(', ')}`);
      if (r.closed_year_children) out.push(`   - closed-year gifts that changed donor: ${r.closed_year_children}`);
      if (r.name_override) out.push(`   - names differ, confirmed: ${r.name_override}`);
    }
    if (entry.mode === 'delete') out.push('   - deleted; every column as it stood is in the JSON block below');
    // An old value is shown whenever the change carries one (record updates, and app changes of kind
    // schema / component, DESIGN.md §10e).
    for (const c of r.changes || []) {
      out.push(entry.mode === 'update' || c.old_text !== undefined ? `   - ${c.label}: ${clip(c.old_text)} -> ${clip(c.new_text)}` : `   - ${c.label}: ${clip(c.new_text)}`);
    }
  });
  for (const x of entry.left_out) out.push(`- Left out: ${x.name}: ${x.why}`);
  // Backticks escaped as ` (still valid JSON) so no value can close the fence.
  out.push('', '```json', JSON.stringify(entry, null, 1).replace(/`/g, '\\u0060'), '```', '');
  return out.join('\n');
}

function appendVerified(file, text) {
  fs.appendFileSync(file, text, 'utf8');
  return fs.readFileSync(file, 'utf8').endsWith(text);
}

// The row key. An APPLIED entry is keyed by its plan id (what revert looks up). A cancel is keyed by
// plan id + time, because a cancelled plan is kept and may be applied later: two entries, one plan.
function entryKey(entry) {
  if (entry.outcome !== 'cancelled') return entry.plan_id;
  const d = new Date(entry.time);
  const p = (n) => String(n).padStart(2, '0');
  return `${entry.plan_id}-c${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function rowFor(entry, text) {
  // Every record touched: for a merge that is the duplicate, the kept record and every moved child, so
  // "what happened to gift X" finds the merge that moved it.
  const ids = [...new Set([
    ...[...entry.rows, ...entry.left_out].map((r) => r.id),
    ...entry.rows.map((r) => r.keep_id),
    ...entry.rows.flatMap((r) => Object.values(r.inventory || {}).flatMap((c) => c.ids)),
  ].filter(Boolean))];
  const written = entry.rows.filter((r) => r.outcome === 'written').length;
  return {
    sbrm_name: entry.headline.slice(0, 200),
    sbrm_planid: entryKey(entry),
    sbrm_outcome: entry.outcome,
    sbrm_tablename: entry.table,
    sbrm_mode: entry.mode,
    sbrm_reason: String(entry.reason || '').slice(0, 500),
    sbrm_source: String(entry.source || '').slice(0, 300),
    sbrm_written: written,
    sbrm_notwritten: entry.rows.length - written,
    sbrm_leftout: entry.left_out.length,
    sbrm_recordids: ids.join('\n'),
    sbrm_entry: text,
    sbrm_revertsplanid: entry.reverts_plan_id || null,
  };
}

function isDuplicateKey(e) {
  return e instanceof DataverseError && (e.code === '0x80040237' || /matching key values|duplicate key/i.test(e.message));
}

// Create one row. true = landed (or had already landed); throws anything else.
function createRow(dv, row) {
  try {
    dv.create(LOG_SET, row);
    return true;
  } catch (e) {
    if (isDuplicateKey(e)) return true;
    throw e;
  }
}

function pendingDir() {
  return store.dir('pending');
}

// Retry parked rows for THIS environment (the connection only reaches one). Returns how many landed.
function flushPending(dv, env) {
  let n = 0;
  for (const f of fs.readdirSync(pendingDir()).filter((x) => x.startsWith(`${env}--`) && x.endsWith('.json')).sort()) {
    const file = path.join(pendingDir(), f);
    try {
      if (createRow(dv, JSON.parse(fs.readFileSync(file, 'utf8')))) {
        fs.rmSync(file);
        n += 1;
      }
    } catch { /* stays parked */ }
  }
  return n;
}

function writeEntry(entry, dv) {
  const text = entryText(entry);
  const local = fileFor(store.dir('log'), entry.person.email);
  if (!appendVerified(local, text)) throw new Error(`the local log did not read back: ${local}`);
  const row = rowFor(entry, text);
  let flushed = 0;
  let rowOk = false;
  let error = null;
  try {
    flushed = flushPending(dv, entry.env);
    rowOk = createRow(dv, row);
  } catch (e) {
    error = e.message;
  }
  if (!rowOk) {
    fs.writeFileSync(path.join(pendingDir(), `${entry.env}--${row.sbrm_planid}.json`), JSON.stringify(row), 'utf8');
  }
  return { local, rowOk, key: row.sbrm_planid, error, flushed };
}

// Parse every JSON block out of a local log file (a backup reader; revert reads the row).
function readEntries(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /```json\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(txt))) out.push(JSON.parse(m[1]));
  return out;
}

module.exports = { writeEntry, entryText, entryKey, rowFor, readEntries, flushPending, fileFor, LOG_SET, LOG_ID };
