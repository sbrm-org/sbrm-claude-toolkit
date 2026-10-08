'use strict';
// App components (DESIGN.md §10b, §10e; rulings §10j, §10k, 10/7/26): a view (savedqueries), a form
// (systemforms), a sitemap (sitemaps) or a Power Automate cloud flow (workflows, category 5). Ported from
// `the earlier Python component tool` (definition_job, new_flow_job), which proved each write live
// 9/24-9/29. The engine keeps its one rule: COMPUTE the effect from live reads, show it, re-check it at
// apply, verify it, log it.
//
//   plan   reads the live component; refuses a managed one; refuses unless it still hashes to the
//          `snapshot_hash` the job was built from (a restore point is only true if nothing moved since,
//          the earlier Python component tool); computes a readable diff by section; for a form checks every field
//          exists on its table; for a flow prints who it RUNS AS, from the connection references it names.
//          Reads only.
//   apply  re-checks the live hash, the level and the severity, shows the pop-up, then ONE write: a PATCH
//          with If-Match (update, on, off, own), a POST into the named solution (create) or a DELETE
//          (admin, typed name). Views, forms and sitemaps are then published (only that table or sitemap,
//          never PublishAllXml). The definition is read back and parse-compared; a flow's trigger
//          subscription is checked when the flow is on.
//   log    the entry carries the full definition before AND after (DESIGN.md §10e: the log IS the restore
//          point), refused at plan if it would not fit one Write Log row.
//
// Who a flow runs as (DESIGN.md §10b, the security point): a cloud flow acts through the connections its
// connection references name, and the platform lets anyone who can write the row EDIT a flow running on
// SBRM App Admin's connections (verified 9/29, a live finding). So every flow pop-up prints "Runs as",
// and a definition that ADDS or SWAPS a connection reference, or changes the trigger of a flow that is on,
// takes admin (ruled 10/7). Turning a flow on is gated by the platform itself: only the connection owner
// may (403 ConnectionAuthorizationFailed), and the engine says so in plain words.

const crypto = require('crypto');
const { whoAmI, accessFor, PlanRefused } = require('./resolve');
const { resolveAccess, TOOLKIT_SETS } = require('./access');
const { ApplyRefused } = require('./apply');
const { canonical } = require('./store');
const { entryText } = require('./log');
const { DataverseError } = require('./cli');
const { GUID } = require('./contract');
const { atLeast } = require('./levels');
const severity = require('./severity');
const { unprovenPhrase } = require('./proven');

const CONTRACT = 'sbrm-dv-job/1';
const MAX_ENTRY = 1000000; // characters of the logged entry; sbrm_entry holds 1,048,576 (DESIGN.md §10e)
const MAX_AGE_MS = 24 * 3600 * 1000;
const HASH = /^[0-9a-f]{64}$/;
const SOLUTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/; // same rule as lib/write.js
const IDENT = /^[a-z_][a-z0-9_]*$/;

// One entry per component set. `fields` are what a snapshot covers and what the log keeps in full.
const SETS = {
  workflows: {
    noun: 'flow', id: 'workflowid', name: 'name', fields: ['clientdata', 'description'], xml: {}, json: 'clientdata',
    select: 'workflowid,name,ismanaged,category,statecode,statuscode,_ownerid_value,description,clientdata',
    sections: ['trigger', 'concurrency', 'actions', 'notes', 'connections', 'description', 'other'],
  },
  savedqueries: {
    noun: 'view', id: 'savedqueryid', name: 'name', fields: ['fetchxml', 'layoutxml', 'description'], xml: { fetchxml: 'fetch', layoutxml: 'grid' },
    table: 'returnedtypecode', select: 'savedqueryid,name,ismanaged,statecode,returnedtypecode,querytype,description,fetchxml,layoutxml',
    sections: ['columns', 'filters', 'sort', 'description', 'other'],
  },
  systemforms: {
    noun: 'form', id: 'formid', name: 'name', fields: ['formxml', 'description'], xml: { formxml: 'form' },
    table: 'objecttypecode', select: 'formid,name,ismanaged,objecttypecode,type,description,formxml',
    sections: ['tabs', 'sections', 'fields', 'events', 'description', 'other'],
  },
  sitemaps: {
    noun: 'sitemap', id: 'sitemapid', name: 'sitemapname', fields: ['sitemapxml'], xml: { sitemapxml: 'SiteMap' },
    select: 'sitemapid,sitemapname,sitemapnameunique,ismanaged,sitemapxml',
    sections: ['areas', 'groups', 'subareas', 'other'],
  },
};
const MODES = ['update', 'create', 'on', 'off', 'own', 'delete'];
const FLOW_ONLY = new Set(['on', 'off', 'own']);
// Trigger messages (the earlier Python component tool MESSAGES).
const MESSAGES = { 1: 'create', 2: 'delete', 3: 'update', 4: 'create or update', 5: 'create or delete', 6: 'update or delete', 7: 'any change' };
// Step types that must carry a note when added (the app developer, 9/25/26; the earlier Python component tool check_notes).
const NOTE_TYPES = new Set(['If', 'OpenApiConnection', 'Scope', 'Terminate', 'Query']);

const TOP_KEYS = new Set(['contract', 'kind', 'env', 'component', 'mode', 'definition', 'owner', 'snapshot_hash',
  'solution', 'proven_in', 'publish', 'source', 'reason', 'intent']);

const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const blank = (v) => v === null || v === undefined || v === '';

// ---------- XML (no dependencies) ----------
//
// Enough of XML for Dataverse's fetchxml, layoutxml, formxml and sitemapxml: elements, attributes in either
// quote, the five named entities and numeric ones, comments, CDATA, processing instructions. A definition
// that does not parse is refused, never repaired.

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
}

function parseXml(src) {
  const s = String(src);
  const doc = { n: '#doc', a: {}, c: [] };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const fail = (m, at) => { throw new Error(`not valid XML: ${m} (at character ${at})`); };
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '<') {
      const e = s.indexOf('<', i);
      const end = e < 0 ? s.length : e;
      const t = decode(s.slice(i, end)).trim();
      if (t) {
        if (stack.length === 1) fail('text outside the root element', i);
        top().c.push(t);
      }
      i = end;
      continue;
    }
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); if (e < 0) fail('unclosed comment', i); i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i);
      if (e < 0) fail('unclosed CDATA', i);
      const t = s.slice(i + 9, e).trim();
      if (t) top().c.push(t);
      i = e + 3;
      continue;
    }
    if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i); if (e < 0) fail('unclosed declaration', i); i = e + 2; continue; }
    if (s.startsWith('<!', i)) { const e = s.indexOf('>', i); if (e < 0) fail('unclosed declaration', i); i = e + 1; continue; }
    if (s.startsWith('</', i)) {
      const e = s.indexOf('>', i);
      if (e < 0) fail('unclosed end tag', i);
      const name = s.slice(i + 2, e).trim();
      const el = stack.pop();
      if (!el || el.n !== name || stack.length === 0) fail(`</${name}> does not close <${el ? el.n : '?'}>`, i);
      i = e + 1;
      continue;
    }
    let j = i + 1;
    while (j < s.length && !/[\s/>]/.test(s[j])) j += 1;
    const el = { n: s.slice(i + 1, j), a: {}, c: [] };
    if (!el.n) fail('an element with no name', i);
    let closed = false;
    for (;;) {
      while (j < s.length && /\s/.test(s[j])) j += 1;
      if (j >= s.length) fail(`unclosed <${el.n}>`, i);
      if (s[j] === '/' && s[j + 1] === '>') { closed = true; j += 2; break; }
      if (s[j] === '>') { j += 1; break; }
      let k = j;
      while (k < s.length && !/[\s=/>]/.test(s[k])) k += 1;
      const an = s.slice(j, k);
      while (k < s.length && /\s/.test(s[k])) k += 1;
      if (!an || s[k] !== '=') fail(`attribute "${an}" on <${el.n}> has no value`, j);
      k += 1;
      while (k < s.length && /\s/.test(s[k])) k += 1;
      const q = s[k];
      if (q !== '"' && q !== "'") fail(`attribute "${an}" on <${el.n}> is not quoted`, k);
      const e = s.indexOf(q, k + 1);
      if (e < 0) fail(`attribute "${an}" on <${el.n}> is not closed`, k);
      if (has(el.a, an)) fail(`attribute "${an}" twice on <${el.n}>`, j);
      el.a[an] = decode(s.slice(k + 1, e));
      j = e + 1;
    }
    if (stack.length === 1 && doc.c.length) fail('a second root element', i);
    top().c.push(el);
    if (!closed) stack.push(el);
    i = j;
  }
  if (stack.length !== 1) fail(`<${top().n}> is never closed`, s.length);
  if (doc.c.length !== 1 || typeof doc.c[0] === 'string') fail('no root element', 0);
  return doc.c[0];
}

// Every element named `name` under `node` (itself included), document order.
function els(node, name, out = []) {
  if (!node || typeof node === 'string') return out;
  if (node.n === name) out.push(node);
  for (const c of node.c) els(c, name, out);
  return out;
}

function kids(node, name) {
  return (node && node.c ? node.c : []).filter((c) => typeof c !== 'string' && c.n === name);
}

function labelOf(node) {
  const l = els(kids(node, 'labels')[0], 'label')[0] || els(kids(node, 'Titles')[0], 'Title')[0];
  return l ? (l.a.description || l.a.Title || null) : null;
}

// The tree with the listed parts masked out, for the "anything else changed" residual of a section diff.
// drop: element names removed wherever they are; dropAttrs: { element: [attrs] }; dropKids: { parent: [names] };
// dropIf(el): an element a named section already explains (a removed field's cell, an added page), removed with
// its subtree; dropEmpty: element names removed when that left them with no children (a row whose only cell
// went). So the residual reports only what no section explains: a field MOVED still shows, a field removed
// does not show twice.
function mask(node, { drop = [], dropAttrs = {}, dropKids = {}, dropIf = () => false, dropEmpty = [] }) {
  const walk = (n) => {
    if (typeof n === 'string') return n;
    const a = { ...n.a };
    for (const x of dropAttrs[n.n] || []) delete a[x];
    const gone = new Set(dropKids[n.n] || []);
    const c = n.c.filter((k) => typeof k === 'string' || (!drop.includes(k.n) && !gone.has(k.n) && !dropIf(k))).map(walk).filter((k) => k !== null);
    if (dropEmpty.includes(n.n) && n.c.length && !c.length) return null;
    return { n: n.n, a, c };
  };
  return walk(node) || { n: node.n, a: {}, c: [] };
}

// Does this element (or anything under it) bind one of these fields?
function bindsAny(el, fields) {
  if (!fields.size || typeof el === 'string') return false;
  if (el.a.datafieldname && fields.has(el.a.datafieldname)) return true;
  return el.c.some((k) => bindsAny(k, fields));
}

// ---------- definitions, snapshot, hash ----------

// A definition field as compared and hashed: clientdata as parsed JSON, XML as its parsed tree (attribute
// order, quote style, entity spelling and whitespace between tags do not count), text as text, blank as null.
function normField(set, field, v) {
  if (blank(v)) return null;
  if (field === SETS[set].json) return typeof v === 'string' ? JSON.parse(v) : v;
  if (has(SETS[set].xml, field)) return parseXml(v);
  return String(v);
}

function normDef(set, def) {
  return Object.fromEntries(SETS[set].fields.map((f) => [f, normField(set, f, def[f])]));
}

function hashDef(set, id, def) {
  return crypto.createHash('sha256').update(canonical({ set, id: String(id || '').toLowerCase(), definition: normDef(set, def) })).digest('hex');
}

// The restore-point hash Claude builds a change from (DESIGN.md §10e). From one live read of the component
// (`<set>(<id>)?$select=<every field in SETS[set].fields>,<id column>`):
//   sha256( canonical({ set, id: lowercase id, definition: { field: normalized value } }) )
// over SETS[set].fields only (flows: clientdata + description; views: fetchxml + layoutxml + description;
// forms: formxml + description; sitemaps: sitemapxml); canonical = lib/store.js sorted-key JSON;
// normalized = normField. So two reads of an unchanged component always hash the same, and any change to a
// field, an attribute value or an element does not.
function snapshot(set, row) {
  if (!has(SETS, set)) throw new Error(`"${set}" is not a component set: ${Object.keys(SETS).join(', ')}`);
  const spec = SETS[set];
  const id = String(row[spec.id] || row.id || '').toLowerCase();
  const definition = Object.fromEntries(spec.fields.map((f) => [f, blank(row[f]) ? null : row[f]]));
  return { hash: hashDef(set, id, definition), id, name: row[spec.name] === undefined ? null : row[spec.name], definition };
}

// The same, read live (READS ONLY).
function readSnapshot(dv, set, id) {
  const spec = SETS[set];
  return snapshot(set, dv.get(`${set}(${id})?$select=${spec.id},${spec.name},${spec.fields.join(',')}`));
}

function sameDef(set, a, b, fields = SETS[set].fields) {
  return fields.every((f) => canonical(normField(set, f, a[f])) === canonical(normField(set, f, b[f])));
}

// ---------- flow pieces ----------

function flowDef(cd) {
  const p = (cd && cd.properties) || {};
  return { def: p.definition || {}, refs: p.connectionReferences || {} };
}

// Every action however deeply nested, with where it sits (the earlier Python component tool _walk, plus the parent path,
// so an action MOVED into a scope counts as changed: a move changes when it runs).
function walkActions(actions, parent = '', out = new Map()) {
  if (!obj(actions)) return out;
  for (const [name, a] of Object.entries(actions)) {
    if (!obj(a)) continue;
    out.set(name, { parent, a });
    walkActions(a.actions, `${parent}${name}/`, out);
    if (obj(a.else)) walkActions(a.else.actions, `${parent}${name}/else/`, out);
    if (obj(a.cases)) for (const [cn, c] of Object.entries(a.cases)) if (obj(c)) walkActions(c.actions, `${parent}${name}/${cn}/`, out);
    if (obj(a.default)) walkActions(a.default.actions, `${parent}${name}/default/`, out);
  }
  return out;
}

// What an action DOES, without its children, its order (runAfter, compared apart) or its note.
function actionCore(a) {
  const core = {};
  for (const [k, v] of Object.entries(a)) {
    if (['actions', 'runAfter', 'description'].includes(k)) continue;
    if (k === 'else' && obj(v)) { const { actions: _x, ...rest } = v; core.else = rest; continue; } // eslint-disable-line no-unused-vars
    if (k === 'default' && obj(v)) { const { actions: _x, ...rest } = v; core.default = rest; continue; } // eslint-disable-line no-unused-vars
    if (k === 'cases' && obj(v)) {
      core.cases = Object.fromEntries(Object.entries(v).map(([cn, c]) => [cn, obj(c) ? Object.fromEntries(Object.entries(c).filter(([ck]) => ck !== 'actions')) : c]));
      continue;
    }
    core[k] = v;
  }
  return core;
}

function triggerCore(t) {
  return Object.fromEntries(Object.entries(t || {}).filter(([k]) => !['description', 'runtimeConfiguration'].includes(k)));
}

function triggerInfo(name, t) {
  const p = ((t && t.inputs) || {}).parameters || {};
  const conditions = ((t && t.conditions) || []).map((c) => c.expression);
  if (has(p, 'subscriptionRequest/entityname')) {
    const m = p['subscriptionRequest/message'];
    return {
      name, dataverse: true, table: p['subscriptionRequest/entityname'], message: MESSAGES[m] || String(m),
      filter: p['subscriptionRequest/filteringattributes'] || null, conditions,
    };
  }
  return { name, dataverse: false, type: [t && t.type, t && t.kind].filter(Boolean).join('/') || 'unknown', conditions };
}

function triggerText(info) {
  if (!info) return 'none';
  const conds = info.conditions.length ? `, ${info.conditions.length} condition${info.conditions.length === 1 ? '' : 's'}` : '';
  if (!info.dataverse) return `${info.type}${conds}`;
  return `on ${info.message} of ${info.table}, filter ${info.filter || 'none (any column)'}${conds}`;
}

function concurrencyOf(t) {
  return ((t && t.runtimeConfiguration) || {}).concurrency || null;
}

function concText(c) {
  return c ? Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') : 'none';
}

// The connection references a definition names: key -> { logical, api, source, entry }.
function flowConnections(cd) {
  const out = {};
  for (const [k, r] of Object.entries(flowDef(cd).refs)) {
    out[k] = {
      logical: obj(r) && obj(r.connection) ? r.connection.connectionReferenceLogicalName || null : null,
      api: obj(r) && obj(r.api) ? r.api.name || null : null,
      source: obj(r) ? r.runtimeSource || null : null,
      entry: canonical(r),
    };
  }
  return out;
}

