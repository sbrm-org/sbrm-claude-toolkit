'use strict';
// The guard's two text heuristics, judged on what a command DOES (1.11.5). On 10/9 a terminal-setup review
// was blocked six times by read-only or documentation work and never by a real write, injection or approval
// attempt: the injection rule matched the names of input tools, and the home-folder rule matched a home or
// root token and a recursion word anywhere on the line. The must-pass cases below are those calls as they ran
// (from the session transcript); the must-block cases are the real thing each rule exists to stop.
// Trigger words are assembled at run time (J) so this file does not trip the guards it tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { verdict } = require('../../guard/guard');

const J = (...p) => p.join('');
const AHK = J('Auto', 'Hotkey');
const NIR = J('nir', 'cmd');
const SK = J('Send', 'Keys');
const PAG = J('py', 'autogui');
const KBE = J('keybd', '_event');
const AHK_EXT = J('.a', 'hk');
const HM = J('HO', 'ME=');
const ENGINE = `${os.homedir().replace(/\\/g, '/')}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.11.6/dataverse/engine/dataverse-write.js`;
const HOME = os.homedir().replace(/\\/g, '/');
const judge = (input) => verdict(input, [], { popup: () => false });
const sh = (command, tool = 'PowerShell', extra = {}) => ({ tool_name: tool, tool_input: { command }, ...extra });
const write = (file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content } });

// ---------- must PASS: the 10/9 blocks, verbatim ----------

const APPS = String.raw`$apps = @(); foreach ($k in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*') { $apps += Get-ItemProperty $k -ErrorAction SilentlyContinue | Select-Object DisplayName,DisplayVersion }
$apps | Where-Object { $n=$_.DisplayName; $n -and ($names | Where-Object { $n -like "*$_*" }) } | Sort-Object DisplayName -Unique | Format-Table -AutoSize | Out-String
"=== Store apps of interest ==="; Get-AppxPackage | Where-Object { $_.Name -match 'Terminal|PowerToys|Claude|Elgato' } | Select-Object Name,Version | Format-Table -AutoSize | Out-String
"=== Git Bash ==="; & 'C:\Program Files\Git\bin\bash.exe' --version | Select-Object -First 1`;

