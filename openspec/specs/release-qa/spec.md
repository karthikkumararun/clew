# release-qa Specification

## Purpose
TBD - created by archiving change add-e2e-testing. Update Purpose after archive.
## Requirements
### Requirement: One-command local QA stack
The repository SHALL provide commands to run the whole quality pass on a developer machine with Docker (Docker Desktop, OrbStack or Colima): `pnpm qa:up` (generate test certificates and keys, start the chosen Compose profiles, wait until healthy, load the seed), `pnpm qa:e2e` (build the app with the `e2e` feature if needed and run the chosen suites), `pnpm qa:checklist` (generate the manual checklist) and `pnpm qa:down` (stop everything and delete volumes).

#### Scenario: Fresh machine run
- **WHEN** a maintainer with Docker installed runs `pnpm qa:up` then `pnpm qa:e2e --suite full`
- **THEN** the stack comes up, the full suite runs against it, and a summary with pass, fail and flaky counts and the artifact folder is printed

#### Scenario: Docker not running
- **WHEN** `pnpm qa:up` runs while the Docker daemon is not reachable
- **THEN** it stops with a message explaining how to start Docker and does nothing else

#### Scenario: Selecting profiles
- **WHEN** the maintainer runs `pnpm qa:up --profiles core,nosql`
- **THEN** only those services start, and `pnpm qa:e2e` skips journeys that need other profiles and lists them as skipped

### Requirement: Manual QA checklist
The project SHALL generate `docs/qa/checklist.md` from the specs: every scenario that is explicitly marked manual, has no test at all, or is about layout or colour and was only checked where nothing is drawn, appears as a checkbox with its capability, steps and expected result; scenarios that have no end-to-end test but are covered by a unit or integration test appear as one-line references without checkboxes. Manual-only checks SHALL include at least: visual fidelity against the canvas screens, native file and folder dialogs, Oracle Instant Client missing and found states, GitHub Copilot sign-in, macOS Gatekeeper and Windows SmartScreen behaviour of installers, and accessibility with a screen reader.

#### Scenario: Generate the checklist
- **WHEN** the maintainer runs `pnpm qa:checklist`
- **THEN** a Markdown checklist is written, grouped by capability, with no scenario that already has an end-to-end test, and with the scenarios a person has to check apart from those a lower-level test covers

#### Scenario: Record a manual pass
- **WHEN** the maintainer completes a manual pass
- **THEN** the checked file can be committed as `docs/qa/runs/<date>-<platform>.md` with the build commit recorded

### Requirement: Diagnostics bundle
The About dialog SHALL have a "Copy diagnostics" button that copies a text report containing: Clew version and commit, OS and version, CPU architecture, WebView version, enabled drivers with their client library versions (for example the Oracle Instant Client), the last 200 lines of the application log, and the active connection's driver and server version. The report SHALL NOT contain passwords, tokens, API keys, connection hostnames or usernames, query text, or row data; such values SHALL be replaced by redaction markers.

#### Scenario: Copy diagnostics
- **WHEN** the user clicks Copy diagnostics
- **THEN** the clipboard holds the report and a confirmation "Copied" appears

#### Scenario: Secrets are redacted
- **WHEN** the log tail contains a connection error that mentions a host and a password
- **THEN** the copied report shows `‹host›` and `‹redacted›` in their place

### Requirement: Defect reporting
Defects SHALL be filed as GitHub issues with the Defect template: title, build (version and commit), OS, the connection driver involved, steps to reproduce, expected result with a link or name of the spec scenario or canvas screen, actual result, severity, attachments (screenshot, diagnostics) and whether it reproduces on a second run. Severities SHALL be S1 (data loss, security, crash or unusable feature), S2 (feature broken, workaround exists), S3 (wrong but minor) and S4 (cosmetic). Issues SHALL carry labels for severity, the capability and the platform.

#### Scenario: File a defect
- **WHEN** the maintainer finds a failing behaviour during a QA pass
- **THEN** they create an issue from the Defect template and the required fields prevent submission without steps, expected result and severity

