'use strict';
// Who may write (DESIGN.md §9, §10a), read LIVE from the environment's own Dataverse Write Access table
// (`sbrm_dataversewriteaccess`), through the person's own sign-in. Moved out of the toolkit's access.json
// on 10/7/26 (Dylan: the GitHub repo must stay public, so no staff emails in it).
//
//   - one row per person per environment: email (the key), level read | write | develop | admin
//     (lib/levels.js; the old `schema` reads as admin), may merge (yes/no; admin implies it);
//   - absent person = read; a row with an unknown level = read (never more than it says);
//   - NO row limit (ruled 10/7: "I dont think placing caps on writes makes sense"). The table's
//     Rows Per Approval column is no longer read; a big change is flagged instead (lib/severity.js);
//   - staff hold READ ONLY on the table, so nobody's Claude can grant itself anything, and the engine
//     refuses any job aimed at the toolkit's own tables unless the person is an admin;
//   - FAIL CLOSED: if the list cannot be read, every write in that environment is refused.
//
// Shape: { people: { email: { envs: { env: level }, merge: { env: bool }, name } } }.

const { normalize } = require('./levels');

const ACCESS_SET = 'sbrm_dataversewriteaccesses';
const LOG_TABLES = new Set(['sbrm_dataversewritelogs', 'sbrm_dataverseevents']);
const TOOLKIT_SETS = new Set([...LOG_TABLES, ACCESS_SET]);

// Tables that hold the APP itself, not data (10/7 blind review, CONFIRMED live: a flow's clientdata and
// state, a form's formxml and a connection reference's connection are all writable columns, so a records
// job at write level could rewrite a flow running as the app's service account, skipping the develop gate,
// the snapshot check, the "runs as" line and publish). A records job is refused on every one of them, at
// every level; app changes go through kind "component" / "schema", which check all of that.
const APP_DEFINITION_SETS = new Set([
  'workflows', 'systemforms', 'savedqueries', 'sitemaps', 'appmodules', 'appmodulecomponents', 'appactions',
  'connectionreferences', 'connectors', 'environmentvariabledefinitions', 'environmentvariablevalues',
  'solutions', 'solutioncomponents', 'publishers', 'webresourceset', 'customapis', 'customapirequestparameters',
  'customapiresponseproperties', 'pluginassemblies', 'plugintypes', 'sdkmessageprocessingsteps',
  'sdkmessageprocessingstepimages', 'serviceendpoints', 'roles', 'roleprivilegescollection', 'fieldsecurityprofiles',
  'fieldpermissions', 'systemusers', 'teams', 'businessunits', 'savedqueryvisualizations', 'duplicaterules',
  'duplicateruleconditions', 'processstages', 'workflowbinaries', 'flowmachines', 'flowsessions', 'msdyn_flow_actionapprovals',
  'canvasapps', 'botcomponents', 'bots', 'complexcontrols', 'customcontrols', 'ribboncustomizations', 'organizations',
  // added from the 10/7 re-verify: webhooks that fire on row events, process triggers, plug-in packages,
  // mail plumbing, app settings, connection instances
  'callbackregistrations', 'processtriggers', 'pluginpackages', 'mailboxes', 'emailserverprofiles', 'appsettings',
  'settingdefinitions', 'organizationsettings', 'connectioninstances', 'sdkmessagefilters', 'serviceplanmappings',
  'entityanalyticsconfigs', 'datalakeworkspaces', 'msdyn_dataflows', 'keyvaultreferences', 'credentials',
]);

function readAccess(dv, env) {
  let rows;
  try {
    rows = dv.get(`${ACCESS_SET}?$select=sbrm_name,sbrm_email,sbrm_level,sbrm_merge&$filter=${encodeURIComponent('statecode eq 0')}`).value || [];
  } catch (e) {
    throw Object.assign(new Error(`could not read the Dataverse Write Access list in this app (${String(e.message).slice(0, 160)}), so writes here are refused until it can be read. Ask Dylan.`), { code: 'access_unreadable' });
  }
  const people = {};
  for (const r of rows) {
    const email = String(r.sbrm_email || '').trim().toLowerCase();
    if (!email) continue;
    const p = { envs: { [env]: normalize(r.sbrm_level) }, merge: { [env]: r.sbrm_merge === true } };
    if (r.sbrm_name) p.name = String(r.sbrm_name);
    people[email] = p;
  }
  return { people };
}

// An `access` argument may be the object itself (tests, library callers) or a function the caller hands
// over to read it once the connection exists (apply connects inside).
function resolveAccess(access, dv, env) {
  return typeof access === 'function' ? access(dv, env) : access;
}

// Several environments' lists as one (the review's list of who may write anywhere).
function mergeAccessLists(lists) {
  const out = { people: {} };
  for (const l of lists) {
    for (const [email, p] of Object.entries(l.people || {})) {
      const o = out.people[email] || (out.people[email] = { envs: {}, merge: {} });
      Object.assign(o.envs, p.envs);
      Object.assign(o.merge, p.merge);
      if (p.name) o.name = p.name;
    }
  }
  return out;
}

module.exports = { readAccess, resolveAccess, mergeAccessLists, ACCESS_SET, TOOLKIT_SETS, LOG_TABLES, APP_DEFINITION_SETS };
