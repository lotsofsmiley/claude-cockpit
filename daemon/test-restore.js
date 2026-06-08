'use strict';
/*
 * Reboot-restore test: proves sessions come back after the daemon DIES (reboot / battery
 * / crash) — not just after the GUI closes.
 *  1. Start a daemon in an isolated state dir + port (no touching the real ~/.coclaude-pit).
 *  2. Spawn two sessions: a renamed pwsh in an island, and a "claude" session.
 *  3. SIGKILL the daemon  (== power loss: no graceful shutdown).
 *  4. Start a fresh daemon on the same state dir + port.
 *  5. List: expect BOTH sessions back with the SAME id, name, cwd, island — alive again.
 *     For the claude session, the buffer must show `claude --resume <claudeId>` was typed.
 *  PASS iff metadata survived the kill AND the claude conversation was resumed by id.
 *
 * Self-contained: starts/stops its own daemons. Run: node daemon/test-restore.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 4319; // off the default 4317 so it never collides with a running daemon
const STATE_DIR = path.join(os.tmpdir(), 'coclaude-pit-test-' + process.pid);
const DAEMON_FILE = path.join(STATE_DIR, 'daemon.json');
const DAEMON_JS = path.join(__dirname, 'index.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b[=>]/g, '');

function startDaemon() {
  const child = spawn(process.execPath, [DAEMON_JS], {
    env: { ...process.env, COCLAUDE_PORT: String(PORT), COCLAUDE_STATE_DIR: STATE_DIR },
    stdio: 'ignore',
  });
  return child;
}
async function waitDaemonFile(timeoutMs = 8000) {
  for (let i = 0; i < timeoutMs / 100; i++) {
    try { const d = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8')); if (d.port === PORT) return d; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('daemon never wrote its state file');
}
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

(async () => {
  console.log('--- coclaude-pit reboot-restore test ---');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const cwd = STATE_DIR; // a real, existing dir we can assert survived

  let d1 = startDaemon();
  await waitDaemonFile();
  const a = await connect();

  // session 1: a renamed pwsh in an island
  a.send(JSON.stringify({ type: 'island-create', name: 'Ops' }));
  const islMsg = await waitFor(a, (m) => m.type === 'island-created');
  const islandId = islMsg.id;
  a.send(JSON.stringify({ type: 'spawn', name: 'pwsh-keep', shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd, island: islandId }));
  const s1 = await waitFor(a, (m) => m.type === 'spawned');
  a.send(JSON.stringify({ type: 'rename', id: s1.id, name: 'renamed-shell', color: '#e3b341' }));

  // session 2: a "claude" session (claude need not be installed — we only check the resume cmd)
  a.send(JSON.stringify({ type: 'spawn', name: 'claude-keep', shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd, claude: true }));
  const s2 = await waitFor(a, (m) => m.type === 'spawned');
  await sleep(1500); // let persistSessions + first launch settle

  // capture the captured claudeId from the persisted record
  const recsBefore = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'sessions.json'), 'utf8'));
  const claudeRec = recsBefore.find((r) => r.id === s2.id);
  const claudeId = claudeRec && claudeRec.claudeId;
  console.log(`before kill: ${recsBefore.length} sessions persisted; claudeId=${claudeId}`);
  a.close();

  // 3. simulate reboot/power-loss: hard-kill the daemon (no SIGTERM cleanup)
  d1.kill('SIGKILL');
  await sleep(1200);
  console.log('>> daemon SIGKILLed (simulated reboot/power loss)');

  // 4. fresh daemon, same state dir + port
  let d2 = startDaemon();
  await waitDaemonFile();
  await sleep(2500); // let restoreSessions re-spawn + type the resume command
  const b = await connect();
  b.send(JSON.stringify({ type: 'list' }));
  const list = await waitFor(b, (m) => m.type === 'sessions');

  const f1 = list.sessions.find((s) => s.id === s1.id);
  const f2 = list.sessions.find((s) => s.id === s2.id);
  const islandBack = list.islands.find((i) => i.id === islandId);
  console.log(`after restart: session1 back=${!!f1} name=${f1 && f1.name} island=${f1 && f1.island === islandId} cwd=${f1 && f1.cwd === cwd} alive=${f1 && f1.alive}`);
  console.log(`after restart: session2 back=${!!f2} name=${f2 && f2.name} alive=${f2 && f2.alive}`);
  console.log(`after restart: island '${islandBack && islandBack.name}' back=${!!islandBack}`);

  // claude session: the buffer must show the resume-by-id command was typed
  b.send(JSON.stringify({ type: 'attach', id: s2.id }));
  const att = await waitFor(b, (m) => m.type === 'attached' && m.id === s2.id);
  const buf = stripAnsi(att.buffer || '');
  const resumedById = !!claudeId && buf.includes(`--resume ${claudeId}`);
  console.log(`after restart: claude buffer shows '--resume ${claudeId}' = ${resumedById}`);

  const meta1Ok = f1 && f1.name === 'renamed-shell' && f1.color === '#e3b341' && f1.island === islandId && f1.cwd === cwd && f1.alive;
  const pass = !!meta1Ok && !!f2 && f2.alive && !!islandBack && resumedById;

  console.log('\n=== VERDICT ===');
  console.log(`pwsh session restored with name/color/island/cwd : ${!!meta1Ok}`);
  console.log(`claude session re-spawned + alive                : ${!!(f2 && f2.alive)}`);
  console.log(`island restored                                  : ${!!islandBack}`);
  console.log(`claude conversation resumed by id                : ${resumedById}`);
  console.log(pass ? 'RESULT: PASS  -- sessions survived a full daemon death' : 'RESULT: FAIL');

  // cleanup: kill restored sessions + daemon + temp dir
  for (const s of [s1.id, s2.id]) b.send(JSON.stringify({ type: 'kill', id: s }));
  await sleep(400);
  b.close();
  d2.kill('SIGKILL');
  await sleep(300);
  try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('test error:', e); try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(2); });
