'use strict';
// The read connection's go-between (dataverse/mcp/proxy.js, 1.11.10). Kayleen's Mac, 10/13: the CLI's MCP
// server (1.0.81) crashed with SIGABRT whenever two requests were in flight, and Claude Code sends tools/list,
// prompts/list and resources/list together at every connect. The proxy answers the lists itself and sends the
// CLI one request at a time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const { createProxy, bridge } = require('../../mcp/proxy');

const req = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const note = (method, params) => JSON.stringify(params ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method });
const ans = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });

function rig(opts = {}) {
  const client = [];
  const server = [];
  const logs = [];
  const timers = [];
  const p = createProxy({
    toClient: (s) => client.push(JSON.parse(s)),
    toServer: (s) => server.push(JSON.parse(s)),
    log: (s) => logs.push(s),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    ...opts,
  });
  return { p, client, server, logs, timers };
}

test('the connect burst: prompts/resources answered here, the CLI only ever has ONE request', () => {
  const { p, client, server } = rig();
  p.fromClient(req(0, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.deepEqual(server.map((m) => m.method), ['initialize']);
  p.fromServer(ans(0, { protocolVersion: '2025-06-18', capabilities: { logging: {}, prompts: {}, resources: {}, tools: {} }, serverInfo: { name: 'dataverse' } }));
  assert.deepEqual(client[0].result.capabilities, { logging: {}, tools: {} }, 'prompts/resources taken out of initialize');
  assert.equal(client[0].result.serverInfo.name, 'dataverse', 'the rest of the answer untouched');

  p.fromClient(note('notifications/initialized'));
  p.fromClient(req(1, 'tools/list'));
  p.fromClient(req(2, 'prompts/list'));
  p.fromClient(req(3, 'resources/list'));
  p.fromClient(req(4, 'resources/templates/list'));
  assert.deepEqual(server.slice(1).map((m) => m.method), ['notifications/initialized', 'tools/list'], 'nothing else reached the CLI');
  assert.deepEqual(client.slice(1).map((m) => [m.id, Object.keys(m.result)[0]]), [[2, 'prompts'], [3, 'resources'], [4, 'resourceTemplates']]);
  assert.deepEqual(client[1].result.prompts, []);
  p.fromServer(ans(1, { tools: [{ name: 'read_query' }] }));
  assert.equal(client.at(-1).id, 1);
  assert.deepEqual(p.state(), { inflight: null, queued: 0 });
});

test('parallel tool calls go to the CLI one after another, in order', () => {
  const { p, client, server } = rig();
  p.fromClient(req('a', 'tools/call', { name: 'read_query' }));
  p.fromClient(req('b', 'tools/call', { name: 'search' }));
  p.fromClient(req('c', 'tools/call', { name: 'describe' }));
  assert.deepEqual(server.map((m) => m.id), ['a']);
  p.fromServer(ans('a', { ok: 1 }));
  assert.deepEqual(server.map((m) => m.id), ['a', 'b']);
  p.fromServer(ans('b', { ok: 2 }));
  p.fromServer(ans('c', { ok: 3 }));
  assert.deepEqual(server.map((m) => m.id), ['a', 'b', 'c']);
  assert.deepEqual(client.map((m) => m.id), ['a', 'b', 'c']);
});

test('numeric and string ids are different requests (1 is not "1")', () => {
  const { p, server } = rig();
  p.fromClient(req(1, 'tools/call'));
  p.fromClient(req('1', 'tools/call'));
  p.fromServer(ans('1', {})); // not the one in flight
  assert.equal(server.length, 1, 'the string-id answer did not release the numeric request');
  p.fromServer(ans(1, {}));
  assert.equal(server.length, 2);
});

test('ping is answered here, even while the CLI is busy', () => {
  const { p, client, server } = rig();
  p.fromClient(req(1, 'tools/call'));
  p.fromClient(req(2, 'ping'));
  assert.deepEqual(client, [{ jsonrpc: '2.0', id: 2, result: {} }]);
  assert.equal(server.length, 1);
});

test('a cancelled QUEUED request is never sent', () => {
  const { p, server, client } = rig();
  p.fromClient(req(1, 'tools/call'));
  p.fromClient(req(2, 'tools/call'));
  p.fromClient(note('notifications/cancelled', { requestId: 2, reason: 'timeout' }));
  p.fromServer(ans(1, {}));
  assert.deepEqual(server.map((m) => m.id), [1]);
  assert.deepEqual(client.map((m) => m.id), [1]);
});

test('a cancelled IN-FLIGHT request: cancel passed on; answered = normal; silent = queue moves on after the grace, late answer dropped', () => {
  // answered after the cancel
  let r = rig();
  r.p.fromClient(req(1, 'tools/call'));
  r.p.fromClient(req(2, 'tools/call'));
  r.p.fromClient(note('notifications/cancelled', { requestId: 1 }));
  assert.equal(r.server.at(-1).method, 'notifications/cancelled');
  assert.equal(r.timers[0].ms, 10000);
  r.p.fromServer(ans(1, {}));
  assert.ok(r.timers[0].cleared);
  assert.equal(r.server.at(-1).id, 2);

  // never answered
  r = rig();
  r.p.fromClient(req(1, 'tools/call'));
  r.p.fromClient(req(2, 'tools/call'));
  r.p.fromClient(note('notifications/cancelled', { requestId: 1 }));
  r.timers[0].fn();
  assert.equal(r.server.at(-1).id, 2, 'moved on');
  assert.match(r.logs[0], /cancelled and not answered/);
  r.p.fromServer(ans(1, { late: true }));
  assert.equal(r.client.length, 0, 'the late answer to the abandoned request is dropped');
  r.p.fromServer(ans(2, {}));
  assert.deepEqual(r.client.map((m) => m.id), [2]);
  assert.deepEqual(r.p.state(), { inflight: null, queued: 0 });
});

test('a stale cancel timer does not release a LATER request', () => {
  const r = rig();
  r.p.fromClient(req(1, 'tools/call'));
  r.p.fromClient(req(2, 'tools/call'));
  r.p.fromClient(note('notifications/cancelled', { requestId: 1 }));
  r.p.fromServer(ans(1, {})); // answered in time, request 2 now in flight
  r.timers[0].fn(); // the old timer fires anyway
  assert.equal(r.p.state().inflight, '2');
});

test("Claude Code's answer to the CLI's own request passes straight through while busy", () => {
  const { p, client, server } = rig();
  p.fromClient(req(1, 'tools/call'));
  p.fromServer(req('s1', 'ping'));
  assert.equal(client[0].method, 'ping', "the CLI's request reaches Claude Code");
  p.fromClient(ans('s1', {}));
  assert.deepEqual(server.map((m) => m.id), [1, 's1']);
  assert.equal(p.state().inflight, '1', 'still waiting on the tool call');
});

test("the CLI's non-JSON stdout (\"warn: ...\") is kept off the connection and logged", () => {
  const { p, client, logs } = rig();
  p.fromServer('warn: DataverseCli.Mcp[0] resources are not supported');
  p.fromServer('   ');
  assert.equal(client.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^not JSON, kept off the connection: warn:/);
});

// A stand-in CLI that behaves like 1.0.81 on Kayleen's Mac: it dies (exit 99, standing in for SIGABRT) the
// moment a second request arrives while one is unanswered. It answers each request after 30 ms, prints a
// "warn:" line like the real one, and advertises prompts/resources.
const FAKE = `
let buf = '', open = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined || m.method === undefined) continue;
    open += 1;
    if (open > 1) process.exit(99);
    setTimeout(() => {
      let result = {};
      if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { logging: {}, prompts: {}, resources: {}, tools: {} }, serverInfo: { name: 'dataverse', version: '1.0.81.0' } };
      if (m.method === 'tools/list') result = { tools: [{ name: 'read_query' }] };
      if (m.method === 'tools/call') result = { content: [{ type: 'text', text: m.params.name }] };
      process.stdout.write('warn: DataverseCli.Mcp[0] a log line on stdout\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      open -= 1;
    }, 30);
  }
});
process.stdin.on('end', () => process.exit(0));
`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-proxy-'));
const fakePath = path.join(dir, 'fake_cli.js');
fs.writeFileSync(fakePath, FAKE);

const BURST = [note('notifications/initialized'), req(2, 'tools/list'), req(3, 'prompts/list'), req(4, 'resources/list'),
  req(5, 'tools/call', { name: 'read_query' }), req(6, 'tools/call', { name: 'search' })];

function collect(stream, onMsg) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onMsg(l); }
  });
}

