---
name: sbrmapps-operator
description: >
  Operate SBRM's self-hosted app platform (Cloudron at my.sbrmapps.com) as an approved operator:
  check app health, restart or reconfigure an app, evaluate and install a new app, and record the
  change. Covers getting your own Cloudron API token, the rules every SBRM agent follows when adding
  to the platform, the install checklist, and verification. Platform facts and
  the full rule set live on the SBRM Wiki (Platform Ops book); this skill tells you what to read and
  in what order. Triggers on "cloudron", "sbrmapps", "my.sbrmapps.com", "the apps box",
  "install an app on cloudron", "add an app to the box", "self-host this for SBRM",
  "evaluate a self-hosted app", "which app should we use", "restart the cloudron app",
  "is the wiki down", "cloudron api token", "platform ops".
---

# SBRM app platform (Cloudron) for operators

SBRM runs its self-hosted apps (wiki, e-signature, bill intake, Grist, internal bots) on one Cloudron server. Dashboard: `https://my.sbrmapps.com`. Apps live at `<name>.sbrmapps.com`.

This skill is for approved platform operators. Everyone else: use the per-app skills (`bookstack`, `documenso`) and route platform requests to the administrator (Tim). Using an app never requires this skill.

## Read these first (every session, before any change)

The rules and the live facts are on the SBRM Wiki, book **Platform Ops** (restricted to IT & Systems and wiki admins). Fetch them with the `bookstack` skill and your own wiki token:

1. **Building principles**: what may and may not be built or installed, and why. These bind you the same way they bind the administrator's agent.
2. **Operator guide**: how the operators work together, the install checklist, known traps.
3. **App inventory**: what is installed now, app IDs, update policy, owner.

If you cannot read those pages (wiki down, 403, page missing), you may run read-only status checks and nothing else. Say which page you could not read and stop. Do not work from memory of an earlier session: the pages change.

If a wiki page and this skill disagree, the wiki page wins. Tell the operator about the mismatch so the skill gets fixed.

## Create your own API token

Tokens are personal to a machine and an agent. Never reuse someone else's token.

1. Sign in at `https://my.sbrmapps.com` with the operator login named on the wiki Operator guide (a personal account with the plain `user` role cannot administer apps, so a token minted under it will not work). Open the profile menu (top right), then **API Tokens**.
2. New token. Name it for the consumer: `claude-code-<yourname>-laptop`, not `token1`.
3. Scope: read and write only if you will make changes; read-only otherwise.
4. **Allowed IP ranges**: leave empty unless you always work from one network. A token pinned to a range returns `401` everywhere else, which looks exactly like an outage.
5. Copy the token when it is shown. It is shown once.
6. Store it in your password manager, then expose it to Claude as an environment variable:

```bash
# in your shell profile or secret store, never in a repo
export CLOUDRON_API_TOKEN="<token>"
```

**Working with Claude:** never paste the token into a conversation. Everything typed into a chat becomes part of the transcript. Claude reads the variable; it never prints it.

Creating or revoking a token is a security change: ask first. Record it in the **API tokens** table on the wiki App inventory page (token name, scope, IP range, date, holder; never the value) and tell the administrator. Tokens are managed only in the dashboard: an API token cannot list, create, or revoke tokens.

## Authenticating requests

```bash
command -v curl >/dev/null 2>&1 || { echo "Error: curl not found"; exit 1; }
[ -n "$CLOUDRON_API_TOKEN" ] || { echo "Error: CLOUDRON_API_TOKEN is not set"; exit 1; }
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $CLOUDRON_API_TOKEN" https://my.sbrmapps.com/api/v1/apps
```

`200` = working. `401` = token wrong, expired, or your IP is outside the token's allowed range (check that before assuming the server is down). Never `echo` the variable, and never run a command that would print request headers (`curl -v`) into the transcript.

## What you can do

| Task | Endpoint | Ask first? |
|---|---|---|
| List apps and health | `GET /api/v1/apps` | No |
| One app's detail | `GET /api/v1/apps/<id>` | No |
| Watch a task (install, update, backup) | `GET /api/v1/tasks/<taskId>` | No |
| Restart an app | `POST /api/v1/apps/<id>/restart` | Yes for staff-facing apps during the workday; see the Operator guide for hours and blackout windows (about 2 min of 502) |
| Back up the platform | `GET /api/v1/backup_sites` (two sites exist; the Operator guide names which to use), then `POST /api/v1/backup_sites/<siteId>/create_backup` | No |
| List backups | `GET /api/v1/backups` | No |
| Back up one app | `POST /api/v1/apps/<id>/backup` | No |
| Install an app | `POST /api/v1/apps` | Yes, after the checklist |
| Turn off automatic updates | `POST /api/v1/apps/<id>/configure/automatic_update` body `{"enable": false}` | Part of install |
| Set non-secret app env | `POST /api/v1/apps/<id>/configure/env`. **The call replaces the whole env block.** GET the app, merge your key into its existing `env`, POST the full block. Restarts the app | Yes |
| Current plan | `GET /api/v1/appstore/subscription` | No |

App IDs come from the App inventory page or from `GET /api/v1/apps`. The route source of truth is `git.cloudron.io/platform/box`, file `src/server.js`. Treat response shapes as unstable: check that the key you expect exists and fail loudly if it does not.

