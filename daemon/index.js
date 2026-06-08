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
const { exec, spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const VERSION = (() => { try { return require('../package.json').version; } catch { return '0.0.0'; } })();
const HOST = '127.0.0.1';
const PORT = Number(process.env.COCLAUDE_PORT) || 4317;
const STATE_DIR = path.join(os.homedir(), '.coclaude-pit');
const DAEMON_FILE = path.join(STATE_DIR, 'daemon.json');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const CLAUDE_HOOKS_FILE = path.join(STATE_DIR, 'claude-hooks.json');
const HOOK_SCRIPT_FILE = path.join(STATE_DIR, 'hook.ps1');
const ISLANDS_FILE = path.join(STATE_DIR, 'islands.json');
const MCP_CONFIG_FILE = path.join(STATE_DIR, 'mcp.json');
const MCP_SERVER_PATH = path.join(__dirname, '..', 'mcp', 'server.mjs');
const MEDIA_HELPER = path.join(__dirname, 'media-helper.ps1');
const MEDIA_CMD_FILE = path.join(STATE_DIR, 'media-cmd.txt');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
// Shipped defaults for a fresh user: generic session openers, no vault.
const DEFAULT_CONFIG = {
  templates: [
    { label: 'PowerShell', name: 'pwsh', shell: 'powershell.exe', args: ['-NoLogo'], cwd: null, color: null },
    { label: 'Claude (here)', name: 'claude', shell: 'powershell.exe', args: ['-NoLogo'], cwd: null, color: '#e3b341', claude: true },
  ],
  vaultPath: null,
};
const STATE_BY_EVENT = {
  SessionStart: 'running', UserPromptSubmit: 'running',
  PreToolUse: 'running', PostToolUse: 'running',
  Notification: 'waiting', Stop: 'done', SessionEnd: 'idle',
};
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];
const MAX_BUFFER_BYTES = 2 * 1024 * 1024; // ~2 MB of scrollback replayed on re-attach
const DEFAULT_SHELL = process.env.COCLAUDE_SHELL || 'powershell.exe';
const DEFAULT_SHELL_ARGS = process.env.COCLAUDE_SHELL_ARGS
  ? JSON.parse(process.env.COCLAUDE_SHELL_ARGS)
  : ['-NoLogo'];

fs.mkdirSync(STATE_DIR, { recursive: true });
const TOKEN = process.env.COCLAUDE_TOKEN || crypto.randomBytes(24).toString('hex');

// User config (session-opener templates + optional vault path). Created on first run.
let config;
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch { config = DEFAULT_CONFIG; try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch { /* ignore */ } }

/** @type {Map<string, any>} */
const sessions = new Map();
/** @type {Map<string, any>} island registry: id -> {id,name,color,collapsed,order} */
const islands = new Map();
try { JSON.parse(fs.readFileSync(ISLANDS_FILE, 'utf8')).forEach((i) => islands.set(i.id, i)); } catch { /* none yet */ }
const notifications = []; // Claude -> Filipe inbox (last 50)
let mediaState = null;   // { playing, status, title, artist, position, duration }
let mediaThumb = '';     // cached art data-URL (sent only when the track changes)
let mediaHelper = null;
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

// Kill a pty's whole process tree (shell -> claude -> claude's MCP servers). node-pty's
// kill leaves grandchildren orphaned on Windows, which is how claude/node processes pile up.
function killTree(pid) { if (pid) { try { exec(`taskkill /F /T /PID ${pid}`); } catch { /* ignore */ } } }

function persistSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.values()].map(meta), null, 2)); } catch { /* ignore */ }
}

