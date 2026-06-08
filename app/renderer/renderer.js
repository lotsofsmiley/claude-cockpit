'use strict';
/* Renderer: pure browser context, talks to the daemon over WebSocket only.
 * Phase 1 tabs + Phase 2 Claude-state + tab islands (named/colored/collapsible groups). */

const VAULT = 'C:\\add\\vaults\\ADD-Vault';
const TEMPLATES = [
  { label: 'PowerShell · home',  name: 'pwsh',         shell: 'powershell.exe', args: ['-NoLogo'], cwd: null,           color: null },
  { label: 'PowerShell · vault', name: 'vault',        shell: 'powershell.exe', args: ['-NoLogo'], cwd: VAULT,          color: '#7aa2f7' },
  { label: 'Claude · vault',     name: 'claude:vault', shell: 'powershell.exe', args: ['-NoLogo'], cwd: VAULT,          color: '#e3b341', claude: true },
  { label: 'Claude · resume',    name: 'claude:resume', shell: 'powershell.exe', args: ['-NoLogo'], cwd: VAULT,          color: '#bc8cff', claude: true, resume: true },
  { label: 'PowerShell · dev',   name: 'dev',          shell: 'powershell.exe', args: ['-NoLogo'], cwd: 'C:\\add\\dev', color: null },
];
const COLORS = ['#3fb950', '#7aa2f7', '#e3b341', '#f85149', '#bc8cff', '#39c5cf', '#ff9e64'];
const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  plus: SVG('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  bell: SVG('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  bellOff: SVG('<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.9 17.9 0 0 1 18 8"/><path d="M6.26 6.26A5.9 5.9 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="2" y1="2" x2="22" y2="22"/>'),
  sidebar: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>'),
  panelTop: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'),
};

const daemon = window.cockpit && window.cockpit.daemon;
const statusEl = document.getElementById('status');
const tabsEl = document.getElementById('tabs');
const appEl = document.getElementById('app');
const newMenu = document.getElementById('newMenu');
const tabMenu = document.getElementById('tabMenu');

