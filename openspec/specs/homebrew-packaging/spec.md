# homebrew-packaging Specification

## Purpose
TBD - created by archiving change add-homebrew-packaging. Update Purpose after archive.
## Requirements
### Requirement: Cask in the maintainer's tap
The tap `karthikkumararun/homebrew-tap` SHALL provide `Casks/clew.rb` so that `brew install --cask karthikkumararun/tap/clew` (or `brew tap karthikkumararun/tap` then `brew install --cask clew`) installs Clew. The cask SHALL declare: the version; the SHA-256 of the macOS installer; the URL `https://github.com/karthikkumararun/clew/releases/download/v<version>/Clew_<version>_universal.dmg`; name "Clew"; the description; the homepage; a `livecheck` on the latest GitHub release; `depends_on macos: :monterey` (Homebrew's style check requires this form for "macOS 12 or later"); the app `Clew.app`; a `binary` link to `Clew.app/Contents/MacOS/clew`; and a `zap` list (see Uninstall). The cask SHALL be the only file the release workflow writes to the tap.

#### Scenario: Install from the tap
- **WHEN** a user runs `brew install --cask karthikkumararun/tap/clew` on a Mac running macOS 12 or later
- **THEN** `Clew.app` is in `/Applications` and the `clew` command is linked into Homebrew's `bin`

#### Scenario: Unsupported macOS
- **WHEN** a user on macOS 11 runs the install command
- **THEN** Homebrew refuses with its standard "requires macOS >= 12" message and installs nothing

#### Scenario: Both architectures
- **WHEN** the installer is the universal `.dmg`
- **THEN** the same cask installs a working app on Apple Silicon and on Intel Macs

#### Scenario: Update detection
- **WHEN** a new stable release is published
- **THEN** `brew livecheck karthikkumararun/tap/clew` reports the new version

### Requirement: Quarantine cleared for unsigned builds
While the macOS build is not signed with a Developer ID certificate and notarized, the cask SHALL clear the quarantine attribute from the installed app after every install and upgrade, using a `postflight_steps` block that runs `/usr/bin/xattr -dr com.apple.quarantine "{{appdir}}/Clew.app"`, and SHALL print a caveat saying that Clew is not signed or notarized, that the cask clears macOS's quarantine attribute so the app opens normally, and that a manually downloaded `.dmg` needs right-click › Open the first time (with the equivalent `xattr` command). When the release is signed and notarized, the rendered cask SHALL contain neither the postflight nor the caveat.

#### Scenario: Opens without a warning
- **WHEN** a user installs the unsigned cask and opens Clew from Launchpad
- **THEN** macOS shows no "cannot be opened because the developer cannot be verified" dialog

#### Scenario: Attribute is gone
- **WHEN** the install finishes
- **THEN** `xattr -p com.apple.quarantine /Applications/Clew.app` reports that the attribute does not exist

#### Scenario: Upgrade
- **WHEN** the user runs `brew upgrade --cask clew` to a newer release
- **THEN** the postflight runs again and the upgraded app is not quarantined

#### Scenario: Manual download
- **WHEN** the user downloads the `.dmg` from GitHub instead of using Homebrew
- **THEN** the README and the release notes explain right-click › Open and the `xattr -dr com.apple.quarantine /Applications/Clew.app` command

#### Scenario: Signed release
- **WHEN** the release workflow reports that the macOS build is signed and notarized
- **THEN** the rendered cask has no `postflight_steps` and no unsigned caveat

### Requirement: Integrity and trust
The cask's SHA-256 SHALL be the digest of the installer listed in the `SHA256SUMS.txt` published with the same release, so Homebrew verifies the download before installing. The URL SHALL point only to a release asset of `karthikkumararun/clew`. The README SHALL state plainly that, because the app is unsigned and the cask removes macOS's quarantine check, installing it means trusting this repository's releases and the tap, and SHALL describe how to inspect the cask (`brew cat --cask karthikkumararun/tap/clew`).

#### Scenario: Tampered download
- **WHEN** the installer on GitHub no longer matches the cask's SHA-256
- **THEN** Homebrew aborts the install with its checksum mismatch error

#### Scenario: Inspect before installing
- **WHEN** a user runs `brew cat --cask karthikkumararun/tap/clew`
- **THEN** the cask text shows the exact URL, checksum and the `xattr` step

### Requirement: Cask rendering
`packaging/homebrew/clew.rb.tmpl` and `scripts/release/render-cask` SHALL produce the cask from the release version and the installer's entry in `SHA256SUMS.txt`, with the unsigned postflight and caveat included unless `--signed` is passed. Template placeholders SHALL use a syntax that cannot collide with Homebrew's own `{{appdir}}` placeholder (for example `@VERSION@`, `@SHA256@`, `@POSTFLIGHT@`, `@CAVEATS@`). Rendering SHALL fail, writing nothing, for a pre-release or malformed version, a missing installer entry, or a digest that is not 64 lowercase hexadecimal characters. Only stable `MAJOR.MINOR.PATCH` versions SHALL be rendered.

#### Scenario: Render a stable release
- **WHEN** the renderer runs with version `0.1.0` and a checksum file that lists `Clew_0.1.0_universal.dmg`
- **THEN** the output cask contains version `0.1.0` and that digest, the postflight and the caveat

#### Scenario: Pre-release refused
- **WHEN** the version is `0.2.0-rc.1`
- **THEN** the renderer exits non-zero and says only stable releases are published to the tap

#### Scenario: Missing checksum entry
- **WHEN** the checksum file has no entry for the installer
- **THEN** the renderer exits non-zero naming the missing file

#### Scenario: Placeholder syntax
- **WHEN** the unsigned cask is rendered
- **THEN** it still contains the literal `{{appdir}}` for Homebrew and no unreplaced template placeholder

### Requirement: Release automation for the tap
A `homebrew` job, in a workflow of its own that runs when a release is published (not when its draft is created), SHALL run only for stable releases. It SHALL: skip itself with a notice when the `HOMEBREW_TAP_TOKEN` secret is not configured; download `SHA256SUMS.txt` and `BUILD_SIGNED_MACOS.txt` from the release; render the cask; gate the cask (see next requirement); and push exactly one commit named `clew <version>` that changes only `Casks/clew.rb` to the tap's default branch. Re-running with an unchanged cask SHALL push nothing. Pre-releases SHALL never update the tap. A failure of this job SHALL NOT change or unpublish the release, and "Re-run failed jobs" SHALL repeat only this job.

#### Scenario: Stable release
- **WHEN** release `v0.1.0` is published
- **THEN** the tap receives one commit `clew 0.1.0` that changes only `Casks/clew.rb`

#### Scenario: Pre-release
- **WHEN** release `v0.2.0-rc.1` is published as a pre-release
- **THEN** the `homebrew` job does not run and the tap is unchanged

#### Scenario: No token
- **WHEN** the repository has no `HOMEBREW_TAP_TOKEN` secret
- **THEN** the job ends successfully with a notice that the tap was not updated, and the release stays published

#### Scenario: Idempotent re-run
- **WHEN** the job runs again for a version already in the tap
- **THEN** it reports that there is nothing to push and makes no commit

#### Scenario: Unexpected file changes
- **WHEN** staging the cask would change any file other than `Casks/clew.rb`
- **THEN** the job fails before pushing

### Requirement: Cask gate
Before anything reaches the tap, the rendered cask SHALL pass, on a macOS runner and in a temporary local tap: `brew style --cask`; `brew audit --cask --online --strict`; a real `brew install --cask`; a check that the quarantine attribute is absent on the installed app (for unsigned releases); a check that `clew --version` prints `clew <version>`; a check that the app starts on the runner's architecture (Apple Silicon); and `brew uninstall --cask`, after which neither the app nor the `clew` link may remain. The job SHALL record the app's code-signature status (`codesign -dv`) in its summary.

#### Scenario: Gate passes
- **WHEN** a correct cask is rendered for a published release
- **THEN** style, audit, install, quarantine, version, launch and uninstall checks all pass and the push step runs

#### Scenario: Quarantine left behind
- **WHEN** the installed app still carries the quarantine attribute
- **THEN** the gate fails with "the app is still quarantined after install" and nothing is pushed

#### Scenario: Wrong version
- **WHEN** `clew --version` prints a version different from the release
- **THEN** the gate fails naming both versions

#### Scenario: Leftovers after uninstall
- **WHEN** uninstall leaves `Clew.app` or the `clew` link behind
- **THEN** the gate fails

### Requirement: Command-line version flag
The application binary SHALL answer `--version` (and `-V`) by printing `clew <version>` to standard output and exiting with status 0 before any window, webview, keychain or network access, and SHALL print the same on `--help` together with a one-line description. The `clew` command linked by the cask SHALL start the application normally when run without arguments.

#### Scenario: Version flag
- **WHEN** `clew --version` runs on a machine without a display session
- **THEN** it prints `clew 0.1.0` and exits with status 0 without opening a window

#### Scenario: No arguments
- **WHEN** a user runs `clew` in a terminal on a Mac
- **THEN** the Clew window opens as if launched from Launchpad

### Requirement: Unsigned Apple Silicon builds launch
Unsigned macOS builds SHALL still run on Apple Silicon: the app bundle SHALL carry at least an ad-hoc code signature on both architectures (applied by the build when no Developer ID identity is configured), the release workflow SHALL verify it with `codesign --verify --deep --strict` and by running `clew --version` on an Apple Silicon runner, and the build SHALL fail if the binary is killed by the system on launch.

#### Scenario: Apple Silicon launch
- **WHEN** the unsigned universal build runs on an Apple Silicon Mac after the quarantine attribute is cleared
- **THEN** the app starts normally

#### Scenario: Missing signature
- **WHEN** a build leaves the arm64 binary without any signature
- **THEN** the release workflow's launch check fails before the release is published

### Requirement: Homebrew-managed updates
When Clew is installed through Homebrew (a `Caskroom/clew` directory exists under `/opt/homebrew` or `/usr/local`), Settings › Updates SHALL show "Installed with Homebrew. Update with: `brew upgrade --cask clew`" with a Copy button, SHALL still allow checking whether a newer version exists when update checks are enabled, and SHALL NOT download or install updates itself. For other installs the in-app updater behaves as specified for release packaging.

#### Scenario: Homebrew install
- **WHEN** the user opens Settings › Updates in a Homebrew-installed copy
- **THEN** the page shows the `brew upgrade --cask clew` command and no "Install update" button

#### Scenario: Newer version available
- **WHEN** update checks are on and a newer release exists
- **THEN** a Homebrew-installed copy says "Version 0.2.0 is available. Update with: brew upgrade --cask clew"

#### Scenario: Direct download install
- **WHEN** Clew was installed from the `.dmg`
- **THEN** the in-app updater works as usual

### Requirement: Uninstall and zap
`brew uninstall --cask clew` SHALL remove the app and the `clew` link. `brew uninstall --zap --cask clew` SHALL additionally remove only Clew's own support files: `~/Library/Application Support/Clew`, `~/Library/Caches/dev.adk.clew`, `~/Library/HTTPStorages/dev.adk.clew`, `~/Library/Logs/Clew`, `~/Library/Preferences/dev.adk.clew.plist`, `~/Library/Saved Application State/dev.adk.clew.savedState` and `~/Library/WebKit/dev.adk.clew`. It SHALL NOT remove the user's SQL scripts (`~/Documents/Clew`), exported files, or items in the keychain. The uninstall caveat SHALL say that saved passwords remain in the keychain under the service name "Clew" and how to remove them.

#### Scenario: Plain uninstall
- **WHEN** the user runs `brew uninstall --cask clew`
- **THEN** the app and link are gone and the saved connections remain

#### Scenario: Zap
- **WHEN** the user runs `brew uninstall --zap --cask clew`
- **THEN** the listed support folders are removed, `~/Documents/Clew/Scripts` is still there, and the caveat explains the keychain entries

### Requirement: Documentation
The repository README SHALL have an Install section with the Homebrew command, the manual `.dmg` instructions including the quarantine workaround, and the trust statement; the tap's README SHALL list its casks (`mergeiq`, `clew`) with install commands and a short explanation of why the casks clear quarantine and what that implies; and `docs/` SHALL describe how a release reaches the tap, what to do when the gate fails, how to create and rotate the tap token, and how to switch the cask to the signed form once the app is notarized.

#### Scenario: Find the install command
- **WHEN** a new user opens the repository README
- **THEN** the Install section shows `brew install --cask karthikkumararun/tap/clew` first

#### Scenario: Token rotation
- **WHEN** the tap token expires
- **THEN** the docs explain how to create a fine-grained token limited to the tap repository and store it as `HOMEBREW_TAP_TOKEN`

