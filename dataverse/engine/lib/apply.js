'use strict';
// apply <plan-id> (CONTRACT.md §1, §5, §9). Reads the STORED plan, never the job file.
//
//   1. re-check: plan intact, younger than 24h, same person (WhoAmI), access still write and the
//      row cap still met, every update target unchanged since the plan, every create still not a
//      duplicate. A row that moved is left out and shown as such.
//   2. the pop-up, rendered from the stored plan (minus moved rows). Only Approve writes.
//   3. write each row (PATCH with If-Match, so a change after step 1 is refused by Dataverse),
//      read it back, log, consume the plan.

const fs = require('fs');
const { whoAmI, accessFor, same, display, deleteSeverity } = require('./resolve');
const { resolveAccess, TOOLKIT_SETS, LOG_TABLES, APP_DEFINITION_SETS } = require('./access');
const cascade = require('./cascade');
const { loadTable } = require('./meta');
const { BIND_VALUE } = require('./contract');
const { DataverseError } = require('./cli');
const { loadPlan } = require('./store');
const { summary, detail, headline } = require('./render');
const { writeEntry } = require('./log');
const closedYear = require('./closedyear');
const { atLeast } = require('./levels');
const severity = require('./severity');

const MAX_AGE_MS = 24 * 3600 * 1000;

class ApplyRefused extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'ApplyRefused';
    this.code = code; // fixed reason for the event record (lib/events.js)
  }
}

function expectedValue(col, v) {
  if (col.kind !== 'lookup') return v;
  return v === null ? null : BIND_VALUE.exec(v)[2].toLowerCase();
}

function selectFor(plan, row) {
  const keys = new Set(plan.verify.map((v) => v.read_key));
  for (const k of Object.keys(row.before || {})) if (k !== plan.labels.primary_id) keys.add(k);
  return [...keys].join(',');
}

// Step 1 for one row: null if it still stands, else why it is left out.
function recheck(dv, plan, row, today = new Date()) {
  const col = plan.closed_year_column;
  if (plan.mode === 'delete') {
    // The person approves deleting the record AS THE PLAN READ IT: if anything on it moved since, it is
    // left out (they may be about to delete something someone just updated).
    let now;
    try {
      now = dv.get(`${plan.table}(${row.id})`);
    } catch (e) {
      if (!(e instanceof DataverseError)) throw e;
      return { why: 'the record no longer exists' };
    }
    const moved = Object.keys(row.before).filter((k) => k in now && !k.includes('@') && !same(row.before[k], now[k]));
    if (moved.length) return { why: `changed since the plan (${moved.slice(0, 5).join(', ')})` };
    if (!now['@odata.etag']) return { why: 'no version tag came back, so the delete could not be protected' };
    if (col && !closedYear.isOpen(now[col], today)) return { why: `this record ${closedYear.why(now[col], today)}` };
    return { etag: now['@odata.etag'] };
  }
  if (plan.mode === 'update') {
    let now;
    try {
      now = dv.get(`${plan.table}(${row.id})?$select=${selectFor(plan, row)}`);
    } catch (e) {
      if (!(e instanceof DataverseError)) throw e;
      return { why: 'the record no longer exists' };
    }
    const moved = Object.keys(row.before)
      .filter((k) => k !== plan.labels.primary_id && k in now && !same(row.before[k], now[k]))
      .map((k) => `${(plan.verify.find((v) => v.read_key === k) || {}).label || k}: ${row.before[k]} -> ${now[k]}`);
    if (moved.length) return { why: `changed since the plan (${moved.join('; ')})` };
    if (!now['@odata.etag']) return { why: 'no version tag came back, so the write could not be protected' };
    if (col && !closedYear.isOpen(now[col], today)) return { why: `this record ${closedYear.why(now[col], today)}` };
    if (col && col in row.body && !closedYear.isOpen(row.body[col], today)) return { why: `the new book date ${closedYear.why(row.body[col], today)}` };
    return { etag: now['@odata.etag'] };
  }
  if (col && !closedYear.isOpen(row.body[col], today)) return { why: `the book date ${closedYear.why(row.body[col], today)}` };
  if (row.dup_filter) {
    try {
      const hits = dv.get(`${plan.table}?$top=1&$select=${plan.labels.primary_id}&$filter=${encodeURIComponent(row.dup_filter)}`);
      if ((hits.value || []).length) return { why: 'already recorded since the plan (the duplicate check now finds a match)' };
    } catch (e) {
      if (!(e instanceof DataverseError)) throw e;
      return { why: `the duplicate check could not run: ${e.message}` };
    }
  }
  return {};
}