// a live finding (9/25/26): trigger concurrency cannot be removed once saved; the platform refuses any
// definition that drops it. So a PATCH (a change or a revert) carries the live concurrency forward into a
// trigger of the same name (or the only trigger, when both have one) that lacks it. Returns the carried value.
function carryConcurrency(oldCd, newCd) {
  const ot = flowDef(oldCd).def.triggers || {};
  const nt = flowDef(newCd).def.triggers || {};
  const on = Object.keys(ot);
  const nn = Object.keys(nt);
  let carried = null;
  for (const name of nn) {
    const from = has(ot, name) ? ot[name] : (on.length === 1 && nn.length === 1 ? ot[on[0]] : null);
    const c = concurrencyOf(from);
    if (c && !concurrencyOf(nt[name])) {
      nt[name].runtimeConfiguration = { ...(nt[name].runtimeConfiguration || {}), concurrency: c };
      carried = c;
    }
  }
  return carried;
}

// ---------- what a change can DO (blind review round 3, 10/7) ----------

// Plain-text secrets in a flow definition. A live Donor App Dev flow keeps an app secret as the default value
// of a String parameter (an environment variable that is not of type Secret), read 10/7 by name and shape
// only. A job on such a flow would copy it into the plan file, the pop-up's detail and the Write Log, which
// every writer can read, so the engine refuses it before anything is stored. Returns WHERE (never a value).
// "token" but not "tokens": some live flows send max_tokens / max_completion_tokens (a count) in their
// request bodies, the only false positives when this scan ran over every unmanaged flow in Donor App Dev and
// the Donor App (10/7, 60 + 82 flows, locations only).
const SECRET_NAME = /secret|password|passwd|api.?key|apikey|token(?!s)|client.?secret|connection.?string|subscription.?key|access.?key|private.?key|credential/i;
// Inside an `authentication` object: Basic password, Raw value, ClientCertificate pfx/password,
// ActiveDirectoryOAuth secret (round 4: Raw auth keeps its secret in `value`).
const AUTH_SECRET_KEY = /secret|password|passwd|pfx|key|token|^value$/i;
const SECRET_HEADER = /authorization|api.?key|secret|token|password|subscription.?key|functions.?key|cookie|^x-.*key$/i;
// Query-string names that carry a credential in a URI or a form body (round 4).
const SECRET_QUERY = /^(key|code|sig|token|apikey|api_key|api-key|access_token|client_secret|secret|password|subscription-key)$/i;

// A value typed into the definition, as opposed to one the flow computes: an expression (@...) or a string
// interpolating one (@{...}) is not a literal.
function isLiteral(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    return s !== '' && !s.startsWith('@') && !s.includes('@{');
  }
  return v !== null && v !== undefined && typeof v !== 'object';
}

// Credential-carrying names in a query string ("a=1&sig=xyz"), literal values only.
function queryKeys(s) {
  const q2 = String(s).includes('?') ? String(s).slice(String(s).indexOf('?') + 1) : String(s);
  return q2.split(/[&;]/).map((kv) => kv.split('=')).filter(([k, v]) => k && v !== undefined && SECRET_QUERY.test(decodeURIComponent(k.trim())) && isLiteral(decodeURIComponent(v)))
    .map(([k]) => k.trim());
}

// A body, any shape: an object's secret-named keys with literal values, a JSON string parsed, a form body scanned.
function bodySecrets(v, path, out, depth = 0) {
  if (depth > 12 || v === null || v === undefined) return;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^[[{]/.test(s)) { try { bodySecrets(JSON.parse(s), path, out, depth + 1); return; } catch { /* not JSON */ } }
    if (/[^=\s]+=[^&]/.test(s)) for (const k of queryKeys(s)) out.push(`${path} ${k}`);
    return;
  }
  if (Array.isArray(v)) { v.forEach((x) => bodySecrets(x, path, out, depth + 1)); return; }
  if (typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_NAME.test(k) && isLiteral(x)) out.push(`${path} ${k}`);
    else bodySecrets(x, path, out, depth + 1);
  }
}

// Every place in one step's or trigger's inputs where a typed-in credential can sit.
function inputSecrets(label, inputs, out) {
  if (!obj(inputs)) return;
  const at = (what) => out.push(`${label} (its ${what})`);
  if (obj(inputs.authentication)) for (const [k, v] of Object.entries(inputs.authentication)) if (AUTH_SECRET_KEY.test(k) && isLiteral(v)) at(`authentication ${k}`);
  if (obj(inputs.headers)) for (const [k, v] of Object.entries(inputs.headers)) if (SECRET_HEADER.test(k) && isLiteral(v)) at(`${k} header`);
  if (typeof inputs.uri === 'string' && inputs.uri.includes('?')) for (const k of queryKeys(inputs.uri)) at(`URI query ${k}`);
  if (obj(inputs.queries)) for (const [k, v] of Object.entries(inputs.queries)) if ((SECRET_QUERY.test(k) || SECRET_NAME.test(k)) && isLiteral(v)) at(`query ${k}`);
  if (inputs.body !== undefined) { const b = []; bodySecrets(inputs.body, 'body', b); for (const x of b) at(x); }
  // Connector parameters (OpenApiConnection): a parameter whose own name (after any "item/" path) looks secret.
  if (obj(inputs.parameters)) {
    for (const [k, v] of Object.entries(inputs.parameters)) {
      const leaf = k.split('/').pop();
      if (SECRET_NAME.test(leaf) && isLiteral(v)) at(`parameter ${k}`);
      else if (obj(v) || Array.isArray(v)) { const b = []; bodySecrets(v, `parameter ${k}`, b); for (const x of b) at(x); }
    }
  }
}

function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function flowSecrets(cd) {
  const out = [];
  if (!obj(cd)) return out;
  const { def } = flowDef(cd);
  for (const [k, p] of Object.entries(obj(def.parameters) ? def.parameters : {})) {
    const secureType = obj(p) && /^secure/i.test(String(p.type || ''));
    if ((SECRET_NAME.test(k) || secureType) && obj(p) && hasValue(p.defaultValue)) out.push(`parameter "${k}"`);
  }
  // Round 4: EVERY step and every trigger, not only Http steps (a connector step or a webhook trigger can carry
  // a key in a header, a query string, a body or a parameter too). This is the one gate for disk as well: the
  // snapshot CLI refuses a flow this finds anything in.
  for (const [n, x] of walkActions(def.actions)) inputSecrets(`step "${n}"`, x.a.inputs, out);
  for (const [n, t] of Object.entries(obj(def.triggers) ? def.triggers : {})) if (obj(t)) inputSecrets(`trigger "${n}"`, t.inputs, out);
  return [...new Set(out)];
}

// Where plain-text secrets sit in either of two flow definitions ({clientdata}), names only.
function secretsIn(...defs) {
  const out = [];
  for (const d of defs) {
    if (!d || blank(d.clientdata)) continue;
    let cd;
    try { cd = typeof d.clientdata === 'string' ? JSON.parse(d.clientdata) : d.clientdata; } catch { continue; }
    out.push(...flowSecrets(cd));
  }
  return [...new Set(out)];
}

function secretRefusal(where) {
  return `the flow holds a secret in plain text (${where.join(', ')}); move it to a Secret environment variable first. Nothing was logged.`;
}

// The inputs of a step that decide what it can reach (shown in the pop-up; compared for proven_in). Never a
// secret value: authentication shows its TYPE only, and secrets are refused before this is ever printed.
function actionFacts(a) {
  const i = obj(a.inputs) ? a.inputs : {};
  const host = obj(i.host) ? i.host : {};
  const p = obj(i.parameters) ? i.parameters : {};
  let uriHost = null;
  if (typeof i.uri === 'string') {
    const u = i.uri.trim();
    if (u.startsWith('@') || u.includes('@{')) uriHost = '(an expression)';
    else { try { uriHost = new URL(u).host; } catch { uriHost = '(not a URL)'; } }
  }
  // The connection: a connection reference key (OpenApiConnection: host.connectionName) or, in older
  // ApiConnection steps, host.connection.name = "@parameters('$connections')['<key>']['connectionId']" (round 4).
  // A connection named any other way cannot be matched to who owns it.
  let connection = host.connectionName || null;
  let unresolved = false;
  if (!connection && obj(host.connection)) {
    const m = /parameters\('\$connections'\)\['([^']+)'\]/.exec(String(host.connection.name || ''));
    if (m) connection = m[1];
    else unresolved = true;
  }
  return {
    type: a.type || '?',
    kind: a.kind || null,
    method: typeof i.method === 'string' ? i.method.toUpperCase() : null,
    host: uriHost,
    entity: p.entityName === undefined ? null : String(p.entityName),
    operation: host.operationId || null,
    child: host.workflowReferenceName || null,
    auth: obj(i.authentication) ? String(i.authentication.type || 'set') : null,
    connection,
    connection_unresolved: unresolved,
  };
}

function actionText(name, f) {
  const parts = [];
  if (f.method || f.host) parts.push([f.method, f.host].filter(Boolean).join(' '));
  if (f.entity) parts.push(`table ${f.entity}`);
  if (f.operation) parts.push(`operation ${f.operation}`);
  if (f.child) parts.push(`child flow ${f.child}`);
  if (f.auth) parts.push(`auth ${f.auth}`);
  if (f.connection) parts.push(`via ${f.connection}`);
  return `${name} [${f.type}]${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

// Why a step takes admin even with no connection reference change (blind review round 3): it runs another
// flow, calls out over HTTP, picks its table or operation at run time, or acts through a connection that
// belongs to someone other than the person approving. runsAs: runsAs(...) of the definition; me: systemuserid.
// Connector operations that send a raw HTTP request through the connection's own sign-in (SharePoint "Send an
// HTTP request to SharePoint", Office 365 "Send an HTTP request", "HTTP with Microsoft Entra ID"): as strong as
// an Http step, with someone's credentials attached (round 4).
const HTTP_OPERATION = /HttpRequest|InvokeHttp|SendHttp/i;

// Whose connection a step or trigger acts through: someone else's, or one that cannot be matched to a
// connection reference at all, is an admin's.
function connectionPower(label, f, runsAsList, me) {
  if (f.connection_unresolved) return [`${label} uses a connection the engine cannot match to a connection reference`];
  if (!f.connection) return [];
  const ref = (runsAsList || []).find((r) => r.key === f.connection);
  if (!ref) return [`${label} uses a connection (${f.connection}) the definition's connection references do not name`];
  if (!ref.invoker && !ref.missing && me && ref.owner_id !== String(me).toLowerCase()) return [`${label} acts through ${ref.display || ref.key}, as ${ref.owner}`];
  return [];
}

function stepPower(name, f, runsAsList, me) {
  const why = [];
  if (f.type === 'Workflow') why.push(`step ${name} runs another flow (child flow ${f.child || 'unknown'})`);
  if (/^http/i.test(f.type)) why.push(`step ${name} calls ${[f.method, f.host].filter(Boolean).join(' ') || 'out'} directly over HTTP`);
  if (f.operation && HTTP_OPERATION.test(f.operation)) why.push(`step ${name} sends a raw HTTP request through its connection (operation ${f.operation})`);
  if ((f.entity && /@|concat/i.test(f.entity)) || (f.operation && /@/.test(f.operation))) why.push(`step ${name} picks its table or operation at run time`);
  why.push(...connectionPower(`step ${name}`, f, runsAsList, me));
  return why;
}

// Triggers (round 4): one that takes HTTP requests from outside ("When an HTTP request is received": a Request
// trigger of any kind but the in-platform ones, Button for manual and child flows, PowerApp(V2), Skills), one
// that registers a webhook with an outside service, and one listening through someone else's connection.
const INTERNAL_REQUEST_KINDS = new Set(['button', 'powerapp', 'powerappv2', 'skills']);
function triggerPower(name, f, runsAsList, me) {
  const why = [];
  if (f.type === 'Request' && !INTERNAL_REQUEST_KINDS.has(String(f.kind || '').toLowerCase())) why.push(`trigger ${name} takes HTTP requests from outside (anyone holding its URL can start the flow)`);
  if (f.type === 'HttpWebhook') why.push(`trigger ${name} registers a webhook with an outside service`);
  why.push(...connectionPower(`trigger ${name}`, f, runsAsList, me));
  return why;
}

function allEls(node, out = []) {
  if (!node || typeof node === 'string') return out;
  out.push(node);
  for (const c of node.c) allEls(c, out);
  return out;
}

function textOf(node, name) {
  const el = els(node, name)[0];
  return el ? el.c.filter((c) => typeof c === 'string').join('').trim() || null : null;
}

// Script hooks in a view's layout: a web resource or JavaScript function on a column (imageproviderwebresource,
// imageproviderfunctionname). The designer writes an EMPTY "$webresource:" on plain columns (read live 10/7),
// which is not a hook.
function viewHooks(layoutxml) {
  if (blank(layoutxml)) return [];
  const out = [];
  for (const el of allEls(parseXml(layoutxml))) {
    for (const [k, v] of Object.entries(el.a)) {
      if (!/webresource|functionname/i.test(k)) continue;
      const s = String(v || '').trim();
      if (s && !/^\$webresource:\s*$/i.test(s)) out.push(`column ${el.a.name || el.n}: ${k} ${s}`);
    }
  }
  return out.sort();
}

