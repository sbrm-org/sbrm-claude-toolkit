'use strict';
// revert <plan-id> (CONTRACT.md §10). READS ONLY: it turns an applied plan's log entry into a NEW
// job, plans it like any other write, and hands back the plan. The person applies that plan the
// normal way (pop-up, Approve), so a revert can never write without its own approval.
//
//   update -> every column the write changed goes back to its logged `before` value
//   create -> the record is marked inactive (statecode 1 + the table's first inactive status),
//             never deleted (only an admin's own delete job removes a record, ruled 10/7)
//   delete -> cannot be undone (the record is gone; its last values are in the log entry)
//
// RULED 10/7/26 (Dylan): a record is LEFT OUT if any column being undone has changed since the
// original write (someone edited it after us; undoing would wipe their edit without them knowing).
// The check is per COLUMN being undone, not the whole record: an unrelated later edit does not
// block. When one undone column moved, the WHOLE record is left out, never half-undone. Checked
// against the plan's own `before`, so apply's re-check (§5.4) and If-Match carry the guarantee
// through to the write.

const { validateJob, BIND_KEY } = require('./contract');
const { planJob, same, PlanRefused } = require('./resolve');
const { loadTable, refTable } = require('./meta');
const { LOG_SET } = require('./log');
const severity = require('./severity');

const UNDOABLE = new Set(['applied', 'applied with problems']);

function parseEntry(text) {
  const m = /```json\n([\s\S]*?)\n```/.exec(String(text || ''));
  if (!m) throw new Error('the log entry has no JSON block');
  return JSON.parse(m[1]);
}

// The applied entry for a plan id from this environment's log table, or null. An applied entry is
// keyed by the bare plan id (a cancel carries a -cHHMMSS suffix and wrote nothing).
function findEntry(dv, planId) {
  const filter = encodeURIComponent(`sbrm_planid eq '${planId}'`);
  const res = dv.get(`${LOG_SET}?$select=sbrm_planid,sbrm_entry&$filter=${filter}`);
  const row = (res.value || [])[0];
  return row ? parseEntry(row.sbrm_entry) : null;
}

