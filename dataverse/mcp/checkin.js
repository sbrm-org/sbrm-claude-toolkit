#!/usr/bin/env node
'use strict';
// The version check-in child (1.11.9, DESIGN.md §12c), started by launch.js beside a read connection:
//   node checkin.js --app <env> --host <url> --uptime-ms <n> --trigger start|hourly
// Thin on purpose: the logic is engine/lib/checkin.js. It prints nothing (stdio is ignored), always exits 0,
// and ends itself after two minutes if the Dataverse CLI hangs on the send.

const kill = setTimeout(() => process.exit(0), 120000);
if (kill.unref) kill.unref();

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

(async () => {
  try {
    await require('../engine/lib/checkin').runCheck({
      app: arg('app'), host: arg('host'), uptimeMs: Number(arg('uptime-ms')) || 0, trigger: arg('trigger') === 'hourly' ? 'hourly' : 'start',
    });
  } catch { /* nobody to tell; the next check tries again */ }
  process.exit(0);
})();
