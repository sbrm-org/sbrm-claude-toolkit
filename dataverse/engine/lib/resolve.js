'use strict';
// Live resolution of a validated job into a plan (CONTRACT.md §4). READS ONLY.
//
// Every fact the person will approve is computed here from the job plus live reads:
// who is asking, whether they may write, which columns exist and what they are called,
// each target's CURRENT values, duplicates, and the linked records' real names.

const { loadTable, choiceLabels, refTable, isChoice, NUMERIC } = require('./meta');
const closedYear = require('./closedyear');
const { resolveAccess, TOOLKIT_SETS, LOG_TABLES, APP_DEFINITION_SETS } = require('./access');
const { BIND_KEY, BIND_VALUE } = require('./contract');
const { DataverseError } = require('./cli');

const { normalize, atLeast } = require('./levels');
const severity = require('./severity');
const cascade = require('./cascade');

const LOOKUP_TYPES = new Set(['Lookup', 'Customer', 'Owner']);

// `code` is the fixed reason the event record and the review count on (DESIGN.md §7 D2, lib/events.js).
class PlanRefused extends Error {
  constructor(reasons, code = null) {
    super(reasons.join('\n'));
    this.name = 'PlanRefused';
    this.reasons = reasons;
    this.code = code;
  }
}

// ---------- identity + access ----------

function whoAmI(dv) {
  const me = dv.get('WhoAmI');
  const u = dv.get(`systemusers(${me.UserId})?$select=fullname,internalemailaddress,domainname`);
  const email = String(u.internalemailaddress || u.domainname || '').toLowerCase();
  return { systemuserid: me.UserId, fullname: u.fullname, email };
}

// { level } for one person in one environment: read | write | develop | admin (lib/levels.js).
function accessFor(access, email, env) {
  const person = ((access && access.people) || {})[email] || {};
  return { level: normalize((person.envs || {})[env] || 'read') };
}

// ---------- value comparison + display ----------

function asDateMidnight(v) {
  if (typeof v !== 'string' || v.length < 10 || (v.slice(0, 10).match(/-/g) || []).length !== 2) return null;
  const rest = v.slice(10);
  return ['', 'T00:00:00', 'T00:00:00Z', 'T00:00:00.000', 'T00:00:00.000Z', 'T00:00:00.0000000'].includes(rest) ? v.slice(0, 10) : null;
}

// Same rules as dataverse_write.py `_same`, plus GUID case and number-vs-numeric-string.
// Narrow on purpose: a different date, or the same date at a non-midnight time, differs.
function same(a, b) {
  // Dataverse stores and returns an empty text value as null, so "" and blank are the same value
  // (otherwise writing "" reads back as a mismatch, and "" -> blank looks like a change). 10/7/26.
  if (a === undefined || a === '') a = null;
  if (b === undefined || b === '') b = null;
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a);
    const y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.005;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return true;
    if (/^[0-9a-f-]{36}$/i.test(a) && a.toLowerCase() === b.toLowerCase()) return true;
    const da = asDateMidnight(a);
    return da !== null && da === asDateMidnight(b);
  }
  return a === b;
}

function money(n) {
  const v = Number(n);
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '-$' : '$') + s;
}

