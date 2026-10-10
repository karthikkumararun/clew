## 1. Bundling

- [ ] 1.1 Configure `tauri.conf.json` bundle: product name, identifier, icons (thread-ball logo at all sizes, .icns/.ico), macOS minimum 12.0, entitlements, Windows NSIS + MSI with WebView2 install modes (spec: release-packaging › Installers for macOS and Windows)
- [ ] 1.2 Generate app icons from a master SVG of the logo (`pnpm tauri icon`)
- [ ] 1.3 Test: local `pnpm tauri build` produces a .dmg on macOS and .exe/.msi on Windows (CI artifact check)

## 2. Release workflow

- [ ] 2.1 `.github/workflows/release.yml` on `v*` tags with tauri-action matrix (universal macOS, Windows x64), draft release, SHA256SUMS
- [ ] 2.2 macOS signing + notarization when secrets exist; unsigned fallback labelled in the release (spec: release-packaging › Signing and notarization)
- [ ] 2.3 Windows Authenticode signing (Azure Trusted Signing or PFX) when secrets exist
- [ ] 2.4 Test: dry-run the workflow on a `v0.0.0-test` tag in a fork without secrets

## 3. Updates

- [ ] 3.1 Add `tauri-plugin-updater` and `tauri-plugin-process`; generate the updater key pair; publish `latest.json` (spec: release-packaging › Opt-in updates)
- [ ] 3.2 Settings › Updates: auto-check toggle (default off), Check now, notes dialog, install-and-restart with unsaved-work/transaction guard
- [ ] 3.3 Test: signature failure discards the update (mock manifest)

## 4. About and licenses

- [ ] 4.1 About dialog with logo, "Clew by ADK", version, commit (injected at build), MIT, links (spec: release-packaging › About dialog)
- [ ] 4.2 Generate THIRD_PARTY_LICENSES.html with cargo-about + license-checker; viewer in About
- [ ] 4.3 CI license allow-list check (`cargo deny`, node script)
- [ ] 4.4 Test: About shows build version; license check fails on a disallowed fixture

## 5. Project files

- [ ] 5.1 LICENSE (MIT), README (screenshots from the canvas, install, build, databases, AI & privacy), CONTRIBUTING (OpenSpec workflow), CODE_OF_CONDUCT, SECURITY.md, issue/PR templates (spec: release-packaging › Open-source project files)
