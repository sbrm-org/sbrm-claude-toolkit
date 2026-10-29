'use strict';
// The guard's NEXT decision model (guard/guard_next.js, 1.11.10 in shadow; guard_review/DESIGN.md + GATE_2.md).
//   1. parity: every case of guard.js's self-test and of guard_false_positives.test.js decides the same, except the
//      flips the design names (each listed below with its group);
//   2. must PASS: the false positives on record (FINDINGS §2a, D-1100, D-1106, D-1111, D-1113, the held 10/9
//      cases) in their recorded shape with generic paths, and the ordinary-work shapes of DESIGN §6a;
//   3. must BLOCK / ASK: the gate's corrections (C2 unknown write target, C3 start-up files, F13 loading set),
//      the rulings (fork 3, fork 5) and what the parse newly sees (brace expansion, a removal of a folder above).
// Trigger words are assembled at run time (J) so this file does not trip the guards it tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.SBRM_DV_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-next-')); // nothing minted or recorded
const G = require('../../guard/guard');
const N = require('../../guard/guard_next');
const FP = require('./guard_false_positives.test.js');

const J = (...p) => p.join('');
const H = os.homedir().replace(/\\/g, '/');
const PLUG = `${H}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.11.9`;
const ENG = `${PLUG}/dataverse/engine/dataverse-write.js`;
const DEV = 'C:/Users/x/dev/toolkit';
const SCRATCH = 'C:/Users/x/AppData/Local/Temp/claude/s/scratchpad';
const AP = J('ap', 'ply');
const PR = J('Permission', 'Request');
const ID = '20261013-120000-abcdef12';
const opts = { dirs: [DEV.toLowerCase()], popup: () => false };
const next = (input) => N.decideNext(input, opts);
const sh = (command, tool = 'Bash', extra = {}) => ({ tool_name: tool, tool_input: { command }, permission_mode: 'default', ...extra });
const ps = (command, extra = {}) => sh(command, 'PowerShell', extra);
const write = (file_path, content, extra = {}) => ({ tool_name: 'Write', tool_input: { file_path, content }, ...extra });

// ---------- 1. parity ----------

// DESIGN.md §4, with the gate's corrections: the deliberate differences, each with its group.
const FLIPS = new Map([
  ['a look-alike engine outside the plugin', 'Group C: a mutating word as a bare argument of an unknown program; the look-alike still fails as an approval'],
  ['grep for the words is refused too (they only run as an approval)', 'Group A: the words in a non-running position'],
  ['a grep for the assignment still blocks in a shell (the rule stays broad there)', 'Group A: a grep is not an assignment'],
  ['find from another drive letter', 'fork 3 extended to find (build 10/13): a name filter that cannot match the key lists names only'],
]);

test('parity with guard.js: every self-test case decides the same, except the named flips', () => {
  const { cases, answerer, approvalCases, dirs } = G.selftestCases();
  const o = { dirs, popup: () => false };
  const diffs = [];
  for (const [label, input] of [...cases, ...answerer]) {
    const a = N.decideOld(input, o).kind;
    const b = N.decideNext(input, o).kind;
    if (a !== b && !FLIPS.has(label)) diffs.push(`${label}: old ${a}, next ${b}`);
  }
  const k = (v) => (!v ? 'none' : v.block ? 'block' : 'ask');
  for (const [label, input] of approvalCases) {
    const a = k(G.approvalVerdict(input));
    const b = k(N.approvalVerdict(input));
    if (a !== b && !FLIPS.has(label)) diffs.push(`approval ${label}: old ${a}, next ${b}`);
  }
  assert.deepEqual(diffs, []);
});

test('the named flips really flip (a flip that stops flipping is a changed design)', () => {
  const { cases, approvalCases, dirs } = G.selftestCases();
  const o = { dirs, popup: () => false };
  const lookalike = cases.find(([l]) => l === 'a look-alike engine outside the plugin');
  assert.equal(N.decideNext(lookalike[1], o).kind, 'allow');
  const grep = approvalCases.find(([l]) => l.startsWith('grep for the words'));
  assert.equal(N.approvalVerdict(grep[1]), null);
});

for (const [label, input] of FP.PASS) {
  test(`parity, passes: ${label}`, () => assert.equal(next(input).kind, 'allow', next(input).why));
}
for (const [label, input, message] of FP.BLOCK) {
  test(`parity, ${FLIPS.has(label) ? 'FLIP to allow' : 'blocks'}: ${label}`, () => {
    const r = next(input);
    if (FLIPS.has(label)) { assert.equal(r.kind, 'allow', r.why); return; }
    assert.equal(r.kind, 'block');
    assert.match(r.why, message);
  });
}

// ---------- 2. must PASS ----------