// A Claude hook command that reports state to this daemon. Guarded by ADD_TERM_TAB_ID
// so it is a silent no-op when claude runs OUTSIDE a cockpit tab. URL+tab come from
// env the daemon stamps on each pty; the event is baked per-hook.
// Claude runs hooks through a POSIX shell on Windows, which would eat PowerShell
// $variables in an inline -Command. So the logic lives in a .ps1 file and the hook
// just invokes it by -File (no $ for the shell to mangle). Forward slashes keep the
// shell happy; env (ADD_TERM_TAB_ID / COCLAUDE_HOOK_URL) is read inside the script.
const HOOK_SCRIPT = [
  'param([string]$Event)',
  'try {',
  '  $body = [Console]::In.ReadToEnd()',
  '  if ($env:ADD_TERM_TAB_ID -and $env:COCLAUDE_HOOK_URL) {',
  '    $uri = "$($env:COCLAUDE_HOOK_URL)?tab=$($env:ADD_TERM_TAB_ID)&event=$Event"',
  '    Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType "application/json" -TimeoutSec 2 | Out-Null',
  '  }',
  '} catch { }',
  '',
].join('\r\n');
function hookCmd(event) {
  const p = HOOK_SCRIPT_FILE.replace(/\\/g, '/');
  // -WindowStyle Hidden stops a console window flashing on every hook fire.
  return `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${p}" -Event ${event}`;
}
function writeClaudeHooks() {
  try { fs.writeFileSync(HOOK_SCRIPT_FILE, HOOK_SCRIPT); } catch { /* ignore */ }
  const hooks = {};
  for (const e of HOOK_EVENTS) hooks[e] = [{ hooks: [{ type: 'command', command: hookCmd(e) }] }];
  try { fs.writeFileSync(CLAUDE_HOOKS_FILE, JSON.stringify({ hooks }, null, 2)); } catch { /* ignore */ }
}
// MCP config the cockpit's Claude templates load via --mcp-config, so a claude
// session running in a tab can operate the cockpit (spawn/rename/move/notify...).
function writeMcpConfig() {
  const server = { command: process.execPath, args: [MCP_SERVER_PATH] };
  if (process.versions.electron) server.env = { ELECTRON_RUN_AS_NODE: '1' }; // packaged: run our exe as Node
  const cfg = { mcpServers: { 'coclaude-pit': server } };
  try { fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch { /* ignore */ }
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

// Read the vault's open handoffs (title + priority) for the dashboard.
function readHandoffs() {
  if (!config.vaultPath) return [];
  const dir = path.join(config.vaultPath, '99-Meta', 'Handoffs');
  const rank = { high: 0, medium: 1, low: 2 };
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      let title = f.replace(/\.md$/, ''), priority = null;
      try {
        const txt = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000);
        const h = txt.match(/^#\s+(.+)$/m); if (h) title = h[1].trim();
        const p = txt.match(/\[P:(high|medium|low)\]/i) || txt.match(/priority:\s*(high|medium|low)/i);
        if (p) priority = p[1].toLowerCase();
      } catch { /* ignore one file */ }
      out.push({ file: f, title, priority });
    }
  } catch { /* no handoffs dir */ }
  out.sort((a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3));
  return out;
}

