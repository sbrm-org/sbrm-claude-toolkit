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
$typed = $env:SBRM_DV_DIALOG_TYPED
$show = New-Object System.Windows.Forms.Button; $show.Text = 'Show every change'; $show.SetBounds(12, 376, 170, 32); $show.DialogResult = 'Retry'
$cancel = New-Object System.Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.SetBounds(408, 376, 104, 32); $cancel.DialogResult = 'Cancel'
$ok = New-Object System.Windows.Forms.Button; $ok.Text = 'Approve'; $ok.SetBounds(524, 376, 104, 32); $ok.DialogResult = 'OK'
if ($typed) {
  $tb.SetBounds(12, 12, 616, 290)
  $lbl = New-Object System.Windows.Forms.Label; $lbl.SetBounds(12, 310, 616, 22); $lbl.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $lbl.Text = 'To approve this delete, type: ' + $typed
  $in = New-Object System.Windows.Forms.TextBox; $in.SetBounds(12, 336, 616, 26); $in.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $ok.Enabled = $false
  $in.Add_TextChanged({ $ok.Enabled = ($in.Text.Trim().ToLower() -eq $typed.Trim().ToLower()) })
  $f.Controls.AddRange(@($tb, $lbl, $in, $show, $cancel, $ok))
} else {
  $tb.SetBounds(12, 12, 616, 350)
  $f.Controls.AddRange(@($tb, $show, $cancel, $ok))
}
$f.AcceptButton = $cancel; $f.CancelButton = $cancel
$f.Add_Shown({ $f.Activate(); $cancel.Focus() })
$t = New-Object System.Windows.Forms.Timer
$t.Interval = [int]$env:SBRM_DV_DIALOG_TIMEOUT * 1000
$t.Add_Tick({ $t.Stop(); $f.DialogResult = 'Cancel'; $f.Close() })
$t.Start()
$r = $f.ShowDialog()
if ($r -eq 'OK' -and $typed) { 'TYPED:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($in.Text)) }
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

// A delete (ruled 10/7: admin deletes, with the object's name typed): the same dialog with a text field.
// The typed text comes back on its own line; Node compares it (the Mac dialog cannot hold Approve shut).
const OSA_TYPED = [
  'on run argv',
  'set r to display dialog ((item 1 of argv) & return & return & "To approve this delete, type: " & (item 4 of argv)) default answer "" with title (item 2 of argv) buttons {"Show every change", "Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution giving up after ((item 3 of argv) as integer)',
  'if gave up of r then return "CANCEL"',
  'if button returned of r is "Approve" then return "TYPED:" & (text returned of r) & linefeed & "APPROVE"',
  'if button returned of r is "Show every change" then return "SHOW"',
  'return "CANCEL"',
  'end run',
];

function sameTyped(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function askOnce(text, title, env = process.env, typed = null) {
  const secs = timeoutSeconds(env);
  let r;
  if (process.platform === 'win32') {
    const tmp = path.join(store.dir('tmp', env), `dialog-${process.pid}.txt`);
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')], {
        encoding: 'utf8', timeout: (secs + 30) * 1000, windowsHide: false,
        env: { ...env, SBRM_DV_DIALOG_TEXT: tmp, SBRM_DV_DIALOG_TITLE: title, SBRM_DV_DIALOG_TIMEOUT: String(secs), SBRM_DV_DIALOG_TYPED: typed || '' },
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } else if (process.platform === 'darwin') {
    const args = (typed ? OSA_TYPED : OSA).flatMap((l) => ['-e', l]).concat([text, title, String(secs), ...(typed ? [typed] : [])]);
    r = spawnSync('osascript', args, { encoding: 'utf8', timeout: (secs + 30) * 1000 });
  } else {
    return { answer: 'CANCEL', note: 'no supported pop-up on this system (Windows or Mac only)' };
  }
  const lines = (r.stdout || '').trim().split(/\r?\n/);
  const out = lines.pop() || '';
  if (out === 'APPROVE' && typed) {
    // Approve on a delete counts only with the exact name typed (Windows holds the button shut until it
    // matches; the Mac dialog cannot, so this check is the one that counts on both).
    const t = lines.reverse().find((l) => l.startsWith('TYPED:'));
    const got = !t ? null : process.platform === 'win32' ? Buffer.from(t.slice(6), 'base64').toString('utf8') : t.slice(6);
    if (!sameTyped(got, typed)) return { answer: 'CANCEL', raw: out, note: `approve needs "${typed}" typed exactly; ${got ? `"${got}" was typed` : 'nothing was typed'}, so nothing was deleted` };
    return { answer: 'APPROVE', raw: out };
  }
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
function confirm({ summaryText, detailText, title, typed = null }, { ask = askOnce, open = openFile, env = process.env } = {}) {
  const file = path.join(store.dir('tmp', env), `changes-${process.pid}.txt`);
  // While the pop-up waits, a marker tells the guard to refuse any tool that drives the screen, mouse or
  // keyboard (10/7 third pass: an apply run in the background plus a screen tool could press Approve).
  const marker = path.join(store.dir('tmp', env), `popup-open-${process.pid}`);
  try { fs.writeFileSync(marker, new Date().toISOString(), 'utf8'); } catch { /* the pop-up still works */ }
  try {
    for (let i = 0; i < 20; i += 1) {
      const { answer, note } = ask(summaryText, title, env, typed);
      if (answer === 'APPROVE') return { approved: true };
      if (answer !== 'SHOW') return { approved: false, note: note || null };
      fs.writeFileSync(file, detailText.replace(/\r?\n/g, os.EOL), 'utf8');
      open(file);
    }
    return { approved: false, note: 'asked too many times' };
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(marker, { force: true });
  }
}

module.exports = { confirm, askOnce, timeoutSeconds, sameTyped, MAX_TIMEOUT };
