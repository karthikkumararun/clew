## ADDED Requirements

### Requirement: Installers for macOS and Windows
A tagged release SHALL produce: a macOS universal `.dmg` (arm64 + x86_64, macOS 12+) with the app named "Clew", and Windows x64 installers (NSIS `.exe` per-user install, and `.msi`) that install or bootstrap the WebView2 runtime. Artifacts SHALL be named `Clew_<version>_<platform>.<ext>` (`universal` for macOS, `x64` for Windows) and published with SHA-256 checksums.

#### Scenario: Tag a release
- **WHEN** a maintainer pushes tag `v0.1.0`
- **THEN** CI builds all installers and creates a draft GitHub Release "Clew 0.1.0" with the files, `SHA256SUMS.txt` and generated notes

#### Scenario: Build failure on one platform
- **WHEN** the Windows build fails
- **THEN** no release is published and the workflow reports the failing job

### Requirement: Signing and notarization
When signing secrets are configured, macOS builds SHALL be signed with a Developer ID Application certificate (hardened runtime) and notarized and stapled; Windows installers and the app executable SHALL be Authenticode-signed. Without secrets, the workflow SHALL still produce unsigned builds and label the release "unsigned".

#### Scenario: Signed macOS build
- **WHEN** the release builds with Apple secrets present
- **THEN** `spctl --assess` accepts the app and Gatekeeper opens it without a warning

#### Scenario: Fork without secrets
- **WHEN** a fork runs the release workflow without secrets
- **THEN** unsigned installers are produced and the README explains how to open them

### Requirement: Opt-in updates
Settings › Updates SHALL offer "Check for updates automatically" (default off) and a "Check now" button. Update manifests and packages SHALL be signed with the Tauri updater key and verified before installing. Installing SHALL ask before restarting and never interrupt running queries or lose unsaved work.

#### Scenario: Update available
- **WHEN** the user clicks Check now and version 0.2.0 is available
- **THEN** the app shows the version and notes, and installs and restarts only after the user agrees

#### Scenario: Tampered update
- **WHEN** the downloaded package's signature doesn't verify
- **THEN** the update is discarded and the user sees "Update couldn't be verified"

#### Scenario: Unsaved work on restart
- **WHEN** an update is ready and a console has unsaved changes or an open transaction
- **THEN** the app asks to resolve them before restarting

### Requirement: About dialog
An About dialog (app menu › About Clew on macOS, Help › About on Windows) SHALL show the logo, "Clew", "by ADK", version and commit, "MIT License", links to the GitHub repository and issues, and a "Third-party licenses" viewer.

#### Scenario: Open About
- **WHEN** the user opens About
- **THEN** the dialog shows "Clew by ADK" and the exact version and commit of the build

### Requirement: Open-source project files
The repository SHALL include LICENSE (MIT, copyright ADK), README (what Clew is, screenshots, install, build from source, supported databases, AI providers and privacy), CONTRIBUTING (setup, OpenSpec workflow, tests), CODE_OF_CONDUCT, SECURITY.md (how to report vulnerabilities privately), and GitHub issue/PR templates. A third-party license bundle for Rust and npm dependencies SHALL be generated at build time and shipped in the app.

#### Scenario: Incompatible license
- **WHEN** a dependency with a license outside the allow-list (MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, Zlib, Unicode-DFS, CC0, and the permissive BSL-1.0, 0BSD, CDLA-Permissive-2.0 and OFL-1.1) is added
- **THEN** the CI license check fails and names the dependency
