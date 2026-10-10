## 1. Project scaffold

- [x] 1.1 Create the Tauri 2 + React 18 + TypeScript + Vite app with pnpm (`pnpm create tauri-app`), product name "Clew", identifier `dev.adk.clew`; enable TypeScript strict mode
- [x] 1.2 Add scripts: `dev`, `build`, `typecheck`, `lint` (eslint + prettier), `test` (vitest); add `rustfmt.toml` and clippy config
- [x] 1.3 Set up the Rust crate layout: `src-tauri/src/{main.rs,lib.rs,error.rs,commands/mod.rs,state.rs}` with a typed `AppError { code, message, detail }` serialized across IPC
- [x] 1.4 Configure the CSP and Tauri capabilities (own commands only, no shell/http plugins) (spec: app-shell › Offline by default)
- [x] 1.5 Add `.github/workflows/ci.yml` with a macos-14 + windows-latest matrix running typecheck, vitest, fmt, clippy, cargo test and a debug build
- [ ] 1.6 Test: CI passes on both OSes with a placeholder window

## 2. Design system primitives

- [x] 2.1 Copy `design/tokens.css` to `src/styles/tokens.css`; add `global.css` (reset, body font, 2px accent focus ring, scrollbars styled to tokens)
- [x] 2.2 Bundle IBM Plex Sans and JetBrains Mono via @fontsource (400/500/600)
- [x] 2.3 Build the icon set as React components (chevrons, plus, close, search, refresh, database, table, folder, key, link, play, filter, download, terminal, settings, warning, check, clock, file) matching the canvas SVG paths
- [x] 2.4 Build Button (default, toolbar, primary/accent, ghost), IconButton (requires aria-label), Input, Select, Checkbox, SegmentedControl, Badge, DriverBadge, EnvDot, Kbd, Tooltip
- [x] 2.5 Build Dialog (focus trap, Esc to close, 12px radius, backdrop `--bg-backdrop`), Menu (keyboard navigable) and SplitPane (drag handle, min/max, persisted size key)
- [x] 2.6 Test: Vitest + RTL tests for focus trap, IconButton a11y label, SplitPane clamping

## 3. Platform and shortcuts

- [x] 3.1 Add `lib/platform.ts` (isMac, isWindows) and `formatShortcut()` rendering ⌘⇧⌥ vs Ctrl+Shift+Alt (spec: app-shell › Keyboard shortcuts)
- [x] 3.2 Implement the shortcut registry with scopes, conflict detection and a single window listener
- [x] 3.3 Implement the command registry `{ id, title, category, shortcut?, run }` (used later by the command palette)
- [x] 3.4 Test: Mod mapping per platform, conflict rejection, editor scope precedence

## 4. Workspace layout

- [x] 4.1 Build `Toolbar` with the logo, "Clew" / "by ADK" wordmark and left/center/right slots; macOS overlay title bar with drag region and 78px inset (spec: app-shell › Brand mark in the toolbar, Desktop application)
- [x] 4.2 Build `Sidebar` slot with resizable width 240–420 (default 272), Mod+B toggle, auto-collapse below 900px (spec: app-shell › Workspace layout)
- [x] 4.3 Build `SidePanel` right slot (380px default, resizable 320–560, persisted open state) and a toolbar toggle-button slot (spec: app-shell › Workspace layout)
- [x] 4.4 Build `StatusBar` with left connection area and a right-side item registry (spec: app-shell › Status bar)
- [x] 4.5 Test: layout renders with canvas metrics; sidebar and side-panel clamp and toggle

## 5. Editor tabs

- [ ] 5.1 Implement `workspaceStore` (Zustand): tabs, activeTabId, open/focus-by-key, close, reorder (spec: app-shell › Editor tabs)
- [ ] 5.2 Implement the tab-kind registry and `EditorArea` that renders the active tab's kind
- [ ] 5.3 Build `TabStrip`: icon, title, subtitle, dirty dot, close button, env stripe, drag-reorder, horizontal overflow scroll, Mod+W, Mod+Shift+[ / ]
- [ ] 5.4 Unsaved-changes confirmation (Save / Discard / Cancel) on close
- [ ] 5.5 Test: dedupe by key, close activates left neighbour, dirty prompt, reorder

## 6. Welcome screen

- [ ] 6.1 Build `Welcome.tsx` per `design/canvas/Welcome.dc.html` including the thread background line, actions, URL field, Recent list (empty state "No connections yet"), shortcut hints (spec: app-shell › Welcome screen)
- [ ] 6.2 Add a Rust command `app_paths()` returning the connections file path and app version; show them in the footer
- [ ] 6.3 Wire the Welcome actions to command ids (`connection.new`, `connection.import`, `file.openDatabase`, `connection.fromUrl`) that are no-ops until later changes register them
- [ ] 6.4 Test: Welcome shows when no tabs are open and after the last tab closes

## 7. Settings and persistence

- [ ] 7.1 Rust: app-data dir setup, `settings.json` read/write with versioning, corrupt-file backup + defaults (spec: app-shell › Settings)
- [ ] 7.2 Rust: `clew.db` with sqlx migrations and `ui_state` table; commands `ui_state_get/set`
- [ ] 7.3 Frontend: `settingsStore` + `SettingsDialog` (Mod+,) with font size, page size, confirm-close, update-check toggle
- [ ] 7.4 Persist and restore open tabs (debounced) and sidebar state; add `tauri-plugin-window-state` with off-screen correction (spec: app-shell › Persisted workspace state)
- [ ] 7.5 Test: Rust tests for settings defaults/corruption; Vitest for restore of three tabs
