# claudpit

A handcrafted Windows desktop **cockpit for running many Claude Code sessions** — each a real
PowerShell tab — with crash-survival, grouping, live activity, an operator API, and a comms dashboard.

> Repo: `claude-cockpit` · App: **claudpit**. A personal tool, built in the open.

## Why

Windows Terminal + PowerShell don't treat Claude Code sessions as first-class objects: they
can't keep them alive across a crash, group them, show which one is busy, let Claude *operate*
the app, or surface what needs you. claudpit does.

## Features

- **Many sessions as tabs** — each tab is a real `pwsh` session. One-click templates open Claude
  in the vault (`Claude · vault`) or the resumable-session picker (`Claude · resume`).
- **True live survival** — a background daemon owns the PTYs, so closing or crashing the window
  doesn't kill your sessions. Reopen → re-attach → scrollback replays. (Verified by `test:survive`.)
- **Tab islands** — group sessions into named, colored, collapsible islands; left rail or top bar.
- **Live activity state** — a tab glows blue while producing output, green when idle. No hooks, no popups.
- **Operator API (MCP)** — a Claude session can drive the cockpit: spawn / rename / move tabs,
  manage islands, read another tab's output, and notify you (`cockpit_*` tools).
- **Comms dashboard** — a slide-out panel with a *Claude → you* inbox and your open vault handoffs.
- Copy/paste, font zoom, 50k-line scrollback, switchable left/top layout, dark UI.

## Architecture

```
app/      Electron GUI — no native modules; talks to the daemon over WebSocket
daemon/   plain-Node process — owns every PTY, OUTLIVES the GUI (ws://127.0.0.1:4317)
mcp/      stdio MCP server — exposes the cockpit_* operator tools to Claude sessions
```

The daemon owning the PTYs is what gives both crash-survival *and* a native-rebuild-free GUI
(`node-pty` is built for system Node, never loaded inside Electron).

## Run

```powershell
npm install
npm start              # launches the GUI (auto-starts the daemon)

npm run test:survive   # proves a session survives the GUI closing
npm run test:state     # activity/state machine
npm run test:islands   # island registry
npm run test:operator  # MCP operator tools
```

Requires Node and Claude Code on `PATH`. PowerShell 7 recommended (falls back to Windows PowerShell).

## Build a desktop app

```powershell
npm run dist   # -> dist/claudpit Setup <ver>.exe (installer) + dist/claudpit <ver>.exe (portable)
npm run pack   # quick unpacked build in dist/win-unpacked (no installer)
```

No Visual Studio needed — node-pty is N-API, so it's not recompiled. The build is unsigned, so
Windows SmartScreen warns on first run ("More info → Run anyway"). Bump the version with
`npm version patch|minor|major`, then `npm run dist`.

## Status

Working: sessions, live survival, islands, activity state, operator MCP, comms dashboard.
See `TESTING.md` for the manual checklist.

## License

MIT
