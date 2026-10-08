'use strict';
// The approval pop-up (DESIGN.md §5, §6). Native, nothing installed:
//   Windows: a WinForms window through PowerShell, sent inline (-EncodedCommand), never a .ps1
//            file, because ThreatLocker blocks script files by hash (memory reference_threatlocker).
//   Mac:     AppleScript `display dialog` through osascript.
// Buttons: Show every change | Cancel | Approve. Cancel is the default (Enter = Cancel), Esc and
// closing the window are Cancel, and an unanswered dialog times out to Cancel.
//
// ONLY the exact answer APPROVE approves. Anything else, including an error, is a cancel.
// SBRM_DV_DIALOG_TIMEOUT can only SHORTEN the timeout, and a timeout is always Cancel, so the
// knob that lets a test close the window can never approve anything.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const store = require('./store');

const MAX_TIMEOUT = 540; // seconds: under the 600 s ceiling on a Claude command, so the pop-up cancels itself first

function timeoutSeconds(env = process.env) {
  const t = Number(env.SBRM_DV_DIALOG_TIMEOUT);
  return Number.isFinite(t) && t > 0 ? Math.min(t, MAX_TIMEOUT) : MAX_TIMEOUT;
}

const PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$text = [IO.File]::ReadAllText($env:SBRM_DV_DIALOG_TEXT, [Text.Encoding]::UTF8)
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:SBRM_DV_DIALOG_TITLE
$f.StartPosition = 'CenterScreen'; $f.TopMost = $true
$f.ClientSize = New-Object System.Drawing.Size(640, 420)
$f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true; $tb.ReadOnly = $true; $tb.ScrollBars = 'Vertical'; $tb.WordWrap = $true; $tb.TabStop = $false
$tb.BackColor = [System.Drawing.SystemColors]::Window
$tb.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$tb.Text = ($text -replace "\`r?\`n", "\`r\`n")
$tb.SetBounds(12, 12, 616, 350)
$show = New-Object System.Windows.Forms.Button; $show.Text = 'Show every change'; $show.SetBounds(12, 376, 170, 32); $show.DialogResult = 'Retry'
$cancel = New-Object System.Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.SetBounds(408, 376, 104, 32); $cancel.DialogResult = 'Cancel'
$ok = New-Object System.Windows.Forms.Button; $ok.Text = 'Approve'; $ok.SetBounds(524, 376, 104, 32); $ok.DialogResult = 'OK'
$f.Controls.AddRange(@($tb, $show, $cancel, $ok))
$f.AcceptButton = $cancel; $f.CancelButton = $cancel
$f.Add_Shown({ $f.Activate(); $cancel.Focus() })
$t = New-Object System.Windows.Forms.Timer
$t.Interval = [int]$env:SBRM_DV_DIALOG_TIMEOUT * 1000
$t.Add_Tick({ $t.Stop(); $f.DialogResult = 'Cancel'; $f.Close() })
$t.Start()
$r = $f.ShowDialog()
if ($r -eq 'OK') { 'APPROVE' } elseif ($r -eq 'Retry') { 'SHOW' } else { 'CANCEL' }
`;

const OSA = [
  'on run argv',
  'set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Show every change", "Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution giving up after ((item 3 of argv) as integer)',
  'if gave up of r then return "CANCEL"',
  'if button returned of r is "Approve" then return "APPROVE"',
  'if button returned of r is "Show every change" then return "SHOW"',
  'return "CANCEL"',
  'end run',
];

function askOnce(text, title, env = process.env) {
  const secs = timeoutSeconds(env);
  let r;
  if (process.platform === 'win32') {
    const tmp = path.join(store.dir('tmp', env), `dialog-${process.pid}.txt`);
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')], {
        encoding: 'utf8', timeout: (secs + 30) * 1000, windowsHide: false,
        env: { ...env, SBRM_DV_DIALOG_TEXT: tmp, SBRM_DV_DIALOG_TITLE: title, SBRM_DV_DIALOG_TIMEOUT: String(secs) },
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } else if (process.platform === 'darwin') {
    const args = OSA.flatMap((l) => ['-e', l]).concat([text, title, String(secs)]);
    r = spawnSync('osascript', args, { encoding: 'utf8', timeout: (secs + 30) * 1000 });
  } else {
    return { answer: 'CANCEL', note: 'no supported pop-up on this system (Windows or Mac only)' };
  }
  const out = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
  if (out === 'APPROVE' || out === 'SHOW') return { answer: out, raw: out };
  // A clean Cancel prints CANCEL. Anything else means the window failed; still a cancel, but say why.
  // (osascript's own Cancel button exits 1 with "User canceled", which is a clean cancel too.)
  const userCancel = process.platform === 'darwin' && /User cancel/i.test(r.stderr || '');
  const failed = out !== 'CANCEL' && !userCancel;
  return { answer: 'CANCEL', raw: out, note: failed ? `the pop-up did not run cleanly: ${(r.error && r.error.message) || (r.stderr || '').trim().slice(0, 300) || 'no answer'}` : null };
}

function openFile(file) {
  const cmd = process.platform === 'win32' ? ['notepad.exe', [file]] : ['open', ['-t', file]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* the dialog still works without the detail window */ }
}

// Loop until Approve or Cancel. "Show every change" opens the full detail, then asks again.
// The detail holds client records, so it is written inside the engine's store (never a shared
// temp folder) and deleted when the pop-up closes; the viewer has already loaded it.
function confirm({ summaryText, detailText, title }, { ask = askOnce, open = openFile, env = process.env } = {}) {
  const file = path.join(store.dir('tmp', env), `changes-${process.pid}.txt`);
  try {
    for (let i = 0; i < 20; i += 1) {
      const { answer, note } = ask(summaryText, title, env);
      if (answer === 'APPROVE') return { approved: true };
      if (answer !== 'SHOW') return { approved: false, note: note || null };
      fs.writeFileSync(file, detailText.replace(/\r?\n/g, os.EOL), 'utf8');
      open(file);
    }
    return { approved: false, note: 'asked too many times' };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

module.exports = { confirm, askOnce, timeoutSeconds, MAX_TIMEOUT };
