'use strict';
/* Reads the daemon's port+token from the state file and hands them to the
 * renderer through a locked-down bridge. The renderer never touches Node. */
const { contextBridge } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

function readDaemon() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.coclaude-pit', 'daemon.json'), 'utf8'));
  } catch { return null; }
}

contextBridge.exposeInMainWorld('cockpit', { daemon: readDaemon() });
