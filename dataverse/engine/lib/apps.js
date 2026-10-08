'use strict';
// Which apps this machine opens a read connection to (1.11.1, 10/8). The plugin declares all five
// connections; each one that starts runs the Dataverse CLI's own server, which signs in to its app. On the
// first staff Mac that was four sign-in pop-ups at every start, for apps the person does not work in.
//
//   ~/.sbrm-dataverse/config/apps.json   { "apps": ["donorapp", "fedev"], "set": "<when>" }
//
// No file = every app (how Dylan's machine has always run). Set by `dataverse-write.js apps <a,b>` during
// /dataverse-setup. It only narrows READ connections: it grants nothing, and the write path still checks
// each app's Write Access list. The guard keeps the config folder out of a session's direct reach.

const fs = require('fs');
const path = require('path');
const store = require('./store');

function file(env) {
  return path.join(store.dir('config', env), 'apps.json');
}

// The chosen list, or null for "every app".
function read(env) {
  try {
    const j = JSON.parse(fs.readFileSync(file(env), 'utf8'));
    return Array.isArray(j.apps) && j.apps.every((a) => typeof a === 'string') ? j.apps : null;
  } catch {
    return null;
  }
}

function write(apps, env) {
  const f = file(env);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ apps, set: new Date().toISOString() }, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

function clear(env) {
  fs.rmSync(file(env), { force: true });
}

function opens(key, env) {
  const a = read(env);
  return !a || a.includes(key);
}

module.exports = { read, write, clear, opens, file };