function localStamp(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// "/<set>(<guid>)" for a lookup's old value. The set comes from the navigation property's own
// relationship, so it is exact for an ordinary lookup. A polymorphic one (Customer) has one nav per
// target table; if the old record was the OTHER kind, plan finds no such record and refuses the row.
function bindFor(dv, table, navKey, guid) {
  if (guid === null || guid === undefined) return null;
  const nav = table.navs.get(BIND_KEY.exec(navKey)[1]);
  if (!nav) throw new PlanRefused([`${table.entity.plural} no longer has the lookup ${navKey}`], 'invalid_job');
  return `/${refTable(dv, table, nav.referenced).set}(${String(guid).toLowerCase()})`;
}

function inactiveStatus(dv, table) {
  const r = dv.get(`EntityDefinitions(LogicalName='${table.entity.logical}')/Attributes(LogicalName='statuscode')`
    + '/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)');
  const hit = ((r.OptionSet && r.OptionSet.Options) || []).find((o) => o.State === 1);
  return hit ? hit.Value : null;
}

// read key ("_x_value" or "x") -> attribute logical name
function attrOfReadKey(k) {
  const m = /^_(.+)_value$/.exec(k);
  return m ? m[1] : k;
}

// Build the undo job (a raw job file) from an entry. Returns { raw, skipped, expect } where
// expect maps record id -> [{key, readKey?, attr?, value, text, label}] = what the record must
// still hold for the undo to be safe.
function buildJob(dv, entry) {
  if (!entry) throw new PlanRefused(['no applied entry for that plan (a cancelled plan wrote nothing)'], 'nothing_to_undo');
  if (entry.mode === 'merge') {
    throw new PlanRefused([`undoing a merge is not built yet. The Write Log entry for plan ${entry.plan_id} holds both records in full as they were and every record the merge moved, so a rebuild is possible; ask Dylan.`], 'not_built');
  }
  if (!UNDOABLE.has(entry.outcome)) throw new PlanRefused([`that plan's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  if (entry.mode === 'delete') {
    throw new PlanRefused([`a delete cannot be undone by the toolkit. Every column of each deleted record, as it stood, is in the Write Log entry for plan ${entry.plan_id}; a record can be keyed back from there by hand (it gets a new id).`], 'nothing_to_undo');
  }
  if (entry.mode !== 'update' && entry.mode !== 'create') throw new PlanRefused([`cannot undo a ${entry.mode}`], 'nothing_to_undo');
  const table = loadTable(dv, entry.table);
  if (!table) throw new PlanRefused([`there is no table "${entry.table}" any more`], 'table_missing');

  const skipped = [];
  const rows = [];
  const expect = new Map();
  const verify = new Set();
  const status = entry.mode === 'create' ? inactiveStatus(dv, table) : null;
  if (entry.mode === 'create' && status === null) throw new PlanRefused([`${table.entity.plural} has no inactive status, so a created record cannot be marked inactive`], 'nothing_to_undo');

  for (const r of entry.rows) {
    if (r.outcome !== 'written') {
      skipped.push({ name: r.name, id: r.id || null, why: `not undone: the original write reported "${r.outcome}"` });
      continue;
    }
    if (entry.mode === 'update') {
      const changes = r.changes || [];
      if (!changes.length) continue;
      const body = {};
      for (const c of changes) {
        body[c.column] = BIND_KEY.test(c.column) ? bindFor(dv, table, c.column, c.old) : c.old;
        verify.add(BIND_KEY.test(c.column) ? table.navs.get(BIND_KEY.exec(c.column)[1]).attr : c.column);
      }
      rows.push({ name: r.name, id: r.id, body });
      expect.set(r.id, changes.map((c) => ({ key: c.column, value: c.new, text: c.new_text, label: c.label })));
    } else {
      rows.push({ name: r.name, id: r.id, body: { statecode: 1, statuscode: status } });
      verify.add('statecode').add('statuscode');
      const after = Object.entries(r.after || {}).filter(([k]) => k !== table.entity.primaryId);
      for (const [k] of after) verify.add(attrOfReadKey(k));
      expect.set(r.id, after.map(([k, v]) => ({ readKey: k, value: v, text: v === null ? '(blank)' : String(v), label: (table.attrs.get(attrOfReadKey(k)) || {}).label || k })));
    }
  }
  if (!rows.length) {
    throw new PlanRefused(['nothing to undo:', ...skipped.map((s) => `  ${s.name}: ${s.why}`)], 'nothing_to_undo');
  }
  const fields = [...new Set(rows.flatMap((x) => Object.keys(x.body)))].sort();
  const when = entry.time ? localStamp(entry.time) : 'an unknown time';
  const by = entry.person ? entry.person.fullname : 'unknown';
  const raw = {
    contract: 'sbrm-dv-job/1',
    kind: 'rows',
    env: entry.env,
    table: entry.table,
    mode: 'update',
    source: `revert ${entry.plan_id}`,
    reason: `Undo plan ${entry.plan_id} ("${entry.headline}", applied ${when} by ${by}).`.slice(0, 500),
    intent: { verb: 'update', count: rows.length, table: entry.table, fields },
    verify: [...verify].sort(),
    rows,
  };
  return { raw, skipped, expect };
}

// The whole revert: build the job, plan it, leave out every record whose undone columns moved.
// Returns { plan, raw } (plan not yet saved).
function planRevert(dv, entry, { envs, access, warnRows }) {
  const { raw, skipped, expect } = buildJob(dv, entry);
  const { errors, job } = validateJob(raw, { envs });
  if (errors.length) throw new PlanRefused(['the undo job is not valid (an engine bug; nothing was planned):', ...errors], 'engine_bug');
  let plan;
  try {
    plan = planJob(dv, job, { envs, access, warnRows });
  } catch (e) {
    if (e instanceof PlanRefused && skipped.length) e.reasons.push(...skipped.map((s) => `  ${s.name}: ${s.why}`));
    throw e;
  }

  const keep = [];
  const moved = [];
  for (const row of plan.rows) {
    const diffs = [];
    for (const x of expect.get(row.id) || []) {
      const readKey = x.readKey || plan.columns[x.key].read_key;
      const now = row.before[readKey];
      if (same(now, x.value)) continue;
      const shown = (row.changes.find((c) => c.column === x.key) || {}).old_text;
      diffs.push(`${x.label}: ${x.text} -> ${shown !== undefined ? shown : (now === null ? '(blank)' : now)}`);
    }
    if (diffs.length) moved.push({ name: row.name, id: row.id, why: `changed since plan ${entry.plan_id}, so it is left as it is (${diffs.join('; ')})` });
    else keep.push(row);
  }
  const refused = [...skipped, ...plan.refused, ...moved];
  if (!keep.length) {
    throw new PlanRefused(['every record changed since the original write (or was already undone); nothing to undo:', ...refused.map((x) => `  ${x.name}: ${x.why}`)], 'every_row_moved');
  }
  // The severity of the undo as it will be approved (fewer rows than the original plan if some moved).
  const sev = plan.severity && severity.assess({ count: keep.length, noun: plan.severity.noun }, { warnRows: plan.severity.warn_rows });
  return { plan: { ...plan, rows: keep, refused, severity: sev, reverts_plan_id: entry.plan_id }, raw };
}

module.exports = { planRevert, buildJob, findEntry, parseEntry, inactiveStatus };

