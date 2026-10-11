## 1. Sources and guidelines

- [x] 1.1 Review `design/icons/*.svg` against `design/canvas/AppIcon.dc.html`; fix any difference (spec: app-icon › Icon artwork and sources)
- [x] 1.2 Write `design/icons/README.md`: files, palette, clear space (100 px macOS, 48 px Windows), minimum sizes, and don'ts (no recolouring, outlines, effects, or placing the mark on gold)
- [x] 1.3 Test: `scripts/check-icons.ts` validates the sources (valid SVG, viewBox, palette, contrast >= 7:1) with fixtures that fail on an off-palette colour

## 2. Generator

- [x] 2.1 Record the SHA-256 of every file currently in `src-tauri/icons/` into `scripts/tauri-default-icon-hashes.txt` before replacing anything (spec: app-icon › No default Tauri art)
- [x] 2.2 `scripts/build-icons.ts` with `@resvg/resvg-js`: render exact-size PNGs; size rule below 48 px uses the small artwork (spec: app-icon › Size-specific artwork)
- [x] 2.3 ICO writer (16, 20, 24, 32, 40, 48, 64, 128, 256; PNG-compressed 256) and ICNS writer (icp4, icp5, icp6, ic07, ic08, ic09, ic10) (spec: app-icon › Deterministic icon generation)
- [x] 2.4 Generate `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png` (512), the Windows Store logos from the Windows master, and the `icons/dev/` set with the DEV pill
- [x] 2.5 `pnpm icons` script; commit the generated files
- [x] 2.6 Test: running twice is byte-identical; ICO/ICNS parsers list exactly the required sizes; 16 px comes from the small artwork

## 3. Tauri wiring

- [x] 3.1 Replace `src-tauri/icons/*` with the generated files; keep `tauri.conf.json` icon names; add the NSIS installer icon (spec: app-icon › Platform integration)
- [x] 3.2 `src-tauri/tauri.dev.conf.json` selecting `icons/dev/*` and update the `dev` script to use it (spec: app-icon › Development builds are distinguishable)
- [x] 3.3 Verify the built macOS bundle contains our `icon.icns` and the Windows executable resource lists the ICO sizes (CI step on the existing build jobs)
- [x] 3.4 Note the macOS `tauri dev` Dock-icon behaviour in design.md (open question)

## 4. In-app mark

- [x] 4.1 Generate `src/components/ClewMark.tsx` from `clew-mark.svg` in the same script (size, title, currentColor, unique mask id) (spec: app-icon › In-app mark)
- [x] 4.2 Use `ClewMark` at 20 px in the toolbar (accent colour, accessible name "Clew") and 56 px on the Welcome screen per the updated canvas; remove the old line-art paths and `ClewLogo`
- [x] 4.3 Test: toolbar and Welcome render the mark with the right size, accent colour and accessible name; no other file in `src/` contains the old logo paths

## 5. Checks in CI

- [x] 5.1 `check-icons` in the PR workflow: regenerate and diff, default-art hash check, ICO/ICNS contents (spec: app-icon › No default Tauri art, Deterministic icon generation)
- [x] 5.2 Golden PNGs for 16, 32, 64, 256, 1024 in `design/icons/golden/` and the `pixelmatch` comparison with diff output; `--update-golden` flow (spec: app-icon › Golden images)
- [x] 5.3 Test: a deliberately shifted thread fails the golden check (fixture, then remove)

## 6. Platform verification (manual)

- [ ] 6.1 Walk through the platform list in the spec on macOS (Dock light and dark, Cmd+Tab, Finder views, Launchpad, `.dmg`) and Windows (taskbar dark and light at 100/125/150%, Start, Alt+Tab, Apps list, installer, high contrast); record results in the QA checklist or the PR (spec: app-icon › Platform verification)
- [ ] 6.2 Check the newest macOS available for system wrapping of the icon and record the outcome under Open Questions

## 7. End-to-end

- [ ] 7.1 E2E (design suite, once `add-e2e-testing` exists): add the toolbar mark and the Welcome mark to `design/states.json`, covering `app-icon › In-app mark`
- [ ] 7.2 E2E: smoke check that the window icon is not Tauri's default (hash of the window icon resource) on Windows and Linux
