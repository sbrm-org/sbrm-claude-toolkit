'use strict';
// SBRM toolkit: the Dataverse guard's NEXT decision model (1.11.10 runs it in SHADOW; guard_review/DESIGN.md v2 and
// GATE_2.md, ruled 10/13: "two releases": 1.11.10 shadow, 1.11.11 cut-over after a clean shadow week).
//
// Why: in the week to 10/13, 9 of 13 guard blocks were wrong, across five rules, after per-rule fixes in 1.11.3 and
// 1.11.5. Every false positive on record came from rules that judge a line by which STRINGS it holds; the layers that
// judge structure (the MCP tool name, a resolved file path, the approval line's exact form + realpath + ticket, a
// parsed settings diff) never had one. So this keeps those layers exactly as guard.js has them and replaces the
// text rules on shell lines with a parse (shellparse.js): each simple command is judged by its command word, its
// arguments resolved as paths, its redirects and what it feeds through a pipe. A name that appears only as data (a
// grep pattern, an echo, a commit message, a heredoc bound for a document) is never a hit.
//
// The gate's binding corrections are built in: C2 an unknown variable as a write target on a line that names the
// store or the plugin stays blocked; C3 shell start-up files are files that RUN; C-v2b the folder Claude Code was
// started in is in the loading set. Rulings: fork 3 (an extension-filtered listing of home passes), fork 5 (plugin
// install / marketplace add from a session ASK), fork 6 (all six store folders protected by resolved target).
//
// Returns: null (allow), a string (block, the reason), or { ask: reason } (Claude Code asks the person).
// In 1.11.10 nothing here has authority: guard.js decides and calls shadow() so disagreements are recorded.
// Trigger strings are spelled with character classes so this file does not trip other guards.

const os = require('os');
const path = require('path');
const fs = require('fs');
const G = require('./guard');
const SP = require('./shellparse');

const I = G._internals;
const { literal, text, isGlob, baseName } = SP;
const HOME_F = I.HOME.replace(/\\/g, '/');
const HOME_N = I.HOME_N;
const STORE = I.STORE;
const TMP_F = os.tmpdir().replace(/\\/g, '/');

// ---------- messages (the old wording, so a person and the tests read the same reasons) ----------

const MSG = {
  store: "changing the engine's own store (plans, log, events)",
  plugin: "changing the toolkit plugin's files",
  move: "moving the engine's store or settings for a run (plans must stay where the guard protects them)",
  key: "reaching into the store's root or settings folder (it holds the plan signing key)",
  keyRead: 'reading the plan signing key',
  feed: "feeding the store's root or settings folder into another command (it holds the plan signing key)",
  hooksOff: 'switching hooks off',
  pluginOff: 'switching the toolkit plugin (and its guard) off',
  answerer: 'adding a hook that answers approval prompts (only the person may add one) [rule: prompt-answerer; matched: a new or changed PermissionRequest hook]',
  internals: "code that reaches the engine's write side directly (it would skip the approval)",
  list: "the Dataverse CLI's write side, called with a list of arguments",
  other: 'another tool that writes to Dataverse (the Xrm PowerShell cmdlets or the Power Platform CLI)',
  hidden: 'code that runs out of sight (decoded at run time, or preloaded into node)',
  http: 'a raw writing HTTP call at Dataverse',
  loading: 'changing a file Claude Code loads hooks or settings from, by a shell command (the shell cannot be checked before it runs; use the Write or Edit tool, which checks the change) [rule: loading-settings]',
  profile: 'changing a shell start-up file so every later command runs with a changed PATH, home folder, node options or engine settings [rule: profile]',
  apply: 'an apply or resolve that is not exactly the approval form, so Claude Code cannot ask the person about it. The form: its own command, nothing before or after it, `node "<this plugin>/dataverse/engine/dataverse-write.js" apply <plan-id> [<plan-id> ...]` (at most 20 plans, none twice) or `... resolve <number> [<number> ...] <resolution> "<note>"` (at most 20 numbers, none twice, all from one app), with no $ ` * ? [ ] { } ! % ^ ; & | < > characters anywhere (reword a note that has them)',
};
const tag = (msg, rule, matched) => (matched ? `${msg} [rule: ${rule}; matched: "${String(matched).replace(/"/g, "'").slice(0, 80)}"]` : msg);

// ---------- paths ----------

const under = (p, root) => !!p && !!root && (p === root || p.startsWith(`${root.replace(/\/+$/, '')}/`));
// p is a folder strictly above x
const above = (p, x) => !!p && !!x && p !== x && (p === '/' || x.startsWith(`${p.replace(/\/+$/, '')}/`));
const isRoot = (p) => p === '/' || /^[a-z]:\/?$/i.test(p);

const STORES = [...new Set([STORE, I.real(STORE)])];
const protectedStore = (p) => STORES.some((s) => I.PROTECTED_STORE.some((d) => under(p, `${s}/${d}`)));
const inConfig = (p) => STORES.some((s) => under(p, `${s}/config`));
const isStoreRoot = (p) => STORES.includes(p);
function pluginRoots() {
  const out = [I.norm(path.join(I.HOME, '.claude', 'plugins', 'cache', 'sbrm-claude-toolkit')), I.norm(path.join(I.HOME, '.claude', 'plugins', 'marketplaces', 'sbrm-claude-toolkit'))];
  const r = I.pluginRoot();
  if (r) out.push(r.replace(/\/+$/, ''));
  return out;
}
const inPluginP = (p) => !!p && (I.inPlugin(p) || pluginRoots().some((r) => under(p, r)));
const pluginAncestor = (p) => pluginRoots().some((r) => above(p, r));
const storeAncestor = (p) => STORES.some((s) => above(p, s) || p === s);
const sweepsHome = (p) => p !== null && (p === '/' || isRoot(p) || p === HOME_N || above(p, HOME_N));

// A word's text with its variables filled in, or null when any part cannot be known.
function wordValue(w, ctx) {
  if (!w || !w.parts) return null;
  let s = '';
  for (const p of w.parts) {
    if (p.t === 'lit') s += p.v;
    else if (p.t === 'tilde') s += HOME_F;
    else if (p.t === 'var') {
      if (p.op) return null;
      const v = varValue(p.name, ctx);
      if (v === null) return null;
      s += v;
    } else return null;
  }
  return s;
}
function varValue(name, ctx) {
  const n = String(name).toLowerCase();
  if (['home', 'userprofile', 'env:userprofile', 'env:home'].includes(n)) return HOME_F;
  if (n === 'env:homedrive' || n === 'homedrive') return HOME_F.slice(0, 2);
  if (n === 'env:homepath' || n === 'homepath') return HOME_F.slice(2);
  if (['tmp', 'temp', 'tmpdir', 'env:tmp', 'env:temp'].includes(n)) return TMP_F;
  if (n === 'pwd' && ctx.here) return ctx.here;
  if (ctx.vars.has(n)) return ctx.vars.get(n);
  return null;
}