#### Scenario: Spec is wrong, not the code
- **WHEN** the investigation shows the spec was wrong or ambiguous
- **THEN** the issue is relabelled `spec` and fixed by updating the spec and design first, as for any spec change

### Requirement: Fix and verify loop
Every defect of severity S1 to S3 SHALL be fixed on its own branch named `fix/<issue-number>-<slug>` with a regression test added before or with the fix, at the lowest feasible level (unit, then component, then Rust integration, then end-to-end), and the pull request SHALL reference the issue and the spec scenario. After merge, the suites relevant to the defect's capability SHALL run again, and the issue SHALL be closed only after the maintainer re-checks the original steps.

#### Scenario: Regression test first
- **WHEN** a fix pull request is opened for issue 27
- **THEN** it contains a test that fails on `main` and passes on the branch, or explains in the description why no automated test is feasible and adds the case to the manual checklist

#### Scenario: Re-verify
- **WHEN** a fix is merged
- **THEN** the maintainer re-runs the original steps (or the new test) on their machine before closing the issue

### Requirement: Defect class guards
Every fixed defect SHALL be classified in the fix pull request (for example C1 invisible to jsdom: layout, clipping, overlap; C2 state with no way back; C3 requirement prose without a scenario; C4 design mismatch; C5 weak test; C6 fix without regression test) and the pull request SHALL state the guard that prevents the whole class from recurring, not only the instance. Classes and their guards SHALL be kept in `docs/qa/defect-classes.md`, and a new class SHALL add an entry and, where possible, a generic automated check.

#### Scenario: Clipped menu fixed
- **WHEN** a defect where a toolbar clipped a dropdown menu is fixed
- **THEN** the pull request names class C1, adds the instance's regression test, and points to the shared overlay-integrity check that now covers every menu

#### Scenario: New kind of defect
- **WHEN** a defect fits no existing class
- **THEN** the pull request adds a class entry with its guard to `docs/qa/defect-classes.md`

### Requirement: Fix pull request check
A CI check SHALL run on pull requests from `fix/*` branches or labelled `defect`, failing when the pull request neither changes a test file nor contains a section "No automated test" with a reason, and failing when the description lacks a linked issue, a spec scenario (existing or newly added) and a defect class.

#### Scenario: Fix without a test
- **WHEN** a `fix/` pull request changes only source files and has no "No automated test" section
- **THEN** the check fails and says what is missing

#### Scenario: Spec scenario added with the fix
- **WHEN** the investigation shows the behaviour was never specified
- **THEN** the pull request adds the missing scenario to the spec (as a change delta) and its test, and the check passes

### Requirement: Exploratory charters
`docs/qa/charters.md` SHALL hold short exploratory-testing charters used during manual passes, each with a mission, a time box and what to record. It SHALL include at least: hide or close every panel and try to get back; resize to the narrowest window and open every menu; start with each saved layout state; change environments and watch every place that shows them; production flows end to end; kill a database or the network mid-operation; keyboard-only for 15 minutes; compare every screen with its canvas image; import data from a tool you use (DataGrip). New charters SHALL be added from every defect found by hand.

#### Scenario: Charter from a defect
- **WHEN** a manual pass finds a defect no charter would have found
- **THEN** a charter that would have found it is added with the fix

### Requirement: Release gate
A release SHALL be cut only when: no S1 or S2 defects are open; the design review report shows every state approved or with only filed S4 discrepancies; the `smoke` suite is green on macOS, Windows and Linux and the `full` and `heavy` suites are green on Linux for the release commit; the manual checklist has been completed on macOS and on Windows for the same commit with failures filed as defects; and `docs/qa/coverage.md` shows no scenario of a shipped capability without any test level or manual entry.

#### Scenario: Open S2 defect
- **WHEN** a release is attempted with one open S2 defect
- **THEN** the gate check fails and names the issue

#### Scenario: All green
- **WHEN** every condition is satisfied for commit abc123
- **THEN** the gate check passes and prints the evidence (workflow run links, checklist file, coverage summary)

