'use strict';
/* Renderer: pure browser context, talks to the daemon over WebSocket only.
 * Phase 1 tabs + Phase 2 Claude-state + tab islands (named/colored/collapsible groups). */

const COLORS = ['#3fb950', '#7aa2f7', '#e3b341', '#f85149', '#bc8cff', '#39c5cf', '#ff9e64'];
const DEFAULT_TEMPLATE = { label: 'PowerShell', name: 'pwsh', shell: 'powershell.exe', args: ['-NoLogo'], cwd: null, color: null };
const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const SVGF = (p) => `<svg viewBox="0 0 24 24" fill="currentColor">${p}</svg>`;
const ICONS = {
  plus: SVG('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  bell: SVG('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  bellOff: SVG('<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.9 17.9 0 0 1 18 8"/><path d="M6.26 6.26A5.9 5.9 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="2" y1="2" x2="22" y2="22"/>'),
  sidebar: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>'),
  panelTop: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'),
  inbox: SVG('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  play: SVGF('<polygon points="7 4 20 12 7 20"/>'),
  pause: SVGF('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
  prev: SVGF('<polygon points="19 20 9 12 19 4"/><rect x="5" y="4" width="2.6" height="16" rx="1"/>'),
  next: SVGF('<polygon points="5 4 15 12 5 20"/><rect x="16.4" y="4" width="2.6" height="16" rx="1"/>'),
  music: SVG('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  volume: SVG('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
  search: SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
};

const daemon = window.cockpit && window.cockpit.daemon;
const statusEl = document.getElementById('status');
const tabsEl = document.getElementById('tabs');
const appEl = document.getElementById('app');
const newMenu = document.getElementById('newMenu');
const tabMenu = document.getElementById('tabMenu');

const term = new Terminal({
  fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 14,
  cursorBlink: true, scrollback: 50000, rightClickSelectsWord: true,
  theme: { background: '#0b0d10', foreground: '#cdd6e4' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();
// Keep keystrokes landing in the active session: clicking the terminal area or
// re-focusing the window always returns focus to xterm's input.
document.getElementById('main').addEventListener('mousedown', () => setTimeout(() => { if (!renamingActive) term.focus(); }, 0));
window.addEventListener('focus', () => { if (!renamingActive) term.focus(); });

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
  // Ctrl+K is handled at the document level (capture) so it works from any focus — see below.
  if (k === '=' || k === '+') { setFont(term.options.fontSize + 1); e.preventDefault(); return false; }
  if (k === '-') { setFont(term.options.fontSize - 1); e.preventDefault(); return false; }
  if (k === '0') { setFont(14); e.preventDefault(); return false; }
  return true;
});

let ws = null;
let activeId = null;
let bootstrapped = false;
let daemonLabel = '';
let islandList = [];                 // [{id,name,color,collapsed,order}]
let notifyOn = localStorage.getItem('coclaude.notify') === '1'; // desktop notifications: off by default
let fitTimer = null;
let dashOpen = false;
let templates = [];
let vaultPath = null;
let renameIslandId = null;           // island to inline-rename on next render (just created)
const sessions = new Map();
const prevState = new Map();
const attention = new Set(); // tabs that finished work while not focused
const everSeen = new Set();  // tabs you've actually opened — only these can raise an attention badge
const quietTimers = new Map(); // id -> timer: confirm a session is *really* done before flagging (not a mid-stream pause)
const pendingSpawns = [];
let renamingActive = false;  // an inline rename is open — don't let a rail re-render or focus-steal clobber it
let railDirty = false;       // a rail re-render was deferred during a rename

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
  el.className = 'tab' + (s.id === activeId ? ' active' : '') + (s.island ? ' in-island' : '') + (attention.has(s.id) ? ' attention' : '');
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

  if (attention.has(s.id)) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = '!'; el.append(dot, name, b, x); }
  else el.append(dot, name, x);
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
  if (renamingActive) { railDirty = true; return; } // don't wipe an open rename input; redraw when it closes
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
    const collapsed = isl.collapsed && appEl.classList.contains('layout-left'); // collapse only in the vertical rail
    if (!collapsed) members.forEach((s) => group.appendChild(buildTab(s)));
    tabsEl.appendChild(group);
  }
  ungrouped.forEach((s) => tabsEl.appendChild(buildTab(s)));
  setStatus();
}

/* ---- actions ---- */
function attach(id) {
  if (id === activeId || !sessions.has(id)) return;
  activeId = id; attention.delete(id); everSeen.add(id); term.clear();
  const qt = quietTimers.get(id); if (qt) { clearTimeout(qt); quietTimers.delete(id); }
  send({ type: 'attach', id });
  // match this pty to the current window size, so switching tabs never shows a stale layout
  send({ type: 'resize', id, cols: term.cols, rows: term.rows });
  renderRail();
  term.focus(); // a tab click must leave you ready to type immediately
}
function inlineRename(hostEl, oldEl, current, onSave) {
  const input = document.createElement('input');
  input.className = 'rename'; input.value = current || '';
  renamingActive = true;
  const done = (save) => {
    if (input.parentNode !== hostEl) { renamingActive = false; return; }
    const v = input.value.trim();
    hostEl.replaceChild(oldEl, input);
    renamingActive = false;
    if (save && v && v !== current) onSave(v);
    if (railDirty) { railDirty = false; renderRail(); } // apply any updates that arrived during the rename
  };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
  input.onblur = () => done(true);
  hostEl.replaceChild(input, oldEl);
  input.focus(); input.select();
}
function startRenameTab(tabEl, s) {
  attention.delete(s.id); tabEl.classList.remove('attention'); // interacting with it = seen; drop the badge/outline
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
function spawnTemplate(t) {
  pendingSpawns.push(t);
  // The daemon builds + types the launch command (claude/run) so it can replay it on reboot.
  send({ type: 'spawn', name: t.name || t.label, color: t.color, cwd: t.cwd,
    shell: t.shell || 'powershell.exe', args: t.args || ['-NoLogo'],
    claude: !!t.claude, resume: !!t.resume, prompt: t.prompt || null, run: t.run || null });
}

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
  templates.forEach((t) => newMenu.appendChild(item(t.label, () => { hideMenus(); spawnTemplate(t); })));
  newMenu.appendChild(sep());
  newMenu.appendChild(item('＋ New island', () => { hideMenus(); createIsland(); }));
  newMenu.appendChild(item('⚙ Manage session types…', () => { hideMenus(); openTemplateManager(); }));
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

/* ---- dashboard ---- */
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function renderDash(data) {
  const notes = (data.notifications || []).slice().reverse();
  document.getElementById('dashInbox').innerHTML = notes.length
    ? notes.map((n) => `<div class="dash-item"><div style="flex:1"><div class="dash-msg">${esc(n.message)}</div><div class="dash-meta">${n.at ? n.at.slice(11, 16) : ''} · ${esc(n.level || '')}</div></div></div>`).join('')
    : '<div class="dash-empty">No messages yet.</div>';
  const ho = document.getElementById('dashHandoffs');
  const pr = document.getElementById('dashProjects');
  if (!data.hasVault) {
    ho.innerHTML = '<div class="dash-cta">No vault connected. claudpit can read an Obsidian-style <b>second brain</b> — a folder of markdown notes — and surface what needs you. Point it at a vault and let Claude work from it.<br><span id="setVault" class="dash-link">Set vault folder…</span></div>';
    const sv = document.getElementById('setVault'); if (sv) sv.onclick = promptVault;
    pr.innerHTML = '';
    return;
  }
  const hs = data.handoffs || [];
  ho.innerHTML = hs.length
    ? hs.map((h) => `<div class="dash-item dash-click" data-handoff="${esc(h.file)}" title="Open in a Claude session"><span class="pri pri-${h.priority || 'none'}"></span><span class="dash-msg">${esc(h.title)}</span></div>`).join('')
    : '<div class="dash-empty">No open handoffs.</div>';
  const ps = data.projects || [];
  pr.innerHTML = ps.length
    ? ps.map((p) => `<div class="dash-item dash-click" data-project="${esc(p.name)}" title="Open in a Claude session"><span class="pri pri-${p.priority || 'none'}"></span><span class="dash-msg">${esc(p.name)}</span>${p.todos ? `<span class="dash-meta" style="margin:0">${p.todos}</span>` : ''}</div>`).join('')
    : '<div class="dash-empty">No active projects.</div>';
}
function openDash(on) {
  dashOpen = on;
  document.getElementById('dash').classList.toggle('hidden', !on);
  if (on) send({ type: 'dashboard' });
}
document.getElementById('btnDash').innerHTML = ICONS.inbox;
document.getElementById('btnDash').onclick = () => openDash(!dashOpen);
document.getElementById('dashClose').onclick = () => openDash(false);
document.getElementById('inboxClear').onclick = () => send({ type: 'notify-clear' });
function openVaultThing(name, color, prompt) {
  if (!vaultPath) return;
  openDash(false);
  // dedupe: if a session for this thing is already open, just focus it instead of spawning another
  for (const s of sessions.values()) { if ((s.name || '') === name) { attach(s.id); return; } }
  spawnTemplate({ claude: true, cwd: vaultPath, name, color, prompt });
}
document.getElementById('dashHandoffs').addEventListener('click', (e) => {
  const el = e.target.closest('[data-handoff]'); if (!el) return;
  const nm = el.dataset.handoff.replace(/\.md$/, ''); // per-handoff name so dedupe is per-file
  openVaultThing(nm, '#e3b341', `Open the handoff 99-Meta/Handoffs/${el.dataset.handoff}, brief me on it, and help me action it.`);
});
document.getElementById('dashProjects').addEventListener('click', (e) => {
  const el = e.target.closest('[data-project]'); if (!el) return;
  openVaultThing(el.dataset.project, '#7aa2f7', `Open the project 01-Projects/${el.dataset.project}/, give me a short status, and help me with it.`);
});

/* ---- session-type manager (user-editable openers) ---- */
function closeModal() { document.getElementById('modal').classList.add('hidden'); }
document.getElementById('modalClose').onclick = closeModal;
function mkBtn(t, fn) { const b = document.createElement('span'); b.className = 't-btn'; b.textContent = t; b.onclick = fn; return b; }
function mkInput(cls, val, fn, ph) { const i = document.createElement('input'); i.type = 'text'; i.className = cls; i.value = val; i.placeholder = ph || ''; i.oninput = () => fn(i.value); return i; }
function mkChk(t, on, fn) { const l = document.createElement('label'); l.className = 'chk'; const c = document.createElement('input'); c.type = 'checkbox'; c.checked = on; c.onchange = () => fn(c.checked); l.append(c, document.createTextNode(t)); return l; }
function promptVault() {
  const ho = document.getElementById('dashHandoffs');
  ho.innerHTML = '<input id="vaultInput" type="text" placeholder="C:\\path\\to\\vault"><div class="dash-meta">Folder containing 99-Meta/Handoffs/. Press Enter.</div>';
  const inp = document.getElementById('vaultInput'); inp.focus();
  inp.onkeydown = (e) => { if (e.key === 'Enter') { vaultPath = inp.value.trim() || null; send({ type: 'config-save', vaultPath }); setTimeout(() => send({ type: 'dashboard' }), 100); } };
}
function openTemplateManager() {
  const rows = templates.map((t) => ({ ...t }));
  const palette = [['none', ''], ['blue', '#7aa2f7'], ['amber', '#e3b341'], ['green', '#3fb950'], ['red', '#f85149'], ['purple', '#bc8cff'], ['cyan', '#39c5cf']];
  function draw() {
    document.getElementById('modalTitle').textContent = 'Session types';
    const body = document.getElementById('modalBody');
    body.innerHTML = '';
    rows.forEach((t, i) => {
      const row = document.createElement('div'); row.className = 'tmpl-row';
      const up = mkBtn('↑', () => { if (i > 0) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); } });
      const down = mkBtn('↓', () => { if (i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); } });
      const lbl = mkInput('t-label', t.label || '', (v) => { t.label = v; }, 'Label');
      const cwd = mkInput('t-cwd', t.cwd || '', (v) => { t.cwd = v || null; }, 'Folder (blank = home)');
      const sel = document.createElement('select');
      palette.forEach(([nm, hex]) => { const o = document.createElement('option'); o.value = hex; o.textContent = nm; if ((t.color || '') === hex) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { t.color = sel.value || null; };
      const cl = mkChk('Claude', !!t.claude, (v) => { t.claude = v; });
      const rs = mkChk('Resume', !!t.resume, (v) => { t.resume = v; });
      const del = mkBtn('✕', () => { rows.splice(i, 1); draw(); });
      row.append(up, down, lbl, cwd, sel, cl, rs, del);
      body.appendChild(row);
    });
    const hint = document.createElement('div'); hint.className = 'modal-hint';
    hint.textContent = 'Label = menu text · Folder = working directory · Claude = run claude on open · Resume = open the resumable-session picker.';
    body.appendChild(hint);
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const add = document.createElement('button'); add.textContent = '+ Add'; add.onclick = () => { rows.push({ label: 'New session', shell: 'powershell.exe', args: ['-NoLogo'], cwd: null, color: null }); draw(); };
    const save = document.createElement('button'); save.className = 'primary'; save.textContent = 'Save'; save.onclick = () => { templates = rows.map((t) => ({ ...t, name: t.name || t.label })); send({ type: 'config-save', templates }); closeModal(); };
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.onclick = closeModal;
    actions.append(add, save, cancel);
    body.appendChild(actions);
  }
  draw();
  document.getElementById('modal').classList.remove('hidden');
}

/* ---- media (OS now-playing) ---- */
let media = null;
function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function updateMediaProgress() {
  if (!media) return;
  const pos = media.position || 0, dur = media.duration || 0;
  document.getElementById('mFill').style.width = (dur > 0 ? Math.min(100, pos / dur * 100) : 0) + '%';
}
function renderMedia() {
  const el = document.getElementById('media');
  if (!media || !media.title) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const t = document.getElementById('mTitle'); t.textContent = media.title; t.title = media.title;
  document.getElementById('mArtist').textContent = media.artist || '';
  document.getElementById('mPlay').innerHTML = media.playing ? ICONS.pause : ICONS.play;
  const art = document.getElementById('mediaArt'), fb = document.getElementById('mArtFallback');
  if (media.thumb) { art.src = media.thumb; art.style.display = ''; fb.style.display = 'none'; }
  else { art.style.display = 'none'; fb.style.display = ''; }
  updateMediaProgress();
}
document.getElementById('mPrev').innerHTML = ICONS.prev;
document.getElementById('mNext').innerHTML = ICONS.next;
document.getElementById('mVol').innerHTML = ICONS.volume;
document.getElementById('mArtFallback').innerHTML = ICONS.music;
document.getElementById('mPrev').onclick = () => send({ type: 'media-control', action: 'prev' });
document.getElementById('mPlay').onclick = () => send({ type: 'media-control', action: 'playpause' });
document.getElementById('mNext').onclick = () => send({ type: 'media-control', action: 'next' });
document.getElementById('mVol').onclick = () => send({ type: 'media-control', action: 'mute' });
document.getElementById('mVol').onwheel = (e) => { e.preventDefault(); send({ type: 'media-control', action: e.deltaY < 0 ? 'volup' : 'voldown' }); };
// No local tick — the daemon streams the authoritative position ~every 0.7s (monotonic),
// so rendering on each update avoids the local-tick-vs-daemon flicker.

/* ---- command palette (Ctrl+K) ---- */
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); // accent-fold: gestão -> gestao
let palFiltered = [];
let palSel = 0;
function markPalSel() {
  document.querySelectorAll('.pal-item').forEach((el) => el.classList.toggle('sel', +el.dataset.idx === palSel));
  const s = document.querySelector('.pal-item.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
}
function choosePalette() { const id = palFiltered[palSel]; if (id) { closePalette(); attach(id); } }
function renderPalette(q) {
  const nq = norm(q);
  const list = document.getElementById('palList');
  list.innerHTML = ''; palFiltered = [];
  const ordered = [...islandList].sort((a, b) => (a.order || 0) - (b.order || 0));
  const byId = {}; ordered.forEach((i) => { byId[i.id] = { island: i, sessions: [] }; });
  const ung = [];
  for (const s of sessions.values()) {
    const isl = (s.island && byId[s.island]) ? byId[s.island].island : null;
    if (nq && !norm(s.name).includes(nq) && !(isl && norm(isl.name).includes(nq))) continue;
    if (isl) byId[s.island].sessions.push(s); else ung.push(s);
  }
  const addItem = (s) => {
    const idx = palFiltered.length; palFiltered.push(s.id);
    const it = document.createElement('div'); it.className = 'pal-item'; it.dataset.idx = idx;
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = stateColor(s);
    const nm = document.createElement('span'); nm.className = 'pal-name'; nm.textContent = s.name || 'session';
    it.append(dot, nm);
    if (attention.has(s.id)) { const b = document.createElement('span'); b.className = 'pal-badge'; b.textContent = '!'; it.appendChild(b); }
    it.onclick = () => { palSel = idx; choosePalette(); };
    it.onmousemove = () => { if (palSel !== idx) { palSel = idx; markPalSel(); } };
    list.appendChild(it);
  };
  for (const i of ordered) {
    const g = byId[i.id];
    if (!g.sessions.length) continue;
    const h = document.createElement('div'); h.className = 'pal-group'; h.textContent = i.name || 'island'; list.appendChild(h);
    g.sessions.forEach(addItem);
  }
  ung.forEach(addItem);
  if (!palFiltered.length) { const e = document.createElement('div'); e.className = 'pal-empty'; e.textContent = 'No matches.'; list.appendChild(e); }
  if (palSel >= palFiltered.length) palSel = Math.max(0, palFiltered.length - 1);
  markPalSel();
}
function openPalette() {
  document.getElementById('palette').classList.remove('hidden');
  const inp = document.getElementById('palInput'); inp.value = ''; palSel = 0; renderPalette(''); inp.focus();
}
function closePalette() { document.getElementById('palette').classList.add('hidden'); term.focus(); }
document.getElementById('searchBtn').querySelector('.s-ico').innerHTML = ICONS.search;
document.getElementById('searchBtn').onclick = openPalette;
// Ctrl+K (Cmd+K) toggles the palette from ANY focus. Capture phase + stopPropagation so the
// key is grabbed before xterm — the terminal never receives a stray ^K, and it works even
// when focus is on the dashboard, a menu, or no tab is attached.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault(); e.stopPropagation();
    if (document.getElementById('palette').classList.contains('hidden')) openPalette(); else closePalette();
  }
}, true);
document.getElementById('palInput').oninput = (e) => renderPalette(e.target.value);
document.getElementById('palInput').onkeydown = (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palFiltered.length - 1, palSel + 1); markPalSel(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); markPalSel(); }
  else if (e.key === 'Enter') { e.preventDefault(); choosePalette(); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
};
document.getElementById('palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });

/* ---- auto-update (centered modal, same dim-backdrop concept as the palette) ---- */
let pendingUpdate = null;
function renderNotes(text, el) {
  el.innerHTML = '';
  const raw = String(text || '');
  // GitHub returns release notes as HTML; render a clean text-only subset (headings/bullets/paras),
  // never raw markup. Other providers may send markdown — handled by the line parser below.
  if (/<(p|h[1-6]|ul|ol|li|br|div|strong|em)\b/i.test(raw)) {
    const body = new DOMParser().parseFromString(raw, 'text/html').body;
    const emit = (node) => {
      node.childNodes.forEach((c) => {
        if (c.nodeType === 3) { const t = c.textContent.trim(); if (t) { const p = document.createElement('p'); p.textContent = t; el.appendChild(p); } return; }
        if (c.nodeType !== 1) return;
        const tag = c.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) { const h = document.createElement('h4'); h.textContent = c.textContent.trim(); el.appendChild(h); }
        else if (tag === 'li') { const d = document.createElement('div'); d.className = 'um-li'; d.textContent = c.textContent.trim(); el.appendChild(d); }
        else if (tag === 'p') { const t = c.textContent.trim(); if (t) { const p = document.createElement('p'); p.textContent = t; el.appendChild(p); } }
        else emit(c); // ul/ol/div/etc — descend
      });
    };
    emit(body);
    if (!el.childNodes.length) { const p = document.createElement('p'); p.textContent = body.textContent.trim() || 'A new version is ready to install.'; el.appendChild(p); }
    return;
  }
  let any = false;
  for (const r of raw.split(/\r?\n/)) {
    const line = r.trim();
    if (!line) continue;
    any = true;
    if (/^#{1,6}\s/.test(line)) { const h = document.createElement('h4'); h.textContent = line.replace(/^#{1,6}\s/, ''); el.appendChild(h); }
    else if (/^[-*]\s/.test(line)) { const d = document.createElement('div'); d.className = 'um-li'; d.textContent = line.replace(/^[-*]\s+/, ''); el.appendChild(d); }
    else { const p = document.createElement('p'); p.textContent = line; el.appendChild(p); }
  }
  if (!any) { const p = document.createElement('p'); p.textContent = 'A new version is ready to install.'; el.appendChild(p); }
}
function openUpdateModal() {
  if (!pendingUpdate) return;
  document.getElementById('umTitle').textContent = `claudpit ${pendingUpdate.version} is ready`;
  renderNotes(pendingUpdate.notes, document.getElementById('umNotes'));
  const go = document.getElementById('umGo'); go.disabled = false; go.textContent = 'Update & restart';
  document.getElementById('updateBar').classList.add('hidden');
  document.getElementById('updateModal').classList.remove('hidden');
}
function dismissUpdateModal() {
  document.getElementById('updateModal').classList.add('hidden');
  if (pendingUpdate) {
    document.getElementById('updateMsg').textContent = `↑ claudpit ${pendingUpdate.version} ready`;
    document.getElementById('updateBar').classList.remove('hidden');
  }
}
/* ---- engine (daemon) update: shown when the running engine is older than the installed
   code. One click restarts the engine; restore brings the sessions back (Claude resumes). ---- */
const installedEngineRev = (window.cockpit && window.cockpit.engineRev) || 0;
function checkEngine(runningRev) {
  const bar = document.getElementById('engineBar');
  if (installedEngineRev > (runningRev || 0)) {
    bar.textContent = '⚙ Engine update ready — click to restart';
    bar.classList.remove('hidden');
  } else { bar.classList.add('hidden'); }
}
if (window.cockpit && window.cockpit.restartEngine) {
  document.getElementById('engineBar').onclick = () => {
    document.getElementById('engineBar').textContent = 'Restarting engine — sessions resuming…';
    window.cockpit.restartEngine(); // WS drops, reconnects, and re-checks on the next hello-ok
  };
}

if (window.cockpit && window.cockpit.onUpdateAvailable) {
  window.cockpit.onUpdateAvailable((u) => { pendingUpdate = (typeof u === 'string') ? { version: u, notes: '' } : u; openUpdateModal(); });
  document.getElementById('umGo').onclick = () => {
    const b = document.getElementById('umGo'); b.disabled = true; b.textContent = 'Downloading…';
    window.cockpit.installUpdate();
  };
  document.getElementById('umLater').onclick = dismissUpdateModal;
  document.getElementById('updateBar').onclick = openUpdateModal;
  document.getElementById('updateModal').addEventListener('mousedown', (e) => { if (e.target.id === 'updateModal') dismissUpdateModal(); });
}

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
        checkEngine(m.daemon.engineRev);
        send({ type: 'config' });
        break;
      case 'sessions': {
        sessions.clear();
        m.sessions.forEach((s) => sessions.set(s.id, s));
        islandList = m.islands || [];
        for (const s of sessions.values()) {
          const prev = prevState.get(s.id);
          if (s.state === 'running') {
            // new activity — cancel any pending "finished" confirmation (this was just a pause)
            const t = quietTimers.get(s.id); if (t) { clearTimeout(t); quietTimers.delete(s.id); }
          } else if (prev === 'running' && s.id !== activeId && everSeen.has(s.id) && !quietTimers.has(s.id)) {
            // a tab you've opened went quiet off-screen. Only badge it if it STAYS quiet (a real
            // turn-end, not a mid-stream gap). This avoids the restore-flood + repeated re-flagging.
            quietTimers.set(s.id, setTimeout(() => {
              quietTimers.delete(s.id);
              const cur = sessions.get(s.id);
              if (cur && cur.state !== 'running' && s.id !== activeId) { attention.add(s.id); renderRail(); }
            }, 4000));
          }
          prevState.set(s.id, s.state);
        }
        for (const id of [...prevState.keys()]) if (!sessions.has(id)) {
          prevState.delete(id); attention.delete(id); everSeen.delete(id);
          const t = quietTimers.get(id); if (t) { clearTimeout(t); quietTimers.delete(id); }
        }
        if (!bootstrapped) {
          bootstrapped = true;
          if (sessions.size === 0) spawnTemplate(templates[0] || DEFAULT_TEMPLATE);
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
        pendingSpawns.shift(); // drain; the daemon now types the launch command itself
        sessions.set(m.id, m.meta);
        activeId = m.id; term.clear(); renderRail(); doFit(); term.focus();
        break;
      }
      case 'attached': if (m.id === activeId) term.write(m.buffer || ''); break;
      case 'data':     if (m.id === activeId) term.write(m.data); break;
      case 'exit':     if (m.id === activeId) term.writeln(`\r\n\x1b[31m[session exited: ${m.exitCode}]\x1b[0m`); break;
      case 'notify':   if (notifyOn) { try { new Notification('claudpit · Claude', { body: m.message, silent: true }); } catch (_) { /* ignore */ } } if (dashOpen) send({ type: 'dashboard' }); break;
      case 'dashboard-data': renderDash(m); break;
      case 'config-data': templates = m.templates || []; vaultPath = m.vaultPath || null; break;
      case 'media': {
        if (!m.media) { media = null; renderMedia(); break; }
        const prevThumb = media && media.thumb;
        media = m.media;
        if (!media.thumb && prevThumb) media.thumb = prevThumb;
        renderMedia();
        break;
      }
    }
  };
}

function doFit() {
  // debounced: rapid zoom / resize collapses to one pty resize, so a live TUI
  // (claude) repaints once instead of dumping its banner into scrollback N times.
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    try { fit.fit(); } catch (_) { /* ignore */ }
    // resize EVERY session, not just the active one — otherwise a background tab keeps the old
    // cols/rows and renders a stale layout until you resize again while it's focused.
    for (const id of sessions.keys()) send({ type: 'resize', id, cols: term.cols, rows: term.rows });
  }, 90);
}

term.onData((d) => { if (activeId) send({ type: 'input', id: activeId, data: d }); });
window.addEventListener('resize', doFit);
connect();
setTimeout(doFit, 200);
