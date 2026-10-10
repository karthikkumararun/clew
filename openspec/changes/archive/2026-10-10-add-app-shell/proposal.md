## Why

Clew has no code yet. Every later feature (connections, explorer, console, grid) needs a running desktop app on macOS and Windows with the workspace layout, tab system, keyboard-shortcut plumbing and design tokens from the UX canvas. Building this foundation first gives the other changes a fixed frame to slot into.

## What Changes

- Scaffold a Tauri 2 + React 18 + TypeScript + Vite project (pnpm) with the repository layout from the project context.
- Bring in the design system: `design/tokens.css` becomes `src/styles/tokens.css`; IBM Plex Sans and JetBrains Mono are bundled locally; a small set of shared primitives (Button, IconButton, Input, Select, Checkbox, SegmentedControl, Tabs, Badge, DriverBadge, EnvDot, Kbd, Tooltip, Dialog, Menu) is built to match the canvas.
- Add the workspace layout: 44px main toolbar (logo + "Clew / by ADK" wordmark, slots for connection chip and actions), resizable explorer sidebar slot, editor area with a tab strip, a resizable right side-panel slot (for the AI assistant), 26px status bar.
- Add a generic editor-tab system (open, focus, close, reorder, dirty marker, environment stripe) that later features register tab kinds into.
- Add a keyboard shortcut registry with platform-aware `Mod` (Cmd on macOS, Ctrl on Windows).
- Add the Welcome screen shown when no tabs are open (actions are stubs, wired by later changes).
- Add a Settings dialog (Mod+,) with persisted app preferences.
- Persist window size/position, sidebar width and open tabs across restarts.
- Add a CI workflow that builds and tests on macOS and Windows for every push.

Canvas screens implemented: `design/canvas/Main.dc.html` (frame only: toolbar, sidebar slot, tab strip, status bar), `design/canvas/Welcome.dc.html`.

## Capabilities

### New Capabilities
- `app-shell`: the desktop window, workspace layout, tab system, keyboard shortcuts, welcome screen, settings and persisted UI state.

### Modified Capabilities
- (none)

## Impact

- New: the whole repository skeleton (`src-tauri/`, `src/`, `package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`).
- Dependencies: tauri 2, @tauri-apps/api, react 18, zustand, @fontsource/ibm-plex-sans, @fontsource/jetbrains-mono, vitest, @testing-library/react.
- Platforms: macOS 12+ (arm64 + x64), Windows 10/11 x64 with the WebView2 runtime.
