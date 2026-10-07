'use strict';
// What the person reads (DESIGN.md §5 R5, §6b.2). Rendered from the PLAN RECORD only, so
// every number is true by construction; the job's own words appear once, labelled
// "Reason given". Plain ASCII: the Windows console is cp1252 (an em dash renders as junk).

function nounCase(label) {
  // "Contacts" -> "contacts", "EBT Loads" -> "EBT loads": lowercase a word only when the
  // rest of it is already lowercase, so acronyms survive.
  return label.split(' ').map((w) => (w.length > 1 && w.slice(1) === w.slice(1).toLowerCase() ? w[0].toLowerCase() + w.slice(1) : w)).join(' ');
}

function noun(plan, n) {
  return nounCase(n === 1 ? plan.labels.singular : plan.labels.plural);
}

function isDeactivation(plan) {
  return plan.mode === 'update' && plan.rows.every((r) => {
    const keys = Object.keys(r.body);
    return r.body.statecode === 1 && keys.every((k) => k === 'statecode' || k === 'statuscode');
  });
}

function headline(plan) {
  const n = plan.rows.length;
  if (plan.mode === 'create') return `Add ${n} ${noun(plan, n)} to the ${plan.app}`;
  if (isDeactivation(plan)) return `Mark ${n} ${noun(plan, n)} inactive in the ${plan.app}`;
  return `Update ${n} ${noun(plan, n)} in the ${plan.app}`;
}

// One line per column, however many rows: "City: 2 contacts" or, when every row gets the
// same new value, "Status: set to Inactive on 4 contacts".
function summaryLines(plan) {
  const byCol = new Map();
  for (const r of plan.rows) {
    for (const c of r.changes) {
      if (!byCol.has(c.column)) byCol.set(c.column, { label: c.label, n: 0, values: new Set(), first: c });
      const e = byCol.get(c.column);
      e.n += 1;
      e.values.add(c.new_text);
    }
  }
  const lines = [];
  for (const e of byCol.values()) {
    const who = `${e.n} ${noun(plan, e.n)}`;
    if (e.n === 1) {
      // One row: show the change itself, as the detail view does.
      lines.push(plan.mode === 'update' ? `${e.label}: ${e.first.old_text} -> ${e.first.new_text}` : `${e.label}: ${e.first.new_text}`);
    } else if (e.values.size === 1) lines.push(`${e.label}: set to "${[...e.values][0]}" on ${who}`);
    else lines.push(`${e.label}: ${who}`);
  }
  return lines;
}

function money(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// The dialog body (short). Warnings and refusals are always shown, never only in detail.
function summary(plan) {
  const out = [headline(plan), ''];
  for (const l of summaryLines(plan)) out.push(`  ${l}`);
  if (plan.amount_total !== null && plan.amount_total !== undefined) out.push('', `Total amount: ${money(plan.amount_total)}`);
  const warns = plan.rows.flatMap((r) => r.warnings.map((w) => `${r.name}: ${w}`));
  if (warns.length) {
    out.push('', `Needs a look (${warns.length}):`);
    for (const w of warns.slice(0, 5)) out.push(`  ${w}`);
    if (warns.length > 5) out.push(`  ...and ${warns.length - 5} more (Show every change)`);
  }
  if (plan.refused.length) {
    out.push('', `Left out, will NOT be written (${plan.refused.length}):`);
    for (const x of plan.refused.slice(0, 5)) out.push(`  ${x.name}: ${x.why}`);
    if (plan.refused.length > 5) out.push(`  ...and ${plan.refused.length - 5} more (Show every change)`);
  }
  out.push('', `Reason given: ${plan.reason}`);
  return out.join('\n');
}

// Everything, row by row: what "Show every change" opens.
function detail(plan, { id } = {}) {
  const out = [headline(plan), ''];
  out.push(`Requested by: ${plan.identity.fullname} (${plan.identity.email})`);
  out.push(`Reason given: ${plan.reason}`);
  out.push(`Made by: ${plan.source}`);
  if (plan.reverts_plan_id) out.push(`Undoes plan: ${plan.reverts_plan_id}`);
  if (id) out.push(`Plan: ${id}`);
  out.push('');
  plan.rows.forEach((r, i) => {
    const shown = r.record_name && r.record_name !== r.name ? `${r.name}  [record: ${r.record_name}]` : r.name;
    out.push(`${i + 1}. ${shown}`);
    for (const c of r.changes) {
      out.push(plan.mode === 'update' ? `     ${c.label}: ${c.old_text} -> ${c.new_text}` : `     ${c.label}: ${c.new_text}`);
    }
    for (const w of r.warnings) out.push(`     ! ${w}`);
  });
  if (plan.amount_total !== null && plan.amount_total !== undefined) out.push('', `Total amount: ${money(plan.amount_total)}`);
  if (plan.refused.length) {
    out.push('', 'Left out, will NOT be written:');
    for (const x of plan.refused) out.push(`  - ${x.name}: ${x.why}`);
  }
  return out.join('\n');
}

module.exports = { headline, summary, summaryLines, detail, nounCase, isDeactivation };