const PASS = [
  // FINDINGS §2a, the 13 blocks of 10/12-10/13 (generic paths)
  ['#1 find with escaped parentheses in a dev folder', sh('find "/c/Users/x/dev/toolkit" -type f \\( -name "*.js" -o -name "*.json" \\) | grep -v node_modules | sort')],
  ['#2 grep for the store variable, then sed -n', sh('cd "/c/Users/x/dev/toolkit/dataverse/engine" && grep -n "function configDir\\|SBRM_DV_CONFIG" lib/*.js ; sed -n 1,124p lib/store.js')],
  ['#3 grep -c for the store variable', sh('grep -c "SBRM_DV_CONFIG" CLAUDE.md')],
  ['#4 a for/if loop that greps the events log', sh("for i in $(seq 1 60); do if grep -q 'D-1007' ~/.sbrm-dataverse/events/events.jsonl 2>/dev/null; then grep 'D-1007' ~/.sbrm-dataverse/events/events.jsonl | tail -1; exit 0; fi; sleep 5; done")],
  ['#5 Get-ChildItem of home filtered to document extensions (fork 3)', ps(`Get-ChildItem "${H}" -Recurse -File -Include *.pdf,*.docx,*.xlsx -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) } | Sort-Object LastWriteTime -Descending | Select-Object -First 20 FullName`)],
  ['#6 cat and git remote -v in the plugin folders', sh(`cat ~/.claude/remote-settings.json; git -C ${H}/.claude/plugins/cache/sbrm-claude-private remote -v; git -C ${H}/.claude/plugins/marketplaces/sbrm-claude-toolkit remote -v; ls ${H}/.claude/plugins/cache`)],
  ['#7 a python heredoc editing .md files, a commit, a Compress-Archive with $src', sh("python - <<'EOF'\np='C:/Users/x/proj/CLAUDE.md'\nt=open(p).read()\nopen(p,'w').write(t.replace('a','b'))\nEOF\ngit commit -m \"notes\" && powershell -NoProfile -Command \"$src='C:\\Users\\x\\proj'; $out='C:\\Users\\x\\tmp\\p.zip'; Compress-Archive -Path \\\"$src\\CLAUDE.md\\\",\\\"$src\\STATUS.md\\\" -DestinationPath $out\"", 'Bash', { cwd: 'C:/Users/x/Documents/Claude' })],
  ['#8 a python heredoc writing a scratch-folder settings file with a logging hook', sh(`python - <<'EOF'\nimport json,os\nd='${SCRATCH}/tabspike/.claude'\nos.makedirs(d, exist_ok=True)\njson.dump({"hooks":{"${PR}":[{"hooks":[{"type":"command","command":"python log.py"}]}]}}, open(d+'/settings.local.json','w'))\nEOF`, 'Bash', { cwd: 'C:/Users/x/Documents/Claude' })],
  ['#10 a variable bound to the scratchpad as a redirect target, a plugin script run', sh(`S="${PLUG}/skills/web-research/scripts"; OUT="${SCRATCH}/web"; bash "$S/tavily.sh" extract "https://example.org" > "$OUT/t1947.txt" 2>&1; wc -c "$OUT/t1947.txt"; head -c 1500 "$OUT/t1947.txt"`)],
  ['#11 a heredoc of prose naming settings.json and the prompt hook, into a .md', sh(`cd "/c/Users/x/Documents/Claude/Terminal Setup/review" && cat >> SPIKES.md <<'EOF'\n## spike\nA hook in settings.json under ${PR} answers prompts.\nEOF`)],
  ['#12 the newest version folder in a variable, then the review', sh(`P=$(ls -d "${H}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/"*/ | sort -V | tail -1); echo "$P"; cd "/c/Users/x/Documents/Claude" && node "\${P}dataverse/engine/dataverse-write.js" review 2>&1 | tail -80`)],
  ['#13 listing and reading job files (Daian)', sh('cd ~/.sbrm-dataverse/jobs && for f in a.json b.json; do echo "== $f"; cat "$f" | head -60; done; ls ~/.sbrm-dataverse/jobs | grep -i -E "738|deact|move|contact"', 'Bash', { cwd: '/Users/x' })],
  // D-1100, D-1106, D-1111, D-1113 and the 10/13 NMTC search
  ['D-1100 a .md that quotes the engine\'s function names', write('C:/Users/x/Documents/Claude/Review/FINDINGS.md', J('The write ', 'Connection in lib/write.js and apply', 'Plan are what the content rule matched.'))],
  ['D-1106 a grep for the write module', sh(J('grep -rn "write', 'Connection" "/c/Users/x/dev/toolkit/dataverse/engine/lib"'))],
  ['D-1111 a listing of pending events into a temp file', sh('ls ~/.sbrm-dataverse/events/pending > /tmp/pend_before.txt; node --test test/x.test.js')],
  ['D-1113 a node one-liner reading the events log by path pieces', sh("node -e \"const fs=require('fs'),os=require('os'),p=require('path'); const L=fs.readFileSync(p.join(os.homedir(),'.sbrm-dataverse','events','events.jsonl'),'utf8'); console.log(L.length)\"")],
  ['10/13 a find of home by a dated name (fork 3 extended)', sh(`ls "${H}/" | grep -i "rescue"; find "${H}" -maxdepth 6 -iname "*2019-02-07*" 2>/dev/null | head`)],
  // FINDINGS §2b, the held 10/9 cases
  ['10/9 a store listing counted beside an unrelated cp', sh('ls ~/.sbrm-dataverse/events/pending | wc -l; cp a.txt b.txt', 'Bash', { cwd: SCRATCH })],
  ['10/9 a store listing counted into a temp file', sh('ls ~/.sbrm-dataverse/events/pending | wc -l > /tmp/count.txt')],
  ['10/9 GIK (b): a python heredoc reading the log, writing a scratch file', sh(`cd "${SCRATCH}" && python - <<'EOF'\nimport re, json\ntxt=open(r"C:\\Users\\x\\.sbrm-dataverse\\log\\a@example.org.md",encoding="utf-8").read()\nE=[1]\njson.dump(E,open("audit_log.json","w",encoding="utf-8"),indent=1)\nEOF`)],
  ['10/9 GIK (d): a heredoc test script in a dev folder, then node runs it', sh(`cd "/c/Users/x/dev/toolkit/replays" && cat > bisect.js <<'EOF'\nconst S = '~/.sbrm-dataverse/jobs';\nEOF\nnode bisect.js`)],
  ['10/9 (b): rm and clone in a scratch folder, then diff against the plugin', sh(`rm -rf tk && git clone https://github.com/example/toolkit tk && diff -rq tk/dataverse ${PLUG}/dataverse`, 'Bash', { cwd: SCRATCH })],
  ['10/9 (c): find -exec sed -i in a scratch clone', sh("find dataverse skills/dataverse -type f \\( -name \"*.js\" -o -name \"*.md\" \\) -exec sed -i 's/\\r$//' {} +", 'Bash', { cwd: SCRATCH })],
  ['10/9 a .py whose string holds a resolve line (a task body)', write('C:/Users/x/tmp/task.py', J('from todoist_api import TodoistClient\nTodoistClient().add("Close D-1003", description="run: node ', ENG, ' reso', 'lve D-1003 fixed done")\n'))],
  // DESIGN §6a ordinary work
  ['a while-read loop reading plans', sh('ls ~/.sbrm-dataverse/plans | while read f; do cat ~/.sbrm-dataverse/plans/$f | head -3; done')],
  ['jq and json.tool over a plan', sh('jq . ~/.sbrm-dataverse/plans/x.json; python -m json.tool ~/.sbrm-dataverse/plans/x.json')],
  ['git log in the toolkit marketplace folder', sh(`cd ${H}/.claude/plugins/marketplaces/sbrm-claude-toolkit && git log -p -3`)],
  ['diff of two process substitutions naming the store', sh('diff <(cat ~/.sbrm-dataverse/log/a.md) <(cat ~/.sbrm-dataverse/log/b.md)')],
  ['PowerShell foreach over Get-Content of the events log', ps('foreach ($l in Get-Content "$HOME\\.sbrm-dataverse\\events\\events.jsonl") { $l.Length }')],
  ['Get-ChildItem -Recurse of Documents', ps('Get-ChildItem $HOME\\Documents -Recurse | Measure-Object')],
  ['a commit message spelling every trigger', sh(J('git commit -m "guard: set', 'x, Set-Item env:, SetEnvironment', 'Variable, ', PR, ', dataverse-write.js ', AP, ', SBRM_DV_HOME=x"'))],
  ['a Todoist comment through a python script holding the apply line', sh(J('python todoist_api.py comment 123 "next: node ', ENG, ' ', AP, ' ', ID, '"'))],
  ['a heredoc .md holding env calls and the apply line', sh(J("cat > notes.md <<'EOF'\nset", 'x PATH x\n[Environment]::SetEnvironment', "Variable('HOME','x')\nnode ", ENG, ' ', AP, ' 1\nEOF'))],
  ['a tar of a project folder into scratch', sh('tar -czf /tmp/scratch.tgz "/c/Users/x/Documents/Claude/proj"')],
  ['copying a plugin file OUT to scratch', sh(`cp ${PLUG}/dataverse/guard/guard.js /tmp/guard_copy.js`)],
  ['a find of the store root that lists names only', sh('find ~/.sbrm-dataverse -name "*.json" | head')],
  ['adding an alias to a shell start-up file', sh("echo \"alias ll='ls -la'\" >> ~/.zshrc")],
  ['updating the toolkit (the nudge\'s two lines)', sh('claude plugin marketplace update sbrm-claude-toolkit && claude plugin update sbrm-toolkit@sbrm-claude-toolkit')],
  ['a .md describing a shell-string CLI write', write('C:/temp/notes.md', J('subprocess.run("dataverse data up', 'date contact 1", shell=True)'))],
  ['a plugin hooks.json gaining a PostToolUse hook only', write(`${H}/.claude/plugins/marketplaces/other/plugins/x/hooks/hooks.json`, '{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"x"}]}]}}')],
  ['a skill file without hooks in its frontmatter', write(`${H}/.claude/skills/x/SKILL.md`, '---\nname: x\ndescription: y\n---\nBody text.\n')],
];
for (const [label, input] of PASS) {
  test(`passes: ${label}`, () => {
    const r = next(input);
    assert.equal(r.kind, 'allow', r.why);
  });
}

// ---------- 3. must BLOCK / ASK ----------