test('control: the stand-in CLI really dies on the connect burst when nothing is in between', async () => {
  const child = spawn(process.execPath, [fakePath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const code = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c));
    child.stdin.write(`${req(1, 'initialize')}\n`);
    setTimeout(() => { for (const l of BURST) child.stdin.write(`${l}\n`); }, 80);
  });
  assert.equal(code, 99);
});

test('through the bridge, the same burst against the same stand-in CLI: it survives and every request is answered', async () => {
  const child = spawn(process.execPath, [fakePath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const logs = [];
  bridge({ clientIn, clientOut, child, log: (s) => logs.push(s) });
  const got = new Map();
  const lines = [];
  let exited = null;
  child.on('exit', (c) => { exited = c; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out; got ${[...got.keys()]}`)), 5000);
    collect(clientOut, (l) => {
      lines.push(l);
      const m = JSON.parse(l);
      got.set(m.id, m);
      if (m.id === 1) for (const b of BURST) clientIn.write(`${b}\n`);
      if ([1, 2, 3, 4, 5, 6].every((id) => got.has(id))) { clearTimeout(t); resolve(); }
    });
    clientIn.write(`${req(1, 'initialize')}\n`);
  });
  assert.equal(exited, null, 'the stand-in CLI is still running');
  assert.deepEqual(Object.keys(got.get(1).result.capabilities).sort(), ['logging', 'tools']);
  assert.deepEqual(got.get(2).result.tools.map((x) => x.name), ['read_query']);
  assert.deepEqual(got.get(3).result, { prompts: [] });
  assert.deepEqual(got.get(4).result, { resources: [] });
  assert.equal(got.get(5).result.content[0].text, 'read_query');
  assert.equal(got.get(6).result.content[0].text, 'search');
  assert.ok(lines.every((l) => l.startsWith('{')), 'only JSON reached Claude Code');
  assert.ok(logs.some((s) => /^not JSON.*warn:/.test(s)));
  const ended = new Promise((resolve) => child.on('exit', resolve));
  clientIn.end(); // Claude Code closes the connection
  assert.equal(await ended, 0, 'closing the client side ends the CLI cleanly');
});