## Who decides
Your person decides; you propose. Reading, health checks, backups, and documentation edits need no permission. Before any change, say what it will do and how you would undo it, then wait for a yes. How the operators split decisions between themselves is on the wiki Operator guide and is informal for now: follow what that page says today, not what you remember.

Stop and make sure a real conversation has happened, whoever is asking, before: uninstalling an app, deleting or restoring a backup, anything that costs money, anything that changes how people sign in, anything that could put client or treatment data on the platform, or any exception to a building principle.

A yes for one action does not extend to the next one.

## Hard rules (the short list; the wiki page has the full set and the reasons)

1. **Administrative data only.** Client, treatment, and health records never go on this platform. An app that would hold them is not a Cloudron app.
2. **Adopt before you build.** Official Cloudron store package first, community package second, custom package last, and only after talking it through with Tim. Never fork an app, never patch its code in place.
3. **Cloudron owns the server.** No OS packages, no nginx or firewall edits, no new inbound ports. If the only way to make something work is to go around Cloudron, the answer is a different app or a different platform, not a workaround.
4. **Sign-in goes through Microsoft Entra.** Prefer apps where SSO-only can be set in configuration at install. Prove SSO with one account before switching passwords off. Keep the break-glass account.
5. **Secrets never go in Cloudron-level app env.** Any API token holder can read every app's env block. Secrets go in the package's own data-directory env file. An app gets only its own scoped credential, never a shared or master key.
6. **The human places secrets; the agent never touches them.** The operator pastes secret values in the dashboard File manager. The agent never reads, writes, downloads, or prints `/app/data/env*`, `env.sh`, or any app config file that can hold a credential, through the files API, the exec API, or the app terminal, for any app.
7. **Automatic updates off.** The platform's own weekly updater handles patch and minor updates, with a backup first. It covers every app automatically except those on its manual-only list.
8. **Every app ships with its documentation.** Inventory row, an `App:` page in Platform Ops, and a skill for operating it. An install without these is not finished.
9. **Alerts go to Teams or sbrm.org email** and each one names a cause and an action.

## Installing an app

0. **Evaluate first.** Run the gates on the Building principles page (data boundary, hosting lane, store package, SSO, agent operability, memory headroom, plan). Show the operator the result of each gate. Raise anything on the Operator guide's "worth raising" list before going further.
1. **Back up.** Trigger a platform backup and watch the task. Done means the task reads `success: true`, and `GET /api/v1/backups` shows a `type: box` entry whose `siteId` is the site you used and whose `creationTime` (UTC) is later than when you started. A backup merely dated today proves nothing: scheduled backups run every day.
2. **Hold monitoring.** The operator does this by hand as the Operator guide describes; the agent holds no credential for it. Ask for it and wait until the operator says it is on.
3. **Install** (after a yes). Cloudron creates the DNS record itself. Community packages install by versions URL (see the Operator guide). Watch the task to completion.
4. **Harden.** Public signup off. Automatic updates off (verify `enableAutomaticUpdate` is `false` on the app object). SSO configured and proven, then password login off. Backups cover the app.
5. **Verify** (next section).
6. **Release the monitoring hold** (operator, by hand) and confirm the new app appears in monitoring. A hold left on suspends all self-healing.
7. **Record.** Add the App inventory row. Create the `App:` wiki page from the template on the Operator guide. Open a pull request adding a per-app skill to this toolkit (no internal IDs or addresses: the repository is public).
8. **Send the change note** the Operator guide describes: what was installed and why, with the gate answers.

## Verification (after any change)

```bash
curl -s -H "Authorization: Bearer $CLOUDRON_API_TOKEN" https://my.sbrmapps.com/api/v1/apps \
| python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'apps' not in d:
    sys.exit('API error (401? check the token IP range): %s' % d)
for a in d['apps']:
    print(a.get('fqdn'), a.get('runState'), a.get('health'), 'autoUpdate=%s' % a.get('enableAutomaticUpdate'))"
```

Every app should read `running healthy`. Then request the changed app's URL and check for `200`. Show this output in the same message as any claim that the work is done.

## Before you report done

Re-read the Hard rules and the install checklist against what you actually did. Name any step you skipped and why. State the final state of the monitoring hold. If a rule was bent, say so plainly: the administrator would rather hear it from you than find it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401` on every call | Token expired, or your network is outside the token's allowed IP range |
| `401` on `/api/v1/tokens` only | Normal. Tokens are managed in the dashboard, never by API token |
| `402 app limit reached` | Plan problem: administrator |
| Several apps slow or failing at once | Check disk and memory on the dashboard System page first. Local backups filling the disk is the classic failure |
| `400 memoryLimit too small` | You set a limit below the package's minimum. The limit is a cap, not a reservation |
| App shows `502` for a minute or two | Normal after restart or server reboot. Retry before diagnosing |
| Role or group options missing in the dashboard | Not included in SBRM's plan. Do not try to enable them |

## Boundaries

No shell access to the server is needed or provided for operators: everything here works through the API and the dashboard. Server-level work (firewall, OS, private networking, restore, rebuild) belongs to the administrator.
