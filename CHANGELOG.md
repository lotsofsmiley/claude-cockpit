# Changelog

All notable changes to **claudpit** are recorded here. Versions follow semver-ish bumps.

## 0.3.4

### Fixed
- Ungrouped tabs now match the width of tabs inside islands (left/vertical layout).
- Islands collapse/expand in **both** layouts (top + left), consistently — the caret shows in
  both, and the collapsed state is shared.
- Taskbar icon enlarged again (bold frame near the edges, same `>_` design). If it still looks
  like the old small one, Windows cached the pinned icon — unpin + repin claudpit (or restart
  Explorer) to refresh.

## 0.3.3

### Fixed
- **Updates are now silent and in-place** — no installer wizard, no location prompt. The app
  updates exactly where it is, in the background, then relaunches (the wizard was the NSIS
  installer running interactively; it now runs with `/S`).
- **Claude tabs pin their conversation** (`--session-id`), so on any restart/update each tab
  restores to the *exact* chat instead of dumping you in the resume picker. (Tabs opened before
  this update have no pinned id and show the picker one last time — re-pick them once and
  they're permanent.)
- **Attention badge** only flags work that *started* while a tab was in the background — opening
  a tab (which makes Claude repaint) no longer re-trips the badge.
- **Can't type into the terminal behind a modal** anymore (update / palette / session-types
  grab keystrokes instead of leaking them to the shell).
- **Taskbar icon** restored to the original `>_` design, enlarged to fill the icon like other
  apps' taskbar icons (was a different blue-tile design).

### Note
- Engine revision bumped, so the daemon restarts once to apply (sessions restore through it).

## 0.3.2

### Fixed
- **Attention badges** no longer flood on resume/restore or re-fire on a tab you've already seen.
  A tab earns the yellow `!` only if you've opened it before AND it stays quiet for a few seconds
  after working (a real turn-end, not a mid-stream pause).
- **Resizing** the window now resizes every tab's terminal, not just the active one — switching
  tabs no longer shows a stale layout you'd have to re-resize.
- **Inline rename** no longer gets cancelled/reset when a session's state changes or a
  notification arrives (the rail defers its redraw until you finish), and the rename box border
  is cleaned up (no stray outline).
- **Dashboard** handoff/project clicks focus an already-open session instead of spawning a
  duplicate every time.
- **Update notes** render cleanly (was showing raw HTML tags).

### Changed
- Larger UI fonts across the terminal, rail, menus, dashboard, and palette (daemon-pid text
  stays small).
- The window remembers its last size/position (defaults to ~80% of the screen) instead of
  reopening at a fixed small box.
- The resume session type no longer forces a purple tab color.

## 0.3.1

### Added
- **Engine-update prompt (version mismatch).** The daemon now reports an engine revision. When
  the installed code is newer than the *running* engine, a banner offers a one-click **Restart
  engine** that re-spawns the shells and resumes every Claude conversation (via restore). This is
  how daemon-side changes get applied — the GUI can't update the long-lived daemon in place, so
  the engine is migrated deliberately, losing no conversation. Pure GUI/renderer updates don't
  bump the engine revision, so they never prompt a restart.

### Changed
- Ship only the `en-US` Chromium locale (~46 MB smaller install). This affects only the language
  of Chromium's own built-in UI (context menus, error pages) — not the app's text, the terminal,
  Claude, fonts, or date/number formatting (that's ICU, which stays).

## 0.3.0

### Added
- **Reboot-restore.** Sessions now survive a full machine death (reboot, battery, Windows
  update — not just closing the GUI). The daemon persists a self-sufficient record per
  session (shell, args, cwd, name, color, island, and the Claude session id) and, on a cold
  boot, re-spawns every session that was alive: shells return at their original folder and
  Claude tabs resume their conversation via `claude --resume <id>`.
- **Auto-update** (installed builds only). When a new version is published, a **centered
  modal** (dim backdrop, like the command palette) shows the version and its changes with an
  **Update & restart** button. Because the daemon is detached and owns every PTY, the GUI
  updates and relaunches while all sessions keep running — no work lost.

### Fixed
- **Ctrl+K** now opens the command palette from any focus (it was terminal-focus-only, so it
  did nothing unless a tab had focus).
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
