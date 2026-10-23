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
const crypto = require('crypto');
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

// "written" counts only rows read back as planned (the Write Log's sbrm_written too). A row whose write went through
// but could not be read back (1.11.18) counts as not written, and the text says how many of those there are.
function unverified(entry) {
  const n = (entry.rows || []).filter((r) => /^read-back failed:/.test(r.outcome || '')).length;
  return n ? ` (${n} of them went through but could not be verified)` : '';
}

// entry = { time, headline, outcome, plan_id, person, env, app, table, mode, source, reason,
//           approval, rows: [{name, id, outcome, changes, before, after}], left_out: [{name, id, why}] }
// `rowLines: false` (an entry trimmed for the Write Log row, fitForRow) leaves out the per-row lines.
// The entry's heading and summary lines (also the head of a split entry's first part, splitText).
function headerLines(entry, suffix = '') {
  const p = entry.person;
  // An entry trimmed to its counts ('all', fitForRow) carries them; every other entry counts its rows.
  const written = entry.rows_written ?? entry.rows.filter((r) => r.outcome === 'written').length;
  const total = entry.rows_total ?? entry.rows.length;
  const leftOut = entry.left_out_total ?? entry.left_out.length;
  return [
    '',
    // Heading in the writer's LOCAL time (people read it); the JSON keeps exact UTC.
    `## ${localStamp(entry.time)} - ${entry.headline} (${entry.outcome.toUpperCase()})${suffix}`,
    '',
    `- Person: ${p.fullname} <${p.email}> (systemuserid ${p.systemuserid})`,
    `- Where: ${entry.app} (${entry.env}), table ${entry.table}, ${entry.mode}`,
    `- Plan: ${entry.plan_id}; approval: ${entry.approval}; made by: ${entry.source}`,
    ...(entry.reverts_plan_id ? [`- Undoes plan: ${entry.reverts_plan_id}`] : []),
    `- Reason given: ${entry.reason}`,
    `- Rows: ${written} written, ${total - written} not written${unverified(entry)}, ${leftOut} left out`,
    '',
  ];
}

