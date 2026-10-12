#!/usr/bin/env node
'use strict';
// The toolkit nudge (1.11.9, DESIGN.md §12e): a UserPromptSubmit hook. Claude Code updates a plugin in the
// background and the running session keeps the old one, and when the update itself fails nobody hears. This
// tells the person's Claude, as context on their next prompt:
//   1. this session runs an older toolkit than the one now installed: once per session, "quit and reopen";
//   2. the last version check-in found the automatic update stuck (stale, or a release pending 3+ days):
//      once per machine per day, offer to update.
// File reads only (no network). Silent when there is nothing to say and on ANY failure: it must never get in
// the way of a prompt. run.sh exits 0 whatever happens here.

const fs = require('fs');
const path = require('path');

function main(input) {
  const c = require('../engine/lib/checkin');
  const { cmpVersion, isVersion } = require('../engine/lib/version');
  let session = 'unknown';
  try { session = JSON.parse(input).session_id || 'unknown'; } catch { /* still useful without it */ }
  const root = c.defaultRoot();
  const info = c.readPlugin(root);
  if (info.name !== c.PLUGIN_NAME) return null; // a dev copy says nothing
  const inst = c.readInstalled(c.pluginsDir(root));
  const cfg = c.settings();
  const file = path.join(c.eventsDir(), 'nudged.json');
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { seen = {}; }
  seen.sessions = seen.sessions || {};
  const now = new Date();
  const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  let text = null;

  if (isVersion(info.version) && isVersion(inst.version) && cmpVersion(info.version, inst.version) < 0) {
    if (!seen.sessions[session]) {
      const how = cfg.reload_plugins_applies ? 'run /reload-plugins, or quit Claude Code completely and reopen it' : 'quit Claude Code completely and reopen it';
      text = `SBRM toolkit: this computer now has toolkit ${inst.version} installed, but this session is still running ${info.version}. `
        + `Tell the person once, in one plain sentence at the end of your next reply: the SBRM toolkit updated while this session was open; at a good stopping point, ${how}. `
        + 'Nothing to run; nothing is wrong.';
      seen.sessions[session] = now.toISOString();
    }
  } else {
    const st = c.readState();
    const main = (st.main && st.main.version) || null;
    const firstSeen = st.main && st.main.first_seen_at ? new Date(st.main.first_seen_at) : null;
    const sameInstall = st.observed && st.observed.installed === inst.version;
    const behind = isVersion(main) && isVersion(inst.version) && cmpVersion(inst.version, main) < 0;
    const oldPending = st.state === 'pending' && firstSeen && now - firstSeen >= cfg.checkin_pending_days * 86400000;
    if (behind && sameInstall && (st.state === 'stale' || oldPending) && seen.stuck_day !== today) {
      const since = firstSeen ? ` out since ${firstSeen.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : '';
      text = `SBRM toolkit: a newer version (${main},${since}) has not reached this computer, which still has ${inst.version}; the automatic update is not pulling it. `
        + 'Tell the person once today, in plain words, and offer to update it. If they say yes, run these two commands yourself, one at a time: '
        + '`claude plugin marketplace update sbrm-claude-toolkit` then `claude plugin update sbrm-toolkit@sbrm-claude-toolkit`; then tell them to quit Claude Code completely and reopen it. '
        + 'If Claude Code will not let you run them, give the person the two lines to type themselves, each starting with ! . Never run them without their yes.';
      seen.stuck_day = today;
    }
  }
  if (!text) return null;
  // Forget sessions older than a week so the file stays small.
  for (const [k, v] of Object.entries(seen.sessions)) if (now - new Date(v) > 7 * 86400000) delete seen.sessions[k];
  try { fs.writeFileSync(file, JSON.stringify(seen), 'utf8'); } catch { /* say it anyway */ }
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    try {
      const out = main(input);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* silence: a nudge must never block a prompt */ }
    process.exit(0);
  });
}

module.exports = { main };
