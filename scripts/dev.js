'use strict';
/*
 * Launch an ISOLATED cockpit instance for development.
 * It uses its own state dir (~/.coclaude-pit-dev) and port (4318), so its daemon and
 * sessions are completely separate from the production cockpit on 4317. Nothing here
 * can see, attach to, restart, or kill the sessions you are working in.
 *
 *   npm run start:dev
 */
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron'); // resolves to the electron binary path

const env = {
  ...process.env,
  COCLAUDE_STATE_DIR: process.env.COCLAUDE_STATE_DIR || path.join(os.homedir(), '.coclaude-pit-dev'),
  COCLAUDE_PORT: process.env.COCLAUDE_PORT || '4318',
};
console.log(`[dev] isolated cockpit · state=${env.COCLAUDE_STATE_DIR} · port=${env.COCLAUDE_PORT}`);
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
