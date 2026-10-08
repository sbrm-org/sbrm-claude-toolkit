'use strict';
// Who may write (DESIGN.md §6c, CONTRACT.md §6), read LIVE from the environment's own Dataverse Write
// Access table (`sbrm_dataversewriteaccess`), through the person's own sign-in. Moved out of the toolkit's
// access.json on 10/7/26 (Dylan: the GitHub repo must stay public, so no staff emails in it).
//
//   - one row per person per environment: email (the key), level read | write | schema, rows per approval
//     (blank = the toolkit default), may merge (yes/no; schema implies it);
//   - absent person = read; a row with an unknown level = read (never more than it says);
//   - staff hold READ ONLY on the table, so nobody's Claude can grant itself anything, and the engine
//     refuses any job aimed at the toolkit's own tables unless the person holds schema;
//   - FAIL CLOSED: if the list cannot be read, every write in that environment is refused.
//
// It returns the same shape access.json had ({ default_max_rows, people: { email: { envs, max_rows, merge } } }),
// so accessFor / mergeAccess and every library caller are unchanged.

const ACCESS_SET = 'sbrm_dataversewriteaccesses';
const TOOLKIT_SETS = new Set(['sbrm_dataversewritelogs', 'sbrm_dataverseevents', ACCESS_SET]);
const LEVELS = new Set(['read', 'write', 'schema']);

function readAccess(dv, env, { default_max_rows = 25 } = {}) {
  let rows;
  try {
    rows = dv.get(`${ACCESS_SET}?$select=sbrm_name,sbrm_email,sbrm_level,sbrm_maxrows,sbrm_merge&$filter=${encodeURIComponent('statecode eq 0')}`).value || [];
  } catch (e) {
    throw Object.assign(new Error(`could not read the Dataverse Write Access list in this app (${String(e.message).slice(0, 160)}), so writes here are refused until it can be read. Ask Dylan.`), { code: 'access_unreadable' });
  }
  const people = {};
  for (const r of rows) {
    const email = String(r.sbrm_email || '').trim().toLowerCase();
    if (!email) continue;
    const raw = String(r.sbrm_level || '').trim().toLowerCase();
    const p = { envs: { [env]: LEVELS.has(raw) ? raw : 'read' }, merge: { [env]: r.sbrm_merge === true } };
    if (Number.isInteger(r.sbrm_maxrows) && r.sbrm_maxrows > 0) p.max_rows = r.sbrm_maxrows;
    if (r.sbrm_name) p.name = String(r.sbrm_name);
    people[email] = p;
  }
  return { default_max_rows, people };
}

// An `access` argument may be the object itself (tests, library callers) or a function the caller hands
// over to read it once the connection exists (apply connects inside).
function resolveAccess(access, dv, env) {
  return typeof access === 'function' ? access(dv, env) : access;
}

// Several environments' lists as one (the review's list of who may write anywhere).
function mergeAccessLists(lists) {
  const out = { default_max_rows: (lists[0] || {}).default_max_rows, people: {} };
  for (const l of lists) {
    for (const [email, p] of Object.entries(l.people || {})) {
      const o = out.people[email] || (out.people[email] = { envs: {}, merge: {} });
      Object.assign(o.envs, p.envs);
      Object.assign(o.merge, p.merge);
      if (p.max_rows !== undefined) o.max_rows = p.max_rows;
      if (p.name) o.name = p.name;
    }
  }
  return out;
}

module.exports = { readAccess, resolveAccess, mergeAccessLists, ACCESS_SET, TOOLKIT_SETS };