const PASS = [
  ['1. monitor sizes through the Forms Screen class, plus an installed-apps check (was "keystroke or click injection")', sh(String.raw`"=== Monitors ==="; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "{0}  {1}x{2}  primary={3}" -f $_.DeviceName,$_.Bounds.Width,$_.Bounds.Height,$_.Primary }
"=== Relevant installed apps ==="
$names = 'Stream Deck','Elgato','${AHK}','Logi','Claude','PowerShell 7','WezTerm','Alacritty','PowerToys','Windows Terminal Preview','Cascadia','Nerd'
${APPS}
"=== PowerToys / AHK exes on PATH ==="; foreach ($c in '${AHK}','${AHK}64','${NIR}','PowerToys') { $g=Get-Command $c -ErrorAction SilentlyContinue; if ($g) { "$c -> $($g.Source)" } else { "$c (not found)" } }`)],
  ['2. Get-Command lookups of the automation tools and an uninstall-list name filter (was "keystroke or click injection")', sh(String.raw`"=== Monitors (WMI) ==="; Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction SilentlyContinue | ForEach-Object { "{0}  {1}cm x {2}cm" -f ($_.InstanceName -split '\\')[1],$_.MaxHorizontalImageSize,$_.MaxVerticalImageSize }
Get-CimInstance Win32_VideoController | Select-Object Name,CurrentHorizontalResolution,CurrentVerticalResolution | Format-Table -AutoSize | Out-String
"=== Relevant installed apps ==="
$names = 'Stream Deck','Elgato','${AHK}','Logi','Claude','PowerShell 7','WezTerm','Alacritty','PowerToys','Cascadia','Nerd'
${APPS}
foreach ($c in '${AHK}','${AHK}64','${NIR}') { $g=Get-Command $c -ErrorAction SilentlyContinue; if ($g) { "$c -> $($g.Source)" } else { "$c (not found)" } }`)],
  ['3a. a process-chain trace: prose "shells / claude" plus Get-CimInstance -Filter (was "a recursive read or copy of the home folder")', sh(String.raw`$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
for ($i=0; $i -lt 10 -and $p; $i++) { $cl = ($p.CommandLine + '') -replace '\s+',' '; if ($cl.Length -gt 150) { $cl = $cl.Substring(0,150) }; "{0} (pid {1})  {2}" -f $p.Name,$p.ProcessId,$cl; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }
"=== Other WT shells / claude processes running ==="
Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'cmd.exe','powershell.exe','pwsh.exe','OpenConsole.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'claude') -or $_.Name -eq 'claude.exe' } | Group-Object Name | Select-Object Count,Name | Format-Table -AutoSize | Out-String
"=== claude install ==="
Get-ChildItem "$env:APPDATA\npm\node_modules\@anthropic-ai" -ErrorAction SilentlyContinue | Select-Object Name
Test-Path "$env:USERPROFILE\.local\bin\claude.exe"
Get-Command claude -All | Select-Object Source`)],
  ['3b. the same trace, second form (was "a recursive read or copy of the home folder")', sh(String.raw`$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
for ($i=0; $i -lt 10 -and $p; $i++) { $cl = ($p.CommandLine + '') -replace '\s+',' '; if ($cl.Length -gt 150) { $cl = $cl.Substring(0,150) }; "{0} (pid {1})  {2}" -f $p.Name,$p.ProcessId,$cl; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }
"=== Running shells / claude sessions ==="
Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'cmd.exe','powershell.exe','pwsh.exe','OpenConsole.exe','WindowsTerminal.exe','claude.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'claude-code') } | Group-Object Name | Select-Object Count,Name | Format-Table -AutoSize | Out-String`)],
  ['3c. fixed files under the home folder: Terminal settings, $PROFILE paths, font registry, Get-Module -ListAvailable', sh(String.raw`Get-Content "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json" -Raw
Test-Path $PROFILE.CurrentUserCurrentHost; Test-Path $PROFILE.CurrentUserAllHosts; Test-Path "$env:USERPROFILE\Documents\WindowsPowerShell\profile.ps1"
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts' | Out-String; Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts' -ErrorAction SilentlyContinue
Get-Module -ListAvailable PSReadLine | Select-Object Name,Version`)],
  ['4. a markdown plan whose prose names the tools (was "writing keystroke or click injection")', write('C:/Users/x/Claude/Terminal Setup/PLAN.md', J(
    '| Desktop app | Claude desktop 2.31226 installed alongside the CLI. |\n',
    '| Automation helpers | None: no ', AHK, ', PowerToys, Stream Deck software. |\n',
    '| Admin / IT | Dylan is in local Administrators (UAC prompts, not blocked). |\n',
    'Even a call shape in prose is prose: ', SK, '(), ', PAG, '.click(), ', KBE, '(13,0,0,0).\n'))],
  ['5. grep of the guard\'s own files for its pattern words (was "keystroke or click injection")', sh(J('d="/c/Users/x/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.11.4/dataverse/guard"; ls "$d"; echo ---; grep -n -i -E \'injection|hotkey|', SK, '|Forms|', NIR, '|recursive|home folder|drive root|Get-ChildItem|-Recurse\' "$d"/* | head -40; echo --- source; ls "/c/Users/x/Documents/Shared Dataverse Write" | head -30'), 'Bash')],
  // 10/9 later, Daian's Mac (reconstructed; her exact command not yet seen): writing a tab-color hook script.
  // 1.11.4 read a quoted "$HOME" plus `jq -r` anywhere on the line as a recursive home sweep.
  ['6. writing a hook script that keeps a state file under "$HOME" and parses with jq -r (was "a recursive read or copy of the home folder")', sh("mkdir -p ~/.claude/hooks && cat > ~/.claude/hooks/tab-color.sh <<'EOF'\n#!/bin/bash\ns=$(jq -r .session_id)\necho done > \"$HOME\"/.claude/state-$s\nEOF\nchmod +x ~/.claude/hooks/tab-color.sh && echo '{\"session_id\":\"x\"}' | ~/.claude/hooks/tab-color.sh && echo ok", 'Bash')],
  ['6b. Daian\'s exact command: her tab-color hook script (1.11.4 read `// empty` in a jq filter as a lone `/`, plus `jq -r`)', sh(String.raw`mkdir -p ~/.claude/hooks
cat > ~/.claude/hooks/tab-color.sh <<'EOF'
#!/bin/zsh
# Colors this iTerm2 tab by Claude's state: teal = working, red = needs you, yellow = done/your turn.
IT2=~/Applications/iTerm.app/Contents/Resources/utilities/it2
SID=$` + '{ITERM_SESSION_ID#*:}' + String.raw`
[[ -z "$SID" || ! -x $IT2 ]] && exit 0
EVT=$(cat)
event=$(print -r -- "$EVT" | /usr/bin/jq -r '.hook_event_name // empty')
ntype=$(print -r -- "$EVT" | /usr/bin/jq -r '.notification_type // empty')
case "$event" in
  UserPromptSubmit|PostToolUse|SessionStart|SessionEnd) color="#80CBC4" ;;
  PermissionRequest) color="#F28B82" ;;
  Notification) [[ "$ntype" == idle_prompt ]] && color="#F9E2AF" || color="#F28B82" ;;
  Stop|StopFailure) color="#F9E2AF" ;;
  *) exit 0 ;;
esac
# skip if unchanged, so frequent tool events stay cheap
STATE=/tmp/cc-tabcolor-$SID
[[ "$(cat $STATE 2>/dev/null)" == "$color" ]] && exit 0
print -r -- "$color" > $STATE
$IT2 session set-color "$color" --session "$SID" >/dev/null 2>&1 &!
exit 0
EOF
chmod +x ~/.claude/hooks/tab-color.sh
# test silently: should print nothing, set yellow
echo '{"hook_event_name":"Stop"}' | ~/.claude/hooks/tab-color.sh; echo "out-above-should-be-empty exit=$?"; sleep 1; cat /tmp/cc-tabcolor-$` + '{ITERM_SESSION_ID#*:}', 'Bash', { cwd: '/Users/daian' })],
  // 10/9 later, another session (bisected against 1.11.4): a single letter + colon read as a drive root
  // (`except Exception as e:`) and a `.find(` method read as the find command, ~460 characters apart.
  ['7a. a python heredoc with .find( and "except ... as e:" (was "a recursive read or copy of the home folder")', sh("python - <<'EOF'\ni = \"x\".find(\"x\")\ntry:\n    pass\nexcept Exception as e: print(e)\nEOF", 'Bash')],
  ['7b. python -c with .find( and "for x in y:"', sh("python -c \"i = 'x'.find('x')\nfor x in y: pass\"", 'Bash')],
  // Same session: a line naming the plugin path with ANY redirect was read as a write into the plugin.
  ['8a. sed rewriting a require() path into a scratch file (was "changing the toolkit plugin\'s files")', sh(`sed 's#${HOME}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.11.4/dataverse/guard/guard.js#C:/work/guard.js#' diag.js > diag_wc.js`, 'Bash')],
  ['8b. a node one-liner reading the plugin\'s settings into a scratch file', sh(`node -e "console.log(require('${HOME}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.11.4/dataverse/envs.json'))" > envs_copy.txt`, 'Bash')],
  // Neighbours of the same false positives
  ['the Forms assembly for the clipboard and a message box', sh('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText(); [System.Windows.Forms.MessageBox]::Show("done")')],
  ['installing or locating the tools by name', sh(J('winget install ', AHK, '.', AHK, '; where.exe ', NIR, '; pip show ', PAG, '; which xdo', 'tool'), 'Bash')],
  ['a grep whose pattern is itself call-shaped', sh(J('grep -rn "', SK, '(" src/ | head'), 'Bash')],
  ['reading a hotkey script', sh(J('Get-Content C:/tools/layout', AHK_EXT))],
  ['a JSON config naming a tool', write('C:/temp/apps.json', J('{"skip": ["', AHK, '", "', NIR, '"], "note": "', PAG, '.click() is not used"}'))],
  ['a heredoc note to a .md file', sh(J("cat > notes.md <<'EOF'\nNever call ", PAG, ".click() from a session.\nEOF"), 'Bash')],
  ['a recursive search of a project folder', sh('grep -rn "Filter" "/c/Users/x/Documents/Claude/Accounts Payable"', 'Bash')],
  ['Get-ChildItem -Recurse of a folder under home', sh('Get-ChildItem "$env:USERPROFILE\\Documents\\Claude" -Recurse -Filter *.md | Measure-Object')],
  ['a recursive command with no path, from a project folder', sh('rg -n secret', 'Bash', { cwd: 'C:/Users/x/Documents/Claude' })],
  ['a non-recursive listing of home', sh('ls ~ && Get-ChildItem $HOME', 'Bash')],
  // 1.11.6: a home folder set for one run, in a file or shell text that has nothing to do with Dataverse.
  ['10a. a Fly.io entrypoint dropping privileges (was "writing code that moves the engine\'s store or settings")', write('/Users/tim/code-projects/happy-agent/fly/docker-entrypoint.sh', J('#!/bin/sh\nset -eu\nmkdir -p /data/happy-agent\nchown -R happy:happy /data\nexec setpriv --reuid=happy --regid=happy --init-groups env ', HM, '/data/happy-agent "$@"\n'))],
  ['10b. the sbrm-ops-agents entrypoint, verbatim', write('/Users/tim/code-projects/sbrm-ops-agents/fly/docker-entrypoint.sh', J('#!/bin/sh\n# Prepare the Fly volume (mounted root-owned at /data) and drop privileges.\nset -eu\nDATA="${DATA_DIR:-/data}"\nfor d in state tailscale ledger queue transcripts; do mkdir -p "$DATA/$d"; done\nchown -R vigilance:vigilance "$DATA"\nchmod 0700 "$DATA/tailscale"\nexec setpriv --reuid=vigilance --regid=vigilance --init-groups env ', HM, '/home/vigilance "$@"\n'))],
  ['10c. a test script giving npm a scratch home, mentioning Claude only in a comment', write('C:/work/app/test.sh', J('#!/bin/sh\n# Claude Code runs this before a commit\n', HM, '"$(mktemp -d)" npm test\n'))],
  ['10d. an entrypoint whose user and home folder are named claude', write('C:/work/cc/entrypoint.sh', J('#!/bin/sh\nmkdir -p /home/claude\nchown claude /home/claude\necho "starting claude"\nexec setpriv --reuid=claude --regid=claude --init-groups env ', HM, '/home/claude "$@"\n'))],
];

