## 1. Application side

- [x] 1.1 Handle `--version`, `-V` and `--help` at the top of `main()` before any window, keychain or network access; version from `CARGO_PKG_VERSION` (spec: homebrew-packaging › Command-line version flag)
- [x] 1.2 Confirm the executable inside the bundle is `Clew.app/Contents/MacOS/clew` and that running it without arguments opens the window
- [x] 1.3 Check what signature an unsigned universal build carries (`codesign -dv`, `codesign --verify --deep --strict`) and, if the bundle is unsealed, set an ad-hoc `signingIdentity` for unsigned builds; record the finding in design.md (spec: homebrew-packaging › Unsigned Apple Silicon builds launch)
- [x] 1.4 Test: unit test for the flag parser; CI step runs `clew --version` from a built bundle

## 2. Template and renderer

- [x] 2.1 Write `packaging/homebrew/clew.rb.tmpl` with `@VERSION@`, `@SHA256@`, `@POSTFLIGHT@` and `@CAVEATS@`, the zap list and the livecheck (spec: homebrew-packaging › Cask in the maintainer's tap)
- [x] 2.2 Port `render-cask` to `scripts/release/render-cask.ts`: checksum parsing, stable-version check, digest validation, unsigned postflight and caveat, `--signed`, `--out` (spec: homebrew-packaging › Cask rendering, Quarantine cleared for unsigned builds)
- [x] 2.3 Test: Vitest cases ported from mergeIQ's `render-cask.test.mjs` (stable release, pre-release refused, missing and malformed digest, signed output without postflight, `{{appdir}}` preserved, no leftover placeholder)
- [x] 2.4 Test: render the cask for a fixture release and run `brew style --cask` on it locally

## 3. Release workflow

- [x] 3.1 Expose `version`, `tag`, `prerelease` and `signed_macos` outputs from the verify job and make sure the installer is named `Clew_<version>_universal.dmg` and listed in `SHA256SUMS.txt` (depends on `add-release-packaging`)
- [x] 3.2 Add the `homebrew` job after publish: token check, download checksums, render, push (spec: homebrew-packaging › Release automation for the tap)
- [x] 3.3 Gate step: temporary tap, `brew style`, `brew audit --cask --online --strict`, install, quarantine absent, `clew --version`, arm64 launch, `codesign` summary, uninstall leaves nothing (spec: homebrew-packaging › Cask gate)
- [x] 3.4 Push step: one commit `clew <version>` touching only `Casks/clew.rb`; no-op when unchanged; first commit on an empty tap
- [x] 3.5 Test: a workflow lint test (like mergeIQ's `workflow.test`) asserting the job's `needs`, stable-only condition, token skip and single-file push; dry-run on a fork or test tag without the token

## 4. Tap repository

- [ ] 4.1 Create a fine-grained token for `karthikkumararun/homebrew-tap` (contents read and write) and store it as `HOMEBREW_TAP_TOKEN` in the Clew repository (manual, maintainer)
- [ ] 4.2 Update the tap README to list `mergeiq` and `clew` with install commands and the quarantine explanation (pull request in the tap repository, maintainer)
- [ ] 4.3 First release: confirm the commit appears in the tap and `brew install --cask karthikkumararun/tap/clew` works on a clean Mac

## 5. Homebrew-aware updates

- [x] 5.1 Detect a Homebrew install from the two Caskroom paths in Rust and expose it to the frontend (spec: homebrew-packaging › Homebrew-managed updates)
- [x] 5.2 Settings › Updates: show the `brew upgrade --cask clew` command with Copy for Homebrew installs, keep the version check, and remove the install button
- [x] 5.3 Test: detection with a fake Caskroom directory; the Updates page renders each mode

## 6. Documentation

- [x] 6.1 README Install section: Homebrew command first, `.dmg` instructions with the `xattr` one-liner, trust statement, `brew cat` tip (spec: homebrew-packaging › Documentation, Integrity and trust)
- [x] 6.2 `docs/homebrew.md`: how a release reaches the tap, what to do when the gate fails, token creation and rotation, switching to the signed cask
- [x] 6.3 Release notes template: install section with both methods

## 7. Verification (manual, on a Mac without developer tools)

- [ ] 7.1 Fresh Mac or user account: tap, install, open from Launchpad and Spotlight without a Gatekeeper dialog, check `xattr`, run `clew --version` (spec: homebrew-packaging › Quarantine cleared for unsigned builds)
- [ ] 7.2 `brew upgrade --cask clew` after a second release: still opens without a warning
- [ ] 7.3 `brew uninstall --cask clew` and `brew uninstall --zap --cask clew`: only the listed files go; `~/Documents/Clew/Scripts` and the keychain items remain (spec: homebrew-packaging › Uninstall and zap)
- [ ] 7.4 Intel Mac (or Rosetta) launch of the universal build

## 8. End-to-end

- [x] 8.1 E2E: add the `clew --version` check and the Homebrew-install detection (fake Caskroom) to the smoke suite on macOS
- [x] 8.2 Declare `covers(...)` for the homebrew-packaging scenarios the smoke suite exercises
