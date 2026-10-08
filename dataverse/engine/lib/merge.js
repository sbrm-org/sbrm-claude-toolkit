'use strict';
// Merges (DESIGN.md §8, ruled by Dylan 10/7/26). A merge is a TYPED verb, not a row write: Dataverse's
// native Merge action re-points every child the platform cascades and marks the duplicate merged into the
// kept record. The engine keeps its one rule: COMPUTE the effect from live reads, show it, re-check it at
// apply, verify it, log it.
//
//   plan   checks each pair, reads BOTH records in full, takes the child inventory (from the cascade-on-
//          merge relationship metadata, never a hand list), works out the fill-ins, counts closed-year
//          gifts that will change donor. Reads only.
//   apply  re-checks every pair and RE-TAKES the inventory (a pair whose children moved since the plan is
//          left out), shows the pop-up, then one Merge per pair, read back: duplicate merged into the kept
//          record and inactive, every inventoried child now on the kept record, the fill-ins landed.
//   log    the entry carries both records in full as they stood before (Dylan 10/7: "log how both
//          records were structured before the merge, just so we have a full path of it"), the inventory
//          and the fill-ins: what a worst-case rebuild needs. A merge cannot be fully undone (Dylan
//          accepted 10/7): `merged`/`masterid` are read-only in Dataverse.
//
// Rulings carried: children always shown, 500 children per approval as a ceiling (what one apply can
// carry, not an access rule; the per-person row cap is GONE, ruled 10/7 evening, and a merge always
// carries the "Can't be fully undone" severity line, §10j); merging needs a separate `merge` grant per
// person per environment (admin implies it); a merge may re-point closed-fiscal-year gifts (Dylan 10/7:
// attribution, not finances) and nothing else.

const { whoAmI, accessFor, same, PlanRefused } = require('./resolve');
const { resolveAccess } = require('./access');
const { atLeast } = require('./levels');
const severity = require('./severity');
const { loadTable, label } = require('./meta');
const { GUID } = require('./contract');
const { ApplyRefused } = require('./apply');
const closedYear = require('./closedyear');

const CONTRACT = 'sbrm-dv-job/1';
const CHILD_CEILING = 500;
const MAX_ENTRY = 900000; // characters; sbrm_entry holds 1,048,576. Over it, the plan refuses rather than log less.

// The two tables the donor app merges (392 merges to 10/7/26: 354 contacts, 38 accounts).
const MERGE_TABLES = {
  accounts: { logical: 'account', id: 'accountid', name: 'name', type: 'Microsoft.Dynamics.CRM.account' },
  contacts: { logical: 'contact', id: 'contactid', name: 'fullname', type: 'Microsoft.Dynamics.CRM.contact' },
};

// Children worth inventorying: the donor app's own tables plus the platform tables a donor record actually
// carries (from merge_accounts.py, proven on the 10/7 account merges). System bookkeeping tables (sharing,
// posts, async jobs, duplicate detection) are counted, named in the log, and not inventoried.
const CHILD_PREFIXES = ['msnfp_', 'sbrm_', 'cr695_'];
const CHILD_EXTRA = new Set(['contact', 'annotation', 'task', 'phonecall', 'email', 'appointment', 'letter', 'connection', 'account']);

const TOP_KEYS = new Set(['contract', 'kind', 'env', 'table', 'source', 'reason', 'intent', 'pairs']);
const PAIR_KEYS = new Set(['keep', 'duplicate', 'fill_blank', 'name_override']);
const IDENT = /^[a-z_][a-z0-9_]*$/;

// ---------- the job file (file level, pure) ----------

function validateMergeJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);
  const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!obj(raw)) return { errors: ['the job file must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be exactly "${CONTRACT}"`);
  if (raw.kind !== 'merge') err('"kind" must be "merge"');
  if (typeof raw.env !== 'string' || !Object.prototype.hasOwnProperty.call(envs, raw.env)) err(`"env" must be one of: ${Object.keys(envs).join(', ')}`);
  if (!Object.prototype.hasOwnProperty.call(MERGE_TABLES, raw.table)) err(`"table" must be one of: ${Object.keys(MERGE_TABLES).join(', ')} (the tables the donor app merges)`);
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > 500 || /[\r\n]/.test(raw.reason)) err('"reason" must be one line, at most 500 characters');
  const pairs = Array.isArray(raw.pairs) ? raw.pairs : null;
  if (!pairs || !pairs.length) err('"pairs" must be a non-empty list');
  const keeps = new Set();
  const dups = new Map();
  (pairs || []).forEach((p, i) => {
    const at = `pair ${i + 1}`;
    if (!obj(p)) return err(`${at} is not an object`);
    for (const k of Object.keys(p)) if (!PAIR_KEYS.has(k)) err(`${at}: unknown key "${k}"`);
    for (const side of ['keep', 'duplicate']) {
      const r = p[side];
      if (!obj(r) || typeof r.id !== 'string' || !GUID.test(r.id)) err(`${at}: "${side}.id" must be a record GUID`);
      if (!obj(r) || typeof r.name !== 'string' || !r.name.trim()) err(`${at}: "${side}.name" is required (the record's human name)`);
      if (obj(r)) for (const k of Object.keys(r)) if (!['id', 'name'].includes(k)) err(`${at}: unknown key "${side}.${k}"`);
    }
    if (obj(p.keep) && obj(p.duplicate) && typeof p.keep.id === 'string' && typeof p.duplicate.id === 'string') {
      const k = p.keep.id.toLowerCase();
      const d = p.duplicate.id.toLowerCase();
      if (k === d) err(`${at}: the kept record and the duplicate are the same record`);
      if (dups.has(d)) err(`${at}: duplicate ${d} is already merged by pair ${dups.get(d)}`);
      dups.set(d, i + 1);
      keeps.add(k);
    }
    if (p.fill_blank !== undefined && p.fill_blank !== null && (!Array.isArray(p.fill_blank) || p.fill_blank.some((c) => typeof c !== 'string' || !IDENT.test(c)))) {
      err(`${at}: "fill_blank" must be a list of column names`);
    }
    if (p.name_override !== undefined && p.name_override !== null && (typeof p.name_override !== 'string' || !p.name_override.trim())) {
      err(`${at}: "name_override" must say who confirmed it and why, or be null`);
    }
  });
  for (const k of keeps) if (dups.has(k)) err(`record ${k} is both kept and merged away in this job (no chains in one job)`);
  const intent = raw.intent;
  if (!obj(intent)) err('"intent" is required: {verb: "merge", pairs, table}');
  else if (pairs && !errors.length) {
    const mism = [];
    if (intent.verb !== 'merge') mism.push(`verb says "${intent.verb}"`);
    if (intent.pairs !== pairs.length) mism.push(`pairs says ${intent.pairs}, the file has ${pairs.length}`);
    if (intent.table !== raw.table) mism.push(`table says "${intent.table}", the file merges "${raw.table}"`);
    for (const k of Object.keys(intent)) if (!['verb', 'pairs', 'table'].includes(k)) mism.push(`unknown key "${k}"`);
    if (mism.length) err(`intent does not match the pairs (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  return {
    errors: [],
    job: {
      contract: CONTRACT, kind: 'merge', env: raw.env, table: raw.table, source: raw.source.trim(), reason: raw.reason.trim(), intent,
      pairs: pairs.map((p) => ({
        keep: { id: p.keep.id.toLowerCase(), name: p.keep.name.trim() },
        duplicate: { id: p.duplicate.id.toLowerCase(), name: p.duplicate.name.trim() },
        fill_blank: p.fill_blank || [],
        name_override: p.name_override ? p.name_override.trim() : null,
      })),
    },
  };
}

// ---------- names ----------

const SUFFIX = /\b(inc|incorporated|llc|llp|lp|ltd|co|corp|corporation|company|the|pc|pllc|dba)\b/g;

// Same rule as merge_accounts._key / same_company for accounts; contacts compare the plain name.
function nameKey(name, table) {
  let s = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ');
  if (table === 'accounts') s = s.replace(SUFFIX, ' ');
  return s.replace(/[^a-z0-9]/g, '');
}

function sameName(a, b, table) {
  const ka = nameKey(a, table);
  const kb = nameKey(b, table);
  return Boolean(ka && kb) && (ka === kb || ka.startsWith(kb) || kb.startsWith(ka));
}

// ---------- reads ----------

function raw(rec) {
  return Object.fromEntries(Object.entries(rec || {}).filter(([k]) => !k.includes('@')));
}

function blank(v) {
  return v === null || v === undefined || (typeof v === 'string' && !v.trim());
}

// The cascade-on-merge relationships worth inventorying, each with its child table's set, key, nav and label.
function childRelationships(dv, logical) {
  const rels = dv.get(`EntityDefinitions(LogicalName='${logical}')/OneToManyRelationships`
    + '?$select=SchemaName,ReferencingEntity,ReferencingAttribute,ReferencingEntityNavigationPropertyName,CascadeConfiguration').value || [];
  const cascade = rels.filter((r) => r.CascadeConfiguration && r.CascadeConfiguration.Merge === 'Cascade');
  const wanted = cascade.filter((r) => CHILD_PREFIXES.some((p) => r.ReferencingEntity.startsWith(p)) || CHILD_EXTRA.has(r.ReferencingEntity));
  // Each child table's set, key and label, 25 tables per query (one query per table took ~90 s live on
  // a contact's ~60 child tables, 10/7).
  const meta = new Map();
  const ents = [...new Set(wanted.map((r) => r.ReferencingEntity))];
  for (let i = 0; i < ents.length; i += 25) {
    const f = encodeURIComponent(ents.slice(i, i + 25).map((e) => `LogicalName eq '${e}'`).join(' or '));
    for (const e of dv.get(`EntityDefinitions?$select=LogicalName,EntitySetName,PrimaryIdAttribute,DisplayName,DisplayCollectionName&$filter=${f}`).value || []) {
      meta.set(e.LogicalName, { set: e.EntitySetName, primaryId: e.PrimaryIdAttribute, plural: label(e.DisplayCollectionName, e.EntitySetName), singular: label(e.DisplayName, e.LogicalName) });
    }
  }
  const missing = ents.filter((e) => !meta.has(e));
  if (missing.length) throw new PlanRefused([`could not read the metadata of child table(s) ${missing.join(', ')}`], 'dataverse_error');
  return {
    rels: wanted.map((r) => {
      const m = meta.get(r.ReferencingEntity);
      return { schema: r.SchemaName, entity: r.ReferencingEntity, attr: r.ReferencingAttribute, nav: r.ReferencingEntityNavigationPropertyName,
        set: m.set, pk: m.primaryId, label: m.plural, singular: m.singular };
    }),
    skipped: cascade.filter((r) => !wanted.includes(r)).map((r) => r.SchemaName).sort(),
  };
}

function nextPath(link) {
  return link ? '/' + link.split('/').slice(3).join('/') : null;
}

// { schema: { entity, set, pk, attr, nav, label, ids } } of every child pointing at `id`; unreadable kept apart.
async function takeInventory(dv, rels, id) {
  const first = await dv.getMany(rels.map((r) => `${r.set}?$select=${r.pk}&$filter=_${r.attr}_value eq ${id}`));
  const found = {};
  const unreadable = {};
  for (let i = 0; i < rels.length; i += 1) {
    const r = rels[i];
    const res = first[i];
    if (!res.ok) { unreadable[r.schema] = String(res.error.message).slice(0, 160); continue; }
    let ids = (res.value.value || []).map((row) => String(row[r.pk]).toLowerCase());
    let link = nextPath(res.value['@odata.nextLink']);
    while (link) {
      const [page] = await dv.getMany([link]);
      if (!page.ok) { unreadable[r.schema] = String(page.error.message).slice(0, 160); break; }
      ids = ids.concat((page.value.value || []).map((row) => String(row[r.pk]).toLowerCase()));
      link = nextPath(page.value['@odata.nextLink']);
    }
    if (ids.length) found[r.schema] = { entity: r.entity, set: r.set, pk: r.pk, attr: r.attr, nav: r.nav, label: r.label, singular: r.singular, ids: ids.sort() };
  }
  return { found, unreadable };
}

function inventoryKey(inv) {
  return JSON.stringify(Object.keys(inv).sort().map((k) => [k, inv[k].ids]));
}

function childCount(inv) {
  return Object.values(inv).reduce((n, c) => n + c.ids.length, 0);
}

// Closed-year gifts among the children (they change donor; amount, date and GL do not).
function closedYearChildren(dv, envInfo, inv, today = new Date()) {
  let n = 0;
  for (const c of Object.values(inv)) {
    const col = closedYear.guardFor(envInfo, c.set);
    if (!col) continue;
    for (let i = 0; i < c.ids.length; i += 50) {
      const chunk = c.ids.slice(i, i + 50);
      const f = encodeURIComponent(chunk.map((x) => `${c.pk} eq ${x}`).join(' or '));
      for (const row of dv.get(`${c.set}?$select=${col}&$filter=${f}`).value || []) if (!closedYear.isOpen(row[col], today)) n += 1;
    }
  }
  return n;
}

function localDate(d = new Date()) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// The values Merge writes onto the kept record: blanks filled from the duplicate, plus the stamp line.
function fillIns(T, keep, dup, fillBlank, who, when) {
  const content = {};
  for (const c of fillBlank) if (blank(keep[c]) && !blank(dup[c])) content[c] = dup[c];
  const stamp = `Merged duplicate '${dup[T.name]}' (created ${String(dup.createdon || '').slice(0, 10)}) into this record on ${when} with Claude AI (${who}).`;
  content.description = `${String(keep.description || '').trimEnd()}\n${stamp}`.trim();
  return content;
}

// ---------- plan ----------

// Merging is its own grant (May Merge, ruled 10/7, §8f): an admin always may; a writer or developer only
// with the flag on their row in that environment (develop does NOT imply it: building the app is not a
// data decision about donors, DESIGN.md §10a).
function mergeAccess(access, email, env, dv = null) {
  access = resolveAccess(access, dv, env);
  const acc = accessFor(access, email, env);
  const person = (access.people || {})[email] || {};
  const granted = atLeast(acc.level, 'admin') || (atLeast(acc.level, 'write') && ((person.merge || {})[env] === true));
  return { ...acc, merge: granted };
}

// A merge always carries the "Can't be fully undone" line (§8e, §10j): undo brings the duplicate back and
// moves the listed records back, but records in system tables stay on the kept record.
function mergeSeverity(n, warnRows) {
  return severity.assess({
    count: n, noun: 'merges',
    irreversible: [`${n === 1 ? 'this merge moves' : 'these merges move'} linked records onto the kept record; undo moves the listed ones back, but records in system tables stay`],
  }, { warnRows });
}

async function planMerge(dv, job, { envs, access, warnRows, now = new Date() }) {
  const envInfo = envs[job.env];
  const T = MERGE_TABLES[job.table];
  const identity = whoAmI(dv);
  const acc = mergeAccess(access, identity.email, job.env, dv);
  if (!acc.merge) throw new PlanRefused([`${identity.fullname} has no merge grant in the ${envInfo.name}. Merging is granted separately from write access (ruled 10/7); ask Dylan.`], 'not_permitted');
  // No cap on pairs (ruled 10/7); severity below. CHILD_CEILING and the log-size ceiling stay: they are
  // what one apply can carry and log in full, not access rules.

  const table = loadTable(dv, job.table);
  const bad = [];
  for (const p of job.pairs) for (const c of p.fill_blank) {
    const a = table.attrs.get(c);
    if (!a) bad.push(`fill_blank: ${table.entity.plural} has no column "${c}"`);
    else if (!a.update || !a.read) bad.push(`fill_blank: "${a.label}" (${c}) cannot be read and written`);
  }
  if (bad.length) throw new PlanRefused([...new Set(bad)], 'invalid_job');
  const { rels, skipped } = childRelationships(dv, T.logical);

  const keepState = new Map(); // a kept record AS EARLIER MERGES IN THIS JOB WILL LEAVE IT
  const pairs = [];
  const refused = [];
  for (const p of job.pairs) {
    const label = `${p.duplicate.name} into ${p.keep.name}`;
    let keepRec;
    let dupRec;
    try {
      keepRec = keepState.get(p.keep.id) || raw(dv.get(`${job.table}(${p.keep.id})`));
      dupRec = raw(dv.get(`${job.table}(${p.duplicate.id})`));
    } catch (e) {
      refused.push({ name: label, id: p.duplicate.id, why: `a record could not be read: ${e.message.slice(0, 160)}` });
      continue;
    }
    let why = null;
    if (keepRec.statecode !== 0 || keepRec.merged) why = `the kept record '${keepRec[T.name]}' is not active, or is itself merged`;
    else if (dupRec.statecode !== 0 || dupRec.merged) why = `the duplicate '${dupRec[T.name]}' is not active, or is already merged`;
    else if (!sameName(keepRec[T.name], dupRec[T.name], job.table) && !p.name_override) {
      why = `the names do not look like the same ${T.logical}: '${keepRec[T.name]}' and '${dupRec[T.name]}' (add name_override saying who confirmed it)`;
    }
    if (why) { refused.push({ name: label, id: p.duplicate.id, why }); continue; }
    const inv = await takeInventory(dv, rels, p.duplicate.id);
    const content = fillIns(T, keepRec, dupRec, p.fill_blank, identity.fullname, localDate(now));
    const keepBefore = { ...keepRec };
    keepState.set(p.keep.id, { ...keepRec, ...content });
    pairs.push({
      keep_id: p.keep.id, duplicate_id: p.duplicate.id,
      keep_name: keepRec[T.name], duplicate_name: dupRec[T.name],
      keep_created: keepRec.createdon || null, duplicate_created: dupRec.createdon || null,
      name_override: p.name_override, fill_blank: p.fill_blank,
      keep_before: keepBefore, duplicate_before: dupRec,
      inventory: inv.found, unreadable: inv.unreadable,
      children: childCount(inv.found),
      closed_year_children: closedYearChildren(dv, envInfo, inv.found, now),
      content,
      fill_labels: Object.keys(content).filter((c) => c !== 'description').map((c) => table.attrs.get(c).label),
    });
  }
  if (!pairs.length) throw new PlanRefused(['every pair was refused:', ...refused.map((x) => `  ${x.name}: ${x.why}`)], 'every_row_refused');
  const total = pairs.reduce((n, p) => n + p.children, 0);
  if (total > CHILD_CEILING) throw new PlanRefused([`these merges move ${total} records, over the ceiling of ${CHILD_CEILING} per approval. Split the job.`], 'too_big');

  const plan = {
    contract: job.contract, kind: 'merge', env: job.env, host: envInfo.host, app: envInfo.name, table: job.table,
    mode: 'merge', source: job.source, reason: job.reason, intent: job.intent, identity, access: acc.level,
    cli_version: dv.cliVersion || null,
    labels: { singular: table.entity.singular, plural: table.entity.plural, primary_id: T.id, primary_name: T.name, odata_type: T.type },
    relationships_inventoried: rels.length, relationships_skipped: skipped,
    severity: mergeSeverity(pairs.length, warnRows),
    pairs, refused,
  };
  if (JSON.stringify(plan).length > MAX_ENTRY) {
    throw new PlanRefused([`this merge's full record of both records and their children is too big to log in one entry. Split the job (the log never keeps less, ruled 10/7).`], 'too_big');
  }
  return plan;
}

// ---------- the pop-up ----------

function noun(label, n) {
  const w = String(label || '');
  return n === 1 ? w.toLowerCase() : w.toLowerCase();
}

function mergeHeadline(plan) {
  const keeps = new Set(plan.pairs.map((p) => p.keep_id)).size;
  const n = plan.pairs.length;
  return `Merge ${n} duplicate ${noun(n === 1 ? plan.labels.singular : plan.labels.plural, n)} into ${keeps} in the ${plan.app}`;
}

// "1 contact, 2 transactions": singular when one (the 10/7 live test read "1 contacts").
function movesLine(pairs) {
  const by = new Map();
  for (const p of pairs) {
    for (const c of Object.values(p.inventory)) {
      const e = by.get(c.label) || { n: 0, singular: c.singular || c.label };
      e.n += c.ids.length;
      by.set(c.label, e);
    }
  }
  return by.size ? [...by].map(([l, e]) => `${e.n} ${String(e.n === 1 ? e.singular : l).toLowerCase()}`).join(', ') : 'no linked records';
}

function mergeSummary(plan) {
  const out = [...severity.block(plan.severity), mergeHeadline(plan), ''];
  const groups = new Map();
  for (const p of plan.pairs) {
    if (!groups.has(p.keep_id)) groups.set(p.keep_id, []);
    groups.get(p.keep_id).push(p);
  }
  for (const ps of groups.values()) {
    const k = ps[0];
    out.push(`  ${k.keep_name}${k.keep_created ? ` (${String(k.keep_created).slice(0, 4)})` : ''}  <-  ${ps.length} duplicate${ps.length === 1 ? '' : 's'}`);
    out.push(`    moves ${movesLine(ps)}`);
    const fills = [...new Set(ps.flatMap((p) => p.fill_labels))];
    if (fills.length) out.push(`    fills blank on the kept record: ${fills.join(', ')}`);
    const overrides = ps.filter((p) => p.name_override).map((p) => `'${p.duplicate_name}' (${p.name_override})`);
    if (overrides.length) out.push(`    names differ, confirmed: ${overrides.join('; ')}`);
  }
  const closed = plan.pairs.reduce((n, p) => n + p.closed_year_children, 0);
  if (closed) out.push('', `  ${closed} of the moved gifts are in closed fiscal years: their donor changes; amount, date and GL do not.`);
  const unread = [...new Set(plan.pairs.flatMap((p) => Object.keys(p.unreadable)))];
  if (unread.length) out.push('', `  Could not be read, so not listed (the merge still moves them): ${unread.join(', ')}`);
  out.push('', '  Can be undone with revert: the duplicate comes back and the records listed here move back.', '  Records in system tables are not listed and would stay on the kept record.');
  if (plan.refused.length) {
    out.push('', `Left out, will NOT be merged (${plan.refused.length}):`);
    for (const x of plan.refused.slice(0, 5)) out.push(`  ${x.name}: ${x.why}`);
  }
  out.push('', `Reason given: ${plan.reason}`);
  return out.join('\n');
}

function mergeDetail(plan, { id } = {}) {
  const out = [mergeHeadline(plan), '', `Requested by: ${plan.identity.fullname} (${plan.identity.email})`, `Reason given: ${plan.reason}`, `Made by: ${plan.source}`];
  if (id) out.push(`Plan: ${id}`);
  out.push('');
  plan.pairs.forEach((p, i) => {
    out.push(`${i + 1}. ${p.duplicate_name} (${p.duplicate_id}) into ${p.keep_name} (${p.keep_id})`);
    for (const c of Object.values(p.inventory)) out.push(`     ${c.label}: ${c.ids.length}`);
    for (const [c, v] of Object.entries(p.content)) if (c !== 'description') out.push(`     fills ${c}: ${v}`);
    out.push(`     adds to Description: ${p.content.description.split('\n').pop()}`);
    if (p.name_override) out.push(`     ! names differ, confirmed: ${p.name_override}`);
  });
  out.push('', `Relationships checked: ${plan.relationships_inventoried} (system tables not listed: ${plan.relationships_skipped.length})`);
  if (plan.refused.length) { out.push('', 'Left out, will NOT be merged:'); for (const x of plan.refused) out.push(`  - ${x.name}: ${x.why}`); }
  return out.join('\n');
}

// ---------- apply ----------

const MAX_AGE_MS = 24 * 3600 * 1000;

// Re-check one pair against live data before anything is written. null = still stands, else why.
async function recheckPair(dv, plan, p, rels, firstForKeep) {
  let keep;
  let dup;
  try {
    keep = raw(dv.get(`${plan.table}(${p.keep_id})`));
    dup = raw(dv.get(`${plan.table}(${p.duplicate_id})`));
  } catch (e) {
    return `a record could not be read: ${e.message.slice(0, 160)}`;
  }
  if (keep.statecode !== 0 || keep.merged) return 'the kept record is no longer active, or has been merged';
  if (dup.statecode !== 0 || dup.merged) return 'the duplicate is no longer active, or has already been merged';
  // The fill-ins were worked out against the kept record as it was; if those fields moved, they are stale.
  if (firstForKeep) {
    const moved = [...p.fill_blank, 'description'].filter((c) => !same(p.keep_before[c], keep[c]));
    if (moved.length) return `the kept record changed since the plan (${moved.join(', ')})`;
  }
  const inv = await takeInventory(dv, rels, p.duplicate_id);
  if (inventoryKey(inv.found) !== inventoryKey(p.inventory)) {
    return `the duplicate's linked records changed since the plan (${childCount(p.inventory)} then, ${childCount(inv.found)} now), so the pop-up would not show what moves`;
  }
  return null;
}

async function readBack(dv, plan, p) {
  const bad = [];
  const dup = raw(dv.get(`${plan.table}(${p.duplicate_id})?$select=merged,_masterid_value,statecode`));
  if (dup.merged !== true || String(dup._masterid_value || '').toLowerCase() !== p.keep_id || dup.statecode !== 1) {
    bad.push(`duplicate not marked merged into the kept record (merged=${dup.merged}, masterid=${dup._masterid_value}, statecode=${dup.statecode})`);
  }
  const rels = Object.values(p.inventory);
  const pages = await dv.getMany(rels.map((c) => `${c.set}?$select=${c.pk}&$filter=_${c.attr}_value eq ${p.keep_id}`));
  rels.forEach((c, i) => {
    if (!pages[i].ok) { bad.push(`${c.label}: could not read back (${pages[i].error.message.slice(0, 80)})`); return; }
    const now = new Set((pages[i].value.value || []).map((r) => String(r[c.pk]).toLowerCase()));
    const stuck = c.ids.filter((x) => !now.has(x));
    // A child count over one page is read back by its own query below rather than trusted.
    for (const x of stuck.slice(0, 50)) {
      try {
        const row = dv.get(`${c.set}(${x})?$select=_${c.attr}_value`);
        if (String(row[`_${c.attr}_value`] || '').toLowerCase() === p.keep_id) stuck.splice(stuck.indexOf(x), 1);
      } catch { /* stays stuck */ }
    }
    if (stuck.length) bad.push(`${c.label}: ${stuck.length} not moved`);
  });
  const keepNow = raw(dv.get(`${plan.table}(${p.keep_id})?$select=${Object.keys(p.content).join(',')}`));
  const missed = Object.keys(p.content).filter((c) => !same(keepNow[c], p.content[c]));
  if (missed.length) bad.push(`fill-ins did not land: ${missed.join(', ')}`);
  return bad;
}

async function applyMerge(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date() } = deps;
  if (now - new Date(plan.created) > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old. Make a new plan.', 'stale_plan');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = mergeAccess(access, me.email, plan.env, dv);
  if (!acc.merge) throw new ApplyRefused(`your merge grant in the ${plan.app} has been removed.`, 'access_revoked');

  const { rels } = childRelationships(dv, MERGE_TABLES[plan.table].logical);
  const standing = [];
  const moved = [];
  const seenKeep = new Set();
  for (const p of plan.pairs) {
    const why = await recheckPair(dv, plan, p, rels, !seenKeep.has(p.keep_id));
    seenKeep.add(p.keep_id);
    if (why) moved.push({ name: `${p.duplicate_name} into ${p.keep_name}`, id: p.duplicate_id, why });
    else standing.push(p);
  }
  const view = { ...plan, pairs: standing, refused: [...plan.refused, ...moved] };
  if (!standing.length) {
    fs.rmSync(file, { force: true });
    throw new ApplyRefused(['every pair changed since the plan, nothing to merge:', ...moved.map((m) => `  ${m.name}: ${m.why}`)].join('\n'), 'every_row_moved');
  }
  if (plan.severity) {
    view.severity = mergeSeverity(standing.length, plan.severity.warn_rows);
    if (severity.grew(plan.severity, view.severity)) throw new ApplyRefused('these merges are bigger now than when they were planned. Make a new plan.', 'severity_grew');
  }
  const answer = confirm({ summaryText: mergeSummary(view), detailText: mergeDetail(view, { id }), title: `SBRM: approve these merges in the ${plan.app}?` });
  const base = {
    time: now.toISOString(), plan_id: id, person: me, env: plan.env, app: plan.app, table: plan.table, mode: 'merge',
    source: plan.source, reason: plan.reason, approval: 'dialog', left_out: view.refused, headline: mergeHeadline(view),
  };
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv };

  const rows = [];
  for (const p of standing) {
    const T = plan.labels;
    const out = {
      name: `${p.duplicate_name} into ${p.keep_name}`, id: p.duplicate_id, keep_id: p.keep_id,
      keep_before: p.keep_before, duplicate_before: p.duplicate_before, inventory: p.inventory, unreadable: p.unreadable,
      content: p.content, children: p.children, closed_year_children: p.closed_year_children, name_override: p.name_override, changes: [],
    };
    try {
      dv.merge({
        Target: { '@odata.type': T.odata_type, [T.primary_id]: p.keep_id },
        Subordinate: { '@odata.type': T.odata_type, [T.primary_id]: p.duplicate_id },
        UpdateContent: { '@odata.type': T.odata_type, ...p.content },
        PerformParentingChecks: false,
      });
      const bad = await readBack(dv, plan, p);
      out.outcome = bad.length ? `read-back mismatch: ${bad.join('; ')}` : 'written';
    } catch (e) {
      out.outcome = `failed: ${e.message}`;
    }
    rows.push(out);
  }
  fs.rmSync(file, { force: true });
  const written = rows.filter((r) => r.outcome === 'written').length;
  return { entry: { ...base, outcome: written === rows.length ? 'applied' : 'applied with problems', rows }, outcome: written === rows.length ? 'applied' : 'applied with problems', person: me, dv, written, rows, left_out: view.refused };
}

