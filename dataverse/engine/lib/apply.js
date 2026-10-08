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
const { whoAmI, accessFor, same } = require('./resolve');
const { resolveAccess } = require('./access');
const { BIND_VALUE } = require('./contract');
const { DataverseError } = require('./cli');
const { loadPlan } = require('./store');
const { summary, detail, headline } = require('./render');
const { writeEntry } = require('./log');
const closedYear = require('./closedyear');

const MAX_AGE_MS = 24 * 3600 * 1000;
const LEVELS = { read: 0, write: 1, schema: 2 };

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
  if ((LEVELS[acc.level] || 0) < LEVELS.write) throw new ApplyRefused(`your access to the ${plan.app} is now ${acc.level}, not write.`, 'access_revoked');
  if (acc.maxRows !== null && plan.rows.length > acc.maxRows) throw new ApplyRefused(`${plan.rows.length} rows is over your limit of ${acc.maxRows}.`, 'over_cap');

  // 1. re-check every row
  const standing = [];
  const moved = [];
  for (const row of plan.rows) {
    const r = recheck(dv, plan, row, now);
    if (r.why) moved.push({ name: row.name, id: row.id, why: r.why });
    else standing.push({ row, etag: r.etag });
  }
  const view = { ...plan, rows: standing.map((s) => s.row), refused: [...plan.refused, ...moved] };
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
  const answer = confirm({ summaryText: summary(view), detailText: detail(view, { id: plan.id }), title: `SBRM: approve this change to the ${plan.app}?` });
  if (!answer.approved) {
    const entry = { ...base, headline: headline(view), outcome: 'cancelled', note: answer.note || null, rows: [] };
    const logged = writeEntry(entry, dv);
    return { outcome: 'cancelled', note: answer.note || null, written: 0, failed: 0, left_out: view.refused, logged, rows: [], person: me };
  }

  // 3. write, read back, log, consume
  const rows = [];
  for (const { row, etag } of standing) {
    const out = { name: row.name, id: row.id, changes: row.changes, before: row.before, body: row.body };
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
