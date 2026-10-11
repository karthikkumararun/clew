## Why

Clew still ships with Tauri's default icon, so the app has no identity in the Dock, the taskbar, Finder, File Explorer, the installers or the repository. The icon is also the first impression for the people the project is shared with. The icon has been designed on the canvas; this change turns it into real, correctly built assets and makes the in-app logo match it.

## What Changes

- Add the app icon artwork as SVG sources in `design/icons/`: a macOS master (`clew-icon.svg`), a Windows master (`clew-icon-windows.svg`), a small-size artwork for sizes below 48 px (`clew-icon-small.svg`) and a one-colour mark (`clew-mark.svg`). The design is the canvas screen `design/canvas/AppIcon.dc.html`.
- Add a deterministic generator (`pnpm icons`) that renders the sources into every platform asset in `src-tauri/icons/` (macOS `.icns`, Windows `.ico`, PNG sets, Windows Store logos) plus development-build variants with a DEV badge.
- Wire the icons into the Tauri bundle configuration, window icon and installers, and remove every file of Tauri's default art.
- Replace the in-app line-art logo (`ClewLogo`) with the mark in the toolbar, Welcome screen and (when it exists) About dialog, so the app and its icon are one identity.
- Add automated checks: no default Tauri art, required sizes present in the `.ico` and `.icns`, golden-image comparisons, contrast, and CI check that generated assets are up to date.
- Add a manual verification list for Dock, app switcher, Finder, taskbar scaling, installers and high-contrast mode.

Canvas screens implemented: `design/canvas/AppIcon.dc.html`; logo instances updated in `Main.dc.html`, `Welcome.dc.html` and `AIAssistant.dc.html`.

## Capabilities

### New Capabilities
- `app-icon`: the icon artwork and variants, generated platform assets, bundle and window wiring, development-build badge, in-app mark, and the checks that keep them correct.

### Modified Capabilities
- (none)

## Impact

- New: `design/icons/*.svg`, `design/icons/README.md`, `scripts/build-icons.ts`, `scripts/check-icons.ts`, `src-tauri/icons/**` regenerated, `src-tauri/tauri.dev.conf.json`, `src/components/ClewMark.tsx` (generated from `clew-mark.svg`).
- Changed: `src-tauri/tauri.conf.json` (bundle icons, NSIS installer icon), `src/components/icons/index.tsx` (`ClewLogo` uses the mark), toolbar and Welcome components, CI workflow (icons up to date, default-art check).
- Dev dependencies: `@resvg/resvg-js` (SVG to PNG), an ICO/ICNS writer (`png2icons` or a small in-repo writer).
- Depends on `add-app-shell`. Independent of every other change and can be built at any time.
