'use strict';
/* Renderer: pure browser context, talks to the daemon over WebSocket only.
 * Phase 1 tabs + Phase 2 Claude-state + tab islands (named/colored/collapsible groups). */

const VAULT = 'C:\\add\\vaults\\ADD-Vault';
const TEMPLATES = [
  { label: 'PowerShell · home',  name: 'pwsh',         shell: 'powershell.exe', args: ['-NoLogo'], cwd: null,           color: null },
  { label: 'PowerShell · vault', name: 'vault',        shell: 'powershell.exe', args: ['-NoLogo'], cwd: VAULT,          color: '#7aa2f7' },
  { label: 'Claude · vault',     name: 'claude:vault', shell: 'powershell.exe', args: ['-NoLogo'], cwd: VAULT,          color: '#e3b341', claude: true },
  { label: 'PowerShell · dev',   name: 'dev',          shell: 'powershell.exe', args: ['-NoLogo'], cwd: 'C:\\add\\dev', color: null },
];
const COLORS = ['#3fb950', '#7aa2f7', '#e3b341', '#f85149', '#bc8cff', '#39c5cf', '#ff9e64'];

const daemon = window.cockpit && window.cockpit.daemon;
const statusEl = document.getElementById('status');
const tabsEl = document.getElementById('tabs');
const appEl = document.getElementById('app');
const newMenu = document.getElementById('newMenu');
const tabMenu = document.getElementById('tabMenu');

