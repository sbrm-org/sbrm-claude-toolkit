'use strict';
// What deleting a record does to OTHER records (found by the 10/7 blind review: a contact in the donor app
// has ~75 relationships whose Delete behaviour reaches child rows, and the first build showed and logged only
// the record itself). Read from the relationship metadata, never a hand list. READS ONLY.
//
//   Cascade    the linked records are deleted too          -> shown, counted, ids logged
//   RemoveLink the linked records stay, their lookup blanks -> shown, counted, ids logged (a gift loses its donor)
//   Restrict   Dataverse refuses the delete while any exist -> the record is left out at plan, with why
//   Unlink     a many-to-many association is dropped        -> shown, counted (10/7 re-verify)
//
// Grandchildren (what the deleted children cascade to in turn) are not walked; the pop-up says so.
//
// The reads run in PARALLEL (the CLI's getMany): live on 10/7 one Donor App Dev contact's inventory took
// 10 min 23 s one query at a time. Metadata is read in batches of 25 tables per query, as merges do.

const { label } = require('./meta');
const { DataverseError } = require('./cli');

const ACTIONS = new Set(['Cascade', 'RemoveLink', 'Restrict']);
const CHUNK = 15; // records per OR filter (URL length)
const PAGE_CEILING = 50; // pages of 5,000 per relationship before giving up and saying so
const PARALLEL = 16;

function tableMeta(dv, names) {
  const meta = new Map();
  const ents = [...new Set(names)];
  for (let i = 0; i < ents.length; i += 25) {
    const f = encodeURIComponent(ents.slice(i, i + 25).map((e) => `LogicalName eq '${e}'`).join(' or '));
    for (const e of dv.get(`EntityDefinitions?$select=LogicalName,EntitySetName,PrimaryIdAttribute,DisplayName,DisplayCollectionName&$filter=${f}`).value || []) {
      meta.set(e.LogicalName, { set: e.EntitySetName, pk: e.PrimaryIdAttribute, plural: label(e.DisplayCollectionName, e.EntitySetName), singular: label(e.DisplayName, e.LogicalName) });
    }
  }
  return meta;
}

function deleteRelationships(dv, logical) {
  const rels = (dv.get(`EntityDefinitions(LogicalName='${logical}')/OneToManyRelationships`
    + '?$select=SchemaName,ReferencingEntity,ReferencingAttribute,CascadeConfiguration').value || [])
    .filter((r) => r.CascadeConfiguration && ACTIONS.has(r.CascadeConfiguration.Delete));
  const meta = tableMeta(dv, rels.map((r) => r.ReferencingEntity));
  const out = rels.map((r) => ({ schema: r.SchemaName, entity: r.ReferencingEntity, attr: r.ReferencingAttribute, action: r.CascadeConfiguration.Delete, ...(meta.get(r.ReferencingEntity) || {}) }));
  return out.concat(manyToMany(dv, logical));
}

// Many-to-many links (10/7 re-verify): deleting a record drops every association it has. Each is read from
// the relationship's intersect table (its id column, not a lookup), action "Unlink". A link table the
// person cannot read is listed as not checked, never silently skipped.
function manyToMany(dv, logical) {
  let rels;
  try {
    rels = dv.get(`EntityDefinitions(LogicalName='${logical}')/ManyToManyRelationships`
      + '?$select=SchemaName,Entity1LogicalName,Entity2LogicalName,IntersectEntityName,Entity1IntersectAttribute,Entity2IntersectAttribute').value || [];
  } catch (e) {
    if (!(e instanceof DataverseError)) throw e;
    return [{ schema: 'many-to-many links', unreadableWhy: String(e.message).slice(0, 160) }];
  }
  const meta = tableMeta(dv, rels.flatMap((r) => [r.IntersectEntityName, r.Entity1LogicalName, r.Entity2LogicalName]));
  return rels.map((r) => {
    const other = r.Entity1LogicalName === logical ? r.Entity2LogicalName : r.Entity1LogicalName;
    const attr = r.Entity1LogicalName === logical ? r.Entity1IntersectAttribute : r.Entity2IntersectAttribute;
    const o = meta.get(other);
    const what = o ? o.singular.toLowerCase() : other;
    return { schema: r.SchemaName, entity: r.IntersectEntityName, attr, plainAttr: true, action: 'Unlink',
      set: (meta.get(r.IntersectEntityName) || {}).set || null, pk: attr, plural: `links to ${what} records`, singular: `link to a ${what} record` };
  });
}

