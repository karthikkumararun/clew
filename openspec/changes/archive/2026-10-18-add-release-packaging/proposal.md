## Why

Clew is meant to be shared with friends and the open-source community, so it needs installers people can download and trust on macOS and Windows, a repeatable release process, and a way to receive updates.

## What Changes

- Release workflow on GitHub Actions triggered by a version tag (`v*`): build macOS universal (Apple Silicon + Intel) `.dmg` and Windows x64 NSIS `.exe` (+ `.msi`), attach them to a draft GitHub Release with checksums and release notes.
- Code signing and notarization when secrets are present: Apple Developer ID + notarytool; Windows Authenticode (certificate or Azure Trusted Signing). Unsigned builds remain possible for forks, with instructions.
- Opt-in auto-update via the Tauri updater using signed update manifests hosted on GitHub Releases ("Check for updates" off by default, in Settings › Updates).
- About dialog: logo, "Clew by ADK", version, commit, license (MIT), links to GitHub, third-party licenses.
- Open-source hygiene: LICENSE (MIT), README with screenshots, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md, issue templates, third-party license bundle generated at build time.

## Capabilities

### New Capabilities
- `release-packaging`: build, sign, publish and update Clew on macOS and Windows, plus the About dialog and project licensing.

### Modified Capabilities
- (none)

## Impact

- `.github/workflows/release.yml`, `src-tauri/tauri.conf.json` bundle/updater config, `src-tauri/Entitlements.plist`, `scripts/` for license bundling.
- Secrets (optional): `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_PASSWORD`, `WINDOWS_CERTIFICATE`/Azure signing credentials, `TAURI_SIGNING_PRIVATE_KEY`.
- Dependencies: `tauri-plugin-updater`, `tauri-plugin-process`, `cargo-about` (CI), `license-checker` (CI).