const BLOCK = [
  // C2 (GATE_2): an unknown write target on a line that names the store or the plugin
  ['C2 a redirect to a variable bound on the line to the plugin', sh(`OUT="${PLUG}/dataverse/x.json"; cat y > "$OUT"`), /plugin's files/],
  ['C2 a removal through an unknown variable on a line naming the store', sh('rm "$X/plans/a.json"; ls ~/.sbrm-dataverse'), /engine's own store/],
  // C3: shell start-up files run in every later shell
  ['C3 the engine store variable exported into .bashrc', sh(J("echo 'export SBRM_DV_", "HOME=/tmp/x' >> ~/.bashrc")), /start-up file/],
  ['C3 a PATH change in .zshrc', sh("echo 'export PATH=\"/tmp/shim:$PATH\"' >> ~/.zshrc"), /start-up file/],
  ['C3 a copy over .bashrc (its content cannot be read)', sh('cp /tmp/x ~/.bashrc'), /start-up file/],
  ['C3 a Write of .zshrc that preloads node code', write(`${H}/.zshrc`, J('export NODE_OPT', 'IONS="--require /tmp/x.js"\n')), /start-up file/],
  ['C3 the PowerShell profile setting the home folder', write(`${H}/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`, J('$env:USER', 'PROFILE = "C:\\tmp"\n')), /start-up file/],
  // F13: the loading set
  ['F13 a plugin hooks.json gaining a prompt hook', write(`${H}/.claude/plugins/marketplaces/other/plugins/x/hooks/hooks.json`, `{"hooks":{"${PR}":[{"hooks":[{"type":"command","command":"x"}]}]}}`), /prompt-answerer/],
  ['F13 a skill whose frontmatter adds a prompt hook', write(`${H}/.claude/skills/x/SKILL.md`, `---\nname: x\nhooks:\n  ${PR}:\n    - hooks:\n        - type: command\n          command: x\n---\nBody.\n`), /prompt-answerer/],
  ['F13 a shell write into the project\'s local settings', sh("echo '{}' > .claude/settings.local.json", 'Bash', { cwd: 'C:/Users/x/proj' }), /loading-settings/],
  ['F13 a run of Claude Code with hooks switched off in --settings', sh(J("claude -p hi --settings '{\"disableAll", "Hooks\": true}'")), /switching hooks off/],
  // what the parse newly sees
  ['a backslash inside a word (bash drops it: the path is the plans folder)', sh(J('r', 'm ~/.sbrm-dataverse/pl\\ans/x.json')), /engine's own store/],
  ['a removal inside a for loop', sh(J('for f in a b; do r', 'm ~/.sbrm-dataverse/plans/x.json; done')), /engine's own store/],
  ['a removal inside if/then', sh(J('if true; then r', 'm ~/.sbrm-dataverse/log/x.md; fi')), /engine's own store/],
  ['brace expansion into the store',sh(J('r', 'm ~/.sbrm-dataverse/{plans,log}/x.json')), /engine's own store/],
  ['a wildcard folder in the store (the key rule sees it first)', sh(J('r', 'm ~/.sbrm-dataverse/*/x.json')), /engine's own store|walking through the store's folders/],
  ['moving the whole store away', sh(J('m', 'v ~/.sbrm-dataverse ~/old-store')), /engine's own store/],
  ['removing the home folder (the store goes with it)', sh(J('r', 'm -rf ~')), /engine's own store/],
  ['moving a plan OUT of the store', sh(J('m', 'v ~/.sbrm-dataverse/plans/x.json /tmp/')), /engine's own store/],
  ['a plans listing fed to a removal', sh(J('ls ~/.sbrm-dataverse/plans | xargs r', 'm')), /engine's own store/],
  ['eval of a removal in the store', sh(J('eval "r', 'm -rf ~/.sbrm-dataverse/plans"')), /engine's own store/],
  ['a heredoc into bash removing plans', sh(J("bash <<'EOF'\nr", 'm -rf ~/.sbrm-dataverse/plans\nEOF')), /engine's own store/],
  ['cmd /c del in the store', sh(J('cmd /c d', 'el %USERPROFILE%\\.sbrm-dataverse\\plans\\x.json')), /engine's own store/],
  ['PowerShell Remove-Item in the store', ps(J('Remove-', 'Item -Recurse $HOME\\.sbrm-dataverse\\plans')), /engine's own store/],
  ['PowerShell listing of plans piped to Remove-Item', ps(J('Get-ChildItem $HOME\\.sbrm-dataverse\\plans | Remove-', 'Item')), /engine's own store/],
  ['sudo with a moved home', sh(J('sudo ', 'HO', 'ME=/tmp/x ./run.sh')), /moving the engine's store/],
  ['a .py handing a CLI write to a shell (F5, closed part)', write('C:/temp/go.py', J('import subprocess\nsubprocess.run("dataverse data up', 'date contact 1", shell=True)\n')), /CLI's write side/],
  ['an unreadable line naming the key falls back to the old rules', sh(J('cat ~/.sbrm-dataverse/config/plan.', 'key "unterminated')), /plan signing key/],
];
for (const [label, input, message] of BLOCK) {
  test(`blocks: ${label}`, () => {
    const r = next(input);
    assert.equal(r.kind, 'block', `expected a block, got ${r.kind}`);
    assert.match(r.why, message);
  });
}

// ---------- the persistent env-var rule: the 10/22 independent audit (guard_review/env_probe_2026-10-22) ----------
// Each case was ALLOWED by 1.11.16 and the staged next model (verify_audit.js). Names: Dylan 10/22, "code-loading
// names only" (a persistent PYTHONIOENCODING stays allowed).
const SETX = J('se', 'tx');
const SETENV = J('SetEnvironment', 'Variable');
const SETITEM = J('Set-', 'Item');
const ENV_BLOCK = [
  ['A-N1 a persistent PYTHONPATH', sh(`${SETX} PYTHONPATH C:/a/modules`), /moving the engine's store/],
  ['A-N2 a persistent PYTHONSTARTUP', sh(`${SETX} PYTHONSTARTUP C:/a/s.py`), /moving the engine's store/],
  ['A-N3 a persistent PYTHONHOME', sh(`${SETX} PYTHONHOME C:/a/py`), /moving the engine's store/],
  ['A-N4 a persistent PYTHONUSERBASE', sh(`${SETX} PYTHONUSERBASE C:/a/u`), /moving the engine's store/],
  ['A-N5 a persistent GIT_CONFIG_GLOBAL', sh(`${SETX} GIT_CONFIG_GLOBAL C:/a/gc`), /moving the engine's store/],
  ['A-N6 a persistent GIT_EXEC_PATH', sh(`${SETX} GIT_EXEC_PATH C:/a/g`), /moving the engine's store/],
  ['A-N7 a persistent GIT_SSH_COMMAND', sh(`${SETX} GIT_SSH_COMMAND C:/a/ssh.exe`), /moving the engine's store/],
  ['A-N8 a persistent GIT_CONFIG_COUNT (injects any git config)', sh(`${SETX} GIT_CONFIG_COUNT 1`), /moving the engine's store/],
  ['A-N9 a persistent GIT_TEMPLATE_DIR', sh(`${SETX} GIT_TEMPLATE_DIR C:/a/t`), /moving the engine's store/],
  ['A-N10 a persistent ZDOTDIR', sh(`${SETX} ZDOTDIR C:/a/z`), /moving the engine's store/],
  ['A-N11 a persistent OPENSSL_CONF', sh(`${SETX} OPENSSL_CONF C:/a/o.cnf`), /moving the engine's store/],
  ['A-F1 the .NET call with spaces round ::', ps(`[Environment] :: ${SETENV}('NODE_PATH','C:/a','User')`), /moving the engine's store/],
  ['A-F2 the .NET call with a quoted method name', ps(`[Environment]::'${SETENV}'('NODE_PATH','C:/a','User')`), /moving the engine's store/],
  ['A-F3 the si alias', ps('si env:NODE_PATH C:/a'), /moving the engine's store/],
  ['A-F4 New-Item on the env drive with -Name', ps('New-Item -Path Env: -Name NODE_PATH -Value C:/a'), /moving the engine's store/],
  ['A-F5 the ni alias', ps('ni env:NODE_PATH C:/a'), /moving the engine's store/],
  ['A-F6 the Environment:: provider path', ps(`${SETITEM} Environment::NODE_PATH C:/a`), /moving the engine's store/],
  ['A-F7 a backtick-escaped Set-Item', ps(J('Set-`', 'Item env:NODE_PATH C:/a')), /moving the engine's store/],
  ['A-F8 a backtick-escaped setx', ps(J('se`', 'tx NODE_PATH C:/a')), /moving the engine's store/],
  ['A-P1 readonly appended to .bashrc', ps(`Add-Content -LiteralPath "${H}/.bashrc" -Value 'readonly NODE_PATH=/a'`), /start-up file/],
  ['A-P2 readonly written into .bashrc', write(`${H}/.bashrc`, 'readonly NODE_PATH=/a\n'), /start-up file/],
  ['A-P3 a fish conf.d snippet', write(`${H}/.config/fish/conf.d/a.fish`, 'set -gx NODE_PATH /a\n'), /start-up file/],
  ['A-P4 New-Item on the env drive in a PowerShell profile', write(`${H}/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`,
    'New-Item -Path Env: -Name NODE_PATH -Value C:/a\n'), /start-up file/],
  ['A-P5 the Environment:: path in a PowerShell profile', write(`${H}/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`,
    `${SETITEM} Environment::NODE_PATH C:/a\n`), /start-up file/],
];
for (const [label, input, message] of ENV_BLOCK) {
  test(`env audit blocks: ${label}`, () => {
    const r = next(input);
    assert.equal(r.kind, 'block', `expected a block, got ${r.kind}`);
    assert.match(r.why, message);
  });
}
const ENV_PASS = [
  ['a persistent harmless app key (the 10/8 false positive)', sh(`${SETX} SBRM_LOGS_GRIST_KEY abc`)],
  ['a persistent PYTHONIOENCODING (not code-loading; Dylan 10/22)', sh(`${SETX} PYTHONIOENCODING utf-8`)],
  ['setx /M of a safe name', sh(`${SETX} MY_APP_KEY abc /M`)],
  ['the .NET call on a safe name', ps(`[Environment]::${SETENV}('MY_APP_KEY','x','User')`)],
  ['Set-Item on the env drive, safe name', ps(`${SETITEM} env:MY_APP_KEY x`)],
  ['New-Item of an ordinary file', ps('New-Item -ItemType File C:/temp/x.txt')],
  ['New-Item of an ordinary file that happens to be called PATH', ps('New-Item -ItemType File PATH')],
  ['New-Item on the env drive with a safe -Name', ps('New-Item -Path Env: -Name MY_APP_KEY -Value x')],
  ['a fish conf.d snippet with a safe name', write(`${H}/.config/fish/conf.d/b.fish`, 'set -gx MY_APP_KEY abc\n')],
];
for (const [label, input] of ENV_PASS) {
  test(`env audit passes: ${label}`, () => assert.equal(next(input).kind, 'allow', next(input).why));
}

test('fork 5 (ruled 10/13): plugin install and marketplace add ASK; disable still blocks', () => {
  assert.equal(next(sh('claude plugin install foo@bar')).kind, 'ask');
  assert.equal(next(sh('claude plugin marketplace add example/plugins')).kind, 'ask');
  assert.equal(next(sh(J('claude plugin dis', 'able sbrm-toolkit@sbrm-claude-toolkit'))).kind, 'block');
});

test('approvals: the exact form still asks; the words in a running position are refused; as data they pass', () => {
  const own = (G._internals.ownEngine() || '').replace(/\\/g, '/');
  const A = (command) => ({ tool_name: 'Bash', tool_input: { command }, permission_mode: 'default' });
  assert.ok(N.approvalVerdict(A(`node "${own}" ${AP} ${ID}`)).ask);
  assert.ok(N.approvalVerdict(A(`bash -c "node '${own}' ${AP} ${ID}"`)).block);
  assert.ok(N.approvalVerdict(A(`R=$(node "${own}" ${AP} ${ID})`)).block);
  assert.ok(N.approvalVerdict(A(`node -e "require('child_process').execSync('node ${own} ${AP} ${ID}')"`)).block);
  assert.equal(N.approvalVerdict(A(`echo "node ${own} ${AP} ${ID}"`)), null);
  assert.equal(N.approvalVerdict(A(`git commit -m "node ${own} ${AP}"`)), null);
});

// Settings files: the iTerm2 case (10/9) and the loading set. A settings file Claude Code loads (here: the project
// folder's, with that folder as the session's) is diffed as before; the same file in a folder nothing loads from
// is not a hook (blocks #8, #9).
test('settings: a project settings file is diffed; one in a scratch folder nothing loads is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrm-next-settings-'));
  const file = path.join(dir, '.claude', 'settings.local.json').replace(/\\/g, '/');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hook = JSON.stringify({ hooks: { [PR]: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
  assert.match(next(write(file, hook, { cwd: dir })).why || '', /prompt-answerer/);
  assert.equal(next(write(file, hook, { cwd: 'C:/Users/x/elsewhere' })).kind, 'allow');
  // and a Claude Code run started in that folder asks the person
  fs.writeFileSync(file, hook);
  assert.equal(next(sh('claude -p hi', 'Bash', { cwd: dir })).kind, 'ask');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 4. the shadow's new stops, fixed before the cut-over (1.11.14) ----------
// Calls the installed guard allowed and the next model would have stopped (events/guard_shadow.jsonl 10/16-10/21,
// guard_review/replay_shadow.js), as they ran with generic paths, each beside the real thing its rule exists for.

const SKILL = `${H}/.claude/skills/x`;
const CLI = J('data', 'verse');
const NEW_STOPS_PASS = [
  ['S-1005 a sed edit of a skill\'s body text (no hooks in it)', sh(`cd "${SKILL}" && grep -n "recent runs used 3" SKILL.md && sed -i 's/run; recent runs used 3 at a time\\./run; the 10\\/16\\/26 run 4 at a time./' SKILL.md && grep -n "at a time" SKILL.md`)],
  ['D-1175 a python heredoc that only READS Claude Code\'s user config', sh(`python - <<'EOF'\nimport json,os\nd=json.load(open(os.path.expanduser("~/.claude.json"),encoding="utf-8"))\ncwd=r"C:\\Users\\x\\Documents\\Claude"\nfor k,v in (d.get("projects") or {}).items():\n    if os.path.normcase(os.path.normpath(k.replace("/","\\\\")))==os.path.normcase(cwd):\n        print("disabledMcpServers:",v.get("disabledMcpServers"))\nEOF`)],
  ['D-1175 shape: a JS string .replace of a slash, then a read', sh(`node -e "const p='a/b'.replace('/', '\\\\\\\\'); console.log(require('fs').readFileSync(p.replace(/x/g,'y'),'utf8'))"`)],
  ['H-1028 a .py docstring that opens with the product name', write('C:/Users/x/Documents/Claude/EOM/prerec_check.py', `"""Checks.\n\n${J('Data', 'verse')} UserLocal DateOnly comes back as 07:00Z, so dates are read in UTC.\n"""\nprint(1)\n`)],
  ['10/21 a python -c whose string names an app beside the product word', sh(`cd /c/Users/x/repos/tracker && python -c "\nfor name in [('sharepoint (cert)', 1), ('${CLI} hgs (secret)', 2)]:\n    print(name)\n" 2>&1 | tail -4`)],
  // H-1093/H-1095 (10/25): a line address narrows where an s/// applies, so it can only change less
  ['H-1093 a sed edit of a skill with a line address (N s///)', sh(`cd "${SKILL}" && sed -i '18s/a/b/' SKILL.md`)],
  ['H-1093 a sed edit of a skill with a line range and two commands (N,M s///)', sh(`sed -i '3,9s/old text/new text/g; 12s/x/y/' "${SKILL}/SKILL.md"`)],
];
for (const [label, input] of NEW_STOPS_PASS) {
  test(`new stop now passes: ${label}`, () => {
    const r = next(input);
    assert.equal(r.kind, 'allow', r.why);
  });
}

const NEW_STOPS_BLOCK = [
  ['a sed edit that writes a prompt hook into a skill\'s frontmatter', sh(`sed -i 's/^name: x$/name: x\\nhooks:\\n  ${PR}:\\n    - hooks:\\n        - type: command\\n          command: y/' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a python heredoc that WRITES into the store', sh(J(`python - <<'EOF'\nimport os\nopen(os.path.expanduser("~/.sbrm-dataverse/plans/x.json"),"w").wri`, `te("{}")\nEOF`)), /engine's own store/],
  ['a .py holding a CLI write in a variable it hands to a shell', write('C:/temp/go2.py', J('import os\ncmd = "', CLI, ' data up', 'date contact 1"\nos.system(cmd)\n')), /CLI's write side/],
  ['a python -c string naming a CLI write verb the guard knows', sh(`python -c "x = '${CLI} skill upload a'; print(x)"`), /writes to Dataverse/],
  ['a python -c string with the CLI word then a flag', sh(`python -c "x = '${CLI} --bogus data up${J('', 'date')} a'; print(x)"`), /unknown option|writes to Dataverse/],
  ['D-1184 (ruled 10/21: the rule stands) a names-only listing of the store\'s settings folder', sh('ls ~/.sbrm-dataverse/config/tickets | wc -l; ls ~/.sbrm-dataverse/config/'), /store's root or settings folder/],
  ['os.replace INTO the store is still a move (only a string\'s .replace is not)', sh(J(`python - <<'EOF'\nimport os\nos.repl`, `ace("/tmp/x.json", "~/.sbrm-dataverse/plans/x.json")\nEOF`)), /engine's own store/],
  ['a sed edit of a skill that re-inserts what it matched (&)', sh(`sed -i 's/^name: x$/&\\nmore: y/' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed edit of a skill that decodes a character escape', sh(`sed -i 's/^name: x$/name: x\\n\\x68ooks:/' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed edit of a skill that is not an s command (y, shaped like one)', sh(`sed -i 'y/abc/xyz/' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed edit of a skill that reads another file in (r)', sh(`sed -i '1r /tmp/extra.yml' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed edit of a skill with the w flag', sh(`sed -i 's/a/b/w /tmp/out.txt' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed edit of a skill with the e flag (runs the result)', sh(`sed -i 's/a/b/e' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed edit of a skill through -e (the script is not read)', sh(`sed -i -e 's/a/b/' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a line-addressed sed edit of a skill that writes a hook word', sh(`sed -i '2s/^name: x$/hooks:/' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a line-addressed sed edit of a skill with the e flag', sh(`sed -i '18s/a/b/e' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a line-addressed sed command that is not s (d)', sh(`sed -i '18d' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed edit of a skill with a pattern address (not read)', sh(`sed -i '/^name/s/a/b/' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed edit of a skill with a negated address (not read)', sh(`sed -i '18!s/a/b/' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed edit of a skill with a stepped address (not read)', sh(`sed -i '1~2s/a/b/' "${SKILL}/SKILL.md"`), /prompt-answerer/],
  ['a sed address with nothing after it', sh(`sed -i '18' "${SKILL}/SKILL.md"`), /prompt-answerer/],
];
for (const [label, input, message] of NEW_STOPS_BLOCK) {
  test(`still blocks: ${label}`, () => {
    const r = next(input);
    assert.equal(r.kind, 'block', `expected a block, got ${r.kind}`);
    assert.match(r.why, message);
  });
}

// R-1080 / R-1082 (10/21, the Mail Sorting Guide session): a read-only Dataverse client and an Entra token helper were
// refused as "a raw writing HTTP call at Dataverse". Their only POST is the token request, whose URL sits in a constant
// (`LOGIN = "https://login.microsoftonline.com/..."`, then `.post(LOGIN.format(...))`); the rule read only a URL written
// on the write line, so it fell back to "a Dataverse address anywhere + a post anywhere". Now a write's target held in
// a named constant is looked up in the same text; a write line whose target still cannot be read keeps the fallback.
const DVH2 = J('sbrmrec.crm.dyn', 'amics.com');
const LOGIN_LINE = 'LOGIN = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"\n';
const TOKEN_POST = '        r = self._http.post(LOGIN.format(tenant=self._tenant), data={"grant_type": "client_credentials"}, timeout=120)\n';
const RAW_PASS = [
  ['R-1080 a read-only client: the token POST to a constant, every Dataverse call a GET', write('C:/Users/x/Documents/Claude/dataverse_app.py', J(
    '"""Dataverse Web API reads as an APP identity. READ-ONLY.\n    dv.get_all("sbrmrec", "sbrm_clients")\n"""\nimport requests\n\n', LOGIN_LINE,
    'API = "/api/data/v9.2/"\n\ndef host_url(host):\n    return "https://" + host + ".crm.dyn', 'amics.com"\n\nclass DataverseApp:\n    def _token(self, base):\n',
    TOKEN_POST, '        return r.json()["access_token"]\n    def get(self, base, path):\n        return self._http.get(base + API + path, headers={}).json()\n'))],
  ['R-1082 a token helper whose docstring names a Dataverse URL as an example', write('C:/Users/x/Documents/Claude/entra_token.py', J(
    `"""Entra tokens for any resource: Dataverse (https://${DVH2}), Graph (https://graph.microsoft.com)."""\nimport requests\n\n`, LOGIN_LINE,
    'class EntraToken:\n    def get(self, resource):\n', TOKEN_POST, '        return r.json()["access_token"]\n'))],
  ['a JS const URL to another service, posted to', write('C:/Users/x/proj/tok.js', J(
    `// reads https://${DVH2}/api/data/v9.2/contacts with the token\nconst TOKEN_URL = 'https://login.microsoftonline.com/t/oauth2/v2.0/token';\n`,
    'async function token() { const r = await fetch(TOKEN_URL, { method: "PO', 'ST", body: "x" }); return r.json(); }\n'))],
];
for (const [label, input] of RAW_PASS) {
  test(`raw-HTTP rule passes: ${label}`, () => {
    const r = next(input);
    assert.equal(r.kind, 'allow', r.why);
  });
}
const RAW_BLOCK = [
  ['the same client with a PATCH whose URL is built at run time', write('C:/Users/x/Documents/Claude/dv_writer.py', J(
    'import requests\n', LOGIN_LINE, 'def host_url(h):\n    return "https://" + h + ".crm.dyn', 'amics.com"\nclass C:\n    def _token(self, base):\n', TOKEN_POST,
    '    def save(self, base, path, body):\n        return self._http.pat', 'ch(base + "/api/data/v9.2/" + path, json=body)\n'))],
  ['a constant holding a Dataverse URL, posted to', write('C:/Users/x/proj/w.py', J(
    `import requests\nURL = "https://${DVH2}/api/data/v9.2/contacts"\nrequests.po`, 'st(URL, json={"lastname": "x"})\n'))],
  ['a literal POST to another service no longer covers a variable PATCH to Dataverse (the hole, closed)', write('C:/Users/x/proj/two.py', J(
    'import requests\nrequests.po', 'st("https://graph.microsoft.com/v1.0/me/sendMail", json={})\n',
    `url = "https://" + "sbrmrec" + ".crm.dyn` + 'amics.com/api/data/v9.2/contacts(1)"\nrequests.pat', 'ch(url, json={"lastname": "x"})\n'))],
];
for (const [label, input] of RAW_BLOCK) {
  test(`raw-HTTP rule still blocks: ${label}`, () => {
    const r = next(input);
    assert.equal(r.kind, 'block', `expected a block, got ${r.kind}`);
    assert.match(r.why, /raw writing HTTP call at Dataverse/);
  });
}

// F-1009 / F-1011 (10/20), R-1043/1044/1047/1048 (10/21): browser work in one session was stopped because an approval
// was waiting in ANOTHER session on this machine. The browser tool drives Chrome tabs only; it cannot reach the
// terminal where Claude Code asks. Ruled 10/21 (Dylan: "we need to fix that chrome block because its really
// annoying"): while an approval waits the browser tool is free, except a call that names Claude's own site (where a
// Remote Control or claude.ai/code approval could be shown). Mouse and keyboard tools that reach the desktop still block.
test('an approval waiting: the browser tool is free except on Claude\'s own site; desktop screen tools still block', () => {
  const waiting = { dirs: opts.dirs, popup: () => true };
  const chrome = (action, extra = {}) => ({ tool_name: 'mcp__claude-in-chrome__computer', tool_input: { action, tabId: 1, ...extra } });
  for (const a of ['screenshot', 'zoom', 'wait', 'left_click', 'double_click', 'key', 'type', 'scroll', 'left_click_drag', 'hover']) {
    const r = N.decideNext(chrome(a, { coordinate: [1, 1], text: 'y', duration: 2 }), waiting);
    assert.equal(r.kind, 'allow', `${a}: ${r.why}`);
  }
  assert.equal(N.decideNext({ tool_name: 'mcp__claude-in-chrome__shortcuts_execute', tool_input: { tabId: 1, shortcut: 'x' } }, waiting).kind, 'allow');
  // Claude's own site, by any browser tool, while an approval waits: blocked
  const site = [
    { tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { tabId: 1, url: 'https://claude.ai/code' } },
    { tool_name: 'mcp__claude-in-chrome__tabs_create_mcp', tool_input: { url: 'https://www.claude.com/remote' } },
    { tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { tabId: 1, action: 'javascript_exec', text: "location='https://CLAUDE.AI/new'" } },
    chrome('type', { text: 'claude.ai/code' }),
  ];
  for (const input of site) {
    const r = N.decideNext(input, waiting);
    assert.equal(r.kind, 'block', `${input.tool_name}: expected a block`);
    assert.match(r.why, /Claude's own site while an approval is waiting/);
  }
  // with no approval waiting, the same calls pass
  for (const input of site) assert.equal(N.decideNext(input, { dirs: opts.dirs, popup: () => false }).kind, 'allow');
  // a look-alike domain is not Claude's site
  assert.equal(N.decideNext({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { tabId: 1, url: 'https://notclaude.ai.example.org/x' } }, waiting).kind, 'allow');
  // desktop mouse/keyboard tools still block while waiting, whatever they are asked
  assert.equal(N.decideNext({ tool_name: 'mcp__windows-mcp__Click-Tool', tool_input: { action: 'screenshot', loc: [1, 2] } }, waiting).kind, 'block');
  assert.equal(N.decideNext({ tool_name: 'mcp__computer-use__computer', tool_input: { action: 'left_click' } }, waiting).kind, 'block');
});

// ---------- 1.11.19: two false positives from the 10/23 review (#6hqFf2p8HWC6Q93J) ----------
// F-1076 (10/22): a chained string .replace after one whose last argument is a slash was read as renaming the drive
// root, because the receiver rule took the ")" closing the first call's arguments for the one closing Path("/").
// D-1273 (10/23): the read-only review redirected to a file under the job folder Claude Code gives every background
// session, CLAUDE_JOB_DIR, was an unknown target on a line naming the plugin. It now resolves from the hook's own
// environment, unless the line assigns it.
test('F-1076: a chained string .replace after a slash argument is not a rename; Path(...).replace still is', () => {
  const chained = sh(`cd "/c/Users/x/proj" && python -c "
rows=['a|b']
out=[r.replace('|','/').replace(chr(10),' ') for r in rows]
open('notes/out.md','w',encoding='utf-8').write(chr(10).join(out))
"`);
  assert.equal(next(chained).kind, 'allow', next(chained).why);
  assert.equal(next(sh(`python -c "print('a/b'.replace('/','|').replace('x','y'))"`)).kind, 'allow');
  // the real things the rule exists for
  assert.match(next(sh(J(`python -c "from pathlib import Path; Path('~/.sbrm-dataverse/plans/x.json').repl`, `ace('/tmp/y')"`))).why, /engine's own store/);
  // a parenthesized string literal is still a string: its .replace changes no file (round 6 corrected round 1 here)
  assert.equal(next(sh(J(`python -c "import os; ('~/.sbrm-dataverse/plans').repl`, `ace('/tmp/y')"`))).kind, 'allow');
  // a real rename of the drive root, with no store path in the text to fall back on: the wrapped literal is judged
  assert.match(next(sh(J(`python -c "from pathlib import Path; Path('/').repl`, `ace('/tmp/y')"`))).why, /engine's own store/);
  // a call's own parenthesis is not a wrapper: rstrip('/') then .replace is string work (review 10/23)
  assert.equal(next(sh(`python -c "print('a/b/'.rstrip('/').replace('a','c'))"`)).kind, 'allow');
  // the DESTINATION of a Path rename or replace is judged too (review 10/23: only the source was)
  assert.match(next(sh(J(`python -c "from pathlib import Path; Path('C:/temp/x.json').repl`, `ace('~/.sbrm-dataverse/plans/x.json')"`))).why, /engine's own store/);
  assert.match(next(sh(J(`python -c "from pathlib import Path; Path('C:/temp/x.json').ren`, `ame('${PLUG}/dataverse/guard/guard.js')"`))).why, /toolkit plugin's files/);
  assert.match(next(sh(J(`python -c "import pathlib; p=pathlib.Path('C:/temp/x.json'); p.repl`, `ace('~/.sbrm-dataverse/plans/x.json')"`))).why, /engine's own store/);
  // a destination passed by KEYWORD is judged too (round 4), for a Path method and for os.replace / os.rename
  assert.match(next(sh(J(`python -c "from pathlib import Path; Path('C:/temp/x.json').repl`, `ace(target='~/.sbrm-dataverse/plans/x.json')"`))).why, /engine's own store/);
  assert.match(next(sh(J(`python -c "from pathlib import Path; Path('C:/temp/x.json').ren`, `ame(target='${PLUG}/dataverse/guard/guard.js')"`))).why, /toolkit plugin's files/);
  assert.match(next(sh(J(`python -c "import os; os.repl`, `ace('C:/temp/x.json', dst='~/.sbrm-dataverse/plans/x.json')"`))).why, /engine's own store/);
  assert.match(next(sh(J(`python -c "import os; os.ren`, `ame(src='C:/temp/x.json', dst='~/.bashrc')"`))).why, /./);
  assert.equal(next(sh(`python -c "import shutil; shutil.move(src='C:/temp/x', dst='~/.bashrc')"`)).kind, 'block');
  // keyword-only writes (round 5): open(file=..., mode="w") and makedirs(name=...)
  assert.match(next(sh(J(`python -c "open(file='~/.sbrm-dataverse/plans/x.json', mode='w').wri`, `te('{}')"`))).why, /engine's own store/);
  assert.match(next(sh(`python -c "import os; os.makedirs(name='~/.sbrm-dataverse/plans/forged')"`)).why, /engine's own store/);
  assert.equal(next(sh(`python -c "open(file='C:/temp/notes.txt', mode='w').write('x')"`)).kind, 'allow');
  // a copy's SOURCE is read, not written: copying a plugin file out by keyword is fine; copying INTO it is not
  assert.equal(next(sh(`python -c "import shutil; shutil.copyfile(src='${PLUG}/dataverse/guard/guard.js', dst='C:/temp/g.js')"`)).kind, 'allow');
  assert.match(next(sh(`python -c "import shutil; shutil.copyfile(src='C:/temp/g.js', dst='${PLUG}/dataverse/guard/guard.js')"`)).why, /toolkit plugin's files/);
  // a bare string literal's replace is text work, slashes or not (round 5), even when its text names the store (round 6)
  assert.equal(next(sh(`python -c "print('/'.replace('/', '|'))"`)).kind, 'allow');
  assert.equal(next(sh(`python -c "print('hello'.replace('~/.sbrm-dataverse/plans/x.json','notes'))"`)).kind, 'allow');
  // round 6: the write mode is read from the call itself, wherever it sits; a positional copy source is read, not written
  assert.match(next(sh(J(`python -c "open(file='${PLUG}/dataverse/guard/guard.js',${' '.repeat(400)}mode='w').wri`, `te('x')"`))).why, /toolkit plugin's files/);
  // round 7: a mode held in a variable could be a write; a raw-string mode is still a literal
  assert.match(next(sh(J(`python -c "m='w'; open('${PLUG}/dataverse/guard/guard.js',m).wri`, `te('x')"`))).why, /toolkit plugin's files/);
  assert.equal(next(sh(`python -c "print(open(file='${PLUG}/dataverse/guard/guard.js',mode=r'r').read())"`)).kind, 'allow');
  assert.match(next(sh(J(`python -c "open(file='${PLUG}/dataverse/guard/guard.js',mode=r'w').wri`, `te('x')"`))).why, /toolkit plugin's files/);
  assert.equal(next(sh(`python -c "import shutil; shutil.copyfile('${PLUG}/dataverse/guard/guard.js', dst='C:/temp/g.js')"`)).kind, 'allow');
  assert.match(next(sh(`python -c "import shutil; shutil.copyfile('C:/temp/g.js', dst='${PLUG}/dataverse/guard/guard.js')"`)).why, /toolkit plugin's files/);
  // os.replace is a file move, not a string's replace: its destination counts without pathlib
  assert.equal(next(sh(J(`python -c "import os; os.repl`, `ace('C:/temp/x', '~/.bashrc')"`))).kind, 'block');
  assert.equal(next(sh(J(`python -c "import os; os.repl`, `ace('C:/temp/x', dst='~/.bashrc')"`))).kind, 'block');
  // a pathlib object moved onto a shell start-up file: no store text to fall back on, so the destination itself is judged
  assert.equal(next(sh(J(`python -c "import pathlib; p=pathlib.Path('C:/temp/x'); p.repl`, `ace('~/.bashrc')"`))).kind, 'block');
  // a STRING replace whose first argument looks like a path is text work, with or without pathlib (rounds 2 and 3)
  assert.equal(next(sh(`python -c "print('hello'.replace('~/.bashrc','notes'))"`)).kind, 'allow');
  assert.equal(next(sh(`python -c "from pathlib import Path; print('hello'.replace('~/.bashrc','notes'))"`)).kind, 'allow');
});

test('D-1273: a redirect under CLAUDE_JOB_DIR resolves from the environment; assigned on the line or unset, it is judged as before', () => {
  const was = process.env.CLAUDE_JOB_DIR;
  const review = `node "${ENG}" review > "$CLAUDE_JOB_DIR/tmp/review.txt" 2>&1; wc -l "$CLAUDE_JOB_DIR/tmp/review.txt"`;
  try {
    process.env.CLAUDE_JOB_DIR = 'C:/Users/x/.claude/jobs/22cfe1d3';
    assert.equal(next(sh(review)).kind, 'allow', next(sh(review)).why);
    // assigned on the line to the plugin: the line's own value is judged
    assert.equal(next(sh(`CLAUDE_JOB_DIR="${PLUG}"; node "${ENG}" review > "$CLAUDE_JOB_DIR/dataverse/guard/guard.js"`)).kind, 'block');
    assert.equal(next(sh(`export CLAUDE_JOB_DIR="${PLUG}"; node "${ENG}" review > "$CLAUDE_JOB_DIR/dataverse/guard/guard.js"`)).kind, 'block');
    // an environment value inside the plugin is judged like any path there
    process.env.CLAUDE_JOB_DIR = PLUG;
    assert.match(next(sh(`node "${ENG}" review > "$CLAUDE_JOB_DIR/dataverse/guard/guard.js"`)).why, /toolkit plugin's files/);
    // unset: unknown, as before
    delete process.env.CLAUDE_JOB_DIR;
    assert.match(next(sh(review)).why, /unknown-target/);
    // Bash names are case-sensitive: a lowercase $claude_job_dir is ANOTHER (unset) variable, never the job folder
    process.env.CLAUDE_JOB_DIR = 'C:/Users/x/.claude/jobs/22cfe1d3';
    assert.equal(next(sh(`node "${ENG}" review > "$claude_job_dir/c/Users/x/.sbrm-dataverse/plans/x.json"`)).kind, 'block');
    assert.equal(next(sh(`CLAUDE_JOB_DIR=/tmp/safe; node "${ENG}" review > "$claude_job_dir/c/Users/x/.sbrm-dataverse/plans/x.json"`)).kind, 'block');
    // unset on the line: Bash expands it to nothing, so the environment's value is not used (round 3)
    assert.equal(next(sh(`unset CLAUDE_JOB_DIR; node "${ENG}" review > "$CLAUDE_JOB_DIR/c/Users/x/.sbrm-dataverse/plans/x.json"`)).kind, 'block');
    delete process.env.CLAUDE_JOB_DIR;
    // only this one name: another variable stays unknown
    process.env.SOME_DIR = 'C:/Users/x/tmp';
    assert.match(next(sh(`node "${ENG}" review > "$SOME_DIR/review.txt"`)).why, /unknown-target/);
  } finally {
    if (was === undefined) delete process.env.CLAUDE_JOB_DIR; else process.env.CLAUDE_JOB_DIR = was;
    delete process.env.SOME_DIR;
  }
});

// Review 10/23 round 2 (pre-existing since 1.11.14): the next model folded every variable name to lowercase, but a
// POSIX shell's names are case-sensitive, so a variable set in one case and read in another was judged as the set
// value while the shell expanded an unset one, and a write into the store passed. PowerShell and cmd stay case-blind.
test('POSIX variable names are case-sensitive: set in one case and read in another is never the set value', () => {
  const hp = H.replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`);
  const S = J('.sbrm', '-dataverse');
  for (const c of [
    `A=/tmp/safe; printf '{}' > "$a${hp}/${S}/plans/x.json"`,
    `a=/tmp/safe; printf '{}' > "$A${hp}/${S}/plans/x.json"`,
    // (a target built from an UNKNOWN variable on a line that does not name the store stays allowed: the C2 residual)
    // an unset variable is unknown again, never its earlier value (round 3)
    `A=/tmp/safe; unset A; printf '{}' > "$A${hp}/${S}/plans/x.json"`,
    `A=/tmp/safe; unset -v B A; printf '{}' > "$A${hp}/${S}/plans/x.json"`,
    `export A=/tmp/safe; printf '{}' > "$a${hp}/${S}/plans/x.json"`,
    `printf '{}' > "$home/${S}/plans/x.json"`,
  ]) assert.equal(next(sh(c)).kind, 'block', c);
  // the same case still resolves, as before
  assert.equal(next(sh(`A=/tmp/safe; printf '{}' > "$A/out.json"`)).kind, 'allow');
  assert.equal(next(sh(`printf '{}' > "$HOME/notes/out.json"`)).kind, 'allow');
  assert.equal(next(sh(`A=${hp}/${S}; printf '{}' > "$A/plans/x.json"`)).kind, 'block');
});

// H-1081 (10/25, 1.11.19; still blocked on 1.11.23): a Todoist close whose quoted note held "Memory System (" and
// "Dataverse ->" was read as the CLI with the unknown option "-". The old whole-text CLI rule ran before the parse:
// "System (" read as a shell-out call, so it scanned the whole note for the CLI word. The CLI is now judged per parsed
// command: a script's data arguments and a printer's are data; a shell handed a string, inline code, a command
// substitution and the CLI as a command are still read.
test('H-1081: the Dataverse CLI words inside a script\'s or a printer\'s quoted argument are data; run, they still block', () => {
  const DV = J('data', 'verse');
  const note = `3 ${DV} -> ${DV} Reference, qbo_write -> QBO Write Path, index -> Memory System (asserted on`;
  for (const c of [
    `python todoist_api.py done X "${note}"`,
    `cd "/c/Users/x/proj" && python todoist_api.py comment 6abc "${note}"`,
    `echo "${note}"`,
    `printf '%s\\n' "${note}"`,
    `grep -n "System (x) ${DV} -y" notes.md`,
    // the CLI's own read is still a read
    `${DV} data query --help`,
  ]) assert.equal(next(sh(c)).kind, 'allow', `${c}: ${next(sh(c)).why}`);
  for (const c of [
    `${DV} ${J('data cre', 'ate')} --table x`,
    `cd x && ${DV} ${J('data del', 'ete')} --table x`,
    `python todoist_api.py done X "${note}"; ${DV} ${J('data cre', 'ate')} --table x`,
    `python todoist_api.py done X "$(${DV} ${J('data cre', 'ate')} --table x)"`,
    `bash -c "${DV} ${J('data cre', 'ate')} --table x"`,
    `python -c "import os; os.${J('sys', 'tem')}('${DV} ${J('data cre', 'ate')} --table x')"`,
    `echo "$(${DV} ${J('data cre', 'ate')} --table x)"`,
    `awk 'BEGIN { ${J('sys', 'tem')}("${DV} ${J('data cre', 'ate')} --table x") }'`,
  ]) assert.equal(next(sh(c)).kind, 'block', c);
  // the same in PowerShell
  assert.equal(next(ps(`python todoist_api.py done X "${note}"`)).kind, 'allow', next(ps(`python todoist_api.py done X "${note}"`)).why);
  assert.equal(next(ps(`${DV} ${J('data cre', 'ate')} --table x`)).kind, 'block');
});

// D-1388 (Daian 10/26, still blocked on 1.11.23): fork 3's find of home by name blocked as soon as it carried an
// exclusion (-not -path), though an ANDed exclusion can only narrow the listing. The find expression is now read as
// logic: it passes when every name it can print has passed a -name / -iname test that cannot match the key's file
// name. The same read closes an older hole: an -o branch with no name test (-iname "*.md" -o -type f) lists everything.
test('D-1388: a find of home by name may carry exclusions; an or-branch with no name test still sweeps', () => {
  for (const c of [
    'find ~ -maxdepth 4 \\( -iname "*niagara*" -o -iname "*distech*" -o -iname "*tridium*" -o -iname "*.jnlp" \\) -not -path "*/Library/Caches/*" 2>/dev/null | head',
    'find ~ -maxdepth 3 -iname "*.pdf" ! -ipath "*/node_modules/*"',
    'find ~ -maxdepth 4 -type f -iname "*.xlsx" -not -name \'~$*\' -print',
    'find ~ -path "*/node_modules" -prune -o -iname "*.xlsx" -print',
    'find ~ -maxdepth 4 -iname "*niagara*"',
  ]) assert.equal(next(sh(c)).kind, 'allow', `${c}: ${next(sh(c)).why}`);
  for (const c of [
    'find ~ -maxdepth 4 -iname "*.md" -o -type f',
    'find ~ -maxdepth 4 -not -iname "*.md"',
    'find ~ -maxdepth 4 \\( -iname "*.md" -o -path "*x*" \\) -not -path "*/y/*"',
    'find ~ -path "*/node_modules" -prune -o -iname "*.xlsx"',
    'find ~ -iname "*.pdf" -o -path "*" -print',
    'find ~ -iname "*.key" -not -path "*/x/*"',
    'find ~ -iname "*.pdf" -not -path "*/x/*" -printf "%p"',
    J('find ~ -iname "*.pdf" -not -path "*/x/*" -ex', 'ec cat {} \\;'),
    'find ~ -iname "*.pdf" -not -path "*/x/*" | xargs cat',
    'find ~ \\( -iname "*.pdf" -not -path "*/x/*"',
    'find ~ -iname "*.pdf" -print -o ! \\( -type d -print \\)',
  ]) assert.match(next(sh(c)).why || '', /home-sweep|home folder/, c);
});

// Inline-code review (inline_code_review\GATE_2.md G4, ruled 10/29/26): the reader follows a name bound once and a path
// joined from known parts, stops reading a list's or a string's method as a file call, and an untraceable write target
// on code that names the store or the plugin ASKS (Dylan: "ask") instead of blocking. A literal or resolved write into
// a protected place still blocks. A path built at run time to get past the guard is an accepted residual.
test('inline review G4: the recorded false positives pass', () => {
  for (const c of [
    // H-1086 core (fpd): a string's replace on a variable, the plugin path only in its text, a relative write
    J(`python -c "s=open('equiv.py').read();s=s.repl`, `ace(r'~\\.claude\\plugins\\cache\\sbrm-claude-toolkit\\sbrm-toolkit\\1.11.19\\run.sh','x');open('equiv.py','w').wri`, `te(s)"`),
    // fpc: a list's remove, the store only in a print
    `python -c "l=[1,2];x=1;l.remove(x);print('see ~/.sbrm-dataverse/plans')"`,
    // H-1102 shapes (fpb, fpb3, fpk): read the events file, write a scratch file through a join, an f-string, a +
    J(`python -c "import os;ev=os.path.expanduser('~/.sbrm-dataverse/events/events.jsonl');out=os.path.join(os.environ['TEMP'],'x.md');open(out,'w').wri`, `te(open(ev).read()[:10])"`),
    J(`python -c "import os;ev=os.path.expanduser('~/.sbrm-dataverse/events/events.jsonl');t=os.environ['TEMP'];open(f'{t}/x.md','w').wri`, `te(open(ev).read()[:10])"`),
    `python -c "import json,os;d=json.load(open(os.path.expanduser('~/.sbrm-dataverse/plans/a.json')));out=os.environ['TEMP']+'/a.json';json.dump(d,open(out,'w'))"`,
    // a dict's copy and a module-qualified rename between scratch files, on code naming the store
    J(`python -c "import os;d={'a':1}.copy();os.ren`, `ame('C:/temp/a.json','C:/temp/b.json');print('~/.sbrm-dataverse')"`),
  ]) assert.equal(next(sh(c)).kind, 'allow', `${c}: ${next(sh(c)).why}`);
});

test('inline review G4: a name bound once and a joined path are followed into the store, the plugin and settings', () => {
  for (const c of [
    J(`python -c "p='~/.sbrm-dataverse/plans/x.json';open(p,'w').wri`, `te('x')"`),
    J(`python -c "import os;p=os.path.join(os.path.expanduser('~'),'.sbrm-dataverse','plans','x.json');open(p,'w').wri`, `te('x')"`),
    J(`python -c "import os;p=os.environ['USERPROFILE']+'/.sbrm-'+'dataverse/plans/x.json';open(p,'w').wri`, `te('x')"`),
    J(`python -c "import os;h=os.path.expanduser('~');open(f'{h}/.sbrm-dataverse/plans/x.json','w').wri`, `te('x')"`),
    J(`python -c "from pathlib import Path;p=Path.home()/'.sbrm-dataverse'/'plans'/'x.json';p.wri`, `te_text('x')"`),
    J(`node -e "const os=require('os'),path=require('path'),fs=require('fs');const p=path.join(os.homedir(),'.sbrm-dataverse','plans','x.json');fs.wri`, `teFileSync(p,'x')"`),
    // an absolute later part wins the join, as the language does it
    J(`python -c "import os;p=os.path.join('C:/temp','${H}/.sbrm-dataverse/plans/x.json');open(p,'w').wri`, `te('x')"`),
  ]) assert.match(next(sh(c)).why || '', /engine's own store/, c);
  assert.match(next(sh(J(`python -c "import os;g=os.path.join('${PLUG}','dataverse','guard','guard.js');open(g,'w').wri`, `te('x')"`))).why || '', /toolkit plugin's files/);
  // the path module under another name, and a declaration of several names (replay t1e, t1f)
  for (const c of [
    J(`node -e "const fs=require('fs'),p=require('path'),os=require('os');fs.wri`, `teFileSync(p.join(os.homedir(),'.sbrm-dataverse','plans','x.json'),'x')"`),
    J(`node -e "const fs=require('fs'),p=require('path'),os=require('os');fs.wri`, `teFileSync(p.join(os.homedir(),'.sbrm-'+'dataverse','plans','x.json'),'x')"`),
    J(`python -c "import os.path as osp;open(osp.join(osp.expanduser('~'),'.sbrm-dataverse','plans','x.json'),'w').wri`, `te('x')"`),
    // (the store's name in pieces from here on: a line spelling the store path out is already stopped by the line rule,
    // so only the reader's own work can catch these)
    J(`node -e "const fs=require('fs'),path=require('path'),os=require('os');const a='C:/temp',p=path.join(os.homedir(),'.sbrm-'+'dataverse','plans','x.json');fs.wri`, `teFileSync(p,'x')"`),
    // a keyword target held in a name bound once, and a pathlib receiver bound once
    J(`python -c "import os;p=os.path.join(os.path.expanduser('~'),'.sbrm-'+'dataverse','plans','x.json');open(file=p,mode='w').wri`, `te('x')"`),
    J(`python -c "from pathlib import Path;p=Path.home()/('.sbrm-'+'dataverse')/'plans'/'x.json';p.wri`, `te_text('x')"`),
  ]) assert.match(next(sh(c)).why || '', /engine's own store/, c);
  // a joined path into the store's settings folder, even read, is the signing key (replay t2b); dev_dirs.json is not
  assert.match(next(sh(`python -c "import os;print(open(os.path.expanduser('~/.sbrm-'+'dataverse/config/x'+'.bin')).read())"`)).why || '', /signing key/);
  assert.equal(next(sh(`python -c "import os;print(open(os.path.join(os.path.expanduser('~'),'.sbrm-dataverse','config','dev_dirs.json')).read())"`)).kind, 'allow');
  assert.equal(next(sh(J(`python -c "import os,json;p=os.path.expanduser('~/.claude/settings.json');json.dump({},open(p,'w'))"`))).kind, 'block');
  // the absolute later part wins the other way too: out of the store, nothing protected is written
  assert.equal(next(sh(J(`python -c "import os;p=os.path.join('~/.sbrm-dataverse','C:/temp/x.json');open(p,'w').wri`, `te('x')"`))).kind, 'allow');
});

test('inline review G4: an untraceable write target on code naming the store or plugin asks, and never hides a block', () => {
  const unknownStore = J(`python -c "import sys;p=sys.argv[1];open(p,'w').wri`, `te('x');print('~/.sbrm-dataverse/plans')"`);
  const r = next(sh(unknownStore));
  assert.equal(r.kind, 'ask', r.why);
  assert.match(r.why, /could not tell where/);
  // a name bound twice, or by a loop, is not followed (its last value is not the one written to)
  assert.equal(next(sh(J(`python -c "p=input();open(p,'w').wri`, `te('x');p='C:/temp/a';print('~/.sbrm-dataverse')"`))).kind, 'ask');
  assert.equal(next(sh(J(`python - <<'EOF'\nimport sys\np='C:/temp/a'\nfor p in sys.argv:\n    open(p,'w').wri`, `te('~/.sbrm-dataverse')\nEOF`))).kind, 'ask');
  // the plugin named in the text, a pathlib receiver the guard cannot read
  assert.equal(next(sh(J(`python -c "from pathlib import Path;import sys;q=Path(sys.argv[1]);q.wri`, `te_text('${PLUG}')"`))).kind, 'ask');
  // nothing protected named: allowed, as before
  assert.equal(next(sh(J(`python -c "import sys;p=sys.argv[1];open(p,'w').wri`, `te('x')"`))).kind, 'allow');
  // text joined after a known folder lands in that folder (B-...-f78b4b's shape: replay files written in a loop into
  // the scratchpad, by code that reads the events file)
  const loop = (target) => J(`python - <<'EOF'\nimport os,json\nD=r"${SCRATCH}/replay"\nev=os.path.expanduser('~/.sbrm-dataverse/events/events.jsonl')\nfor k in ['a','b']:\n    open(${target},'w').wri`, `te(k)\nEOF`);
  assert.equal(next(sh(loop('f"{D}/{k}.txt"'))).kind, 'allow', next(sh(loop('f"{D}/{k}.txt"'))).why);
  assert.equal(next(sh(loop("D+'/'+k+'.txt'"))).kind, 'allow');
  // ... but a join keeps every part known (an absolute later part would win), and home is no folder to judge by
  assert.equal(next(sh(loop('os.path.join(D,k)'))).kind, 'ask');
  assert.equal(next(sh(loop("os.path.expanduser('~')+'/'+k"))).kind, 'ask');
  assert.equal(next(sh(loop("f\"{os.path.expanduser('~')}/.claude/{k}\""))).kind, 'ask');
  // under the store or the plugin, the folder alone decides
  assert.match(next(sh(loop("f\"{os.path.expanduser('~/.sbrm-dataverse/plans')}/{k}.json\""))).why || '', /engine's own store/);
  assert.match(next(sh(loop(`'${PLUG}/dataverse/'+k`))).why || '', /toolkit plugin's files/);
  // an ask never masks a block later in the same code
  assert.match(next(sh(J(`python -c "import sys;p=sys.argv[1];open(p,'w').wri`, `te('x');open('~/.sbrm-dataverse/plans/y.json','w').wri`, `te('y')"`))).why || '', /engine's own store/);
  // nor a block in a later command on the line
  assert.equal(next(sh(J(`python -c "import sys;open(sys.argv[1],'w');print('~/.sbrm-dataverse')" && echo x > ~/.sbrm-dataverse/plans/z.json`))).kind, 'block');
});
