'use strict';
// `get` (1.11.42): ANY read of the Dataverse Web API, GET only, its answer saved to a file (Dylan 11/23/26, "go on the
// general read command", after the Dataverse MCP read tools stopped answering for staff: they are billed in Copilot
// credits and the tenant had none). The plain Web API is not metered. With `get`, `query` (many rows) and `image`
// (a record's picture), a staff Claude needs no MCP call to read anything: rows, one record, table and column
// definitions, choice labels, functions such as WhoAmI.
//
// Why it cannot write: the read connection (lib/cli.js readConnection) has no method but GET, and an OData GET
// changes nothing (functions are side-effect free; every action is a POST). The path is checked anyway so a read can
// only reach this environment's data API: never another host, never `..`, never $batch, never the raw /$value bytes
// (the Dataverse CLI prints them as text and corrupts them; `image` reads pictures).
//
// Where: the same ~/sbrm-reads/ folder as `query` and `image` (never in git or OneDrive; a read can hold client
// records). `--print` also prints a small answer into the conversation, the way the MCP tools did.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const query = require('./query');

const MAX_PATH = 4000;
const DEFAULT_MAX = 5000;
const MAX_MAX = 500000;
const PRINT_MAX = 20000;
const PREFIX = 'api/data/v9.2/';

// The path as it will be sent (relative to api/data/v9.2/, spaces encoded), or { problem }.
function cleanPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { problem: 'name the Web API path to read, e.g. contacts?$select=fullname&$top=5' };
  let p = raw.trim();
  if (p.length > MAX_PATH) return { problem: `the path is longer than ${MAX_PATH} characters` };
  if (/[\x00-\x1f\x7f]/.test(p)) return { problem: 'the path holds a control character' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) return { problem: 'give the path only (e.g. contacts?$top=5), not a full address: the engine reads only this app\'s own Dataverse' };
  p = p.replace(/^\/+/, '');
  if (p.toLowerCase().startsWith(PREFIX)) p = p.slice(PREFIX.length).replace(/^\/+/, '');
  // The route (the part before "?") is checked AFTER the prefix comes off (review F1: "api/data/v9.2/api/mcp" left
  // "api/mcp", which the CLI sends as is) and as Dataverse would read it, every %xx decoded (round 2 R2: ".%2e" and
  // "%24value" got past a check of the literal text). A route that does not decode is refused. The query string is
  // not held to these: a filter may compare against any text.
  let route;
  try { route = decodeURIComponent(p.split('?')[0]); } catch { return { problem: 'the path has a % that is not a valid escape' }; }
  if (/\\/.test(route)) return { problem: 'the path holds a backslash' };
  if (/(^|\/)\.\.?(\/|$)/.test(route)) return { problem: 'the path may not climb out with ..' };
  if (/^api\//i.test(route.replace(/^\/+/, ''))) return { problem: 'only the data API (api/data/v9.2/...) is read here' };
  if (/(^|\/)\$batch\b/i.test(route)) return { problem: '$batch is a POST: it is never sent from here' };
  if (/\/\$value$/i.test(route)) return { problem: 'the raw /$value form arrives corrupted through the Dataverse CLI; read a picture with `image`, a text column by name' };
  if (p.includes('#')) return { problem: 'the path may not hold #' };
  // A shell that expands "$select" inside double quotes leaves "?=fullname": the read would silently ask for the
  // wrong thing. Said plainly instead.
  const qs = p.includes('?') ? p.slice(p.indexOf('?') + 1) : null;
  if (qs !== null && qs.split('&').some((part) => part === '' || part.startsWith('='))) {
    return { problem: 'part of the query has no name (e.g. "?=fullname"): the shell took a $ out of the path. Wrap the path in single quotes, or write \\$ inside double quotes' };
  }
  return { path: p.replace(/ /g, '%20') };
}

