'use strict';
/*
 * Claude-id capture test: a legacy picker tab (claude=true, claudeId=null) should LEARN its
 * conversation id from claude's session files once the GUI is viewing it and a recent .jsonl
 * appears in its project dir.
 *  1. Point the daemon at a temp HOME (so ~/.claude/projects and state are isolated).
 *  2. Seed a sessions.json with one legacy claude record (no id) -> daemon restores it.
 *  3. Attach to it (so it's the active tab) and drop a fresh <uuid>.jsonl in its project dir.
 *  4. Wait for the capture poller; sessions.json should now have claudeId = that uuid.
 * Self-contained. Run: node daemon/test-capture.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 4320;
const HOME = path.join(os.tmpdir(), 'cocpit-cap-' + process.pid);
const STATE = path.join(HOME, '.coclaude-pit');
const CWD = path.join(HOME, 'proj'); // the tab's working dir
const SLUG = CWD.replace(/[\\/:]/g, '-');
const PROJDIR = path.join(HOME, '.claude', 'projects', SLUG);
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TAB_ID = '11111111-2222-3333-4444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon() {
  return spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, USERPROFILE: HOME, HOME, COCLAUDE_PORT: String(PORT) },
    stdio: 'ignore',
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
async function waitDaemon(ms = 8000) {
  for (let i = 0; i < ms / 100; i++) { try { JSON.parse(fs.readFileSync(path.join(STATE, 'daemon.json'), 'utf8')); return; } catch { /* wait */ } await sleep(100); }
  throw new Error('daemon never started');
}
const readRec = () => JSON.parse(fs.readFileSync(path.join(STATE, 'sessions.json'), 'utf8')).find((r) => r.id === TAB_ID);

(async () => {
  console.log('--- claude-id capture test ---');
  fs.mkdirSync(CWD, { recursive: true });
  fs.mkdirSync(PROJDIR, { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });
  // seed a legacy picker record (no claudeId)
  fs.writeFileSync(path.join(STATE, 'sessions.json'), JSON.stringify([{
    id: TAB_ID, name: 'LEGACY', color: null, cwd: CWD, shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'],
    island: null, createdAt: new Date(0).toISOString(), claude: true, claudeId: null, resume: true,
    prompt: null, run: null, alive: true, lastExit: null,
  }]));

  const d = startDaemon();
  await waitDaemon();
  await sleep(1500);
  console.log('before: claudeId =', readRec().claudeId);

  const ws = await connect();
  ws.send(JSON.stringify({ type: 'attach', id: TAB_ID })); // make it the active tab
  await sleep(500);
  // a conversation file appears (as if the user picked/used it), with a fresh mtime
  fs.writeFileSync(path.join(PROJDIR, SESSION_ID + '.jsonl'), '{"type":"user"}\n');
  console.log('dropped', SESSION_ID + '.jsonl in project dir; waiting for capture…');

  let captured = null;
  for (let i = 0; i < 8; i++) { await sleep(1000); captured = readRec().claudeId; if (captured) break; }

  const pass = captured === SESSION_ID;
  console.log('\n=== VERDICT ===');
  console.log('captured claudeId        :', captured);
  console.log('matches dropped session  :', pass);
  console.log(pass ? 'RESULT: PASS — legacy tab learned its conversation id' : 'RESULT: FAIL');

  ws.close();
  try { d.kill('SIGKILL'); const cp = require('child_process'); cp.execSync('taskkill /F /T /PID ' + d.pid, { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('test error:', e); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(2); });
