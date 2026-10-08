'use strict';
// The access ladder (DESIGN.md §10a, ruled 10/7/26): read < write < develop < admin.
//
//   read     can look (the default for anyone without a row)
//   write    can change records (rows jobs; merges only with the separate May Merge flag)
//   develop  can change the app: tables, columns, relationships, choices, views, forms, sitemaps, flows
//   admin    runs the toolkit: its own tables (who may write, the Write Log, the events), `resolve`,
//            merges everywhere, roles, and DELETES of every kind (ruled 10/7: "let admin do deletes of all")
//
// `schema` was the old name for admin (10/7 morning to evening). It is read as admin for one release so
// no row reads as less than it did while the rows are renamed; then the alias goes.

const RANK = { read: 0, write: 1, develop: 2, admin: 3 };
const ALIASES = { schema: 'admin' };

// The level a Write Access row's text names, or 'read' for anything unknown (never more than it says).
function normalize(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const name = ALIASES[s] || s;
  return Object.prototype.hasOwnProperty.call(RANK, name) ? name : 'read';
}

function rank(level) {
  return RANK[normalize(level)];
}

function atLeast(level, need) {
  return rank(level) >= RANK[need];
}

// How each level reads to staff (pop-ups, whoami, doctor, review).
const PLAIN = {
  read: 'can look',
  write: 'can change records',
  develop: 'can change records and the app',
  admin: 'can change records and the app, and runs the toolkit',
};

module.exports = { RANK, ALIASES, normalize, rank, atLeast, PLAIN };