// Form controls that run or show something from outside the form: a web resource, an iframe, a custom (PCF)
// control that is not Microsoft's own (MscrmControls.*), or any control carrying a URL, even when it also
// binds a field; plus the form's script libraries and event handlers. [{ label, sig }]: sig changes whenever
// the control does, so an edited one counts as changed.
const WEB_RESOURCE_CONTROL = '{9fdf5f91-88b1-47f4-ad53-c11efc01a01d}';
const IFRAME_CONTROL = '{fd2a7985-3187-444e-908d-6624b21f69c0}';
function formHooks(formxml) {
  if (blank(formxml)) return [];
  const x = parseXml(formxml);
  const custom = new Map();
  for (const d of els(x, 'controlDescription')) {
    for (const cc of els(d, 'customControl')) {
      if (cc.a.name && !/^MscrmControls\./i.test(cc.a.name)) custom.set(d.a.forControl, [...(custom.get(d.a.forControl) || []), cc.a.name]);
    }
  }
  const out = [];
  for (const c of els(x, 'control')) {
    const cls = String(c.a.classid || '').toLowerCase();
    const url = textOf(c, 'Url') || allEls(c).flatMap((e) => e.c.filter((t) => typeof t === 'string' && /^https?:\/\//i.test(t.trim()))).map((t) => t.trim())[0] || null;
    const kinds = [];
    if (cls === WEB_RESOURCE_CONTROL) kinds.push('web resource');
    if (cls === IFRAME_CONTROL) kinds.push('iframe');
    if (!kinds.length && url) kinds.push('URL');
    const cc = custom.get(c.a.id) || [];
    if (cc.length) kinds.push('custom control');
    if (!kinds.length) continue;
    const what = [url, textOf(c, 'WebResourceId'), ...cc].filter(Boolean).join(', ');
    const label = `control ${c.a.id} (${kinds.join(', ')}${what ? `: ${what}` : ''})`;
    out.push({ label, sig: `${label}|${canonical(c)}|${canonical(cc)}` });
  }
  for (const lib of els(x, 'Library')) out.push({ label: `script library ${lib.a.name}`, sig: `lib|${canonical(lib)}` });
  for (const ev of els(x, 'event')) {
    for (const h of els(ev, 'Handler')) {
      const label = `on ${ev.a.name}${ev.a.attribute ? ` of ${ev.a.attribute}` : ''}: ${h.a.libraryName}.${h.a.functionName}`;
      out.push({ label, sig: `handler|${label}|${canonical(h)}` });
    }
  }
  return out;
}

// A sitemap page that opens a URL or a web resource instead of a table.
function sitemapHooks(xml) {
  if (blank(xml)) return [];
  return els(parseXml(xml), 'SubArea').filter((s) => s.a.Url).map((s) => ({ label: `page ${s.a.Id} opens ${s.a.Url}`, sig: canonical(s.a) }));
}

// What in a view, form or sitemap change needs admin: script hooks, web resources, iframes, custom controls and
// URLs that are ADDED or CHANGED (a removed one runs nothing). { why: [...], lines: [...] }.
function markupPower(set, before, after) {
  const why = [];
  const lines = [];
  if (set === 'savedqueries') {
    const added = listDiff(viewHooks((before || {}).layoutxml), viewHooks((after || {}).layoutxml)).added;
    for (const h of added) { why.push(`a view ${h} runs a script`); lines.push(`Script hook added or changed: ${h}`); }
  } else if (set === 'systemforms' || set === 'sitemaps') {
    const fn = set === 'systemforms' ? formHooks : sitemapHooks;
    const field = set === 'systemforms' ? 'formxml' : 'sitemapxml';
    const old = new Set(fn((before || {})[field]).map((h) => h.sig));
    for (const h of fn((after || {})[field]).filter((x) => !old.has(x.sig))) {
      why.push(`it adds or changes ${h.label}`);
      lines.push(`Added or changed: ${h.label}`);
    }
  }
  return { why, lines };
}

// ---------- section diffs (pure) ----------
//
// Each returns { sections: [names, in SETS[set].sections order], lines: [plain summary lines], detail: [...] }.
// The list is complete by construction: whatever no named section covers lands in "other", so nothing that
// changes is ever reported as unchanged.

function listDiff(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return { added: b.filter((x) => !sa.has(x)), removed: a.filter((x) => !sb.has(x)) };
}

function names(list, n = 8) {
  return list.length > n ? `${list.slice(0, n).join(', ')} and ${list.length - n} more` : list.join(', ');
}

function clipLine(s, n = 160) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

// A readable middle of two texts: common lines trimmed from both ends, the rest shown -/+ (clipped).
function textDiff(a, b, max = 40) {
  const la = String(a || '').split('\n');
  const lb = String(b || '').split('\n');
  let s = 0;
  while (s < la.length && s < lb.length && la[s] === lb[s]) s += 1;
  let e = 0;
  while (e < la.length - s && e < lb.length - s && la[la.length - 1 - e] === lb[lb.length - 1 - e]) e += 1;
  const out = [];
  const minus = la.slice(s, la.length - e);
  const plus = lb.slice(s, lb.length - e);
  for (const l of minus.slice(0, max)) out.push(`- ${clipLine(l, 200)}`);
  if (minus.length > max) out.push(`- ... ${minus.length - max} more line(s)`);
  for (const l of plus.slice(0, max)) out.push(`+ ${clipLine(l, 200)}`);
  if (plus.length > max) out.push(`+ ... ${plus.length - max} more line(s)`);
  return out;
}

function prettyXml(v) {
  return blank(v) ? '' : String(v).replace(/>\s*</g, '>\n<');
}

function order(set, found) {
  return SETS[set].sections.filter((s) => found.has(s));
}

function diffFlow(oldCd, newCd, { oldDescription = null, newDescription = null } = {}) {
  const found = new Set();
  const lines = [];
  const detail = [];
  const o = flowDef(oldCd);
  const n = flowDef(newCd);
  const ot = o.def.triggers || {};
  const nt = n.def.triggers || {};
  const tnames = [...new Set([...Object.keys(ot), ...Object.keys(nt)])].sort();
  const before = tnames.filter((t) => has(ot, t)).map((t) => triggerText(triggerInfo(t, ot[t]))).join('; ');
  const after = tnames.filter((t) => has(nt, t)).map((t) => triggerText(triggerInfo(t, nt[t]))).join('; ');
  const trigChanged = tnames.some((t) => !has(ot, t) || !has(nt, t) || canonical(triggerCore(ot[t])) !== canonical(triggerCore(nt[t])));
  if (trigChanged) {
    found.add('trigger');
    lines.push(`Trigger CHANGED: ${before || 'none'} -> ${after || 'none'}`);
    for (const t of tnames) detail.push(...textDiff(JSON.stringify(triggerCore(ot[t]), null, 1), JSON.stringify(triggerCore(nt[t]), null, 1)).map((l) => `  trigger ${t} ${l}`));
  } else {
    lines.push(`Trigger unchanged: ${after || 'none'}`);
  }
  const concBefore = tnames.map((t) => concurrencyOf(ot[t])).find(Boolean) || null;
  const concAfter = tnames.map((t) => concurrencyOf(nt[t])).find(Boolean) || null;
  if (tnames.some((t) => canonical((ot[t] || {}).runtimeConfiguration || null) !== canonical((nt[t] || {}).runtimeConfiguration || null))) {
    found.add('concurrency');
    lines.push(`Trigger settings CHANGED: concurrency ${concText(concBefore)} -> ${concText(concAfter)}`);
  }
  const concurrencyAdded = tnames.some((t) => !concurrencyOf(ot[t]) && concurrencyOf(nt[t]));

  const oa = walkActions(o.def.actions);
  const na = walkActions(n.def.actions);
  const { added, removed } = listDiff([...oa.keys()], [...na.keys()]);
  const changed = [];
  const moved = [];
  for (const k of [...na.keys()].filter((x) => oa.has(x))) {
    const x = oa.get(k);
    const y = na.get(k);
    if (canonical(actionCore(x.a)) !== canonical(actionCore(y.a))) changed.push(k);
    else if (x.parent !== y.parent || canonical(x.a.runAfter || null) !== canonical(y.a.runAfter || null)) moved.push(k);
  }
  const touched = changed.length + moved.length + added.length + removed.length;
  if (touched) {
    found.add('actions');
    const parts = [];
    if (changed.length) parts.push(`${changed.length} changed (${names(changed)})`);
    if (moved.length) parts.push(`${moved.length} moved or re-ordered (${names(moved)})`);
    if (added.length) parts.push(`${added.length} added (${names(added)})`);
    if (removed.length) parts.push(`${removed.length} removed (${names(removed)})`);
    lines.push(`Actions: ${oa.size} -> ${na.size}; ${parts.join(', ')}`);
    // What each added or changed step reaches (blind review round 3): method, host, table, operation, child
    // flow, authentication type, connection. Never a secret value.
    const steps = [...added.map((k) => ['+', k]), ...changed.map((k) => ['~', k])];
    for (const [mark, k] of steps.slice(0, 12)) lines.push(`  ${mark} ${actionText(k, actionFacts(na.get(k).a))}`);
    if (steps.length > 12) lines.push(`  ... and ${steps.length - 12} more step(s) (see the detail)`);
    for (const k of changed) {
      detail.push(`  CHANGED ${k}`);
      detail.push(...textDiff(JSON.stringify(actionCore(oa.get(k).a), null, 1), JSON.stringify(actionCore(na.get(k).a), null, 1), 20).map((l) => `      ${l}`));
    }
    for (const k of moved) detail.push(`  MOVED   ${k}: ${oa.get(k).parent || '(top)'} -> ${na.get(k).parent || '(top)'}`);
    for (const k of added) {
      const a = na.get(k).a;
      const op = obj(a.inputs) && obj(a.inputs.host) ? a.inputs.host.operationId : null;
      detail.push(`  ADDED   ${k} [${a.type || '?'}${op ? `/${op}` : ''}] ${clipLine(a.description || '', 90)}`);
    }
    for (const k of removed) detail.push(`  REMOVED ${k}`);
  } else {
    lines.push(`Actions unchanged (${na.size})`);
  }

  const notes = [];
  for (const t of tnames) if (has(ot, t) && has(nt, t) && (ot[t].description || null) !== (nt[t].description || null)) notes.push(`trigger ${t}`);
  for (const k of [...na.keys()].filter((x) => oa.has(x))) if ((oa.get(k).a.description || null) !== (na.get(k).a.description || null)) notes.push(k);
  if (notes.length) {
    found.add('notes');
    lines.push(`Notes changed on: ${names(notes)}`);
  }

  const oc = flowConnections(oldCd);
  const nc = flowConnections(newCd);
  const conn = { added: [], swapped: [], removed: [] };
  for (const [k, r] of Object.entries(nc)) {
    if (!has(oc, k)) conn.added.push(`${k} (${r.logical || r.source || '?'})`);
    else if (oc[k].entry !== r.entry) conn.swapped.push(`${k} (${oc[k].logical || oc[k].source || '?'} -> ${r.logical || r.source || '?'})`);
  }
  for (const k of Object.keys(oc)) if (!has(nc, k)) conn.removed.push(`${k} (${oc[k].logical || '?'})`);
  if (conn.added.length || conn.swapped.length || conn.removed.length) {
    found.add('connections');
    const parts = [];
    if (conn.added.length) parts.push(`added ${names(conn.added)}`);
    if (conn.swapped.length) parts.push(`swapped ${names(conn.swapped)}`);
    if (conn.removed.length) parts.push(`removed ${names(conn.removed)}`);
    lines.push(`Connection references CHANGED: ${parts.join('; ')}`);
  } else {
    lines.push('Connection references unchanged');
  }

  if ((oldDescription || null) !== (newDescription || null)) {
    found.add('description');
    lines.push(`Description: ${clipLine(oldDescription || '(blank)', 70)} -> ${clipLine(newDescription || '(blank)', 70)}`);
  }

  // The residual: everything in clientdata outside triggers, actions and connection references.
  const rest = (cd) => {
    const c = JSON.parse(JSON.stringify(cd || {}));
    if (obj(c.properties)) {
      delete c.properties.connectionReferences;
      if (obj(c.properties.definition)) { delete c.properties.definition.triggers; delete c.properties.definition.actions; }
    }
    return canonical(c);
  };
  if (rest(oldCd) !== rest(newCd)) {
    found.add('other');
    lines.push('Other parts of the definition changed (parameters, outputs or settings; see the detail)');
    // Shown, not summarised (blind review round 3): these parts are not reviewed step by step. Secrets were
    // refused before any diff is made, so nothing printed here is one.
    const restObj = (cd) => JSON.parse(rest(cd));
    detail.push(...textDiff(JSON.stringify(restObj(oldCd), null, 1), JSON.stringify(restObj(newCd), null, 1), 30).map((l) => `  other ${l}`));
  }
  // What each section's change IS, for "was this the same change in the dev copy?" (proven_in, blind review
  // 10/7). Never the raw clientdata: connection reference logical names and ids differ by environment, so a
  // connection change is compared by its keys, and actions by name and type.
  // A step's name, type and the inputs that decide what it reaches (round 3: not name and type alone).
  const typeOf = (m, k) => `${k}:${m.get(k).a.type || '?'}:${canonical(actionFacts(m.get(k).a))}`;
  const filt = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).sort().join(',');
  const shape = {
    trigger: canonical(tnames.filter((t) => has(nt, t)).map((t) => ({ ...triggerInfo(t, nt[t]), filter: filt(triggerInfo(t, nt[t]).filter) }))),
    concurrency: canonical(tnames.map((t) => (nt[t] || {}).runtimeConfiguration || null)),
    actions: canonical({ added: added.map((k) => typeOf(na, k)).sort(), removed: [...removed].sort(), changed: changed.map((k) => typeOf(na, k)).sort(), moved: [...moved].sort() }),
    notes: canonical([...notes].sort()),
    connections: canonical({ added: Object.keys(nc).filter((k) => !has(oc, k)).sort(), swapped: Object.keys(nc).filter((k) => has(oc, k) && oc[k].entry !== nc[k].entry).sort(), removed: Object.keys(oc).filter((k) => !has(nc, k)).sort() }),
    description: newDescription || null,
    other: rest(newCd),
  };
  return {
    sections: order('workflows', found), lines, detail, connections: conn, trigger_changed: trigChanged, concurrency_added: concurrencyAdded, shape,
    steps: [...added, ...changed].map((k) => ({ name: k, facts: actionFacts(na.get(k).a) })),
    // Triggers added or changed (round 4: judged by what they can reach, like steps).
    trigger_steps: tnames.filter((t) => has(nt, t) && (!has(ot, t) || canonical(triggerCore(ot[t])) !== canonical(triggerCore(nt[t]))))
      .map((t) => ({ name: t, facts: actionFacts(nt[t]) })),
  };
}

function viewParts(fetchxml, layoutxml) {
  const f = blank(fetchxml) ? null : parseXml(fetchxml);
  const l = blank(layoutxml) ? null : parseXml(layoutxml);
  const attrs = [];
  if (f) {
    const walk = (node, prefix) => {
      for (const c of node.c) {
        if (typeof c === 'string') continue;
        if (c.n === 'attribute') attrs.push(`${prefix}${c.a.name}`);
        else if (c.n === 'link-entity') walk(c, `${c.a.alias || c.a.name}.`);
        else if (c.n === 'entity') walk(c, '');
      }
    };
    walk(f, '');
  }
  // The WHOLE cell, every attribute (round 3: a script hook such as imageproviderfunctionname sits on the cell,
  // so name and width alone let one be added unseen).
  const cells = l ? els(l, 'cell').map((c) => ({ name: c.a.name, attrs: c.a, kids: c.c })) : [];
  const conds = f ? els(f, 'condition').map((c) => `${c.a.entityname ? `${c.a.entityname}.` : ''}${c.a.attribute} ${c.a.operator}${has(c.a, 'value') ? ` ${c.a.value}` : ''}`) : [];
  // Filters = every filter element plus the shape of every join (a join narrows the rows as much as a filter).
  const filters = f ? canonical([...els(f, 'filter'), ...els(f, 'link-entity').map((x) => ({ n: 'link-entity', a: x.a, c: kids(x, 'filter') }))]) : null;
  const sort = f ? els(f, 'order').map((o) => `${o.a.alias ? `${o.a.alias}.` : ''}${o.a.attribute}${o.a.descending === 'true' ? ' descending' : ''}`) : [];
  const residual = canonical([
    f ? mask(f, { drop: ['attribute', 'filter', 'order'], dropAttrs: { 'link-entity': ['name', 'from', 'to', 'alias', 'link-type', 'visible'] } }) : null,
    l ? mask(l, { drop: ['cell'] }) : null,
  ]);
  return { attrs, cells, conds, filters, sort, residual };
}

function diffView(oldDef, newDef) {
  const found = new Set();
  const lines = [];
  const detail = [];
  const a = viewParts(oldDef.fetchxml, oldDef.layoutxml);
  const b = viewParts(newDef.fetchxml, newDef.layoutxml);
  const ca = a.cells.map((c) => c.name);
  const cb = b.cells.map((c) => c.name);
  const cd = listDiff(ca, cb);
  const fd = listDiff(a.attrs, b.attrs);
  if (canonical(a.cells) !== canonical(b.cells) || canonical(a.attrs) !== canonical(b.attrs)) {
    found.add('columns');
    const parts = [];
    if (cd.added.length) parts.push(`added ${names(cd.added)}`);
    if (cd.removed.length) parts.push(`${cd.removed.length} column${cd.removed.length === 1 ? ' leaves' : 's leave'} the view (${names(cd.removed)})`);
    if (!cd.added.length && !cd.removed.length) parts.push(canonical(ca) !== canonical(cb) ? 'order changed' : 'column settings (width, icon or script) or fetched columns changed');
    lines.push(`Columns: ${parts.join('; ')}`);
    if (fd.added.length || fd.removed.length) detail.push(`  fetched columns: +${fd.added.join(', ') || 'none'} / -${fd.removed.join(', ') || 'none'}`);
    detail.push(`  shown before: ${ca.join(', ') || 'none'}`, `  shown after:  ${cb.join(', ') || 'none'}`);
  } else {
    lines.push(`Columns unchanged (${cb.length})`);
  }
  if (a.filters !== b.filters) {
    found.add('filters');
    const d = listDiff(a.conds, b.conds);
    lines.push(`Filters CHANGED: ${d.added.length ? `adds ${names(d.added, 4)}` : ''}${d.added.length && d.removed.length ? '; ' : ''}${d.removed.length ? `drops ${names(d.removed, 4)}` : ''}${!d.added.length && !d.removed.length ? 'grouping or joins changed' : ''}`);
    detail.push(`  filters before: ${a.conds.join('; ') || 'none'}`, `  filters after:  ${b.conds.join('; ') || 'none'}`);
  } else {
    lines.push('Filters unchanged');
  }
  if (canonical(a.sort) !== canonical(b.sort)) {
    found.add('sort');
    lines.push(`Sort: ${a.sort.join(', ') || 'none'} -> ${b.sort.join(', ') || 'none'}`);
  }
  if ((oldDef.description || null) !== (newDef.description || null)) {
    found.add('description');
    lines.push(`Description: ${clipLine(oldDef.description || '(blank)', 70)} -> ${clipLine(newDef.description || '(blank)', 70)}`);
  }
  if (a.residual !== b.residual) {
    found.add('other');
    lines.push('Other view settings changed (see the detail)');
    detail.push(...textDiff(prettyXml(oldDef.fetchxml), prettyXml(newDef.fetchxml), 20).map((l) => `  fetchxml ${l}`));
    detail.push(...textDiff(prettyXml(oldDef.layoutxml), prettyXml(newDef.layoutxml), 20).map((l) => `  layoutxml ${l}`));
  }
  return { sections: order('savedqueries', found), lines, detail };
}

// Every field a form names (controls, hidden data fields, header and footer): what the publish needs to exist.
function formFields(formxml) {
  const x = parseXml(formxml);
  const out = [];
  const walk = (n) => {
    if (typeof n === 'string') return;
    if (has(n.a, 'datafieldname') && n.a.datafieldname) out.push(n.a.datafieldname);
    n.c.forEach(walk);
  };
  walk(x);
  return [...new Set(out)];
}

// ignore = what the named sections already explain on THIS side: { fields, tabs, sections } (Sets).
function formParts(formxml, ignore = { fields: new Set(), tabs: new Set(), sections: new Set() }) {
  const x = parseXml(formxml);
  const tabs = els(x, 'tab').map((t) => ({ name: t.a.name || t.a.id, label: labelOf(t) }));
  const sections = els(x, 'section').map((s) => ({ name: s.a.name || s.a.id, label: labelOf(s) }));
  const events = canonical([...els(x, 'events'), ...els(x, 'formLibraries')]);
  const residual = canonical(mask(x, {
    drop: ['events', 'formLibraries'],
    dropAttrs: { tab: ['name', 'id'], section: ['name', 'id'], control: ['datafieldname'], data: ['datafieldname'] },
    dropKids: { tab: ['labels'], section: ['labels'] },
    dropIf: (el) => (el.n === 'tab' && ignore.tabs.has(el.a.name || el.a.id)) || (el.n === 'section' && ignore.sections.has(el.a.name || el.a.id))
      || ((el.n === 'cell' || el.n === 'data') && bindsAny(el, ignore.fields)),
    dropEmpty: ['row', 'rows', 'hiddencontrols'],
  }));
  return { tabs, sections, fields: formFields(formxml), events, residual };
}

function namedDiff(kind, a, b, found, section, lines) {
  const an = a.map((t) => t.name);
  const bn = b.map((t) => t.name);
  const d = listDiff(an, bn);
  const relabel = b.filter((t) => a.some((o) => o.name === t.name && o.label !== t.label)).map((t) => `${t.name} (${a.find((o) => o.name === t.name).label || 'no label'} -> ${t.label || 'no label'})`);
  if (d.added.length || d.removed.length || relabel.length || canonical(an) !== canonical(bn)) {
    found.add(section);
    const parts = [];
    if (d.added.length) parts.push(`added ${names(d.added)}`);
    if (d.removed.length) parts.push(`removed ${names(d.removed)}`);
    if (relabel.length) parts.push(`relabelled ${names(relabel, 4)}`);
    if (!parts.length) parts.push('order changed');
    lines.push(`${kind}: ${parts.join('; ')}`);
  }
}

function diffForm(oldDef, newDef) {
  const found = new Set();
  const lines = [];
  const detail = [];
  const a = formParts(oldDef.formxml);
  const b = formParts(newDef.formxml);
  namedDiff('Tabs', a.tabs, b.tabs, found, 'tabs', lines);
  namedDiff('Sections', a.sections, b.sections, found, 'sections', lines);
  const fd = listDiff(a.fields, b.fields);
  if (fd.added.length || fd.removed.length) {
    found.add('fields');
    if (fd.added.length) lines.push(`Fields added to the form: ${names(fd.added)}`);
    // DESIGN.md §10c: removing fields is develop, but the pop-up says what stops ("3 fields leave the form").
    if (fd.removed.length) lines.push(`${fd.removed.length} field${fd.removed.length === 1 ? ' leaves' : 's leave'} the form: ${names(fd.removed)}`);
  } else {
    lines.push(`Fields unchanged (${b.fields.length})`);
  }
  if (a.events !== b.events) {
    found.add('events');
    lines.push('Form scripts or event handlers CHANGED');
  }
  if ((oldDef.description || null) !== (newDef.description || null)) {
    found.add('description');
    lines.push(`Description: ${clipLine(oldDef.description || '(blank)', 70)} -> ${clipLine(newDef.description || '(blank)', 70)}`);
  }
  const tabsD = listDiff(a.tabs.map((t) => t.name), b.tabs.map((t) => t.name));
  const secD = listDiff(a.sections.map((t) => t.name), b.sections.map((t) => t.name));
  const ra = formParts(oldDef.formxml, { fields: new Set(fd.removed), tabs: new Set(tabsD.removed), sections: new Set(secD.removed) }).residual;
  const rb = formParts(newDef.formxml, { fields: new Set(fd.added), tabs: new Set(tabsD.added), sections: new Set(secD.added) }).residual;
  if (ra !== rb) {
    found.add('other');
    lines.push('Layout or other form settings changed (see the detail)');
  }
  if (found.size) detail.push(...textDiff(prettyXml(oldDef.formxml), prettyXml(newDef.formxml), 30).map((l) => `  formxml ${l}`));
  return { sections: order('systemforms', found), lines, detail };
}

// ignore = Ids of areas, groups and pages the named sections already explain on THIS side.
function sitemapParts(xml, ignore = new Set()) {
  const x = parseXml(xml);
  const sig = (n, extra) => ({ name: n.a.Id, label: [labelOf(n), extra ? extra(n) : null].filter(Boolean).join(' / ') || null });
  return {
    areas: els(x, 'Area').map((n) => sig(n)),
    groups: els(x, 'Group').map((n) => sig(n)),
    subareas: els(x, 'SubArea').map((n) => sig(n, (s) => s.a.Entity || s.a.Url || null)),
    residual: canonical(mask(x, {
      dropAttrs: { Area: ['Id'], Group: ['Id'], SubArea: ['Id', 'Entity', 'Url'] },
      dropKids: { Area: ['Titles'], Group: ['Titles'], SubArea: ['Titles'] },
      dropIf: (el) => ['Area', 'Group', 'SubArea'].includes(el.n) && ignore.has(el.a.Id),
    })),
  };
}

function diffSitemap(oldDef, newDef) {
  const found = new Set();
  const lines = [];
  const a = sitemapParts(oldDef.sitemapxml);
  const b = sitemapParts(newDef.sitemapxml);
  namedDiff('Areas', a.areas, b.areas, found, 'areas', lines);
  namedDiff('Groups', a.groups, b.groups, found, 'groups', lines);
  namedDiff('Pages (subareas)', a.subareas, b.subareas, found, 'subareas', lines);
  const ids = (p) => [...p.areas, ...p.groups, ...p.subareas].map((x) => x.name);
  const d = listDiff(ids(a), ids(b));
  if (sitemapParts(oldDef.sitemapxml, new Set(d.removed)).residual !== sitemapParts(newDef.sitemapxml, new Set(d.added)).residual) {
    found.add('other');
    lines.push('Other navigation settings changed (icons, order or options; see the detail)');
  }
  const detail = found.size ? textDiff(prettyXml(oldDef.sitemapxml), prettyXml(newDef.sitemapxml), 30).map((l) => `  sitemapxml ${l}`) : [];
  return { sections: order('sitemaps', found), lines, detail };
}

// The body of a create: the definition plus the fields the engine or the job adds (blind review round 2,
// 10/7: every one of them is shown in the pop-up, so createLines is built from this same body).
function createBody(set, name, def, extra = {}) {
  const base = { name };
  for (const f of SETS[set].fields) if (!blank(def[f])) base[f] = def[f];
  if (set === 'workflows') return { ...base, category: 5, type: 1, primaryentity: 'none' }; // new_flow_job's body, created Off (9/29)
  if (set === 'savedqueries') return { querytype: 0, ...extra, ...base };
  return { type: 2, ...extra, ...base };
}

const EXTRA_LABELS = {
  savedqueries: { querytype: { 0: 'public view', 1: 'advanced find', 2: 'associated view', 4: 'quick find', 64: 'lookup view' } },
  systemforms: { type: { 2: 'main form', 5: 'mobile form', 6: 'quick view form', 7: 'quick create form', 11: 'card form' } },
  workflows: { category: { 5: 'cloud flow' }, type: { 1: 'definition' } },
};

function extraLine(set, body) {
  const shown = new Set(['name', ...SETS[set].fields]);
  const parts = Object.entries(body).filter(([k]) => !shown.has(k)).map(([k, v]) => {
    const label = ((EXTRA_LABELS[set] || {})[k] || {})[v];
    return `${k} ${v}${label ? ` (${label})` : ''}`;
  });
  return parts.length ? `Also sets: ${parts.join(', ')}` : null;
}

// What a NEW component holds, for the pop-up of a create. `body` = createBody(...), so nothing the POST sets
// is left off the pop-up.
function createLines(set, def, body = null) {
  const out = [];
  if (set === 'workflows') {
    const cd = normField(set, 'clientdata', def.clientdata);
    const { def: d } = flowDef(cd);
    const acts = [...walkActions(d.actions).keys()];
    out.push(`Trigger: ${Object.entries(d.triggers || {}).map(([n, t]) => triggerText(triggerInfo(n, t))).join('; ') || 'none'}`);
    out.push(`Actions: ${acts.length}${acts.length ? ` (${names(acts)})` : ''}`);
    const refs = Object.values(flowConnections(cd)).map((r) => r.logical || r.source || '?');
    out.push(`Connection references: ${refs.length ? names([...new Set(refs)]) : 'none'}`);
  } else if (set === 'savedqueries') {
    const p = viewParts(def.fetchxml, def.layoutxml);
    out.push(`Columns: ${p.cells.map((c) => c.name).join(', ') || 'none'}`);
    out.push(`Filters: ${p.conds.join('; ') || 'none'}`);
    if (p.sort.length) out.push(`Sort: ${p.sort.join(', ')}`);
  } else if (set === 'systemforms') {
    const p = formParts(def.formxml);
    out.push(`Tabs: ${p.tabs.length}${p.tabs.length ? ` (${names(p.tabs.map((t) => t.label || t.name))})` : ''}`);
    out.push(`Sections: ${p.sections.length}`);
    out.push(`Fields: ${p.fields.length}${p.fields.length ? ` (${names(p.fields)})` : ''}`);
  }
  if (def.description) out.push(`Description: ${clipLine(def.description, 100)}`);
  const extra = body ? extraLine(set, body) : null;
  if (extra) out.push(extra);
  return out;
}

// Link-entity aliases the view designer generates ("a_" + 32 hex) differ between Donor App Dev and the Donor
// App for the SAME view (read live 10/7: "Active Contacts Donated Today", the same savedqueryid in both, is
// a_a4256f4f... in Dev and a_cf562183... in the Donor App, in fetchxml and layoutxml alike). For comparing a
// dev change with a live one they are renamed by order of appearance. Nothing else is tolerated: the one
// unmanaged contact form identical in both environments carries identical ids, so forms compare as they are.
function normAliases(def) {
  const out = { ...def };
  const aliases = [...new Set((String(def.fetchxml || '').match(/\ba_[0-9a-f]{32}\b/gi) || []).map((x) => x.toLowerCase()))];
  aliases.forEach((a, i) => {
    for (const f of ['fetchxml', 'layoutxml']) if (out[f]) out[f] = out[f].replace(new RegExp(a, 'gi'), `a_link${i + 1}`);
  });
  return out;
}

// One section's content in a definition (views, forms, sitemaps), for "is the dev change the same change?".
function sectionContent(set, def, section) {
  if (section === 'description') return def.description || null;
  if (set === 'savedqueries') {
    const d = normAliases(def);
    const p = viewParts(d.fetchxml, d.layoutxml);
    return canonical({ columns: [p.cells, p.attrs], filters: p.filters, sort: p.sort, other: p.residual }[section]);
  }
  if (set === 'systemforms') {
    const p = formParts(def.formxml);
    return canonical({ tabs: p.tabs, sections: p.sections, fields: [...p.fields].sort(), events: p.events, other: p.residual }[section]);
  }
  const p = sitemapParts(def.sitemapxml);
  return canonical({ areas: p.areas, groups: p.groups, subareas: p.subareas, other: p.residual }[section]);
}

// Was the dev copy's applied plan (its parsed Write Log entry) THE SAME change as this one? (blind review 10/7,
// rounds 1 and 2). The same kind of component, name, mode and sections, AND the same content in every changed
// section: for a view, form or sitemap the dev AFTER definition equals this change's for those sections; for
// a flow, the dev change's own per-section diff equals this change's (trigger, action names and types,
// connection reference keys), never the raw clientdata, whose connection references differ by environment.
// true, or a short reason.
function sameChange({ set, name, mode, sections, diff, after }, e) {
  if (!e || e.mode !== 'component') return 'it was not an app component change';
  const c = e.component || {};
  if (c.set !== set) return `it changed a ${(SETS[c.set] || {}).noun || c.set}, not a ${SETS[set].noun}`;
  if (String(c.name || '').trim() !== name) return `it changed '${c.name}', not '${name}'`;
  if (e.action !== mode) return `it was a ${e.action}, not a ${mode}`;
  const a = [...(e.sections || [])].sort();
  const b = [...sections].sort();
  if (canonical(a) !== canonical(b)) return `it changed ${a.join(', ') || 'nothing'}; this changes ${b.join(', ') || 'nothing'}`;
  if (mode !== 'update') return true;
  const row = (e.rows || [])[0] || {};
  const devBefore = row.before && row.before.definition;
  const devAfter = row.after && row.after.definition;
  if (!devAfter || (set === 'workflows' && !devBefore)) return 'its log entry does not carry the definitions to compare';
  let differ;
  try {
    if (set === 'workflows') {
      const dd = diffFlow(normField(set, 'clientdata', devBefore.clientdata), normField(set, 'clientdata', devAfter.clientdata),
        { oldDescription: devBefore.description || null, newDescription: devAfter.description || null });
      differ = b.filter((s) => dd.shape[s] !== diff.shape[s]);
    } else {
      differ = b.filter((s) => sectionContent(set, devAfter, s) !== sectionContent(set, after, s));
    }
  } catch (err) {
    return `its definitions could not be compared (${String(err.message).slice(0, 80)})`;
  }
  return differ.length ? `its ${differ.join(', ')} ${differ.length === 1 ? 'differs' : 'differ'} from this change's` : true;
}

function diffComponent(set, before, after) {
  if (set === 'workflows') {
    return diffFlow(normField(set, 'clientdata', before.clientdata), normField(set, 'clientdata', after.clientdata), { oldDescription: before.description || null, newDescription: after.description || null });
  }
  if (set === 'savedqueries') return diffView(before, after);
  if (set === 'systemforms') return diffForm(before, after);
  return diffSitemap(before, after);
}

// ---------- the job file (file level, pure) ----------

function checkFlowDefinition(cd, err) {
  if (!obj(cd) || !obj(cd.properties) || !obj(cd.properties.definition)) return err('"definition.clientdata" must be a flow definition: {properties: {definition, connectionReferences}}');
  const d = cd.properties.definition;
  if (!obj(d.triggers) || !Object.keys(d.triggers).length) err('"definition.clientdata": the flow has no trigger');
  if (d.actions !== undefined && !obj(d.actions)) err('"definition.clientdata": actions must be an object');
  if (cd.properties.connectionReferences !== undefined && !obj(cd.properties.connectionReferences)) err('"definition.clientdata": connectionReferences must be an object');
  // Platform limits that failed two live saves on 9/25/26 (a live finding): checked here, before any write.
  for (const [n, t] of Object.entries(d.triggers || {})) if (obj(t) && String(t.description || '').length > 256) err(`trigger ${n}: its note is ${t.description.length} characters; the platform limit is 256`);
  const long = [...walkActions(d.actions).entries()].filter(([, x]) => String(x.a.description || '').length > 256).map(([k]) => k);
  if (long.length) err(`step note(s) over 256 characters (the platform limit): ${names(long, 6)}`);
  const secrets = flowSecrets(cd);
  if (secrets.length) err(secretRefusal(secrets));
  return null;
}

function validateComponentJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!obj(raw)) return { errors: ['the job file must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be exactly "${CONTRACT}"`);
  if (raw.kind !== 'component') err('"kind" must be "component"');
  if (typeof raw.env !== 'string' || !has(envs, raw.env)) err(`"env" must be one of: ${Object.keys(envs).join(', ')}`);
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required (script path, or "claude-session")');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > 500 || /[\r\n]/.test(raw.reason)) err('"reason" must be one line, at most 500 characters');
  const mode = raw.mode;
  if (!MODES.includes(mode)) err(`"mode" must be one of: ${MODES.join(', ')}`);
  const c = raw.component;
  let set = null;
  if (!obj(c)) err('"component" is required: {set, id, name}');
  else {
    for (const k of Object.keys(c)) if (!['set', 'id', 'name'].includes(k)) err(`unknown key "component.${k}"`);
    if (!has(SETS, c.set)) err(`"component.set" must be one of: ${Object.keys(SETS).join(', ')}`);
    else set = c.set;
    if (typeof c.name !== 'string' || !c.name.trim() || /[\r\n]/.test(c.name) || c.name.length > 200) err('"component.name" is required: the component\'s name as the app shows it, one line');
    if (mode === 'create') {
      if (c.id !== undefined && c.id !== null) err('"component.id" is for changing an existing component; a create gets its id from Dataverse');
    } else if (typeof c.id !== 'string' || !GUID.test(c.id)) err('"component.id" must be the component\'s GUID');
  }
  if (set && FLOW_ONLY.has(mode) && set !== 'workflows') err(`mode "${mode}" is for flows only`);
  if (set === 'sitemaps' && mode === 'create') err('a new sitemap belongs to a new app, which is made in the maker portal');

  const needsHash = MODES.includes(mode) && mode !== 'create';
  if (needsHash) {
    if (typeof raw.snapshot_hash !== 'string' || !HASH.test(raw.snapshot_hash)) err('"snapshot_hash" is required: the 64-character hash of the live definition you built from (lib/component.js snapshot)');
  } else if (raw.snapshot_hash !== undefined) err('"snapshot_hash" is for changes to an existing component');
  if (mode === 'create') {
    if (typeof raw.solution !== 'string' || !SOLUTION_NAME.test(raw.solution)) err('"solution" is required for a create: the unique name of an unmanaged SBRM solution');
  } else if (raw.solution !== undefined) err('"solution" is for a create (an existing component stays in its solutions)');
  if (mode === 'own') {
    if (typeof raw.owner !== 'string' || !GUID.test(raw.owner)) err('"owner" must be the new owner\'s systemuser GUID');
  } else if (raw.owner !== undefined) err('"owner" is for mode "own"');
  if (raw.proven_in !== undefined && raw.proven_in !== null) {
    if (mode === 'create') err('"proven_in" is for changes to something live (a create changes nothing that exists)');
    else if (typeof raw.proven_in !== 'string' || !raw.proven_in.trim()) err('"proven_in" must be the dev copy\'s plan id');
  }
  if (raw.publish !== undefined && raw.publish !== true) err('"publish" may only be true: a view, form or sitemap change is always published (an unpublished change reaches nobody)');

  // The definition.
  let def = null;
  const d = raw.definition;
  if (mode === 'create' || mode === 'update') {
    if (!obj(d) || !Object.keys(d).length) err('"definition" is required for a create or an update');
    else if (set) {
      const spec = SETS[set];
      const extra = mode === 'create' ? { savedqueries: ['returnedtypecode', 'querytype'], systemforms: ['objecttypecode', 'type'] }[set] || [] : [];
      const allowed = [...spec.fields, ...extra];
      for (const k of Object.keys(d)) if (!allowed.includes(k)) err(`unknown key "definition.${k}" for a ${spec.noun} ${mode} (allowed: ${allowed.join(', ')})`);
      def = {};
      const core = spec.fields.filter((f) => f !== 'description');
      if (mode === 'create') for (const f of core) if (blank(d[f])) err(`"definition.${f}" is required for a new ${spec.noun}`);
      if (mode === 'update' && !Object.keys(d).length) err('"definition" names nothing to change');
      for (const f of Object.keys(d).filter((k) => allowed.includes(k))) {
        const v = d[f];
        if (f === spec.json) {
          let cd = v;
          if (typeof v === 'string') { try { cd = JSON.parse(v); } catch { err('"definition.clientdata" is not valid JSON'); continue; } }
          checkFlowDefinition(cd, err);
          def[f] = JSON.stringify(cd);
        } else if (has(spec.xml, f)) {
          if (typeof v !== 'string' || !v.trim()) { err(`"definition.${f}" must be the XML text`); continue; }
          try {
            const root = parseXml(v);
            if (root.n !== spec.xml[f]) err(`"definition.${f}" must have <${spec.xml[f]}> as its root, not <${root.n}>`);
          } catch (e) { err(`"definition.${f}" is ${e.message}`); continue; }
          def[f] = v;
        } else if (f === 'description') {
          if (v !== null && typeof v !== 'string') err('"definition.description" must be text or null');
          else if (set === 'workflows' && String(v || '').length > 1024) err(`"definition.description" is ${v.length} characters; a flow's Description is limited to 1024 (a live finding)`);
          else def[f] = v === '' ? null : v;
        } else if (f === 'returnedtypecode' || f === 'objecttypecode') {
          if (typeof v !== 'string' || !IDENT.test(v)) err(`"definition.${f}" must be the table's logical name`);
          else def[f] = v;
        } else if (!Number.isInteger(v) || v < 0) err(`"definition.${f}" must be a whole number`);
        else def[f] = v;
      }
      if (mode === 'create' && set === 'savedqueries' && !has(d, 'returnedtypecode')) err('"definition.returnedtypecode" is required for a new view: the table it lists');
      if (mode === 'create' && set === 'systemforms' && !has(d, 'objecttypecode')) err('"definition.objecttypecode" is required for a new form: the table it shows');
    }
  } else if (d !== undefined) err(`"definition" is for a create or an update, not "${mode}"`);

  // Intent: what Claude says the job does, checked against the file here and against the engine's own diff at plan.
  const intent = raw.intent;
  if (!obj(intent)) err('"intent" is required: {verb, component, name, changed}');
  else if (!errors.length) {
    const mism = [];
    const noun = SETS[set].noun;
    for (const k of Object.keys(intent)) if (!['verb', 'component', 'name', 'changed'].includes(k)) mism.push(`unknown key "${k}"`);
    if (intent.verb !== mode) mism.push(`verb says "${intent.verb}", the file's mode is "${mode}"`);
    if (intent.component !== noun) mism.push(`component says "${intent.component}", the file changes a ${noun}`);
    if (typeof intent.name !== 'string' || intent.name.trim() !== c.name.trim()) mism.push(`name says "${intent.name}", the file names "${c.name.trim()}"`);
    if (mode === 'update') {
      if (!Array.isArray(intent.changed) || !intent.changed.length) mism.push(`changed must list what changes, from: ${SETS[set].sections.join(', ')}`);
      else {
        const bad = intent.changed.filter((x) => !SETS[set].sections.includes(x));
        if (bad.length) mism.push(`changed names ${bad.join(', ')}; a ${noun} has: ${SETS[set].sections.join(', ')}`);
        if (new Set(intent.changed).size !== intent.changed.length) mism.push('changed lists a section twice');
      }
    } else if (intent.changed !== undefined && !(Array.isArray(intent.changed) && !intent.changed.length)) {
      mism.push(`changed is for an update; a "${mode}" changes no definition sections`);
    }
    if (mism.length) err(`intent does not match the job (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }
  if (errors.length) return { errors };
  return {
    errors: [],
    job: {
      contract: CONTRACT, kind: 'component', env: raw.env, mode,
      component: { set, id: mode === 'create' ? null : c.id.toLowerCase(), name: c.name.trim() },
      definition: def, owner: raw.owner ? raw.owner.toLowerCase() : null, snapshot_hash: raw.snapshot_hash || null,
      solution: raw.solution || null, proven_in: raw.proven_in ? raw.proven_in.trim() : null,
      source: raw.source.trim(), reason: raw.reason.trim(), intent,
    },
  };
}

// ---------- live reads ----------

function q(s) {
  return String(s).replace(/'/g, "''");
}

function filterPath(set, select, filter) {
  return `${set}?$select=${select}&$filter=${encodeURIComponent(filter)}`;
}

// Only Dataverse's own "does not exist" means a component is gone (blind review 10/7: any read error used to
// count, so a delete whose read-back hit a throttle or an outage was logged as written).
function isNotFound(e) {
  return e instanceof DataverseError && (e.code === '0x80040217' || e.status === 404);
}

// The component as it stands: { definition, name, statecode, statuscode, owner, table, managed, category, etag },
// or null when Dataverse says it does not exist. Any other read error is thrown, never read as "gone".
function readComponent(dv, set, id) {
  const spec = SETS[set];
  let row;
  try {
    row = dv.get(`${set}(${id})?$select=${spec.select}`, { formatted: true });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  return {
    id: String(row[spec.id] || id).toLowerCase(),
    name: row[spec.name] === undefined ? null : row[spec.name],
    definition: Object.fromEntries(spec.fields.map((f) => [f, blank(row[f]) ? null : row[f]])),
    managed: row.ismanaged === true,
    category: row.category === undefined ? null : row.category,
    statecode: row.statecode === undefined ? null : row.statecode,
    statuscode: row.statuscode === undefined ? null : row.statuscode,
    owner: row._ownerid_value ? { id: String(row._ownerid_value).toLowerCase(), name: row['_ownerid_value@OData.Community.Display.V1.FormattedValue'] || row._ownerid_value } : null,
    table: spec.table ? row[spec.table] || null : null,
    etag: row['@odata.etag'] || null,
  };
}

// Unpublished drafts (blind review 10/7). A view, form or sitemap edited in the maker portal and saved but not
// published keeps the edit in an unpublished layer: a plain GET, and so the snapshot hash and the logged
// before, see only the PUBLISHED definition, while a PATCH replaces the draft (lost for good) and PublishXml on
// a table publishes every pending edit on it, other people's included. RetrieveUnpublishedMultiple returns every
// component's latest layer (read live in Donor App Dev 10/7: forms, views AND sitemaps answer it; 42 contact
// forms and 74 contact views, none differing from published), so a draft is a component whose unpublished
// definition differs from its published one, or that exists only unpublished.
// [{ id, name }] for one component (`id`) or every component on a table (`table`).
function draftsFor(dv, set, { table = null, id = null }) {
  const spec = SETS[set];
  const sel = `${spec.id},${spec.name},${spec.fields.join(',')}`;
  const f = id ? `${spec.id} eq ${id}` : `${spec.table} eq '${q(table)}'`;
  const un = dv.get(`${set}/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${sel}&$filter=${encodeURIComponent(f)}`).value || [];
  if (!un.length) return [];
  const pub = new Map((dv.get(filterPath(set, sel, f)).value || []).map((r) => [String(r[spec.id]).toLowerCase(), r]));
  const out = [];
  for (const u of un) {
    const uid = String(u[spec.id]).toLowerCase();
    const p = pub.get(uid);
    let differs = true;
    try { differs = !p || snapshot(set, u).hash !== snapshot(set, p).hash; } catch { differs = true; } // unparseable = not provably the same
    if (differs) out.push({ id: uid, name: u[spec.name] || uid });
  }
  return out;
}

// The drafts a change must respect: the TARGET's own (refused: a write would destroy it) and, when the apply
// publishes a whole table, the OTHER components on that table (their edits go live with ours: a warning).
// PublishXml on a table publishes everything pending on it, its FORMS and its VIEWS alike (blind review round
// 2, 10/7: publishing for a view used to look only at the table's other views), so both are read.
function draftState(dv, set, mode, id, table) {
  if (set === 'workflows') return { target: [], others: [] };
  const target = id && ['update', 'delete'].includes(mode) ? draftsFor(dv, set, { id }) : [];
  const others = SETS[set].table && table && ['update', 'create'].includes(mode)
    ? ['systemforms', 'savedqueries'].flatMap((s) => draftsFor(dv, s, { table }).filter((d) => d.id !== id).map((d) => ({ ...d, name: `the ${SETS[s].noun} '${d.name}'` })))
    : [];
  return { target, others };
}

// The toolkit's own tables (who may write, the Write Log, the events), by logical name: their rows change
// only with admin access (lib/resolve.js), and so do the views, forms, sitemaps and flows built on them
// (blind review round 2, 10/7). Derived from lib/access.js's entity set names so the two lists cannot drift.
const TOOLKIT_TABLES = [...TOOLKIT_SETS].map((s) => s.replace(/(ss)es$|s$/, '$1'));
const TOOLKIT_MENTION = new RegExp(`\\b(${TOOLKIT_TABLES.join('|')})`, 'gi');

// Which toolkit tables a change touches: a view's or form's own table; any a sitemap or flow definition names
// (a sitemap page on it, a flow triggered by it or writing to it).
function toolkitTables(set, table, def) {
  if (SETS[set].table) return table && TOOLKIT_TABLES.includes(table) ? [table] : [];
  const text = Object.values(def || {}).filter((v) => typeof v === 'string').join('\n');
  return [...new Set((text.match(TOOLKIT_MENTION) || []).map((x) => x.toLowerCase()))].sort();
}

function draftRefusal(name) {
  return `'${name}' has unpublished edits; publish or discard them in the maker portal first (this change would overwrite them, and the log could not keep them)`;
}

// state = what the log keeps of a component (before and after): the definition in full plus its switches.
function stateOf(c) {
  return c ? { name: c.name, definition: c.definition, statecode: c.statecode, statuscode: c.statuscode, owner: c.owner, table: c.table } : null;
}

// Who a flow runs as: the owners of the connection references its definition names (the earlier Python component tool
// 547-552). [{ key, logical, display, owner, owner_id, connected, active, missing, invoker }].
function runsAs(dv, cd) {
  const refs = flowConnections(cd);
  const logicals = [...new Set(Object.values(refs).map((r) => r.logical).filter(Boolean))];
  const rows = new Map();
  for (let i = 0; i < logicals.length; i += 20) {
    const f = logicals.slice(i, i + 20).map((l) => `connectionreferencelogicalname eq '${q(l)}'`).join(' or ');
    for (const r of dv.get(filterPath('connectionreferences', 'connectionreferencelogicalname,connectionreferencedisplayname,connectionid,statecode,_ownerid_value', f), { formatted: true }).value || []) {
      rows.set(String(r.connectionreferencelogicalname).toLowerCase(), r);
    }
  }
  return Object.entries(refs).map(([key, r]) => {
    if (r.source === 'invoker') return { key, logical: r.logical, invoker: true, owner: 'the person who runs it' };
    const row = r.logical ? rows.get(r.logical.toLowerCase()) : null;
    if (!row) return { key, logical: r.logical, missing: true, owner: null };
    return {
      key, logical: r.logical, display: row.connectionreferencedisplayname || r.logical,
      owner: row['_ownerid_value@OData.Community.Display.V1.FormattedValue'] || row._ownerid_value || 'unknown',
      owner_id: row._ownerid_value ? String(row._ownerid_value).toLowerCase() : null,
      connected: Boolean(row.connectionid), active: row.statecode === 0,
    };
  });
}

function runsAsText(list) {
  if (!list || !list.length) return 'no connections (built-in steps only)';
  const owners = [...new Set(list.map((r) => (r.missing ? `a missing connection reference (${r.logical})` : r.owner)))];
  return owners.join(' and ');
}

// Active flows whose definitions name this flow's id: they call it, so turning it off makes them fail.
function callersOf(dv, id) {
  try {
    return (dv.get(filterPath('workflows', 'workflowid,name', `category eq 5 and statecode eq 1 and contains(clientdata,'${q(id)}')`)).value || [])
      .filter((w) => String(w.workflowid).toLowerCase() !== id).map((w) => w.name).sort();
  } catch (e) {
    if (e instanceof DataverseError) return null;
    throw e;
  }
}

function existingByName(dv, set, name, table) {
  const spec = SETS[set];
  const f = set === 'workflows' ? `name eq '${q(name)}' and category eq 5`
    : `name eq '${q(name)}' and ${spec.table} eq '${q(table)}'`;
  return dv.get(filterPath(set, `${spec.id},name`, f)).value || [];
}

function tableFields(dv, logical) {
  try {
    return new Set((dv.get(`EntityDefinitions(LogicalName='${logical}')/Attributes?$select=LogicalName`).value || []).map((a) => a.LogicalName));
  } catch (e) {
    if (e instanceof DataverseError) return null;
    throw e;
  }
}

function readSolution(dv, envInfo, uniquename) {
  const rows = dv.get(filterPath('solutions', 'solutionid,uniquename,friendlyname,ismanaged,_publisherid_value', `uniquename eq '${q(uniquename)}'`)).value || [];
  if (rows.length !== 1) return { why: `there is no solution "${uniquename}" in the ${envInfo.name}`, code: 'invalid_job' };
  const s = rows[0];
  if (s.ismanaged) return { why: `the solution "${uniquename}" is managed; nothing is ever added to a managed solution (the change rules)`, code: 'not_permitted' };
  if (!envInfo.publisher) return { why: `envs.json names no SBRM publisher for the ${envInfo.name}`, code: 'engine_bug' };
  if (String(s._publisherid_value || '').toLowerCase() !== String(envInfo.publisher).toLowerCase()) {
    return { why: `the solution "${uniquename}" is not under the SBRM publisher; SBRM's own changes go only in SBRM-publisher solutions`, code: 'not_permitted' };
  }
  return { solution: { id: String(s.solutionid).toLowerCase(), uniquename: s.uniquename, name: s.friendlyname || s.uniquename } };
}

// ---------- levels and severity (pure, from the plan's facts) ----------

// The level a change needs (ruled 10/7, DESIGN.md §10k): develop, except delete, a flow definition that adds
// or swaps a connection reference, and a changed trigger on a flow that is on, which are admin.
function needFor(f) {
  const why = [];
  if (f.mode === 'delete') why.push(`it deletes the ${f.noun}`);
  // A flow only acts on a toolkit table once it exists, changes, or is turned on; turning it off or handing it
  // over adds nothing it can do.
  if ((f.toolkit || []).length && (f.set !== 'workflows' || ['create', 'update', 'on'].includes(f.mode))) {
    why.push(`it touches the toolkit's own ${f.toolkit.join(', ')} (who may write, the Write Log, the events), which only an admin changes`);
  }
  if (f.set === 'workflows' && f.mode === 'update') {
    if (f.connections_added) why.push('it adds or swaps a connection reference (the flow would act through different connections)');
    if (f.trigger_changed && f.live_on) why.push('it changes the trigger of a flow that is on');
    // Round 3: parameters, outputs and anything else outside the trigger, steps and connections are not
    // reviewed step by step, so a change there is an admin's.
    if ((f.sections || []).includes('other')) why.push('it changes parts of the flow outside its trigger, steps and connections');
  }
  // Round 3: a flow acts as its owner (its trigger subscription runs as the owner), so handing one over changes
  // who it acts as.
  if (f.set === 'workflows' && f.mode === 'own') why.push('it changes who owns the flow, and a flow acts as its owner');
  // Round 3: what a step, script, control or page can REACH (lib: stepPower, markupPower).
  for (const p of f.power || []) why.push(p);
  return { level: why.length ? 'admin' : 'develop', why };
}

function severityFor(f, warnRows) {
  const irreversible = [];
  const lasting = [];
  const what = `the ${f.noun} '${f.name}'`;
  if (f.mode === 'create') lasting.push(`creates ${what}${f.set === 'workflows' ? ' (Off)' : ''}`);
  if (f.mode === 'delete') irreversible.push(`deletes ${what}${f.set === 'workflows' ? ' and its run history' : ''} (its full definition stays in the Write Log)`);
  if (f.set === 'workflows' && f.mode === 'update') {
    const live = ['trigger', 'concurrency', 'actions', 'connections'].filter((s) => f.sections.includes(s));
    if (f.live_on && live.length) irreversible.push(`changes the ${live.join(', ')} of ${what} while it is on; whatever it does before a revert stays done`);
    if (f.concurrency_added) irreversible.push(`adds trigger concurrency to ${what}, which the platform never lets anyone remove`);
    if ((f.sections || []).includes('other')) irreversible.push(`changes parts of ${what} outside its trigger, steps and connections (parameters, outputs or settings), shown in the detail`);
  }
  if (f.mode === 'on') irreversible.push(`turning on ${what} starts it running and acting as ${f.runs_as_text}`);
  if ((f.other_drafts || []).length) irreversible.push(`publishing ${f.table} also publishes unpublished edits to: ${names(f.other_drafts)}`);
  return severity.assess({ count: 1, noun: 'components', lasting, irreversible, unproven: f.unproven || null }, { warnRows });
}

// What a change is, worked out from a live read and the definition to be written; plan and apply both use
// it, so apply never trusts the plan's own account of the change (blind review 10/7: a plan file edited by
// hand could otherwise lower the level it needs or the warnings it shows).
//   live      readComponent(...) or null (create)
//   written   the definition the write leaves (update: live + the body; create: the new definition) or null
// Returns { facts, diff, flow, typed }. READS ONLY.
function describe(dv, { mode, set, name, table, id, live, written, unproven, carried = null, extra = {}, me = null }) {
  const spec = SETS[set];
  let diff = { sections: [], lines: [], detail: [] };
  if (mode === 'update') diff = diffComponent(set, live.definition, written);
  else if (mode === 'create') diff = { sections: [], lines: createLines(set, written, createBody(set, name, written, extra || {})), detail: [] };
  diff.lines = [...diff.lines];
  const power = [];
  if (set !== 'workflows' && (mode === 'update' || mode === 'create')) {
    const m = markupPower(set, live ? live.definition : null, written);
    power.push(...m.why);
    diff.lines.push(...m.lines);
  }
  let flow = null;
  if (set === 'workflows') {
    const cd = JSON.parse((written || live.definition).clientdata || '{}');
    const ra = runsAs(dv, cd);
    if (mode === 'update' || mode === 'create') {
      // Every step a create adds, and every step an update adds or changes, judged by what it can reach.
      const steps = mode === 'create'
        ? [...walkActions(flowDef(cd).def.actions).entries()].map(([k, x]) => ({ name: k, facts: actionFacts(x.a) }))
        : (diff.steps || []);
      if (mode === 'create') for (const s of steps.slice(0, 12)) diff.lines.push(`  + ${actionText(s.name, s.facts)}`);
      for (const s of steps) power.push(...stepPower(s.name, s.facts, ra, me));
      const triggers = mode === 'create'
        ? Object.entries(flowDef(cd).def.triggers || {}).filter(([, t]) => obj(t)).map(([n, t]) => ({ name: n, facts: actionFacts(t) }))
        : (diff.trigger_steps || []);
      for (const t of triggers) power.push(...triggerPower(t.name, t.facts, ra, me));
    }
    let triggerRunas = null;
    if (mode === 'own' && id) {
      // What the trigger subscription runs as, shown with an owner change (round 3).
      triggerRunas = (dv.get(filterPath('callbackregistrations', 'name,runas', `name eq '${q(id)}'`)).value || []).map((c) => c.runas);
    }
    flow = {
      trigger_runas: triggerRunas,
      live_on: live ? live.statecode === 1 : false,
      runs_as: ra, runs_as_text: runsAsText(ra),
      trigger: Object.entries(flowDef(cd).def.triggers || {}).map(([n, t]) => triggerInfo(n, t)),
      trigger_changed: Boolean(diff.trigger_changed), concurrency_added: Boolean(diff.concurrency_added),
      connections: diff.connections || { added: [], swapped: [], removed: [] },
      concurrency_carried: carried,
      callers: mode === 'off' ? callersOf(dv, id) : null,
      owner: live ? live.owner : null,
    };
  }
  const drafts = draftState(dv, set, mode, id, table);
  const facts = {
    mode, set, noun: spec.noun, name, table, sections: diff.sections,
    live_on: flow ? flow.live_on : false, trigger_changed: flow ? flow.trigger_changed : false,
    connections_added: flow ? Boolean(flow.connections.added.length || flow.connections.swapped.length) : false,
    concurrency_added: flow ? flow.concurrency_added : false, runs_as_text: flow ? flow.runs_as_text : null,
    target_drafts: drafts.target.map((d) => d.name), other_drafts: drafts.others.map((d) => d.name),
    toolkit: toolkitTables(set, table, written || (live ? live.definition : {})),
    power: [...new Set(power)],
    unproven: unproven || null,
  };
  // What the person types to approve a delete: the component's LIVE name, or its id when it has none
  // (blind review 10/7: a blank name made the phrase null, and a null phrase is no typed step at all).
  const typed = mode === 'delete' ? (severity.typedPhrase([name]) || id) : null;
  return { facts, diff, flow, typed };
}

// ---------- plan ----------

function title(plan) {
  const c = plan.component;
  const on = c.table ? ` (${c.table})` : '';
  const what = `the ${c.noun} '${c.name}'${on}`;
  if (plan.mode === 'create') return `Create ${what} in the ${plan.app}${c.noun === 'flow' ? ', Off,' : ''} in solution ${plan.solution.name}`;
  if (plan.mode === 'update') return `Change ${what} in the ${plan.app}`;
  if (plan.mode === 'on') return `Turn on ${what} in the ${plan.app}`;
  if (plan.mode === 'off') return `Turn off ${what} in the ${plan.app}`;
  if (plan.mode === 'own') return `Hand ${what} in the ${plan.app} over to ${plan.owner_to.name}`;
  return `Delete ${what} from the ${plan.app}`;
}

// The would-be log entry, for the size check (the entry must fit one Write Log row, DESIGN.md §10e).
function entryFor(plan, { time, planId, person, outcome, rows }) {
  return {
    time, plan_id: planId, person, env: plan.env, app: plan.app,
    table: `${plan.component.set}${plan.component.table ? ` (${plan.component.table})` : ''}`.slice(0, 100),
    // sections: what the change changed, so a later `proven_in` can be checked as the SAME change (lib/proven.js).
    mode: 'component', action: plan.mode, component: plan.component, sections: plan.diff.sections, source: plan.source, reason: plan.reason, approval: 'dialog',
    left_out: [], headline: title(plan), outcome, rows, reverts_plan_id: plan.reverts_plan_id || null,
  };
}

function changesFor(plan) {
  return plan.diff.lines.map((l) => ({ label: plan.component.noun, new_text: l }));
}

async function planComponent(dv, job, ctx) {
  return planCore(dv, job, ctx, {});
}

async function planCore(dv, job, { envs, access, warnRows = severity.DEFAULT_WARN_ROWS, readEnv }, { revertOf = null } = {}) {
  const envInfo = envs[job.env];
  const spec = SETS[job.component.set];
  const set = job.component.set;
  const identity = whoAmI(dv);
  if (!identity.email) throw new PlanRefused(['could not read your email from Dataverse; access cannot be checked'], 'no_identity');
  const acc = accessFor(resolveAccess(access, dv, job.env), identity.email, job.env);
  if (!atLeast(acc.level, 'develop')) {
    throw new PlanRefused([`changing the app (views, forms, sitemaps, flows) takes develop access in the ${envInfo.name}; ${identity.fullname} has ${acc.level}. Ask Dylan if this should change.`],
      atLeast(acc.level, 'write') ? 'not_permitted' : 'access_read');
  }

  let live = null;
  let solution = null;
  let table = null;
  let after = null;
  let carried = null;
  if (job.mode === 'create') {
    const s = readSolution(dv, envInfo, job.solution);
    if (s.why) throw new PlanRefused([s.why], s.code);
    solution = s.solution;
    table = spec.table ? job.definition[spec.table] : null;
    if (table && !tableFields(dv, table)) throw new PlanRefused([`there is no table "${table}" in the ${envInfo.name}`], 'table_missing');
    if (existingByName(dv, set, job.component.name, table).length) {
      throw new PlanRefused([`a ${spec.noun} named '${job.component.name}'${table ? ` on ${table}` : ''} already exists in the ${envInfo.name}; this never makes a second (change that one instead)`], 'invalid_job');
    }
    after = Object.fromEntries(spec.fields.map((f) => [f, blank(job.definition[f]) ? null : job.definition[f]]));
  } else {
    live = readComponent(dv, set, job.component.id);
    if (!live) throw new PlanRefused([`there is no ${spec.noun} ${job.component.id} in the ${envInfo.name}`], 'invalid_job');
    if (live.managed) throw new PlanRefused([`'${live.name}' is a MANAGED ${spec.noun} (Microsoft's or a vendor's layer); managed components are never changed (the change rules). Make our own copy instead.`], 'not_permitted');
    if (set === 'workflows' && live.category !== 5) throw new PlanRefused([`'${live.name}' is not a cloud flow (category ${live.category}); business rules and classic workflows are changed in the maker portal`], 'invalid_job');
    if (String(live.name || '').trim() !== job.component.name) {
      throw new PlanRefused([`the job calls this ${spec.noun} '${job.component.name}', but ${job.component.id} is named '${live.name}'. Check the id.`], 'invalid_job');
    }
    let now;
    try {
      now = hashDef(set, live.id, live.definition);
    } catch (e) {
      throw new PlanRefused([`the live definition of '${live.name}' could not be read: ${e.message}`], 'engine_bug');
    }
    if (now !== job.snapshot_hash) {
      throw new PlanRefused([revertOf
        ? `'${live.name}' has changed since plan ${revertOf} wrote it, so a revert would overwrite someone's later change. Read it again and decide what it should be.`
        : `the live definition of '${live.name}' has changed since the snapshot this job was built from (snapshot ${job.snapshot_hash.slice(0, 12)}, live now ${now.slice(0, 12)}). Read it again and rebuild the change.`], 'snapshot_moved');
    }
    table = live.table;
    if (job.mode === 'update') {
      after = { ...live.definition, ...job.definition };
      if (set === 'workflows' && live.definition.clientdata) {
        const cd = JSON.parse(after.clientdata);
        carried = carryConcurrency(JSON.parse(live.definition.clientdata), cd);
        if (carried) after.clientdata = JSON.stringify(cd);
      }
      if (sameDef(set, live.definition, after)) {
        throw new PlanRefused([carried
          ? `the only difference is trigger concurrency, which the platform never lets anyone remove once set (a live finding), so '${live.name}' cannot go back further than it is now`
          : `'${live.name}' already has this definition (nothing to change)`], 'every_row_refused');
      }
    }
  }

  // A plain-text secret in the flow, before or after, is never copied into a plan, a pop-up or the Write Log
  // (round 3). Checked first, so no later step stores or prints the definition.
  if (set === 'workflows') {
    const where = secretsIn(live ? live.definition : null, after);
    if (where.length) throw new PlanRefused([secretRefusal(where)], 'invalid_job');
  }

  // Mode-specific checks.
  let ownerTo = null;
  if (job.mode === 'on' && live.statecode === 1) throw new PlanRefused([`'${live.name}' is already on`], 'every_row_refused');
  if (job.mode === 'off' && live.statecode !== 1) throw new PlanRefused([`'${live.name}' is already off`], 'every_row_refused');
  if (job.mode === 'delete' && set === 'workflows' && live.statecode === 1) throw new PlanRefused([`'${live.name}' is on; turn it off first (a separate approval), then delete it`], 'invalid_job');
  if (job.mode === 'own') {
    if (live.owner && live.owner.id === job.owner) throw new PlanRefused([`'${live.name}' is already owned by ${live.owner.name}`], 'every_row_refused');
    let u;
    try { u = dv.get(`systemusers(${job.owner})?$select=fullname,isdisabled`); } catch (e) {
      if (!(e instanceof DataverseError)) throw e;
      throw new PlanRefused([`there is no user ${job.owner} in the ${envInfo.name}`], 'invalid_job');
    }
    if (u.isdisabled) throw new PlanRefused([`${u.fullname} is a disabled user; a flow owned by them stops working`], 'invalid_job');
    ownerTo = { id: job.owner, name: u.fullname };
  }

  // A form's fields must exist on its table, so the publish cannot fail on a missing column (DESIGN.md §10b).
  if (set === 'systemforms' && after) {
    const have = tableFields(dv, table);
    if (!have) throw new PlanRefused([`there is no table "${table}" in the ${envInfo.name}`], 'table_missing');
    const missing = formFields(after.formxml).filter((f) => !have.has(f));
    if (missing.length) throw new PlanRefused([`the form names field(s) that ${table} does not have: ${missing.join(', ')}`], 'invalid_job');
  }

  // Flow notes (the app developer, 9/25/26, carried from the earlier Python component tool check_notes): a changed
  // trigger carries a changed note, and an added step of a kind that can fail carries a note. Not on a revert.
  if (set === 'workflows' && after && !revertOf) {
    const nd = flowDef(JSON.parse(after.clientdata)).def;
    const od = live ? flowDef(JSON.parse(live.definition.clientdata || '{}')).def : { triggers: {}, actions: {} };
    const bad = [];
    for (const [n, t] of Object.entries(nd.triggers || {})) {
      const o = (od.triggers || {})[n];
      if (job.mode === 'create' && !t.description) bad.push(`trigger ${n} needs a note (its description, at most 256 characters)`);
      if (o && canonical(triggerCore(o)) !== canonical(triggerCore(t)) && (o.description || '') === (t.description || '')) bad.push(`trigger ${n} changed but its note did not: say what changed, why, and where the docs are`);
    }
    const old = walkActions(od.actions);
    const bare = [...walkActions(nd.actions).entries()].filter(([k, x]) => !old.has(k) && !x.a.description && (job.mode === 'create' || NOTE_TYPES.has(x.a.type))).map(([k]) => k);
    if (bare.length) bad.push(`added step(s) with no note: ${names(bare, 6)}`);
    if (bad.length) throw new PlanRefused(bad, 'invalid_job');
  }

  // The change as the engine sees it: the diff, who a flow runs as, the drafts it would touch.
  const createExtra = job.mode === 'create' ? Object.fromEntries(Object.entries(job.definition).filter(([k]) => !spec.fields.includes(k))) : null;
  const { facts, diff, flow, typed } = describe(dv, {
    mode: job.mode, set, name: live ? live.name : job.component.name, table, id: live ? live.id : null, live, written: after, carried, extra: createExtra,
    me: identity.systemuserid,
  });
  if (facts.target_drafts.length) throw new PlanRefused([draftRefusal(live.name)], 'invalid_job');

  if (flow) {
    const missing = flow.runs_as.filter((r) => r.missing).map((r) => r.logical || r.key);
    if (missing.length && (job.mode === 'create' || job.mode === 'update' || job.mode === 'on')) {
      throw new PlanRefused([`the definition names connection reference(s) that do not exist in the ${envInfo.name}: ${missing.join(', ')}`], 'invalid_job');
    }
    if (job.mode === 'create' || job.mode === 'on') {
      const dead = flow.runs_as.filter((r) => !r.invoker && !r.missing && (!r.connected || !r.active)).map((r) => r.logical);
      if (dead.length) throw new PlanRefused([`connection reference(s) ${dead.join(', ')} are inactive or have no connection; the flow could not run`], 'invalid_job');
    }
  }

  // Intent: the sections Claude said change, against the engine's own diff (the §6b.1 rule).
  if (job.mode === 'update' && !revertOf) {
    const said = [...job.intent.changed].sort();
    const got = [...diff.sections].sort();
    if (canonical(said) !== canonical(got)) {
      throw new PlanRefused([`intent does not match the change: intent says ${said.join(', ')}; the definition changes ${got.join(', ') || 'nothing'}`], 'intent_mismatch');
    }
  }

  // Tried in the dev copy first? Only if the cited plan was THIS change (blind review 10/7: any applied plan
  // id used to silence the line): same kind of component, same name, same mode, the same sections changed.
  const matches = (e) => sameChange({ set, name: job.component.name, mode: job.mode, sections: diff.sections, diff, after }, e);
  facts.unproven = job.mode === 'create' ? null : unprovenPhrase({ env: job.env, envs, provenIn: job.proven_in, readEnv, matches });
  const need = needFor(facts);
  if (!atLeast(acc.level, need.level)) {
    throw new PlanRefused([`this change takes admin access in the ${envInfo.name} because ${need.why.join(', and ')}; ${identity.fullname} has ${acc.level}. Ask Dylan.`], 'not_permitted');
  }

  const plan = {
    contract: CONTRACT, kind: 'component', env: job.env, host: envInfo.host, app: envInfo.name, mode: job.mode,
    source: job.source, reason: job.reason, intent: job.intent, identity, access: acc.level, cli_version: dv.cliVersion || null,
    severity: severityFor(facts, warnRows), refused: [],
    component: { set, id: live ? live.id : null, name: job.component.name, noun: spec.noun, table },
    facts, need: need.level, need_why: need.why,
    before: stateOf(live), before_hash: live ? job.snapshot_hash : null,
    after_definition: after, sent_fields: job.mode === 'update' ? Object.keys(job.definition).concat(carried && !job.definition.clientdata ? ['clientdata'] : []) : null,
    create_extra: createExtra,
    solution, owner_to: ownerTo, diff, flow,
    publish: ['update', 'create'].includes(job.mode) ? (set === 'sitemaps' ? { sitemaps: [`{${live.id}}`] } : set === 'workflows' ? null : { entities: [table] }) : null,
    typed,
    proven_in: job.proven_in || null,
    reverts_plan_id: revertOf || null,
  };
  // The log keeps the whole definition before and after; if that would not fit one Write Log row, refuse
  // rather than log less (ruled 10/7, §8f).
  const probe = entryFor(plan, {
    time: new Date().toISOString(), planId: '00000000-000000-00000000', person: identity, outcome: 'applied with problems',
    rows: [{ name: plan.component.name, id: plan.component.id || '00000000-0000-0000-0000-000000000000', outcome: 'written', changes: changesFor(plan), before: plan.before, after: { ...(plan.before || {}), definition: after || (plan.before || {}).definition } }],
  });
  const size = entryText(probe).length;
  if (size > MAX_ENTRY) {
    throw new PlanRefused([`this change's log entry (the full definition before and after) would be ${size} characters, over the ${MAX_ENTRY} one Write Log row holds. The log never keeps less (ruled 10/7); this change is made in the maker portal.`], 'too_big');
  }
  return plan;
}

// ---------- the pop-up ----------

function undoLine(plan) {
  const n = plan.component.noun;
  if (plan.mode === 'update') return `Can be undone with revert: the definition before this change is kept in full in the Write Log.${plan.component.set === 'workflows' ? ' Anything the flow does before then stays done.' : ''}`;
  if (plan.mode === 'create') return plan.component.set === 'workflows' ? 'Undo turns the flow off; it is not deleted (only an admin delete removes it).' : `Undo cannot remove the new ${n}; only an admin delete can.`;
  if (plan.mode === 'on') return 'Can be undone with revert (turns it back off). Anything it does while on stays done.';
  if (plan.mode === 'off') return 'Can be undone with revert (turns it back on).';
  if (plan.mode === 'own') return `Can be undone with revert (hands it back to ${plan.before.owner ? plan.before.owner.name : 'the previous owner'}).`;
  return `Cannot be undone with revert. The ${n}'s full definition is kept in the Write Log; bringing it back is a rebuild.`;
}

function componentHeadline(plan) {
  return title(plan);
}

function componentSummary(plan) {
  const out = [...severity.block(plan.severity), title(plan), ''];
  if (plan.mode === 'update' || plan.mode === 'create') for (const l of plan.diff.lines) out.push(`  ${l}`);
  if (plan.flow) {
    out.push(`  Runs as: ${plan.flow.runs_as_text}`);
    if (plan.flow.concurrency_carried) out.push(`  Trigger concurrency (${concText(plan.flow.concurrency_carried)}) is kept: the platform never lets it be removed.`);
    if (plan.mode === 'update') out.push(plan.flow.live_on ? '  The flow is ON: the change applies from its next run.' : '  The flow is off.');
    if (plan.mode === 'off') {
      out.push('  It stops running: nothing it watches for is acted on until it is turned back on.');
      if (plan.flow.callers === null) out.push('  Could not check which flows call it.');
      else if (plan.flow.callers.length) out.push(`  Flows that call it will fail while it is off: ${names(plan.flow.callers)}`);
    }
    if (plan.mode === 'on') out.push(`  Only the owner of its connections (${plan.flow.runs_as_text}) can turn it on; if Power Automate refuses, they turn it on themselves.`);
  }
  if (plan.mode === 'own') {
    out.push(`  Owner: ${plan.before.owner ? plan.before.owner.name : 'unknown'} -> ${plan.owner_to.name}`);
    const ra = plan.flow && plan.flow.trigger_runas;
    out.push(`  A flow acts as its owner: from now on it acts as ${plan.owner_to.name}${ra && ra.length ? ` (its trigger subscription: runas ${[...new Set(ra)].join(', ')})` : ' (it has no trigger subscription now)'}.`);
  }
  if (plan.mode === 'delete') out.push(`  To approve, type its name exactly: ${plan.typed}`);
  if (plan.publish) out.push(`  Published after the change (${plan.publish.entities ? `the ${plan.component.table} table only` : 'this sitemap only'}).`);
  out.push('', `  ${undoLine(plan)}`, '', `Reason given: ${plan.reason}`);
  return out.join('\n');
}

function componentDetail(plan, { id } = {}) {
  const c = plan.component;
  const out = [...severity.block(plan.severity), title(plan), '', `Requested by: ${plan.identity.fullname} (${plan.identity.email})`, `Reason given: ${plan.reason}`, `Made by: ${plan.source}`];
  if (id) out.push(`Plan: ${id}`);
  if (plan.reverts_plan_id) out.push(`Undoes plan: ${plan.reverts_plan_id}`);
  out.push(`Component: ${c.set} ${c.id || '(new)'}${c.table ? `, table ${c.table}` : ''}`);
  if (plan.solution) out.push(`Solution: ${plan.solution.name} (${plan.solution.uniquename})`);
  out.push(`Access needed: ${plan.need}${plan.need_why.length ? ` (${plan.need_why.join('; ')})` : ''}; ${plan.identity.fullname} has ${plan.access}`);
  if (plan.diff.sections.length) out.push(`Changes: ${plan.diff.sections.join(', ')}`);
  for (const p of (plan.facts && plan.facts.power) || []) out.push(`  admin because ${p}`);
  out.push('');
  for (const l of plan.diff.lines) out.push(`  ${l}`);
  for (const l of plan.diff.detail) out.push(l);
  if (plan.flow) {
    out.push('', `Runs as: ${plan.flow.runs_as_text}`);
    for (const r of plan.flow.runs_as) out.push(`  ${r.key}: ${r.invoker ? 'the person who runs it' : r.missing ? `MISSING (${r.logical})` : `${r.display} (${r.logical}), owner ${r.owner}${r.connected ? '' : ', NO CONNECTION'}${r.active ? '' : ', INACTIVE'}`}`);
    for (const t of plan.flow.trigger) out.push(`Trigger ${t.name}: ${triggerText(t)}`);
    if (plan.flow.owner) out.push(`Flow owner: ${plan.flow.owner.name}`);
  }
  if (plan.before_hash) out.push('', `Snapshot: ${plan.before_hash}`);
  return out.join('\n');
}

// ---------- apply ----------

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// What a plan may ask apply to write (round 3): an update sends only definition fields; a create sends the
// definition, the name, the fixed flow fields and the create extras validation allows. Anything else in a plan
// file was put there by hand, and apply refuses it (plan_tampered).
const CREATE_EXTRAS = { savedqueries: ['returnedtypecode', 'querytype'], systemforms: ['objecttypecode', 'type'] };
const FLOW_CREATE_FIXED = ['category', 'type', 'primaryentity'];

function planShapeProblems(plan) {
  const c = plan && plan.component;
  if (!c || !has(SETS, c.set)) return ['an unknown kind of component'];
  if (!MODES.includes(plan.mode)) return [`the mode "${plan.mode}"`];
  const set = c.set;
  const fields = SETS[set].fields;
  const bad = [];
  if (plan.mode === 'update') {
    if (!Array.isArray(plan.sent_fields) || !plan.sent_fields.length) bad.push('no field at all');
    else for (const f of plan.sent_fields) if (!fields.includes(f)) bad.push(`the field "${f}"`);
  }
  for (const k of Object.keys(plan.after_definition || {})) if (!fields.includes(k)) bad.push(`the definition key "${k}"`);
  if (plan.mode === 'create') for (const k of Object.keys(plan.create_extra || {})) if (!(CREATE_EXTRAS[set] || []).includes(k)) bad.push(`the create field "${k}"`);
  if (!bad.length && (plan.mode === 'update' || plan.mode === 'create')) {
    const allowed = new Set([...fields, ...(plan.mode === 'create' ? ['name', ...(CREATE_EXTRAS[set] || []), ...(set === 'workflows' ? FLOW_CREATE_FIXED : [])] : [])]);
    for (const k of Object.keys(bodyFor(plan))) if (!allowed.has(k)) bad.push(`the body key "${k}"`);
  }
  return [...new Set(bad)];
}

// The body of the one write.
function bodyFor(plan) {
  const set = plan.component.set;
  if (plan.mode === 'update') return Object.fromEntries(plan.sent_fields.map((f) => [f, plan.after_definition[f]]));
  if (plan.mode === 'create') return createBody(set, plan.component.name, plan.after_definition, plan.create_extra || {});
  if (plan.mode === 'on') return { statecode: 1, statuscode: 2 };
  if (plan.mode === 'off') return { statecode: 0, statuscode: 1 };
  if (plan.mode === 'own') return { 'ownerid@odata.bind': `/systemusers(${plan.owner_to.id})` };
  return null;
}

// 403 ConnectionAuthorizationFailed (a live finding, verified 9/29/26): the platform lets only the owner of
// a flow's connections turn it on or hand it over. Said plainly, with who has to do it.
function isConnectionRefusal(e) {
  return /ConnectionAuthorizationFailed/i.test(`${e && e.code} ${e && e.message}`);
}

function connectionRefusalText(plan) {
  const who = plan.flow ? plan.flow.runs_as_text : 'the owner of its connections';
  const act = plan.mode === 'own' ? 'hand this flow over' : 'turn this flow on';
  return `Power Automate refused: only the owner of this flow's connections (${who}) can ${act}. Nothing changed. `
    + `${who} signs in to Power Automate and does it there (then read it back). Sharing their connection with you is never the fix: it would let you act as them in any flow.`;
}

// Is the flow's trigger subscription live with the filter the definition declares? (the earlier Python component tool
// _trigger_live, Gate A #4 9/24/26: a saved definition is not a live trigger.) null = nothing to check.
// Round 3: the message, scope and runas are compared too, not only the filter and table. A trigger with no
// runas parameter registers runas 1 (read live in Donor App Dev 10/7: the QGiv intake flow's trigger has
// message 1 and scope 4 and no runas; its subscription reads message 1, scope 4, runas 1).
function checkSubscription(dv, plan, cd, sleep) {
  const hit = Object.entries(flowDef(cd).def.triggers || {}).find(([n, x]) => triggerInfo(n, x).dataverse);
  if (!hit) return null;
  const t = triggerInfo(hit[0], hit[1]);
  const p = hit[1].inputs.parameters;
  const norm = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).sort().join(',');
  const want = {
    message: p['subscriptionRequest/message'], scope: p['subscriptionRequest/scope'],
    runas: p['subscriptionRequest/runas'] === undefined ? 1 : p['subscriptionRequest/runas'],
  };
  const off = (c) => {
    const why = [];
    if (norm(c.filteringattributes) !== norm(t.filter)) why.push(`filter ${c.filteringattributes || 'none'}`);
    if (c.entityname && c.entityname !== t.table) why.push(`table ${c.entityname}`);
    for (const k of ['message', 'scope', 'runas']) if (want[k] !== undefined && c[k] !== undefined && c[k] !== null && Number(c[k]) !== Number(want[k])) why.push(`${k} ${c[k]} (the definition says ${want[k]})`);
    return why;
  };
  let cb = [];
  for (let i = 0; i < 10; i += 1) { // re-registers within seconds; ~30 s ceiling, as the Python
    cb = dv.get(filterPath('callbackregistrations', 'name,entityname,message,scope,runas,filteringattributes,modifiedon,_ownerid_value', `name eq '${q(plan.component.id)}'`)).value || [];
    if (cb.length && cb.every((c) => !off(c).length)) break;
    if (i < 9) sleep(3000);
  }
  if (!cb.length) return { ok: false, why: `the trigger is not registered (no subscription for ${t.table}); turn the flow off and on in the designer, never Save` };
  const bad = cb.map(off).filter((w) => w.length);
  if (bad.length) return { ok: false, why: `the trigger is not live as the definition says (${t.table}, filter ${t.filter || 'none'}; registered: ${bad.map((w) => w.join(', ')).join('; ')}); turn the flow off and on in the designer, never Save` };
  return { ok: true, note: `trigger live on ${t.table}, filter ${t.filter || 'none'}, message ${want.message}, scope ${want.scope}, runas ${want.runas}` };
}

function readBack(dv, plan, rid, sleep) {
  const set = plan.component.set;
  const bad = [];
  const notes = [];
  if (plan.mode === 'delete') {
    // Gone only if Dataverse says it does not exist; any other read error is "could not confirm", never written.
    let still;
    try { still = readComponent(dv, set, rid); } catch (e) {
      bad.push(`could not confirm it is gone (${String(e.message).slice(0, 160)})`);
      return { after: null, bad, notes };
    }
    if (still) bad.push('it is still there');
    return { after: null, bad, notes };
  }
  const now = readComponent(dv, set, rid);
  if (!now) return { after: null, bad: ['it could not be read back'], notes };
  if (plan.mode === 'update' || plan.mode === 'create') {
    const fields = plan.mode === 'update' ? plan.sent_fields : SETS[set].fields.filter((f) => !blank(plan.after_definition[f]));
    const off = fields.filter((f) => canonical(normField(set, f, now.definition[f])) !== canonical(normField(set, f, plan.after_definition[f])));
    if (off.length) bad.push(`the definition read back differs from what was sent (${off.join(', ')})`);
    if (plan.mode === 'create' && set === 'workflows' && now.statecode !== 0) bad.push(`the new flow is not off (statecode ${now.statecode})`);
  }
  // Round 3: a flow the platform switched off (or on) while saving the definition is not "written": a save that
  // fails the platform's own validation can leave the flow off.
  if (plan.mode === 'update' && set === 'workflows' && plan.live_before
    && (now.statecode !== plan.live_before.statecode || now.statuscode !== plan.live_before.statuscode)) {
    bad.push(`the flow's state changed on save (statecode ${plan.live_before.statecode} -> ${now.statecode}, statuscode ${plan.live_before.statuscode} -> ${now.statuscode}); open it and run the Flow checker`);
  }
  if (plan.mode === 'on' && now.statecode !== 1) bad.push(`it is not on (statecode ${now.statecode})`);
  if (plan.mode === 'off' && now.statecode !== 0) bad.push(`it is not off (statecode ${now.statecode})`);
  if (plan.mode === 'own' && (!now.owner || now.owner.id !== plan.owner_to.id)) bad.push(`the owner is ${now.owner ? now.owner.name : 'unknown'}, not ${plan.owner_to.name}`);
  if (set === 'workflows' && now.statecode === 1 && (plan.mode === 'on' || plan.mode === 'update')) {
    const sub = checkSubscription(dv, { ...plan, component: { ...plan.component, id: rid } }, JSON.parse(now.definition.clientdata || '{}'), sleep);
    if (sub && !sub.ok) bad.push(sub.why);
    else if (sub) notes.push(sub.note);
  }
  return { after: stateOf(now), bad, notes };
}

async function applyComponent(plan, deps, { id, file, fs }) {
  const { access, connect, confirm, now = new Date(), sleep = defaultSleep } = deps;
  if (now - new Date(plan.created) > MAX_AGE_MS) throw new ApplyRefused('this plan is more than 24 hours old. Make a new plan.', 'stale_plan');
  const dv = connect(plan.host);
  const me = whoAmI(dv);
  if (me.systemuserid !== plan.identity.systemuserid) throw new ApplyRefused(`this plan was made by ${plan.identity.fullname}; you are signed in as ${me.fullname}. Nothing was written.`, 'different_person');
  const acc = accessFor(resolveAccess(access, dv, plan.env), me.email, plan.env);
  const shapeBad = planShapeProblems(plan);
  if (shapeBad.length) throw new ApplyRefused(`this plan file asks to write ${shapeBad.join(', ')}, which no plan of this kind writes. It was changed after it was made; make a new plan. Nothing was written.`, 'plan_tampered');
  const set = plan.component.set;

  // Re-check that what the plan read is still true.
  let live = null;
  let etag = null;
  if (plan.mode === 'create') {
    const sol = dv.get(filterPath('solutions', 'solutionid,ismanaged,_publisherid_value', `uniquename eq '${q(plan.solution.uniquename)}'`)).value || [];
    if (sol.length !== 1 || sol[0].ismanaged || String(sol[0].solutionid).toLowerCase() !== plan.solution.id) throw new ApplyRefused(`the solution ${plan.solution.uniquename} changed since the plan (gone, or now managed). Make a new plan.`, 'snapshot_moved');
    if (existingByName(dv, set, plan.component.name, plan.component.table).length) throw new ApplyRefused(`a ${plan.component.noun} named '${plan.component.name}' now exists in the ${plan.app}. Nothing was written.`, 'snapshot_moved');
  } else {
    live = readComponent(dv, set, plan.component.id);
    if (!live) throw new ApplyRefused(`'${plan.component.name}' no longer exists. Nothing was written.`, 'snapshot_moved');
    if (live.managed) throw new ApplyRefused(`'${plan.component.name}' is now managed; managed components are never changed.`, 'not_permitted');
    let h = null;
    try { h = hashDef(set, live.id, live.definition); } catch { h = null; }
    if (h !== plan.before_hash) throw new ApplyRefused(`'${plan.component.name}' has changed since the plan (its definition no longer matches the snapshot). Nothing was written; make a new plan.`, 'snapshot_moved');
    if (plan.before && (live.statecode !== plan.before.statecode || (live.owner && plan.before.owner && live.owner.id !== plan.before.owner.id))) {
      // Only a flow's definition change survives its flow being switched since the plan, and then its
      // severity and level are worked out below on the new state (a flow turned on since now runs the change live).
      if (plan.mode !== 'update' || set !== 'workflows') {
        throw new ApplyRefused(`'${plan.component.name}' was turned on or off, or changed owner, since the plan. Nothing was written; make a new plan.`, 'snapshot_moved');
      }
    }
    etag = live.etag;
    if (!etag) throw new ApplyRefused('no version tag came back, so the write could not be protected. Nothing was written.', 'snapshot_moved');
  }

  // Everything the person approves is worked out AGAIN here, from the live re-read and the definition this
  // apply will write, never from the plan's own account of itself (blind review 10/7): the diff, who a flow
  // runs as, the drafts it touches, the level it needs, the warnings and the typed delete phrase. Only the
  // dev-copy line is carried from the plan (apply has no connection to the dev copy).
  const body = bodyFor(plan);
  const written = plan.mode === 'update' ? { ...live.definition, ...body } : plan.mode === 'create' ? plan.after_definition : null;
  if (set === 'workflows') {
    const where = secretsIn(live ? live.definition : null, written);
    if (where.length) throw new ApplyRefused(secretRefusal(where), 'invalid_job');
  }
  const d = describe(dv, {
    mode: plan.mode, set, name: live ? live.name : plan.component.name, table: live ? live.table : plan.component.table,
    id: live ? live.id : null, live, written, unproven: plan.facts && plan.facts.unproven, carried: plan.flow ? plan.flow.concurrency_carried : null, extra: plan.create_extra || {},
    me: me.systemuserid,
  });
  if (d.facts.target_drafts.length) throw new ApplyRefused(`${draftRefusal(live.name)}. Nothing was written.`, 'snapshot_moved');
  if (set === 'systemforms' && written) {
    const have = tableFields(dv, d.facts.table);
    const missing = have ? formFields(written.formxml).filter((f) => !have.has(f)) : ['(the table could not be read)'];
    if (missing.length) throw new ApplyRefused(`the form names field(s) that ${d.facts.table} does not have: ${missing.join(', ')}. Nothing was written.`, 'snapshot_moved');
  }
  if (d.flow && plan.flow) {
    const owners = (list) => canonical((list || []).map((r) => [r.key, r.owner_id || null, Boolean(r.missing)]));
    if (owners(d.flow.runs_as) !== owners(plan.flow.runs_as)) throw new ApplyRefused(`the connections '${plan.component.name}' runs on changed since the plan (now: ${d.flow.runs_as_text}). Nothing was written; make a new plan.`, 'snapshot_moved');
  }
  const need = needFor(d.facts);
  if (!atLeast(acc.level, need.level)) {
    throw new ApplyRefused(need.level === 'admin' && atLeast(acc.level, 'develop')
      ? `this change takes admin access because ${need.why.join(', and ')}; you have ${acc.level}. Nothing was written.`
      : `your access to the ${plan.app} is now ${acc.level}, not ${need.level}. Nothing was written.`, 'access_revoked');
  }
  const sevNow = severityFor(d.facts, plan.severity.warn_rows);
  if (severity.grew(plan.severity, sevNow)) {
    throw new ApplyRefused(['this change is more serious than when it was planned, so it is not shown for approval:', ...sevNow.lines.map((l) => `  ! ${l}`), 'Make a new plan.'].join('\n'), 'severity_grew');
  }

  const view = {
    ...plan, component: { ...plan.component, name: d.facts.name }, severity: sevNow, facts: d.facts, diff: d.diff, flow: d.flow,
    need: need.level, need_why: need.why, access: acc.level, typed: d.typed,
  };
  const answer = confirm({ summaryText: componentSummary(view), detailText: componentDetail(view, { id }), title: `SBRM: approve this app change in the ${plan.app}?`, typed: d.typed });
  const base = entryFor(view, { time: now.toISOString(), planId: id, person: me, outcome: 'cancelled', rows: [] });
  if (!answer.approved) return { entry: { ...base, outcome: 'cancelled', note: answer.note || null, rows: [] }, outcome: 'cancelled', person: me, dv, written: 0, rows: [], left_out: [] };

  // Drafts again, AFTER the approval and just before the write (round 3): the pop-up can stay open for
  // minutes, and an edit saved in the maker portal meanwhile would be overwritten (the target's) or published
  // along with this change (the table's) without the person having seen it.
  const again = draftState(dv, set, plan.mode, live ? live.id : null, d.facts.table);
  if (again.target.length) throw new ApplyRefused(`${draftRefusal(live.name)} (saved while the pop-up was open). Nothing was written.`, 'snapshot_moved');
  const newDrafts = again.others.map((x) => x.name).filter((n) => !d.facts.other_drafts.includes(n));
  if (newDrafts.length) {
    throw new ApplyRefused(`unpublished edits were saved while the pop-up was open, and publishing ${d.facts.table} now would publish them too: ${names(newDrafts)}. Nothing was written; make a new plan.`, 'severity_grew');
  }

  // The one write, then publish (views, forms, sitemaps), then the read-back.
  const row = { name: view.component.name, id: plan.component.id, set, action: plan.mode, changes: changesFor(view), before: stateOf(live), after: null, notes: [] };
  let rid = plan.component.id;
  let wrote = false;
  try {
    if (plan.mode === 'create') {
      const res = dv.create(set, body, { solution: plan.solution.uniquename });
      rid = String(res[SETS[set].id] || '').toLowerCase();
      if (!rid) throw new Error('the new component id did not come back');
      row.id = rid;
    } else if (plan.mode === 'delete') {
      dv.remove(set, rid, etag);
    } else {
      dv.update(set, rid, body, etag);
    }
    wrote = true;
    if (plan.publish) {
      const pub = plan.publish.sitemaps ? { sitemaps: [`{${rid}}`] } : { entities: [d.facts.table] };
      try { dv.publish(pub); } catch (e) {
        row.notes.push(`saved but NOT published: ${e.message}. Nobody sees the change until it is published.`);
        row.publish_failed = true;
      }
    }
    const rb = readBack(dv, { ...plan, after_definition: written || plan.after_definition, live_before: stateOf(live) }, rid, sleep);
    row.after = rb.after;
    row.notes.push(...rb.notes);
    const problems = [...rb.bad, ...(row.publish_failed ? ['not published'] : [])];
    row.outcome = problems.length ? `read-back mismatch: ${problems.join('; ')}` : 'written';
  } catch (e) {
    if (!wrote && isConnectionRefusal(e)) row.outcome = `refused: ${connectionRefusalText(view)}`;
    else if (!wrote && e && e.code === '0x80060882') row.outcome = 'failed: the component changed between the check and the write; nothing was written to it';
    else row.outcome = `failed: ${e.message}`;
    try { row.after = wrote ? stateOf(readComponent(dv, set, rid)) : stateOf(live); } catch { row.after = null; }
  }
  fs.rmSync(file, { force: true });
  const ok = row.outcome === 'written';
  const outcome = ok ? 'applied' : 'applied with problems';
  return { entry: { ...base, outcome, rows: [row] }, outcome, person: me, dv, written: ok ? 1 : 0, rows: [row], left_out: [] };
}

// ---------- revert ----------
//
// update -> the logged definition before, only if the component still holds what was written; on <-> off;
// own -> the previous owner; a created flow -> off (never deleted); a created view or form stays (only an
// admin delete removes it); a delete cannot be undone here (the definition is in the log entry).

async function planComponentRevert(dv, entry, ctx) {
  if (!entry || entry.mode !== 'component') throw new PlanRefused(['that plan is not an app component change'], 'nothing_to_undo');
  if (!['applied', 'applied with problems'].includes(entry.outcome)) throw new PlanRefused([`that change's outcome is "${entry.outcome}"; there is nothing to undo`], 'nothing_to_undo');
  const row = (entry.rows || [])[0];
  if (!row || !row.after && entry.action !== 'delete' || !/^(written|read-back mismatch)/.test(String(row.outcome))) {
    throw new PlanRefused([`that change did not land (${row ? row.outcome : 'no row'}); there is nothing to undo`], 'nothing_to_undo');
  }
  // A log entry is data, and a forged or damaged one must be refused cleanly, never crash (round 4): the set,
  // the id and the name are checked, and the entry must belong to the environment this revert reads.
  const envs = (ctx && ctx.envs) || {};
  if (typeof entry.env !== 'string' || !has(envs, entry.env)) throw new PlanRefused([`that log entry names an environment the toolkit does not know ("${entry.env}")`], 'invalid_job');
  if (dv.host && String(dv.host).toLowerCase() !== String(envs[entry.env].host).toLowerCase()) {
    throw new PlanRefused([`that change was made in the ${envs[entry.env].name}; this revert was planned against another environment. Revert it in the ${envs[entry.env].name}.`], 'invalid_job');
  }
  const set = row.set || (obj(entry.component) ? entry.component.set : null);
  if (typeof set !== 'string' || !has(SETS, set) || (row.set && obj(entry.component) && entry.component.set && row.set !== entry.component.set)) {
    throw new PlanRefused([`that log entry does not name a component set this engine changes (${Object.keys(SETS).join(', ')})`], 'invalid_job');
  }
  if (typeof row.id !== 'string' || !GUID.test(row.id)) throw new PlanRefused(['that log entry has no valid component id'], 'invalid_job');
  const rawName = (row.after && row.after.name) || row.name;
  if (typeof rawName !== 'string' || !rawName.trim()) throw new PlanRefused(['that log entry has no component name'], 'invalid_job');
  const spec = SETS[set];
  const noun = spec.noun;
  const name = rawName;
  const what = `the ${noun} '${name}'`;
  if (entry.action === 'delete') {
    throw new PlanRefused([`a deleted ${noun} cannot be brought back by revert. Its full definition is in the Write Log entry for plan ${entry.plan_id} (rows[0].before.definition); rebuilding it is a new create.`], 'nothing_to_undo');
  }
  const live = readComponent(dv, set, row.id);
  if (!live) throw new PlanRefused([`${what} no longer exists`], 'nothing_to_undo');
  const job = {
    contract: CONTRACT, kind: 'component', env: entry.env, component: { set, id: row.id, name: live.name },
    definition: null, owner: null, snapshot_hash: hashDef(set, live.id, live.definition), solution: null, proven_in: null,
    source: `revert ${entry.plan_id}`,
    reason: `Undo plan ${entry.plan_id} ("${entry.headline}", by ${entry.person ? entry.person.fullname : 'unknown'}).`.slice(0, 500),
    intent: null,
  };
  if (entry.action === 'update') {
    // Only if the component still holds exactly what that plan wrote; else it moved and a revert would
    // overwrite someone's later change.
    job.mode = 'update';
    job.snapshot_hash = hashDef(set, row.id, row.after.definition);
    job.definition = Object.fromEntries(spec.fields.map((f) => [f, row.before.definition[f] === undefined ? null : row.before.definition[f]]));
  } else if (entry.action === 'create') {
    if (set !== 'workflows') throw new PlanRefused([`${what} stays: revert does not delete what it created; only an admin delete removes it`], 'nothing_to_undo');
    if (live.statecode !== 1) throw new PlanRefused([`${what} is already off; it stays (only an admin delete removes it)`], 'nothing_to_undo');
    job.mode = 'off';
  } else if (entry.action === 'on' || entry.action === 'off') {
    const want = entry.action === 'on' ? 1 : 0;
    if (live.statecode !== want) throw new PlanRefused([`${what} is no longer ${entry.action}; nothing to undo`], 'nothing_to_undo');
    // Turning a flow back off is the safety lever, so it is not held to the definition being unchanged
    // (the snapshot is the live one); turning it back on shows the On warning like any other On.
    job.mode = entry.action === 'on' ? 'off' : 'on';
  } else if (entry.action === 'own') {
    const prev = row.before && row.before.owner;
    if (!prev) throw new PlanRefused([`the log does not say who owned ${what} before`], 'nothing_to_undo');
    if (!live.owner || live.owner.id !== (row.after && row.after.owner ? row.after.owner.id : null)) throw new PlanRefused([`${what} has changed owner again since; nothing to undo`], 'nothing_to_undo');
    job.mode = 'own';
    job.owner = prev.id;
  } else {
    throw new PlanRefused([`unknown component action "${entry.action}"`], 'engine_bug');
  }
  job.intent = { verb: job.mode, component: noun, name: live.name };
  return planCore(dv, job, ctx, { revertOf: entry.plan_id });
}

module.exports = {
  validateComponentJob, planComponent, componentSummary, componentDetail, componentHeadline, applyComponent, planComponentRevert, snapshot,
  readSnapshot, parseXml, formFields, diffFlow, diffView, diffForm, diffSitemap, diffComponent, carryConcurrency, flowConnections,
  needFor, severityFor, SETS, MAX_ENTRY, sameChange, sectionContent, createBody, TOOLKIT_TABLES,
  flowSecrets, actionFacts, stepPower, triggerPower, viewHooks, formHooks, markupPower, planShapeProblems,
};
