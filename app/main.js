'use strict';
/* Electron main process. Ships NO native modules — it only ensures the daemon is
 * up and loads the renderer, which talks to the daemon over WebSocket. */
const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// State dir is overridable so a dev/test instance (COCLAUDE_STATE_DIR + COCLAUDE_PORT)
// runs a fully separate daemon + sessions and never touches the production cockpit.
const STATE_DIR = process.env.COCLAUDE_STATE_DIR || path.join(os.homedir(), '.coclaude-pit');
const DAEMON_FILE = path.join(STATE_DIR, 'daemon.json');
let win = null;

function daemonAlive() {
  try {
    const d = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
    process.kill(d.pid, 0); // throws if the pid is gone
    return true;
  } catch { return false; }
}

async function ensureDaemon() {
  if (daemonAlive()) return;
  const daemonPath = path.join(__dirname, '..', 'daemon', 'index.js');
  let cmd, args, env;
  if (app.isPackaged) {
    // packaged: run the daemon with our own binary as Node — node-pty is rebuilt for Electron's ABI
    cmd = process.execPath; args = [daemonPath]; env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  } else {
    // dev: system node (node-pty is built for system Node)
    cmd = process.platform === 'win32' ? 'node.exe' : 'node'; args = [daemonPath]; env = process.env;
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env });
  child.unref();
  for (let i = 0; i < 40 && !daemonAlive(); i++) await new Promise((r) => setTimeout(r, 100));
}

// Engine migration: kill the running (older-code) daemon tree, then spawn a fresh one from the
// installed code. The new daemon's restore re-spawns the shells and resumes Claude by id, so a
// deliberate one-click "restart engine" loses no conversation. Used by the version-mismatch banner.
function killDaemonTree() {
  return new Promise((resolve) => {
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8')).pid; } catch { /* none */ }
    try { fs.unlinkSync(DAEMON_FILE); } catch { /* ignore */ }
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      k.on('exit', () => resolve()); k.on('error', () => resolve());
    } else { try { process.kill(pid); } catch { /* ignore */ } resolve(); }
  });
}
ipcMain.on('restart-engine', async () => {
  await killDaemonTree();
  await new Promise((r) => setTimeout(r, 400));
  await ensureDaemon(); // restore re-spawns sessions; the renderer's WS auto-reconnects
});

// Remember the window's size/position across launches (default: ~80% of the work area).
const WINDOW_FILE = path.join(STATE_DIR, 'window.json');
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds(); // un-maximized size
    fs.writeFileSync(WINDOW_FILE, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* ignore */ }
}
function initialBounds() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8')); } catch { /* none */ }
  if (saved && saved.width > 300 && saved.height > 200) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x != null && saved.y != null &&
        saved.x < a.x + a.width - 60 && saved.x + saved.width > a.x + 60 &&
        saved.y < a.y + a.height - 40 && saved.y + saved.height > a.y + 20;
    });
    return { width: saved.width, height: saved.height, x: onScreen ? saved.x : undefined, y: onScreen ? saved.y : undefined, maximized: !!saved.maximized };
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  return { width: Math.round(area.width * 0.8), height: Math.round(area.height * 0.82) };
}

function createWindow() {
  const b = initialBounds();
  win = new BrowserWindow({
    width: b.width, height: b.height,
    ...(b.x != null ? { x: b.x, y: b.y } : {}),
    minWidth: 640, minHeight: 420,
    backgroundColor: '#0b0d10', title: 'claudpit',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  if (b.maximized) win.maximize();
  let saveTimer = null;
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveBounds, 500); };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', saveBounds);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The menu bar is removed, so keep two dev accelerators that don't clash with
  // terminal keys: F12 / Ctrl+Shift+I -> devtools, Ctrl+Shift+R -> reload renderer.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F12' || (ctrl && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools(); e.preventDefault();
    } else if (ctrl && input.shift && input.key.toLowerCase() === 'r') {
      win.webContents.reload(); e.preventDefault();
    }
  });
}

// Release notes from the provider may be a string or an array of {version, note}.
function notesToText(n) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map((x) => (x && x.note) ? x.note : '').filter(Boolean).join('\n\n');
  return '';
}

// Auto-update from GitHub Releases. quitAndInstall restarts only the GUI; the daemon is
// detached + holds every PTY, so updating keeps all sessions running. New GUI re-attaches.
function setupUpdates() {
  if (!app.isPackaged) return; // updates only in the installed build
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', (info) => {
    if (win) win.webContents.send('update-available', { version: info.version, notes: notesToText(info.releaseNotes) });
  });
  // isSilent=true -> NSIS runs with /S: no wizard, updates in place where the app already is.
  autoUpdater.on('update-downloaded', () => autoUpdater.quitAndInstall(true, true));
  autoUpdater.on('error', () => { /* ignore (e.g. no releases yet / offline) */ });
  ipcMain.on('install-update', () => { autoUpdater.downloadUpdate().catch(() => {}); });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 2 * 60 * 60 * 1000);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // remove the File/Edit/View/Window bar — reclaim the space
  app.setAppUserModelId('com.lotsofsmiley.claudpit'); // distinct Windows taskbar identity
  await ensureDaemon();
  createWindow();
  setupUpdates();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