function entryText(entry, { rowLines = true } = {}) {
  const p = entry.person;
  const out = headerLines(entry);
  if (!rowLines) {
    const kept = { bodies: 'what undo needs', hashed: 'what undo needs, with each long new value as its hash', rows: 'only each record\'s id and outcome', all: 'only the counts' }[entry.log_trimmed] || 'less';
    out.push(`- Over Dataverse's 1 MB limit for this row, so the row lines are left out here and the JSON keeps ${kept}. The full entry is in ${p.email}'s local log on the computer that applied it (~/.sbrm-dataverse/log/).`);
  }
  if (rowLines) entry.rows.forEach((r, i) => {
    out.push(`${i + 1}. ${r.name} \`${r.id || 'new'}\`: ${r.outcome}`);
    if (r.note) out.push(`   - note: ${r.note}`);
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
  if (rowLines) for (const x of entry.left_out) out.push(`- Left out: ${x.name}: ${x.why}`);
  // Backticks escaped as ` (still valid JSON) so no value can close the fence.
  out.push('', '```json', JSON.stringify(entry, null, 1).replace(/`/g, '\\u0060'), '```', '');
  return out.join('\n');
}

// The Write Log row's entry column holds at most 1,048,576 characters (D-1174, 10/17: an import's 1,314,762-character
// entry was refused, parked and retried unchanged forever). The local log always keeps the full entry; the row keeps
// as much as fits, in steps:
//   'bodies'  each row keeps what undo reads (lib/revert.js): name, id, outcome, note, and `changes` for an update,
//             `after` for a create (merges and app changes keep their changes, after and the moved-record ids);
//             the `body` and `before` copies go
//   'hashed'  as 'bodies', but a NEW value over 2,000 characters (a change's `new`, a create's `after`) is kept as its
//             SHA-256 and length: undo writes back only the old value, and the hash still shows a later change
//   'rows'    each row keeps name, id and outcome; undo then refuses and says where the full entry is (the OLD values
//             alone do not fit)
//   'all'     no rows: the counts and the plan's own fields, clipped, always under the limit
const ENTRY_MAX = 1000000; // under the column's limit, with room for the escaping JSON.stringify adds
const KEEP_FOR_UNDO = { update: ['changes'], create: ['after'] };
const BIG_VALUE = 2000;
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
function hashBig(r) {
  const out = { ...r };
  if (Array.isArray(r.changes)) {
    out.changes = r.changes.map((c) => {
      if (!(typeof c.new === 'string' && c.new.length > BIG_VALUE)) return c;
      const { new: v, new_text: _shown, ...rest } = c; // eslint-disable-line no-unused-vars
      return { ...rest, new_sha256: sha256(v), new_length: v.length };
    });
  }
  if (r.after && typeof r.after === 'object') {
    const kept = {};
    const hashed = {};
    for (const [k, v] of Object.entries(r.after)) {
      if (typeof v === 'string' && v.length > BIG_VALUE) hashed[k] = sha256(v); else kept[k] = v;
    }
    out.after = kept;
    if (Object.keys(hashed).length) out.after_sha256 = hashed;
  }
  return out;
}
const cut = (v, n) => (v === null || v === undefined ? v : String(v).slice(0, n));
// The trimmed forms of an entry, smallest-loss first: { base (the plan's own fields, clipped), steps }.
function trimmedForms(entry) {
  const pick = (r, keys) => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
  // The plan's own fields, clipped in EVERY step, so a huge reason or name never pushes out the rows undo needs, and
  // the last step always fits (review 10/23, rounds 1 and 2).
  const p = entry.person || {};
  const base = {
    ...entry, table: cut(entry.table, 200), app: cut(entry.app, 200), approval: cut(entry.approval, 50),
    headline: cut(entry.headline, 200), source: cut(entry.source, 300), reason: cut(entry.reason, 500),
    person: { fullname: cut(p.fullname, 200), email: cut(p.email, 200), systemuserid: cut(p.systemuserid, 60) },
    left_out: entry.left_out.map((x) => ({ name: cut(x.name, 200), id: x.id, why: cut(x.why, 500) })),
  };
  const keep = KEEP_FOR_UNDO[entry.mode] || ['changes', 'after', 'keep_id', 'inventory'];
  // A row's display name and note are clipped too: neither is what undo reads (round 3).
  const short = (r) => ({ ...r, ...(r.name !== undefined ? { name: cut(r.name, 200) } : {}), ...(r.note !== undefined ? { note: cut(r.note, 500) } : {}) });
  const bodies = entry.rows.map((r) => short(pick(r, ['name', 'id', 'outcome', 'note', ...keep])));
  const steps = [
    ['bodies', bodies],
    ['hashed', bodies.map(hashBig)],
    ['rows', entry.rows.map((r) => short(pick(r, ['name', 'id', 'outcome'])))],
  ];
  return { base, steps };
}

// ONE row's text: the entry, else its trimmed forms in order, else the counts alone (always fits).
function fitForRow(entry, text = entryText(entry)) {
  if (text.length <= ENTRY_MAX) return text;
  const { base, steps } = trimmedForms(entry);
  for (const [trimmed, rows] of steps) {
    const t = entryText({ ...base, rows, log_trimmed: trimmed }, { rowLines: false });
    if (t.length <= ENTRY_MAX) return t;
  }
  // Nothing per row fits: the counts and the clipped plan fields, nothing that can grow.
  return entryText({
    time: base.time, plan_id: cut(base.plan_id, 100), outcome: cut(base.outcome, 100), mode: cut(base.mode, 50),
    table: base.table, env: cut(base.env, 50), app: base.app, approval: base.approval, person: base.person,
    reverts_plan_id: cut(base.reverts_plan_id, 100) || null, headline: base.headline, source: base.source, reason: base.reason,
    rows: [], left_out: [], log_trimmed: 'all', rows_total: entry.rows.length,
    rows_written: entry.rows.filter((r) => r.outcome === 'written').length, left_out_total: entry.left_out.length,
  }, { rowLines: false });
}

// RULED 10/23/26 (Dylan, "Split into rows"): when even the 'hashed' form of an entry is over one row, it is written
// across numbered Write Log rows instead of losing what undo needs: the bare plan id (what undo looks up) holds the
// heading and part 1, `<plan id>-p2` ... `-pN` the rest, each part a slice of the 'hashed' form's JSON. Undo joins them
// (lib/revert.js findEntry). Past MAX_PARTS rows, 'rows' and 'all' are the last resorts as before.
const MAX_PARTS = 20;
const PART_MAX = 900000; // a part's slice, escaped as a JSON string; the heading adds well under 100,000
// A slice's length as the row writes it: JSON-escaped, and each backtick as ` (round 4: a backtick-heavy part
// was measured before that last escape and came out several times the limit).
const writtenLength = (x) => JSON.stringify(x).replace(/`/g, '\\u0060').length;
function sliceJson(s) {
  const out = [];
  for (let i = 0; i < s.length;) {
    let n = Math.min(PART_MAX, s.length - i);
    let len;
    while ((len = writtenLength(s.slice(i, i + n))) > PART_MAX) n = Math.max(1, Math.floor((n * PART_MAX * 0.98) / len));
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}
function splitText(base, chunk, k, n) {
  const out = k === 1 ? headerLines(base, ` [log part 1 of ${n}]`) : ['', `## ${localStamp(base.time)} - ${base.headline} [log part ${k} of ${n}]`, ''];
  out.push(`- Over Dataverse's 1 MB limit for one row, so this entry is split across ${n} Write Log rows (plan ${base.plan_id}, then -p2 to -p${n}); undo joins them in order. The full entry is also in ${base.person.email}'s local log on the computer that applied it (~/.sbrm-dataverse/log/).`);
  const part = { plan_id: base.plan_id, log_trimmed: 'split', part: k, parts: n, chunk };
  out.push('', '```json', JSON.stringify(part, null, 1).replace(/`/g, '\\u0060'), '```', '');
  return out.join('\n');
}
// The entry's row texts: one, or the parts of a split entry in order.
function fitRows(entry, text = entryText(entry), { maxParts = MAX_PARTS } = {}) {
  if (text.length <= ENTRY_MAX) return [text];
  const { base, steps } = trimmedForms(entry);
  for (const [trimmed, rows] of steps.slice(0, 2)) {
    const t = entryText({ ...base, rows, log_trimmed: trimmed }, { rowLines: false });
    if (t.length <= ENTRY_MAX) return [t];
  }
  if (maxParts > 1) {
    // (one part is allowed: the compact form can fit where the printed one does not, round 4)
    const chunks = sliceJson(JSON.stringify({ ...base, rows: steps[1][1], log_trimmed: 'hashed' }));
    const texts = chunks.map((c, i) => splitText(base, c, i + 1, chunks.length));
    if (chunks.length <= maxParts && texts.every((t) => t.length <= ENTRY_MAX)) return texts;
  }
  return [fitForRow(entry, text)];
}
// The rows for an entry's texts; parts 2..N are keyed <plan id>-pK and are never counted as a write.
function rowsFor(entry, texts, first = null) {
  return texts.map((t, i) => {
    if (i === 0) return first ? { ...first, sbrm_entry: t } : rowFor(entry, t);
    return {
      ...rowFor(entry, t), sbrm_planid: `${entryKey(entry)}-p${i + 1}`, sbrm_name: `${String(entry.headline).slice(0, 170)} (log part ${i + 1} of ${texts.length})`,
      sbrm_outcome: 'log part', sbrm_written: 0, sbrm_notwritten: 0, sbrm_leftout: 0, sbrm_recordids: '', sbrm_revertsplanid: null,
    };
  });
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
  // A split entry's parts sort before its first row (<key>-pK.json < <key>.json) and land first; the first row, which
  // undo looks up, waits while any of its parts is still parked.
  const waiting = new Set();
  for (const f of fs.readdirSync(pendingDir()).filter((x) => x.startsWith(`${env}--`) && x.endsWith('.json')).sort()) {
    const file = path.join(pendingDir(), f);
    const key = f.slice(`${env}--`.length, -'.json'.length);
    const part = /^(.+)-p\d+$/.exec(key);
    if (!part && waiting.has(key)) continue;
    try {
      const row = JSON.parse(fs.readFileSync(file, 'utf8'));
      let rows = [row];
      // A row parked by 1.11.18 or earlier was never trimmed (D-1174): fit it from its own JSON block, splitting it
      // across rows when even the undo form does not fit one.
      if (String(row.sbrm_entry || '').length > ENTRY_MAX) {
        const entry = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(row.sbrm_entry)[1]);
        rows = rowsFor(entry, fitRows(entry, row.sbrm_entry), row);
        rows = [...rows.slice(1), rows[0]];
      }
      if (rows.every((r) => createRow(dv, r))) {
        fs.rmSync(file);
        n += 1;
      } else if (part) waiting.add(part[1]);
    } catch {
      if (part) waiting.add(part[1]); // stays parked
    }
  }
  return n;
}

function writeEntry(entry, dv) {
  const text = entryText(entry);
  const local = fileFor(store.dir('log'), entry.person.email);
  if (!appendVerified(local, text)) throw new Error(`the local log did not read back: ${local}`);
  const rows = rowsFor(entry, fitRows(entry, text));
  const row = rows[0];
  let flushed = 0;
  let rowOk = true;
  let error = null;
  try {
    flushed = flushPending(dv, entry.env);
  } catch (e) {
    error = e.message;
  }
  // A split entry's parts first, so the row undo looks up exists only once every part has landed; whatever does not
  // land is parked, each row on its own, and retried in the same order (flushPending).
  for (const r of [...rows.slice(1), row]) {
    if (rowOk) {
      try {
        rowOk = createRow(dv, r);
      } catch (e) {
        rowOk = false;
        error = e.message;
      }
    }
    if (!rowOk) fs.writeFileSync(path.join(pendingDir(), `${entry.env}--${r.sbrm_planid}.json`), JSON.stringify(r), 'utf8');
  }
  return { local, rowOk, key: row.sbrm_planid, error, flushed, parts: rows.length };
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

module.exports = { unverified, fitForRow, fitRows, rowsFor, ENTRY_MAX, MAX_PARTS, sha256, writeEntry, entryText, entryKey, rowFor, readEntries, flushPending, fileFor, LOG_SET, LOG_ID };