function writeRow(dv, plan, row, etag) {
  let rid = row.id;
  if (plan.mode === 'delete') {
    dv.remove(plan.table, row.id, etag);
    // Read back: the record must be gone.
    // Only a real "does not exist" counts as gone; any other read failure is "could not confirm".
    try {
      dv.get(`${plan.table}(${row.id})?$select=${plan.labels.primary_id}`);
      return { rid, after: null, bad: ['the record is still there'] };
    } catch (e) {
      if (!(e instanceof DataverseError)) throw e;
      // By the platform's error CODE only: every message embeds the request path, so a GUID containing
      // "404" would have matched a text test (10/7 re-verify).
      const gone = e.code === '0x80040217';
      return { rid, after: null, bad: gone ? [] : [`could not confirm it is gone (${String(e.message).slice(0, 120)})`] };
    }
  }
  if (plan.mode === 'create') {
    const res = dv.create(plan.table, row.body);
    rid = res[plan.labels.primary_id];
    if (!rid) throw new Error('the new record id did not come back');
  } else {
    dv.update(plan.table, row.id, row.body, etag);
  }
  const back = dv.get(`${plan.table}(${rid})?$select=${plan.verify.map((v) => v.read_key).join(',')}`);
  const after = Object.fromEntries(Object.entries(back).filter(([k]) => !k.includes('@')));
  const bad = Object.keys(row.body).filter((key) => {
    const col = plan.columns[key];
    return !same(back[col.read_key], expectedValue(col, row.body[key]));
  }).map((key) => plan.columns[key].label);
  return { rid, after, bad };
}

function applyPlan(id, deps) {
  const { access, connect, confirm, now = new Date(), env = process.env } = deps;
  const { record: plan, file, intact } = loadPlan(id, { env });
  if (!intact) throw new ApplyRefused('this plan file was changed after it was made. Make a new plan.', 'plan_tampered');
  if (now - new Date(plan.created) > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old. Make a new plan.', 'stale_plan');

  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) {
    throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  }
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  // Worked out again from what the plan WRITES (the table and the mode), never from a field the plan
  // carries: a delete and the toolkit's own tables are an admin's (10/7 review: the toolkit tables were
  // checked at plan only, so a demotion in between was missed).
  const need = plan.mode === 'delete' || TOOLKIT_SETS.has(plan.table) ? 'admin' : 'write';
  if (!atLeast(acc.level, need)) throw new ApplyRefused(`your access to the ${plan.app} is now ${acc.level}, not ${need}.`, 'access_revoked');
  if (APP_DEFINITION_SETS.has(plan.table)) throw new ApplyRefused(`${plan.table} holds the app's own definitions; it is changed through an app change (kind component or schema), never a records job.`, 'not_permitted');
  if (LOG_TABLES.has(plan.table) && plan.mode !== 'create') throw new ApplyRefused('the Write Log and the event table are append-only.', 'not_permitted');

  // 0. The pop-up shows each row's `changes`; the write sends its `body`. They must say the same thing, or
  // the person approves one change and gets another (10/7 review: an edited plan file could split them).
  for (const row of plan.rows) {
    if (plan.mode === 'delete') { if (row.body) throw new ApplyRefused('a delete row carries a body; this plan file is not one the engine made. Make a new plan.', 'plan_tampered'); continue; }
    const shown = new Map((row.changes || []).map((c) => [c.column, c]));
    for (const [key, v] of Object.entries(row.body || {})) {
      const col = plan.columns[key];
      if (!col) throw new ApplyRefused(`the plan writes ${key}, which it never showed. Make a new plan.`, 'plan_tampered');
      const c = shown.get(key);
      const want = expectedValue(col, v);
      // Apply's re-check compares only the columns the plan's `before` holds: every written column must be
      // there, or a column could be written without being re-checked (10/7 re-verify).
      if (plan.mode === 'update' && (!row.before || !(col.read_key in row.before))) throw new ApplyRefused(`the plan writes ${key} without a before value to re-check. Make a new plan.`, 'plan_tampered');
      // A value equal to the record's current one is not a change, so it is not shown; anything else must be.
      const unchanged = plan.mode === 'update' && row.before && same(row.before[col.read_key], want);
      if (!c && !unchanged && !(plan.mode === 'create' && v === null)) throw new ApplyRefused(`the plan writes ${key} without showing it. Make a new plan.`, 'plan_tampered');
      if (c && !same(c.new, want)) throw new ApplyRefused(`the plan shows ${c.label} as "${c.new_text}" but would write something else. Make a new plan.`, 'plan_tampered');
      // The pop-up shows the TEXT; for a plain column that text is computed from the value (choices and
      // lookups show a label read at plan, which the value check above already ties to the write).
      if (c && col.kind === 'plain' && !['Picklist', 'State', 'Status', 'Boolean', 'Virtual', 'Money'].includes(col.type) && c.new_text !== display(col, want)) {
        throw new ApplyRefused(`the plan's text for ${c.label} does not match the value it would write. Make a new plan.`, 'plan_tampered');
      }
    }
    for (const c of row.changes || []) if (!(c.column in (row.body || {}))) throw new ApplyRefused(`the plan shows a change to ${c.label} it would not write. Make a new plan.`, 'plan_tampered');
  }

  // 1. re-check every row
  const standing = [];
  const moved = [];
  for (const row of plan.rows) {
    const r = recheck(dv, plan, row, now);
    if (r.why) moved.push({ name: row.name, id: row.id, why: r.why });
    else standing.push({ row, etag: r.etag });
  }
  const view = { ...plan, rows: standing.map((s) => s.row), refused: [...plan.refused, ...moved] };
  // The severity of what still stands. Rows can only drop out between plan and apply, so this never
  // grows for a rows plan; the check is here so no future path can approve less than it writes (§10j).
  if (plan.severity) {
    view.severity = severity.assess({ count: view.rows.length, noun: plan.severity.noun, lasting: plan.severity.lasting, irreversible: plan.severity.irreversible, unproven: plan.severity.unproven }, { warnRows: plan.severity.warn_rows });
    if (severity.grew(plan.severity, view.severity)) throw new ApplyRefused('this change is bigger or more serious now than when it was planned. Make a new plan.', 'severity_grew');
  }
  const ctx = { plan, view, standing, moved, me, dv, confirm, now, file };
  if (plan.mode !== 'delete') return finishApply(ctx);
  // A delete: what it takes with it must be exactly what the pop-up shows: re-taken now (in parallel, so
  // this path is async and applyPlan returns a Promise), and any difference refuses the whole apply.
  return (async () => {
    const table = loadTable(dv, plan.table);
    const rels = cascade.deleteRelationships(dv, table.entity.logical);
    const inv = await cascade.inventory(dv, rels, view.rows.map((r) => r.id));
    const stable = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k].action, o[k].ids]));
    const changed = view.rows.filter((r) => stable(cascade.forRecord(inv, r.id)) !== stable(r.cascade));
    if (changed.length || !plan.cascade) {
      throw new ApplyRefused(`the records linked to ${changed.length ? changed.map((r) => r.name).slice(0, 3).join(', ') : 'what is being deleted'} changed since the plan, so the pop-up would not show what goes with them. Make a new plan.`, 'every_row_moved');
    }
    view.typed = severity.typedPhrase(view.rows.map((r) => r.record_name || r.name || r.id));
    view.severity = deleteSeverity(view.rows.length, table.entity, inv, plan.severity ? plan.severity.warn_rows : undefined);
    if (plan.severity && severity.grew(plan.severity, view.severity)) throw new ApplyRefused('this delete is bigger now than when it was planned. Make a new plan.', 'severity_grew');
    return finishApply(ctx);
  })();
}