function clip(s, n = 120) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}... (${s.length} characters)` : s;
}

// ---------- columns ----------

function caseHint(navs, nav) {
  const hit = [...navs.keys()].find((k) => k.toLowerCase() === nav.toLowerCase());
  return hit ? ` (did you mean "${hit}@odata.bind"? navigation properties are case-sensitive)` : '';
}

function resolveColumns(table, job) {
  const errs = [];
  const columns = {};
  const byAttr = new Map();
  const write = job.mode === 'create' ? 'create' : 'update';
  for (const key of job.bodyKeys) {
    const m = BIND_KEY.exec(key);
    let col;
    if (m) {
      const nav = table.navs.get(m[1]);
      if (!nav) { errs.push(`"${key}": ${table.entity.plural} has no lookup "${m[1]}"${caseHint(table.navs, m[1])}`); continue; }
      const attr = table.attrs.get(nav.attr);
      col = { key, kind: 'lookup', attr: nav.attr, readKey: `_${nav.attr}_value`, referenced: nav.referenced, type: attr ? attr.type : 'Lookup', label: attr ? attr.label : nav.attr };
      if (attr && !attr[write]) errs.push(`"${col.label}" (${key}) cannot be set on ${write}`);
    } else {
      const attr = table.attrs.get(key);
      if (!attr) { errs.push(`"${key}": ${table.entity.plural} has no column by that name`); continue; }
      if (LOOKUP_TYPES.has(attr.type)) { errs.push(`"${key}" is a lookup; set it with "<NavigationProperty>@odata.bind"`); continue; }
      if (attr.attributeOf) { errs.push(`"${key}" is computed from ${attr.attributeOf} and cannot be written`); continue; }
      if (!attr[write]) { errs.push(`"${attr.label}" (${key}) cannot be set on ${write}`); continue; }
      col = { key, kind: 'plain', attr: key, readKey: key, type: attr.type, typeName: attr.typeName, label: attr.label };
    }
    if (byAttr.has(col.attr)) { errs.push(`"${key}" and "${byAttr.get(col.attr)}" both set ${col.label}`); continue; }
    byAttr.set(col.attr, key);
    columns[key] = col;
  }

  // verify: must include every column the job writes (an unverified column has no read-back
  // and no logged `before`, so it could not be reverted, R3). It may add more to watch.
  const verifyAttrs = job.verify ? [...job.verify] : [...byAttr.keys()];
  if (job.verify) {
    const missing = [...byAttr.keys()].filter((a) => !job.verify.includes(a));
    if (missing.length) errs.push(`"verify" leaves out written column(s) ${missing.join(', ')}; every written column is read back`);
  }
  const verify = [];
  for (const a of verifyAttrs) {
    const attr = table.attrs.get(a);
    if (!attr) { errs.push(`verify: ${table.entity.plural} has no column "${a}"`); continue; }
    if (!attr.read) { errs.push(`verify: "${a}" cannot be read back`); continue; }
    verify.push({ attr: a, readKey: LOOKUP_TYPES.has(attr.type) ? `_${a}_value` : a, label: attr.label });
  }

  if (job.amount_field) {
    const c = columns[job.amount_field];
    if (c && !NUMERIC.has(c.type)) errs.push(`"amount_field" ${job.amount_field} is not a number or currency column`);
  }
  return { columns, verify, errs };
}

// Choice values must be real options; the label map is kept for display.
function checkChoices(dv, table, job, columns) {
  const errs = [];
  for (const col of Object.values(columns)) {
    const attr = table.attrs.get(col.attr);
    if (!isChoice(attr)) continue;
    const labels = choiceLabels(dv, table, col.attr);
    col.choices = [...labels.entries()];
    job.rows.forEach((r) => {
      if (!(col.key in r.body)) return;
      const v = r.body[col.key];
      if (v === null) return;
      if (attr.type === 'Boolean') {
        if (typeof v !== 'boolean') errs.push(`${r.name}: ${col.label} must be true or false`);
        return;
      }
      const parts = attr.type === 'Virtual' ? String(v).split(',').map((s) => Number(s.trim())) : [v];
      for (const p of parts) if (!Number.isInteger(p) || !labels.has(p)) errs.push(`${r.name}: ${col.label} has no option ${p}`);
    });
  }
  return errs;
}

function choiceText(col, v) {
  if (v === null || v === undefined) return null;
  const map = new Map(col.choices || []);
  if (col.type === 'Virtual') return String(v).split(',').map((s) => map.get(Number(s.trim())) || s.trim()).join(', ');
  return map.has(v) ? map.get(v) : String(v);
}

function display(col, v, formatted) {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (formatted !== undefined && formatted !== null) return clip(formatted);
  if (col.choices) return choiceText(col, v);
  if (col.type === 'Money') return money(v);
  return clip(v);
}

// ---------- the plan ----------

function planJob(dv, job, { envs, access, warnRows }) {
  const envInfo = envs[job.env];
  const identity = whoAmI(dv);
  if (!identity.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, job.env), identity.email, job.env);
  if (!atLeast(acc.level, 'write')) {
    throw new PlanRefused([`${identity.fullname} (${identity.email}) has read access to the ${envInfo.name}, not write. Ask Dylan if this should change.`], 'access_read');
  }
  // The app's own definitions (flows, forms, views, connections, solutions, roles, users) are never a
  // records job, at any level (10/7 review): kind component / schema, which check what they must.
  if (APP_DEFINITION_SETS.has(job.table)) {
    throw new PlanRefused([`${job.table} holds the app's own definitions, not records. Change a view, form, sitemap or flow with an app change (kind "component"; tables and columns are kind "schema"), which takes develop access. Access, roles and users are changed in the admin portal.`], 'not_permitted');
  }
  // No cap on how many rows (ruled 10/7: "I dont think placing caps on writes makes sense"); a big change
  // is flagged by its severity instead, below.
  // Deletes are an admin's (ruled 10/7: "let admin do deletes of all").
  if (job.mode === 'delete' && !atLeast(acc.level, 'admin')) {
    throw new PlanRefused([`deleting records takes admin access in the ${envInfo.name}; ${identity.fullname} has ${acc.level}. Ask Dylan.`], 'not_permitted');
  }
  // The toolkit's own tables (who may write, the Write Log, the events) change only with admin access
  // (10/7): nobody's Claude grants itself access or edits the record of what it did.
  if (TOOLKIT_SETS.has(job.table) && !atLeast(acc.level, 'admin')) {
    throw new PlanRefused([`the toolkit's own tables (who may write, the Write Log, the events) are changed only by an admin of the toolkit in the ${envInfo.name}. Ask Dylan.`], 'not_permitted');
  }
  // The record of what happened is append-only for everyone, admins included: a log row is never edited
  // or deleted through the toolkit (access is revoked by deleting or editing a Write Access row instead).
  if (LOG_TABLES.has(job.table) && job.mode !== 'create') {
    throw new PlanRefused(['the Write Log and the event table are append-only: their rows are never changed or deleted through the toolkit (an event is closed with `resolve`).'], 'not_permitted');
  }

  const table = loadTable(dv, job.table);
  if (!table) throw new PlanRefused([`there is no table "${job.table}" in the ${envInfo.name}`], 'table_missing');
  // A delete plan is async (the linked-record inventory reads in parallel): planJob returns a Promise then.
  if (job.mode === 'delete') return planDelete(dv, job, { envInfo, table, identity, acc, warnRows });
  const { columns, verify, errs } = resolveColumns(table, job);
  if (errs.length) throw new PlanRefused(errs, 'invalid_job');
  const choiceErrs = checkChoices(dv, table, job, columns);
  if (choiceErrs.length) throw new PlanRefused(choiceErrs, 'invalid_job');

  const hasState = table.attrs.has('statecode');
  // The closed-year guard (DESIGN.md §8d): the book-date column of a guarded table, from envs.json.
  const guard = closedYear.guardFor(envInfo, job.table);
  if (guard && !table.attrs.has(guard)) throw new PlanRefused([`the closed-year guard names ${guard}, which ${table.entity.plural} does not have (envs.json)`], 'engine_bug');
  const readKeys = [...new Set([...verify.map((v) => v.readKey), ...(hasState ? ['statecode'] : []), table.entity.primaryName, guard].filter(Boolean))];
  const rows = [];
  const refused = [];
  const targetNames = new Map(); // "/set(guid)" -> display name | null when missing

  const lookupTarget = (col, bind) => {
    if (targetNames.has(bind)) return targetNames.get(bind);
    const [, set, guid] = BIND_VALUE.exec(bind);
    const ref = refTable(dv, table, col.referenced);
    let out;
    if (ref.set !== set) {
      out = { error: `${col.label} must point at ${ref.plural.toLowerCase()} (${ref.set}), not ${set}` };
    } else {
      try {
        const rec = dv.get(`${set}(${guid})?$select=${ref.primaryName}`);
        out = { id: guid.toLowerCase(), name: rec[ref.primaryName] || guid };
      } catch (e) {
        if (!(e instanceof DataverseError)) throw e;
        out = { error: `${col.label}: the linked ${ref.singular.toLowerCase()} ${guid} does not exist` };
      }
    }
    targetNames.set(bind, out);
    return out;
  };

  for (const r of job.rows) {
    const changes = [];
    let why = null;
    const warnings = r.warning ? [r.warning] : [];

    // Expected values in read-back form (lookups compare by GUID).
    const expected = {};
    for (const [key, v] of Object.entries(r.body)) {
      const col = columns[key];
      if (col.kind === 'lookup') {
        if (v === null) expected[key] = { value: null, text: '(blank)' };
        else {
          const t = lookupTarget(col, v);
          if (t.error) { why = t.error; break; }
          expected[key] = { value: t.id, text: t.name };
        }
      } else {
        expected[key] = { value: v, text: display(col, v) };
      }
    }

    let before = null;
    let recordName = null;
    if (!why && job.mode === 'update') {
      try {
        before = dv.get(`${table.entity.set}(${r.id})?$select=${readKeys.join(',')}`, { formatted: true });
      } catch (e) {
        if (!(e instanceof DataverseError)) throw e;
        why = `record ${r.id} was not found in ${table.entity.plural.toLowerCase()}`;
      }
      if (before && hasState && before.statecode !== 0) why = 'the record is inactive';
      // A closed-year gift is never modified, and an open one is never moved INTO a closed year.
      if (!why && before && guard && !closedYear.isOpen(before[guard])) why = `this record ${closedYear.why(before[guard])}`;
      if (!why && before && guard && guard in r.body && !closedYear.isOpen(r.body[guard])) why = `the new book date ${closedYear.why(r.body[guard])}`;
      if (before) {
        recordName = before[table.entity.primaryName] || null;
        if (recordName && recordName.trim().toLowerCase() !== r.name.toLowerCase()) {
          warnings.push(`the job calls this row "${r.name}", but the record is named "${recordName}"`);
        }
      }
    }
    if (!why && job.mode === 'create' && guard && !closedYear.isOpen(r.body[guard])) why = `the book date ${closedYear.why(r.body[guard])}`;
    if (!why && job.mode === 'create' && r.dup_filter) {
      try {
        const hits = dv.get(`${table.entity.set}?$top=1&$select=${table.entity.primaryId}&$filter=${encodeURIComponent(r.dup_filter)}`);
        if ((hits.value || []).length) why = 'already recorded (the duplicate check found a match)';
      } catch (e) {
        if (!(e instanceof DataverseError)) throw e;
        why = `the duplicate check could not run: ${e.message}`;
      }
    }

    if (!why) {
      for (const [key, exp] of Object.entries(expected)) {
        const col = columns[key];
        if (job.mode === 'update') {
          const old = before[col.readKey];
          if (same(old, exp.value)) continue;
          const fmt = before[`${col.readKey}@OData.Community.Display.V1.FormattedValue`];
          changes.push({ column: key, label: col.label, old, new: exp.value, old_text: display(col, old, fmt), new_text: exp.text });
        } else if (exp.value !== null) {
          changes.push({ column: key, label: col.label, new: exp.value, new_text: exp.text });
        }
      }
      if (job.mode === 'update' && changes.length === 0) why = 'already has these values (nothing to change)';
    }

    if (why) refused.push({ name: r.name, id: r.id, why });
    else {
      // Raw values only (annotations dropped): this is what apply re-checks and revert restores.
      const beforeKeep = before ? Object.fromEntries(Object.entries(before).filter(([k]) => !k.includes('@'))) : null;
      // dup_filter is kept so apply can run it again (someone may have keyed the record by hand since).
      rows.push({ name: r.name, record_name: recordName, id: r.id, body: r.body, before: beforeKeep, dup_filter: r.dup_filter, changes, warnings });
    }
  }

  if (!rows.length) throw new PlanRefused(['every row was refused:', ...refused.map((x) => `  ${x.name}: ${x.why}`)], 'every_row_refused');

  const amountTotal = job.amount_field
    ? rows.reduce((s, r) => s + Number(r.body[job.amount_field] || 0), 0)
    : null;

  return {
    contract: job.contract,
    kind: job.kind,
    env: job.env,
    host: envInfo.host,
    app: envInfo.name,
    table: job.table,
    mode: job.mode,
    source: job.source,
    reason: job.reason,
    intent: job.intent,
    identity,
    access: acc.level,
    cli_version: dv.cliVersion || null,
    labels: { singular: table.entity.singular, plural: table.entity.plural, primary_id: table.entity.primaryId },
    columns: Object.fromEntries(Object.entries(columns).map(([k, c]) => [k, { attr: c.attr, kind: c.kind, read_key: c.readKey, type: c.type, label: c.label }])),
    verify: verify.map((v) => ({ attr: v.attr, read_key: v.readKey, label: v.label })),
    amount_field: job.amount_field,
    amount_total: amountTotal === null ? null : Math.round(amountTotal * 100) / 100,
    closed_year_column: guard, // apply re-checks it: a plan made Nov 30 and applied Dec 1 is caught
    severity: rowsSeverity(job.mode, rows.length, table.entity, warnRows),
    rows,
    refused,
  };
}

