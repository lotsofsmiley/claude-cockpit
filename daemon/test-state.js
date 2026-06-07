'use strict';
/*
 * State test: proves the daemon's /hook webhook drives per-session state, the way
 * Claude's hooks will. Spawns a session, POSTs each hook event, and checks the
 * session's broadcast state flips accordingly. Requires the daemon running.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const DAEMON_FILE = path.join(os.homedir(), '.coclaude-pit', 'daemon.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const d = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
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
async function postHook(d, tab, event) {
  const r = await fetch(`http://127.0.0.1:${d.port}/hook?tab=${tab}&event=${event}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, session_id: 'test' }),
  });
  return r.status;
}
async function stateOf(ws, id) {
  ws.send(JSON.stringify({ type: 'list' }));
  const m = await waitFor(ws, (x) => x.type === 'sessions');
  const s = m.sessions.find((s) => s.id === id);
  return s ? s.state : undefined;
}

(async () => {
  console.log('--- coclaude-pit state test ---');
  const ws = await connect();
  const d = ws._d;
  ws.send(JSON.stringify({ type: 'spawn', name: 'state-test', shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }));
  const sp = await waitFor(ws, (m) => m.type === 'spawned');
  const id = sp.id;
  console.log('spawned:', id);

  const checks = [['UserPromptSubmit', 'running'], ['Notification', 'waiting'], ['Stop', 'done'], ['SessionEnd', 'idle']];
  let pass = true;
  for (const [ev, want] of checks) {
    const code = await postHook(d, id, ev);
    await sleep(150);
    const got = await stateOf(ws, id);
    const ok = got === want && code === 200;
    if (!ok) pass = false;
    console.log(`POST ${ev.padEnd(16)} -> http ${code}, state='${got}' (want '${want}')  ${ok ? 'OK' : 'FAIL'}`);
  }
  console.log('\n=== VERDICT ===');
  console.log(pass ? 'RESULT: PASS  -- /hook drives per-session state' : 'RESULT: FAIL');
  ws.send(JSON.stringify({ type: 'kill', id }));
  await sleep(200); ws.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('test error:', e); process.exit(2); });
