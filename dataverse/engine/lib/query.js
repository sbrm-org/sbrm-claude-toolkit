'use strict';
// `query` (1.11.8): a READ-ONLY bulk read of one table into a file, for the person's Claude to process with a
// script (Dylan 10/9/26: "especially daian will need to do reads over hundreds of rows"). The read connection
// answers GETs only; nothing here can write to Dataverse.
//
// Why a file and not the chat: the MCP read tool puts every row into the conversation, which is slow, costly
// and read by eye past a few dozen rows. Here the rows go to disk and only the count, the columns and the path
// are printed, so a script does the work (the way Dylan's own sessions read with TDS).
//
// Where: ~/sbrm-reads/ (SBRM_DV_READS for tests), deliberately OUTSIDE the engine's store, which the guard
// protects, so scripts may read these files freely. Never inside a git-tracked folder or OneDrive: a read can
// hold client records (Recovery is HIPAA; client information is never persisted where it can travel). Files
// older than KEEP_DAYS are deleted on every query.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { gitExposure } = require('./safety');

const KEEP_DAYS = 7;
const PAGE_SIZE = 5000;
const DEFAULT_MAX = 50000;
const MAX_MAX = 500000;
const FV = '@OData.Community.Display.V1.FormattedValue';

function readsDir(env = process.env) {
  if (env.SBRM_DV_READS) return env.SBRM_DV_READS;
  let home;
  try { home = os.userInfo().homedir || os.homedir(); } catch { home = os.homedir(); }
  return path.join(home, 'sbrm-reads');
}

// A refusal reason, or null when the folder is a safe place for client records.
function exposure(dir) {
  if (/onedrive/i.test(dir)) return `the reads folder (${dir}) is inside OneDrive, which syncs it off this machine; a read can hold client records`;
  const s = gitExposure(dir);
  if (s.exposed) return `the reads folder (${dir}) is inside a git-tracked folder (${s.repo}); a read can hold client records and git can carry them`;
  return null;
}

function purge(dir, now = Date.now()) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(json|csv)$/i.test(f)) continue;
    const p = path.join(dir, f);
    try {
      if (now - fs.statSync(p).mtimeMs > KEEP_DAYS * 24 * 3600 * 1000) { fs.rmSync(p); n += 1; }
    } catch { /* gone or locked: next run */ }
  }
  return n;
}

// Usage problems, as reasons; [] when the request is well formed.
function validate({ env, set, opt, envs }) {
  const bad = [];
  if (!env || !envs[env]) bad.push(`unknown app "${env || ''}"; one of: ${Object.keys(envs).join(', ')}`);
  if (!set || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(set)) bad.push(`the table must be its entity SET name (plural, letters/digits/underscore), not "${set || ''}"`);
  if (opt.select !== undefined && (opt.select === true || !/^[A-Za-z0-9_]+(?:,[A-Za-z0-9_]+)*$/.test(opt.select))) bad.push('--select takes column logical names separated by commas, no spaces');
  for (const k of ['filter', 'orderby', 'expand']) if (opt[k] === true) bad.push(`--${k} needs a value`);
  if (opt.max !== undefined && !(/^\d+$/.test(String(opt.max)) && Number(opt.max) >= 1 && Number(opt.max) <= MAX_MAX)) bad.push(`--max takes a whole number from 1 to ${MAX_MAX}`);
  if (opt.name !== undefined && (opt.name === true || !/^[A-Za-z0-9_-]{1,60}$/.test(opt.name))) bad.push('--name takes up to 60 letters, digits, - or _');
  return bad;
}

function firstPath(set, opt) {
  const q = [];
  if (opt.select) q.push(`$select=${opt.select}`);
  if (opt.filter) q.push(`$filter=${encodeURIComponent(opt.filter)}`);
  if (opt.orderby) q.push(`$orderby=${encodeURIComponent(opt.orderby)}`);
  if (opt.expand) q.push(`$expand=${encodeURIComponent(opt.expand)}`);
  return q.length ? `${set}?${q.join('&')}` : set;
}

// "https://host/api/data/v9.2/x?..." -> "/api/data/v9.2/x?..." (the same shape lib/merge.js uses).
function nextPath(link) {
  return link ? '/' + String(link).split('/').slice(3).join('/') : null;
}

// Drop etags; turn "<col>@...FormattedValue" into "<col>@label"; keep everything else as read.
function clean(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === '@odata.etag') continue;
    if (k.endsWith(FV)) out[`${k.slice(0, -FV.length)}@label`] = v;
    else if (!k.includes('@')) out[k] = v;
  }
  return out;
}

function read(dv, set, opt) {
  const max = opt.max ? Number(opt.max) : DEFAULT_MAX;
  const rows = [];
  let p = firstPath(set, opt);
  let truncated = false;
  let pages = 0;
  while (p) {
    const page = dv.get(p, { formatted: true, pageSize: PAGE_SIZE });
    pages += 1;
    for (const r of page.value || []) {
      if (rows.length >= max) { truncated = true; break; }
      rows.push(clean(r));
    }
    if (truncated || rows.length >= max) { truncated = truncated || Boolean(page['@odata.nextLink']); break; }
    p = nextPath(page['@odata.nextLink']);
  }
  return { rows, truncated, pages, max };
}

function columns(rows) {
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const cols = columns(rows);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Write atomically; returns the file path.
function save(dir, { env, set, opt, result, now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${env}-${set}${opt.name ? `-${opt.name}` : ''}-${stamp(now)}.${opt.csv ? 'csv' : 'json'}`;
  const file = path.join(dir, name);
  const body = opt.csv ? toCsv(result.rows) : JSON.stringify({
    meta: {
      env, table: set, read_at: now.toISOString(), count: result.rows.length, truncated: result.truncated,
      select: opt.select || null, filter: opt.filter || null, orderby: opt.orderby || null, expand: opt.expand || null,
    },
    rows: result.rows,
  }, null, 1);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { readsDir, exposure, purge, validate, firstPath, nextPath, clean, read, columns, toCsv, save, KEEP_DAYS, PAGE_SIZE, DEFAULT_MAX };