// Steps 2 and 3: the pop-up, then write, read back, log, consume.
function finishApply({ plan, view, standing, moved, me, dv, confirm, now, file }) {
  const base = {
    time: now.toISOString(), plan_id: plan.id, person: me, env: plan.env, app: plan.app, table: plan.table,
    mode: plan.mode, source: plan.source, reason: plan.reason, approval: 'dialog', left_out: view.refused,
    reverts_plan_id: plan.reverts_plan_id || null, // a revert's log row names the plan it undoes (§10)
  };
  if (!standing.length) {
    fs.rmSync(file, { force: true });
    throw new ApplyRefused(['every row changed since the plan, nothing to write:', ...moved.map((m) => `  ${m.name}: ${m.why}`)].join('\n'), 'every_row_moved');
  }

  // 2. the pop-up
  const answer = confirm({
    summaryText: summary(view), detailText: detail(view, { id: plan.id }),
    title: plan.mode === 'delete' ? `SBRM: approve DELETING from the ${plan.app}?` : `SBRM: approve this change to the ${plan.app}?`,
    typed: view.typed || null,
  });
  if (!answer.approved) {
    const entry = { ...base, headline: headline(view), outcome: 'cancelled', note: answer.note || null, rows: [] };
    const logged = writeEntry(entry, dv);
    return { outcome: 'cancelled', note: answer.note || null, written: 0, failed: 0, left_out: view.refused, logged, rows: [], person: me };
  }

  // 3. write, read back, log, consume
  const rows = [];
  for (const { row, etag } of standing) {
    const out = { name: row.name, id: row.id, changes: row.changes, before: row.before, body: row.body };
    if (row.cascade) out.cascade = row.cascade; // a delete: every linked record it took or unlinked, by id
    try {
      const w = writeRow(dv, plan, row, etag);
      out.id = w.rid;
      out.after = w.after;
      out.outcome = w.bad.length ? `read-back mismatch: ${w.bad.join(', ')}` : 'written';
    } catch (e) {
      out.outcome = e && e.code === '0x80060882'
        ? 'failed: the record changed between the check and the write; nothing was written to it'
        : `failed: ${e.message}`;
    }
    rows.push(out);
  }
  fs.rmSync(file, { force: true });
  const written = rows.filter((r) => r.outcome === 'written').length;
  const entry = { ...base, headline: headline(view), outcome: written === rows.length ? 'applied' : 'applied with problems', rows };
  const logged = writeEntry(entry, dv);
  return { outcome: entry.outcome, written, failed: rows.length - written, left_out: view.refused, logged, rows, person: me };
}

module.exports = { applyPlan, ApplyRefused, recheck, expectedValue };
