## Context

The app currently ships Tauri's default icons (`src-tauri/icons/`: `icon.icns`, `icon.ico`, `icon.png`, `32x32.png`, `128x128.png`, `128x128@2x.png` and the `Square*Logo.png` Windows Store set) and an inline line-art logo (`ClewLogo` in `src/components/icons/index.tsx`) used by the toolbar and Welcome screen. The icon is designed on the canvas (`design/canvas/AppIcon.dc.html`); the SVG sources are already in `design/icons/`.

## Goals / Non-Goals

**Goals:** one source of truth (SVG), reproducible generation on every OS, size-specific artwork so 16 px is legible, a clear dev-build marker, one identity for the app and its in-app logo, and checks that stop regressions.
**Non-Goals:** a light-theme variant (the icon carries its own dark ground, so it works on light and dark docks and taskbars), tray or menu-bar icons (no tray in v1), animated icons, Linux packaging polish (PNGs are generated but not verified), a favicon (no web build).

## Decisions

### The design
A clew is a ball of thread; the trailing end is the thread that leads you out of the labyrinth. Gold is the app's accent colour and the "thread" colour used throughout the UI. Strand cut-outs follow two crossing wraps like real yarn rather than a grid, so it reads as thread and not as a globe or a basketball. The thread leaves from beneath the ball and runs to the right so the shape never reads as a Q (the project is "Clew", not "Q").

### Three artworks, one mark
- **macOS master** (`clew-icon.svg`): macOS does not mask or shade third-party icons, so the 824 px body, the 100 px margin, the soft shadow and the hairline highlight are part of the artwork. The shadow filter uses `color-interpolation-filters="sRGB"`: in the default linear mode dark gradients quantise unevenly and the base turns teal.
- **Windows master** (`clew-icon-windows.svg`): same drawing, 928 px body, no shadow, because Windows places icons edge to edge.
- **Small** (`clew-icon-small.svg`): redrawn for sizes below 48 px: two strands about 2.5x thicker, the ball larger, the thread thicker and detached beneath the ball, near full-bleed body. Scaling the master down at 16 px turns three fine strands into mush.
- **Mark** (`clew-mark.svg`): one colour on a 24 px grid with a mask cutting the strands out of the disc, so it works on any background and takes `currentColor`.

### Generation (`scripts/build-icons.ts`, run with `pnpm icons`)
- **Rendering:** `@resvg/resvg-js` renders each SVG to PNG at the exact target size. It supports clip paths, masks and filters and produces the same pixels on every OS (no dependence on system fonts, Quick Look, `iconutil` or browsers).
- **ICO:** a small writer assembling PNG-compressed entries for 16, 20, 24, 32, 40, 48, 64, 128, 256 (the Windows icon scale ladder at 100%, 125%, 150% and 200%).
- **ICNS:** a small writer assembling PNG entries with type codes `icp4` (16), `icp5` (32), `icp6` (64), `ic07` (128), `ic08` (256), `ic09` (512), `ic10` (1024). Alternative: `png2icons`; chosen only if the in-repo writers prove fiddly.
- **Determinism:** fixed render options, no timestamps in container headers, sorted entries; CI regenerates and `git diff --exit-code`, as already done for the generated TypeScript bindings.
- **Size rule:** `size < 48 → small`, otherwise platform master. The threshold is a constant shared by the generator and the canvas page generator.
- **Dev variants:** a copy of each set with a blue (`--info` family `#7FC8F8`) rounded "DEV" pill at the lower left (x 215-465, y 760-856 in master space), generated into `icons/dev/`. `src-tauri/tauri.dev.conf.json` overrides `bundle.icon` with them; `pnpm tauri dev` passes `--config src-tauri/tauri.dev.conf.json`.

### Tauri wiring
`tauri.conf.json`: keep the existing `bundle.icon` list (names unchanged) and add `bundle.windows.nsis.installerIcon: "icons/icon.ico"`. The window icon on Windows and Linux comes from `icons/icon.png` via Tauri's default; the macOS Dock icon comes from the bundle.

### In-app mark
`scripts/build-icons.ts` also converts `clew-mark.svg` into `src/components/ClewMark.tsx` (a React component with `size` and optional `title`, `fill="currentColor"`, mask id made unique per instance with `useId`). `ClewLogo` becomes a thin wrapper kept for existing imports, then removed once call sites use `ClewMark`. The About dialog (built in `add-release-packaging`) imports a 192 px PNG rendered from the macOS master.

### Checks (`scripts/check-icons.ts`, in PR CI)
Sources parse and are 1024 viewBox; palette check; gold/strand contrast >= 7:1 from the documented constants; generated outputs match a fresh generation; ICO and ICNS entry lists; SHA-256 comparison against `scripts/tauri-default-icon-hashes.txt` (recorded before replacing the defaults); golden PNG comparison with `pixelmatch` at 0.1% for 16, 32, 64, 256, 1024 px in `design/icons/golden/`.

## Risks / Trade-offs

- [Small-size art looks different from the master] → Intentional (like Apple's and Microsoft's own icons); the canvas shows both side by side and the goldens lock them.
- [resvg renders filters or masks slightly differently from browsers] → Goldens are generated by resvg itself; the canvas page is a design reference, not a pixel target.
- [Committed generated binaries bloat diffs] → Icons change rarely; the CI regeneration check keeps them honest.
- [Dev-badge icons might be confused for the real icon in screenshots] → They exist only under `icons/dev/` and are excluded from release bundles (checked in CI).

## Open Questions

- **Newest macOS versions** may wrap or restyle icons that lack the newer layered icon format (Apple's Icon Composer `.icon`). Verify on the maintainer's macOS; if the icon is wrapped in a system container, add a layered icon asset in a follow-up change.
- **Dock icon of `tauri dev` on macOS**: verified by the maintainer: plain `pnpm tauri dev` shows the Clew icon (release artwork, no badge) in the Dock, so the Dock does pick up `bundle.icon` without a bundle. `pnpm dev:app` also verified: the Dock shows the icon with the DEV pill at the lower left.
- **Licensing of the artwork and name**: should the icon and the name "Clew by ADK" be covered by the project's MIT license, or reserved as a trademark with a short usage note in the README?