// The folder a path text names, as the file system will resolve it (".." folded, 8.3 and links expanded), or
// null when it cannot be known.
function resolveText(s, ctx) {
  let t = String(s).replace(/\\/g, '/');
  t = t.replace(/%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%/gi, HOME_F).replace(/%SystemDrive%/gi, 'c:').replace(/%TEMP%|%TMP%/gi, TMP_F)
    .replace(/\$env:(?:USERPROFILE|HOME)|\$\{?HOME\}?|\$env:HOMEDRIVE\$env:HOMEPATH/gi, HOME_F);
  if (/%[A-Za-z_]\w*%/.test(t) || /\$[\w{(]/.test(t)) return null;
  if (t === '~' || t.startsWith('~/')) t = HOME_F + t.slice(1);
  t = t.replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  let abs;
  if (/^[a-z]:(?:\/|$)/i.test(t) || t.startsWith('/')) abs = t;
  else if (/^[a-z]:/i.test(t)) abs = `${t.slice(0, 2)}/${t.slice(2)}`;
  else if (ctx.here) abs = `${ctx.here}/${t}`;
  else return null;
  const drive = (abs.match(/^[a-z]:/i) || [''])[0];
  abs = drive + path.posix.normalize(`/${abs.slice(drive.length)}`);
  if (abs === '/' || abs === '//') return '/';
  // Only a path on the home folder's own drive can reach the store or the plugin. A network share or another drive
  // is not looked up on disk (a disconnected share can stall the call, and every tool call waits on this hook).
  const lower = abs.toLowerCase();
  if (lower.startsWith('//') || /^\/(?:volumes|net|mnt)\//.test(lower) || (drive && drive.toLowerCase() !== HOME_N.slice(0, 2).toLowerCase() && /^[a-z]:/.test(HOME_N))) {
    return I.norm(abs).replace(/\/+$/, '') || '/';
  }
  return I.real(abs).replace(/\/+$/, '') || '/';
}

function expandBraces(s) {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(s);
  if (!m) return [s];
  return m[2].split(',').flatMap((alt) => expandBraces(m[1] + alt + m[3])).slice(0, 64);
}
function globRe(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const e = seg.indexOf(']', i + 1);
      if (e < 0) { re += '\\['; continue; }
      re += `[${seg.slice(i + 1, e).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = e;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

// Every place a word can name, as { path, glob }; { unknown: true } when it cannot be read. A pattern word is
// judged by the folder before its first wildcard plus which protected folders its next segment could match.
function places(w, ctx, shell) {
  const v = wordValue(w, ctx);
  if (v === null) return { unknown: true, list: [] };
  let texts = [v];
  if (w.parts.some((p) => p.t === 'lit' && !p.q && p.v.includes('{'))) texts = expandBraces(v);
  // Git Bash drops an unquoted backslash; Windows programs given the raw word would not. Both are judged.
  if (shell === 'posix' && /\\/.test(w.raw) && !/["'$`]/.test(w.raw)) texts.push(w.raw);
  const glob = isGlob(w);
  const list = [];
  for (const t of texts) {
    if (glob && /[*?[]/.test(t)) {
      const f = t.replace(/\\/g, '/');
      const k = f.search(/[*?[]/);
      const slash = f.lastIndexOf('/', k);
      const dirText = slash < 0 ? '.' : f.slice(0, slash) || '/';
      const pattern = slash < 0 ? f : f.slice(slash + 1);
      const dir = resolveText(dirText, ctx);
      if (dir === null) return { unknown: true, list: [] };
      list.push({ path: dir, glob: pattern.split('/')[0], rest: pattern });
    } else {
      const p = resolveText(t, ctx);
      if (p === null) return { unknown: true, list: [] };
      list.push({ path: p });
    }
  }
  return { unknown: false, list };
}

// What a place reaches: store (a protected folder), config, root (the store root), plugin; storeUp / pluginUp
// (a folder above one, which a removal would take with it). A pattern counts as every folder it could match.
function reach(pl) {
  const out = new Set();
  const add = (p) => {
    if (protectedStore(p)) out.add('store');
    if (inConfig(p)) out.add('config');
    if (isStoreRoot(p)) out.add('root');
    if (inPluginP(p)) out.add('plugin');
    if (storeAncestor(p)) out.add('storeUp');
    if (pluginAncestor(p)) out.add('pluginUp');
  };
  add(pl.path);
  if (pl.glob !== undefined) {
    const re = globRe(pl.glob);
    const targets = [...STORES.flatMap((s) => [s, ...I.PROTECTED_STORE.map((d) => `${s}/${d}`)]), ...pluginRoots()];
    for (const t of targets) {
      if (above(pl.path, t)) {
        const next = t.slice(pl.path.replace(/\/+$/, '').length + 1).split('/')[0];
        if (re.test(next)) add(`${pl.path.replace(/\/+$/, '')}/${next}`);
      }
    }
    if (under(pl.path, STORE) || STORES.some((s) => under(pl.path, s))) {
      // inside the store root: a wildcard there could match config
      if (STORES.some((s) => pl.path === s) && re.test('config')) { out.add('config'); out.add('store'); }
    }
  }
  return out;
}

// ---------- the loading set (F13 + C-v2b) and shell start-up files (C3) ----------

function projectDirs(cwd) {
  const out = [];
  const add = (d) => {
    if (!d) return;
    let cur = I.norm(d).replace(/\/+$/, '');
    for (let i = 0; i < 40 && cur; i += 1) {
      out.push(cur);
      const up = cur.replace(/\/[^/]*$/, '');
      if (up === cur || !up) break;
      cur = up;
    }
  };
  add(cwd);
  add(process.env.CLAUDE_PROJECT_DIR);
  return [...new Set(out)];
}
const USER_CLAUDE = I.norm(path.join(I.HOME, '.claude'));
// 'settings' (JSON settings), 'hooksjson' (a plugin's hooks), 'skillmd' (a skill or agent file whose
// frontmatter can carry hooks), or null.
function loadingKind(p, cwd) {
  if (!p) return null;
  const n = p.replace(/\/+$/, '');
  if (n === `${USER_CLAUDE}/settings.json` || n === `${USER_CLAUDE}/settings.local.json` || /\/managed-settings\.json$/i.test(n)) return 'settings';
  const dirs = projectDirs(cwd);
  for (const d of dirs) {
    if (n === `${d}/.claude/settings.json` || n === `${d}/.claude/settings.local.json`) return 'settings';
  }
  if (under(n, `${USER_CLAUDE}/plugins`) && (/\/hooks\/hooks\.json$/i.test(n) || /\/\.claude-plugin\/plugin\.json$/i.test(n))) return 'hooksjson';
  if (/\.md$/i.test(n)) {
    if (under(n, `${USER_CLAUDE}/skills`) || under(n, `${USER_CLAUDE}/agents`)) return 'skillmd';
    if (under(n, `${USER_CLAUDE}/plugins`) && /\/(?:skills|agents)\//i.test(n)) return 'skillmd';
    for (const d of dirs) if (under(n, `${d}/.claude/skills`) || under(n, `${d}/.claude/agents`)) return 'skillmd';
  }
  return null;
}
const PROFILE_NAMES = new Set(['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.kshrc', '.mkshrc']);
function isProfile(p) {
  if (!p) return false;
  const n = p.replace(/\/+$/, '');
  const b = n.split('/').pop();
  if (PROFILE_NAMES.has(b) && n === `${HOME_N}/${b}`) return true;
  if (/\/(?:documents\/(?:windows)?powershell|\.config\/powershell)\/[^/]*profile\.ps1$/i.test(n) && under(n, HOME_N)) return true;
  if (/\/\.config\/fish\/config\.fish$/i.test(n)) return true;
  const env = process.env.CLAUDE_ENV_FILE;
  if (env && I.norm(env) === n) return true;
  return false;
}
// A variable a start-up file may not set: the deny list (home, PATH, node, the loader, Claude, the CLI) and the
// engine's own (C3, GATE_2.md).
const DENY_NAME = new RegExp(`^(?:${I.ENV_DENY}|SBRM_DV\\w*|SBRM_DATAVERSE\\w*)$`, 'i');

// ---------- what commands do ----------

const REMOVE = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri', 'unlink', 'shred', 'srm', 'trash', 'clear-content', 'clc', 'clear-item']);
const MOVE = new Set(['mv', 'move', 'move-item', 'mi', 'rename-item', 'rni', 'ren', 'rename']);
const COPY = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'rsync', 'scp', 'install', 'ditto', 'cpio']);
const WRITE_ARGS = new Set(['tee', 'touch', 'truncate', 'mkdir', 'md', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'out-file',
  'export-csv', 'export-clixml', 'chmod', 'chown', 'chgrp', 'attrib', 'icacls', 'takeown', 'set-acl', 'ln', 'mklink', 'set-itemproperty', 'sp',
  'new-itemproperty', 'setfacl', 'chflags', 'xattr', 'tee-object']);
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
// Commands that only print, search or read their arguments: an apply phrase in them is data, not a run.
const DATA_CMDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'cat', 'type', 'head', 'tail',
  'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'tr', 'column', 'jq', 'diff', 'cmp', 'git', 'gh', 'write-output', 'write-host', 'get-content', 'gc', 'out-host',
  'format-table', 'format-list', 'ft', 'fl', 'select-object', 'where-object', 'measure-object', 'sed', 'awk', 'nl', 'fold', 'fmt', 'rev', 'tac', 'od', 'xxd',
  'hexdump', 'strings', 'file', 'stat', 'ls', 'dir', 'gci', 'get-childitem', 'test-path', 'resolve-path', 'get-item', 'gi', 'basename', 'dirname',
  'realpath', 'readlink', 'which', 'where', 'get-command', 'gcm', 'out-string', 'set-clipboard', 'clip', 'pbcopy', 'printenv', 'true', 'false', ':', 'test', '[']);
const LISTERS = new Set(['ls', 'dir', 'find', 'gci', 'get-childitem', 'tree', 'fd', 'fdfind']);
const CONTENT_SWEEP = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'findstr', 'cp', 'copy-item', 'cpi', 'copy', 'tar', 'bsdtar', 'zip', '7z', '7za',
  'rsync', 'robocopy', 'xcopy', 'compress-archive', 'rclone', 'scp']);
const PIPE_READERS = new Set(['get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'remove-item', 'ri',
  'del', 'erase', 'rd', 'rmdir', 'rm', 'foreach-object', '%', 'foreach', 'set-content', 'add-content', 'compress-archive', 'read', 'parallel', 'invoke-item', 'ii']);
const INTERP = { node: 'js', nodejs: 'js', bun: 'js', deno: 'js', python: 'py', python3: 'py', python2: 'py', py: 'py', pythonw: 'py', perl: 'pl', ruby: 'rb', php: 'php' };
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'ls-remote', 'rev-parse', 'rev-list', 'describe', 'blame', 'grep', 'shortlog',
  'cat-file', 'reflog', 'help', 'version', '--version', 'whatchanged', 'name-rev', 'merge-base', 'for-each-ref', 'count-objects', 'fsck', 'check-ignore', 'check-attr',
  'var', 'diff-tree', 'diff-files', 'diff-index', 'show-ref', 'verify-commit', 'verify-tag', 'show-branch', 'cherry', 'range-diff', 'annotate', 'fetch']);

// PowerShell parameters that take no value.
const PS_SWITCHES = new Set(['recurse', 'force', 'file', 'directory', 'hidden', 'readonly', 'system', 'name', 'whatif', 'confirm', 'passthru', 'raw', 'append',
  'noclobber', 'nonewline', 'followsymlink', 'all', 'unique', 'descending', 'wait', 'nonewwindow', 'noprofile', 'noninteractive', 'asjob', 'asplaintext',
  'usebasicparsing', 'simplematch', 'casesensitive', 'list', 'quiet', 'notmatch', 'allmatches', 'asstring', 'skipcertificatecheck', 'update', 'overwrite',
  'leaf', 'container', 'isvalid', 'resolve', 'relative', 'autosize', 'wrap', 'expand', 'stream', 'asbytestream', 'nonewscope', 'sta', 'mta', 'nologo']);

// Named parameters and positional words of a command (PowerShell style when the shell is PowerShell).
function argsOf(c) {
  const named = new Map();
  const pos = [];
  const flags = [];
  const a = c.args || [];
  let rest = false;
  for (let i = 0; i < a.length; i += 1) {
    const L = literal(a[i]);
    if (!rest && L === '--') { rest = true; continue; }
    if (!rest && L !== null && /^-[A-Za-z]/.test(L)) {
      flags.push(L);
      if (c.shell === 'ps') {
        const m = /^-([A-Za-z][\w-]*)(?::(.*))?$/.exec(L);
        const name = m ? m[1].toLowerCase() : L.slice(1).toLowerCase();
        if (m && m[2] !== undefined) {
          named.set(name, [...(named.get(name) || []), { type: 'word', parts: [{ t: 'lit', v: m[2], q: true }], raw: m[2] }]);
        } else if (!PS_SWITCHES.has(name) && !(name !== 'depth' && I.PS_RECURSE.test(`-${name}`)) && a[i + 1] && !/^-[A-Za-z]/.test(literal(a[i + 1]) || '')) {
          named.set(name, [...(named.get(name) || []), a[i + 1]]);
          i += 1;
        } else named.set(name, named.get(name) || []);
      } else {
        const eq = L.indexOf('=');
        if (L.startsWith('--') && eq > 0) named.set(L.slice(2, eq).toLowerCase(), [{ type: 'word', parts: [{ t: 'lit', v: L.slice(eq + 1), q: true }], raw: L.slice(eq + 1) }]);
      }
      continue;
    }
    pos.push(a[i]);
  }
  return { named, pos, flags };
}
const flagHas = (flags, re) => flags.some((f) => re.test(f));

