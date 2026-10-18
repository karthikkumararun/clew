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

- Homebrew installation is specified separately in `add-homebrew-packaging`. It needs this change to publish `Clew_<version>_universal.dmg`, `SHA256SUMS.txt` and a `signed_macos` workflow output, to keep Apple Silicon builds launchable without a Developer ID (ad-hoc signature), and to leave in-app update installation to Homebrew for Homebrew installs.

- Copyright holder line for LICENSE: settled as "ADK" (as the spec says); change `LICENSE` and `bundle.copyright` together if that should be a personal name.

## Implementation notes

Decisions taken while building:

- **Release overlay config.** `src-tauri/tauri.release.conf.json` only adds `createUpdaterArtifacts: true`; the workflow passes it with `--config`. Putting it in `tauri.conf.json` would make every local `tauri build` fail without the signing key.
- **Draft release only after every build.** The build matrix uploads its files as workflow artifacts; a final `publish` job needs all of them and is the only one that runs `gh release create --draft`, so a failing platform leaves no partial release. tauri-action is used to build, not to publish. "Run workflow" by hand is a dry run: it builds, checks and uploads the files and `latest.json` as an artifact, but creates no release.
- **Names.** The bundler's names (`Clew_0.1.0_x64-setup.exe`, `Clew_0.1.0_x64_en-US.msi`, `Clew.app.tar.gz`) are renamed to `Clew_<version>_<platform>.<ext>` by `scripts/release/lib.ts`; the updater manifest is built from those names. Checksums cover installers and archives, not the `.sig` files.
- **Update manifest.** Built by `scripts/release/lib.ts` from the `.sig` files: both macOS architectures take the universal archive, Windows takes the NSIS setup, and a platform without a signature is left out. The endpoint is the "latest release" asset URL, so an update is offered only after a draft is published.
- **Updater key.** Generated with `pnpm tauri signer generate` (no password); the public key is in `tauri.conf.json`, the private key stays on the maintainer's machine and in the `TAURI_SIGNING_PRIVATE_KEY` secret. `docs/releasing.md` says how to back it up and replace it.
- **WebView2.** Tauri has one `webviewInstallMode` for both Windows installers, so both use `embedBootstrapper` (a small bootstrapper that downloads the runtime if it is missing) instead of NSIS `downloadBootstrapper` and MSI `embedBootstrapper`.
- **macOS entitlements.** Hardened runtime plus `com.apple.security.cs.disable-library-validation`, which the user-installed Oracle Instant Client needs, and `network.client`. The app is not sandboxed.
- **Licenses.** `cargo about generate --format json` for Rust, and for npm the packages Vite really bundles (collected from a production build, licenses from `pnpm licenses`), so build tools such as Babel are not listed. The result is `src-tauri/resources/THIRD_PARTY_LICENSES.html`, shown in a sandboxed frame by About. A short stub is committed so development builds find the resource. The script is `pnpm build:licenses` (`pnpm licenses` is a pnpm command). CI runs `pnpm check:licenses` (npm) and `cargo deny check licenses` (Rust). Four licenses beyond the spec's list were allowed because shipped dependencies use them and they are permissive: BSL-1.0 (xxhash-rust), CDLA-Permissive-2.0 (Mozilla's certificate list in webpki-roots), OFL-1.1 (the two bundled fonts) and 0BSD (tslib).
- **Package checks.** A release build has no test mode, so WebDriver cannot drive the installed package. The release workflow checks the built package itself (macOS: both architectures, minimum system version, signature, notarization when signed; Windows: silent install, `clew.exe` present and validly signed when signed, uninstall). J-19 drives About, the license viewer, Copy diagnostics and the Updates settings in the end-to-end build.
- **Hand-off to `add-homebrew-packaging`.** The `publish` job outputs `version`, `tag`, `prerelease` and `signed_macos`; the macOS installer is `Clew_<version>_universal.dmg`; `SHA256SUMS.txt` lists it; the release exists before any later job runs.
- **Updates in Homebrew installs** are left to Homebrew by `add-homebrew-packaging`.