const term = new Terminal({
  fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13,
  cursorBlink: true, theme: { background: '#0b0d10', foreground: '#cdd6e4' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();
// Keep keystrokes landing in the active session: clicking the terminal area or
// re-focusing the window always returns focus to xterm's input.
document.getElementById('main').addEventListener('mousedown', () => setTimeout(() => term.focus(), 0));
window.addEventListener('focus', () => term.focus());

let ws = null;
let activeId = null;
let bootstrapped = false;
let daemonLabel = '';
let islandList = [];                 // [{id,name,color,collapsed,order}]
let renameIslandId = null;           // island to inline-rename on next render (just created)
const sessions = new Map();
const prevState = new Map();
const pendingSpawns = [];

const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const firstId = () => (sessions.size ? [...sessions.keys()][0] : null);

function stateColor(s) {
  switch (s.state) {
    case 'running': return '#7aa2f7'; // working
    case 'waiting': return '#e3b341'; // needs you
    case 'done':    return '#3fb950'; // finished, your turn
    case 'idle':    return '#5c6675'; // ended
    default:        return s.color || (s.alive ? '#3fb950' : '#f85149');
  }
}
function notifyWaiting(s) {
  try { new Notification('coclaude-pit', { body: `${s.name || 'session'} is waiting on you` }); } catch (_) { /* ignore */ }
}
function setStatus() {
  statusEl.textContent = sessions.size ? daemonLabel : (daemonLabel ? daemonLabel + ' · click + to start' : 'connecting…');
}

/* ---- rail rendering (islands + ungrouped) ---- */
function buildTab(s) {
  const el = document.createElement('div');
  el.className = 'tab' + (s.id === activeId ? ' active' : '') + (s.island ? ' in-island' : '');
  el.dataset.id = s.id;

  const dot = document.createElement('span');
  dot.className = 'dot' + (s.state === 'running' || s.state === 'waiting' ? ' pulse' : '');
  dot.style.background = stateColor(s);
  dot.title = s.state ? `claude: ${s.state}` : (s.alive ? 'running' : 'exited');

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name || 'session';
  name.title = `${s.name} — ${s.cwd}`;
  name.ondblclick = (e) => { e.stopPropagation(); startRenameTab(el, s); };

  const x = document.createElement('span');
  x.className = 'x'; x.textContent = '×'; x.title = 'Close session';
  x.onclick = (e) => { e.stopPropagation(); closeTab(s.id); };

  el.append(dot, name, x);
  el.onclick = () => attach(s.id);
  el.oncontextmenu = (e) => { e.preventDefault(); openTabMenu(e.clientX, e.clientY, s.id); };
  return el;
}

function buildIslandHeader(isl, count) {
  const el = document.createElement('div');
  el.className = 'island-hdr';
  el.dataset.island = isl.id;

  const caret = document.createElement('span');
  caret.className = 'caret'; caret.textContent = isl.collapsed ? '▸' : '▾';

  const sq = document.createElement('span');
  sq.className = 'isq'; if (isl.color) sq.style.background = isl.color;

  const name = document.createElement('span');
  name.className = 'iname'; name.textContent = isl.name || 'island';
  name.ondblclick = (e) => { e.stopPropagation(); startRenameIsland(el, isl); };

  const cnt = document.createElement('span');
  cnt.className = 'icount'; cnt.textContent = count;

  el.append(caret, sq, name, cnt);
  el.onclick = () => send({ type: 'island-update', id: isl.id, collapsed: !isl.collapsed });
  el.oncontextmenu = (e) => { e.preventDefault(); openIslandMenu(e.clientX, e.clientY, isl.id); };
  return el;
}

function renderRail() {
  tabsEl.innerHTML = '';
  const byIsland = new Map();
  const ungrouped = [];
  for (const s of sessions.values()) {
    if (s.island && islandList.some((i) => i.id === s.island)) {
      if (!byIsland.has(s.island)) byIsland.set(s.island, []);
      byIsland.get(s.island).push(s);
    } else ungrouped.push(s);
  }
  const ordered = [...islandList].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const isl of ordered) {
    const members = byIsland.get(isl.id) || [];
    const hdr = buildIslandHeader(isl, members.length);
    tabsEl.appendChild(hdr);
    if (renameIslandId === isl.id) { startRenameIsland(hdr, isl); renameIslandId = null; }
    if (!isl.collapsed) members.forEach((s) => tabsEl.appendChild(buildTab(s)));
  }
  ungrouped.forEach((s) => tabsEl.appendChild(buildTab(s)));
  setStatus();
}

/* ---- actions ---- */
function attach(id) {
  if (id === activeId || !sessions.has(id)) return;
  activeId = id; term.clear();
  send({ type: 'attach', id });
  renderRail();
  term.focus(); // a tab click must leave you ready to type immediately
}
function inlineRename(hostEl, oldEl, current, onSave) {
  const input = document.createElement('input');
  input.className = 'rename'; input.value = current || '';
  const done = (save) => {
    if (input.parentNode !== hostEl) return;
    const v = input.value.trim();
    hostEl.replaceChild(oldEl, input);
    if (save && v && v !== current) onSave(v);
  };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
  input.onblur = () => done(true);
  hostEl.replaceChild(input, oldEl);
  input.focus(); input.select();
}
function startRenameTab(tabEl, s) {
  inlineRename(tabEl, tabEl.querySelector('.name'), s.name, (v) => send({ type: 'rename', id: s.id, name: v }));
}
function startRenameIsland(hdrEl, isl) {
  inlineRename(hdrEl, hdrEl.querySelector('.iname'), isl.name, (v) => send({ type: 'island-update', id: isl.id, name: v }));
}
function closeTab(id) {
  const s = sessions.get(id);
  const label = s ? (s.name || 'session') : 'session';
  if (window.confirm(`Close "${label}"? This kills the session and any process in it.`)) send({ type: 'kill', id });
}
function spawnTemplate(t) { pendingSpawns.push(t); send({ type: 'spawn', name: t.name, color: t.color, cwd: t.cwd, shell: t.shell, args: t.args }); }

/* ---- menus ---- */
function hideMenus() { newMenu.classList.add('hidden'); tabMenu.classList.add('hidden'); }
function placeMenu(menu, x, y) {
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
function item(text, onClick, cls) {
  const it = document.createElement('div');
  it.className = 'item' + (cls ? ' ' + cls : ''); it.textContent = text;
  it.onclick = onClick; return it;
}
function label(text) { const l = document.createElement('div'); l.className = 'label'; l.textContent = text; return l; }
function sep() { const s = document.createElement('div'); s.className = 'sep'; return s; }
function swatchRow(onPick) {
  const sw = document.createElement('div'); sw.className = 'swatches';
  const none = document.createElement('span'); none.className = 'swatch none'; none.title = 'default';
  none.onclick = () => onPick(null); sw.appendChild(none);
  COLORS.forEach((c) => { const s = document.createElement('span'); s.className = 'swatch'; s.style.background = c; s.onclick = () => onPick(c); sw.appendChild(s); });
  return sw;
}

function openNewMenu(x, y) {
  newMenu.innerHTML = '';
  newMenu.appendChild(label('New session'));
  TEMPLATES.forEach((t) => newMenu.appendChild(item(t.label, () => { hideMenus(); spawnTemplate(t); })));
  newMenu.appendChild(sep());
  newMenu.appendChild(item('＋ New island', () => { hideMenus(); createIsland(); }));
  placeMenu(newMenu, x, y);
}

function openTabMenu(x, y, id) {
  tabMenu.innerHTML = '';
  tabMenu.appendChild(item('Rename', () => { hideMenus(); const el = tabsEl.querySelector(`.tab[data-id="${id}"]`); if (el) startRenameTab(el, sessions.get(id)); }));
  tabMenu.appendChild(label('Color'));
  tabMenu.appendChild(swatchRow((c) => { hideMenus(); send({ type: 'rename', id, color: c }); }));
  tabMenu.appendChild(sep());
  tabMenu.appendChild(label('Move to island'));
  islandList.forEach((isl) => tabMenu.appendChild(item('▸ ' + (isl.name || 'island'), () => { hideMenus(); send({ type: 'session-move', id, island: isl.id }); })));
  tabMenu.appendChild(item('＋ New island…', () => { hideMenus(); createIsland(id); }));
  const cur = sessions.get(id);
  if (cur && cur.island) tabMenu.appendChild(item('Ungroup', () => { hideMenus(); send({ type: 'session-move', id, island: null }); }));
  tabMenu.appendChild(sep());
  tabMenu.appendChild(item('Close session', () => { hideMenus(); closeTab(id); }));
  placeMenu(tabMenu, x, y);
}

function openIslandMenu(x, y, id) {
  const isl = islandList.find((i) => i.id === id);
  tabMenu.innerHTML = '';
  tabMenu.appendChild(item('Rename', () => { hideMenus(); const el = tabsEl.querySelector(`.island-hdr[data-island="${id}"]`); if (el && isl) startRenameIsland(el, isl); }));
  tabMenu.appendChild(item(isl && isl.collapsed ? 'Expand' : 'Collapse', () => { hideMenus(); send({ type: 'island-update', id, collapsed: !(isl && isl.collapsed) }); }));
  tabMenu.appendChild(label('Color'));
  tabMenu.appendChild(swatchRow((c) => { hideMenus(); send({ type: 'island-update', id, color: c }); }));
  tabMenu.appendChild(sep());
  tabMenu.appendChild(item('Delete island', () => { hideMenus(); send({ type: 'island-delete', id }); }, 'danger'));
  placeMenu(tabMenu, x, y);
}

function createIsland(moveId) {
  renameIslandId = '__next__'; // rename the next island we hear about
  send({ type: 'island-create', name: 'island', moveId: moveId || undefined });
}

document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) hideMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenus(); });

