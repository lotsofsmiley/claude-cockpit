'use strict';
/*
 * Reorder test: the 'reorder' command (sent by drag-drop) must stamp island + order onto each
 * session and order onto each island, and persist it.
 *  1. Spawn 3 pwsh sessions + 1 island (isolated daemon).
 *  2. Send a reorder placing s2,s3 into the island (in that order) and s1 ungrouped.
 *  3. Read sessions.json: s2/s3 -> island, order 0/1; s1 -> ungrouped.
 * Self-contained. Run: node daemon/test-reorder.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 4321;
const STATE = path.join(os.tmpdir(), 'cocpit-reorder-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon() {
  return spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, COCLAUDE_PORT: String(PORT), COCLAUDE_STATE_DIR: STATE }, stdio: 'ignore',
  });
}
function connect() {
  const d = JSON.parse(fs.readFileSync(path.join(STATE, 'daemon.json'), 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
  return new Promise((res, rej) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: d.token })));
    ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'hello-ok') res(ws); });
    ws.on('error', rej);
  });
}
function waitFor(ws, pred, t = 8000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => { ws.off('message', h); rej(new Error('timeout')); }, t);
    function h(raw) { const m = JSON.parse(raw.toString()); if (pred(m)) { clearTimeout(to); ws.off('message', h); res(m); } }
    ws.on('message', h);
  });
}
async function waitDaemon(ms = 8000) {
  for (let i = 0; i < ms / 100; i++) { try { JSON.parse(fs.readFileSync(path.join(STATE, 'daemon.json'), 'utf8')); return; } catch { /* wait */ } await sleep(100); }
  throw new Error('no daemon');
}
const recs = () => JSON.parse(fs.readFileSync(path.join(STATE, 'sessions.json'), 'utf8'));

(async () => {
  console.log('--- reorder test ---');
  fs.mkdirSync(STATE, { recursive: true });
  const d = startDaemon();
  await waitDaemon();
  const ws = await connect();
  const spawnOne = async (name) => { ws.send(JSON.stringify({ type: 'spawn', name, shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] })); return (await waitFor(ws, (m) => m.type === 'spawned')).id; };
  const s1 = await spawnOne('one'); const s2 = await spawnOne('two'); const s3 = await spawnOne('three');
  ws.send(JSON.stringify({ type: 'island-create', name: 'Box' }));
  const island = (await waitFor(ws, (m) => m.type === 'island-created')).id;

  ws.send(JSON.stringify({ type: 'reorder', groups: { [island]: [s2, s3], ungrouped: [s1] }, islands: [island] }));
  await sleep(800);

  const r = recs();
  const get = (id) => r.find((x) => x.id === id);
  const ok = get(s2).island === island && get(s2).order === 0 &&
             get(s3).island === island && get(s3).order === 1 &&
             (!get(s1).island) && get(s1).order === 0;
  console.log(`s2 -> island=${get(s2).island === island} order=${get(s2).order}`);
  console.log(`s3 -> island=${get(s3).island === island} order=${get(s3).order}`);
  console.log(`s1 -> ungrouped=${!get(s1).island} order=${get(s1).order}`);
  console.log('\n=== VERDICT ===');
  console.log(ok ? 'RESULT: PASS — reorder stamped island+order and persisted' : 'RESULT: FAIL');

  ws.close();
  try { d.kill('SIGKILL'); require('child_process').execSync('taskkill /F /T /PID ' + d.pid, { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('test error:', e); try { fs.rmSync(STATE, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(2); });
