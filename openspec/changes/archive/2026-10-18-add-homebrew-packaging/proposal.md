## Why

Most of Clew's macOS audience installs apps with Homebrew, and the maintainer already runs a tap (`karthikkumararun/homebrew-tap`, currently serving the `mergeiq` cask). A `brew install` is the easiest way for friends and contributors to get Clew, but the macOS build will not be signed or notarized (there is no Apple Developer account), so a downloaded copy opens with Gatekeeper's "cannot be opened" warning. Homebrew removed the `--no-quarantine` flag and is dropping casks that fail Gatekeeper from its own cask repository, so the right home for an unsigned app is the maintainer's own tap, with the cask clearing the quarantine attribute itself after install. The `mergeiq` repository already has a working, tested pipeline for exactly this; Clew should reuse the same design.

## What Changes

- Add a `clew` cask to the tap (`brew install --cask karthikkumararun/tap/clew`): universal `.dmg` from the GitHub release, pinned SHA-256, livecheck on the latest GitHub release, macOS 12+, the `Clew.app` bundle and a `clew` command-line link.
- While the app is unsigned, the cask runs `xattr -dr com.apple.quarantine` on the installed app in a `postflight_steps` block (after install and every upgrade) and prints a caveat explaining it. When Clew is later signed and notarized, both disappear from the rendered cask without any other change.
- Add a cask template and renderer (`packaging/homebrew/clew.rb.tmpl`, `scripts/release/render-cask`) that fill the version and SHA-256 from the release's own `SHA256SUMS.txt`, with tests; only stable releases are rendered.
- Add a `homebrew` job to the release workflow that runs after the release is published: render, gate with Homebrew's own `style`, `audit --strict --online`, a real install (quarantine gone, `clew --version` correct, Apple Silicon launch works) and uninstall, then push a single commit to the tap. It skips quietly without the tap token and never affects the published release.
- Add `clew --version` (prints `clew <version>`, exits without a window) to the app binary, used by the gate and available to users.
- Make unsigned Apple Silicon builds launchable and verified (ad-hoc signature requirement and a launch check in CI).
- Make the app aware of Homebrew installs: Settings › Updates says "Installed with Homebrew: update with `brew upgrade --cask clew`" and in-app installation of updates is disabled for those installs.
- Define what `brew uninstall --zap` removes and, deliberately, does not (keychain items, the user's SQL scripts).
- Document installation, what the postflight does and why, and the trust model in the README and the tap README.

## Capabilities

### New Capabilities
- `homebrew-packaging`: the cask, quarantine handling for unsigned builds, rendering, release automation and gate, the `--version` flag, Homebrew-aware updates, uninstall behaviour and documentation.

### Modified Capabilities
- (none; the Homebrew-aware updates requirement lives in the new capability so it does not depend on `release-packaging` being archived first)

## Impact

- New: `packaging/homebrew/clew.rb.tmpl`, `scripts/release/render-cask.ts` (+ tests and fixtures), a `homebrew` job in `.github/workflows/release.yml`, `--version` handling in `src-tauri/src/main.rs`, Homebrew-install detection in the updater settings.
- Secrets: `HOMEBREW_TAP_TOKEN` (fine-grained token with contents write access to `homebrew-tap` only). Without it the job is skipped.
- External repo: `karthikkumararun/homebrew-tap` gains `Casks/clew.rb` (written only by the workflow) and a README listing the casks.
- Depends on `add-release-packaging` (produces `Clew_<version>_universal.dmg`, `SHA256SUMS.txt` and the `signed_macos` output).
- Reference implementation: `karthikkumararun/mergeIQ` (`scripts/release/render-cask.mjs`, `packaging/homebrew/mergeiq.rb.tmpl`, the `homebrew` job in its `release.yml`).
