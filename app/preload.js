'use strict';
/* Reads the daemon's port+token from the state file and hands them to the
 * renderer through a locked-down bridge. The renderer never touches Node. */
const { contextBridge, clipboard, ipcRenderer } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Honor COCLAUDE_STATE_DIR so a dev/test window reads its own isolated daemon.
const STATE_DIR = process.env.COCLAUDE_STATE_DIR || path.join(os.homedir(), '.coclaude-pit');

// The engine rev THIS (installed) build expects. Compared against the running daemon's rev
// to detect a pending engine update. Falls back gracefully if the file can't be resolved.
const ENGINE_REV = (() => { try { return require('../daemon/engine-rev'); } catch { return 0; } })();

function readDaemon() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'daemon.json'), 'utf8'));
  } catch { return null; }
}

contextBridge.exposeInMainWorld('cockpit', {
  daemon: readDaemon(),
  clipboardRead: () => clipboard.readText(),
  clipboardWrite: (t) => clipboard.writeText(t),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (e, v) => cb(v)),
  installUpdate: () => ipcRenderer.send('install-update'),
  engineRev: ENGINE_REV,
  restartEngine: () => ipcRenderer.send('restart-engine'),
});
