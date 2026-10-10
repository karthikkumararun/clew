## Context

Empty repository. This change creates the skeleton every other change builds on. The UX is fixed by `design/canvas/Main.dc.html` (frame) and `design/canvas/Welcome.dc.html`; tokens are in `design/tokens.css`.

## Goals / Non-Goals

**Goals:**
- A Tauri 2 app that builds, runs and is tested in CI on macOS and Windows.
- Pixel-faithful workspace frame and Welcome screen using only tokens.
- Extension points later changes use without editing the shell: sidebar panel slot, right side-panel slot, tab-kind registry, toolbar slots, status-bar items, shortcut registry, command registry (used by the palette later).

**Non-Goals:**
- Any database code (next change: `add-driver-framework`).
- A light theme, i18n, Linux packaging, signing and auto-update (see `add-release-packaging`).

## Decisions

### Tauri 2 over Electron
Small installers (~10–15 MB vs ~150 MB), lower memory, and database drivers in Rust (sqlx, tiberius, mongodb, redis, duckdb) that run off the UI thread with no native Node add-ons to rebuild per platform. Trade-off: WKWebView and WebView2 render slightly differently, so we test both in CI and avoid bleeding-edge CSS.

### Frontend structure
```
src/
  main.tsx, App.tsx
  styles/tokens.css, global.css (reset, fonts, focus ring)
  components/         Button, IconButton, Input, Select, Checkbox, SegmentedControl,
                      Tabs, Badge, DriverBadge, EnvDot, Kbd, Tooltip, Dialog, Menu, SplitPane, icons/
  shell/              Workspace.tsx, Toolbar.tsx, Sidebar.tsx, SidePanel.tsx, EditorArea.tsx, TabStrip.tsx,
                      StatusBar.tsx, Welcome.tsx, SettingsDialog.tsx
  shell/registry/     tabKinds.ts, shortcuts.ts, commands.ts, statusItems.ts
  stores/             workspaceStore.ts (tabs, active tab, layout), settingsStore.ts
  lib/ipc.ts          typed wrappers around invoke()/Channel
  lib/platform.ts     isMac, modKeyLabel()
```
CSS Modules per component; class names follow the canvas (e.g. `.tb` → `Button` variant `toolbar`).

### Tab-kind registry
`registerTabKind({ kind, icon, title(state), render(props), isDirty?(state), serialize?, deserialize? })`. The workspace store holds `{ id, kind, key, state }[]`; `key` deduplicates (e.g. `table:<connId>:<schema>.<table>`). Serialized tab state is saved to the app store on change (debounced 500ms) and on quit.

### Shortcut registry
A small in-house registry (no library): bindings `{ id, keys: 'Mod+Shift+K', scope: 'global' | 'editor' | 'grid' | 'dialog', when?(), run() }`. One `keydown` listener on `window`; the editor scope is handled by CodeMirror keymaps that call into the registry, so the editor wins inside the editor. Labels come from `formatShortcut(keys, platform)`.

### Persistence
Rust side owns files under the platform app-data dir (`tauri::path::app_data_dir`, identifier `dev.adk.clew`, product name `Clew`):
- `settings.json`: preferences (serde, versioned with `"version": 1`).
- `clew.db`: SQLite (sqlx, migrations in `src-tauri/migrations/`) with tables `ui_state(key TEXT PK, value TEXT)`; later changes add history and saved queries.
Window geometry uses `tauri-plugin-window-state`.

### Window chrome
macOS: `titleBarStyle: "Overlay"`, `hiddenTitle: true`; the toolbar is a drag region (`data-tauri-drag-region`) with 78px left padding. Windows: default decorations.

### Fonts
`@fontsource/ibm-plex-sans` (400/500/600) and `@fontsource/jetbrains-mono` (400/500/600) imported in `global.css`; CSP forbids remote fonts.

### Security baseline
Tauri capabilities allow only the app's own commands; CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`. No shell or HTTP plugins enabled.

### CI
`.github/workflows/ci.yml`: matrix `macos-14`, `windows-latest`; steps: pnpm install, `pnpm typecheck`, `pnpm test`, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `pnpm tauri build --debug` (no signing).

## Risks / Trade-offs

- [WebView differences] → Visual check on both OSes in CI artifacts; avoid `:has()` and container queries.
- [Overlay title bar drag regions are fiddly] → Only the empty toolbar area is draggable; buttons opt out.
- [Persisting editor text for many tabs] → Cap restored tab content at 5 MB total; larger files reopen from disk.

## Open Questions

- App identifier `dev.adk.clew`: confirm the reverse-DNS before the first public release (it cannot change without losing user data paths).
