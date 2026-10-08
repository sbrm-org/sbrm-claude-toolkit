'use strict';
// Client information stays inside the Microsoft tenant (RULED 10/6/26, Dylan; DESIGN.md §5).
// Anything git tracks can end up in GitHub or another non-Microsoft repository, so the engine
// refuses to put client records where git would pick them up:
//   - a job file for a HIPAA environment (envs.json `hipaa: true`; Recovery only) must not sit in a
//     git-tracked folder (it carries names and record values);
//   - the engine's own store (plans, logs, temp files) must not sit in one, for any environment.
// "Tracked" = inside a git working tree and NOT ignored. When git cannot answer, assume tracked:
// the safe direction.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function gitRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// { exposed: bool, repo: path|null }
function gitExposure(target) {
  const abs = path.resolve(target);
  const start = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const repo = gitRoot(start);
  if (!repo) return { exposed: false, repo: null };
  // No --no-index: a file ALREADY committed reports "not ignored" even if a pattern now matches it,
  // which is right, because git keeps tracking it.
  const r = spawnSync('git', ['-C', repo, 'check-ignore', '-q', abs], { encoding: 'utf8', windowsHide: true });
  // exit 0 = ignored (safe); 1 = not ignored; anything else (git missing, error) = assume exposed
  return { exposed: r.status !== 0, repo };
}

module.exports = { gitExposure, gitRoot };
