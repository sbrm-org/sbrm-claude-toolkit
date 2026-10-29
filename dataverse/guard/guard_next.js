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
// 1.11.10-1.11.13 ran this in shadow. From 1.11.14 (the cut-over) THIS decides: guard.js's hook entry calls it and
// keeps its own verdict only as the watcher (shadowOld) and as the self-test's parity reference.
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
// A variable's key: a POSIX shell's names are case-sensitive ($a and $A are two variables), PowerShell's and cmd's are
// not (review 10/23: folding a POSIX name let A=/safe; ... > "$a<store path>" be judged as /safe while the shell wrote
// into the store).
const varKey = (name, shell) => (shell === 'posix' ? String(name) : String(name).toLowerCase());
function varValue(name, ctx) {
  if (ctx.shell === 'posix') {
    const k = String(name);
    if (k === 'HOME' || k === 'USERPROFILE') return HOME_F;
    if (k === 'HOMEDRIVE') return HOME_F.slice(0, 2);
    if (k === 'HOMEPATH') return HOME_F.slice(2);
    if (['TMP', 'TEMP', 'TMPDIR'].includes(k)) return TMP_F;
    if (k === 'PWD' && ctx.here) return ctx.here;
    if (ctx.vars.has(k)) return ctx.vars.get(k);
    // The job folder Claude Code gives every background session (D-1273, 10/23), read from the hook's own environment
    // when the line does not set it (a value set on the line wins, above). Only this exact name: any other stays unknown.
    if (k === 'CLAUDE_JOB_DIR' && process.env.CLAUDE_JOB_DIR) return process.env.CLAUDE_JOB_DIR.replace(/\\/g, '/');
    return null;
  }
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
  if (/\/\.config\/fish\/conf\.d\/[^/]+\.fish$/i.test(n) && under(n, HOME_N)) return true;   // 1.11.17 (audit P3): fish runs every snippet there
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

// A string literal in code is judged as a CLI call only when it is COMMAND-SHAPED: the CLI word, then one of the
// verbs the CLI has (`--help`, 10/21: auth, org/env, api, erp, data, skill, mcp, install) or a flag. judgeCli fails
// closed on an unknown verb, which is right for a shell line and wrong for prose in a string: a docstring opening
// "<product> UserLocal DateOnly ..." (H-1028, 10/19) and a label "<product> hgs (secret)" (10/21) were stopped. A
// literal handed straight to a shell is still read as a whole command line (SHELL_CALL below), unknown verbs refused.
const CLI_VERBS = 'auth|org|env|api|erp|data|skill|mcp|install|help';
const CLI_SHAPED = new RegExp(`(?:^|[\\s"'\`&|;(/\\\\])(?:npx\\s+(?:-y\\s+)?@microsoft/)?data[v]erse(?:cli)?(?:@[\\w.^~-]+)?(?:\\.exe|\\.cmd|\\.ps1|\\.js)?["'\`]?\\s+(?:-|(?:${CLI_VERBS})(?![\\w-]))`, 'i');
const literalCli = (s) => (CLI_SHAPED.test(s) ? G.cliVerdict(s) : null);

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

// The paths a call is given BY KEYWORD (dst=, target=, path=, file= and the like): each literal value, or undefined
// when the value is not a literal (judged as unknown). Review 10/23, round 4: only positional arguments were judged, so
// os.replace(src, dst=<a store path>) and Path(x).replace(target=<a store path>) passed.
// Round 5: by the call's role. A copy reads its source (src=, source=) and writes only its destination, so the source is
// not a target; makedirs(name=...) names what it creates.
const PATH_KEYWORD = /^(?:file|path|name|src|source|dst|dest|destination|target|target_path|new_path|filename|newname)$/i;
const SOURCE_KEYWORD = /^(?:src|source)$/i;
function keywordValues(all, lang, keyRe, rx) {
  const out = [];
  for (const a of all) {
    if (!a.keyword) continue;
    const m = /^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(a.text);
    if (!m || !keyRe.test(m[1])) continue;
    const l = codeLiterals(m[2], lang)[0];
    // a string prefix (r'', b'', u'') is still a literal; an f-string is not (its value is null); a name bound once or a
    // joined path is followed (G4)
    const v = l && /^[rbuRBU]{0,2}$/.test(m[2].slice(0, l.start)) && l.end === m[2].length ? l.value : undefined;
    out.push(typeof v === 'string' ? v : rx ? rx(m[2]) : undefined);
  }
  return out;
}
function keywordTargets(all, lang, which = 'all', rx) {
  const keys = { source: [], other: [] };
  for (const a of all) {
    if (!a.keyword) continue;
    const m = /^([A-Za-z_]\w*)\s*=/.exec(a.text);
    if (m && PATH_KEYWORD.test(m[1])) keys[SOURCE_KEYWORD.test(m[1]) ? 'source' : 'other'].push(a);
  }
  const vals = (list) => keywordValues(list, lang, PATH_KEYWORD, rx);
  return which === 'last' ? vals(keys.other) : [...vals(keys.other), ...vals(keys.source)];
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

// ---------- names bound once, and paths joined from known parts (inline_code_review GATE_2 G4, ruled 10/29/26) ----------
// The reader follows what honest code does: a name assigned once to a literal, the home folder, a temp folder, and a
// join (os.path.join, path.join, Path / 'x', a + b, an f-string or template) whose EVERY part is known, joined as the
// language joins (an absolute later part wins). Anything else is unknown. A path built at run time to get past this is
// an accepted residual (G4.4), not a gap to patch.

// The environment variables a path is honestly built from, and the value the guard takes for each.
const ENV_PATHS = { HOME: () => HOME_F, USERPROFILE: () => HOME_F, TEMP: () => TMP_F, TMP: () => TMP_F, TMPDIR: () => TMP_F, LOCALAPPDATA: () => process.env.LOCALAPPDATA, APPDATA: () => process.env.APPDATA };
const envPath = (n) => { const f = ENV_PATHS[String(n).toUpperCase()]; const v = f && f(); return v ? String(v).replace(/\\/g, '/') : undefined; };

// The index of the bracket closing the one at `open`, skipping string literals; -1 when it never closes.
function closeOf(code, open, lits) {
  const litAt = new Map(lits.map((l) => [l.start, l]));
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const l = litAt.get(i);
    if (l) { i = l.end - 1; continue; }
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

// Split code at top-level separators (outside literals and brackets): the pieces, trimmed.
function splitTop(code, isSep, lits) {
  const litAt = new Map(lits.map((l) => [l.start, l]));
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    const l = litAt.get(i);
    if (l) { i = l.end - 1; continue; }
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && isSep(code, i)) { out.push(code.slice(start, i)); start = i + 1; }
  }
  out.push(code.slice(start));
  return out.map((s) => s.trim());
}

const joinPaths = (parts) => parts.slice(1).reduce((acc, p) => (/^(?:[\\/]|[A-Za-z]:)/.test(p) ? p : `${acc.replace(/[\\/]+$/, '')}/${p}`), parts[0]);

// Text joined after a known folder and a separator (f"{D}/{k}.txt", D + '/' + k) can only land under that folder
// (`..` aside, the accepted residual): it resolves to the folder plus UNDER, judged by the folder (judgeTarget). A
// path.join is not read this way: an absolute later part wins there (GATE_2 correction 2).
const UNDER = '\u0001';
const underPrefix = (pre) => (/[\\/]$/.test(pre) && pre.length > 1 && !pre.includes(UNDER) ? `${pre}${UNDER}` : undefined);

// An f-string, template or PowerShell string with only known names in it, filled in; a known folder prefix, as above;
// undefined otherwise.
function fillTemplate(raw, binds, lang, depth) {
  const re = lang === 'py' ? /\{([^{}]*)\}/g : lang === 'ps' ? /\$\{([^}]*)\}|\$([A-Za-z_]\w*)/g : /\$\{([^}]*)\}/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const pre = out + raw.slice(last, m.index);
    const v = resolveExpr(m[1] !== undefined ? m[1] : (lang === 'ps' ? `$${m[2]}` : m[2]), binds, lang, depth + 1);
    if (v === undefined) return underPrefix(pre);
    if (v.endsWith(UNDER)) return pre + v;
    out = pre + v;
    last = m.index + m[0].length;
  }
  return out + raw.slice(last);
}

