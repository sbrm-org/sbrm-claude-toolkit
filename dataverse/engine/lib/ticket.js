'use strict';
// One-time approval tickets (DESIGN.md §10n, ruled 10/8; toolkit 1.11.0). They replace the OS pop-up.
//
// The person approves a write in Claude Code's own permission prompt: the guard (guard/guard.js) answers an
// `apply` with Claude Code's "ask" decision, which the model cannot answer. At that moment the guard MINTS a
// ticket for each plan id on the line; the engine TAKES (checks and uses up) the ticket for its plan before
// it writes. A command disguised past the guard gets no prompt AND no ticket, so the engine refuses it.
//
//   ~/.sbrm-dataverse/config/tickets/<plan id | resolve-D-1003>.json  { key, created, nonce, sig }
//   sig = HMAC-SHA256(plan key, "ticket|<key>|<created>|<nonce>")   (the plan key: lib/store.js planKey)
//
// The config folder and the key are guard-protected from every session tool, so a session can neither read
// the key nor plant a ticket. A ticket lives TTL_MS (long enough for a person to read the prompt); one the
// person declined is never used by its own command and expires. Residual (said to Dylan): a disguised run
// that lands while a real ticket for the same plan is still fresh.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

// Ten minutes (RULED 10/9, Dylan: "Go back to 10 minutes"). A blind review cut it to three on 10/8; in the first
// two days eight approvals came after three minutes (six on 10/9, both people, prompts waiting in another tab),
// each one a re-run and a second Yes. A declined prompt's ticket stays usable the extra minutes only to a run the
// guard lets through, which is the same residual as before. An approval that comes later is refused, and the
// apply is simply run again.
const TTL_MS = 10 * 60 * 1000;
const KEY = /^(?:\d{8}-\d{6}-[0-9a-f]{8}|resolve-[DHRSF]-\d{4,})$/;

function folder(env) {
  return store.dir(path.join('config', 'tickets'), env);
}

function fileFor(key, env) {
  if (!KEY.test(String(key))) throw new Error(`not an approval key: ${key}`);
  return path.join(folder(env), `${key}.json`);
}

function sign(key, created, nonce, env) {
  return crypto.createHmac('sha256', store.planKey(env)).update(`ticket|${key}|${created}|${nonce}`).digest('hex');
}

// The app a plan belongs to, for filing (null: a resolve, or the plan is gone).
function planEnv(key, env) {
  try { return JSON.parse(fs.readFileSync(path.join(store.dir('plans', env), `${key}.json`), 'utf8')).env || null; } catch { return null; }
}

// Drop tickets past their time. A ticket still here was never used: Claude Code asked and the person said No,
// or never answered (an approval given late is used up as `approval_expired` by take()). Each one is counted
// for the review as `approval_unused` (1.11.6, DESIGN.md §11, candidate 5): many would mean the prompts
// confuse people. The rename is the claim, so two sweeps cannot both count one ticket.
function sweep({ env, now = Date.now() } = {}) {
  let names = [];
  try { names = fs.readdirSync(folder(env)); } catch { return; }
  for (const n of names) {
    const f = path.join(folder(env), n);
    try {
      if (now - fs.statSync(f).mtimeMs <= TTL_MS + 60 * 1000) continue;
      if (!n.endsWith('.json')) { fs.rmSync(f, { force: true }); continue; } // a temp or claimed leftover
      const claimed = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.swept`;
      fs.renameSync(f, claimed);
      fs.rmSync(claimed, { force: true });
      const key = n.slice(0, -'.json'.length);
      try {
        const note = require('./note');
        const at = new Date(now);
        note.note({
          id: note.newId('A', at), time: at, kind: 'approval not used', code: 'approval_unused', signal: false,
          env: planEnv(key, env) || 'machine', by: 'guard',
          headline: `Claude Code asked to approve ${key.startsWith('resolve-') ? `closing ${key.slice('resolve-'.length)}` : `plan ${key}`} and it never ran (declined or not answered)`,
          detail: `Approval key: ${key}`,
        });
      } catch { /* counting is extra; the ticket is gone either way */ }
    } catch { /* gone already, or another sweep claimed it */ }
  }
}

// The guard's half: one ticket per approval key, written whole (temp file + rename).
function mint(key, { env, now = Date.now() } = {}) {
  const file = fileFor(key, env);
  const created = new Date(now).toISOString();
  const nonce = crypto.randomBytes(8).toString('hex');
  const t = { key, created, nonce, sig: sign(key, created, nonce, env) };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  sweep({ env, now });
  return t;
}

// Is there a good, fresh ticket for this key? Reads only. { ok, why }.
function check(key, { env, now = Date.now() } = {}) {
  let file;
  try { file = fileFor(key, env); } catch { return { ok: false, why: 'not a plan id' }; }
  let t;
  try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, why: 'missing' }; }
  if (!t || t.key !== key || typeof t.sig !== 'string' || typeof t.created !== 'string' || typeof t.nonce !== 'string') return { ok: false, why: 'damaged' };
  const want = sign(key, t.created, t.nonce, env);
  if (t.sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(t.sig), Buffer.from(want))) return { ok: false, why: 'not signed by this machine' };
  const age = now - Date.parse(t.created);
  if (!(age >= -60 * 1000 && age <= TTL_MS)) return { ok: false, why: 'expired' };
  return { ok: true, file };
}

// The engine's half: check, then use it up. The rename is the claim, so two runs cannot both use one ticket.
function take(key, opts = {}) {
  const c = check(key, opts);
  if (!c.ok) {
    // An approval given too late: used up here, so the sweep does not also count it as never used (1.11.6).
    if (c.why === 'expired') { try { fs.rmSync(fileFor(key, opts.env), { force: true }); } catch { /* gone */ } }
    return c;
  }
  const claimed = `${c.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.used`;
  try { fs.renameSync(c.file, claimed); } catch { return { ok: false, why: 'already used' }; }
  fs.rmSync(claimed, { force: true });
  return { ok: true };
}

// An approval is waiting on this machine (a fresh ticket exists): the guard keeps screen-driving tools off
// Claude Code's prompt while one is open.
// Judged by each ticket's own signed check (blind review 10/8: the file time could drift from `created`).
function pending({ env, now = Date.now() } = {}) {
  try {
    return fs.readdirSync(folder(env)).filter((n) => n.endsWith('.json'))
      .some((n) => check(n.slice(0, -'.json'.length), { env, now }).ok);
  } catch {
    return false;
  }
}

// What the person and the log are told when an apply has no approval.
function refusalText(why) {
  if (why === 'expired') return 'the approval expired before the change started (it lasts ten minutes). Run the command again and approve it when Claude Code asks.';
  if (why === 'already used') return 'the approval for this change was already used. Run the command again and approve it when Claude Code asks.';
  return `this change was not approved in Claude Code's permission prompt (${why}). Run it as its own command so Claude Code asks, and approve it there.`;
}

module.exports = { mint, check, take, sweep, pending, refusalText, TTL_MS, KEY };