function broadcastMedia(payload) {
  const msg = JSON.stringify({ type: 'media', media: payload });
  for (const c of clients) if (c.authed) safeSend(c.ws, msg);
}
// Persistent hidden PowerShell helper reads Windows SMTC and streams JSON lines.
function startMediaHelper() {
  try {
    mediaHelper = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', MEDIA_HELPER],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    mediaHelper.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (!m.title) { if (mediaState) { mediaState = null; broadcastMedia(null); } continue; }
        const changed = !!m.thumb;
        if (changed) mediaThumb = m.thumb;
        mediaState = { playing: !!m.playing, status: m.status || '', title: m.title, artist: m.artist || '', position: m.position || 0, duration: m.duration || 0 };
        broadcastMedia(changed ? { ...mediaState, thumb: mediaThumb } : mediaState);
      }
    });
    mediaHelper.on('exit', () => { mediaHelper = null; });
  } catch { mediaHelper = null; }
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
    state: null, stateAt: null, lastDataAt: 0, island: opts.island || null,
  };
  sessions.set(id, s);
  p.onData((data) => {
    appendBuffer(s, data);
    s.lastDataAt = Date.now();
    if (s.state !== 'running') { s.state = 'running'; s.stateAt = iso(); broadcastSessions(); }
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
      if (s) {
        killTree(s.pty && s.pty.pid);
        if (s.pty) { try { s.pty.kill(); } catch { /* ignore */ } }
        sessions.delete(m.id); broadcastSessions(); persistSessions();
      }
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
    case 'read-buffer': {
      const s = sessions.get(m.id);
      const all = s ? s.buffer.join('') : '';
      const data = m.bytes ? all.slice(-Math.max(0, m.bytes)) : all;
      safeSend(ws, JSON.stringify({ type: 'buffer', id: m.id, data, found: !!s }));
      break;
    }
    case 'notify': {
      const note = { message: String(m.message || ''), level: m.level || 'info', sessionId: m.sessionId || null, at: iso() };
      notifications.push(note); if (notifications.length > 50) notifications.shift();
      const out = JSON.stringify({ type: 'notify', ...note });
      for (const c of clients) if (c.authed) safeSend(c.ws, out);
      break;
    }
    case 'dashboard':
      safeSend(ws, JSON.stringify({ type: 'dashboard-data', notifications, handoffs: readHandoffs(), hasVault: !!config.vaultPath }));
      break;
    case 'config':
      safeSend(ws, JSON.stringify({ type: 'config-data', templates: config.templates || [], vaultPath: config.vaultPath || null }));
      break;
    case 'config-save':
      if (Array.isArray(m.templates)) config.templates = m.templates;
      if (m.vaultPath !== undefined) config.vaultPath = m.vaultPath || null;
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch { /* ignore */ }
      safeSend(ws, JSON.stringify({ type: 'config-data', templates: config.templates || [], vaultPath: config.vaultPath || null }));
      break;
    case 'media-control':
      if (['playpause', 'next', 'prev', 'mute', 'volup', 'voldown'].includes(m.action)) { try { fs.writeFileSync(MEDIA_CMD_FILE, m.action); } catch { /* ignore */ } }
      break;
    case 'notify-clear':
      notifications.length = 0;
      safeSend(ws, JSON.stringify({ type: 'dashboard-data', notifications, handoffs: readHandoffs(), hasVault: !!config.vaultPath }));
      break;
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
        let st = STATE_BY_EVENT[event];
        // Notification fires both for "needs permission" (mid-turn) AND idle-after-done.
        // Only treat it as 'waiting' when the session is actually mid-turn, else every
        // finished turn would flip done -> waiting and falsely ping "waiting on you".
        if (event === 'Notification' && s.state !== 'running') st = null;
        if (st && st !== s.state) { s.state = st; s.stateAt = iso(); broadcastSessions(); }
      }
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });

server.listen(PORT, HOST, () => {
  writeMcpConfig();
  startMediaHelper();
  fs.writeFileSync(DAEMON_FILE, JSON.stringify(
    { port: PORT, token: TOKEN, pid: process.pid, version: VERSION, startedAt: iso(), mcpConfig: MCP_CONFIG_FILE }, null, 2));
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
        if (mediaState) safeSend(ws, JSON.stringify({ type: 'media', media: { ...mediaState, thumb: mediaThumb } }));
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

// Output-based activity: a running session that stops producing output for ~1.5s goes idle
// (back to green). Replaces the old per-event hooks, so there are no PowerShell spawns / popups.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.state === 'running' && s.pty && now - (s.lastDataAt || 0) > 1500) {
      s.state = null; s.stateAt = iso(); broadcastSessions();
    }
  }
}, 500);

process.on('SIGINT', () => { try { if (mediaHelper) mediaHelper.kill(); } catch { /* ignore */ } process.exit(0); });
process.on('SIGTERM', () => { try { if (mediaHelper) mediaHelper.kill(); } catch { /* ignore */ } process.exit(0); });
