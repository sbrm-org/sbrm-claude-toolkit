'use strict';
// review: Dylan's view of the whole toolkit (DESIGN.md §7 D5, sample in §7c). PURE: it takes the rows the
// CLI read from every environment's Write Log and event table and returns text. The CLI does the reads.
//
// Sections: People (last seen, writes, cancels, open, versions, not set up), Open (every open event, any
// age, oldest first, with the plan it names; a person's repeated health checks on one machine fold into the
// latest, which lists the earlier open runs and notes a later pass), Writes with problems (this period), Routine refusals (counts
// by reason, this period), Health checks (latest per person), and the silence rule: someone with write
// access who was active before and not seen for 14 days is flagged with the one action that settles it.
// The brief() line is what the Monday /good-morning shows during the launch review period.

const { atLeast, normalize } = require('./levels');
const { isVersion, cmpVersion, newest } = require('./version');

const DAY = 24 * 3600 * 1000;
const SILENT_DAYS = 14;

function md(d) {
  const x = new Date(d);
  return `${x.getMonth() + 1}/${x.getDate()}`;
}

function when(d) {
  const x = new Date(d);
  let h = x.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${md(d)} ${h}:${String(x.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function first(name) {
  return String(name || '').split(' ')[0] || name;
}

// input: { now, days, access, people: { email -> fullname },
//          logs:   [{ env, email, name, time, planid, headline, outcome, written, notwritten, leftout }],
//          events: [{ env, email, name, time, number, kind, code, signal, status, headline, words, planid, versions, machine }] }
// The toolkit version an event names (1.11.6 on), or null for an older one (the version said only "engine").
function toolkitOf(v) {
  const m = /toolkit (\d+(?:\.\d+)*)/.exec(String(v || ''));
  return m ? m[1] : null;
}

// The strict `key: value` lines a version check-in's detail leads with (lib/checkin.js, 1.11.9).
function parseCheckin(detail) {
  const out = {};
  const re = /^(running|installed|main|state|installed_since|session_uptime_min): (.*)$/gm;
  let m;
  while ((m = re.exec(String(detail || '')))) if (!(m[1] in out)) out[m[1]] = m[2].trim();
  return out;
}

// The Toolkit block (1.11.9, DESIGN.md §12d): each person's latest check-in per machine, graded against the
// main the reviewer fetched (else the newest version seen anywhere). Replaces 1.11.6's "behind" line, which
// learned a version only when someone wrote or was refused.
const RANK = ['stale', 'old', 'restart', 'pending', 'missing', 'ahead', 'current'];
function gradeToolkit({ now, people, checkins, events, toolkit, main, machineDays, pendingDays }) {
  const seen = [...checkins.flatMap((c) => [c.running, c.installed, c.main]), ...events.map((e) => toolkitOf(e.versions)), toolkit];
  const fetched = main && isVersion(main.version);
  const mainV = fetched ? main.version : newest(seen);
  if (!mainV) return null;
  const naming = checkins.filter((c) => [c.running, c.installed, c.main].includes(mainV)).map((c) => new Date(c.time));
  const out = naming.length ? new Date(Math.min(...naming)) : null;
  const grade = (c) => {
    const m = c.machine || 'unknown machine';
    if (c.state === 'unknown' || !isVersion(c.running) || !isVersion(c.installed)) {
      return { rank: 'missing', short: 'install record missing', text: `install record missing (${m}): a dev copy, or installed_plugins.json unreadable; ask` };
    }
    if (cmpVersion(c.running, mainV) > 0) return { rank: 'ahead', short: `ahead of main (${c.running})`, text: `ahead of main (${c.running})` };
    if (cmpVersion(c.running, c.installed) < 0) return { rank: 'restart', short: 'restart needed', text: `restart needed: running ${c.running}, ${c.installed} installed ${when(c.time)}` };
    if (cmpVersion(c.installed, mainV) < 0) {
      if (c.state === 'stale') return { rank: 'stale', short: 'AUTO-UPDATE NOT PULLING', text: `WARN auto-update not pulling: ${c.installed} installed, ${mainV} out since ${md(out || now)}; a session ran 1h+ without it` };
      const age = out ? Math.floor((now - out) / DAY) : 0;
      if (age >= pendingDays) return { rank: 'old', short: 'NOT UPDATED', text: `WARN not updated ${age} days after ${mainV} shipped (no session open 1h+ since; ask them to update by hand)` };
      return { rank: 'pending', short: 'pending', text: `${mainV} pending (out since ${out ? when(out) : 'now'}; last check-in ${when(c.time)})` };
    }
    return { rank: 'current', short: 'current', text: `current ${mainV}` };
  };
  const rows = people.map((p) => {
    const mine = checkins.filter((c) => c.email === p.email).sort((a, b) => new Date(a.time) - new Date(b.time));
    if (!mine.length) return { name: p.name, lastSeen: p.lastSeen, rank: 'none', short: 'no check-in', text: 'no check-in (not set up, or a toolkit before 1.11.9)' };
    const latest = {};
    for (const c of mine) latest[c.machine || ''] = c;
    const machines = Object.values(latest);
    const live = machines.filter((c) => now - new Date(c.time) <= machineDays * DAY);
    if (!live.length) {
      const last = new Date(Math.max(...machines.map((c) => new Date(c.time))));
      return { name: p.name, lastSeen: p.lastSeen, rank: 'quiet', short: 'no check-in lately', text: `no check-in since ${md(last)} (${machines.map((c) => c.machine).join(', ')})` };
    }
    const graded = live.map((c) => ({ c, ...grade(c) })).sort((a, b) => RANK.indexOf(a.rank) - RANK.indexOf(b.rank));
    const worst = graded[0];
    const text = graded.length === 1
      ? `${worst.text}   ${worst.c.machine}, checked ${when(worst.c.time)}`
      : graded.map((g) => `${g.c.machine}: ${g.text}`).join('; ');
    return { name: p.name, lastSeen: p.lastSeen, rank: worst.rank, short: worst.short, text };
  });
  return { main: mainV, source: fetched ? 'fetched now' : 'newest seen; GitHub not reachable', out, rows };
}

// `toolkit` = the reviewer's own version (a fallback for main when GitHub cannot be reached). `checkins` =
// parsed version check-in rows; `main` = { version } from the review's own fetch, or { error }.
function summarize({ now = new Date(), days = 7, access, logs, events, people = {}, toolkit = null, checkins = [], main = null, machineDays = 14, pendingDays = 3 }) {
  const from = new Date(now - days * DAY);
  const inWindow = (t) => new Date(t) >= from;
  const expected = Object.entries((access && access.people) || {})
    .filter(([, p]) => Object.values(p.envs || {}).some((l) => atLeast(l, 'write')))
    .map(([email]) => email);
  const emails = [...new Set([...expected, ...logs.map((l) => l.email), ...events.map((e) => e.email), ...checkins.map((c) => c.email)])].filter(Boolean);

  const open = foldHealth(events).map((e) => ({ ...e, plan: e.planid ? logs.find((l) => l.planid === e.planid) || null : null }));

  const ppl = emails.map((email) => {
    const mine = logs.filter((l) => l.email === email);
    const evs = events.filter((e) => e.email === email);
    const times = [...mine, ...evs, ...checkins.filter((c) => c.email === email)].map((x) => new Date(x.time));
    const lastSeen = times.length ? new Date(Math.max(...times)) : null;
    // A split entry's later rows ("log part", lib/log.js, 1.11.19) are not writes of their own.
    const applied = mine.filter((l) => inWindow(l.time) && l.outcome !== 'cancelled' && l.outcome !== 'log part');
    const health = evs.filter((e) => e.kind === 'health check').sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;
    const latestEv = evs.slice().sort((a, b) => new Date(b.time) - new Date(a.time))[0];
    const granted = (access && access.people && access.people[email]) || {};
    const ck = checkins.find((c) => c.email === email);
    const name = people[email] || (mine[0] && mine[0].name) || (evs[0] && evs[0].name) || (ck && ck.name) || granted.name || email;
    const canWrite = expected.includes(email);
    const silent = canWrite && lastSeen && now - lastSeen > SILENT_DAYS * DAY;
    return {
      email, name, lastSeen, canWrite, silent,
      grants: granted.envs || {}, merges: granted.merge || {},
      writes: applied.length,
      rows: applied.reduce((s, l) => s + (l.written || 0), 0),
      cancels: mine.filter((l) => inWindow(l.time) && l.outcome === 'cancelled').length,
      open: open.filter((e) => e.email === email).length,
      versions: latestEv ? latestEv.versions : null,
      health,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const problems = logs.filter((l) => inWindow(l.time) && l.outcome === 'applied with problems');
  const routine = {};
  const blocks = {}; // guard blocks this period, by rule (1.11.6): the headline is "Blocked [<rule>]: <tool>"
  // The next guard model's shadow (1.11.10, lib/shadow.js): disagreements, split by direction. The ones it would
  // newly stop are ALSO open items (signal), so they are counted here whatever their status.
  let shadow = null;
  for (const e of events.filter((x) => inWindow(x.time) && x.code === 'guard_shadow')) {
    shadow = shadow || { total: 0, unblocked: 0, newStops: 0 };
    shadow.total += 1;
    if (/^Shadow \[old (?:block|ask) \/ next allow\]/.test(e.headline || '')) shadow.unblocked += 1;
    else if (/^Shadow \[old allow \/ next/.test(e.headline || '')) shadow.newStops += 1;
  }
  for (const e of events.filter((x) => inWindow(x.time) && !x.signal && x.kind !== 'health check')) {
    if (e.code === 'checkin') continue; // graded in the Toolkit block, never counted
    if (e.code === 'guard_shadow') continue; // its own line
    if (e.code === 'blocked') {
      const rule = (/^Blocked \[([^\]]+)\]/.exec(e.headline || '') || [])[1] || 'unknown';
      blocks[rule] = (blocks[rule] || 0) + 1;
      continue;
    }
    routine[e.code || 'unclassified'] = (routine[e.code || 'unclassified'] || 0) + 1;
  }
  const tk = gradeToolkit({ now, people: ppl, checkins, events, toolkit, main, machineDays, pendingDays });
  return { from, to: now, days, people: ppl, open, problems, routine, blocks, shadow, toolkit: tk };
}

// Open events, oldest first, with each person's open health checks on one machine folded into ONE item:
// the newest open run, carrying the earlier open runs' numbers (`repeats`) and, when a LATER check on that
// machine did not reopen anything (it passed), when that was (`clearedAt`).
function foldHealth(events) {
  const key = (e) => `${e.env}|${e.email}|${e.machine || ''}`;
  const byTime = (a, b) => new Date(a.time) - new Date(b.time);
  const health = events.filter((e) => e.kind === 'health check').sort(byTime);
  const latest = {};
  for (const e of health) latest[key(e)] = e;
  const out = [];
  const groups = {};
  for (const e of events.filter((x) => x.status === 'open').sort(byTime)) {
    if (e.kind !== 'health check') { out.push(e); continue; }
    (groups[key(e)] = groups[key(e)] || []).push(e);
  }
  for (const [k, g] of Object.entries(groups)) {
    const head = g[g.length - 1];
    const last = latest[k];
    out.push({ ...head, repeats: g.slice(0, -1).map((e) => e.number), clearedAt: last && last !== head && last.status !== 'open' ? last.time : null });
  }
  return out.sort(byTime);
}

function versionShort(v) {
  if (!v) return '';
  const t = /toolkit ([^;]+)/.exec(v);
  const c = /Dataverse CLI ([^;]+)/.exec(v);
  if (t) return `toolkit ${t[1]}${c ? `  CLI ${c[1]}` : ''}`; // 1.11.6 on
  const m = /engine ([^;]+); Dataverse CLI ([^;]+)/.exec(v);
  return m ? `engine ${m[1]}  CLI ${m[2]}` : v.slice(0, 40);
}

function render(s, { generatedBy = null } = {}) {
  const out = [];
  out.push(`DATAVERSE TOOLKIT REVIEW   ${md(s.from)} to ${md(s.to)}   (run ${when(s.to)}${generatedBy ? ` by ${generatedBy}` : ''})`, '');
  out.push('People');
  for (const p of s.people) {
    if (!p.lastSeen) { out.push(`  ${p.name.padEnd(18)} never       not set up (nothing on record)`); continue; }
    const parts = [`${p.writes} write${p.writes === 1 ? '' : 's'} (${p.rows} rows)`];
    if (p.cancels) parts.push(`${p.cancels} cancel${p.cancels === 1 ? '' : 's'}`);
    if (p.open) parts.push(`${p.open} open`);
    out.push(`  ${p.name.padEnd(18)} seen ${md(p.lastSeen).padEnd(6)} ${parts.join(', ').padEnd(40)} ${versionShort(p.versions)}`);
  }
  // Who holds what (DESIGN.md §10a): one line per person with any grant above read, grouped by level.
  const granted = s.people.filter((p) => Object.values(p.grants || {}).some((l) => atLeast(l, 'write')));
  if (granted.length) {
    out.push('', 'Access');
    for (const p of granted) {
      const by = {};
      for (const [env, l] of Object.entries(p.grants)) {
        if (!atLeast(l, 'write')) continue;
        const lv = normalize(l);
        const tag = `${lv}${lv !== 'admin' && p.merges[env] ? ' + merge' : ''}`;
        (by[tag] = by[tag] || []).push(env);
      }
      out.push(`  ${p.name.padEnd(18)} ${Object.entries(by).map(([t, es]) => `${t}: ${es.join(', ')}`).join('; ')}`);
    }
  }
  out.push('', `Open (${s.open.length})`);
  if (!s.open.length) out.push('  nothing open');
  for (const e of s.open) {
    out.push(`  ${String(e.number || '?').padEnd(7)} ${when(e.time).padEnd(15)} ${first(e.name).padEnd(9)} ${e.kind.toUpperCase()}`);
    if (e.words) out.push(`          "${e.words}"`);
    out.push(`          ${e.headline}`);
    if (e.clearedAt) out.push(`          Cleared since: a later health check on this machine passed (${when(e.clearedAt)}).`);
    if (e.repeats && e.repeats.length) out.push(`          Same check, earlier runs still open: ${e.repeats.join(', ')} (resolving ${e.number} closes them too).`);
    if (e.plan) out.push(`          Plan ${e.plan.planid}: ${e.plan.headline}, ${e.plan.outcome}.`);
    else if (e.planid) out.push(`          Plan ${e.planid} (no Write Log row: never applied).`);
  }
  if (s.problems.length) {
    out.push('', `Writes with problems (${s.problems.length})`);
    for (const l of s.problems) out.push(`  ${md(l.time)}  ${first(l.name).padEnd(9)} ${l.headline}: ${l.written} written, ${l.notwritten} not written  (plan ${l.planid})`);
  }
  const r = Object.entries(s.routine).sort((a, b) => b[1] - a[1]);
  out.push('', r.length ? `Routine refusals: ${r.reduce((n, [, c]) => n + c, 0)}   (${r.map(([k, c]) => `${k} ${c}`).join(', ')})` : 'Routine refusals: none');
  const b = Object.entries(s.blocks || {}).sort((x, y) => y[1] - x[1]);
  out.push(b.length ? `Guard blocks: ${b.reduce((n, [, c]) => n + c, 0)}   (${b.map(([k, c]) => `${k} ${c}`).join(', ')}; any Claude judged wrong are under Open)` : 'Guard blocks: none');
  if (s.shadow) {
    const o = s.shadow;
    out.push(`Guard shadow (next model): ${o.total} disagreement${o.total === 1 ? '' : 's'} (${o.unblocked} the redesign unblocks, ${o.newStops} it would newly stop${o.newStops ? ': each is an Open item to judge' : ''}${o.total - o.unblocked - o.newStops ? `, ${o.total - o.unblocked - o.newStops} other` : ''})`);
  }
  const hc = s.people.filter((p) => p.health).map((p) => `${first(p.name)} ${md(p.health.time)} ${p.health.code === 'health_passed' ? 'pass' : p.health.code === 'drift' ? 'DRIFT' : 'FAIL'}`);
  out.push(`Health checks: ${hc.length ? hc.join(', ') : 'none on record'}`);
  if (s.toolkit) {
    const t = s.toolkit;
    out.push('', `Toolkit (main ${t.main}, ${t.source}; ${t.out ? `out since ${when(t.out)}` : 'no machine has it yet'})`);
    for (const r of t.rows) out.push(`  ${r.name.padEnd(18)} ${r.text}`);
    out.push('');
  }
  const silent = s.people.filter((p) => p.silent);
  out.push(silent.length
    ? `Silent ${SILENT_DAYS}+ days: ${silent.map((p) => `${p.name} (last seen ${md(p.lastSeen)}): ask them to run the health check`).join('; ')}`
    : `Nobody silent (${SILENT_DAYS}-day rule).`);
  return out.join('\n');
}

// The Monday /good-morning line.
function brief(s) {
  const active = s.people.filter((p) => p.lastSeen && p.lastSeen >= s.from);
  const writers = s.people.filter((p) => p.writes).sort((a, b) => b.writes - a.writes);
  const writes = writers.reduce((n, p) => n + p.writes, 0);
  const cancels = s.people.reduce((n, p) => n + p.cancels, 0);
  const parts = [`${active.length} ${active.length === 1 ? 'person' : 'people'} active`,
    `${writes} write${writes === 1 ? '' : 's'}${writers.length ? ` (${writers.map((p) => `${first(p.name)} ${p.writes}`).join(', ')})` : ''}`];
  if (cancels) parts.push(`${cancels} cancel${cancels === 1 ? '' : 's'}`);
  parts.push(s.open.length ? `${s.open.length} open (${s.open.slice(0, 3).map((e) => `${e.number}, ${first(e.name)}, ${md(e.time)}`).join('; ')}${s.open.length > 3 ? '; ...' : ''})` : 'nothing open');
  const unset = s.people.filter((p) => !p.lastSeen).map((p) => first(p.name));
  if (unset.length) parts.push(`${unset.join(', ')} not set up`);
  const silent = s.people.filter((p) => p.silent).map((p) => first(p.name));
  if (silent.length) parts.push(`${silent.join(', ')} silent ${SILENT_DAYS}+ days`);
  if (s.toolkit) {
    // People never seen are already "not set up" above; everyone else is graded.
    const graded = s.toolkit.rows.filter((r) => r.rank !== 'none' || r.lastSeen);
    if (graded.length && graded.every((r) => r.rank === 'current')) parts.push(`toolkit: everyone checked in is on ${s.toolkit.main}`);
    else if (graded.length) parts.push(`toolkit ${s.toolkit.main}: ${graded.map((r) => `${first(r.name)} ${r.short}`).join(', ')}`);
  }
  return `Dataverse toolkit, ${md(s.from)} to ${md(s.to)}: ${parts.join(', ')}. "dataverse review" for detail.`;
}

module.exports = { summarize, render, brief, foldHealth, parseCheckin, SILENT_DAYS };
