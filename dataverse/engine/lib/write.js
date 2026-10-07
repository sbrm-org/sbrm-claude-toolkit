'use strict';
// The WRITE connection. Imported by apply.js ONLY; plan never sees it (cli.js is read-only).
// POST (create), PATCH (update) and the native Merge action. There is no DELETE anywhere in the engine (CONTRACT.md §8).
//
// Every PATCH carries If-Match with the record's version tag read at apply, so Dataverse itself
// refuses the write (412) if anyone changed the record between the apply-time check and the
// write. Tested 10/6: the CLI passes conditional headers through (If-None-Match -> 304).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request, resolveCli, getMany, FORMATTED } = require('./cli');
const store = require('./store');

function writeConnection(host, cli = resolveCli()) {
  const withBody = (method, apiPath, body, headers) => {
    const tmp = path.join(store.dir('tmp'), `body-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
    try {
      return request(cli, host, apiPath, { method, headers, bodyFile: tmp });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };
  return {
    host,
    cliVersion: cli.version,
    get(apiPath, { formatted = false } = {}) {
      return request(cli, host, apiPath, { method: 'GET', headers: formatted ? [FORMATTED] : [] });
    },
    create(set, body) {
      return withBody('POST', set, body, ['Prefer: return=representation']);
    },
    update(set, id, body, etag) {
      if (!etag) throw new Error('refusing to PATCH without a version tag (If-Match)');
      return withBody('PATCH', `${set}(${id})`, body, [`If-Match: ${etag}`]);
    },
    // Dataverse's native Merge action (DESIGN.md §8), the ONE action the engine can call. The path is
    // fixed here; nothing a job supplies can name another action.
    merge(body) {
      return withBody('POST', 'Merge', body, []);
    },
    getMany(paths, concurrency) {
      return getMany(cli, host, paths, concurrency);
    },
  };
}

module.exports = { writeConnection };
