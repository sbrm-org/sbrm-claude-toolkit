'use strict';
// File-level validation of a job file (CONTRACT.md §2a, §3). PURE: no Dataverse calls.
// Live checks (columns exist, targets active, duplicates, access) are resolve.js.
//
// Rule behind every clause: the job file is a REQUEST. Anything it does not say exactly
// right is refused, never repaired: a silent repair is the engine guessing what was meant.

const CONTRACT = 'sbrm-dv-job/1';
const TOP_KEYS = new Set(['contract', 'kind', 'env', 'table', 'mode', 'source', 'reason', 'intent',
  'amount_field', 'verify', 'rows']);
const ROW_KEYS = new Set(['name', 'id', 'body', 'dup_filter', 'warning']);
const INTENT_KEYS = new Set(['verb', 'count', 'table', 'fields', 'amount_total']);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[a-z_][a-z0-9_]*$/; // logical names and entity set names
const NAV = /^[A-Za-z_][A-Za-z0-9_]*$/; // navigation properties are case-sensitive
const BIND_KEY = /^([A-Za-z_][A-Za-z0-9_]*)@odata\.bind$/;
const BIND_VALUE = /^\/([a-z_][a-z0-9_]*)\(([0-9a-f-]{36})\)$/i;

const MAX_NAME = 200;
const MAX_REASON = 500;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A body key is either a plain column or a lookup bind. Anything else is refused: a nested
// object or array would be a DEEP INSERT, creating related records the summary never shows.
function classifyBodyKey(key, value) {
  const m = BIND_KEY.exec(key);
  if (m) {
    if (value !== null && (typeof value !== 'string' || !BIND_VALUE.test(value))) {
      return { error: `"${key}" must be "/<entityset>(<guid>)" or null (null clears the lookup)` };
    }
    return { kind: 'lookup', nav: m[1] };
  }
  if (key.includes('@')) return { error: `"${key}": only "<NavigationProperty>@odata.bind" annotations are allowed` };
  if (!IDENT.test(key)) return { error: `"${key}" is not a column logical name (lowercase)` };
  if (value !== null && typeof value === 'object') {
    return { error: `"${key}" holds an object or list; nested writes (deep insert) are not allowed` };
  }
  return { kind: 'plain' };
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function cents(n) {
  return Math.round(Number(n) * 100);
}

// Returns { errors: [...], job } where job is the normalized request (only on no errors).
function validateJob(raw, { envs }) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (!isPlainObject(raw)) return { errors: ['the job file must be a JSON object'] };

  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (raw.contract !== CONTRACT) err(`"contract" must be exactly "${CONTRACT}"`);
  if (raw.kind === 'steps') err('"kind": "steps" is not in v1 of the shared contract (CONTRACT.md §2b); schema jobs stay on dataverse_write.py');
  else if (raw.kind !== 'rows') err('"kind" must be "rows"');
  if (typeof raw.env !== 'string' || !Object.prototype.hasOwnProperty.call(envs, raw.env)) {
    err(`"env" must be one of: ${Object.keys(envs).join(', ')}`);
  }
  if (typeof raw.table !== 'string' || !IDENT.test(raw.table)) err('"table" must be an entity set name (plural, lowercase), e.g. "contacts"');
  if (raw.mode === 'delete') err('there is no delete (CONTRACT.md §8)');
  else if (raw.mode !== 'create' && raw.mode !== 'update') err('"mode" must be "create" or "update"');
  if (typeof raw.source !== 'string' || !raw.source.trim()) err('"source" is required (script path, or "claude-session")');
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) err('"reason" is required: one plain sentence on why');
  else if (raw.reason.length > MAX_REASON) err(`"reason" is over ${MAX_REASON} characters; one sentence`);
  else if (/[\r\n]/.test(raw.reason)) err('"reason" must be one line');

  if (raw.amount_field !== undefined && raw.amount_field !== null && (typeof raw.amount_field !== 'string' || !IDENT.test(raw.amount_field))) {
    err('"amount_field" must be a column logical name or null');
  }
  if (raw.verify !== undefined && raw.verify !== null) {
    if (!Array.isArray(raw.verify) || raw.verify.some((c) => typeof c !== 'string' || !IDENT.test(c))) {
      err('"verify" must be a list of column logical names');
    }
  }

  const rows = Array.isArray(raw.rows) ? raw.rows : null;
  if (!rows) err('"rows" must be a list');
  else if (rows.length === 0) err('"rows" is empty');

  const bodyKeys = new Set();
  if (rows) {
    const ids = new Map();
    const bodies = new Map();
    rows.forEach((row, i) => {
      const at = `row ${i + 1}`;
      if (!isPlainObject(row)) return err(`${at} is not an object`);
      for (const k of Object.keys(row)) if (!ROW_KEYS.has(k)) err(`${at}: unknown key "${k}"`);
      if (typeof row.name !== 'string' || !row.name.trim()) err(`${at}: "name" is required (the row's human name)`);
      else if (row.name.length > MAX_NAME) err(`${at}: "name" is over ${MAX_NAME} characters`);
      const who = typeof row.name === 'string' && row.name.trim() ? `${at} (${row.name})` : at;

      if (raw.mode === 'update') {
        if (typeof row.id !== 'string' || !GUID.test(row.id)) err(`${who}: "id" must be the target record's GUID`);
        else {
          const id = row.id.toLowerCase();
          if (ids.has(id)) err(`${who}: same record id as row ${ids.get(id)}; one row per record`);
          else ids.set(id, i + 1);
        }
        if (row.dup_filter !== undefined && row.dup_filter !== null) err(`${who}: "dup_filter" is for creates only`);
      } else if (raw.mode === 'create') {
        if (row.id !== undefined && row.id !== null) err(`${who}: a create row must not carry an "id"`);
      }

      if (!isPlainObject(row.body) || Object.keys(row.body).length === 0) {
        err(`${who}: "body" must be a non-empty object`);
      } else {
        const attrsViaNav = new Set();
        for (const [k, v] of Object.entries(row.body)) {
          const c = classifyBodyKey(k, v);
          if (c.error) err(`${who}: ${c.error}`);
          else {
            bodyKeys.add(k);
            if (c.kind === 'lookup') attrsViaNav.add(c.nav);
          }
        }
        if (raw.mode === 'create') {
          const sig = JSON.stringify(Object.keys(row.body).sort().map((k) => [k, row.body[k]]));
          if (bodies.has(sig)) err(`${who}: identical body to row ${bodies.get(sig)}`);
          else bodies.set(sig, i + 1);
        }
      }

      if (row.dup_filter !== undefined && row.dup_filter !== null) {
        if (typeof row.dup_filter !== 'string' || !row.dup_filter.trim()) err(`${who}: "dup_filter" must be an OData $filter string or null`);
        else if (/[&?#\r\n]/.test(row.dup_filter)) err(`${who}: "dup_filter" may not contain & ? # or a line break (it is ONE $filter, nothing else)`);
      }
      if (row.warning !== undefined && row.warning !== null && (typeof row.warning !== 'string' || !row.warning.trim())) {
        err(`${who}: "warning" must be text or null`);
      }
    });
  }

  if (raw.amount_field && rows && !bodyKeys.has(raw.amount_field)) {
    err(`"amount_field" ${raw.amount_field} is not set by any row`);
  }

  // Intent match, file half (DESIGN.md §6b.1). The headline is never rendered from intent;
  // intent only has to AGREE with what the engine computes, or nothing is shown for approval.
  const intent = raw.intent;
  if (!isPlainObject(intent)) err('"intent" is required: {verb, count, table, fields, amount_total?}');
  else if (rows && errors.length === 0) {
    for (const k of Object.keys(intent)) if (!INTENT_KEYS.has(k)) err(`intent: unknown key "${k}"`);
    const mism = [];
    if (intent.verb !== raw.mode) mism.push(`verb says "${intent.verb}", the rows are a ${raw.mode}`);
    if (intent.count !== rows.length) mism.push(`count says ${intent.count}, the file has ${rows.length} row(s)`);
    if (intent.table !== raw.table) mism.push(`table says "${intent.table}", the file writes "${raw.table}"`);
    const fields = Array.isArray(intent.fields) ? intent.fields : null;
    const actual = [...bodyKeys].sort();
    if (!fields || !sameSet(fields, actual)) {
      mism.push(`fields say [${fields ? fields.join(', ') : '?'}], the rows set [${actual.join(', ')}]`);
    }
    if (raw.amount_field) {
      const total = rows.reduce((s, r) => s + Number(r.body[raw.amount_field] || 0), 0);
      if (typeof intent.amount_total !== 'number' || cents(intent.amount_total) !== cents(total)) {
        mism.push(`amount_total says ${intent.amount_total}, the rows total ${(cents(total) / 100).toFixed(2)}`);
      }
    } else if (intent.amount_total !== undefined && intent.amount_total !== null) {
      mism.push('amount_total is given but the job has no amount_field');
    }
    if (mism.length) err(`intent does not match the rows (the plan is refused, nothing is shown for approval): ${mism.join('; ')}`);
  }

  if (errors.length) return { errors };
  return {
    errors: [],
    job: {
      contract: CONTRACT,
      kind: 'rows',
      env: raw.env,
      table: raw.table,
      mode: raw.mode,
      source: raw.source.trim(),
      reason: raw.reason.trim(),
      intent: raw.intent,
      amount_field: raw.amount_field || null,
      verify: raw.verify || null,
      bodyKeys: [...bodyKeys].sort(),
      rows: rows.map((r) => ({
        name: r.name.trim(),
        id: r.id ? r.id.toLowerCase() : null,
        body: r.body,
        dup_filter: r.dup_filter || null,
        warning: r.warning ? r.warning.trim() : null,
      })),
    },
  };
}

module.exports = { validateJob, classifyBodyKey, CONTRACT, GUID, BIND_KEY, BIND_VALUE, IDENT, NAV };