// The path text an expression stands for, or undefined when the guard cannot know it.
function resolveExpr(expr, binds, lang, depth = 0) {
  let e = String(expr || '').trim().replace(/;$/, '').trim();
  if (!e || depth > 8) return undefined;
  let lits = codeLiterals(e, lang);
  while (e[0] === '(' && closeOf(e, 0, lits) === e.length - 1) { e = e.slice(1, -1).trim(); lits = codeLiterals(e, lang); }
  const R = (x) => resolveExpr(x, binds, lang, depth + 1);
  // a module under another name (p = require('path'), import os.path as osp) is read as the module
  const al = /^([A-Za-z_$][\w$]*)(?=\s*\.)/.exec(e);
  if (al && binds.aliases && binds.aliases.has(al[1])) { e = binds.aliases.get(al[1]) + e.slice(al[1].length); lits = codeLiterals(e, lang); }
  // one string literal (a prefix allowed); an f-string or template is filled in from known names
  if (lits.length === 1 && lits[0].end === e.length && /^[rbuRBUfF@]{0,2}$/.test(e.slice(0, lits[0].start))) {
    return lits[0].value !== null ? lits[0].value : fillTemplate(lits[0].text, binds, lang, depth);
  }
  // a name bound once
  const nm = lang === 'ps' ? /^\$([A-Za-z_]\w*)$/.exec(e) : /^([A-Za-z_$][\w$]*)$/.exec(e);
  if (nm) return binds.has(nm[1]) ? binds.get(nm[1]) : undefined;
  // the home folder and the environment's temp folders
  if (/^(?:os\.homedir\(\s*\)|(?:pathlib\.)?Path\.home\(\s*\))$/.test(e)) return HOME_F;
  const ev = /^os\.environ\s*\[\s*(["'])(\w+)\1\s*\]$/.exec(e) || /^os\.(?:environ\.get|getenv)\s*\(\s*(["'])(\w+)\1\s*\)$/.exec(e)
    || /^process\.env\s*\[\s*(["'`])(\w+)\1\s*\]$/.exec(e) || /^process\.env\.()(\w+)$/.exec(e) || (lang === 'ps' ? /^\$env:()(\w+)$/i.exec(e) : null);
  if (ev) return envPath(ev[2]);
  // a method that keeps the path: .expanduser(), .resolve(), .absolute()
  const sfx = /\.(?:expanduser|resolve|absolute)\(\s*\)$/.exec(e);
  if (sfx) return R(e.slice(0, sfx.index));
  // a call that wraps or joins paths, when it is the whole expression
  const call = /^((?:os\.path|posixpath|ntpath|path(?:\.posix|\.win32)?)\.(?:join|resolve|expanduser|abspath|normpath|realpath|normalize)|(?:pathlib\.)?(?:Pure(?:Posix|Windows)?)?Path|str|os\.fspath|\[(?:System\.)?IO\.Path\]::Combine|Join-Path)\s*\(/.exec(e);
  if (call && closeOf(e, call[0].length - 1, lits) === e.length - 1) {
    const args = callArgs(e, call[0].length - 1, lits);
    if (!args.length || args.some((a) => a.keyword)) return undefined;
    const parts = args.map((a) => R(a.text));
    if (parts.some((p) => p === undefined || (p.endsWith(UNDER) && parts.length > 1))) return undefined;
    return parts.length === 1 ? parts[0] : joinPaths(parts);
  }
  // a + b (text joined as is) or, in Python, Path / 'x' (joined as a path)
  const plus = splitTop(e, (s, i) => s[i] === '+' && s[i + 1] !== '=' && s[i + 1] !== '+' && s[i - 1] !== '+', lits);
  if (plus.length > 1) {
    let pre = '';
    for (const part of plus) {
      const v = R(part);
      if (v === undefined) return underPrefix(pre);
      if (v.endsWith(UNDER)) return pre + v;
      pre += v;
    }
    return pre;
  }
  if (lang === 'py') {
    const slash = splitTop(e, (s, i) => s[i] === '/' && s[i + 1] !== '/' && s[i - 1] !== '/' && s[i + 1] !== '=', lits);
    if (slash.length > 1) {
      const parts = slash.map(R);
      return parts.some((p) => p === undefined || p.endsWith(UNDER)) ? undefined : joinPaths(parts);
    }
  }
  return undefined;
}

// The names the code binds exactly once, each to the path text it stands for (undefined when unknown). A name bound
// more than once, or by a loop, `with ... as`, an unpacking or an augmented assignment, is unknown.
function collectBinds(src, lang, lits) {
  const binds = new Map();
  const seen = new Map();
  binds.aliases = new Map();
  // the path and os modules under other names
  for (const m of src.matchAll(/\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'`](?:node:)?(path|os)["'`]\s*\)/g)) binds.aliases.set(m[1], m[2]);
  for (const m of src.matchAll(/\bimport\s+(os\.path|os|posixpath|ntpath)\s+as\s+([A-Za-z_]\w*)/g)) binds.aliases.set(m[2], m[1]);
  for (const m of src.matchAll(/\bfrom\s+os\s+import\s+path\s+as\s+([A-Za-z_]\w*)/g)) binds.aliases.set(m[1], 'os.path');
  // a JS declaration of several names (const a = 1, b = 2) is one statement per name
  const stmts = splitTop(src, (s, i) => s[i] === '\n' || s[i] === ';', lits).flatMap((st) => {
    const d = /^(?:const|let|var)\s+/.exec(st);
    if (!d || lang !== 'js') return [st];
    const rest = st.slice(d[0].length);
    return splitTop(rest, (s, i) => s[i] === ',', codeLiterals(rest, lang));
  });
  const assign = lang === 'ps' ? /^\$([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+)$/ : /^(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[\w.[\], ]+)?=(?!=)\s*([\s\S]+)$/;
  const once = [];
  for (const st of stmts) {
    const m = assign.exec(st);
    if (m) { seen.set(m[1], (seen.get(m[1]) || 0) + 1); once.push(m); continue; }
    // other ways a name gets a value: loops, with-as, unpacking, augmented or walrus assignment
    const others = [
      ...[...st.matchAll(/\bfor\s*\(?\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)/g)].map((x) => x[1]),
      ...[...st.matchAll(/\bas\s+([A-Za-z_]\w*)/g)].map((x) => x[1]),
      ...[...st.matchAll(/\$?([A-Za-z_$][\w$]*)\s*(?:[-+*/%|&^]|\*\*|\/\/|<<|>>|:)=(?!=)/g)].map((x) => x[1]),
    ];
    const un = /^(?:(?:const|let|var)\s+)?[[(]?\s*([\w$]+(?:\s*,\s*[\w$*]+)+)\s*[\])]?\s*=(?!=)/.exec(st);
    if (un) others.push(...un[1].split(',').map((x) => x.trim().replace(/^\*/, '')));
    for (const n of others) seen.set(n, (seen.get(n) || 0) + 2);
  }
  for (const m of once) {
    if (seen.get(m[1]) !== 1) { binds.set(m[1], undefined); continue; }
    binds.set(m[1], resolveExpr(m[2], binds, lang));
  }
  return binds;
}

// A method name that is a file call only on a file module (os.remove, shutil.move, fs.rm, File.Delete): on a list, a
// dict or a string it is text work (fpc: a list's remove on code naming the store, 10/29).
const AMBIGUOUS_WRITE = /^(?:remove|rename|replace|move|Move|Replace|copy|Copy|Delete|Create|rm|link)\b/;
const FILE_MODULE = /(?:^|[^\w.])(?:os|shutil|fs|fsp|promises|posix|nt|File|Directory|FileUtils|Bun|Deno)\s*\.\s*$|require\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)\s*\.\s*$/;

const askUnknown = (src) => ({ ask: `SBRM Dataverse guard: this code names ${I.STORE_IN_TEXT.test(src) || I.STORE_ANY.test(src) ? "the engine's own store" : "the toolkit plugin's files"} and writes a file, but the guard could not tell where it writes. Check the target before you say Yes; Yes runs it, No stops it.` });

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
    const v = literalCli(l.value);
    if (v) return tag(`${v}, which writes to Dataverse`, 'cli-literal');
    if (I.KEY_NAMED.test(l.value)) return MSG.keyRead;
    if (/[\\/]|^~/.test(l.value) && /sbrm-dataverse|\.\./i.test(l.value)) {
      const p = resolveText(l.value, ctx);
      if (p && inConfig(p) && !/\/dev_dirs\.json$/i.test(p)) return MSG.keyRead;
    }
  }
  // file writes whose target is a literal, a name bound once or a joined path: judged by where it lands. An unreadable
  // target on code that names the store or the plugin ASKS (G4, Dylan 10/29: "ask"; before, C2 failed closed), and the
  // scan goes on, so a later block still wins.
  const binds = collectBinds(src, lang, lits);
  const rx = (t) => resolveExpr(t, binds, lang);
  const argsAt = (open) => callArgs(src, open, lits).map((a) => (a.keyword || typeof a.literal === 'string' ? a : { ...a, literal: rx(a.text) }));
  let unknown = null;
  const named = namesProtected(src);
  const judgeTarget = (value, removal) => {
    if (value === undefined || value === null) return named ? 'unknown' : null;
    if (value.endsWith(UNDER)) {
      // something under a known folder: judged as a file in it, unless the folder is home, above it, Claude Code's own
      // folder, or above the store or plugin, where the rest of the name decides (G4)
      const d = resolveText(value.slice(0, -1).replace(/[\\/]+$/, '') || '/', ctx);
      if (d !== null && (protectedStore(d) || inPluginP(d))) return judgeTarget(`${d}/x`, removal);
      if (d === null || sweepsHome(d) || under(d, USER_CLAUDE) || above(d, USER_CLAUDE) || storeAncestor(d) || pluginAncestor(d)) return named ? 'unknown' : null;
      return judgeTarget(`${d}/x`, removal);
    }
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
  const hit = (k) => {
    if (k === 'unknown') { if (!unknown) unknown = askUnknown(src); return null; }
    return k === 'store' ? tag(MSG.store, 'store-tamper') : k === 'plugin' ? tag(MSG.plugin, 'plugin-tamper') : k === 'loading' ? MSG.loading : k === 'profile' ? MSG.profile : null;
  };
  for (const [re, which, removal] of CODE_WRITES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (lits.some((l) => m.index >= l.start && m.index < l.end)) continue;
      // `.replace(` as a METHOD is judged by RECEIVER_WRITES below (os.replace, Path(...).replace: its target, or
      // unknown on code that names the store), never here, where a string's .replace(old, new) read its arguments as
      // paths (D-1175, 10/17: `k.replace("/","\\")` read as moving the drive root). A bare replace( is still judged.
      if (/^replace/i.test(m[0]) && /\.\s*$/.test(src.slice(0, m.index))) continue;
      // a list's remove, a dict's copy: a file call only on a file module (G4, fpc)
      if (AMBIGUOUS_WRITE.test(m[0]) && /\.\s*$/.test(src.slice(0, m.index)) && !FILE_MODULE.test(src.slice(Math.max(0, m.index - 80), m.index))) continue;
      const all = argsAt(m.index + m[0].length - 1);
      const args = all.filter((a) => !a.keyword);
      let targets = [];
      if (which === 'open') {
        // the file positionally, or by keyword (open(file=..., mode="w"), round 5)
        const [fileKw] = keywordValues(all, lang, /^(?:file|path)$/i, rx);
        const hasFile = !!args[0] || all.some((a) => a.keyword && /^(?:file|path)\s*=/.test(a.text));
        const file = args[0] ? args[0].literal : fileKw;
        // opening anything in the store's settings folder, even to read, reaches the plan signing key (G4: a joined
        // path is now followed there, as a literal always was by KEY_NAMED)
        if (typeof file === 'string') {
          const fp = resolveText(file.replace(UNDER, 'x'), ctx);
          if (fp && inConfig(fp) && !/\/dev_dirs\.json$/i.test(fp)) return MSG.keyRead;
        }
        const mode = args.slice(1).find((a) => typeof a.literal === 'string');
        const perlTarget = args.find((a) => typeof a.literal === 'string' && /^\+?[<>]/.test(a.literal));
        if (perlTarget) { if (/^\+?>|^\+</.test(perlTarget.literal)) targets = [perlTarget.literal]; }
        else if (mode && /^[rwaxbt+]*[wax+][rwaxbt+]*$/.test(mode.literal) && hasFile) targets = [file];
        // mode=: read from the call's own arguments, wherever it sits (round 6: a 300-character text window missed one
        // placed further out); a mode that is not a literal could be a write, so it counts
        const modeKw = all.filter((a) => a.keyword && /^mode\s*=/.test(a.text));
        const [modeVal] = keywordValues(modeKw, lang, /^mode$/i);
        if (!targets.length && hasFile && modeKw.length && (modeVal === undefined || /^[rwaxbt+]*[wax+][rwaxbt+]*$/.test(modeVal))) targets = [file];
        // a positional mode that is not a literal (open(p, m)) could be a write (round 7)
        if (!targets.length && !perlTarget && args[1] && typeof args[1].literal !== 'string' && hasFile) targets = [file];
      } else if (which === 'first') targets = args[0] ? [args[0].literal] : [];
      // a copy writes its last argument, unless the destination is given by keyword: then every positional is a source
      // (round 6: copyfile(<plugin file>, dst=<scratch>) read the source as the target)
      else if (which === 'last') targets = all.some((a) => a.keyword && /^(?:dst|dest|destination|target)\s*=/i.test(a.text)) ? [] : (args.length ? [args[args.length - 1].literal] : []);
      else targets = args.map((a) => a.literal);
      // a path passed by keyword (os.replace(src, dst=...), open(file=..., mode="w") excepted) is a target too (round 4)
      if (which !== 'open') targets.push(...keywordTargets(all, lang, which, rx));
      for (const t of targets) {
        const h = hit(judgeTarget(t, removal));
        if (h) return h;
      }
    }
  }
  RECEIVER_WRITES.lastIndex = 0;
  let rm;
  while ((rm = RECEIVER_WRITES.exec(src)) !== null) {
    if (lits.some((l) => rm.index >= l.start && rm.index < l.end)) continue;
    const before = src.slice(Math.max(0, rm.index - 300), rm.index);
    // The receiver is a PATH literal only inside Path("x"). A bare or parenthesized string literal is a string, whose
    // .replace is text work, and a ")" closing a call's arguments makes the receiver that call's result (F-1076, 10/22,
    // and review rounds 1-5: s.replace("|", "/").replace(...), "a/".rstrip("/").replace(...) and "/".replace("/", "|")
    // were each read as a file operation on the drive root). Any other receiver is unknown (C2 on code naming the store).
    const lm = /Path\s*\(\s*[rbRB]?(["'])((?:(?!\1).)*)\1\s*\)\s*$/.exec(before);
    const strReceiver = !lm && (/(?:^|[^\w.\])'"])[rbRB]?(["'])(?:(?!\1).)*\1\s*$/.test(before)
      || /(?:^|[^\w.\])'"])\(\s*[rbRB]?(["'])(?:(?!\1).)*\1\s*\)\s*$/.test(before));
    // A rename, replace or link also WRITES its first argument: judged as a target (review 10/23: only the source was).
    // `.replace(` is far more often a string's: it is a file call only when the receiver is Path(...), or an object the
    // guard cannot read in code that uses pathlib, never on a plain string literal (rounds 2 and 3) or in code with no
    // pathlib at all (G4: H-1086, a string's replace on a variable in code naming the plugin, was read as a file move).
    // os.replace / shutil-style module calls are file moves whatever else the code imports (round 4).
    const moduleCall = /(?:^|[^\w.])(?:os|shutil)\s*$/.test(before); // os.replace(src, dst): both are paths
    const pathReceiver = moduleCall || (!strReceiver && /\bpathlib\b|\bPath\s*\(/.test(src));
    if (/replace/.test(rm[0]) && !pathReceiver) continue;
    // the receiver: Path("x"), or a name bound once (G4); a string literal's method changes no file, whatever its text
    // names (round 6); a module's own call is judged by its arguments below
    const idm = !lm && /(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*$/.exec(before);
    if (!strReceiver && !moduleCall) {
      const h = hit(judgeTarget(lm ? lm[2] : idm ? rx(idm[1]) : undefined, /unlink|rmdir|rename|replace/.test(rm[0])));
      if (h) return h;
    }
    if (/rename|symlink_to|hardlink_to/.test(rm[0]) || /replace/.test(rm[0])) {
      const all = argsAt(rm.index + rm[0].length - 1);
      // a Path method's destination is its first argument, a module call's are all of them; or by keyword (round 4)
      const positional = all.filter((a) => !a.keyword);
      const dests = moduleCall ? positional : positional.slice(0, 1);
      for (const v of [...dests.map((a) => a.literal), ...keywordTargets(all, lang, 'all', rx)]) {
        const h = hit(judgeTarget(v, false));
        if (h) return h;
      }
    }
  }
  // A string handed to a shell from code is a command line of its own; a list of words is one too.
  if (depth < 3) {
    SHELL_CALL.lastIndex = 0;
    let sm;
    while ((sm = SHELL_CALL.exec(src)) !== null) {
      if (lits.some((l) => sm.index >= l.start && sm.index < l.end)) continue;
      const span = argsAt(sm.index + sm[0].length - 1);
      const lines = [];
      for (const a of span) {
        if (typeof a.literal === 'string' && !a.literal.includes(UNDER)) lines.push(a.literal);
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
  return unknown;
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

// The environment drive, in every spelling PowerShell accepts for it (1.11.17, audit F6).
const ENV_DRIVE = /^(?:(?:Microsoft\.PowerShell\.Core\\)?Environment::|env:)[\\/]?/i;
// The variable a persistent-setting command targets: { name }, { computed: true } when it cannot be read, or null
// when the command does not touch the environment at all (a New-Item of an ordinary file).
function persistedName(c, name) {
  if (name === 'setx') {
    const words = (c.args || []).map(literal);
    for (let i = 0; i < words.length; i += 1) {
      const L = words[i];
      if (L === null) return { computed: true };
      if (/^\/[sup]$/i.test(L)) { i += 1; continue; }      // /S system, /U user, /P password take a value
      if (/^\//.test(L)) continue;
      return { name: L };
    }
    return null;
  }
  const { named, pos } = argsOf(c);
  const pathW = [...(named.get('path') || []), ...(named.get('literalpath') || [])][0] || pos[0];
  if (!pathW) return null;
  const p = literal(pathW);
  if (p === null || !ENV_DRIVE.test(p)) return null;     // a computed or ordinary path: the file rules judge it
  const n = p.replace(ENV_DRIVE, '');
  if (n) return { name: n };
  // -Name is in PS_SWITCHES (a switch for Get-ChildItem), so argsOf leaves its value positional: read the word after
  // the flag itself; with no -Name, the name is the positional after the path (pos[1], or pos[0] when -Path is named).
  const a = c.args || [];
  const ni = a.findIndex((w) => /^-name$/i.test(literal(w) || ''));
  const nw = ni >= 0 ? a[ni + 1] : pos[pathW === pos[0] ? 1 : 0];
  const L = nw ? literal(nw) : null;
  return L ? { name: L } : { computed: true };
}

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
    // 1.11.17 (10/22 audit F3-F8): the raw-text pattern knew only the spelled-out Set-Item and read the line before
    // the parser decoded it; judge the variable the command really targets (aliases, backticks, Environment::).
    const t = persistedName(c, name);
    if (t && (t.computed || DENY_NAME.test(t.name) || storeMoveAssign({ name: t.name }))) return tag(MSG.move, 'store-move', name);
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
  // an ask from one piece of code waits while the rest are read for a block (G4)
  let ask = null;
  for (const { code, lang } of inlineCode(c, pipe)) {
    const v = codeVerdict(code, lang, ctx, env);
    if (typeof v === 'string') return v;
    if (v && !ask) ask = v;
  }
  return ask;
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

// A `sed -i` on a skill file whose script the guard can read in full and that cannot write a hook (S-1005, 10/16: a
// one-word change to a skill's body text was stopped as a prompt hook, because a shell edit's result cannot be read).
// Passes only a literal script (no -e / -f) made of nothing but s/// commands with plain flags (no e, no w), whose
// text names no hook, permission or request, and that re-inserts nothing it matched (no \1 or &) and decodes no
// character escape (\x \u \o \d \c). Anything else on a skill file fails closed as before.
// H-1093 (10/28): an s/// may carry a line address, N or N,M (`18s/a/b/`): it narrows where the change applies, so it
// can only change less. A pattern, negated, stepped or $ address is still not read.
function sedSubsOnly(script) {
  const s = String(script);
  const parts = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i += 1;
    if (i >= s.length) break;
    i += /^(?:\d+(?:,\d+)?\s*)?/.exec(s.slice(i))[0].length;
    if (s[i] !== 's') return null;
    const d = s[i + 1];
    if (!d || /[\s\\]/.test(d)) return null;
    i += 2;
    const fields = [];
    for (let f = 0; f < 2; f += 1) {
      let v = '';
      while (i < s.length && s[i] !== d) {
        if (s[i] === '\\') { v += s[i] + (s[i + 1] || ''); i += 2; } else { v += s[i]; i += 1; }
      }
      if (s[i] !== d) return null;
      i += 1;
      fields.push(v);
    }
    // plain flags only: an e or w flag (or anything else) is left in place and fails the "s" check next round
    i += /^[gIip0-9]*/.exec(s.slice(i))[0].length;
    parts.push(fields);
  }
  return parts.length ? parts : null;
}
function sedEditSafe(c) {
  if (c.name !== 'sed' && c.name !== 'gsed') return false;
  const { pos, flags } = argsOf(c);
  if (flagHas(flags, /^-[a-zA-Z]*[ef]$|^--(?:expression|file)/) || !pos.length) return false;
  const subs = sedSubsOnly(literal(pos[0]) ?? '');
  return !!subs && subs.every(([pat, rep]) => !/hook|permission|request/i.test(pat + rep)
    && !/\\[0-9xuodc]/i.test(pat + rep) && !/(?:^|[^\\])&/.test(rep));
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
      if (content === null ? !sedEditSafe(c) : /Permission[R]equest|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i.test(content)) return MSG.answerer;
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
// D-1388 (10/28): the find EXPRESSION is read as logic, not as a list of tests. It passes when every name it can
// print has passed a -name / -iname test that cannot match the key's file name: an ANDed exclusion (-not -path,
// ! -name, -prune with an explicit -print) only narrows the listing, while an -o branch with no such test lists
// everything (that branch was a hole before: `-iname "*.md" -o -type f` passed). Any action but -print / -print0, any
// unknown word and any unbalanced parenthesis fails closed.
const FIND_ARG_TESTS = /^-(?:path|ipath|wholename|iwholename|regex|iregex|regextype|lname|ilname|type|xtype|maxdepth|mindepth|[acm](?:time|min)|newer|newer[acmBt]{2}|size|user|group|uid|gid|perm|links|inum|samefile|fstype|used)$/;
const FIND_BARE_TESTS = /^-(?:true|false|empty|readable|writable|executable|depth|mount|xdev|nouser|nogroup|noleaf|daystart|follow|ignore_readdir_race|noignore_readdir_race|prune|quit)$/;
function findExpr(lits) {
  let i = 0;
  const peek = () => lits[i];
  function primary() {
    const l = lits[i];
    if (l === undefined) throw new Error('end');
    if (l === '(') {
      i += 1;
      const e = orExpr();
      if (lits[i] !== ')') throw new Error('paren');
      i += 1;
      return e;
    }
    if (l === '!' || l === '-not') { i += 1; return { t: 'not', x: primary() }; }
    if (/^-i?name$/.test(l)) {
      const p = lits[i + 1];
      if (p === undefined) throw new Error('name');
      i += 2;
      return { t: 'name', safe: !globRe(p).test('plan.key') };
    }
    if (FIND_ARG_TESTS.test(l)) {
      if (lits[i + 1] === undefined) throw new Error('arg');
      i += 2;
      return { t: 'test' };
    }
    if (FIND_BARE_TESTS.test(l)) { i += 1; return { t: 'test' }; }
    if (l === '-print' || l === '-print0') { i += 1; return { t: 'print' }; }
    throw new Error(`unread ${l}`);
  }
  function andExpr() {
    const xs = [primary()];
    while (i < lits.length && peek() !== ')' && peek() !== '-o' && peek() !== '-or') {
      if (peek() === '-a' || peek() === '-and') i += 1;
      xs.push(primary());
    }
    return xs.length === 1 ? xs[0] : { t: 'and', xs };
  }
  function orExpr() {
    const xs = [andExpr()];
    while (peek() === '-o' || peek() === '-or') { i += 1; xs.push(andExpr()); }
    return xs.length === 1 ? xs[0] : { t: 'or', xs };
  }
  if (!lits.length) return null;
  const e = orExpr();
  if (i !== lits.length) throw new Error('trailing');
  return e;
}
// true when every file that satisfies e has passed a key-proof name test
const findNamed = (e) => (e.t === 'name' ? e.safe : e.t === 'and' ? e.xs.some(findNamed) : e.t === 'or' ? e.xs.every(findNamed) : false);
const findPrints = (e) => e.t === 'print' || ((e.t === 'and' || e.t === 'or') && e.xs.some(findPrints)) || (e.t === 'not' && findPrints(e.x));
// with explicit prints: every -print is reached only through a key-proof name test (guarded)
function findPrintsNamed(e, guarded) {
  if (e.t === 'print') return guarded;
  if (e.t === 'not') return !findPrints(e.x);
  if (e.t === 'or') return e.xs.every((x) => findPrintsNamed(x, guarded));
  if (e.t === 'and') {
    let g = guarded;
    for (const x of e.xs) {
      if (!findPrintsNamed(x, g)) return false;
      g = g || findNamed(x);
    }
    return true;
  }
  return true;
}
function findListsNamesOnly(lits) {
  const start = lits.findIndex((l) => /^-/.test(l) || l === '(' || l === '!' || l === ')');
  if (start < 0) return false;
  let e;
  try { e = findExpr(lits.slice(start)); } catch { return false; }
  if (!e) return false;
  return findPrints(e) ? findPrintsNamed(e, false) : findNamed(e);
}
function extensionFiltered(c, pipe) {
  const downstreamReads = pipe.some((x) => x.pos > c.pos && (PIPE_READERS.has(x.name) || x.fromStdin));
  if (c.name === 'find') {
    const lits = (c.args || []).map(literal);
    if (lits.some((l) => l === null)) return false;
    return findListsNamesOnly(lits) && !downstreamReads;
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
      // 1.11.17 (audit P1, P4): readonly and New-Item/ni set variables too; Environment:: is the env drive
      if (['export', 'declare', 'typeset', 'readonly', 'local', 'set', 'setenv', 'set-item', 'si', 'new-item', 'ni', 'setx'].includes(c.name)) {
        for (const w of c.args || []) {
          const L = literal(w) || text(w);
          const n = L.replace(ENV_DRIVE, '').split(/[=\s]/)[0];
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
    const key = varKey(a.name, c.shell);
    if (a.dynamic || !a.value) { ctx.vars.set(key, null); continue; }
    ctx.vars.set(key, wordValue(a.value, ctx));
  }
  if (c.kind !== 'cmd' || !c.word) return;
  if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(c.name)) {
    for (const w of c.args) {
      const a = SP.splitAssign(w);
      if (a) ctx.vars.set(varKey(a.name, c.shell), wordValue(a.value, ctx));
    }
  }
  if (c.name === 'read') for (const w of c.args) { const L = literal(w); if (L && !/^-/.test(L)) ctx.vars.set(varKey(L, c.shell), null); }
  // An unset variable is unknown again, never its earlier value or the environment's (review 10/23, round 3: after
  // `unset A`, Bash expands $A to nothing, so a path built on it reaches somewhere else).
  if (c.name === 'unset' || c.name === 'remove-variable' || c.name === 'rv') {
    for (const w of c.args) { const L = literal(w); if (L && !/^-/.test(L)) ctx.vars.set(varKey(L, c.shell), null); }
  }
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
    ctx.shell = c.shell; // how this command's variable names are read (varKey)
    if (c.nested.length) {
      const r = judge(c.nested, { here: ctx.here, vars: new Map(ctx.vars) }, env);
      ctx.shell = c.shell;
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
// The Dataverse CLI run by a parsed command, at any depth (H-1081, 10/28). The old rule read the whole line, so a
// Todoist note holding "Memory System (" (read as a shell-out call) and "Dataverse ->" was judged as the CLI with the
// option "-". Now each command is read on its own text: a script run on data (scriptRunsData) and a pure printer or
// searcher hand their arguments to no shell, so their words are data. A shell handed a string, inline code, a heredoc
// into a shell and a command substitution are nested commands, read here too; awk, sed, git and the rest keep the old
// read, since their arguments can run commands.
const PRINTERS = new Set(['echo', 'printf', 'write-output', 'write-host', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'findstr', 'select-string', 'sls']);
function cliRuns(cmds) {
  for (const c of cmds) {
    if (c.nested.length) {
      const v = cliRuns(c.nested);
      if (v) return v;
    }
    if (c.kind === 'cmd' && c.word && (PRINTERS.has(c.name) || scriptRunsData(c))) continue;
    const v = G.cliVerdict(String((c.kind === 'expr' ? c.code : c.src) || '').replace(I.HARMLESS_REDIRECT, ' '));
    if (v) return v;
  }
  return null;
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
  let cmds = null;
  let parseError = null;
  try {
    cmds = SP.parse(textIn, shell);
  } catch (e) {
    parseError = e;
  }
  // per parsed command (H-1081); a line the parser cannot read keeps the whole-text rule
  const cli = cmds ? cliRuns(cmds) : G.cliVerdict(plain);
  if (cli) return `${cli}, which writes to Dataverse`;
  if (I.targetsDataverse(plain, { shell: true })) return MSG.http;
  const inj = I.shellInjection(textIn);
  if (inj) return `keystroke or click injection (approving is the person's alone) [rule: injection; matched: "${inj.token}" in ${inj.where}]`;
  if (/dataverse-write(?:\.js)?["']?\s+(?:apply|resolve)\b/i.test(textIn) && PATH_ON_APPLY.test(textIn)) {
    return 'changing PATH or node options on the same line as an apply (the engine must run the real Dataverse CLI)';
  }
  if (parseError) {
    // a line the parser cannot read: the current whole-text rules decide it (fail closed)
    const old = G.shellVerdict(textIn, cwd);
    return old ? `${old} [parser fallback: ${parseError.message}]` : null;
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
    if (l.value !== null && literalCli(l.value)) return "writing code that calls the Dataverse CLI's write side [rule: cli-literal]";
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

// While an approval waits, the BROWSER tool is free (1.11.15; ruled 10/21, Dylan: "we need to fix that chrome block
// because its really annoying"). It drives Chrome tabs only and cannot reach the terminal where Claude Code asks; 1.11.14
// freed screenshots and zoom, and the same morning a wait and clicks in Paychex and Azure tabs were still stopped by
// another session's prompt (R-1043/1044/1047/1048). Kept: a browser call that names Claude's own site (claude.ai,
// claude.com), where a Remote Control or claude.ai/code approval could be shown. Residual, written down: a click
// carries only a tab number, so a tab ALREADY open on Claude's site is not seen. Desktop mouse/keyboard tools still block.
const CLAUDE_SITE = /(?:^|[^\w.-])(?:[\w-]+\.)*claude\.(?:ai|com)(?![\w-])/i;
const browserTool = (mcp) => !!mcp && mcp.server === 'claude-in-chrome';
const namesClaudeSite = (ti) => {
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(ti);
  return strings.some((s) => CLAUDE_SITE.test(s));
};

function verdict(input, dirs = I.devDirs(), { popup = I.popupOpen } = {}) {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const mcp = I.mcpParts(tool);
  if (mcp && I.DV_SERVER.test(mcp.server)) return I.READ_TOOLS.has(mcp.name) ? null : `the Dataverse tool "${mcp.name}" (only known reads are allowed)`;
  if (mcp && I.DV_WRITE_TOOLS.test(mcp.name)) return `the tool "${mcp.name}" (a Dataverse write outside the approved path)`;
  if (browserTool(mcp)) {
    if (namesClaudeSite(ti) && popup()) return 'opening or driving Claude\'s own site while an approval is waiting (approving is the person\'s alone)';
  } else if (I.SCREEN_TOOL.test(tool) && popup()) return 'driving the screen while an approval is waiting (approving is the person\'s alone)';
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
