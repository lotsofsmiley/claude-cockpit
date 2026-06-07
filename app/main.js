'use strict';
/* Electron main process. Ships NO native modules — it only ensures the daemon is
 * up and loads the renderer, which talks to the daemon over WebSocket. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const DAEMON_FILE = path.join(os.homedir(), '.coclaude-pit', 'daemon.json');

function daemonAlive() {
  try {
    const d = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
    process.kill(d.pid, 0); // throws if the pid is gone
    return true;
  } catch { return false; }
}

async function ensureDaemon() {
  if (daemonAlive()) return;
  const child = spawn(process.platform === 'win32' ? 'node.exe' : 'node',
    [path.join(__dirname, '..', 'daemon', 'index.js')],
    { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40 && !daemonAlive(); i++) await new Promise((r) => setTimeout(r, 100));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 720, backgroundColor: '#0b0d10', title: 'coclaude-pit',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await ensureDaemon();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
