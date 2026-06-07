'use strict';
/* Renderer: pure browser context. Talks to the daemon over WebSocket only. */
const daemon = window.cockpit && window.cockpit.daemon;
const statusEl = document.getElementById('status');
const tabsEl = document.getElementById('tabs');

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
const sessions = new Map();

function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const s of sessions.values()) {
    const el = document.createElement('div');
    el.className = 'tab' + (s.id === activeId ? ' active' : '');
    const dotStyle = s.alive ? '' : 'background:#f85149';
    el.innerHTML = `<span class="dot" style="${dotStyle}"></span><span>${s.name || 'session'}</span>`;
    el.onclick = () => attach(s.id);
    tabsEl.appendChild(el);
  }
}

function attach(id) {
  if (id === activeId) return;
  activeId = id;
  term.clear();
  send({ type: 'attach', id });
  renderTabs();
}

function connect() {
  if (!daemon) { statusEl.textContent = 'no daemon.json — is the daemon running?'; return; }
  ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
  ws.onopen = () => send({ type: 'hello', token: daemon.token });
  ws.onclose = () => { statusEl.textContent = 'disconnected — retrying…'; setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'hello-ok':
        statusEl.textContent = `daemon pid ${m.daemon.pid} · v${m.daemon.version}`;
        send({ type: 'list' });
        break;
      case 'sessions':
        sessions.clear();
        m.sessions.forEach((s) => sessions.set(s.id, s));
        if (sessions.size === 0) send({ type: 'spawn', name: 'pwsh', cwd: null });
        else if (!activeId) attach([...sessions.keys()][0]);
        renderTabs();
        break;
      case 'spawned':
        sessions.set(m.id, m.meta); activeId = m.id; renderTabs(); doFit();
        break;
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
