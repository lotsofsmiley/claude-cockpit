'use strict';
/* Renderer: pure browser context. Talks to the daemon over WebSocket only.
 * Phase 1 — tab management (new/close/rename/recolor) + left/top layout toggle. */

const VAULT = 'C:\\add\\vaults\\ADD-Vault';
const TEMPLATES = [
  { label: 'PowerShell · home',  name: 'pwsh',         shell: 'powershell.exe', args: ['-NoLogo'], cwd: null,            color: null },
  { label: 'PowerShell · vault', name: 'vault',        shell: 'powershell.exe', args: ['-NoLogo'], cwd: VAULT,           color: '#7aa2f7' },
  { label: 'Claude · vault',     name: 'claude:vault', shell: 'powershell.exe', args: ['-NoLogo'], cwd: VAULT,           color: '#e3b341', run: 'claude\r\n' },
  { label: 'PowerShell · dev',   name: 'dev',          shell: 'powershell.exe', args: ['-NoLogo'], cwd: 'C:\\add\\dev',  color: null },
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

let ws = null;
let activeId = null;
let bootstrapped = false;
let daemonLabel = '';
const sessions = new Map();
const pendingSpawns = []; // FIFO of templates awaiting their 'spawned' reply

const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const firstId = () => (sessions.size ? [...sessions.keys()][0] : null);

function setStatus() {
  statusEl.textContent = sessions.size ? daemonLabel : (daemonLabel ? daemonLabel + ' · no sessions — click +' : 'connecting…');
}

/* ---- tabs ---- */
function renderTabs() {
  tabsEl.innerHTML = '';
  for (const s of sessions.values()) {
    const el = document.createElement('div');
    el.className = 'tab' + (s.id === activeId ? ' active' : '');
    el.dataset.id = s.id;

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = s.color || (s.alive ? '#3fb950' : '#f85149');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name || 'session';
    name.title = `${s.name} — ${s.cwd}`;
    name.ondblclick = (e) => { e.stopPropagation(); startRename(el, s); };

    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '×'; x.title = 'Close session';
    x.onclick = (e) => { e.stopPropagation(); closeTab(s.id); };

    el.append(dot, name, x);
    el.onclick = () => attach(s.id);
    el.oncontextmenu = (e) => { e.preventDefault(); openTabMenu(e.clientX, e.clientY, s.id); };
    tabsEl.appendChild(el);
  }
  setStatus();
}

function attach(id) {
  if (id === activeId || !sessions.has(id)) return;
  activeId = id;
  term.clear();
  send({ type: 'attach', id });
  renderTabs();
}

function startRename(tabEl, s) {
  const nameEl = tabEl.querySelector('.name');
  const input = document.createElement('input');
  input.className = 'rename'; input.value = s.name || '';
  const commit = (save) => {
    if (input.parentNode !== tabEl) return;
    const v = input.value.trim();
    tabEl.replaceChild(nameEl, input);
    if (save && v && v !== s.name) send({ type: 'rename', id: s.id, name: v });
  };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  };
  input.onblur = () => commit(true);
  tabEl.replaceChild(input, nameEl);
  input.focus(); input.select();
}

function closeTab(id) {
  const s = sessions.get(id);
  const label = s ? (s.name || 'session') : 'session';
  if (window.confirm(`Close "${label}"? This kills the session and any process in it.`)) {
    send({ type: 'kill', id });
  }
}

function spawnTemplate(t) {
  pendingSpawns.push(t);
  send({ type: 'spawn', name: t.name, color: t.color, cwd: t.cwd, shell: t.shell, args: t.args });
}

/* ---- menus ---- */
function hideMenus() { newMenu.classList.add('hidden'); tabMenu.classList.add('hidden'); }

function openNewMenu(x, y) {
  newMenu.innerHTML = '<div class="label">New session</div>';
  TEMPLATES.forEach((t) => {
    const it = document.createElement('div');
    it.className = 'item'; it.textContent = t.label;
    it.onclick = () => { hideMenus(); spawnTemplate(t); };
    newMenu.appendChild(it);
  });
  placeMenu(newMenu, x, y);
}

function openTabMenu(x, y, id) {
  tabMenu.innerHTML = '';
  const rename = document.createElement('div');
  rename.className = 'item'; rename.textContent = 'Rename';
  rename.onclick = () => { hideMenus(); const el = tabsEl.querySelector(`.tab[data-id="${id}"]`); if (el) startRename(el, sessions.get(id)); };
  tabMenu.appendChild(rename);

  const clabel = document.createElement('div'); clabel.className = 'label'; clabel.textContent = 'Color'; tabMenu.appendChild(clabel);
  const sw = document.createElement('div'); sw.className = 'swatches';
  const none = document.createElement('span'); none.className = 'swatch none'; none.title = 'default';
  none.onclick = () => { hideMenus(); send({ type: 'rename', id, color: null }); };
  sw.appendChild(none);
  COLORS.forEach((c) => {
    const s = document.createElement('span'); s.className = 'swatch'; s.style.background = c;
    s.onclick = () => { hideMenus(); send({ type: 'rename', id, color: c }); };
    sw.appendChild(s);
  });
  tabMenu.appendChild(sw);

  const sep = document.createElement('div'); sep.className = 'sep'; tabMenu.appendChild(sep);
  const close = document.createElement('div'); close.className = 'item'; close.textContent = 'Close session';
  close.onclick = () => { hideMenus(); closeTab(id); };
  tabMenu.appendChild(close);

  placeMenu(tabMenu, x, y);
}

function placeMenu(menu, x, y) {
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) hideMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenus(); });

/* ---- layout ---- */
function setLayout(mode) {
  appEl.className = 'layout-' + mode;
  localStorage.setItem('coclaude.layout', mode);
  setTimeout(doFit, 50);
}
setLayout(localStorage.getItem('coclaude.layout') || 'left');

document.getElementById('btnLayout').onclick = () =>
  setLayout(appEl.classList.contains('layout-left') ? 'top' : 'left');
document.getElementById('btnNew').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openNewMenu(r.left, r.bottom + 4);
};

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
        daemonLabel = `daemon pid ${m.daemon.pid} · v${m.daemon.version}`;
        setStatus();
        break;
      case 'sessions':
        sessions.clear();
        m.sessions.forEach((s) => sessions.set(s.id, s));
        if (!bootstrapped) {
          bootstrapped = true;
          if (sessions.size === 0) spawnTemplate(TEMPLATES[0]);
          else attach(firstId());
        } else {
          if (activeId && !sessions.has(activeId)) { activeId = null; term.clear(); }
          if (!activeId && sessions.size > 0) attach(firstId());
        }
        renderTabs();
        break;
      case 'spawned': {
        const t = pendingSpawns.shift();
        sessions.set(m.id, m.meta);
        activeId = m.id; term.clear(); renderTabs(); doFit();
        if (t && t.run) setTimeout(() => send({ type: 'input', id: m.id, data: t.run }), 700);
        break;
      }
      case 'attached':
        if (m.id === activeId) term.write(m.buffer || '');
        break;
      case 'data':
        if (m.id === activeId) term.write(m.data);
        break;
      case 'exit':
        if (m.id === activeId) term.writeln(`\r\n\x1b[31m[session exited: ${m.exitCode}]\x1b[0m`);
        break;
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
