# Releasing Clew

A release is a version tag. Pushing `v0.2.0` runs `.github/workflows/release.yml`, which builds the
macOS universal `.dmg` and the Windows x64 installers, checks that each installs, and creates a
**draft** GitHub Release. You read it, smoke-test the files, and press Publish.

## Cut a release

1. Bump the version everywhere with `pnpm release:bump 0.2.0` (it sets `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the `clew` entry of `Cargo.lock` together),
   commit it through a pull request. The workflow refuses a tag that does not match all of them.
2. Make sure `main` is green, including the nightly end-to-end run and the manual checklist
   (`docs/qa/README.md`, `pnpm qa:gate <commit>`).
3. `git tag v0.2.0 && git push origin v0.2.0`.
4. When the workflow finishes, open the draft release. Download the installer for your platform
   and try it. Check `SHA256SUMS.txt` against the file.
5. Publish. From this moment installed copies with "Check for updates automatically" turned on
   will find `latest.json`.

A version with a suffix (`v0.2.0-beta.1`) becomes a pre-release.

**Dry run:** Actions › Release › Run workflow. It builds and checks everything and uploads the
files and the update manifest as a workflow artifact, but creates no release.

If a platform fails, no release is created. Fix the cause, delete the tag
(`git push --delete origin v0.2.0`), and tag again.

## What the release contains

| File                                             | What                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `Clew_<version>_universal.dmg`                   | macOS 12+, Apple Silicon and Intel                                       |
| `Clew_<version>_x64.exe`                         | Windows 10/11, per-user NSIS installer (installs or bootstraps WebView2) |
| `Clew_<version>_x64.msi`                         | The same for managed installs                                            |
| `Clew_<version>_universal.app.tar.gz` (+ `.sig`) | What the in-app updater downloads on macOS                               |
| `Clew_<version>_x64.exe.sig`                     | The signature of the Windows setup used by the updater                   |
| `SHA256SUMS.txt`                                 | Checksums of the installers and archives                                 |
| `latest.json`                                    | The update manifest the app reads                                        |

## The updater key (required)

Update packages are signed with a Tauri updater key, separate from any Apple or Windows
certificate. The public half is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the
private half must exist only as repository secrets:

| Secret                               | Value                                |
| ------------------------------------ | ------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | The contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password (empty if it has none)  |

The first key pair was generated with `pnpm tauri signer generate -w ~/.tauri/clew-updater.key`;
the private key is `~/.tauri/clew-updater.key` on the machine that ran it. **Back it up.** If it
is lost, installed copies can never verify another update, and you would have to ship a new
public key in a release that users install by hand. To replace the key, generate a new pair, put
the new public key in `tauri.conf.json`, and update the secrets.

Without these secrets the workflow still builds installers, but the release has no `latest.json`
and the build fails at the update-archive step: add them before the first tag.

## Signing (optional; unsigned builds work)

Without signing secrets the installers are unsigned and the release page says so, with how to open
them. Add secrets to turn signing on; nothing else changes.

**macOS** (Apple Developer Program, $99/year): `APPLE_CERTIFICATE` (base64 of the Developer ID
Application `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (for example
`Developer ID Application: Name (TEAMID)`), `APPLE_ID`, `APPLE_PASSWORD` (an app-specific
password) and `APPLE_TEAM_ID`. The build is signed with the hardened runtime, notarized and
stapled, and the workflow runs `codesign`, `spctl` and `stapler` checks on the result.

**Windows**, either:

- Azure Trusted Signing: `AZURE_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`,
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; or
- a PFX certificate: `WINDOWS_CERTIFICATE` (base64 of the `.pfx`) and
  `WINDOWS_CERTIFICATE_PASSWORD`.

The workflow verifies the installed `clew.exe` with `Get-AuthenticodeSignature`. New certificates
start without SmartScreen reputation, so warnings can continue for a while.

## Third-party licenses

`pnpm build:licenses` writes `src-tauri/resources/THIRD_PARTY_LICENSES.html` from `cargo about`
(Rust) and from the npm packages Vite actually bundles; the release workflow runs it before
building, and About › Third-party licenses shows it. CI fails a pull request that adds a
dependency whose license is outside the allow-list (`src-tauri/deny.toml`,
`scripts/licenses-lib.ts`). The committed file is a short stub so development builds work.

## Forks

A fork can run the workflow with no secrets. It needs only its own updater key pair (put the
public key in `tauri.conf.json`). Installers come out unsigned.