const term = new Terminal({
  fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13,
  cursorBlink: true, scrollback: 50000, rightClickSelectsWord: true,
  theme: { background: '#0b0d10', foreground: '#cdd6e4' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();
// Keep keystrokes landing in the active session: clicking the terminal area or
// re-focusing the window always returns focus to xterm's input.
document.getElementById('main').addEventListener('mousedown', () => setTimeout(() => term.focus(), 0));
window.addEventListener('focus', () => term.focus());

// No menu bar, so wire clipboard + font-zoom here. Non-Ctrl keys pass straight
// through to the shell (typing is never intercepted).
const clip = window.cockpit || {};
function setFont(px) {
  term.options.fontSize = Math.max(8, Math.min(30, px));
  doFit();
}
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown' || !e.ctrlKey) return true;
  const k = e.key.toLowerCase();
  if (e.shiftKey && k === 'c') { const s = term.getSelection(); if (s && clip.clipboardWrite) clip.clipboardWrite(s); e.preventDefault(); return false; }
  if (!e.shiftKey && k === 'c' && term.hasSelection()) { if (clip.clipboardWrite) clip.clipboardWrite(term.getSelection()); e.preventDefault(); return false; }
  if (k === 'v') { const t = clip.clipboardRead && clip.clipboardRead(); if (activeId && t) send({ type: 'input', id: activeId, data: t }); e.preventDefault(); return false; }
  if (k === '=' || k === '+') { setFont(term.options.fontSize + 1); e.preventDefault(); return false; }
  if (k === '-') { setFont(term.options.fontSize - 1); e.preventDefault(); return false; }
  if (k === '0') { setFont(13); e.preventDefault(); return false; }
  return true;
});

let ws = null;
let activeId = null;
let bootstrapped = false;
let daemonLabel = '';
let islandList = [];                 // [{id,name,color,collapsed,order}]
let notifyOn = localStorage.getItem('coclaude.notify') === '1'; // desktop notifications: off by default
let fitTimer = null;
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
function fade(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function notifyWaiting(s) {
  if (!notifyOn) return;
  try { new Notification('claudpit', { body: `${s.name || 'session'} is waiting on you`, silent: true }); } catch (_) { /* ignore */ }
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

  const dot = document.createElement('span');
  dot.className = 'idot'; dot.style.background = isl.color || '#5c6675';

  const name = document.createElement('span');
  name.className = 'iname'; name.textContent = isl.name || 'island';
  if (isl.color) name.style.color = isl.color;
  name.ondblclick = (e) => { e.stopPropagation(); startRenameIsland(el, isl); };

  const cnt = document.createElement('span');
  cnt.className = 'icount'; cnt.textContent = count;

  el.append(caret, dot, name, cnt);
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
    const group = document.createElement('div');
    group.className = 'island-group';
    if (isl.color) { group.style.borderColor = fade(isl.color, 0.3); group.style.background = fade(isl.color, 0.05); }
    const hdr = buildIslandHeader(isl, members.length);
    group.appendChild(hdr);
    if (renameIslandId === isl.id) { startRenameIsland(hdr, isl); renameIslandId = null; }
    if (!isl.collapsed) members.forEach((s) => group.appendChild(buildTab(s)));
    tabsEl.appendChild(group);
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
function setLayout(mode) {
  appEl.className = 'layout-' + mode;
  localStorage.setItem('coclaude.layout', mode);
  const b = document.getElementById('btnLayout');
  if (b) b.innerHTML = mode === 'left' ? ICONS.sidebar : ICONS.panelTop;
  setTimeout(doFit, 50);
}
setLayout(localStorage.getItem('coclaude.layout') || 'left');
document.getElementById('btnLayout').onclick = () => setLayout(appEl.classList.contains('layout-left') ? 'top' : 'left');
document.getElementById('btnNew').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); openNewMenu(r.left, r.bottom + 4); };
document.getElementById('btnNew').innerHTML = ICONS.plus;
document.getElementById('rail').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.tab') || e.target.closest('.island-hdr')) return; // those have their own menus
  e.preventDefault(); openNewMenu(e.clientX, e.clientY);
});
function setNotify(on) {
  notifyOn = on; localStorage.setItem('coclaude.notify', on ? '1' : '0');
  const b = document.getElementById('btnNotify');
  if (b) { b.innerHTML = on ? ICONS.bell : ICONS.bellOff; b.title = on ? 'Notifications on' : 'Notifications off (click to enable)'; }
}
document.getElementById('btnNotify').onclick = () => setNotify(!notifyOn);
setNotify(notifyOn);

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
          ? `claude${t.resume ? ' --resume' : ''}${daemon && daemon.claudeSettings ? ` --settings "${daemon.claudeSettings}"` : ''}${daemon && daemon.mcpConfig ? ` --mcp-config "${daemon.mcpConfig}"` : ''}\r\n`
          : t.run);
        if (run) setTimeout(() => send({ type: 'input', id: m.id, data: run }), 700);
        break;
      }
      case 'attached': if (m.id === activeId) term.write(m.buffer || ''); break;
      case 'data':     if (m.id === activeId) term.write(m.data); break;
      case 'exit':     if (m.id === activeId) term.writeln(`\r\n\x1b[31m[session exited: ${m.exitCode}]\x1b[0m`); break;
      case 'notify':   if (notifyOn) { try { new Notification('claudpit · Claude', { body: m.message, silent: true }); } catch (_) { /* ignore */ } } break;
    }
  };
}

function doFit() {
  // debounced: rapid zoom / resize collapses to one pty resize, so a live TUI
  // (claude) repaints once instead of dumping its banner into scrollback N times.
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    try { fit.fit(); } catch (_) { /* ignore */ }
    if (activeId) send({ type: 'resize', id: activeId, cols: term.cols, rows: term.rows });
  }, 90);
}

term.onData((d) => { if (activeId) send({ type: 'input', id: activeId, data: d }); });
window.addEventListener('resize', doFit);
connect();
setTimeout(doFit, 200);
