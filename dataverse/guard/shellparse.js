'use strict';
// A small shell parser for the Dataverse guard's next decision model (1.11.10; guard_review/DESIGN.md §1c).
//
// The guard used to judge a command line by which STRINGS it contained, and every false positive on record came
// from that (a name as data, shell grammar read as a command, a quoting misread, line-wide coupling). This turns
// a line into SIMPLE COMMANDS so the guard can judge each by its command word, its arguments and its redirects:
//
//   { shell, kind: 'cmd' | 'expr' | 'control', word, args, wrappers, assigns, redirects, heredoc, pipeline, pos,
//     src, code, nested: [commands that run inside it: $( ), backticks, bash -c "...", a heredoc into a shell,
//     a PowerShell script block or subexpression], fromStdin (xargs), depth }
//
// A word keeps its PARTS: literal text (quoted or not), variables, command substitutions, a leading ~, so the
// guard can tell a path it can read from one it cannot. Two tokenizers: POSIX (bash, zsh, Git Bash; and cmd /c
// lines, read with backslashes kept) and PowerShell. Anything it cannot read throws ParseError, and the guard then
// falls back to the old whole-text rules for that line (fail closed, DESIGN.md §1a).

class ParseError extends Error {}

const MAX_DEPTH = 5;
const MAX_LEN = 200000;

// ---------- words ----------

function word(parts, raw, start, end) {
  return { type: 'word', parts, raw, start, end };
}

// The word's text if every part is literal (a leading ~ reads as "~"), else null.
function literal(w) {
  if (!w || !w.parts) return null;
  let s = '';
  for (const p of w.parts) {
    if (p.t === 'lit') s += p.v;
    else if (p.t === 'tilde') s += '~';
    else return null;
  }
  return s;
}

// Text for display and loose matching: variables as $NAME, substitutions as $(...).
function text(w) {
  if (!w || !w.parts) return '';
  return w.parts.map((p) => (p.t === 'lit' ? p.v : p.t === 'tilde' ? '~' : p.t === 'var' ? `$${p.name}` : p.t === 'sub' ? '$(...)' : '$?')).join('');
}

// An unquoted * ? or [ makes a word a pattern.
function isGlob(w) {
  return !!(w && w.parts && w.parts.some((p) => p.t === 'lit' && !p.q && /[*?[]/.test(p.v)));
}

// ---------- POSIX ----------

const OPS_POSIX = ['&&', '||', ';;&', ';;', ';&', '|&', '&>>', '&>', '>>', '>|', '>&', '<<<', '<<-', '<<', '<&', '<>', '>', '<', '|', '&', ';', '(', ')'];
const TERM = new Set([' ', '\t', '\r', '\n', '|', '&', ';', '<', '>', '(', ')']);

function matchParen(src, i) {
  // i: just after an opening "(". Returns the index of the matching ")".
  let depth = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) throw new ParseError('unterminated quote in ( )');
      i = e + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') j += 1;
        else if (src[j] === '$' && src[j + 1] === '(') j = matchParen(src, j + 2);
        j += 1;
      }
      if (j >= n) throw new ParseError('unterminated quote in ( )');
      i = j + 1;
      continue;
    }
    if (c === '`') { i = findBacktick(src, i + 1) + 1; continue; }
    if (c === '#' && (i === 0 || /\s/.test(src[i - 1]))) {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new ParseError('unterminated (');
}

function matchBrace(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new ParseError('unterminated ${');
}

function findBacktick(src, i) {
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i;
    i += 1;
  }
  throw new ParseError('unterminated backtick');
}

function ansiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (m, e) => {
    if (/^x/.test(e) || /^u/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' }[e] ?? `\\${e}`;
  });
}