/* ---- layout ---- */
function setLayout(mode) { appEl.className = 'layout-' + mode; localStorage.setItem('coclaude.layout', mode); setTimeout(doFit, 50); }
setLayout(localStorage.getItem('coclaude.layout') || 'left');
document.getElementById('btnLayout').onclick = () => setLayout(appEl.classList.contains('layout-left') ? 'top' : 'left');
document.getElementById('btnIsland').onclick = () => createIsland();
document.getElementById('btnNew').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); openNewMenu(r.left, r.bottom + 4); };

/* ---- connection ---- */
function connect() {
  if (!daemon) { statusEl.textContent = 'no daemon.json — is the daemon running?'; return; }
  ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
  ws.onopen = () => send({ type: 'hello', token: daemon.token });
  ws.onclose = () => { statusEl.textContent = 'disconnected — retrying…'; setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'hello-ok':
        daemonLabel = `daemon pid ${m.daemon.pid} · v${m.daemon.version}`; setStatus();
        break;
      case 'sessions': {
        sessions.clear();
        m.sessions.forEach((s) => sessions.set(s.id, s));
        islandList = m.islands || [];
        for (const s of sessions.values()) {
          if (s.state === 'waiting' && prevState.get(s.id) !== 'waiting') notifyWaiting(s);
          prevState.set(s.id, s.state);
        }
        for (const id of [...prevState.keys()]) if (!sessions.has(id)) prevState.delete(id);
        if (!bootstrapped) {
          bootstrapped = true;
          if (sessions.size === 0) spawnTemplate(TEMPLATES[0]);
          else attach(firstId());
        } else {
          if (activeId && !sessions.has(activeId)) { activeId = null; term.clear(); }
          if (!activeId && sessions.size > 0) attach(firstId());
        }
        renderRail();
        break;
      }
      case 'island-created':
        if (renameIslandId === '__next__') renameIslandId = m.id; // inline-rename it once it renders
        break;
      case 'spawned': {
        const t = pendingSpawns.shift();
        sessions.set(m.id, m.meta);
        activeId = m.id; term.clear(); renderRail(); doFit(); term.focus();
        const run = t && (t.claude
          ? `claude${daemon && daemon.claudeSettings ? ` --settings "${daemon.claudeSettings}"` : ''}${daemon && daemon.mcpConfig ? ` --mcp-config "${daemon.mcpConfig}"` : ''}\r\n`
          : t.run);
        if (run) setTimeout(() => send({ type: 'input', id: m.id, data: run }), 700);
        break;
      }
      case 'attached': if (m.id === activeId) term.write(m.buffer || ''); break;
      case 'data':     if (m.id === activeId) term.write(m.data); break;
      case 'exit':     if (m.id === activeId) term.writeln(`\r\n\x1b[31m[session exited: ${m.exitCode}]\x1b[0m`); break;
      case 'notify':   try { new Notification('coclaude-pit · Claude', { body: m.message }); } catch (_) { /* ignore */ } break;
    }
  };
}

function doFit() {
  fit.fit();
  if (activeId) send({ type: 'resize', id: activeId, cols: term.cols, rows: term.rows });
}

term.onData((d) => { if (activeId) send({ type: 'input', id: activeId, data: d }); });
window.addEventListener('resize', doFit);
connect();
setTimeout(doFit, 200);
