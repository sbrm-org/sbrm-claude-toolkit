'use strict';
// The engine's own per-user store (CONTRACT.md §5): ~/.sbrm-dataverse/{plans,log}.
// SBRM_DV_HOME overrides the root (tests).
//
// The plan hash covers the WHOLE canonical plan (every field except `created` and `hash`),
// not only the bodies. The Python engine hashed bodies alone, so an edited plan that pointed
// the same change at different record ids kept a valid token.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function home(env = process.env) {
  return env.SBRM_DV_HOME || path.join(os.homedir(), '.sbrm-dataverse');
}

function dir(name, env) {
  const d = path.join(home(env), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Sorted-key JSON, recursively. Arrays keep their order (row order is part of the plan).
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

function planHash(plan) {
  const { created, hash, id, ...rest } = plan; // eslint-disable-line no-unused-vars
  return crypto.createHash('sha256').update(canonical(rest)).digest('hex');
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Write atomically (temp file + rename) so a half-written plan never exists.
function savePlan(plan, { now = new Date(), env } = {}) {
  // A random nonce inside the hashed plan makes every plan id unique. Without it, the same job
  // planned twice in one second got the SAME id (found 10/6 by the apply tests), and the log is
  // keyed by plan id, so "revert <plan-id>" would have been ambiguous.
  const withNonce = { ...plan, nonce: crypto.randomBytes(8).toString('hex') };
  const hash = planHash(withNonce);
  const id = `${stamp(now)}-${hash.slice(0, 8)}`;
  const record = { ...withNonce, id, created: now.toISOString(), hash };
  const file = path.join(dir('plans', env), `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return { id, file, record };
}

const PLAN_ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

function loadPlan(id, { env } = {}) {
  if (!PLAN_ID.test(id)) throw Object.assign(new Error(`not a plan id: ${id}`), { code: 'no_plan' });
  const file = path.join(dir('plans', env), `${id}.json`);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`no plan ${id} (already applied, or never made on this machine)`), { code: 'no_plan' });
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Tamper-EVIDENT, not tamper-proof: anything running as the user can rewrite the file and
  // the hash together. What protects the person is that the pop-up is rendered from THIS
  // record at apply, so what they approve is what gets written; the plugin hook keeps a
  // session's Write/Edit out of the store (DESIGN.md §7).
  const hash = planHash(record);
  return { file, record, intact: hash === record.hash && record.id === id && id.endsWith(hash.slice(0, 8)) };
}

module.exports = { home, dir, canonical, planHash, savePlan, loadPlan, PLAN_ID };