for (const [label, input] of PASS) {
  test(`passes: ${label}`, () => {
    assert.equal(judge(input), null);
  });
}

// ---------- must BLOCK: what the two rules exist to stop ----------

const BLOCK = [
  // injection
  ['a real send-keys call (PowerShell, the Forms class)', sh(J('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.', SK, ']::SendWait("y")')), /rule: injection; matched:/],
  ['a send-keys call through a WSH shell object', sh(J('$w = New-Object -ComObject WScript.', 'Shell; $w.', SK, '("~")')), /rule: injection/],
  ['a .py that imports the GUI library and calls click', write('C:/temp/approve.py', J('import ', PAG, '\nimport time\ntime.sleep(1)\n', PAG, '.click(100, 200)\n')), /rule: injection-write; matched:/],
  ['the same library imported under an alias', write('C:/temp/approve2.py', J('import ', PAG, ' as g\ng.click(100, 200)\n')), /rule: injection-write/],
  ['a hotkey script write', write(J('C:/temp/approve', AHK_EXT), 'Send {Enter}'), /rule: injection-write; matched: a /],
  ['a keyboard-event P/Invoke from PowerShell', sh(J('Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void ', KBE, '(byte k, byte s, uint f, UIntPtr e); }\'; [K]::', KBE, '(0x0D,0,0,[UIntPtr]::Zero)')), /rule: injection; matched:/],
  ['running the hotkey runtime with a script', sh(J("& 'C:\\Program Files\\", AHK, '\\', AHK, "64.exe' C:\\temp\\approve", AHK_EXT)), /rule: injection/],
  ['launching a hotkey script by file', sh(J('Start-Process C:\\temp\\approve', AHK_EXT)), /rule: injection/],
  ['the hotkey runtime handed a script of another name', sh(J(AHK, '64.exe /ErrorStdOut C:\\temp\\approve.txt')), /rule: injection; matched: ".*" in a hotkey or AU3 script run/],
  ['the hotkey runtime reading its script from a pipe', sh(J("echo 'Send {Enter}' | ", AHK, '64.exe *'), 'Bash'), /rule: injection/],
  ['a call shape echoed into a script file', sh(J('echo "[System.Windows.Forms.', SK, ']::SendWait(\'y\')" > go.ps1'), 'Bash'), /rule: injection/],
  ['a call shape echoed into an interpreter',sh(J('echo "[System.Windows.Forms.', SK, ']::SendWait(\'y\')" | powershell -'), 'Bash'), /rule: injection/],
  ['a heredoc .py with the click call', sh(J("cat > go.py <<'EOF'\nimport ", PAG, '\n', PAG, ".click(1, 2)\nEOF"), 'Bash'), /rule: injection/],
  ['a settings hook command that sends keys', write(`${HOME}/.claude/settings.json`, J('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -c \\"[System.Windows.Forms.', SK, ']::SendWait(\'y\')\\""}]}]}}')), /rule: injection-write/],
  // home / drive-root sweeps
  ['a real -Recurse of $HOME', sh('Get-ChildItem $HOME -Recurse -Filter *.key | Get-Content'), /rule: home-sweep; matched: "Get-ChildItem -Recurse/],
  ['grep -r of ~', sh('grep -r token ~', 'Bash'), /rule: home-sweep; matched: "grep -r" on "~"/],
  ['ls -R of $env:USERPROFILE', sh('ls -R $env:USERPROFILE'), /rule: home-sweep/],
  ['find from the drive root', sh('find / -name "*.key"', 'Bash'), /rule: home-sweep/],
  ['find from /c/', sh('find /c/ -name "*.key"', 'Bash'), /rule: home-sweep/],
  ['robocopy of C:\\', sh('robocopy C:\\ D:\\backup /E'), /rule: home-sweep/],
  ['cp -r of the home folder', sh('cp -r ~ /tmp/all', 'Bash'), /rule: home-sweep/],
  ['Compress-Archive of the home folder', sh('Compress-Archive -Path $env:USERPROFILE -DestinationPath C:\\temp\\h.zip'), /rule: home-sweep/],
  ['cd home, then a relative recursive grep', sh('cd ~ && grep -r token .', 'Bash'), /rule: home-sweep/],
  ['a recursive command with no path, run from the home folder', sh('rg -n secret', 'Bash', { cwd: os.homedir() }), /rule: home-sweep/],
  ['the folder above home', sh('Get-ChildItem C:\\Users -Recurse'), /rule: home-sweep/],
  ['a home sweep inside bash -c', sh('bash -c "grep -r token ~"', 'Bash'), /rule: home-sweep/],
  ['find from another drive letter', sh('find E:/ -name plan.json', 'Bash'), /rule: home-sweep; matched: "find -name" on "E:\/"/],
  // plugin files: still blocked when the write really lands in the plugin
  ['sed -i on a plugin file', sh(`sed -i 's/a/b/' ${HOME}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.11.4/dataverse/guard/guard.js`, 'Bash'), /plugin's files/],
  ['sed -Ei (in-place inside combined flags) on a plugin file', sh(`sed -Ei 's/a/b/' ${HOME}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.11.4/dataverse/guard/guard.js`, 'Bash'), /plugin's files/],
  ['sed output redirected into the plugin',sh(`sed 's/a/b/' x.js > ${HOME}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.11.4/dataverse/guard/guard.js`, 'Bash'), /plugin's files/],
  ['a redirect to an unknown target on a line naming the plugin', sh(`cat ${HOME}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.11.4/dataverse/envs.json > $OUT`, 'Bash'), /plugin's files/],
  ['cd into the plugin, then a relative redirect', sh(`cd ${HOME}/.claude/plugins/cache/sbrm-claude-toolkit && echo x > y.json`, 'Bash'), /plugin's files/],
  ['a node one-liner writing into the plugin', sh(J(`node -e "require('fs').writeFile`, `Sync('${HOME}/.claude/plugins/cache/sbrm-claude-toolkit/x.json','{}')"`), 'Bash'), /plugin's files/],
  // store move (1.11.6): a moved home in a file that runs the engine or Claude Code, and on any shell line
  ['a script that runs the engine under a moved home', write('C:/temp/plan.sh', J('#!/bin/sh\n', HM, '/tmp/x node "', ENGINE, '" plan job.json\n')), /moves the engine's store/],
  ['a PowerShell script moving USERPROFILE before the Dataverse CLI', write('C:/temp/run.ps1', J('$env:USER', 'PROFILE = "C:\\temp\\x"\ndataverse data query contacts\n')), /moves the engine's store/],
  ['a script that starts Claude Code under a moved home (no plugins load, so no guard)', write('C:/temp/go.sh', J('#!/bin/sh\nexec env ', HM, '/tmp/x claude -p "do the thing"\n')), /moves the engine's store/],
  ['a script starting Claude Code through npx with a version', write('C:/temp/npx.sh', J('#!/bin/sh\n', HM, '/tmp/x npx -y @anthropic-ai/claude-code@latest -p hi\n')), /moves the engine's store/],
  ['a PowerShell script calling claude.exe by its Windows path', write('C:/temp/cc.ps1', J('$env:USER', 'PROFILE = "C:\\t"\n& "C:\\Users\\a\\.local\\bin\\claude.exe" -p hi\n')), /moves the engine's store/],
  ['a script calling claude through a saved path variable', write('C:/temp/v.sh', J('#!/bin/sh\nREAL="$HOME"\n', HM, '/tmp/x "$REAL/.local/bin/claude" -p hi\n')), /moves the engine's store/],
  ['the engine store variable in any script', write('C:/temp/s.py', J('import os\nos.environ["SBRM_DV_', 'HOME"] = "/tmp/x"\n')), /moves the engine's store/],
  ['a moved home on a shell line', sh(J(HM, '/tmp/x node "', ENGINE, '" plan job.json'), 'Bash'), /moving the engine's store/],
  ['a moved home on an unrelated shell line still blocks (the next command could run anything)', sh(J(HM, '/tmp/x ./run.sh'), 'Bash'), /moving the engine's store/],
  ['a moved home inside bash -c', sh(J('bash -c "', HM, '/tmp/x ./run.sh"'), 'Bash'), /moving the engine's store/],
  ['a quoted assignment word handed to env', sh(J('env "', HM, '/tmp/x" ./run.sh'), 'Bash'), /moving the engine's store/],
  // Quoted text that still runs (review of 1.11.6): the shell rule reads quotes as spaces, so all of these block.
  ['Claude Code under a moved home inside $(...)', sh(J('R="$(cd /tmp && ', HM, '/tmp/sb claude -p hi)"'), 'Bash'), /moving the engine's store/],
  ['a comment apostrophe before the moved home', sh(J("# don't read my config\n", HM, '/tmp/sb claude -p hi'), 'Bash'), /moving the engine's store/],
  ['bash -lc with the moved home', sh(J('bash -lc "cd /tmp && ', HM, '/x claude -p hi"'), 'Bash'), /moving the engine's store/],
  ['PowerShell, a path ending in a backslash before the moved home', sh(J('Set-Location "C:\\work\\"; $env:USER', 'PROFILE = "C:\\sb"; claude -p hi')), /moving the engine's store/],
  ['a grep for the assignment still blocks in a shell (the rule stays broad there)', sh(J('grep -n "', HM, '" docker-entrypoint.sh'), 'Bash'), /moving the engine's store/],
];

for (const [label, input, message] of BLOCK) {
  test(`blocks: ${label}`, () => {
    const v = judge(input);
    assert.ok(v, 'expected a block');
    assert.match(v, message);
  });
}

// Settings already holding a PermissionRequest hook the person installed (iTerm2's Claude integration adds one, a
// status reporter): keeping it is not adding one (10/9, Daian's Mac). Throwaway files, never the real settings.
test('settings: keeping an existing PermissionRequest hook passes; adding or changing one is refused', () => {
  const PR = J('Permission', 'Request');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrm-settings-'));
  const file = path.join(dir, '.claude', 'settings.json').replace(/\\/g, '/');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = { hooks: { [PR]: [{ matcher: '', hooks: [{ type: 'command', command: '~/.config/iterm2/cc-status' }] }] } };
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
  const withNotification = { hooks: { ...existing.hooks, Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: '~/.claude/hooks/tab-color.sh' }] }] } };
  const edit = (old_string, new_string) => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string, new_string } });
  // pass: a full rewrite that keeps it and adds a Notification hook
  assert.equal(judge(write(file, JSON.stringify(withNotification, null, 2))), null);
  // pass: an edit whose new text spans the existing block unchanged
  const block = JSON.stringify(existing.hooks, null, 2).slice(1, -1);
  const cur = fs.readFileSync(file, 'utf8');
  const span = cur.slice(cur.indexOf(`"${PR}"`), cur.lastIndexOf(']') + 1);
  assert.ok(span.length > 10 && block.length > 10);
  assert.equal(judge(edit(span, `${span},\n    "Stop": [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/tab-color.sh" }] }]`)), null);
  // refused: a second PermissionRequest hook
  const added = JSON.parse(JSON.stringify(existing));
  added.hooks[PR][0].hooks.push({ type: 'command', command: '~/.claude/hooks/answer.sh' });
  assert.match(judge(write(file, JSON.stringify(added))) || '', /rule: prompt-answerer/);
  // refused: the existing hook's command changed
  assert.match(judge(edit('~/.config/iterm2/cc-status', '~/.claude/hooks/answer.sh')) || '', /rule: prompt-answerer/);
  // refused: the key spelled with a JSON escape
  assert.match(judge(write(file, `{"hooks":{"Permission\\u0052equest":[{"hooks":[{"type":"command","command":"x"}]}]}}`)) || '', /rule: prompt-answerer/);
  // refused: a new settings file that brings one
  fs.unlinkSync(file);
  assert.match(judge(write(file, JSON.stringify(existing))) || '', /rule: prompt-answerer/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The block message names the rule and the token through the real hook path (run.sh -> guard.js).
test('the hook\'s message carries the rule and the matched token', (t) => {
  const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  const RUN = path.join(__dirname, '..', '..', 'guard', 'run.sh');
  const input = sh(J('[System.Windows.Forms.', SK, ']::SendWait("y")'));
  const scratch = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sbrmdv-fp-')); // blocks are recorded (1.11.6)
  const r = spawnSync(BASH, [RUN], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: scratch } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, new RegExp(`\\[rule: injection; matched: "${SK}\\]::SendWait" in a call that sends input\\]`));
});
