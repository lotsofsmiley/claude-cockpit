'use strict';
/*
 * coclaude-pit daemon
 * -------------------
 * Owns every PTY and OUTLIVES the GUI. Plain Node process (node-pty is built for
 * system Node, so the Electron GUI needs zero native modules and never rebuilds).
 * The GUI and the MCP server are just WebSocket clients that attach/detach.
 *
 * Survival model: closing/crashing the GUI only drops a WS client. The shell
 * processes keep running here. Reopen the GUI -> reconnect -> re-attach -> the
 * ring buffer replays recent output and you're back in the live session.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const VERSION = '0.0.1';
const HOST = '127.0.0.1';
const PORT = Number(process.env.COCLAUDE_PORT) || 4317;
const STATE_DIR = path.join(os.homedir(), '.coclaude-pit');
const DAEMON_FILE = path.join(STATE_DIR, 'daemon.json');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const CLAUDE_HOOKS_FILE = path.join(STATE_DIR, 'claude-hooks.json');
const ISLANDS_FILE = path.join(STATE_DIR, 'islands.json');
const STATE_BY_EVENT = {
  SessionStart: 'running', UserPromptSubmit: 'running',
  PreToolUse: 'running', PostToolUse: 'running',
  Notification: 'waiting', Stop: 'done', SessionEnd: 'idle',
};
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];
const MAX_BUFFER_BYTES = 256 * 1024;
const DEFAULT_SHELL = process.env.COCLAUDE_SHELL || 'powershell.exe';
const DEFAULT_SHELL_ARGS = process.env.COCLAUDE_SHELL_ARGS
  ? JSON.parse(process.env.COCLAUDE_SHELL_ARGS)
  : ['-NoLogo'];

fs.mkdirSync(STATE_DIR, { recursive: true });
const TOKEN = process.env.COCLAUDE_TOKEN || crypto.randomBytes(24).toString('hex');

/** @type {Map<string, any>} */
const sessions = new Map();
/** @type {Map<string, any>} island registry: id -> {id,name,color,collapsed,order} */
const islands = new Map();
try { JSON.parse(fs.readFileSync(ISLANDS_FILE, 'utf8')).forEach((i) => islands.set(i.id, i)); } catch { /* none yet */ }
/** connected clients: { ws, attached:Set<id>, authed:boolean } */
const clients = new Set();

const iso = () => new Date().toISOString();
const meta = (s) => ({
  id: s.id, name: s.name, color: s.color, cwd: s.cwd, shell: s.shell,
  cols: s.cols, rows: s.rows, createdAt: s.createdAt,
  alive: !!s.pty, lastExit: s.lastExit ?? null,
  state: s.state ?? null, stateAt: s.stateAt ?? null,
  island: s.island ?? null,
});

function safeSend(ws, data) { try { if (ws.readyState === ws.OPEN) ws.send(data); } catch { /* ignore */ } }

function persistSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.values()].map(meta), null, 2)); } catch { /* ignore */ }
}

// A Claude hook command that reports state to this daemon. Guarded by ADD_TERM_TAB_ID
// so it is a silent no-op when claude runs OUTSIDE a cockpit tab. URL+tab come from
// env the daemon stamps on each pty; the event is baked per-hook.
function hookCmd(event) {
  return 'powershell -NoProfile -Command "$b=[Console]::In.ReadToEnd(); '
    + 'if($env:ADD_TERM_TAB_ID){try{Invoke-RestMethod '
    + "-Uri ($env:COCLAUDE_HOOK_URL+'?tab='+$env:ADD_TERM_TAB_ID+'&event=" + event + "') "
    + '-Method Post -Body $b -ContentType \'application/json\' -TimeoutSec 2 | Out-Null}catch{}}"';
}
function writeClaudeHooks() {
  const hooks = {};
  for (const e of HOOK_EVENTS) hooks[e] = [{ hooks: [{ type: 'command', command: hookCmd(e) }] }];
  try { fs.writeFileSync(CLAUDE_HOOKS_FILE, JSON.stringify({ hooks }, null, 2)); } catch { /* ignore */ }
}

function persistIslands() {
  try { fs.writeFileSync(ISLANDS_FILE, JSON.stringify([...islands.values()], null, 2)); } catch { /* ignore */ }
}
function stateMsg() {
  return JSON.stringify({ type: 'sessions', sessions: [...sessions.values()].map(meta), islands: [...islands.values()] });
}
function broadcastSessions() {
  const msg = stateMsg();
  for (const c of clients) if (c.authed) safeSend(c.ws, msg);
}

function appendBuffer(s, data) {
  s.buffer.push(data);
  s.bufferBytes += Buffer.byteLength(data);
  while (s.bufferBytes > MAX_BUFFER_BYTES && s.buffer.length > 1) {
    s.bufferBytes -= Buffer.byteLength(s.buffer.shift());
  }
}

