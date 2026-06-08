# Changelog

All notable changes to **claudpit** are recorded here. Versions follow semver-ish bumps.

## 0.3.0

### Added
- **Reboot-restore.** Sessions now survive a full machine death (reboot, battery, Windows
  update — not just closing the GUI). The daemon persists a self-sufficient record per
  session (shell, args, cwd, name, color, island, and the Claude session id) and, on a cold
  boot, re-spawns every session that was alive: shells return at their original folder and
  Claude tabs resume their conversation via `claude --resume <id>`.
- **Auto-update** (installed builds only). When a new version is published, a banner shows
  the version with an **Update & restart** button. Because the daemon is detached and owns
  every PTY, the GUI updates and relaunches while all sessions keep running — no work lost.
- `COCLAUDE_STATE_DIR` env override for an isolated state dir (multi-profile / testing).
- `test:restore` — headless proof that sessions survive a SIGKILL'd daemon.

### Changed
- The daemon (not the GUI) now builds and types the launch command, so it can replay it on
  reboot. Default Claude launches use `--session-id <uuid>` so the conversation is precisely
  resumable; "Resume" templates still open the interactive picker.

## 0.2.0
- Tab islands (named/colored/collapsible groups), switchable left-rail / top-navbar layout.
- Claude-as-operator over MCP (spawn/rename/move/notify… from inside a tab).
- Comms dashboard: Claude inbox + clickable vault handoffs/projects.
- Built-in media widget (Windows SMTC: title/artist/art, play-pause/skip, volume).
- Tab attention badge, Ctrl+K command palette (fuzzy, accent-tolerant).
- MIT license, claudpit logo, packaged NSIS + portable Windows builds.

## 0.1.0
- First cut: multiple PowerShell tabs as real PTYs owned by a crash-survivable daemon;
  GUI close/crash no longer kills sessions (re-attach replays scrollback).
