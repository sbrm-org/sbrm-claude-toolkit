'use strict';
// How serious a change is (DESIGN.md §10j, ruled 10/7/26). There are NO caps on how much one approval
// may change (Dylan: "I honestly dont see the point of per approval limits"); instead the engine works out
// the change's severity at PLAN, from the plan itself (never from Claude's description), prints it first,
// and the pop-up shows the same lines above everything else. Claude reads every line to the person
// before asking for the yes, and never softens or skips one.
//
//   Large                 more than `warn_rows` (toolkit.json, 50) rows, pairs or objects
//   Lasting               creates something that stays until someone deletes it (a table, column, view,
//                         form, flow...): only an admin can delete, so undo cannot take it back
//   Can't be fully undone merges, deletes, and changes that alter existing data or live behaviour
//   Not tried in Dev      a change to something live in an app that has a dev copy, not proven there first
//
// A plan with no warnings is routine: it can be reverted and touches `warn_rows` or fewer.

const DEFAULT_WARN_ROWS = 50;

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
}

// count: rows / pairs / objects the plan changes. noun: what they are, plural form ("contacts").
// lasting / irreversible: one plain phrase per item, no trailing period. unproven: a phrase or null.
function assess({ count = 0, noun = 'records', lasting = [], irreversible = [], unproven = null } = {}, { warnRows = DEFAULT_WARN_ROWS } = {}) {
  const large = count > warnRows;
  const lines = [];
  if (large) lines.push(`Large change: ${count} ${noun}.`);
  for (const x of irreversible) lines.push(`Can't be fully undone: ${x}.`);
  for (const x of lasting) lines.push(`Lasting: ${x}. Undo cannot remove it; only an admin delete can.`);
  if (unproven) lines.push(`${unproven}.`);
  return { count, noun, large, warn_rows: warnRows, lasting: [...lasting], irreversible: [...irreversible], unproven: unproven || null, lines };
}

// The plain-words block that heads the plan output and the pop-up. Empty for a routine change.
function block(sev) {
  if (!sev || !sev.lines || !sev.lines.length) return [];
  return ['Before you approve:', ...sev.lines.map((l) => `  ! ${l}`), ''];
}

// true when `now` is more serious than what was approved at plan: more items, or a warning kind the plan
// did not carry. Apply refuses then, so nobody approves a smaller change than the one written.
function grew(planned, now) {
  if (!planned || !now) return false;
  if (now.count > planned.count) return true;
  if (now.large && !planned.large) return true;
  if (now.lasting.length > planned.lasting.length) return true;
  if (now.irreversible.length > planned.irreversible.length) return true;
  if (now.unproven && !planned.unproven) return true;
  return false;
}

// What the person types into the pop-up to approve a DELETE (ruled 10/7: admin may delete, with the
// object's name typed). One thing: its name, exactly as shown. Several: "delete N".
function typedPhrase(names) {
  const list = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!list.length) return null;
  return list.length === 1 ? list[0] : `delete ${list.length}`;
}

module.exports = { assess, block, grew, plural, typedPhrase, DEFAULT_WARN_ROWS };
