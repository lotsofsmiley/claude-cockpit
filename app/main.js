'use strict';
/* Electron main process. Ships NO native modules — it only ensures the daemon is
 * up and loads the renderer, which talks to the daemon over WebSocket. */
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
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

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 720, backgroundColor: '#0b0d10', title: 'claudpit',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
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
  autoUpdater.on('update-downloaded', () => autoUpdater.quitAndInstall(false, true));
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
