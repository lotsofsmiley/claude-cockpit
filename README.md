# coclaude-pit

A Claude Code **session cockpit** for Windows — many `claude` sessions as first-class tabs
with **true live survival** (sessions keep running when the GUI closes), and **Claude as a
first-class operator** of the app (not just a chatbot in a tab).

> Repo name: `claude-cockpit`. App/working name: **coclaude-pit**.

## Why it exists

PowerShell + Windows Terminal don't treat Claude sessions as objects, can't keep them alive
across a crash, and have no surface for Claude to tell you which session needs you. This does.

## Architecture

```
app/      Electron GUI — NO native modules, talks to the daemon over WebSocket only
daemon/   plain Node process — owns every PTY, OUTLIVES the GUI (ws://127.0.0.1:4317)
```

Because the daemon owns the PTYs (node-pty built for system Node), the Electron side needs
**zero native rebuilds**. Closing the GUI just drops a WebSocket client; the shells keep
running in the daemon. Reopen → reconnect → re-attach → ring-buffer replay → back in the live
session. Full design doc lives in the ADD vault: `01-Projects/Claude-Cockpit`.

## Status — Phase 0 (foundation)

- ✅ Survival daemon: node-pty → `powershell.exe`, WS protocol, ring-buffer scrollback, disk-persisted session registry.
- ✅ **Verified**: `npm run test:survive` proves the same shell PID survives a client disconnect + reconnect with buffer replay.
- ✅ Minimal Electron GUI: left tab rail + xterm.js pane, auto-starts the daemon, attaches.

## Run

```powershell
npm install
npm run daemon         # start the survival daemon (the GUI will also auto-start it)
npm start              # launch the Electron GUI
npm run test:survive   # prove a session survives the GUI closing
```

## Roadmap

0. **Foundation** ✅ — daemon + survival + minimal GUI
1. Multi-session tab rail (left/top switchable), names + colors
2. State engine — Claude hooks → semantic status icons (running / waiting / done)
3. Operator command bus + MCP server — Claude spawns/renames/themes/splits/renders/notifies
4. Comms dashboard — vault handoffs/projects + Claude→you inbox + OS notifications
5. Session templates — one-click sessions primed on the Obsidian vault / repos
6. Polish — config-as-code hot reload, PS7 profile, command palette, focus mode, aesthetic

## License

MIT
