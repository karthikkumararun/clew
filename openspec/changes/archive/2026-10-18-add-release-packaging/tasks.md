## 1. Bundling

- [x] 1.1 Configure `tauri.conf.json` bundle: product name, identifier, icons (thread-ball logo at all sizes, .icns/.ico), macOS minimum 12.0, entitlements, Windows NSIS + MSI with WebView2 install modes (spec: release-packaging › Installers for macOS and Windows)
- [x] 1.2 Generate app icons from a master SVG of the logo (`pnpm tauri icon`)
- [x] 1.3 Test: local `pnpm tauri build` produces a .dmg on macOS and .exe/.msi on Windows (CI artifact check)

## 2. Release workflow

- [x] 2.1 `.github/workflows/release.yml` on `v*` tags with tauri-action matrix (universal macOS, Windows x64), draft release, SHA256SUMS
- [x] 2.2 macOS signing + notarization when secrets exist; unsigned fallback labelled in the release (spec: release-packaging › Signing and notarization)
- [x] 2.3 Windows Authenticode signing (Azure Trusted Signing or PFX) when secrets exist
- [x] 2.4 Test: dry-run the workflow (Actions › Release › Run workflow, which builds and checks everything and publishes nothing; run on the repository itself, with secrets, three times until green)  possible only once the workflow is on the default branch

## 3. Updates

- [x] 3.1 Add `tauri-plugin-updater` and `tauri-plugin-process`; generate the updater key pair; publish `latest.json` (spec: release-packaging › Opt-in updates)
- [x] 3.2 Settings › Updates: auto-check toggle (default off), Check now, notes dialog, install-and-restart with unsaved-work/transaction guard
- [x] 3.3 Test: signature failure discards the update (mock manifest)

## 4. About and licenses

- [x] 4.1 About dialog with logo, "Clew by ADK", version, commit (injected at build), MIT, links (spec: release-packaging › About dialog)
- [x] 4.2 Generate THIRD_PARTY_LICENSES.html with cargo-about + license-checker; viewer in About
- [x] 4.3 CI license allow-list check (`cargo deny`, node script)
- [x] 4.4 Test: About shows build version; license check fails on a disallowed fixture

## 5. Project files

- [x] 5.1 LICENSE (MIT), README (screenshots from the canvas, install, build, databases, AI & privacy), CONTRIBUTING (OpenSpec workflow), CODE_OF_CONDUCT, SECURITY.md, issue/PR templates (spec: release-packaging › Open-source project files)

## 6. Homebrew hand-off

- [x] 6.0 Make the release workflow expose `version`, `tag`, `prerelease` and `signed_macos` outputs, name the macOS installer `Clew_<version>_universal.dmg`, list it in `SHA256SUMS.txt`, and publish before any later job runs (consumed by `add-homebrew-packaging`)

## 7. End-to-end

- [x] 7.1 E2E: add journey J-19 in `e2e/specs/` — install the built package on macOS and Windows, launch, About shows the version and commit, Copy diagnostics is redacted, update check is off by default
- [x] 7.2 Declare `covers(...)` for the scenarios it exercises (e.g. release-packaging › About dialog) and add the seed/compose service it needs to the matching profile
