# coclaude-pit — manual test checklist

> Living doc. Claude appends items as features land; you tick them off when you get to it.
> Items marked **(auto ✓)** were already verified headlessly — only re-check in the GUI if you doubt them.

## How to load the latest build
- **Full restart** (close window + `npm start`): needed after `app/main.js` or `daemon/` changes.
- **Renderer-only** changes: `Ctrl+Shift+R` in the window is enough.
- ⚠️ A **daemon code change ends live sessions** (the engine itself is replaced). A normal GUI restart keeps sessions alive — that's the whole survival point; only daemon upgrades break it.

---

## 0 · Survival  (auto ✓ `npm run test:survive`)
- [ ] Open a session, type a few commands. **Close the window.** `npm start`. → same session, scrollback intact, same shell process (not a fresh shell).
- [ ] Stronger: start something long-running in a tab (e.g. `1..100 | % { $_; sleep 1 }`), close the window, reopen → it's still counting.

## 1 · Tabs & layout
- [ ] `+` → each template opens a working PowerShell (home / vault / dev).
- [ ] **Double-click** a tab name → rename sticks.
- [ ] **Right-click** a tab → pick a color swatch → the dot recolors.
- [ ] Hover a tab → **`×`** closes it (asks first).
- [ ] **`▦`** toggles left rail ↔ top bar; the choice survives a restart.

## menu bar
- [ ] No File/Edit/View/Window bar. `F12` still opens devtools; `Ctrl+Shift+R` reloads.

## 2 · Claude state icons  (auto ✓ `npm run test:state` for the wiring)
- [ ] `+` → **Claude · vault** → `claude` launches in the vault automatically.
- [ ] Tab dot is **blue (pulsing)** while Claude works, **green** when it finishes a turn.
- [ ] When Claude needs permission/input → dot goes **amber** + you get a **desktop notification** "… is waiting on you".
- [ ] Switch to a different tab — the working tab's dot keeps updating in the rail (you can watch N sessions at once).
- ⚠️ Known gap: a Claude started via your manual `vault` function (not the template) won't report state yet — only the **Claude · vault** template wires it.

## 3 · Tab islands  (auto ✓ `npm run test:islands` for the registry)
- [ ] **`⊞`** creates an island; type its name inline.
- [ ] Right-click a tab → **"Move to island"** → it nests under the island (indented in left layout).
- [ ] Click an island's **caret** to collapse/expand (collapsed hides its tabs).
- [ ] Right-click an island header → **rename / color / delete**. Delete must **keep** the tabs (they fall back to ungrouped), not kill them.
- [ ] Islands + their collapse state **persist across a restart**.
- [ ] Both left and top layouts render islands sensibly.

## 4 · Operator — Claude drives the cockpit  (auto ✓ `npm run test:operator`)
The cockpit's **Claude · vault** template now launches with the cockpit MCP server, so the
Claude running *inside that tab* can operate the app. Open a **Claude · vault** tab, then ask it:
- [ ] "**spawn a new session** called scratch" → a new tab appears in the rail.
- [ ] "**rename this tab** to 'driver' and make it blue" → the tab updates live.
- [ ] "**create an island** called Ops and **move** the scratch tab into it" → island appears, tab nests under it.
- [ ] "**read the last output** of the scratch session" → Claude can quote what's in that other tab.
- [ ] "**notify me** that you're done" → you get a desktop notification "coclaude-pit · Claude".
- [ ] "**close** the scratch session" → that tab disappears.
- ⚠️ Security: these tools run in a live shell on localhost (token-gated). `cockpit_send_text` can execute commands — intended, but be aware.
- ⚠️ Only Claude sessions started from the **Claude · vault** template have these tools (it injects `--mcp-config`). A manual `claude` won't.
