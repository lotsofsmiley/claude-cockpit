'use strict';
/*
 * Engine (daemon) revision. Bump this ONLY when the daemon's own code changes in a way that
 * benefits from running the new code — PTY handling, the WS protocol, restore logic, etc.
 *
 * The GUI compares the running daemon's reported rev to the installed code's rev. If the
 * installed code is newer, it offers "restart engine" (sessions resume via restore). Pure
 * GUI/renderer updates leave this number alone, so they never prompt an engine restart.
 */
module.exports = 2;
