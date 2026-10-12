## ADDED Requirements

### Requirement: Icon artwork and sources
The project SHALL keep the app icon as SVG sources in `design/icons/`, which are the only source of truth for every generated icon: `clew-icon.svg` (macOS master: 1024 px canvas with an 824 px rounded-square body, 100 px transparent margin, baked soft shadow and top highlight), `clew-icon-windows.svg` (Windows master: 928 px body, 48 px margin, no shadow), `clew-icon-small.svg` (simplified artwork for sizes below 48 px: two heavy strands, near full-bleed body, thread detached beneath the ball) and `clew-mark.svg` (one-colour mark with the strands cut out, `currentColor`). The artwork SHALL be a golden (`#E3A64F` family) ball of thread on the dark ground (`#1B2028` to `#0F1217`) with its thread trailing out beneath it, as shown on `design/canvas/AppIcon.dc.html`. The thread SHALL never attach to the ball at its lower right in a way that makes the icon read as the letter Q.

#### Scenario: Sources exist and are valid
- **WHEN** the icon check runs
- **THEN** all four SVG files exist, parse as valid SVG, and the first three have a 1024×1024 viewBox

#### Scenario: Colours stay on palette
- **WHEN** the check scans the colours used in the sources
- **THEN** every colour is one of the documented icon palette values (ground `#1B2028`, `#0F1217`, `#14171C`; gold `#F2C070`, `#E3A64F`, `#C58633`) or white/black at documented opacity

#### Scenario: Legible contrast
- **WHEN** the check computes the contrast between the gold and the strand colour
- **THEN** it is at least 7 : 1

### Requirement: Size-specific artwork
Every raster size SHALL be rendered from the artwork designed for it, never scaled from a different size: pixel sizes below 48 SHALL be rendered from `clew-icon-small.svg`, and sizes of 48 and above from the platform master (`clew-icon.svg` for macOS assets, `clew-icon-windows.svg` for Windows assets). Pixel sizes SHALL be rendered directly at their target size.

#### Scenario: 16 px uses the small artwork
- **WHEN** the generator renders the 16 px image
- **THEN** it is rendered from `clew-icon-small.svg` at 16×16, and the ball and the thread are both visible as separate gold shapes on the dark body

#### Scenario: 64 px uses the master
- **WHEN** the generator renders the 64 px image for macOS
- **THEN** it is rendered from `clew-icon.svg`, and for the Windows `.ico` from `clew-icon-windows.svg`

### Requirement: Deterministic icon generation
`pnpm icons` SHALL render all platform assets from the SVG sources, with no manual steps and the same output for the same inputs on macOS, Linux and Windows. It SHALL write: `icon.icns` containing the representations 16, 32, 64, 128, 256, 512 and 1024 px; `icon.ico` containing 16, 20, 24, 32, 40, 48, 64, 128 and 256 px (PNG-compressed for 256); `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png` (512×512); the Windows Store logos (`Square*Logo.png`, `StoreLogo.png`) rendered from the Windows master; and the development-build set under `icons/dev/`. CI SHALL regenerate the assets and fail if they differ from the committed files.

#### Scenario: Regeneration is a no-op
- **WHEN** `pnpm icons` runs twice on a clean checkout
- **THEN** the second run produces byte-identical files and `git status` shows no change

#### Scenario: Stale assets
- **WHEN** a source SVG is edited and the assets are not regenerated
- **THEN** the CI check fails and tells the developer to run `pnpm icons`

#### Scenario: ICO contents
- **WHEN** the check parses `icon.ico`
- **THEN** it lists exactly the sizes 16, 20, 24, 32, 40, 48, 64, 128 and 256 and no others

#### Scenario: ICNS contents
- **WHEN** the check parses `icon.icns`
- **THEN** it contains the representations 16, 32, 64, 128, 256, 512 and 1024 px

### Requirement: Platform integration
`tauri.conf.json` SHALL list the generated icons for the bundle (`icons/32x32.png`, `icons/128x128.png`, `icons/128x128@2x.png`, `icons/icon.icns`, `icons/icon.ico`) and the Windows NSIS installer and uninstaller SHALL use `icon.ico`. The built application SHALL show the Clew icon: in the macOS Dock, Finder and app switcher; in the Windows taskbar, Start menu, Alt+Tab and Apps list; on the `.dmg` volume; and on the Windows installer.