// ---------- undo (the rebuild, DESIGN.md §8c + §8f) ----------
//
// CORRECTED 10/7 by the first live undo (F&E Dev, accounts): `merged` and `masterid` are read-only to
// the API, but REACTIVATING a merged record makes Dataverse clear both itself, so the duplicate comes back
// un-merged. (The 10/7 morning claim "cannot be fully undone" came from metadata, not a test.) What the
// undo puts back, from the merge's Write Log entry:
//   1. the duplicate is reactivated (statecode 0 + the table's first active status);
//   2. every inventoried child STILL on the kept record is moved back to the duplicate; a child moved
//      since the merge is left out (someone moved it on purpose);
//   3. the fields the merge filled on the kept record go back to their before values, if they still hold
//      what the merge wrote (else left out: someone edited them since).
// Closed-year gifts may be moved back, the same exception as the merge (attribution, not finances;
// extended to the undo by inference, 10/7, flagged to Dylan). Same grant as merging.

function statusFor(dv, logical, state) {
  const r = dv.get(`EntityDefinitions(LogicalName='${logical}')/Attributes(LogicalName='statuscode')`
    + '/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)');
  const hit = ((r.OptionSet && r.OptionSet.Options) || []).find((o) => o.State === state);
  return hit ? hit.Value : null;
}