// The words a command WRITES, as [{ w, removal }]: removal = the target goes away, so a folder above a protected
// one counts too.
function writeTargets(c) {
  const out = [];
  const name = c.name;
  const { named, pos, flags } = argsOf(c);
  const lits = (c.args || []).map(literal);
  const valueOf = (...names) => names.flatMap((n) => named.get(n) || []);
  const optValue = (re) => {
    const a = c.args || [];
    for (let i = 0; i < a.length; i += 1) {
      const L = lits[i];
      if (L === null) continue;
      const m = re.exec(L);
      if (m) {
        if (m[1]) out.push({ w: { type: 'word', parts: [{ t: 'lit', v: m[1], q: true }], raw: m[1] }, removal: false });
        else if (a[i + 1]) out.push({ w: a[i + 1], removal: false });
      }
    }
  };
  if (!name) return out;
  if (REMOVE.has(name)) {
    for (const w of [...pos, ...valueOf('path', 'literalpath')]) out.push({ w, removal: true });
  } else if (MOVE.has(name)) {
    for (const w of [...pos, ...valueOf('path', 'literalpath', 'destination', 'newname')]) out.push({ w, removal: true });
    optValue(/^(?:-t|--target-directory)(?:=(.+))?$/);
  } else if (COPY.has(name)) {
    if (name === 'robocopy') {
      const p = pos.filter((w) => !/^\//.test(literal(w) || ''));
      const moves = flagHas(lits.filter(Boolean), /^\/MOVE?$/i);
      const purge = flagHas(lits.filter(Boolean), /^\/(?:MIR|PURGE)$/i);
      if (p[1]) out.push({ w: p[1], removal: purge });
      if (p[0] && moves) out.push({ w: p[0], removal: true });
    } else if (name === 'rsync') {
      if (pos.length) out.push({ w: pos[pos.length - 1], removal: flagHas(flags, /^--del/) });
      if (flagHas(flags, /^--remove-source-files$/)) for (const w of pos.slice(0, -1)) out.push({ w, removal: true });
    } else if (c.shell === 'ps' && ['copy-item', 'cpi', 'copy'].includes(name)) {
      const d = valueOf('destination');
      if (d.length) out.push(...d.map((w) => ({ w, removal: false })));
      else if (pos[1]) out.push({ w: pos[1], removal: false });
    } else if (name === 'xcopy') {
      const p = pos.filter((w) => !/^\//.test(literal(w) || ''));
      out.push({ w: p[1] || { type: 'word', parts: [{ t: 'lit', v: '.', q: true }], raw: '.' }, removal: false });
    } else {
      optValue(/^(?:-t|--target-directory)(?:=(.+))?$/);
      if (!out.length && pos.length) out.push({ w: pos[pos.length - 1], removal: false });
    }
  } else if (WRITE_ARGS.has(name)) {
    for (const w of [...pos, ...valueOf('path', 'literalpath', 'filepath', 'target')]) out.push({ w, removal: false });
  } else if (name === 'sed' || name === 'gsed') {
    if (flagHas(flags, /^-[a-zA-Z]*i|^--in-place/)) {
      const scriptGiven = flagHas(flags, /^-[a-zA-Z]*[ef]$|^--(?:expression|file)/);
      for (const w of scriptGiven ? pos : pos.slice(1)) out.push({ w, removal: false });
    }
  } else if (name === 'perl') {
    if (flagHas(flags, /^-[a-zA-Z]*i/)) {
      const eIdx = lits.findIndex((l) => l !== null && /^-[a-zA-Z]*e$/.test(l));
      const files = eIdx >= 0 ? (c.args || []).slice(eIdx + 2).filter((w) => !/^-/.test(literal(w) || '')) : pos.slice(1);
      for (const w of files) out.push({ w, removal: false });
    }
  } else if (name === 'awk' || name === 'gawk') {
    if (/\binplace\b/.test(c.src || '')) for (const w of pos.slice(1)) out.push({ w, removal: false });
  } else if (name === 'find') {
    const roots = [];
    for (const w of c.args || []) {
      const L = literal(w);
      if (L !== null && (/^-/.test(L) || L === '(' || L === '!' || L === ')')) break;
      roots.push(w);
    }
    if (!roots.length) roots.push({ type: 'word', parts: [{ t: 'lit', v: '.', q: true }], raw: '.' });
    const del = flagHas(lits.filter(Boolean), /^-delete$/);
    const exec = flagHas(lits.filter(Boolean), /^-(?:exec|execdir|ok|okdir)$/);
    if (del || exec) for (const w of roots) out.push({ w, removal: del });
    optValue(/^-fprint[f0]?$/);
  } else if (name === 'git') {
    // the repository it acts on, when the subcommand writes
    let i = 0;
    const a = c.args || [];
    let repo = null;
    while (i < a.length) {
      const L = lits[i];
      if (L === '-C') { repo = a[i + 1]; i += 2; continue; }
      if (L === '-c') { i += 2; continue; }
      if (L !== null && /^--(?:git-dir|work-tree)=/.test(L)) { repo = { type: 'word', parts: [{ t: 'lit', v: L.split('=').slice(1).join('='), q: true }], raw: L }; i += 1; continue; }
      if (L !== null && /^-/.test(L)) { i += 1; continue; }
      break;
    }
    const sub = (lits[i] || '').toLowerCase();
    const subArgs = lits.slice(i + 1);
    let writes = sub && !GIT_READ.has(sub);
    if (sub === 'remote') writes = subArgs.some((s) => /^(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/.test(s || ''));
    if (sub === 'branch' || sub === 'tag') writes = subArgs.some((s) => s !== null && !/^-/.test(s)) && !subArgs.some((s) => /^(?:-l|--list|-a|-r|-v|-vv|--show-current|--contains|--merged|--no-merged|--points-at)$/.test(s || ''));
    if (sub === 'config') writes = !subArgs.some((s) => /^(?:--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope)$/.test(s || '')) && subArgs.filter((s) => s !== null && !/^-/.test(s)).length >= 2;
    if (sub === 'stash') writes = !['list', 'show'].includes((subArgs[0] || '').toLowerCase());
    if (sub === 'worktree') writes = !['list'].includes((subArgs[0] || '').toLowerCase());
    if (writes) {
      out.push({ w: repo || { type: 'word', parts: [{ t: 'lit', v: '.', q: true }], raw: '.' }, removal: false });
      if (sub === 'clone') {
        const p = (c.args || []).slice(i + 1).filter((w) => !/^-/.test(literal(w) || ''));
        if (p.length >= 2) out.push({ w: p[p.length - 1], removal: false });
      } else {
        for (const w of (c.args || []).slice(i + 1)) {
          const L = literal(w);
          if (L !== null && /^-/.test(L)) continue;
          out.push({ w, removal: false });
        }
      }
    }
  } else if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const sub = (literal((c.args || []).find((w) => !/^-/.test(literal(w) || '-'))) || '').toLowerCase();
    if (/^(?:install|i|add|ci|link|ln|uninstall|remove|rm|un|r|update|up|upgrade|prune|dedupe|rebuild|init|unlink)$/.test(sub) && !flagHas(flags, /^(?:-g|--global)$/)) {
      const p = valueOf('prefix', 'dir', 'cwd');
      optValue(/^(?:--prefix|-C|--dir|--cwd)(?:=(.+))?$/);
      if (!p.length && !out.length) out.push({ w: { type: 'word', parts: [{ t: 'lit', v: '.', q: true }], raw: '.' }, removal: false });
    }
  } else if (name === 'pip' || name === 'pip3') {
    optValue(/^(?:-t|--target|--prefix|--root)(?:=(.+))?$/);
  } else if (name === 'tar' || name === 'bsdtar') {
    const first = lits[0] || '';
    const extract = flagHas(lits.filter(Boolean), /^-[a-zA-Z]*x|^--extract$|^--get$/) || (/^[a-zA-Z]+$/.test(first) && first.includes('x'));
    const create = flagHas(lits.filter(Boolean), /^-[a-zA-Z]*[cru]|^--create$|^--append$/) || (/^[a-zA-Z]+$/.test(first) && /[cru]/.test(first));
    if (extract) {
      optValue(/^(?:-C|--directory)(?:=(.+))?$/);
      if (!out.length) out.push({ w: { type: 'word', parts: [{ t: 'lit', v: '.', q: true }], raw: '.' }, removal: false });
    }
    if (create) optValue(/^(?:-[a-zA-Z]*f|--file)(?:=(.+))?$/);
  } else if (name === 'unzip') {
    optValue(/^-d$/);
    if (!out.length) out.push({ w: { type: 'word', parts: [{ t: 'lit', v: '.', q: true }], raw: '.' }, removal: false });
  } else if (name === '7z' || name === '7za') {
    if (/^[xe]$/.test(lits[0] || '')) {
      const o = lits.find((l) => l && /^-o./.test(l));
      out.push({ w: { type: 'word', parts: [{ t: 'lit', v: o ? o.slice(2) : '.', q: true }], raw: o || '.' }, removal: false });
    }
  } else if (name === 'expand-archive' || name === 'compress-archive') {
    for (const w of valueOf('destinationpath')) out.push({ w, removal: false });
    if (name === 'expand-archive' && !named.has('destinationpath')) out.push({ w: pos[1] || { type: 'word', parts: [{ t: 'lit', v: '.', q: true }], raw: '.' }, removal: false });
    if (name === 'compress-archive' && !named.has('destinationpath') && pos[1]) out.push({ w: pos[1], removal: false });
  } else if (name === 'dd') {
    for (const L of lits) if (L && /^of=/.test(L)) out.push({ w: { type: 'word', parts: [{ t: 'lit', v: L.slice(3), q: true }], raw: L }, removal: false });
  } else if (name === 'curl') {
    optValue(/^(?:-o|--output|--output-dir)(?:=(.+))?$/);
  } else if (name === 'wget') {
    optValue(/^(?:-O|--output-document|-P|--directory-prefix)(?:=(.+))?$/);
  } else if (['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'wget', 'curl'].includes(name) && c.shell === 'ps') {
    for (const w of valueOf('outfile')) out.push({ w, removal: false });
  } else if (name === 'sort') {
    optValue(/^(?:-o|--output)(?:=(.+))?$/);
  }
  return out;
}

// ---------- code (node -e, python -c, a heredoc into an interpreter, a PowerShell expression) ----------

// The string literals of a piece of code: [{ value | null, start, end }]. Comments are skipped.
function codeLiterals(code, lang) {
  const out = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    if ((lang === 'py' || lang === 'ps' || lang === 'rb' || lang === 'pl' || lang === 'sh') && c === '#') {
      if (lang === 'ps' && code[i - 1] === '<') { const e = code.indexOf('#>', i); i = e < 0 ? n : e + 2; continue; }
      while (i < n && code[i] !== '\n') i += 1;
      continue;
    }
    if ((lang === 'js' || lang === 'cs' || lang === 'php') && c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i += 1; continue; }
    if ((lang === 'js' || lang === 'cs' || lang === 'php') && c === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c !== '"' && c !== "'" && c !== '`') { i += 1; continue; }
    if (c === '`' && lang !== 'js') { i += 1; continue; }
    // prefixes (python r'', b'', f''; c# @"")
    const pre = (code.slice(Math.max(0, i - 2), i).match(/[rbfuRBFU@]{1,2}$/) || [''])[0];
    const raw = /[rR@]/.test(pre);
    const fmt = /[fF]/.test(pre) || c === '`' || (lang === 'ps' && c === '"');
    const triple = lang === 'py' && code.startsWith(c.repeat(3), i);
    const q = triple ? c.repeat(3) : c;
    let j = i + q.length;
    let v = '';
    let dynamic = false;
    let closed = false;
    while (j < n) {
      if (code.startsWith(q, j)) {
        if (lang === 'ps' && code[j + 1] === c && !triple) { v += c; j += 2; continue; }
        closed = true;
        break;
      }
      const d = code[j];
      if (lang === 'ps' && d === '`' && c === '"') { v += code[j + 1] || ''; j += 2; continue; }
      if (d === '\\' && !raw && lang !== 'ps') {
        const e = code[j + 1];
        v += e === 'n' ? '\n' : e === 't' ? '\t' : (e === '\\' || e === "'" || e === '"' || e === '`') ? e : `\\${e || ''}`;
        j += 2;
        continue;
      }
      if (fmt && ((d === '$' && code[j + 1] === '{') || (lang === 'py' && d === '{' && code[j + 1] !== '{'))) dynamic = true;
      if (lang === 'ps' && c === '"' && d === '$' && /[\w({]/.test(code[j + 1] || '')) {
        const m = /^\$(?:env:(?:USERPROFILE|HOME)\b|\{?HOME\}?(?!\w))/i.exec(code.slice(j));
        if (m) { v += HOME_F; j += m[0].length; continue; }
        dynamic = true;
      }
      v += d;
      j += 1;
    }
    if (!closed) break;
    out.push({ value: dynamic ? null : v, text: v, start: i, end: j + q.length });
    i = j + q.length;
  }
  return out;
}

// The top-level arguments of a call whose "(" is at `open`: [{ text, literal: value|null|undefined }].
function callArgs(code, open, lits) {
  let depth = 0;
  let start = open + 1;
  const spans = [];
  const litAt = new Map(lits.map((l) => [l.start, l]));
  for (let i = open; i < code.length; i += 1) {
    const l = litAt.get(i);
    if (l) { i = l.end - 1; continue; }
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) { spans.push([start, i]); break; }
      continue;
    }
    if (c === ',' && depth === 1) { spans.push([start, i]); start = i + 1; }
  }
  return spans.map(([s, e]) => {
    const raw = code.slice(s, e);
    const a = s + (raw.length - raw.trimStart().length);
    const b = s + raw.trimEnd().length;
    const tx = code.slice(a, b);
    if (/^[A-Za-z_]\w*\s*=(?!=)/.test(tx)) return { text: tx, keyword: true };
    const inside = lits.filter((l) => l.start >= a && l.end <= b);
    if (inside.length === 1 && inside[0].end === b && /^[rbfuRBFU@]{0,2}$/.test(code.slice(a, inside[0].start))) return { text: tx, literal: inside[0].value };
    return { text: tx, literal: undefined };
  });
}

// File-writing calls in code: [name regex, which args are targets, removal].
const CODE_WRITES = [
  [/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|truncateSync|mkdirSync|WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|AppendAllLines|CreateText|AppendText|CreateDirectory|writeTextFile|write_file|IO\.write|Bun\.write|File\.write|chmodSync|chownSync|utimesSync|makedirs|mkdir|Create|OpenWrite)\s*\(/g, 'first', false],
  [/\b(?:unlinkSync|unlink|rmSync|rmdirSync|rmdir|remove|removedirs|rmtree|Delete|deleteFile|rm)\s*\(/g, 'first', true],
  [/\b(?:renameSync|rename|replace|move|Move|Replace|symlinkSync|symlink|linkSync|link)\s*\(/g, 'all', true],
  [/\b(?:copyFileSync|copyFile|cpSync|copy|copy2|copyfile|copytree|Copy)\s*\(/g, 'last', false],
  [/\bopen(?:Sync)?\s*\(/g, 'open', false],
];
const LAUNCH_CALL = /\b(?:execSync|exec|spawnSync|spawn|execFileSync|execFile|fork|system|popen|Popen|run|call|check_output|check_call|getoutput|getstatusoutput|shell_exec|passthru|proc_open|Start-Process|Invoke-Expression)\s*\(/;
const SHELL_CALL = /\b(?:execSync|exec|system|popen|Popen|run|call|check_output|check_call|getoutput|getstatusoutput|shell_exec|passthru|spawnSync|spawn)\s*\(/g;
const RECEIVER_WRITES = /\.(?:write_text|write_bytes|unlink|touch|rmdir|rename|replace|chmod|mkdir|symlink_to|hardlink_to)\s*\(/g;

// Does the code name the store or the plugin anywhere (for C2: a write target it cannot read)?
const namesProtected = (t) => I.STORE_IN_TEXT.test(t) || I.STORE_ANY.test(t) || I.PLUGIN_IN_TEXT.test(t);

function codeVerdict(code, lang, ctx, env, depth = 0) {
  const src = String(code || '');
  if (!src.trim()) return null;
  if (I.ENGINE_INTERNALS.test(src)) return tag(MSG.internals, 'engine-internals');
  if (I.CLI_LIST.test(src) && I.LIST_WRITE.test(src)) return MSG.list;
  if (I.STORE_MOVE.test(src)) return MSG.move;
  if (/\b(?:CrmServiceClient|ServiceClient|Microsoft\.Xrm\.Tooling)\b[\s\S]{0,400}\.(?:Create|Update|Delete|Execute|Associate|Disassociate)(?:Async)?\s*\(/.test(src)) return MSG.other;
  const lits = codeLiterals(src, lang);
  for (const l of lits) {
    if (l.value === null) continue;
    const v = G.cliVerdict(l.value);
    if (v) return tag(`${v}, which writes to Dataverse`, 'cli-literal');
    if (I.KEY_NAMED.test(l.value)) return MSG.keyRead;
    if (/[\\/]|^~/.test(l.value) && /sbrm-dataverse|\.\./i.test(l.value)) {
      const p = resolveText(l.value, ctx);
      if (p && inConfig(p) && !/\/dev_dirs\.json$/i.test(p)) return MSG.keyRead;
    }
  }
  // file writes whose target is a literal: judged by where it lands; an unreadable target on code that names the
  // store or the plugin fails closed (C2)
  const named = namesProtected(src);
  const judgeTarget = (value, removal) => {
    if (value === undefined || value === null) return named ? 'unknown' : null;
    const v = value.replace(/^\+?[<>]{1,2}\s*/, '');
    if (!/[\\/~]|^\.{1,2}$/.test(v) && !ctx.here) return null;
    const p = resolveText(v, ctx);
    if (p === null) return named ? 'unknown' : null;
    const r = reach({ path: p });
    if (r.has('store') || (removal && r.has('storeUp'))) return 'store';
    if (r.has('plugin') || (removal && r.has('pluginUp'))) return 'plugin';
    const lk = loadingKind(p, env.cwd);
    if (lk === 'settings' || lk === 'hooksjson') return 'loading';
    if (isProfile(p)) return 'profile';
    return null;
  };
  const hit = (k) => (k === 'store' || k === 'unknown' && I.STORE_IN_TEXT.test(src) ? tag(MSG.store, 'store-tamper') : k === 'plugin' || k === 'unknown' ? tag(MSG.plugin, 'plugin-tamper') : k === 'loading' ? MSG.loading : k === 'profile' ? MSG.profile : null);
  for (const [re, which, removal] of CODE_WRITES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (lits.some((l) => m.index >= l.start && m.index < l.end)) continue;
      const args = callArgs(src, m.index + m[0].length - 1, lits).filter((a) => !a.keyword);
      let targets = [];
      if (which === 'open') {
        const mode = args.slice(1).find((a) => typeof a.literal === 'string');
        const perlTarget = args.find((a) => typeof a.literal === 'string' && /^\+?[<>]/.test(a.literal));
        if (perlTarget) { if (/^\+?>|^\+</.test(perlTarget.literal)) targets = [perlTarget.literal]; }
        else if (mode && /^[rwaxbt+]*[wax+][rwaxbt+]*$/.test(mode.literal) && args[0]) targets = [args[0].literal];
        if (!targets.length && /\bmode\s*=\s*["'][rwaxbt+]*[wax+]/.test(src.slice(m.index, m.index + 300)) && args[0]) targets = [args[0].literal];
      } else if (which === 'first') targets = args[0] ? [args[0].literal] : [];
      else if (which === 'last') targets = args.length ? [args[args.length - 1].literal] : [];
      else targets = args.map((a) => a.literal);
      for (const t of targets) {
        const k = judgeTarget(t, removal);
        if (k) return hit(k);
      }
    }
  }
  RECEIVER_WRITES.lastIndex = 0;
  let rm;
  while ((rm = RECEIVER_WRITES.exec(src)) !== null) {
    if (lits.some((l) => rm.index >= l.start && rm.index < l.end)) continue;
    const before = src.slice(Math.max(0, rm.index - 300), rm.index);
    const lm = /(?:Path\s*\(\s*)?([rbRB]?(["'])((?:(?!\2).)*)\2)\s*\)?\s*$/.exec(before);
    const k = judgeTarget(lm ? lm[3] : undefined, /unlink|rmdir|rename|replace/.test(rm[0]));
    if (k) return hit(k);
  }
  // A string handed to a shell from code is a command line of its own; a list of words is one too.
  if (depth < 3) {
    SHELL_CALL.lastIndex = 0;
    let sm;
    while ((sm = SHELL_CALL.exec(src)) !== null) {
      if (lits.some((l) => sm.index >= l.start && sm.index < l.end)) continue;
      const span = callArgs(src, sm.index + sm[0].length - 1, lits);
      const lines = [];
      for (const a of span) {
        if (typeof a.literal === 'string') lines.push(a.literal);
        else if (/^\[/.test(a.text)) {
          const inner = codeLiterals(a.text, lang).map((l) => l.value);
          if (inner.length && inner.every((x) => typeof x === 'string')) lines.push(inner.map((x) => (/\s/.test(x) ? `'${x.replace(/'/g, "'\\''")}'` : x)).join(' '));
        }
      }
      for (const line of lines) {
        const v = shellVerdict(line, env.cwd, 'posix', { ctx, depth: depth + 1 });
        if (typeof v === 'string') return v;
      }
    }
  }
  return null;
}

// The code a command runs inline, if any: [{ code, lang }].
function inlineCode(c, pipeCmds) {
  const out = [];
  const name = c.name;
  const a = c.args || [];
  const lits = a.map(literal);
  const lang = INTERP[name] || (name && /^python\d/.test(name) ? 'py' : null);
  if (lang) {
    const flagRe = lang === 'js' ? /^(?:-e|--eval|-p|--print|eval)$/ : lang === 'py' ? /^-[a-zA-Z]*c$/ : lang === 'php' ? /^-r$/ : /^-[a-zA-Z]*[eE]$/;
    for (let i = 0; i < a.length; i += 1) {
      if (lits[i] !== null && flagRe.test(lits[i]) && a[i + 1]) out.push({ code: literal(a[i + 1]) ?? text(a[i + 1]), lang });
    }
    const script = a.find((w, i) => lits[i] !== null && !/^-/.test(lits[i]));
    if (c.heredoc && (!script || literal(script) === '-')) out.push({ code: c.heredoc.body, lang });
    // echo "<code>" | node
    if (!out.length && c.pos > 0 && (!script || literal(script) === '-')) {
      for (const up of pipeCmds.filter((x) => x.pos < c.pos)) {
        if (['echo', 'printf', 'write-output'].includes(up.name)) out.push({ code: (up.args || []).map((w) => literal(w) ?? text(w)).join(' '), lang });
      }
    }
  }
  if (name === 'add-type') {
    const { named } = argsOf(c);
    for (const w of [...(named.get('typedefinition') || []), ...(named.get('memberdefinition') || [])]) out.push({ code: literal(w) ?? text(w), lang: 'cs' });
  }
  if (c.herestring && lang) out.push({ code: literal(c.herestring) ?? '', lang });
  return out;
}

// ---------- one command ----------

function storeMoveAssign(a) {
  const n = String(a.name || '').replace(/^env:/i, '');
  if (/^(?:SBRM_DV_(?:HOME|CONFIG)|SBRM_DATAVERSE_CLI)$/i.test(n)) return true;
  if (new RegExp(`^${I.HOME_VARS}$`, 'i').test(n)) return true;
  return false;
}

function judgeOne(c, ctx, env, pipe) {
  // assignments: the engine's store or the home folder moved for a run, or for the rest of the line
  for (const a of c.assigns) {
    if ((a.ps && !a.env) || a.shellVar === true && a.dynamic && !a.value) continue;
    if (storeMoveAssign(a)) return tag(MSG.move, 'store-move', `${a.name}=`);
  }
  if (c.kind === 'expr') {
    for (const t of redirectTargets(c)) {
      const v = targetVerdict(t, c, ctx, env);
      if (v) return v;
    }
    return codeVerdict(c.code, 'ps', ctx, env);
  }
  if (c.kind !== 'cmd' || !c.word) {
    for (const t of redirectTargets(c)) {
      const v = targetVerdict(t, c, ctx, env);
      if (v) return v;
    }
    return null;
  }
  const name = c.name;
  const lits = (c.args || []).map(literal);

  // export / declare: assignments too
  if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(name) || (c.shell === 'cmd' && name === 'set')) {
    for (const w of c.args) {
      const a = SP.splitAssign(w);
      if (a && storeMoveAssign(a)) return tag(MSG.move, 'store-move', `${a.name}=`);
    }
  }
  if (name === 'setx' || ['set-item', 'si', 'new-item', 'ni'].includes(name)) {
    if (I.STORE_MOVE.test(c.src || '')) return tag(MSG.move, 'store-move', name);
  }
  // other Dataverse writers, as the COMMAND
  if (/^(?:set|new|remove|update|add|import|publish|merge|invoke|approve|grant|revoke)-crm\w*$/i.test(name)) return MSG.other;
  if (name === 'pac' && I.OTHER_DV_WRITERS.test(c.src || '')) return MSG.other;

  // Claude Code itself
  if (name === 'claude' || name === 'claude-code' || name === '@anthropic-ai/claude-code') {
    const r = claudeVerdict(c, ctx, lits);
    if (r) return r;
  }

  // the plan signing key: any argument or redirect that resolves into the store's settings folder
  const k = keyVerdict(c, ctx);
  if (k) return k;

  // recursive reads of the home folder (or above it), or of the store's root
  const s = sweepVerdict(c, ctx, pipe);
  if (s) return s;

  // writes: the command's own targets, then its redirects
  const targets = [...writeTargets(c), ...redirectTargets(c)];
  for (const t of targets) {
    const v = targetVerdict(t, c, ctx, env);
    if (v) return v;
  }

  // a listing of protected files, or engine output, fed into a command that acts on each line
  const f = feedVerdict(c, ctx, pipe);
  if (f) return f;

  // code the command runs inline
  for (const { code, lang } of inlineCode(c, pipe)) {
    const v = codeVerdict(code, lang, ctx, env);
    if (v) return v;
  }
  return null;
}

// Where a command's output redirects write (fd duplicates and null sinks write nothing).
function redirectTargets(c) {
  const out = [];
  for (const r of c.redirects) {
    if (!/>/.test(r.op) || r.dup || (r.op === '>&' && (!r.target || /^(?:\d+|-)$/.test(literal(r.target) || '')))) continue;
    const L = r.target ? literal(r.target) : '';
    if (r.target && /^(?:\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)|nul|NUL|\$null)$/i.test(L || '')) continue;
    if (r.target && r.target.parts.length === 1 && r.target.parts[0].t === 'var' && /^null$/i.test(r.target.parts[0].name)) continue;
    out.push({ w: r.target, removal: false, redirect: true });
  }
  return out;
}

function targetVerdict(t, c, ctx, env) {
  if (!t.w) return env.protectedNamed ? tag(env.namesPlugin ? MSG.plugin : MSG.store, 'unknown-target', 'a redirect with no target') : null;
  const pl = places(t.w, ctx, c.shell);
  if (pl.unknown) {
    // C2: a target the guard cannot read, on a line that names the store or the plugin
    if (env.protectedNamed) return tag(env.namesStore ? MSG.store : MSG.plugin, 'unknown-target', text(t.w));
    return null;
  }
  for (const p of pl.list) {
    const r = reach(p);
    if (r.has('store') || (t.removal && r.has('storeUp'))) return tag(MSG.store, 'store-tamper', text(t.w));
    if (r.has('plugin') || (t.removal && r.has('pluginUp'))) return tag(MSG.plugin, 'plugin-tamper', text(t.w));
    const lk = loadingKind(p.path, env.cwd);
    if (lk === 'settings' || lk === 'hooksjson') return MSG.loading;
    if (lk === 'skillmd') {
      const content = writtenContent(c, t);
      if (content === null || /Permission[R]equest|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i.test(content)) return MSG.answerer;
    }
    if (isProfile(p.path)) {
      const content = writtenContent(c, t);
      if (content === null) return MSG.profile;
      const v = profileVerdict(p.path, content, env);
      if (v) return v;
    }
    // a file written by the shell is judged like a Write of the same text (outside dev folders)
    if (t.redirect || c.name === 'tee' || c.name === 'tee-object') {
      const content = writtenContent(c, t);
      if (content !== null && !I.inDevDir(p.path, env.dirs)) {
        const v = contentVerdict(p.path, content);
        if (v) return v;
      }
    }
  }
  return null;
}

// The text a command writes into a file, when the guard can see it (a heredoc, an echo, a printf); else null.
function writtenContent(c, t) {
  if (c.heredoc) return c.heredoc.body;
  if (c.herestring) return literal(c.herestring);
  if (['echo', 'printf', 'write-output'].includes(c.name) && t.redirect) {
    const ws = (c.args || []).filter((w) => !/^-[neE]+$/.test(literal(w) || ''));
    const vals = ws.map(literal);
    return vals.every((v) => v !== null) ? vals.join(' ') : null;
  }
  if (c.shell === 'ps' && ['set-content', 'sc', 'add-content', 'ac', 'out-file'].includes(c.name)) {
    const { named, pos } = argsOf(c);
    const v = named.get('value') || pos.slice(1);
    const vals = v.map(literal);
    return vals.length && vals.every((x) => x !== null) ? vals.join('\n') : null;
  }
  return null;
}

function keyVerdict(c, ctx) {
  const words = [...(c.args || [])];
  for (const r of c.redirects) if (r.target) words.push(r.target);
  const listing = ['ls', 'dir', 'gci', 'get-childitem'].includes(c.name) && !flagHas((c.args || []).map(literal).filter(Boolean), /^-[a-zA-Z]*R[a-zA-Z]*$|^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$|^-depth$|^\/s$/i);
  for (const w of words) {
    const tx = text(w);
    const v = wordValue(w, ctx);
    const relHere = ctx.here && (inConfig(ctx.here) || isStoreRoot(ctx.here) || protectedStore(ctx.here));
    if (I.KEY_NAMED.test(tx) && (v === null || /sbrm-dataverse|config|^\.\.|\/\.\./i.test(v) || relHere)) {
      const pl = v === null ? null : places(w, ctx, c.shell);
      if (!pl || pl.unknown || pl.list.some((p) => reach(p).has('config'))) return tag(MSG.keyRead, 'key', tx);
    }
    if (v === null) continue;
    if (!(/sbrm-dataverse|\.\.|~\d|[*?[]/i.test(v) || (relHere && !/^[\\/~]|^[a-z]:/i.test(v)))) continue;
    const pl = places(w, ctx, c.shell);
    if (pl.unknown) continue;
    for (const p of pl.list) {
      const r = reach(p);
      if (!r.has('config')) continue;
      const exact = p.glob === undefined ? p.path : null;
      if (exact && listing && STORES.some((s) => exact === `${s}/config`)) continue;
      if (exact && /\/config\/dev_dirs\.json$/i.test(exact)) continue;
      if (p.glob !== undefined || /\.\./.test(v)) return tag("a wildcard or a '..' walking through the store's folders (it holds the plan signing key)", 'key', tx);
      return tag(MSG.key, 'key', tx);
    }
  }
  return null;
}

function sweepVerdict(c, ctx, pipe) {
  const b = c.name;
  const flagged = I.SWEEP_FLAGGED[b];
  if (!I.SWEEP_ALWAYS.has(b) && !flagged) return null;
  const all = c.args || [];
  const lits = all.map(literal);
  if (flagged && !lits.some((l) => l !== null && flagged(l))) return null;
  let targets = [];
  if (b === 'find') {
    for (const w of all) {
      const L = literal(w);
      if (L !== null && (/^-/.test(L) || L === '(' || L === '!' || L === ')')) break;
      targets.push(w);
    }
  } else if (c.shell === 'ps') {
    const { named, pos } = argsOf(c);
    targets = [...(named.get('path') || []), ...(named.get('literalpath') || []), ...pos];
    if (['robocopy', 'xcopy'].includes(b)) targets = targets.filter((w) => !/^\//.test(literal(w) || ''));
  } else {
    targets = all.filter((w, i) => !(lits[i] !== null && /^-/.test(lits[i])) && !(lits[i] !== null && /^\/[a-z]+$/i.test(lits[i]) && ['dir', 'findstr', 'robocopy', 'xcopy'].includes(b)));
    if (I.PATTERN_FIRST.has(b) && !lits.some((a) => a !== null && /^-(?:e|f)$|^--(?:regexp|file)=/.test(a))) targets = targets.slice(1);
    // the value of an option that takes one is not a folder (grep -m 5, rg -g '*.md', find -name x)
    targets = targets.filter((w) => {
      const i = all.indexOf(w);
      const prev = i > 0 ? lits[i - 1] : null;
      return !(prev && /^(?:-m|-A|-B|-C|-g|--glob|-t|--type|-e|-f|--include|--exclude|-d|--max-depth|-n|--max-count)$/.test(prev));
    });
  }
  const dot = { type: 'word', parts: [{ t: 'lit', v: '.', q: true }], raw: '.' };
  if (!targets.length) targets = [dot];
  const content = CONTENT_SWEEP.has(b) || (b === 'find' && lits.some((l) => l && /^-(?:exec|execdir|ok|okdir|fprint\w*)$/.test(l)));
  const shown = [c.word ? (literal(c.word) || text(c.word)) : b, ...lits.filter((a) => a !== null && (/^-/.test(a) || /^\/[a-z]+$/i.test(a)))].join(' ');
  for (const t of targets) {
    const v = wordValue(t, ctx);
    if (v === null) continue;
    const pl = places(t, ctx, c.shell);
    if (pl.unknown) continue;
    for (const p of pl.list) {
      if (p.glob === undefined && sweepsHome(p.path)) {
        if (extensionFiltered(c, pipe)) continue;
        return `a recursive read or copy of the home folder or a drive root (it would sweep in the plan signing key); name a narrower folder [rule: home-sweep; matched: "${shown}" on "${text(t)}"]`;
      }
      if (content && (isStoreRoot(p.path) || inConfig(p.path))) return tag(MSG.key, 'key', `${shown} ${text(t)}`);
    }
  }
  return null;
}

// Fork 3 (ruled 10/13): a PowerShell listing of home filtered to literal document extensions, with nothing
// downstream reading the files, cannot sweep in the key.
// The same reasoning applied to `find` (build, 10/13; named to Dylan as an extension of fork 3): a find of home by
// -name / -iname patterns none of which can match the key's file name, with no action of its own and nothing
// downstream reading the files, lists names only.
function extensionFiltered(c, pipe) {
  const downstreamReads = pipe.some((x) => x.pos > c.pos && (PIPE_READERS.has(x.name) || x.fromStdin));
  if (c.name === 'find') {
    const lits = (c.args || []).map(literal);
    if (lits.some((l) => l === null || /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls|path|ipath|wholename|iwholename|regex|iregex|lname|ilname)$/.test(l))) return false;
    const pats = [];
    lits.forEach((l, i) => { if (/^-i?name$/.test(l)) pats.push(lits[i + 1]); });
    if (!pats.length || pats.some((p) => !p || globRe(p).test('plan.key'))) return false;
    return !downstreamReads;
  }
  if (c.shell !== 'ps' || !['get-childitem', 'gci', 'ls', 'dir'].includes(c.name)) return false;
  const { named } = argsOf(c);
  const filters = [...(named.get('include') || []), ...(named.get('filter') || [])];
  if (!filters.length) return false;
  const pats = filters.flatMap((w) => (literal(w) === null ? [null] : literal(w).split(',').map((s) => s.trim())));
  if (!pats.every((p) => p !== null && /^\*\.[A-Za-z0-9]{1,8}$/.test(p) && !/^\*\.key$/i.test(p))) return false;
  return !pipe.some((x) => x.pos > c.pos && PIPE_READERS.has(x.name));
}

function feedVerdict(c, ctx, pipe) {
  if (c.pos === 0) return null;
  const consumer = c.fromStdin || PIPE_READERS.has(c.name);
  if (!consumer) return null;
  const mutating = REMOVE.has(c.name) || MOVE.has(c.name) || WRITE_ARGS.has(c.name) || ['set-content', 'add-content', 'foreach-object', '%', 'foreach'].includes(c.name) || (c.name === 'sed' && /\s-[a-zA-Z]*i/.test(c.src || ''));
  for (const up of pipe.filter((x) => x.pos < c.pos)) {
    if (up.shell !== 'ps' && I.isEngineRun(up.src || '')) return tag(MSG.store, 'pipe-feed', 'engine output');
    const words = up.args && up.args.length ? up.args : [];
    const reached = new Set();
    if (LISTERS.has(up.name) && !words.some((w) => !/^-/.test(literal(w) || '-')) && ctx.here) {
      for (const k of reach({ path: ctx.here })) reached.add(k);
    }
    for (const w of words) {
      if (/^-/.test(literal(w) || '')) continue;
      const pl = places(w, ctx, up.shell);
      if (pl.unknown) continue;
      for (const p of pl.list) for (const k of reach(p)) reached.add(k);
    }
    if (reached.has('root') || reached.has('config')) return tag(MSG.feed, 'pipe-feed', up.name);
    // plans, log and events hold no secret: reading them line by line is ordinary (DESIGN.md §6a); changing them is not
    if (reached.has('store') && mutating) return tag(MSG.store, 'pipe-feed', up.name);
    if (reached.has('plugin') && mutating) return tag(MSG.plugin, 'pipe-feed', up.name);
  }
  return null;
}

// `claude plugin ...`, `claude --settings`, `claude --plugin-dir`, and a run started where project settings hold a
// PermissionRequest hook (F13; fork 5 ruled 10/13: install and marketplace add ASK).
function claudeVerdict(c, ctx, lits) {
  const a = lits.map((l) => (l || '').toLowerCase());
  const pi = a.indexOf('plugin');
  if (pi >= 0) {
    const sub = a[pi + 1];
    if (['disable', 'uninstall', 'remove', 'rm'].includes(sub)) return MSG.pluginOff;
    if (sub === 'marketplace' && ['remove', 'rm'].includes(a[pi + 2])) return MSG.pluginOff;
    if (['install', 'i', 'enable'].includes(sub) || (sub === 'marketplace' && a[pi + 2] === 'add')) {
      return { ask: `SBRM Dataverse guard: adding a plugin to Claude Code (${c.src.slice(0, 160)}). A plugin can bring hooks that answer approval prompts. Yes runs it; No stops it.` };
    }
  }
  if (a[0] === 'config' && /disable[A]llHooks/i.test(c.src || '') && /\btrue\b/i.test(c.src || '')) return MSG.hooksOff;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--settings' || a[i].startsWith('--settings=')) {
      const raw = a[i].includes('=') ? lits[i].slice(lits[i].indexOf('=') + 1) : lits[i + 1];
      if (raw === null || raw === undefined) return 'a Claude Code run with a settings file the guard cannot read [rule: claude-settings]';
      let body = null;
      if (/^\s*\{/.test(raw)) body = raw;
      else {
        const p = resolveText(raw, ctx);
        try { body = p ? fs.readFileSync(p.replace(/^\/([a-z])\//i, '$1:/'), 'utf8') : null; } catch { body = null; }
      }
      if (body === null) return 'a Claude Code run with a settings file the guard cannot read [rule: claude-settings]';
      if (I.HOOKS_OFF.test(body)) return MSG.hooksOff;
      if (I.PLUGIN_OFF_SETTINGS.test(body)) return MSG.pluginOff;
      if (I.PROMPT_ANSWERER.test(body) || /\\u[0-9a-f]{4}/i.test(body)) return { ask: 'SBRM Dataverse guard: a Claude Code run whose settings carry a hook that answers approval prompts. Yes runs it; No stops it.' };
    }
    if (a[i] === '--plugin-dir' && lits[i + 1]) {
      const p = resolveText(lits[i + 1], ctx);
      let body = '';
      for (const f of ['hooks/hooks.json', '.claude-plugin/plugin.json']) { try { body += fs.readFileSync(path.join(p || '', f), 'utf8'); } catch { /* none */ } }
      if (!p || I.PROMPT_ANSWERER.test(body)) return { ask: 'SBRM Dataverse guard: a Claude Code run with a plugin folder whose hooks can answer approval prompts. Yes runs it; No stops it.' };
    }
  }
  // started in a folder whose project settings answer prompts
  for (const d of projectDirs(ctx.here)) {
    if (d === USER_CLAUDE.replace(/\/\.claude$/, '')) continue;
    for (const f of ['settings.json', 'settings.local.json']) {
      let body = '';
      try { body = fs.readFileSync(`${d}/.claude/${f}`, 'utf8'); } catch { continue; }
      if (I.PROMPT_ANSWERER.test(body)) return { ask: `SBRM Dataverse guard: a Claude Code run in ${d}, whose project settings carry a hook that answers approval prompts. Yes runs it; No stops it.` };
    }
  }
  return null;
}

// C3: a shell start-up file runs in every later shell. What is written into one is parsed as a command line: an
// assignment or export of a deny-listed name is refused, and so is anything the shell rules refuse.
function profileVerdict(file, content, env) {
  const shell = /\.ps1$/i.test(file) ? 'ps' : 'posix';
  let cmds;
  try { cmds = SP.parse(String(content), shell); } catch { return MSG.profile; }
  const walk = (list) => {
    for (const c of list) {
      for (const a of c.assigns) if (DENY_NAME.test(String(a.name).replace(/^env:/i, ''))) return true;
      if (['export', 'declare', 'typeset', 'set', 'setenv', 'set-item', 'si', 'setx'].includes(c.name)) {
        for (const w of c.args || []) {
          const L = literal(w) || text(w);
          const n = L.replace(/^env:/i, '').split(/[=\s]/)[0];
          if (DENY_NAME.test(n)) return true;
        }
      }
      if (c.nested.length && walk(c.nested)) return true;
    }
    return false;
  };
  if (walk(cmds)) return MSG.profile;
  const v = shellVerdict(String(content), env.cwd, shell, { depth: 1 });
  return typeof v === 'string' ? v : null;
}

// ---------- a whole command line ----------

function groupByPipeline(cmds) {
  const m = new Map();
  for (const c of cmds) {
    if (!m.has(c.pipeline)) m.set(c.pipeline, []);
    m.get(c.pipeline).push(c);
  }
  return m;
}

function applyEffects(c, ctx) {
  for (const a of c.assigns) {
    const standalone = c.kind === 'control' || !c.word;
    if (!standalone) continue;
    const key = String(a.name).toLowerCase();
    if (a.dynamic || !a.value) { ctx.vars.set(key, null); continue; }
    ctx.vars.set(key, wordValue(a.value, ctx));
  }
  if (c.kind !== 'cmd' || !c.word) return;
  if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(c.name)) {
    for (const w of c.args) {
      const a = SP.splitAssign(w);
      if (a) ctx.vars.set(a.name.toLowerCase(), wordValue(a.value, ctx));
    }
  }
  if (c.name === 'read') for (const w of c.args) { const L = literal(w); if (L && !/^-/.test(L)) ctx.vars.set(L.toLowerCase(), null); }
  if (CD.has(c.name)) {
    const { named, pos } = argsOf(c);
    const to = [...(named.get('path') || []), ...(named.get('literalpath') || []), ...pos][0];
    if (!to) ctx.here = HOME_N;
    else if (literal(to) === '-') ctx.here = null;
    else {
      const pl = places(to, ctx, c.shell);
      ctx.here = pl.unknown || !pl.list.length || pl.list[0].glob !== undefined ? null : pl.list[0].path;
    }
  }
  if (c.name === 'popd' || c.name === 'pop-location') ctx.here = null;
}

function judge(cmds, ctx, env) {
  let ask = null;
  const pipes = groupByPipeline(cmds);
  for (const c of cmds) {
    if (c.nested.length) {
      const r = judge(c.nested, { here: ctx.here, vars: new Map(ctx.vars) }, env);
      if (typeof r === 'string') return r;
      if (r && !ask) ask = r;
    }
    const r = judgeOne(c, ctx, env, pipes.get(c.pipeline) || [c]);
    if (typeof r === 'string') return r;
    if (r && !ask) ask = r;
    applyEffects(c, ctx);
  }
  return ask;
}

// The engine's apply in a RUNNING position: any command that is not a pure printer or searcher, at any depth
// (inside $( ), bash -c, a heredoc into a shell), or code that holds it. A grep, an echo, a commit message or a
// document that holds the words runs nothing (Group A, DESIGN.md §4).
// An interpreter or shell running a script FILE that is not the engine: the words after the script are its data (a
// Todoist comment through `python todoist_api.py comment ...`), as a grep's are (DESIGN.md §6a). A script that runs
// its arguments is the stated residual of Group C; the engine's own run, inline code, or a script word the guard
// cannot read still count.
function scriptRunsData(c) {
  if (!(INTERP[c.name] || /^python\d/.test(c.name || '') || SP.SHELLS.has(c.name) || SP.PS_SHELLS.has(c.name))) return false;
  const a = c.args || [];
  for (let i = 0; i < a.length; i += 1) {
    const L = literal(a[i]);
    if (L === null) return false;
    if (/^-/.test(L)) {
      if (/^(?:-e|--eval|-p|--print|-[a-zA-Z]*c|-command|-encodedcommand|-r|--require|--import|--loader|-m)$/i.test(L)) return false;
      continue;
    }
    return !/dataverse-write(?:\.js)?$/i.test(L);
  }
  return false;
}
function applyRuns(cmds) {
  for (const c of cmds) {
    if (c.nested.length && applyRuns(c.nested)) return true;
    if (c.kind === 'expr' && I.APPLY_ANYWHERE.test(c.code || '')) return true;
    if (c.kind !== 'cmd' || !c.word) continue;
    if (c.heredoc && (INTERP[c.name] || SP.SHELLS.has(c.name)) && I.APPLY_ANYWHERE.test(c.heredoc.body)) return true;
    if (DATA_CMDS.has(c.name) || scriptRunsData(c)) continue;
    if (I.APPLY_ANYWHERE.test(c.src || '')) return true;
  }
  return false;
}
function applyRunsText(command, shells) {
  for (const sh of shells) {
    let cmds;
    try { cmds = SP.parse(command, sh); } catch { if (I.APPLY_ANYWHERE.test(command)) return true; continue; }
    if (applyRuns(cmds)) return true;
  }
  return false;
}

// The PATH / node-options change on the same line as an apply (unchanged from guard.js: whole text).
const PATH_ON_APPLY = /(?:^|[\s;&|(])(?:PATH|Path|NODE_\w+|DYLD_\w+|LD_\w+)=|\$env:(?:PATH|Path|NODE_\w+)|\bexport\s+(?:PATH|NODE_|DYLD_|LD_)|\bset\s+(?:PATH|NODE_)\w*=|\benv\s+(?:-\S+\s+)*\w+=/;

function shellVerdict(command, cwd = null, shell = 'posix', { ctx = null, depth = 0, dirs = null } = {}) {
  const textIn = String(command || '');
  if (I.HIDDEN_CODE.test(textIn)) return MSG.hidden;
  const plain = textIn.replace(I.HARMLESS_REDIRECT, ' ');
  const cli = G.cliVerdict(plain);
  if (cli) return `${cli}, which writes to Dataverse`;
  if (I.targetsDataverse(plain)) return MSG.http;
  const inj = I.shellInjection(textIn);
  if (inj) return `keystroke or click injection (approving is the person's alone) [rule: injection; matched: "${inj.token}" in ${inj.where}]`;
  if (/dataverse-write(?:\.js)?["']?\s+(?:apply|resolve)\b/i.test(textIn) && PATH_ON_APPLY.test(textIn)) {
    return 'changing PATH or node options on the same line as an apply (the engine must run the real Dataverse CLI)';
  }
  let cmds;
  try {
    cmds = SP.parse(textIn, shell);
  } catch (e) {
    // a line the parser cannot read: the current whole-text rules decide it (fail closed)
    const old = G.shellVerdict(textIn, cwd);
    return old ? `${old} [parser fallback: ${e.message}]` : null;
  }
  // The hook's input always names the session's folder; without one, the folder the hook runs in stands for it.
  // (A `cd` the guard cannot follow later on the line still makes relative targets unknown.)
  const here = ctx ? ctx.here : I.norm(cwd || process.cwd()).replace(/\/+$/, '');
  const env = {
    cwd,
    dirs: dirs || I.devDirs(),
    namesStore: I.STORE_IN_TEXT.test(textIn) || I.STORE_ANY.test(textIn),
    namesPlugin: I.PLUGIN_IN_TEXT.test(textIn),
  };
  env.protectedNamed = env.namesStore || env.namesPlugin;
  return judge(cmds, { here, vars: ctx ? new Map(ctx.vars) : new Map() }, env);
}

// ---------- Write / Edit ----------

const SHELL_SCRIPT = /\.(?:sh|bash|zsh|ksh|fish|command)$/i;
const PS_SCRIPT = /\.(?:ps1|psm1)$/i;
const CMD_SCRIPT = /\.(?:cmd|bat)$/i;
const isCodeFile = (file, t) => I.CODE_FILE.test(file) || /\.ipynb$/i.test(file) || (!/\.[\w-]+$/.test(path.basename(String(file))) && /^#!/.test(t));

// The content rules a written file is judged by (Write, Edit, or a shell redirect), outside dev folders.
function contentVerdict(file, t) {
  if (!isCodeFile(file, t)) return null;
  if (I.HIDDEN_CODE.test(t)) return 'writing code that runs out of sight (decoded at run time, or preloaded into node)';
  if (I.ENGINE_INTERNALS.test(t)) return "writing code that reaches the engine's write side directly (it would skip the approval)";
  // 3c: a script that RUNS an apply (as a shell line, or the argument of a launching call), not one that merely
  // holds the words in a string
  if (I.APPLY_ANYWHERE.test(t)) {
    const sh = SHELL_SCRIPT.test(file) || /^#!.*\b(?:ba|z|k|da)?sh\b/.test(t) ? 'posix' : PS_SCRIPT.test(file) ? 'ps' : CMD_SCRIPT.test(file) ? 'cmd' : null;
    if (sh ? applyRunsText(t, [sh]) : LAUNCH_CALL.test(t)) return 'writing a script that runs an apply or resolve (an apply runs only as its own command, so Claude Code asks the person)';
  }
  if (I.targetsDataverse(t) || I.XRM_WRITE.test(t)) return 'writing a raw writing HTTP call at Dataverse';
  if (I.KEY_NAMED.test(t) || /\.sbrm-dataverse[\\/]+config/i.test(t)) return 'writing code that reads the plan signing key';
  if (I.CLI_LIST.test(t) && I.LIST_WRITE.test(t)) return "writing code that calls the Dataverse CLI's write side";
  // F5 (closed part): the CLI's write side as a string the code hands to a shell
  for (const l of codeLiterals(t, /\.py$/i.test(file) ? 'py' : PS_SCRIPT.test(file) ? 'ps' : /\.(?:js|cjs|mjs|ts)$/i.test(file) ? 'js' : 'sh')) {
    if (l.value !== null && G.cliVerdict(l.value)) return "writing code that calls the Dataverse CLI's write side [rule: cli-literal]";
  }
  if (I.storeMoveCode(t)) return "writing code that moves the engine's store or settings";
  return null;
}

// The file's text after the Write or Edit, or null when it cannot be worked out.
function afterText(tool, ti, before) {
  if (tool === 'Write') return String(ti.content || '');
  const edits = tool === 'Edit' ? [ti] : tool === 'MultiEdit' ? (ti.edits || []) : null;
  if (!edits) return null;
  let after = before;
  for (const e of edits) {
    const from = String((e && e.old_string) || '');
    if (!from || !after.includes(from)) return before;
    after = e.replace_all ? after.split(from).join(String(e.new_string || '')) : after.replace(from, () => String(e.new_string || ''));
  }
  return after;
}
const frontmatter = (t) => { const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(t || '')); return m ? m[1] : ''; };
const hooksPart = (f) => { const m = /(?:^|\n)hooks:[\s\S]*?(?=\n[^\s#\n][^\n]*:|$)/.exec(f); return m ? m[0] : ''; };

function writeVerdict(tool, ti, dirs, input = {}) {
  const file = ti.file_path || ti.notebook_path || '';
  if (I.inPlugin(file)) return MSG.plugin;
  if (I.inProtectedStore(file)) return MSG.store;
  const t = I.contentOf(tool, ti);
  const p = I.real(file).replace(/\/+$/, '');
  const lk = loadingKind(p, input.cwd);
  if (lk === 'settings' || lk === 'hooksjson') {
    if (lk === 'settings' && I.HOOKS_OFF.test(t)) return MSG.hooksOff;
    if (I.PLUGIN_OFF_SETTINGS.test(t)) return MSG.pluginOff;
    if ((I.PROMPT_ANSWERER.test(t) || /\\u[0-9a-f]{4}/i.test(t) || (tool !== 'Write' && I.settingsHasAnswerer(file))) && I.addsAnswerer(tool, ti, file)) return MSG.answerer;
  }
  if (lk === 'skillmd') {
    const before = I.readSettings(file);
    const after = afterText(tool, ti, before);
    const hb = hooksPart(frontmatter(before));
    const ha = after === null ? null : hooksPart(frontmatter(after));
    if (ha === null || (/Permission[R]equest|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i.test(ha) && ha !== hb)) return MSG.answerer;
  }
  if (isProfile(p)) {
    const v = profileVerdict(p, t, { cwd: input.cwd, dirs });
    if (v) return v;
  }
  // Only files that run, or the settings Claude Code loads hook COMMANDS from, are read for injection (1.11.5).
  if (/\.(?:a[h]k|au3)$/i.test(file)) return `writing keystroke or click injection (approving is the person's alone) [rule: injection-write; matched: a ${path.extname(file)} script]`;
  if (I.isExecFile(file, t) || lk === 'settings' || lk === 'hooksjson') {
    const token = I.injectMatch(lk ? t.replace(/\\"/g, '"') : t);
    if (token) return `writing keystroke or click injection (approving is the person's alone) [rule: injection-write; matched: "${token}" in a ${path.extname(file) || 'script'} file]`;
  }
  if (!I.inDevDir(file, dirs)) return contentVerdict(file, t);
  return null;
}

// ---------- the verdict ----------

function verdict(input, dirs = I.devDirs(), { popup = I.popupOpen } = {}) {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const mcp = I.mcpParts(tool);
  if (mcp && I.DV_SERVER.test(mcp.server)) return I.READ_TOOLS.has(mcp.name) ? null : `the Dataverse tool "${mcp.name}" (only known reads are allowed)`;
  if (mcp && I.DV_WRITE_TOOLS.test(mcp.name)) return `the tool "${mcp.name}" (a Dataverse write outside the approved path)`;
  if (I.SCREEN_TOOL.test(tool) && popup()) return 'driving the screen while an approval is waiting (approving is the person\'s alone)';
  if (mcp) {
    const strings = [];
    const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(ti);
    if (I.SHELL_MCP.test(mcp.name)) {
      // its shell is unknown: read with both, refused if either refuses
      if (strings.some((s) => applyRunsText(s, ['posix', 'ps']))) return `an apply or resolve through the tool "${mcp.name}" (an apply runs only as a Bash or PowerShell command of its own, so Claude Code asks the person)`;
      for (const s of strings) {
        for (const sh of ['posix', 'ps']) {
          const v = shellVerdict(s, input.cwd || null, sh, { dirs });
          if (typeof v === 'string') return `${v} (through the tool "${mcp.name}")`;
        }
      }
    }
    if (I.CODE_MCP.test(mcp.name)) {
      const t = strings.join('\n');
      if (I.targetsDataverse(t)) return 'a writing HTTP call at Dataverse from another tool';
      if (I.XRM_WRITE.test(t)) return "a write through the app's own page code (Xrm), which skips the approval";
    }
  }
  if (tool === 'Read' || tool === 'Grep') return I.keyPathVerdict(tool, ti, input.cwd);
  if (tool === 'Bash' || tool === 'PowerShell') return shellVerdict(String(ti.command || ''), input.cwd || null, tool === 'PowerShell' ? 'ps' : 'posix', { dirs });
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return writeVerdict(tool, ti, dirs, input);
  return null;
}

// null (not an approval), { block }, or { ask: { verb, keys } } (unchanged from guard.js except that the apply
// words in a NON-running position are not refused).
function approvalVerdict(input, { engine } = {}) {
  const tool = String(input.tool_name || '');
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String((input.tool_input || {}).command || '');
  const ap = G.approvalCommand(command, engine === undefined ? I.ownEngine() : engine);
  const shell = tool === 'PowerShell' ? 'ps' : 'posix';
  if (!ap) return applyRunsText(command, [shell]) ? { block: MSG.apply } : null;
  if (input.agent_id || input.agent_type) return { block: 'an apply from a subagent (the main session runs applies, so the person sees Claude Code\'s prompt)' };
  const mode = input.permission_mode;
  if (!I.ASK_MODES.has(mode)) {
    return { block: `an apply in a permission mode where Claude Code does not ask the person (this session: "${mode || 'not given'}"). The person switches to a mode that asks (shift+tab), then Claude runs the apply again` };
  }
  const other = shellVerdict(command, input.cwd || null, shell);
  if (typeof other === 'string') return { block: other };
  return { ask: ap };
}

// The decision as one value, for comparing the two models: 'allow' | 'block' | 'ask'.
function kindOf(v) {
  if (!v) return 'allow';
  if (typeof v === 'string') return 'block';
  if (v.block) return 'block';
  return 'ask';
}

// Both models on one call, as the hook decides it: the approval layer, then the verdict.
function decideOld(input, opts = {}) {
  const ap = G.approvalVerdict(input, opts);
  if (ap && ap.block) return { kind: 'block', why: ap.block };
  if (ap && ap.ask) return { kind: 'ask', why: 'approval' };
  const v = G.verdict(input, opts.dirs, { popup: opts.popup || (() => false) });
  return v ? { kind: 'block', why: v } : { kind: 'allow', why: null };
}
function decideNext(input, opts = {}) {
  const ap = approvalVerdict(input, opts);
  if (ap && ap.block) return { kind: 'block', why: ap.block };
  if (ap && ap.ask) return { kind: 'ask', why: 'approval' };
  const v = verdict(input, opts.dirs, { popup: opts.popup || (() => false) });
  return { kind: kindOf(v), why: typeof v === 'string' ? v : v && v.ask ? v.ask : null };
}

module.exports = { verdict, approvalVerdict, shellVerdict, writeVerdict, contentVerdict, decideOld, decideNext, kindOf, applyRuns, codeLiterals, loadingKind, isProfile, resolveText };