function lowerNoun(label) {
  return String(label || '').split(' ').map((w) => (w.length > 1 && w.slice(1) === w.slice(1).toLowerCase() ? w[0].toLowerCase() + w.slice(1) : w)).join(' ');
}

// Records (DESIGN.md §10j): a create or update can be reverted, so only its size can make it serious;
// a delete cannot be taken back by the toolkit at all.
function rowsSeverity(mode, n, entity, warnRows) {
  const noun = lowerNoun(n === 1 ? entity.singular : entity.plural);
  const irreversible = mode === 'delete'
    ? [`deletes ${n} ${noun} for good (undo cannot bring ${n === 1 ? 'it' : 'them'} back; the last values are kept in the Write Log)`]
    : [];
  return severity.assess({ count: n, noun: lowerNoun(entity.plural), irreversible }, { warnRows });
}

// ---------- the admin delete (ruled 10/7: "let admin do deletes of all") ----------
//
// Each row names a record by id; the plan reads the WHOLE record as it stands (every column), which the
// log keeps, so what was deleted can be seen and keyed back by hand. The closed-year guard holds: a gift
// in a closed fiscal year is never deleted. Undo cannot bring a deleted record back (lib/revert.js).
async function planDelete(dv, job, { envInfo, table, identity, acc, warnRows }) {
  const guard = closedYear.guardFor(envInfo, job.table);
  const rows = [];
  const refused = [];
  for (const r of job.rows) {
    let rec;
    try {
      rec = dv.get(`${table.entity.set}(${r.id})`, { formatted: true });
    } catch (e) {
      if (!(e instanceof DataverseError)) throw e;
      refused.push({ name: r.name, id: r.id, why: `record ${r.id} was not found in ${table.entity.plural.toLowerCase()}` });
      continue;
    }
    if (guard && !closedYear.isOpen(rec[guard])) {
      refused.push({ name: r.name, id: r.id, why: `this record ${closedYear.why(rec[guard])}` });
      continue;
    }
    const recordName = rec[table.entity.primaryName] || null;
    const warnings = r.warning ? [r.warning] : [];
    if (recordName && recordName.trim().toLowerCase() !== r.name.toLowerCase()) {
      warnings.push(`the job calls this row "${r.name}", but the record is named "${recordName}"`);
    }
    const before = Object.fromEntries(Object.entries(rec).filter(([k]) => !k.includes('@')));
    rows.push({ name: r.name, record_name: recordName, id: r.id, body: null, before, changes: [], warnings });
  }
  // What the deletes do to OTHER records (lib/cascade.js): Restrict blocks a record (left out here, since
  // Dataverse would refuse it); Cascade and RemoveLink are shown, counted and logged with every id.
  const rels = cascade.deleteRelationships(dv, table.entity.logical);
  let inv = await cascade.inventory(dv, rels, rows.map((r) => r.id));
  const blocked = new Map();
  for (const c of Object.values(inv.found)) {
    if (c.action !== 'Restrict') continue;
    for (const [pid, kids] of Object.entries(c.by)) blocked.set(pid, `${kids.length} linked ${String(kids.length === 1 ? c.singular : c.label).toLowerCase()} block deleting it (Dataverse refuses while they exist)`);
  }
  const standing = rows.filter((r) => !blocked.has(r.id));
  for (const r of rows) if (blocked.has(r.id)) refused.push({ name: r.name, id: r.id, why: blocked.get(r.id) });
  if (!standing.length) throw new PlanRefused(['every row was refused:', ...refused.map((x) => `  ${x.name}: ${x.why}`)], 'every_row_refused');
  if (standing.length !== rows.length) inv = await cascade.inventory(dv, rels, standing.map((r) => r.id));
  for (const r of standing) r.cascade = cascade.forRecord(inv, r.id);
  return {
    contract: job.contract,
    kind: job.kind,
    env: job.env,
    host: envInfo.host,
    app: envInfo.name,
    table: job.table,
    mode: 'delete',
    source: job.source,
    reason: job.reason,
    intent: job.intent,
    identity,
    access: acc.level,
    cli_version: dv.cliVersion || null,
    labels: { singular: table.entity.singular, plural: table.entity.plural, primary_id: table.entity.primaryId },
    columns: {},
    verify: [],
    amount_field: null,
    amount_total: null,
    closed_year_column: guard,
    severity: deleteSeverity(standing.length, table.entity, inv, warnRows),
    typed: severity.typedPhrase(standing.map((r) => r.record_name || r.name || r.id)),
    cascade: { relationships: rels.length, key: cascade.inventoryKey(inv), unreadable: inv.unreadable },
    rows: standing,
    refused,
  };
}