async function planUnmerge(dv, entry, { envs, access }) {
  if (!entry || entry.mode !== 'merge') throw new PlanRefused(['that plan is not a merge'], 'nothing_to_undo');
  if (!['applied', 'applied with problems'].includes(entry.outcome)) throw new PlanRefused([`that merge's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  const envInfo = envs[entry.env];
  const T = MERGE_TABLES[entry.table];
  const identity = whoAmI(dv);
  const acc = mergeAccess(access, identity.email, entry.env, dv);
  if (!acc.merge) throw new PlanRefused([`${identity.fullname} has no merge grant in the ${envInfo.name}; undoing a merge needs the same grant (ask Dylan).`], 'not_permitted');
  const active = statusFor(dv, T.logical, 0);
  if (active === null) throw new PlanRefused([`${entry.table} has no active status to restore`], 'engine_bug');
  const table = loadTable(dv, entry.table);
  const labelOf = (c) => ((table && table.attrs.get(c)) || {}).label || c;

  const pairs = [];
  const refused = [];
  for (const r of entry.rows.filter((x) => x.outcome === 'written')) {
    const dup = raw(dv.get(`${entry.table}(${r.id})?$select=statecode,merged,_masterid_value,${T.name}`));
    const keep = raw(dv.get(`${entry.table}(${r.keep_id})?$select=${[...Object.keys(r.content), T.name, 'statecode'].join(',')}`));
    // Children: still on the kept record -> moved back; anywhere else -> left out.
    const kids = Object.values(r.inventory || {}).flatMap((c) => c.ids.map((id) => ({ ...c, id })));
    const now = await dv.getMany(kids.map((k) => `${k.set}(${k.id})?$select=_${k.attr}_value`));
    const back = [];
    const leftKids = [];
    kids.forEach((k, i) => {
      const at = now[i].ok ? String(now[i].value[`_${k.attr}_value`] || '').toLowerCase() : null;
      const one = { set: k.set, attr: k.attr, nav: k.nav, label: k.label, singular: k.singular || k.label, id: k.id };
      if (at === r.keep_id) back.push(one);
      else leftKids.push({ ...one, why: now[i].ok ? 'moved since the merge, so it is left where it is' : 'could not be read' });
    });
    // The kept record's filled fields: restore only those still holding what the merge wrote.
    const restore = {};
    const kept = [];
    for (const [c, v] of Object.entries(r.content)) {
      if (same(keep[c], v)) restore[c] = r.keep_before[c] === undefined ? null : r.keep_before[c];
      else kept.push(c);
    }
    if (!back.length && !Object.keys(restore).length && dup.statecode === 0) {
      refused.push({ name: r.name, id: r.id, why: 'nothing left to put back (already undone, or changed since)' });
      continue;
    }
    pairs.push({
      keep_id: r.keep_id, duplicate_id: r.id, keep_name: keep[T.name], duplicate_name: dup[T.name],
      reactivate: dup.statecode === 0 ? null : { statecode: 0, statuscode: active },
      children: back, children_left: leftKids, restore, restore_now: Object.fromEntries(Object.keys(restore).map((c) => [c, keep[c] === undefined ? null : keep[c]])),
      fields_left: kept,
      labels: Object.fromEntries([...Object.keys(restore), ...kept].map((c) => [c, labelOf(c)])),
    });
  }
  if (!pairs.length) throw new PlanRefused(['nothing to undo:', ...refused.map((x) => `  ${x.name}: ${x.why}`)], 'nothing_to_undo');
  const total = pairs.reduce((n, p) => n + p.children.length, 0);
  if (total > CHILD_CEILING) throw new PlanRefused([`this undo moves ${total} records back, over the ceiling of ${CHILD_CEILING} per approval`], 'too_big');
  return {
    contract: CONTRACT, kind: 'unmerge', env: entry.env, host: envInfo.host, app: envInfo.name, table: entry.table, mode: 'unmerge',
    source: `revert ${entry.plan_id}`, reason: `Undo merge plan ${entry.plan_id} ("${entry.headline}", by ${entry.person ? entry.person.fullname : 'unknown'}).`.slice(0, 500),
    identity, access: acc.level, reverts_plan_id: entry.plan_id,
    labels: { singular: T.logical, primary_id: T.id, primary_name: T.name },
    pairs, refused,
  };
}

function unmergeSummary(plan) {
  const n = plan.pairs.length;
  const out = [`Undo ${n} merge${n === 1 ? '' : 's'} in the ${plan.app}`, ''];
  for (const p of plan.pairs) {
    out.push(`  ${p.duplicate_name}  <-  back out of ${p.keep_name}`);
    if (p.reactivate) out.push('    reactivates it');
    if (p.children.length) out.push(`    moves back ${movesLine([{ inventory: groupKids(p.children) }])}`);
    const lab = (c) => (p.labels && p.labels[c]) || c;
    const fields = Object.keys(p.restore);
    if (fields.length) out.push(`    restores on ${p.keep_name}: ${fields.map(lab).join(', ')}`);
    if (p.children_left.length) out.push(`    leaves ${p.children_left.length} record(s) where they are (moved since the merge)`);
    if (p.fields_left.length) out.push(`    leaves ${p.fields_left.map(lab).join(', ')} as is (edited since the merge)`);
  }
  out.push('', '  Reactivating the duplicate also clears its merged mark (Dataverse does that itself).', '  Records in system tables that the merge moved are not moved back.', '', `Reason given: ${plan.reason}`);
  if (plan.refused.length) { out.push('', 'Left out:'); for (const x of plan.refused) out.push(`  ${x.name}: ${x.why}`); }
  return out.join('\n');
}

function groupKids(kids) {
  const g = {};
  for (const k of kids) {
    g[k.label] = g[k.label] || { label: k.label, singular: k.singular, ids: [] };
    g[k.label].ids.push(k.id);
  }
  return g;
}

async function applyUnmerge(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date() } = deps;
  if (now - new Date(plan.created) > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old. Make a new plan.', 'stale_plan');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  if (!mergeAccess(access, me.email, plan.env, dv).merge) throw new ApplyRefused(`your merge grant in the ${plan.app} has been removed.`, 'access_revoked');

  // Re-check every step against live data and take each version tag for If-Match.
  const steps = [];
  const leftOut = [];
  for (const p of plan.pairs) {
    if (p.reactivate) {
      const d = dv.get(`${plan.table}(${p.duplicate_id})?$select=statecode`);
      if (d.statecode === 0) leftOut.push({ name: p.duplicate_name, id: p.duplicate_id, why: 'already active' });
      else steps.push({ kind: 'reactivate', p, set: plan.table, id: p.duplicate_id, body: p.reactivate, etag: d['@odata.etag'] });
    }
    for (const k of p.children) {
      let c;
      try { c = dv.get(`${k.set}(${k.id})?$select=_${k.attr}_value`); } catch { leftOut.push({ name: k.label, id: k.id, why: 'no longer exists' }); continue; }
      if (String(c[`_${k.attr}_value`] || '').toLowerCase() !== p.keep_id) leftOut.push({ name: k.singular, id: k.id, why: 'moved since the plan' });
      else steps.push({ kind: 'child', p, k, set: k.set, id: k.id, body: { [`${k.nav}@odata.bind`]: `/${plan.table}(${p.duplicate_id})` }, etag: c['@odata.etag'] });
    }
    if (Object.keys(p.restore).length) {
      const keep = dv.get(`${plan.table}(${p.keep_id})?$select=${Object.keys(p.restore).join(',')}`);
      const moved = Object.keys(p.restore).filter((c) => !same(keep[c], p.restore_now[c]));
      if (moved.length) leftOut.push({ name: p.keep_name, id: p.keep_id, why: `edited since the plan (${moved.join(', ')})` });
      else steps.push({ kind: 'restore', p, set: plan.table, id: p.keep_id, body: p.restore, etag: keep['@odata.etag'] });
    }
  }
  if (!steps.length) {
    fs.rmSync(file, { force: true });
    throw new ApplyRefused(['everything changed since the plan, nothing to undo:', ...leftOut.map((m) => `  ${m.name}: ${m.why}`)].join('\n'), 'every_row_moved');
  }
  const view = { ...plan, refused: [...plan.refused, ...leftOut] };
  const answer = confirm({ summaryText: unmergeSummary(view), detailText: unmergeSummary(view), title: `SBRM: undo these merges in the ${plan.app}?` });
  const base = {
    time: now.toISOString(), plan_id: id, person: me, env: plan.env, app: plan.app, table: plan.table, mode: 'unmerge',
    source: plan.source, reason: plan.reason, approval: 'dialog', left_out: view.refused, headline: unmergeSummary(view).split('\n')[0],
    reverts_plan_id: plan.reverts_plan_id,
  };
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: view.refused };

  // Order: the duplicate first (so children point at an active record), then the children, then the kept record.
  const order = { reactivate: 0, child: 1, restore: 2 };
  const rows = [];
  for (const s of steps.sort((a, b) => order[a.kind] - order[b.kind])) {
    const name = s.kind === 'child' ? `${s.k.singular} back to ${s.p.duplicate_name}` : s.kind === 'reactivate' ? `reactivate ${s.p.duplicate_name}` : `restore fields on ${s.p.keep_name}`;
    const out = { name, id: s.id, step: s.kind, set: s.set, body: s.body };
    try {
      dv.update(s.set, s.id, s.body, s.etag);
      const cols = s.kind === 'child' ? [`_${s.k.attr}_value`] : Object.keys(s.body);
      const backRow = dv.get(`${s.set}(${s.id})?$select=${cols.join(',')}`);
      const ok = s.kind === 'child'
        ? String(backRow[`_${s.k.attr}_value`] || '').toLowerCase() === s.p.duplicate_id
        : Object.entries(s.body).every(([c, v]) => same(backRow[c], v));
      out.outcome = ok ? 'written' : 'read-back mismatch';
    } catch (e) {
      out.outcome = `failed: ${e.message}`;
    }
    rows.push(out);
  }
  fs.rmSync(file, { force: true });
  const written = rows.filter((r) => r.outcome === 'written').length;
  const outcome = written === rows.length ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows }, outcome, person: me, dv, written, rows, left_out: view.refused };
}

module.exports = {
  validateMergeJob, planMerge, applyMerge, mergeSummary, mergeDetail, mergeHeadline, sameName, nameKey,
  takeInventory, childRelationships, fillIns, mergeAccess, MERGE_TABLES, CHILD_CEILING,
  planUnmerge, applyUnmerge, unmergeSummary,
};