function nextPath(link) {
  return link ? '/' + link.split('/').slice(3).join('/') : null;
}

// { found: { schema: { action, label, singular, set, by: { recordId: [childIds] } } }, unreadable: { schema: why } }
async function inventory(dv, rels, ids) {
  const found = {};
  const unreadable = {};
  const by = new Map(); // schema -> { parentId: [childIds] }
  const pages = new Map(); // schema -> pages read
  // One job per relationship per chunk of records; follow-on pages are queued as they come back.
  let jobs = [];
  for (const r of rels) {
    if (r.unreadableWhy) { unreadable[r.schema] = r.unreadableWhy; continue; }
    if (!r.set || !r.pk) { unreadable[r.schema] = `no table metadata for ${r.entity}`; continue; }
    const key = r.plainAttr ? r.attr : `_${r.attr}_value`;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const f = encodeURIComponent(ids.slice(i, i + CHUNK).map((id) => `${key} eq ${id}`).join(' or '));
      jobs.push({ r, key, path: r.plainAttr ? `${r.set}?$select=${key}&$filter=${f}` : `${r.set}?$select=${r.pk},${key}&$filter=${f}` });
    }
  }
  while (jobs.length) {
    const results = await dv.getMany(jobs.map((j) => j.path), PARALLEL);
    const next = [];
    jobs.forEach((j, i) => {
      const { r, key } = j;
      if (unreadable[r.schema]) return;
      const res = results[i];
      if (!res.ok) {
        if (!(res.error instanceof DataverseError)) throw res.error;
        unreadable[r.schema] = String(res.error.message).slice(0, 160);
        return;
      }
      const m = by.get(r.schema) || {};
      for (const row of res.value.value || []) {
        const parent = String(row[key] || '').toLowerCase();
        const list = (m[parent] = m[parent] || []);
        // A link row has no id of its own worth keeping; it is counted by the parent it belongs to.
        list.push(r.plainAttr ? `link-${list.length + 1}` : String(row[r.pk]).toLowerCase());
      }
      by.set(r.schema, m);
      const n = (pages.get(r.schema) || 0) + 1;
      pages.set(r.schema, n);
      const link = nextPath(res.value['@odata.nextLink']);
      if (link) {
        if (n >= PAGE_CEILING) unreadable[r.schema] = `more than ${PAGE_CEILING * 5000} linked rows`;
        else next.push({ r, key, path: link });
      }
    });
    jobs = next;
  }
  for (const r of rels) {
    const m = by.get(r.schema);
    if (!m || unreadable[r.schema] || !Object.keys(m).length) continue;
    for (const k of Object.keys(m)) m[k].sort();
    found[r.schema] = { action: r.action, label: r.plural, singular: r.singular, set: r.set, entity: r.entity, attr: r.attr, by: m };
  }
  return { found, unreadable };
}

// The same inventory restricted to one record: { schema: { action, label, singular, set, ids } }.
function forRecord(inv, id) {
  const out = {};
  for (const [k, c] of Object.entries(inv.found)) if (c.by[id]) out[k] = { action: c.action, label: c.label, singular: c.singular, set: c.set, ids: c.by[id] };
  return out;
}

// "12 emails, 3 appointments" for one action across every record.
function countsLine(inv, action) {
  const counts = new Map();
  for (const c of Object.values(inv.found)) {
    if (c.action !== action) continue;
    const n = Object.values(c.by).reduce((s, x) => s + x.length, 0);
    const e = counts.get(c.label) || { n: 0, singular: c.singular };
    e.n += n;
    counts.set(c.label, e);
  }
  const parts = [...counts].map(([l, e]) => `${e.n} ${String(e.n === 1 ? e.singular : l).toLowerCase()}`);
  return { total: [...counts.values()].reduce((s, e) => s + e.n, 0), text: parts.join(', ') };
}

// A stable key for apply's re-check: the same linked rows, or the delete would do something not shown.
function inventoryKey(inv) {
  return JSON.stringify(Object.keys(inv.found).sort().map((k) => [k, Object.keys(inv.found[k].by).sort().map((p) => [p, inv.found[k].by[p]])]));
}

module.exports = { deleteRelationships, inventory, forRecord, countsLine, inventoryKey };
