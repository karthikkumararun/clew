# Homebrew

`brew install --cask karthikkumararun/tap/clew` installs the macOS build from the maintainer's tap,
[`karthikkumararun/homebrew-tap`](https://github.com/karthikkumararun/homebrew-tap). The cask
(`Casks/clew.rb`) is written only by the release workflow.

## How a release reaches the tap

1. Tag `vX.Y.Z` → `release.yml` builds, checks and creates the draft release (docs/releasing.md).
2. You publish the draft. Publishing triggers `.github/workflows/homebrew.yml` (not the draft's
   creation, so the cask never points at a download that is not public). Pre-releases and drafts
   are skipped.
3. It renders `packaging/homebrew/clew.rb.tmpl` with `scripts/release/render-cask.ts` (version and
   the digest of `Clew_<version>_universal.dmg` from the release's `SHA256SUMS.txt`; whether the
   build was signed from its `BUILD_SIGNED_MACOS.txt`), gates the cask in a temporary tap on a
   macOS runner (`brew style`, `brew audit --cask --online --strict`, a real install, quarantine
   absent, `clew --version`, the app stays up on Apple Silicon, clean uninstall) and pushes one
   commit `clew <version>` touching only `Casks/clew.rb`.

The workflow skips with a notice when `HOMEBREW_TAP_TOKEN` is not set, and it never changes the
release. To repeat it for a tag: Actions › Homebrew tap › Run workflow.

## Why the cask clears quarantine

There is no Apple Developer account, so the app is neither signed with a Developer ID nor
notarized. macOS marks downloads as quarantined and Gatekeeper refuses to open such an app. The
cask's `postflight_steps` runs `/usr/bin/xattr -dr com.apple.quarantine /Applications/Clew.app`
after every install and upgrade, so the app opens normally. It signs nothing; it only tells macOS to
skip the check for this copy. Homebrew removed `--no-quarantine`, and its official cask repository
is dropping casks that fail Gatekeeper, which is why this lives in a personal tap. A `.dmg` that
someone downloads in a browser is still quarantined: README explains right-click › Open.

The app does carry an **ad-hoc code signature** (`bundle.macOS.signingIdentity: "-"`): Apple
Silicon will not run a binary without one, and an ad-hoc seal makes `codesign --verify --deep
--strict` pass. It is not a trust signal.

## When the gate fails

The failing step names the cause; nothing reached the tap. Fix it (usually a Homebrew DSL change:
run `brew style --cask` on the rendered cask locally with
`pnpm exec tsx scripts/release/render-cask.ts --version X.Y.Z --checksums SHA256SUMS.txt --out Casks/clew.rb`)
and use **Re-run failed jobs** (or Run workflow with the tag).

## Token creation and rotation

1. GitHub › Settings › Developer settings › Fine-grained tokens › Generate.
2. Resource owner: you. Repository access: **only** `homebrew-tap`. Permission: Contents
   read and write. Pick an expiry you will remember.
3. Store it as the `HOMEBREW_TAP_TOKEN` secret of the `clew` repository (the same value may be used
   by `mergeIQ`).
4. To rotate, repeat and overwrite the secret. An expired token fails the push step; re-run it.

## Switching to a signed build

When the app is signed and notarized, the `signed_macos` output becomes `true` and the renderer
drops the postflight and the caveat on its own (`--signed`). Nothing else changes.

## Uninstall

`brew uninstall --cask clew` removes the app and the `clew` link. `--zap` also removes Clew's
support folders (listed in the cask) but never `~/Documents/Clew` or Keychain items; delete saved
passwords in Keychain Access (service "Clew").
