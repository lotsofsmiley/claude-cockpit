'use strict';
/*
 * Survival test: proves a session OUTLIVES the GUI.
 *  1. Client A spawns a pwsh session, records the shell's $PID, writes MARKER_ALPHA.
 *  2. Client A disconnects  (== closing the GUI).
 *  3. Client B reconnects, lists + attaches, expects MARKER_ALPHA replayed from the
 *     ring buffer, then writes MARKER_BETA and reads the shell $PID again.
 *  PASS iff the shell PID is identical across the disconnect (same live process) AND
 *  the buffer replayed AND the session still accepts input after reconnect.
 *
 * Requires the daemon already running (npm run daemon).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const DAEMON_FILE = path.join(os.homedir(), '.coclaude-pit', 'daemon.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (e.g. window title)
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')           // CSI
  .replace(/\x1b[=>]/g, '');

function connect() {
  const d = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
  return new Promise((res, rej) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: d.token })));
    ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'hello-ok') res(ws); });
    ws.on('error', rej);
  });
}
function waitFor(ws, pred, timeout = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { ws.off('message', h); rej(new Error('timeout')); }, timeout);
    function h(raw) { const m = JSON.parse(raw.toString()); if (pred(m)) { clearTimeout(t); ws.off('message', h); res(m); } }
    ws.on('message', h);
  });
}
const collect = (ws, id, bag) => ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'data' && m.id === id) bag.s += m.data;
});

(async () => {
  console.log('--- coclaude-pit survival test ---');

  const a = await connect();
  a.send(JSON.stringify({ type: 'spawn', name: 'survivor', shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }));
  const sp = await waitFor(a, (m) => m.type === 'spawned');
  const id = sp.id;
  console.log('spawned session:', id);

  const bagA = { s: '' }; collect(a, id, bagA);
  await sleep(1200);
  a.send(JSON.stringify({ type: 'input', id, data: 'Write-Output "PIDTAG=$PID"; Write-Output MARKER_ALPHA\r\n' }));
  await sleep(2000);
  const cleanA = stripAnsi(bagA.s);
  const pidA = (cleanA.match(/PIDTAG=(\d+)/) || [])[1] || null;
  console.log(`A: shell PID=${pidA} | MARKER_ALPHA seen=${cleanA.includes('MARKER_ALPHA')}`);

  a.close();
  console.log('>> client A (GUI) disconnected; daemon should keep the shell alive');
  await sleep(1500);

  const b = await connect();
  b.send(JSON.stringify({ type: 'list' }));
  const list = await waitFor(b, (m) => m.type === 'sessions');
  const found = list.sessions.find((s) => s.id === id);
  console.log(`B: session in list=${!!found} alive=${found && found.alive}`);

  b.send(JSON.stringify({ type: 'attach', id }));
  const att = await waitFor(b, (m) => m.type === 'attached' && m.id === id);
  const replay = stripAnsi(att.buffer || '');
  console.log(`B: replay contains MARKER_ALPHA=${replay.includes('MARKER_ALPHA')}`);

  const bagB = { s: '' }; collect(b, id, bagB);
  b.send(JSON.stringify({ type: 'input', id, data: 'Write-Output "PIDTAG=$PID"; Write-Output MARKER_BETA\r\n' }));
  await sleep(2000);
  const cleanB = stripAnsi(bagB.s);
  const pidB = (cleanB.match(/PIDTAG=(\d+)/) || [])[1] || null;
  console.log(`B: shell PID=${pidB} | MARKER_BETA seen=${cleanB.includes('MARKER_BETA')}`);

  const samePid = !!pidA && pidA === pidB;
  const pass = samePid && replay.includes('MARKER_ALPHA') && cleanB.includes('MARKER_BETA') && found && found.alive;
  console.log('\n=== VERDICT ===');
  console.log(`same shell PID across disconnect/reconnect : ${samePid}  (A=${pidA}, B=${pidB})`);
  console.log(`ring buffer replayed on re-attach          : ${replay.includes('MARKER_ALPHA')}`);
  console.log(`session still interactive after reconnect  : ${cleanB.includes('MARKER_BETA')}`);
  console.log(pass ? 'RESULT: PASS  -- live session survived the GUI closing' : 'RESULT: FAIL');

  b.send(JSON.stringify({ type: 'kill', id }));
  await sleep(300);
  b.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('test error:', e); process.exit(2); });