function spawnSession(opts = {}) {
  const id = crypto.randomUUID();
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const shell = opts.shell || DEFAULT_SHELL;
  const args = opts.args || DEFAULT_SHELL_ARGS;
  const cols = opts.cols || 80, rows = opts.rows || 24;
  const env = Object.assign({}, process.env, {
    ADD_TERM_TAB_ID: id,
    COCLAUDE_HOOK_URL: `http://${HOST}:${PORT}/hook`,
  });
  const p = pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env });
  const s = {
    id, name: opts.name || 'session', color: opts.color || null,
    cwd, shell, cols, rows, createdAt: iso(),
    pty: p, buffer: [], bufferBytes: 0, lastExit: null,
    state: null, stateAt: null, island: opts.island || null,
  };
  sessions.set(id, s);
  p.onData((data) => {
    appendBuffer(s, data);
    const msg = JSON.stringify({ type: 'data', id, data });
    for (const c of clients) if (c.attached.has(id)) safeSend(c.ws, msg);
  });
  p.onExit(({ exitCode }) => {
    s.lastExit = exitCode; s.pty = null;
    const msg = JSON.stringify({ type: 'exit', id, exitCode });
    for (const c of clients) if (c.attached.has(id)) safeSend(c.ws, msg);
    broadcastSessions(); persistSessions();
  });
  persistSessions();
  return s;
}

function handle(client, m) {
  const ws = client.ws;
  switch (m.type) {
    case 'list':
      safeSend(ws, stateMsg());
      break;
    case 'spawn': {
      const s = spawnSession(m);
      client.attached.add(s.id);
      safeSend(ws, JSON.stringify({ type: 'spawned', id: s.id, meta: meta(s) }));
      broadcastSessions();
      break;
    }
    case 'attach': {
      const s = sessions.get(m.id);
      if (!s) { safeSend(ws, JSON.stringify({ type: 'error', message: 'no such session' })); break; }
      client.attached.add(m.id);
      safeSend(ws, JSON.stringify({ type: 'attached', id: m.id, buffer: s.buffer.join(''), meta: meta(s) }));
      break;
    }
    case 'detach': client.attached.delete(m.id); break;
    case 'input': { const s = sessions.get(m.id); if (s && s.pty) s.pty.write(m.data); break; }
    case 'resize': {
      const s = sessions.get(m.id);
      if (s && s.pty) { try { s.pty.resize(m.cols, m.rows); s.cols = m.cols; s.rows = m.rows; } catch { /* ignore */ } }
      break;
    }
    case 'rename': {
      const s = sessions.get(m.id);
      if (s) { if (m.name != null) s.name = m.name; if (m.color !== undefined) s.color = m.color; broadcastSessions(); persistSessions(); }
      break;
    }
    case 'kill': {
      const s = sessions.get(m.id);
      if (s) { if (s.pty) { try { s.pty.kill(); } catch { /* ignore */ } } sessions.delete(m.id); broadcastSessions(); persistSessions(); }
      break;
    }
    case 'island-create': {
      const id = crypto.randomUUID();
      islands.set(id, { id, name: m.name || 'island', color: m.color || null, collapsed: false, order: islands.size });
      if (m.moveId) { const s = sessions.get(m.moveId); if (s) s.island = id; }
      persistIslands(); persistSessions(); broadcastSessions();
      safeSend(ws, JSON.stringify({ type: 'island-created', id }));
      break;
    }
    case 'island-update': {
      const i = islands.get(m.id);
      if (i) {
        if (m.name != null) i.name = m.name;
        if (m.color !== undefined) i.color = m.color;
        if (m.collapsed !== undefined) i.collapsed = !!m.collapsed;
        persistIslands(); broadcastSessions();
      }
      break;
    }
    case 'island-delete': {
      if (islands.delete(m.id)) {
        for (const s of sessions.values()) if (s.island === m.id) s.island = null;
        persistIslands(); persistSessions(); broadcastSessions();
      }
      break;
    }
    case 'session-move': {
      const s = sessions.get(m.id);
      if (s) { s.island = m.island || null; persistSessions(); broadcastSessions(); }
      break;
    }
    default: safeSend(ws, JSON.stringify({ type: 'error', message: 'unknown type ' + m.type }));
  }
}

// HTTP server: serves the Claude-hook webhook; the WebSocket server shares the port.
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url && req.url.startsWith('/hook')) {
    const u = new URL(req.url, `http://${HOST}`);
    const tab = u.searchParams.get('tab');
    const event = u.searchParams.get('event');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      const s = tab && sessions.get(tab);
      if (s) {
        const st = STATE_BY_EVENT[event];
        if (st) { s.state = st; s.stateAt = iso(); broadcastSessions(); }
      }
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });

server.listen(PORT, HOST, () => {
  writeClaudeHooks();
  fs.writeFileSync(DAEMON_FILE, JSON.stringify(
    { port: PORT, token: TOKEN, pid: process.pid, version: VERSION, startedAt: iso(), claudeSettings: CLAUDE_HOOKS_FILE }, null, 2));
  console.log(`[coclaude-pit] daemon v${VERSION} on http+ws://${HOST}:${PORT} (pid ${process.pid})`);
  console.log(`[coclaude-pit] state dir: ${STATE_DIR}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[coclaude-pit] port ${PORT} already in use — another daemon is running. Exiting.`);
    process.exit(0);
  }
  console.error('[coclaude-pit] server error', err);
  process.exit(1);
});

wss.on('connection', (ws) => {
  const client = { ws, attached: new Set(), authed: false };
  clients.add(client);
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!client.authed) {
      if (m.type === 'hello' && m.token === TOKEN) {
        client.authed = true;
        safeSend(ws, JSON.stringify({ type: 'hello-ok', daemon: { pid: process.pid, version: VERSION } }));
        safeSend(ws, stateMsg());
      } else {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'auth required' }));
        ws.close();
      }
      return;
    }
    handle(client, m);
  });
  ws.on('close', () => { clients.delete(client); });
  ws.on('error', () => {});
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
