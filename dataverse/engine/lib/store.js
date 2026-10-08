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

// The ACCOUNT's own folder, from the operating system, not the HOME / USERPROFILE environment variables a
// run can override (10/7 re-verify: `USERPROFILE=/tmp/x node <engine> apply` moved plans and the local log
// out of the folder the guard protects; os.userInfo() ignores the override, checked live on Windows).
function accountHome() {
  try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); }
}

function home(env = process.env) {
  return env.SBRM_DV_HOME || path.join(accountHome(), '.sbrm-dataverse');
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

// Plans are SIGNED (1.10.1, after the 10/7 third adversarial pass): an HMAC under a key kept in this
// machine's store (config/plan.key), which the guard keeps every session tool from reading or writing.
// Before, the hash was a plain SHA-256 anyone could recompute, so "apply trusts the plan record" rested on
// the guard keeping sessions out of the plans folder alone; now a forged or edited plan also fails the
// signature unless the key itself leaks. `created` is signed too (it was left out, so the 24-hour limit
// could be reset by editing one field).
// Made ONCE, with an exclusive create, so two engine runs starting together agree on one key (the loser of
// the race reads the winner's). A key file that exists but is not a 64-hex key is NOT silently replaced:
// that would void every outstanding plan without a word (final re-verify); the run stops and says so.
function planKey(env) {
  const file = path.join(dir('config', env), 'plan.key');
  if (!fs.existsSync(file)) {
    // Written whole to a temp file, then LINKED into place: the link is atomic and fails if the key exists,
    // so no run ever reads a half-written key and the first one wins.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex'), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if (e.code !== 'EEXIST') { fs.rmSync(tmp, { force: true }); throw e; }
    }
    fs.rmSync(tmp, { force: true });
  }
  const k = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(k)) {
    throw Object.assign(new Error(`the plan signing key (${file}) is damaged, so no plan can be checked. Ask Dylan; nothing was written.`), { code: 'engine_bug' });
  }
  return Buffer.from(k, 'hex');
}

function planHash(plan, { env } = {}) {
  const { hash, id, ...rest } = plan; // eslint-disable-line no-unused-vars
  return crypto.createHmac('sha256', planKey(env)).update(canonical(rest)).digest('hex');
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
  const withNonce = { ...plan, nonce: crypto.randomBytes(8).toString('hex'), created: now.toISOString() };
  const hash = planHash(withNonce, { env });
  const id = `${stamp(now)}-${hash.slice(0, 8)}`;
  const record = { ...withNonce, id, hash };
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
  // Signed: an edit to any field (created included) fails unless the signer's key is used, and the guard
  // keeps sessions away from the key as well as the plans. Compared in constant time.
  const hash = planHash(record, { env });
  const ok = typeof record.hash === 'string' && record.hash.length === hash.length
    && crypto.timingSafeEqual(Buffer.from(record.hash), Buffer.from(hash));
  return { file, record, intact: ok && record.id === id && id.endsWith(hash.slice(0, 8)) };
}

module.exports = { home, dir, canonical, planHash, planKey, savePlan, loadPlan, PLAN_ID };
