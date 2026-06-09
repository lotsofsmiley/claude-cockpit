---
title: "Per-tab heavy-MCP toggle (opt-in --mcp-config)"
tags:
  - handoff
status: open
priority: medium
created: 2026-06-09
topic: "let a tab opt into heavy MCP servers (chrome-devtools/excel/browsermcp) instead of every session loading them"
---

# Per-tab heavy-MCP toggle

## Context

Cockpit auto-resumes all saved tabs at launch (Filipe runs ~19). Every Claude
session also loads the MCP servers configured in the user's global
`~/.claude.json`. On 2026-06-09 that came to **18 GB across 167 node/python/claude
processes, 3 GB free of 31 GB** — the bulk being heavy MCPs loaded into every idle
tab. `chrome-devtools` alone is ~240 MB/session (it spawns headless Chrome **plus**
a watchdog process).

Mitigation already applied (outside this repo):
- Moved `chrome-devtools`, `browsermcp`, `excel` OUT of global `~/.claude.json`
  into an opt-in file **`~/.coclaude-pit/mcp-heavy.json`** (preserved, not deleted).
- Global auto-load now = only `shared_ops_ro` (read-only Postgres, light).

Why this feature: there is **no runtime toggle** for MCP servers. Verified against
installed claude-code **v2.1.170** — `claude mcp` has only
add/add-from-claude-desktop/add-json/get/list/remove/reset-project-choices/serve
(no enable/disable), and `/mcp` interactive only does approve/auth/reconnect/
health-check. A server in global config **always** loads; the only off-by-default
gate (`.mcp.json` project approval) is all-or-nothing per project and useless here
because all cockpit tabs share one cwd (the vault). So per-session MCP selection
**must** happen at launch via `--mcp-config`, which is exactly the seam cockpit
already owns. This feature surfaces that as a per-tab switch.

Key fact: `--mcp-config <configs...>` is **variadic** and **additive** (without
`--strict-mcp-config` it merges on top of global + project). So a heavy tab just
passes a second file.

## Current spawn seam (where this hooks)

`daemon/index.js`:
- `STATE_DIR` — line ~26
- `MCP_CONFIG_FILE = path.join(STATE_DIR, 'mcp.json')` — line ~32 (the coclaude-pit
  operator MCP, written by `buildMcpConfig`/`cfg = { mcpServers: { 'coclaude-pit': … } }` ~line 144)
- `claudeCmd(mode, { claudeId, prompt })` — lines ~245-251. Today:
  ```js
  const mcp = fs.existsSync(MCP_CONFIG_FILE) ? ` --mcp-config "${MCP_CONFIG_FILE}"` : '';
  ```
- `spawnSession(opts = {})` — line ~253; builds the session record `s` and the pty.

## What is needed from Filipe

- [ ] **Granularity:** per-tab/session (recommended) vs per-island vs per-template? Default off (light)?
- [ ] **Generalize or not:** single "heavy" bundle toggle now (recommended — fast), or a
      general mechanism where a tab opts into one or more named mcp-config presets
      (`mcp-heavy.json`, future `mcp-db.json`, …)? Pick the near-term scope.
- [ ] **UI affordance:** tab right-click context-menu checkbox, a field in the
      new-session dialog, or both? (The toggle only takes effect on (re)launch of the
      tab's claude — the MCP set is fixed at spawn and cannot be hot-added.)
- [ ] **Restart behaviour:** when toggled on a live tab, offer to relaunch that tab's
      claude immediately, or just apply on next launch? Recommend: prompt to relaunch.

## What Claude will do when unblocked

1. `daemon/index.js`:
   - Add `HEAVY_MCP_FILE = path.join(STATE_DIR, 'mcp-heavy.json')`.
   - Extend `claudeCmd(mode, { claudeId, prompt, heavyMcp })` to build a file list and
     emit a single variadic flag:
     ```js
     const files = [];
     if (fs.existsSync(MCP_CONFIG_FILE)) files.push(MCP_CONFIG_FILE);
     if (heavyMcp && fs.existsSync(HEAVY_MCP_FILE)) files.push(HEAVY_MCP_FILE);
     const mcp = files.length ? ' --mcp-config ' + files.map(f => `"${f}"`).join(' ') : '';
     ```
   - Thread `heavyMcp` through `spawnSession`, the session record `s`, the new/
     resume-id/resume-picker command builders, state persistence, and reboot-restore
     so the flag survives a cockpit restart.
   - Add a daemon endpoint / WS message `setSessionHeavyMcp(id, bool)`.
2. `app/` (renderer + preload): per-tab toggle calling the daemon, with a
   "restart claude in this tab to apply" affordance.
3. Ship `~/.coclaude-pit/mcp-heavy.json` as a managed default if missing (same way
   `mcp.json` is written by the daemon), seeded with chrome-devtools/browsermcp/excel.
4. Update `CHANGELOG.md`, bump version, test per `TESTING.md`, build + publish per the
   claudpit release recipe (draft + API publish; GH token at
   `C:\claude-cockpit\git-access-token.txt`; exclude `releases/` from build).

## Notes / gotchas

- Do NOT use mid-session `claude mcp add` as the mechanism — it persists to disk and,
  because all tabs share the vault cwd, leaks the server into other vault tabs.
- Toggling cannot hot-load into a running session; it always implies a tab relaunch.
- The opt-in file `~/.coclaude-pit/mcp-heavy.json` already exists on Filipe's machine.
- Backup of the pre-change global config: `~/.claude.json.bak-20260609`.
