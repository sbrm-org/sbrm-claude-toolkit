'use strict';
// `image` (1.11.42): a READ-ONLY download of a record's full-size image column into a file, for the person's Claude
// to look at (Dylan 11/23/26: "everything that's like recurring that we can build into the toolkit, we should,
// particularly if it doesn't use copilot credits"). First use: the check scans of a mail batch,
// msnfp_transaction.sbrm_paymentimage, for the batch review.
//
// Why it exists: the MCP read connection's file_download tool is billed in Copilot credits and stopped answering on
// 11/23/26 ("User is not entitled to perform operation") once the tenant had none. The plain Web API is not metered
// and serves the same image: a GET of the column WITHOUT /$value,
//   <set>(<id>)/<column>?size=full
// answers JSON {"value": "<base64>"} (measured 11/23/26, donorapp: 520,206 bytes, a complete JPEG). The /$value form
// answers raw bytes, which the Dataverse CLI prints as text and corrupts, so it is never used. The read connection
// answers GETs only; nothing here can write to Dataverse.
//
// Where: the same ~/sbrm-reads/ folder as `query` (outside the engine's store, never in git or OneDrive: a scan is a
// donor's check). Files older than query.KEEP_DAYS are deleted on every run.

const fs = require('fs');
const path = require('path');
const { GUID } = require('./contract');
const { DataverseError } = require('./cli');

const MAX_IDS = 200;
const MAX_BYTES = 30 * 1024 * 1024;
const EXTS = ['jpg', 'png', 'gif', 'bmp', 'webp', 'tif'];

// Usage problems, as reasons; [] when the request is well formed.
function validate({ env, set, column, ids, envs }) {
  const bad = [];
  if (!env || !envs[env]) bad.push(`unknown app "${env || ''}"; one of: ${Object.keys(envs).join(', ')}`);
  if (!set || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(set)) bad.push(`the table must be its entity SET name (plural, letters/digits/underscore), not "${set || ''}"`);
  if (!column || !/^[a-z_][a-z0-9_]*$/.test(column)) bad.push(`the column must be the image column's logical name (lower case), not "${column || ''}"`);
  if (!Array.isArray(ids) || !ids.length) bad.push('name at least one record id');
  else if (ids.length > MAX_IDS) bad.push(`at most ${MAX_IDS} records in one run`);
  else {
    const wrong = ids.filter((i) => !GUID.test(String(i)));
    if (wrong.length) bad.push(`not a record id (GUID): ${wrong.slice(0, 3).join(', ')}`);
    if (new Set(ids.map((i) => String(i).toLowerCase())).size !== ids.length) bad.push('a record id is listed twice');
  }
  return bad;
}