function lexDollar(src, i, parts, lit, quoted) {
  const d = src[i + 1];
  if (d === '(' && src[i + 2] === '(') {
    const e = matchParen(src, i + 2);
    parts.push({ t: 'arith' });
    return e + 1;
  }
  if (d === '(') {
    const e = matchParen(src, i + 2);
    parts.push({ t: 'sub', src: src.slice(i + 2, e) });
    return e + 1;
  }
  if (d === '{') {
    const e = matchBrace(src, i + 2);
    const inner = src.slice(i + 2, e);
    const m = /^([A-Za-z_]\w*|\d+|[@*#?$!-])([\s\S]*)$/.exec(inner);
    parts.push({ t: 'var', name: m ? m[1] : inner, op: m ? m[2] : '?' });
    // ${x:-$(cmd)} runs cmd
    const op = m ? m[2] : '';
    let k = op.indexOf('$(');
    while (k >= 0) {
      const end = matchParen(op, k + 2);
      parts.push({ t: 'sub', src: op.slice(k + 2, end) });
      k = op.indexOf('$(', end);
    }
    return e + 1;
  }
  const m = /^[A-Za-z_]\w*/.exec(src.slice(i + 1, i + 200));
  if (m) {
    parts.push({ t: 'var', name: m[0] });
    return i + 1 + m[0].length;
  }
  if (d && /[0-9@*#?$!-]/.test(d)) {
    parts.push({ t: 'var', name: d });
    return i + 2;
  }
  lit('$', quoted);
  return i + 1;
}

function lexWordPosix(src, i, opts) {
  const start = i;
  const n = src.length;
  const parts = [];
  const lit = (v, q) => {
    const last = parts[parts.length - 1];
    if (last && last.t === 'lit' && last.q === q) last.v += v;
    else parts.push({ t: 'lit', v, q });
  };
  while (i < n) {
    const c = src[i];
    if (TERM.has(c)) {
      // NAME=( a b c ): an array assignment
      if (c === '(' && parts.length === 1 && parts[0].t === 'lit' && !parts[0].q && /^[A-Za-z_]\w*\+?=$/.test(parts[0].v)) {
        const e = matchParen(src, i + 1);
        parts.push({ t: 'arr', src: src.slice(i + 1, e) });
        i = e + 1;
        continue;
      }
      break;
    }
    if (c === '\\' && !opts.backslashLiteral) {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < n) { lit(src[i + 1], true); i += 2; continue; }
      lit('\\', false);
      i += 1;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) throw new ParseError('unterminated single quote');
      lit(src.slice(i + 1, e), true);
      i = e + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      let j = i + 2;
      while (j < n && src[j] !== "'") { if (src[j] === '\\') j += 1; j += 1; }
      if (j >= n) throw new ParseError('unterminated $\'');
      lit(ansiC(src.slice(i + 2, j)), true);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      let closed = false;
      while (i < n) {
        const d = src[i];
        if (d === '"') { i += 1; closed = true; break; }
        if (d === '\\' && !opts.backslashLiteral && i + 1 < n && '$`"\\\n'.includes(src[i + 1])) {
          if (src[i + 1] !== '\n') lit(src[i + 1], true);
          i += 2;
          continue;
        }
        if (d === '`') {
          const e = findBacktick(src, i + 1);
          parts.push({ t: 'sub', src: src.slice(i + 1, e).replace(/\\([`$\\])/g, '$1') });
          i = e + 1;
          continue;
        }
        if (d === '$') { i = lexDollar(src, i, parts, lit, true); continue; }
        lit(d, true);
        i += 1;
      }
      if (!closed) throw new ParseError('unterminated double quote');
      continue;
    }
    if (c === '`') {
      const e = findBacktick(src, i + 1);
      parts.push({ t: 'sub', src: src.slice(i + 1, e).replace(/\\([`$\\])/g, '$1') });
      i = e + 1;
      continue;
    }
    if (c === '$') { i = lexDollar(src, i, parts, lit, false); continue; }
    if (c === '~' && parts.length === 0 && (i + 1 >= n || src[i + 1] === '/' || src[i + 1] === '\\' || TERM.has(src[i + 1]))) {
      parts.push({ t: 'tilde' });
      i += 1;
      continue;
    }
    lit(c, false);
    i += 1;
  }
  return { w: word(parts, src.slice(start, i), start, i), end: i };
}

function readHeredocs(src, i, pending) {
  const n = src.length;
  for (const p of pending) {
    const lines = [];
    let done = false;
    while (i < n) {
      let e = src.indexOf('\n', i);
      if (e < 0) e = n;
      const line = src.slice(i, e).replace(/\r$/, '');
      i = e + 1;
      if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) { done = true; break; }
      lines.push(line);
    }
    p.tok.heredoc = { body: lines.join('\n'), quoted: p.quoted, delim: p.delim, unterminated: !done };
  }
  pending.length = 0;
  return Math.min(i, n);
}

function lexPosix(src, opts = {}) {
  const tokens = [];
  const n = src.length;
  const pending = [];
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '\\' && src[i + 1] === '\n' && !opts.backslashLiteral) { i += 2; continue; }
    if (c === '\\' && src[i + 1] === '\r' && src[i + 2] === '\n' && !opts.backslashLiteral) { i += 3; continue; }
    if (c === '\n') {
      tokens.push({ type: 'op', v: '\n', start: i, end: i + 1 });
      i += 1;
      if (pending.length) i = readHeredocs(src, i, pending);
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const e = matchParen(src, i + 2);
      tokens.push(word([{ t: 'sub', src: src.slice(i + 2, e), proc: c }], src.slice(i, e + 1), i, e + 1));
      i = e + 1;
      continue;
    }
    const op = OPS_POSIX.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ type: 'op', v: op, start: i, end: i + op.length });
      i += op.length;
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i += 1;
        const { w, end } = lexWordPosix(src, i, opts);
        tokens.push(w);
        i = end;
        const delim = w.parts.map((p) => (p.t === 'lit' ? p.v : p.t === 'tilde' ? '~' : '')).join('');
        pending.push({ tok: w, delim, quoted: w.parts.some((p) => p.t === 'lit' && p.q), strip: op === '<<-' });
      }
      continue;
    }
    const { w, end } = lexWordPosix(src, i, opts);
    tokens.push(w);
    i = end;
  }
  for (const p of pending) p.tok.heredoc = { body: '', quoted: p.quoted, delim: p.delim, unterminated: true };
  return tokens;
}

const SKIP_AT_START = new Set(['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time', 'esac', 'coproc']);
const REDIRECT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<', '<>', '>&', '<&', '<<<']);
const ASSIGN = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?(\+?=)/;

function newCmd(shell, pipeline, pos, depth) {
  return { shell, kind: 'cmd', words: [], assigns: [], redirects: [], heredoc: null, pipeline, pos, depth, nested: [], subs: [], first: null, last: null };
}

// NAME=value as an assignment record (the value is the rest of the word).
function splitAssign(tok) {
  const p0 = tok.parts[0];
  if (!p0 || p0.t !== 'lit' || p0.q) return null;
  const m = ASSIGN.exec(p0.v);
  if (!m) return null;
  const rest = p0.v.slice(m[0].length);
  const parts = [...(rest ? [{ t: 'lit', v: rest, q: false }] : []), ...tok.parts.slice(1)];
  return { name: m[1], value: word(parts, tok.raw.slice(tok.raw.indexOf('=') + 1), tok.start, tok.end) };
}

function buildPosix(tokens, src, depth) {
  const out = [];
  let pipeline = 0;
  let pos = 0;
  let cur = newCmd('posix', pipeline, pos, depth);
  let mode = null; // 'dbl' [[ ]], 'casePat', 'caseHead', 'forVar', 'forHeader'
  let caseDepth = 0;
  const touch = (t) => {
    if (cur.first === null) cur.first = t.start;
    cur.last = t.end;
  };
  const subsOf = (t) => { for (const p of t.parts || []) if (p.t === 'sub' || p.t === 'arr') cur.subs.push(p.src); };
  const finish = () => {
    if (cur.words.length || cur.assigns.length || cur.redirects.length || cur.subs.length || cur.control) {
      cur.src = cur.first === null ? '' : src.slice(cur.first, cur.last);
      out.push(cur);
    }
    cur = newCmd('posix', pipeline, pos, depth);
  };
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (mode === 'dbl') {
      if (t.type === 'word') { subsOf(t); touch(t); if (literal(t) === ']]') mode = null; }
      continue;
    }
    if (t.type === 'op') {
      const v = t.v;
      if (v === '|' || v === '|&') {
        if (mode === 'casePat') continue;
        finish();
        pos += 1;
        cur.pos = pos;
        continue;
      }
      if (v === '\n' || v === ';' || v === '&' || v === '&&' || v === '||') {
        if (mode === 'casePat' && v === '\n') continue;
        if (mode === 'forVar' || mode === 'forHeader') mode = null;
        finish();
        pipeline += 1;
        pos = 0;
        cur.pipeline = pipeline;
        cur.pos = 0;
        continue;
      }
      if (v === ';;' || v === ';&' || v === ';;&') {
        finish();
        pipeline += 1;
        pos = 0;
        cur.pipeline = pipeline;
        cur.pos = 0;
        if (caseDepth) mode = 'casePat';
        continue;
      }
      if (v === '(') {
        if (mode === 'casePat' || mode === 'forVar' || mode === 'forHeader') continue;
        // name() { ... }: a function definition
        if (cur.words.length === 1 && tokens[k + 1] && tokens[k + 1].type === 'op' && tokens[k + 1].v === ')') {
          cur.words = [];
          cur.first = null;
          k += 1;
          continue;
        }
        finish();
        continue;
      }
      if (v === ')') {
        if (mode === 'casePat') { mode = null; continue; }
        finish();
        continue;
      }
      if (REDIRECT_OPS.has(v)) {
        let fd = null;
        const prev = cur.words[cur.words.length - 1];
        if (prev && /^\d+$/.test(literal(prev) || '') && prev.end === t.start) {
          fd = cur.words.pop().raw;
        }
        const next = tokens[k + 1];
        let target = null;
        if (next && next.type === 'word') {
          target = next;
          k += 1;
          subsOf(next);
          touch(next);
        }
        touch(t);
        cur.redirects.push({ op: v, fd, target });
        continue;
      }
      if (v === '<<' || v === '<<-') {
        const next = tokens[k + 1];
        touch(t);
        if (next && next.type === 'word') {
          k += 1;
          touch(next);
          cur.heredoc = next.heredoc || { body: '', quoted: true };
          if (!cur.heredoc.quoted) {
            // an unquoted heredoc body is expanded: a $( ) or backtick in it runs
            try {
              const lw = lexWordPosix(`"${cur.heredoc.body.replace(/(["\\])/g, '\\$1')}"`, 0, {});
              for (const p of lw.w.parts) if (p.t === 'sub') cur.subs.push(p.src);
            } catch { cur.subs.push(cur.heredoc.body); }
          }
        }
        continue;
      }
      continue;
    }
    // a word
    const L = literal(t);
    subsOf(t);
    if (mode === 'casePat') {
      if (L === 'esac') { caseDepth -= 1; mode = null; }
      continue;
    }
    if (mode === 'caseHead') {
      if (L === 'in') mode = 'casePat';
      continue;
    }
    if (mode === 'forVar') {
      cur.control = 'for';
      cur.assigns.push({ name: L || '?', value: null, dynamic: true, shellVar: true });
      touch(t);
      mode = 'forHeader';
      continue;
    }
    if (mode === 'forHeader') {
      if (L === 'do') { finish(); mode = null; }
      continue;
    }
    if (!cur.words.length) {
      if (!cur.assigns.length && L !== null && SKIP_AT_START.has(L)) continue;
      if (!cur.assigns.length && (L === 'for' || L === 'select')) { mode = 'forVar'; continue; }
      if (!cur.assigns.length && L === 'case') { caseDepth += 1; mode = 'caseHead'; continue; }
      if (!cur.assigns.length && L === '[[') { mode = 'dbl'; touch(t); continue; }
      if (!cur.assigns.length && L === 'function') { k += 1; continue; }
      const a = splitAssign(t);
      if (a) {
        cur.assigns.push(a);
        touch(t);
        continue;
      }
    }
    cur.words.push(t);
    touch(t);
  }
  finish();
  return out;
}

// ---------- PowerShell ----------

const PS_KEYWORDS = new Set(['if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'until', 'switch', 'function', 'filter', 'try', 'catch', 'finally', 'trap', 'param', 'begin', 'process', 'end', 'return', 'throw', 'exit', 'break', 'continue', 'data', 'class', 'enum', 'using', 'dynamicparam', 'workflow', 'parallel', 'sequence', 'inlinescript']);

// i: just after an opener; `close` is ")" "}" or "]". Skips PowerShell strings, here-strings and comments.
function psMatch(src, i, close) {
  const open = { ')': '(', '}': '{', ']': '[' }[close];
  let depth = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '`') { i += 2; continue; }
    if (c === '@' && (src[i + 1] === '"' || src[i + 1] === "'") && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
      const q = src[i + 1];
      const e = src.indexOf(`\n${q}@`, i + 2);
      if (e < 0) throw new ParseError('unterminated here-string');
      i = e + 3;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) { if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; } if (src[j] === "'") break; j += 1; }
      if (j >= n) throw new ParseError('unterminated quote');
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '`') { j += 2; continue; }
        if (src[j] === '"' && src[j + 1] === '"') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') { j = psMatch(src, j + 2, ')') + 1; continue; }
        if (src[j] === '"') break;
        j += 1;
      }
      if (j >= n) throw new ParseError('unterminated quote');
      i = j + 1;
      continue;
    }
    if (c === '<' && src[i + 1] === '#') {
      const e = src.indexOf('#>', i + 2);
      if (e < 0) throw new ParseError('unterminated comment');
      i = e + 2;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;({]/.test(src[i - 1]))) {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new ParseError(`unterminated ${open}`);
}

const PS_TERM = new Set([' ', '\t', '\r', '\n', ';', '|', '(', ')', '{', '}', '>']);
const PS_ESC = { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' };

function psVar(src, i, parts) {
  // src[i] === '$'
  const d = src[i + 1];
  if (d === '(') {
    const e = psMatch(src, i + 2, ')');
    parts.push({ t: 'sub', src: src.slice(i + 2, e), ps: true });
    return e + 1;
  }
  if (d === '{') {
    const e = src.indexOf('}', i + 2);
    if (e < 0) throw new ParseError('unterminated ${');
    parts.push({ t: 'var', name: src.slice(i + 2, e) });
    return e + 1;
  }
  const m = /^(?:(?:env|global|script|local|private|using|variable):)?[A-Za-z_][\w]*|^[_?$^]/i.exec(src.slice(i + 1, i + 200));
  if (m) {
    parts.push({ t: 'var', name: m[0] });
    let j = i + 1 + m[0].length;
    // member access or indexing: still dynamic
    while (src[j] === '.' && /[A-Za-z_]/.test(src[j + 1] || '')) {
      const mm = /^\.[A-Za-z_]\w*/.exec(src.slice(j));
      parts.push({ t: 'member', v: mm[0] });
      j += mm[0].length;
    }
    return j;
  }
  parts.push({ t: 'lit', v: '$', q: false });
  return i + 1;
}

function lexWordPs(src, i) {
  const start = i;
  const n = src.length;
  const parts = [];
  const lit = (v, q) => {
    const last = parts[parts.length - 1];
    if (last && last.t === 'lit' && last.q === q) last.v += v;
    else parts.push({ t: 'lit', v, q });
  };
  while (i < n) {
    const c = src[i];
    if (PS_TERM.has(c)) break;
    if (c === '&' && parts.length) break;
    if (c === '`') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < n) { lit(src[i + 1], true); i += 2; continue; }
      i += 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v = '';
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { v += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        v += src[j];
        j += 1;
      }
      if (j >= n) throw new ParseError('unterminated single quote');
      lit(v, true);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '`') { lit(PS_ESC[src[j + 1]] ?? src[j + 1] ?? '', true); j += 2; continue; }
        if (d === '"' && src[j + 1] === '"') { lit('"', true); j += 2; continue; }
        if (d === '"') { closed = true; j += 1; break; }
        if (d === '$' && src[j + 1] && /[\w({:?_$^]/.test(src[j + 1])) { j = psVar(src, j, parts); continue; }
        lit(d, true);
        j += 1;
      }
      if (!closed) throw new ParseError('unterminated double quote');
      i = j;
      continue;
    }
    if (c === '$' && src[i + 1] && /[\w({:?_$^]/.test(src[i + 1])) { i = psVar(src, i, parts); continue; }
    if (c === '@' && (src[i + 1] === '(' || src[i + 1] === '{')) {
      const e = psMatch(src, i + 2, src[i + 1] === '(' ? ')' : '}');
      parts.push({ t: 'sub', src: src.slice(i + 2, e), ps: true, hash: src[i + 1] === '{' });
      i = e + 1;
      continue;
    }
    if (c === '[' && /^\[[\w.,`\[\] ]+\]/.test(src.slice(i, i + 200)) && (parts.length === 0)) {
      // a type literal: [IO.File], [System.Environment]
      const e = psMatch(src, i + 1, ']');
      lit(src.slice(i, e + 1), false);
      i = e + 1;
      continue;
    }
    if (c === '~' && parts.length === 0 && (i + 1 >= n || /[\\/\s]/.test(src[i + 1]))) {
      parts.push({ t: 'tilde' });
      i += 1;
      continue;
    }
    lit(c, false);
    i += 1;
  }
  return { w: word(parts, src.slice(start, i), start, i), end: i };
}

function lexPs(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '`' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) { i += src[i + 1] === '\n' ? 2 : 3; continue; }
    if (c === '\n' || c === ';') { tokens.push({ type: 'op', v: c === ';' ? ';' : '\n', start: i, end: i + 1 }); i += 1; continue; }
    if (c === '<' && src[i + 1] === '#') {
      const e = src.indexOf('#>', i + 2);
      if (e < 0) throw new ParseError('unterminated comment');
      i = e + 2;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '@' && (src[i + 1] === '"' || src[i + 1] === "'") && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
      const q = src[i + 1];
      const bodyStart = src.indexOf('\n', i) + 1;
      const e = src.indexOf(`\n${q}@`, i + 2);
      if (e < 0) throw new ParseError('unterminated here-string');
      const body = src.slice(bodyStart, e).replace(/\r$/, '');
      const parts = [{ t: 'lit', v: body, q: true, here: true }];
      if (q === '"') {
        let k = body.indexOf('$(');
        while (k >= 0) {
          const end = psMatch(body, k + 2, ')');
          parts.push({ t: 'sub', src: body.slice(k + 2, end), ps: true });
          k = body.indexOf('$(', end);
        }
      }
      tokens.push(word(parts, src.slice(i, e + 3), i, e + 3));
      i = e + 3;
      continue;
    }
    if (src.startsWith('&&', i) || src.startsWith('||', i)) { tokens.push({ type: 'op', v: src.slice(i, i + 2), start: i, end: i + 2 }); i += 2; continue; }
    if (c === '|') { tokens.push({ type: 'op', v: '|', start: i, end: i + 1 }); i += 1; continue; }
    if (c === '&') { tokens.push({ type: 'op', v: '&', start: i, end: i + 1 }); i += 1; continue; }
    // redirects: >, >>, 2>, 2>>, *>, 2>&1
    const r = /^(?:([1-6*])?(>>?)(?:&([12]))?)/.exec(src.slice(i, i + 5));
    if (r && r[0] && (c === '>' || ((/[1-6*]/.test(c)) && /^[1-6*]>/.test(src.slice(i, i + 2)) && (i === 0 || /[\s;|]/.test(src[i - 1]))))) {
      tokens.push({ type: 'op', v: r[2], fd: r[1] || null, dup: r[3] || null, start: i, end: i + r[0].length });
      i += r[0].length;
      continue;
    }
    if (c === '(') {
      const e = psMatch(src, i + 1, ')');
      tokens.push({ type: 'group', src: src.slice(i + 1, e), start: i, end: e + 1 });
      i = e + 1;
      continue;
    }
    if (c === '{') {
      const e = psMatch(src, i + 1, '}');
      tokens.push({ type: 'block', src: src.slice(i + 1, e), start: i, end: e + 1 });
      i = e + 1;
      continue;
    }
    if (c === ')' || c === '}') throw new ParseError(`unbalanced ${c}`);
    const { w, end } = lexWordPs(src, i);
    if (end === i) throw new ParseError(`cannot read at ${i}`);
    tokens.push(w);
    i = end;
  }
  return tokens;
}

const PS_ASSIGN = /^\s*(?:\[[^\]]+\]\s*)*\$(\{[^}]+\}|(?:env|global|script|local|private):?[\w]+|[\w]+)(?:\.[\w.]+|\[[^\]]*\])*\s*([+\-*/%]?=|\?\?=)(?!=)/i;

function buildPs(tokens, src, depth) {
  const out = [];
  let pipeline = 0;
  let pos = 0;
  let el = [];
  const flush = () => {
    if (el.length) out.push(psElement(el, src, depth, pipeline, pos));
    el = [];
  };
  for (const t of tokens) {
    if (t.type === 'op' && (t.v === '\n' || t.v === ';' || t.v === '&&' || t.v === '||')) {
      flush();
      pipeline += 1;
      pos = 0;
      continue;
    }
    if (t.type === 'op' && t.v === '|') {
      flush();
      pos += 1;
      continue;
    }
    if (t.type === 'op' && t.v === '&' && el.length) {
      // background job at the end of a pipeline
      flush();
      pipeline += 1;
      pos = 0;
      continue;
    }
    el.push(t);
  }
  flush();
  return out;
}

function psElement(allToks, src, depth, pipeline, pos) {
  // Redirects first: an expression writes a file as surely as a command does ('x' > file).
  const redirects = [];
  const toks = [];
  for (let j = 0; j < allToks.length; j += 1) {
    const t = allToks[j];
    if (t.type === 'op' && (t.v === '>' || t.v === '>>')) {
      if (t.dup) { redirects.push({ op: '>&', fd: t.fd, target: null, dup: t.dup }); continue; }
      const next = allToks[j + 1];
      let target = null;
      if (next && next.type === 'word') { target = next; j += 1; }
      redirects.push({ op: t.v, fd: t.fd, target });
      continue;
    }
    toks.push(t);
  }
  if (!toks.length) toks.push(...allToks.slice(0, 1));
  const cmd0 = psElementBody(toks, src, depth, pipeline, pos, allToks);
  cmd0.redirects.push(...redirects);
  return cmd0;
}

function psElementBody(toks, src, depth, pipeline, pos, allToks) {
  const first = toks[0];
  const start = allToks[0].start;
  const end = allToks[allToks.length - 1].end;
  const esrc = src.slice(start, end);
  const cmd = { shell: 'ps', kind: 'cmd', words: [], assigns: [], redirects: [], heredoc: null, pipeline, pos, depth, nested: [], subs: [], psSubs: [], src: esrc };
  const subsOf = (t) => {
    if (t.type === 'group' || t.type === 'block') cmd.psSubs.push(t.src);
    for (const p of t.parts || []) if (p.t === 'sub') cmd.psSubs.push(p.src);
  };
  for (const t of toks) subsOf(t);
  const L = first.type === 'word' ? literal(first) : null;
  const lower = L === null ? null : L.toLowerCase();
  // An assignment: $x = <pipeline>, $env:X = ..., [type]$x = ...
  const am = pos === 0 ? PS_ASSIGN.exec(esrc) : null;
  if (am) {
    const name = am[1].replace(/^\{|\}$/g, '');
    const rhs = esrc.slice(am[0].length);
    cmd.kind = 'control';
    // The value when it is one plain word or string ($src = 'C:\x'), so a later "$src\file" can be read.
    let value = null;
    try {
      const rt = lexPs(rhs.trim());
      if (rt.length === 1 && rt[0].type === 'word') value = rt[0];
    } catch { /* stays unknown */ }
    cmd.assigns.push({ name, op: am[2], rhsSrc: rhs, value, dynamic: !value || am[2] !== '=', ps: true, env: /^env:/i.test(name), shellVar: !/^env:/i.test(name) });
    cmd.psSubs.push(rhs);
    return cmd;
  }
  if (lower !== null && PS_KEYWORDS.has(lower) && first.parts.every((p) => !p.q)) {
    cmd.kind = 'control';
    cmd.control = lower;
    if (['return', 'throw', 'exit'].includes(lower)) cmd.psSubs.push(src.slice(toks[1] ? toks[1].start : end, end));
    if (lower === 'foreach' && toks[1] && toks[1].type === 'group') {
      const m = /^\s*\$(\w+)\s+in\b/i.exec(toks[1].src);
      if (m) cmd.assigns.push({ name: m[1], dynamic: true, shellVar: true, ps: true });
    }
    return cmd;
  }
  let k = 0;
  // & <command> / . <script>: the call and dot-source operators
  if (first.type === 'op' && first.v === '&') k = 1;
  else if (L === '.' && toks.length > 1) k = 1;
  const w = toks[k];
  const isCommand = w && w.type === 'word' && (k === 1 || (w.parts[0] && (w.parts[0].t === 'lit' && !w.parts[0].q && !/^[\d[@"'(]/.test(w.parts[0].v)) && w.parts[0].t !== 'var' && w.parts[0].t !== 'sub'));
  if (!isCommand) {
    cmd.kind = 'expr';
    cmd.code = esrc;
    return cmd;
  }
  cmd.callOp = k === 1;
  for (let j = k; j < toks.length; j += 1) {
    const t = toks[j];
    if (t.type === 'op' && (t.v === '>' || t.v === '>>')) {
      if (t.dup) { cmd.redirects.push({ op: '>&', fd: t.fd, target: null, dup: t.dup }); continue; }
      const next = toks[j + 1];
      let target = null;
      if (next && next.type === 'word') { target = next; j += 1; }
      cmd.redirects.push({ op: t.v, fd: t.fd, target });
      continue;
    }
    if (t.type === 'word') cmd.words.push(t);
    else if (t.type === 'group' || t.type === 'block') cmd.words.push({ type: 'word', parts: [{ t: 'sub', src: t.src, ps: true, block: t.type === 'block' }], raw: src.slice(t.start, t.end), start: t.start, end: t.end });
  }
  return cmd;
}

// ---------- wrappers and nesting ----------

const WRAPPERS = new Set(['time', 'env', 'sudo', 'doas', 'nice', 'ionice', 'nohup', 'command', 'builtin', 'exec', 'xargs', 'npx', 'bunx', 'pnpx', 'call', 'start',
  'timeout', 'gtimeout', 'caffeinate', 'stdbuf', 'watch', 'retry', 'chronic', 'unbuffer', 'setsid', 'unshare', 'chroot', 'runuser', 'su', 'flock', 'parallel']);
const WRAPPER_VALUE_OPTS = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p']),
  xargs: new Set(['-I', '-n', '-L', '-P', '-d', '-a', '-E', '-s', '--max-args', '--max-procs', '--delimiter', '--arg-file', '-i']),
  timeout: new Set(['-k', '-s', '--signal', '--kill-after']),
  gtimeout: new Set(['-k', '-s']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  stdbuf: new Set(['-i', '-o', '-e']),
  watch: new Set(['-n', '-d']),
  flock: new Set(['-w', '-E']),
  parallel: new Set(['-j', '-N', '--jobs']),
  su: new Set(['-c', '-s', '-g']),
  runuser: new Set(['-u', '-g']),
};
const baseName = (s) => String(s || '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|com)$/i, '').toLowerCase();

// Steps past wrappers to the real command word; NAME=value after env/sudo is an assignment.
function resolveWord(cmd) {
  const words = cmd.words;
  cmd.wrappers = [];
  let i = 0;
  for (;;) {
    if (i >= words.length) break;
    const L = literal(words[i]);
    const b = baseName(L);
    if (L !== null && i > 0 && cmd.wrappers.length && /^[A-Za-z_]\w*=/.test(L) && ['env', 'sudo', 'doas'].includes(cmd.wrappers[cmd.wrappers.length - 1])) {
      // env "HOME=/x" cmd: env sees the word after the shell removed the quotes, so a quoted one counts too
      const a = splitAssign(words[i]) || { name: L.slice(0, L.indexOf('=')), value: word([{ t: 'lit', v: L.slice(L.indexOf('=') + 1), q: true }], L, words[i].start, words[i].end) };
      a.env = true;
      cmd.assigns.push(a);
      i += 1;
      continue;
    }
    const isNpmExec = ['npm', 'pnpm', 'yarn'].includes(b) && ['exec', 'dlx', 'x'].includes((literal(words[i + 1]) || '').toLowerCase());
    if (L === null || (!WRAPPERS.has(b) && !isNpmExec)) break;
    if (b === 'command' && /^-[vV]$/.test(literal(words[i + 1]) || '')) break;
    if (b === 'su') {
      // su -c "<line>": handed to a shell
      cmd.wrappers.push(b);
      break;
    }
    cmd.wrappers.push(b);
    if (b === 'xargs' || b === 'parallel') cmd.fromStdin = true;
    i += isNpmExec ? 2 : 1;
    const valueOpts = WRAPPER_VALUE_OPTS[b] || new Set();
    while (i < words.length) {
      const w = literal(words[i]);
      if (w === null) break;
      if (w === '--') { i += 1; break; }
      if (/^-/.test(w)) {
        if (valueOpts.has(w)) i += 2;
        else i += 1;
        continue;
      }
      if ((b === 'timeout' || b === 'gtimeout') && /^\d+(?:\.\d+)?[smhd]?$/.test(w)) { i += 1; continue; }
      if (b === 'start' && w === '') { i += 1; continue; }
      break;
    }
  }
  cmd.wordIndex = i;
  cmd.word = words[i] || null;
  cmd.args = words.slice(i + 1);
  cmd.name = cmd.word ? baseName(literal(cmd.word) ?? text(cmd.word)) : null;
  return cmd;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh', 'busybox']);
const PS_SHELLS = new Set(['powershell', 'pwsh', 'powershell_ise']);

function handedStrings(cmd) {
  // [{ shell: 'posix'|'ps'|'cmd', src }]
  const out = [];
  const name = cmd.name;
  const args = cmd.args || [];
  const lits = args.map(literal);
  if (cmd.wrappers && cmd.wrappers.includes('su')) {
    const i = (cmd.words || []).findIndex((w) => literal(w) === '-c');
    if (i >= 0 && cmd.words[i + 1]) out.push({ shell: 'posix', src: literal(cmd.words[i + 1]) ?? text(cmd.words[i + 1]) });
  }
  if (!name) return out;
  if (SHELLS.has(name)) {
    const i = lits.findIndex((l) => l !== null && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(l));
    if (i >= 0 && args[i + 1]) out.push({ shell: 'posix', src: literal(args[i + 1]) ?? text(args[i + 1]) });
  } else if (PS_SHELLS.has(name)) {
    const i = lits.findIndex((l) => l !== null && /^-(?:c|com|comm|comma|comman|command)$/i.test(l));
    if (i >= 0) out.push({ shell: 'ps', src: args.slice(i + 1).map((w) => literal(w) ?? text(w)).join(' ') });
    const e = lits.findIndex((l) => l !== null && /^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedcommand)$/i.test(l));
    if (e >= 0 && args[e + 1]) {
      try { out.push({ shell: 'ps', src: Buffer.from(literal(args[e + 1]) || '', 'base64').toString('utf16le'), encoded: true }); } catch { /* unreadable */ }
    }
    // powershell "<command>" with no -Command: the rest is the command
    if (i < 0 && e < 0 && args.length && lits[0] !== null && !/^-/.test(lits[0]) && !/\.ps1$/i.test(lits[0])) {
      out.push({ shell: 'ps', src: args.map((w) => literal(w) ?? text(w)).join(' ') });
    }
  } else if (name === 'cmd') {
    const i = lits.findIndex((l) => l !== null && /^\/[ckCK]$/.test(l));
    if (i >= 0) out.push({ shell: 'cmd', src: args.slice(i + 1).map((w) => w.raw).join(' ') });
  } else if (name === 'eval') {
    out.push({ shell: cmd.shell === 'ps' ? 'ps' : 'posix', src: args.map((w) => literal(w) ?? text(w)).join(' ') });
  } else if (name === 'invoke-expression' || name === 'iex') {
    out.push({ shell: 'ps', src: args.filter((w, k) => !/^-/.test(lits[k] || '')).map((w) => literal(w) ?? text(w)).join(' ') });
  } else if (name === 'find') {
    // find ... -exec <command> {} \; : the command it runs
    for (let k = 0; k < lits.length; k += 1) {
      if (/^-(?:exec|execdir|ok|okdir)$/.test(lits[k] || '')) {
        const rest = [];
        for (let j = k + 1; j < args.length; j += 1) {
          const l = lits[j];
          if (l === ';' || l === '+') break;
          rest.push(args[j].raw);
        }
        if (rest.length) out.push({ shell: 'posix', src: rest.join(' '), fromFind: true });
      }
    }
  }
  // env -S "<line>"
  if (cmd.wrappers && cmd.wrappers.includes('env')) {
    const i = (cmd.words || []).findIndex((w) => /^-S$|^--split-string$/.test(literal(w) || ''));
    if (i >= 0 && cmd.words[i + 1]) out.push({ shell: 'posix', src: literal(cmd.words[i + 1]) ?? text(cmd.words[i + 1]) });
  }
  return out;
}

// ---------- the entry point ----------

function parse(src, shell = 'posix', depth = 0, opts = {}) {
  if (typeof src !== 'string') throw new ParseError('not text');
  if (src.length > MAX_LEN) throw new ParseError('too long to read');
  if (depth > MAX_DEPTH) throw new ParseError('nested too deep');
  let cmds;
  if (shell === 'ps') cmds = buildPs(lexPs(src), src, depth);
  else cmds = buildPosix(lexPosix(src, { backslashLiteral: shell === 'cmd' }), src, depth);
  for (const c of cmds) {
    if (shell === 'cmd') c.shell = 'cmd';
    if (c.kind === 'cmd') resolveWord(c);
    for (const s of c.subs || []) c.nested.push(...parse(s, shell === 'cmd' ? 'posix' : shell, depth + 1));
    for (const s of c.psSubs || []) c.nested.push(...parse(s, 'ps', depth + 1));
    if (c.kind === 'cmd') {
      for (const h of handedStrings(c)) {
        const nested = parse(h.src, h.shell, depth + 1);
        for (const x of nested) { x.handed = true; if (h.fromFind) x.fromFind = true; }
        c.nested.push(...nested);
      }
      // a heredoc fed to a shell is commands, not data
      if (c.heredoc && SHELLS.has(c.name || '') && !c.args.some((w) => !/^-/.test(literal(w) || '-'))) {
        const nested = parse(c.heredoc.body, 'posix', depth + 1);
        for (const x of nested) x.handed = true;
        c.nested.push(...nested);
      }
      if (c.heredoc && PS_SHELLS.has(c.name || '')) {
        const nested = parse(c.heredoc.body, 'ps', depth + 1);
        for (const x of nested) x.handed = true;
        c.nested.push(...nested);
      }
    }
  }
  return cmds;
}

module.exports = { parse, ParseError, literal, text, isGlob, baseName, SHELLS, PS_SHELLS, splitAssign };