// Usage problems, as reasons; [] when the request is well formed.
function validate({ env, raw, opt, envs }) {
  const bad = [];
  if (!env || !envs[env]) bad.push(`unknown app "${env || ''}"; one of: ${Object.keys(envs).join(', ')}`);
  const c = cleanPath(raw);
  if (c.problem) bad.push(c.problem);
  if (opt.all !== undefined && opt.all !== true) bad.push('--all takes no value');
  if (opt.print !== undefined && opt.print !== true) bad.push('--print takes no value');
  if (opt.max !== undefined && !(/^\d+$/.test(String(opt.max)) && Number(opt.max) >= 1 && Number(opt.max) <= MAX_MAX)) bad.push(`--max takes a whole number from 1 to ${MAX_MAX}`);
  if (opt.max !== undefined && opt.all !== true) bad.push('--max goes with --all (it caps how many rows the pages add up to)');
  if (opt.name !== undefined && (opt.name === true || !/^[A-Za-z0-9_-]{1,60}$/.test(opt.name))) bad.push('--name takes up to 60 letters, digits, - or _');
  return bad;
}

// One GET, or with `all` every page of a collection (up to `max` rows). Display labels are asked for, so a choice
// or lookup also reads as text, as in `query`. Returns { body, rows, pages, truncated }.
function read(dv, p, { all = false, max = DEFAULT_MAX } = {}) {
  const first = dv.get(p, { formatted: true, pageSize: all ? query.PAGE_SIZE : 0 });
  if (!all || !Array.isArray(first.value)) return { body: first, rows: Array.isArray(first.value) ? first.value.length : null, pages: 1, truncated: Boolean(first['@odata.nextLink']) };
  const value = [];
  let page = first;
  let pages = 1;
  let truncated = false;
  for (;;) {
    for (const r of page.value || []) {
      if (value.length >= max) { truncated = true; break; }
      value.push(r);
    }
    const next = query.nextPath(page['@odata.nextLink']);
    if (truncated || !next) { truncated = truncated || (value.length >= max && Boolean(next)); break; }
    // A next-page link comes from Dataverse, but it is held to the same rules as the person's path (review F2).
    const checked = cleanPath(next);
    if (checked.problem) throw Object.assign(new Error(`Dataverse's next-page link was not followed: ${checked.problem}`), { code: 'bad_next_link' });
    page = dv.get(checked.path, { formatted: true, pageSize: query.PAGE_SIZE });
    pages += 1;
  }
  const body = { ...first, value };
  delete body['@odata.nextLink'];
  return { body, rows: value.length, pages, truncated };
}

// The part of the path that names what was read, safe for a file name ("contacts", "EntityDefinitions").
function slug(p) {
  return (p.split('?')[0].split(/[(/]/)[0] || 'read').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'read';
}

function stamp(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

// Write atomically; returns the file path. The name ends in milliseconds and 4 random hex characters, so two reads of
// one table in the same second (two Claude runs side by side) never land in one file (review F4).
function save(dir, { env, p, opt, result, now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const unique = `${String(now.getMilliseconds()).padStart(3, '0')}${crypto.randomBytes(2).toString('hex')}`;
  const file = path.join(dir, `${env}-get-${slug(p)}${opt.name ? `-${opt.name}` : ''}-${stamp(now)}-${unique}.json`);
  const body = JSON.stringify({
    meta: { env, path: p, read_at: now.toISOString(), rows: result.rows, pages: result.pages, truncated: result.truncated },
    body: result.body,
  }, null, 1);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// One line saying what came back, without its contents.
function describe(result) {
  const b = result.body || {};
  const more = result.pages > 1 ? ' (more exist: raise --max, or narrow the filter)' : ' (more exist: add --all, or narrow the filter)';
  if (result.rows !== null) return `${result.rows} row(s)${result.pages > 1 ? ` over ${result.pages} pages` : ''}${result.truncated ? more : ''}`;
  const keys = Object.keys(b).filter((k) => !k.startsWith('@'));
  return `one object with ${keys.length} field(s)${keys.length ? `: ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', ...' : ''}` : ''}`;
}

module.exports = { cleanPath, validate, read, save, slug, describe, MAX_PATH, DEFAULT_MAX, MAX_MAX, PRINT_MAX };