// What kind of picture the bytes are, by their signature (never by a name the record carries).
function kind(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 6 && (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length >= 4 && (buf.slice(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || buf.slice(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) return 'tif';
  return 'bin';
}

// An empty answer means "no picture" only if the record exists: measured 11/23/26, Dataverse answers an empty image
// column AND a record id that does not exist the same way, with nothing at all (review finding F9). One more GET,
// only for empty answers (a cash gift has no scan). Returns null, or a problem.
function recordProblem(dv, set, id) {
  try {
    const r = dv.get(`${set}(${String(id).toLowerCase()})?$select=createdon`);
    return r && r.createdon ? null : 'there is no such record';
  } catch (e) {
    if (!(e instanceof DataverseError)) throw e;
    if (/0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return 'there is no such record';
    return String(e.message).slice(0, 300);
  }
}

// One record's image: { bytes } (a Buffer), { none: true } when the record exists and has no image, or { problem }.
// Every Dataverse error is a problem, said with Dataverse's own words: a misspelt column answers "Resource not found
// for the segment ..." (0x80060888, measured 11/23/26), which must not read as "no image" (review F7).
function fetchOne(dv, set, column, id, { thumb = false } = {}) {
  let res;
  try {
    res = dv.get(`${set}(${String(id).toLowerCase()})/${column}${thumb ? '' : '?size=full'}`);
  } catch (e) {
    if (!(e instanceof DataverseError)) throw e;
    if (/0x80040217|does not exist/i.test(`${e.code} ${e.message}`)) return { problem: 'there is no such record' };
    return { problem: String(e.message).slice(0, 300) };
  }
  const value = res && res.value;
  if (value === null || value === undefined || value === '') {
    const p = recordProblem(dv, set, id);
    return p ? { problem: p } : { none: true };
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return { problem: 'the answer was not an image (the column may not be an image column)' };
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length) return { none: true };
  if (bytes.length > MAX_BYTES) return { problem: `the image is ${bytes.length} bytes, over the ${MAX_BYTES}-byte limit` };
  // Decodable text is not a picture (review F8): only the picture types an image column holds are saved.
  const k = kind(bytes);
  if (k === 'bin') return { problem: 'the answer is not a picture (the column may not be an image column)' };
  // A picture that starts right but stops short is not saved as complete (round 2 R6). JPEG and PNG, the scan types,
  // must end with their end marker; the rarer types are only held to a size no real picture is below.
  if (!complete(bytes, k)) return { problem: `the ${k} picture is cut short (${bytes.length} bytes); it was not saved` };
  return { bytes };
}

const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
function complete(buf, k) {
  if (k === 'jpg') {
    // the end-of-image marker, allowing for padding some scanners write after it
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0x00) end -= 1;
    return end >= 4 && buf[end - 2] === 0xff && buf[end - 1] === 0xd9;
  }
  if (k === 'png') return buf.length >= 8 + 12 + 12 && buf.slice(buf.length - 8).equals(IEND);
  if (k === 'gif') return buf.length >= 14 && buf[buf.length - 1] === 0x3b;
  return buf.length >= 32;
}

// Write atomically; returns the file path. The name carries no record text, only the app, table, column and id.
function save(dir, { env, set, column, id, bytes, thumb = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${env}-${set}-${column}-${String(id).toLowerCase()}${thumb ? '-thumb' : ''}.${kind(bytes)}`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
  return file;
}

// Images this command saved that are past their keep time, and any half-written temp file the read commands left
// (`<file>.<pid>.tmp`, a run stopped between the write and the rename; review F6) older than a day. query.purge
// handles its own .json / .csv files. Run by every read command (`get`, `query`, `image`; review F5).
const TMP = /^[a-z0-9_]+-.+\.(json|csv|jpg|png|gif|bmp|webp|tif)\.\d+\.tmp$/i;
function purge(dir, keepDays, now = Date.now()) {
  if (!fs.existsSync(dir)) return 0;
  const mine = new RegExp(`\\.(${EXTS.join('|')})$`, 'i');
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const tmp = TMP.test(f);
    if (!tmp && !mine.test(f)) continue;
    const p = path.join(dir, f);
    const limit = tmp ? 24 * 3600 * 1000 : keepDays * 24 * 3600 * 1000;
    try {
      if (now - fs.statSync(p).mtimeMs > limit) { fs.rmSync(p); n += 1; }
    } catch { /* gone or locked: next run */ }
  }
  return n;
}

// Every id in turn: [{ id, file, bytes, kind } | { id, none: true } | { id, problem }].
function readAll(dv, { env, set, column, ids, thumb = false, dir }) {
  const out = [];
  for (const id of ids) {
    const r = fetchOne(dv, set, column, id, { thumb });
    if (r.bytes) out.push({ id, file: save(dir, { env, set, column, id, bytes: r.bytes, thumb }), bytes: r.bytes.length, kind: kind(r.bytes) });
    else out.push({ id, ...r });
  }
  return out;
}

module.exports = { validate, kind, complete, fetchOne, recordProblem, save, purge, readAll, MAX_IDS, MAX_BYTES, EXTS };