#### Scenario: macOS bundle icon
- **WHEN** a macOS bundle is built
- **THEN** `Clew.app/Contents/Resources/icon.icns` is byte-identical to `src-tauri/icons/icon.icns`

#### Scenario: Windows executable icon
- **WHEN** a Windows build is produced
- **THEN** the executable's icon resource contains the sizes of `icon.ico`, and the installer shows the Clew icon

### Requirement: No default Tauri art
No file in `src-tauri/icons/` SHALL be identical to an icon shipped by Tauri's project template. CI SHALL compare each file's SHA-256 with `scripts/tauri-default-icon-hashes.txt`, recorded from the default icons before they were replaced, and fail on any match.

#### Scenario: Default icon reintroduced
- **WHEN** a developer runs `tauri icon` with the default source or restores a default file
- **THEN** the check fails and names the file

#### Scenario: Clean tree
- **WHEN** all assets come from `pnpm icons`
- **THEN** the check passes

### Requirement: Development builds are distinguishable
Builds made with `pnpm tauri dev` or the debug profile SHALL use icons that show the same artwork with a blue DEV pill at the lower left of the body, generated into `icons/dev/` and selected through `src-tauri/tauri.dev.conf.json`, so a development build is never mistaken for an installed release. Release builds SHALL NOT contain the badge.

#### Scenario: Dev window icon
- **WHEN** the app runs under `pnpm tauri dev` on Windows
- **THEN** the window and taskbar icon show the DEV pill

#### Scenario: Release has no badge
- **WHEN** CI inspects the release bundle's icons
- **THEN** they are identical to `src-tauri/icons/*` and not to `icons/dev/*`

### Requirement: In-app mark
The application's logo SHALL be the mark from `design/icons/clew-mark.svg`, rendered by a single `ClewMark` component generated from that file, coloured with `currentColor` set to the accent token (`--accent`), with accessible name "Clew". It SHALL appear at 20 px in the main toolbar next to the wordmark "Clew" and "by ADK", at 56 px on the Welcome screen, and the About dialog (once it exists) SHALL show the macOS master icon at 96 px. The earlier line-art logo SHALL be removed.

#### Scenario: Toolbar mark
- **WHEN** the workspace renders
- **THEN** the toolbar shows the mark at 20 px in the accent colour, with the accessible name "Clew", followed by "Clew" and "by ADK"

#### Scenario: Welcome mark
- **WHEN** the Welcome screen renders
- **THEN** the mark is 56 px, accent coloured, above the "Clew" heading

#### Scenario: One source
- **WHEN** `clew-mark.svg` is edited and `pnpm icons` runs
- **THEN** `ClewMark` is regenerated from it and no other file in `src/` contains the logo's paths

#### Scenario: About icon
- **WHEN** the About dialog renders
- **THEN** it shows the macOS master icon at 96 px, not the mark

### Requirement: Golden images
The check SHALL render the generated 16, 32, 64, 256 and 1024 px images and compare them with approved golden PNGs in `design/icons/golden/` with a tolerance of 0.1% of pixels, and SHALL fail with a diff image on any difference. Updating the goldens SHALL require `pnpm icons --update-golden` and a reviewed commit.

#### Scenario: Unintended artwork change
- **WHEN** a source edit shifts the thread by 6 px in the master
- **THEN** the 256 and 1024 px comparisons fail and a diff image is written

#### Scenario: Intended change
- **WHEN** the icon is redesigned deliberately
- **THEN** `--update-golden` regenerates the goldens and the pull request shows the new images for review

### Requirement: Platform verification
Before a release the maintainer SHALL verify the icon on real systems and record it in the manual QA checklist: macOS Dock (light and dark appearance), Cmd+Tab switcher, Finder in icon, list and column views, Launchpad and the `.dmg`; Windows taskbar (dark and light, 100%, 125% and 150% scaling), Start menu, Alt+Tab, Apps list and installer; Windows high-contrast mode; and the newest macOS version available, to confirm the icon is not wrapped or restyled by the system.

#### Scenario: Newest macOS wraps the icon
- **WHEN** the newest macOS shows the icon inside a system-added container
- **THEN** a defect is filed and a layered icon asset is added in a follow-up change (see design open question)

#### Scenario: Taskbar at 150%
- **WHEN** the app runs at 150% display scaling on Windows
- **THEN** the taskbar icon shows both the ball and the thread without blur beyond normal scaling
