## Context

The maintainer's `mergeIQ` repository already ships a working Homebrew pipeline for an unsigned Tauri app, and the tap `karthikkumararun/homebrew-tap` (cask `mergeiq`) proves the approach on Homebrew 7.x:
- `packaging/homebrew/mergeiq.rb.tmpl` and `scripts/release/render-cask.mjs` (+ tests) render the cask from the release version and `SHA256SUMS.txt`, adding a `postflight_steps` block that runs `xattr -dr com.apple.quarantine` and a caveat while the app is unsigned.
- A `homebrew` job in `release.yml` runs after the release is published, skips without `HOMEBREW_TAP_TOKEN`, gates the cask in a temporary local tap (`brew style`, `brew audit --cask --online --strict`, install, quarantine absent, `--version` correct, uninstall clean) and pushes one commit touching only the cask.
Clew should copy this design rather than invent another.

Why a tap and not Homebrew's own cask repository: Homebrew removed the `--no-quarantine` option and announced that casks failing Gatekeeper checks would be disabled in its official collection (cutoff 1 September 2026; I could not confirm what happened on that date, so check the current state before ever proposing an upstream cask). A third-party tap controlled by the maintainer is not subject to that policy as far as I could find (also unconfirmed). The `xattr` postflight is therefore acceptable only in the tap, which the `mergeiq` renderer already notes.

## Goals / Non-Goals

**Goals:** one-command install and upgrade for macOS users; honest handling of the unsigned state; the same trusted automation as mergeIQ; a clean switch to the signed form later.
**Non-Goals:** submitting to `homebrew/cask`; a Homebrew formula (source build); Windows package managers (Scoop and winget are a candidate follow-up); notarization itself (that is the signing work in `add-release-packaging`).

## Decisions

### Port, don't redesign
Port `render-cask` to TypeScript (`scripts/release/render-cask.ts`, Vitest tests with fixtures) because Clew's scripts are TypeScript run by `tsx`; keep the same inputs, the same refusal rules and the same exit codes as the Node original so the two repositories stay easy to compare. The workflow job is copied step for step with names changed; its macOS runner, environment variables (`HOMEBREW_NO_AUTO_UPDATE`, `HOMEBREW_NO_ANALYTICS`, `HOMEBREW_NO_INSTALL_CLEANUP`) and token handling stay.

### Template
`packaging/homebrew/clew.rb.tmpl`:
```ruby
cask "clew" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/karthikkumararun/clew/releases/download/v#{version}/Clew_#{version}_universal.dmg"
  name "Clew"
  desc "Open-source database IDE for SQL and NoSQL databases"
  homepage "https://github.com/karthikkumararun/clew"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :monterey"

  app "Clew.app"
  binary "#{appdir}/Clew.app/Contents/MacOS/clew"
@POSTFLIGHT@
  zap trash: [ ...support files listed in the spec... ]
@CAVEATS@
end
```
The unsigned fragment is `postflight_steps do run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Clew.app"] end`. The `{{appdir}}` is Homebrew's own placeholder; Clew's template placeholders use `@NAME@` so the renderer can never replace it by accident (the mergeIQ template uses `{{…}}` for both, which works only because its renderer replaces a fixed list).

### Why the postflight is correct and what it does not do
Quarantine is added by the downloader (Homebrew's `curl`) and checked by Gatekeeper the first time the app opens. Removing the attribute makes macOS skip that check for this copy; it does not sign anything. It must run after install and after every upgrade (new files, new attribute), which `postflight` does. It cannot help `.dmg` files downloaded in a browser, hence the manual instructions.

### Apple Silicon without a Developer ID
arm64 binaries must carry some signature to run; a completely unsigned arm64 Mach-O is killed. Toolchains normally add an ad-hoc "linker-signed" signature, and the mergeIQ cask works on Apple Silicon today, but Clew will not rely on luck: the gate runs `codesign --verify --deep --strict` and `clew --version` on the arm64 runner and records `codesign -dv` in the summary. If the Tauri bundle turns out to leave the bundle without a seal, set `bundle.macOS.signingIdentity` to `"-"` (ad-hoc) for unsigned builds. I could not confirm Tauri's exact default from its documentation, so this is verified during implementation (task 1.3).

### `--version`
Handled at the top of `main()` before Tauri's builder: `std::env::args()` is checked for `--version`, `-V` or `--help`; the version comes from `env!("CARGO_PKG_VERSION")`, which release tooling already keeps equal to the tag. This gives the gate a fast, display-free check and gives users a tiny CLI.

### Updates for Homebrew installs
Detection is two path checks (`/opt/homebrew/Caskroom/clew`, `/usr/local/Caskroom/clew`); GUI apps do not see the shell's `HOMEBREW_PREFIX`. The cask deliberately omits `auto_updates true`, so `brew upgrade` manages the app and the in-app updater stays out of the way (installing over a Homebrew-managed app would leave Homebrew's records stale and re-trigger quarantine handling).

### Uninstall
`zap` lists only Clew-owned support paths. User-created content (`~/Documents/Clew/Scripts`) and the keychain are out of bounds; the caveat tells users how to remove keychain items (Keychain Access, service "Clew") because a cask cannot do it.

### Token and permissions
`HOMEBREW_TAP_TOKEN` is a fine-grained personal access token limited to `karthikkumararun/homebrew-tap` with contents read and write. It is used only in the `homebrew` job, masked in logs, passed through an HTTP header and never written to disk; the job's own `GITHUB_TOKEN` stays read-only. The same token value can be stored as a secret in both repositories.

## Risks / Trade-offs

- [Homebrew changes the `postflight_steps` DSL or deprecates quarantine removal] → The gate (`style`, `audit --strict`, install) fails before anything reaches the tap, and docs describe the signed alternative.
- [macOS tightens Gatekeeper further so cleared quarantine is not enough] → The post-install launch check on a runner catches it early; the real fix is signing.
- [Users read "unsigned and quarantine removed" as unsafe] → It is unsafe in exactly the way the README says (trust the repository); the checksum chain, `brew cat` and the public workflow are the mitigations.
- [Token leakage] → Minimal scope, masked, short lifetime, rotation documented.
- [Two repos' scripts drift] → Same names, same tests and exit codes; a note in each README points to the other.

## Open Questions

- Should the cask also link a `Clew` shell completion or a `clew <file.sql>` open command? Out of scope until the app accepts file arguments.
- Once notarized, do we propose the cask to `homebrew/cask`? Decide then, after checking the current policy.
