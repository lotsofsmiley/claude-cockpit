/*
 * Operator test (Phase 3):
 *  A) daemon level — read-buffer returns a session's output; notify broadcasts to clients.
 *  B) MCP level — boot mcp/server.mjs, do the JSON-RPC handshake, list tools, and call
 *     cockpit_list_sessions end-to-end (MCP -> daemon -> back).
 * Requires the daemon running.
 */
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(__dir, '..', 'mcp', 'server.mjs');
const DAEMON_FILE = path.join(os.homedir(), '.coclaude-pit', 'daemon.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = true;
const check = (name, cond) => { console.log(`${cond ? 'OK' : 'FAIL'}: ${name}`); if (!cond) pass = false; };

function connect() {
  const d = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
  ws._d = d;
  return new Promise((res, rej) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: d.token })));
    ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'hello-ok') res(ws); });
    ws.on('error', rej);
  });
}
function waitFor(ws, pred, t = 6000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => { ws.off('message', h); rej(new Error('timeout')); }, t);
    function h(raw) { const m = JSON.parse(raw.toString()); if (pred(m)) { clearTimeout(to); ws.off('message', h); res(m); } }
    ws.on('message', h);
  });
}

function rpcChannel(child) {
  let buf = ''; const waiters = [];
  child.stdout.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      for (let k = waiters.length - 1; k >= 0; k--) if (waiters[k].pred(m)) { const w = waiters.splice(k, 1)[0]; clearTimeout(w.t); w.res(m); }
    }
  });
  return {
    send: (o) => child.stdin.write(JSON.stringify(o) + '\n'),
    wait: (pred, timeout = 8000) => new Promise((res, rej) => { const w = { pred, res }; w.t = setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1); rej(new Error('rpc timeout')); }, timeout); waiters.push(w); }),
  };
}

(async () => {
  console.log('--- coclaude-pit operator test ---');

  // A) daemon: read-buffer + notify
  const a = await connect();
  a.send(JSON.stringify({ type: 'spawn', name: 'op-test', shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }));
  const sp = await waitFor(a, (m) => m.type === 'spawned');
  const id = sp.id;
  await sleep(900);
  a.send(JSON.stringify({ type: 'input', id, data: 'echo HELLO_OPERATOR\r' }));
  await sleep(1400);
  const buf = await new Promise((res) => { a.send(JSON.stringify({ type: 'read-buffer', id, bytes: 8000 })); waitFor(a, (m) => m.type === 'buffer' && m.id === id).then((m) => res(m.data)); });
  check('read-buffer returns session output', /HELLO_OPERATOR/.test(buf));

  const b = await connect();
  const tag = 'ping-operator-test';
  const gotNotify = waitFor(b, (m) => m.type === 'notify' && m.message === tag, 4000).then(() => true).catch(() => false);
  await sleep(100);
  a.send(JSON.stringify({ type: 'notify', message: tag, level: 'info' }));
  check('notify broadcasts to other clients', await gotNotify);
  a.send(JSON.stringify({ type: 'kill', id }));
  b.close();

  // B) MCP server: handshake + tools/list + tools/call
  const child = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write('[mcp stderr] ' + d));
  const rpc = rpcChannel(child);
  rpc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  const init = await rpc.wait((m) => m.id === 1);
  check('MCP initialize responds', !!init.result && !!init.result.serverInfo);
  rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  rpc.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tl = await rpc.wait((m) => m.id === 2);
  const names = ((tl.result && tl.result.tools) || []).map((t) => t.name);
  check('tools registered (>=10, incl. spawn/notify)', names.length >= 10 && names.includes('cockpit_spawn_session') && names.includes('cockpit_notify'));
  rpc.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cockpit_list_sessions', arguments: {} } });
  const tc = await rpc.wait((m) => m.id === 3);
  check('cockpit_list_sessions round-trips MCP->daemon', !!tc.result && !tc.result.isError && /sessions/.test(JSON.stringify(tc.result)));
  child.kill();

  console.log('\n=== VERDICT ===');
  console.log(pass ? 'RESULT: PASS  -- operator daemon commands + MCP server work' : 'RESULT: FAIL');
  a.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('test error:', e); process.exit(2); });
