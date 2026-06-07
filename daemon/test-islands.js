'use strict';
/* Islands test: exercises the daemon island registry + session assignment +
 * persistence, via the WS protocol. Requires the daemon running. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const DAEMON_FILE = path.join(os.homedir(), '.coclaude-pit', 'daemon.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const d = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
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
const snap = (ws) => { ws.send(JSON.stringify({ type: 'list' })); return waitFor(ws, (m) => m.type === 'sessions'); };

let pass = true;
const check = (name, cond) => { console.log(`${cond ? 'OK' : 'FAIL'}: ${name}`); if (!cond) pass = false; };

(async () => {
  console.log('--- coclaude-pit islands test ---');
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'spawn', name: 'isltest', shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }));
  const sp = await waitFor(ws, (m) => m.type === 'spawned');
  const sid = sp.id;

  ws.send(JSON.stringify({ type: 'island-create', name: 'Infra', moveId: sid }));
  const ic = await waitFor(ws, (m) => m.type === 'island-created');
  const iid = ic.id;
  await sleep(150); let s = await snap(ws);
  check('island appears in list', s.islands.some((i) => i.id === iid && i.name === 'Infra'));
  check('session assigned to island', (s.sessions.find((x) => x.id === sid) || {}).island === iid);

  ws.send(JSON.stringify({ type: 'island-update', id: iid, collapsed: true, color: '#7aa2f7', name: 'Infrastructure' }));
  await sleep(150); s = await snap(ws);
  const isl = s.islands.find((i) => i.id === iid) || {};
  check('island collapsed', isl.collapsed === true);
  check('island color set', isl.color === '#7aa2f7');
  check('island renamed', isl.name === 'Infrastructure');

  ws.send(JSON.stringify({ type: 'session-move', id: sid, island: null }));
  await sleep(150); s = await snap(ws);
  check('session ungrouped', (s.sessions.find((x) => x.id === sid) || {}).island === null);

  ws.send(JSON.stringify({ type: 'island-delete', id: iid }));
  await sleep(150); s = await snap(ws);
  check('island deleted', !s.islands.some((i) => i.id === iid));
  check('islands.json persisted', fs.existsSync(path.join(os.homedir(), '.coclaude-pit', 'islands.json')));

  console.log('\n=== VERDICT ===');
  console.log(pass ? 'RESULT: PASS  -- island registry + assignment + persistence' : 'RESULT: FAIL');
  ws.send(JSON.stringify({ type: 'kill', id: sid }));
  await sleep(200); ws.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('test error:', e); process.exit(2); });