// A delete's severity counts what it takes WITH it (DESIGN.md §10j, review 10/7).
function deleteSeverity(n, entity, inv, warnRows) {
  const noun = lowerNoun(n === 1 ? entity.singular : entity.plural);
  const gone = cascade.countsLine(inv, 'Cascade');
  const unlinked = cascade.countsLine(inv, 'RemoveLink');
  const irreversible = [`deletes ${n} ${noun} for good (undo cannot bring ${n === 1 ? 'it' : 'them'} back; the last values are kept in the Write Log)`];
  if (gone.total) irreversible.push(`also deletes the records linked to ${n === 1 ? 'it' : 'them'}: ${gone.text} (and anything those delete in turn)`);
  if (unlinked.total) irreversible.push(`unlinks ${unlinked.text}: they stay, with that link blank`);
  const dropped = cascade.countsLine(inv, 'Unlink');
  if (dropped.total) irreversible.push(`removes ${dropped.text} (the many-to-many associations go with ${n === 1 ? 'it' : 'them'})`);
  const unread = Object.keys(inv.unreadable);
  if (unread.length) irreversible.push(`${unread.length} kind(s) of linked record could not be checked (${unread.slice(0, 3).join(', ')}${unread.length > 3 ? ', ...' : ''}), so what they lose is not listed`);
  return severity.assess({ count: n + gone.total + unlinked.total + dropped.total, noun: 'records', irreversible }, { warnRows });
}

module.exports = { planJob, whoAmI, accessFor, same, display, money, deleteSeverity, PlanRefused };
