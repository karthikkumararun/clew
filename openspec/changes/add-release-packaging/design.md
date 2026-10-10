## Context

Repository: https://github.com/karthikkumararun/clew (updater manifest URL and About links point here).

The CI workflow from `add-app-shell` builds debug bundles. This change adds a release pipeline, signing, updates and project hygiene. Targets: macOS 12+ (universal) and Windows 10/11 x64.

## Decisions

- **tauri-action** (`tauri-apps/tauri-action`) in a matrix: `macos-14` with `--target universal-apple-darwin`, `windows-latest` with `--bundles nsis,msi`. Draft release; a maintainer publishes it after a smoke test.
- **macOS signing:** import the .p12 into a temporary keychain; `APPLE_SIGNING_IDENTITY`; notarize with `notarytool` via Tauri's built-in support (APPLE_ID / APPLE_PASSWORD app-specific password / APPLE_TEAM_ID). Entitlements: network client, user-selected file read/write; no JIT entitlement needed.
- **Windows signing:** prefer Azure Trusted Signing (cheaper for individuals) via `signCommand`; fall back to a PFX certificate. WebView2: `webviewInstallMode: downloadBootstrapper` for NSIS, `embedBootstrapper` for MSI.
- **Updater:** `tauri-plugin-updater` with `latest.json` attached to each release; the endpoint is the GitHub "latest release" asset URL. Public key in `tauri.conf.json`; private key only in CI secrets.
- **Licenses:** `cargo about generate` + `license-checker --production --json` merged into `THIRD_PARTY_LICENSES.html` bundled as a resource; CI checks the allow-list with `cargo deny` and a small Node script.
- **DuckDB / Copilot:** DuckDB is bundled (static). The Copilot language server is **not** bundled (downloaded on consent at runtime, see `add-ai-assistant`), keeping its license out of our distribution.

## Risks / Trade-offs

- [Apple Developer Program costs $99/yr; Windows signing also costs] → Pipeline works unsigned; signing is enabled by adding secrets later.
- [Universal macOS build doubles Rust compile time] → Cache cargo per target; release builds are infrequent.
- [SmartScreen warnings for new certificates] → Expected until reputation builds; documented in README.

## Open Questions

- Copyright holder line for LICENSE: "ADK" or your full name?
