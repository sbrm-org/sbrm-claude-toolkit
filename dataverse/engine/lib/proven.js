'use strict';
// "Tried in the dev copy first?" (DESIGN.md §10d, ruled 10/7: a warning line, never a refusal).
//
// An app with a dev copy names it in envs.json (`dev`: the Donor App's is Donor App Dev). A change to
// something LIVE there (an existing flow, form, view, sitemap or column setting) may carry `proven_in`:
// the plan id of the same change applied in the dev copy. The engine reads that plan's entry from the dev
// copy's Write Log and checks it was APPLIED and was THE SAME CHANGE (the caller's `matches`, which compares
// what the entry touched with what this job touches). Anything else, or no `proven_in`, and the pop-up says
// "Not tried in <dev> first". Added after the 10/7 blind review: citing any unrelated applied plan used to
// silence the line. Additive changes (a new table, column, view, flow created Off) never get the line.
// READS ONLY.

const { LOG_SET } = require('./log');

function parseEntry(text) {
  const m = /```json\n([\s\S]*?)\n```/.exec(String(text || ''));
  return m ? JSON.parse(m[1]) : null;
}

// null when nothing needs saying; otherwise the phrase for severity.assess({ unproven }).
// matches(entry) -> true, or a short reason it is not the same change.
function unprovenPhrase({ env, envs, provenIn = null, readEnv, matches = null }) {
  const devKey = (envs[env] || {}).dev;
  if (!devKey || !envs[devKey]) return null; // no dev copy: no line (HGS, Recovery, Sober Living, the dev copy itself)
  const devName = envs[devKey].name;
  if (!provenIn) return `Not tried in ${devName} first`;
  let entry = null;
  try {
    const dv = readEnv(devKey);
    const rows = dv.get(`${LOG_SET}?$select=sbrm_planid,sbrm_outcome,sbrm_entry&$filter=${encodeURIComponent(`sbrm_planid eq '${String(provenIn).replace(/'/g, "''")}'`)}`).value || [];
    const row = rows.find((r) => r.sbrm_outcome === 'applied') || null;
    entry = row ? parseEntry(row.sbrm_entry) : null;
  } catch {
    entry = null;
  }
  if (!entry) return `Not tried in ${devName} first (plan ${provenIn} is not in its Write Log as applied)`;
  if (!matches) return `Not tried in ${devName} first (plan ${provenIn} could not be compared with this change)`;
  const same = matches(entry);
  return same === true ? null : `Not tried in ${devName} first (plan ${provenIn} was a different change: ${same || 'it touched other things'})`;
}

module.exports = { unprovenPhrase, parseEntry };
