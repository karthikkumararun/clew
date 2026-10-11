## ADDED Requirements

### Requirement: Real-app end-to-end harness
The project SHALL provide an end-to-end test harness that launches the real built Clew application and drives its UI through WebDriver, so a test exercises the WebView, the Rust backend and a real database together. The harness SHALL run on macOS, Windows and Linux.

#### Scenario: Launch and drive the app
- **WHEN** an end-to-end test starts
- **THEN** the built app opens with a fresh state, the test can find controls by accessible role and label, click, type and read text, and the app is closed afterwards

#### Scenario: Restart within a test
- **WHEN** a test closes and relaunches the app with the same test data directory
- **THEN** the second launch sees the state the first one saved (open tabs, settings, connections)

#### Scenario: Harness unavailable on a platform
- **WHEN** the harness cannot drive the app on one of the three platforms
- **THEN** CI fails that platform's job instead of skipping it silently

### Requirement: Isolated test mode
Test mode SHALL exist only in builds compiled with the `e2e` Cargo feature, SHALL be enabled only by an environment variable, and SHALL provide: a temporary application data directory per run, a file-backed secret store in that directory instead of the OS keychain, native file and folder dialogs answered from a queue supplied by the test, no network calls other than those the test configures (update checks and telemetry off), and a fixed clock option for relative-time text. Release builds SHALL NOT contain test mode.

#### Scenario: Never touches the real profile
- **WHEN** an end-to-end run finishes
- **THEN** the developer's real Clew data directory and OS keychain are unchanged

#### Scenario: Release build has no test mode
- **WHEN** CI inspects a release build
- **THEN** the test-mode environment variable has no effect and the `e2e` feature symbols are absent

#### Scenario: Scripted dialogs
- **WHEN** a journey exports connections and the app opens a save dialog
- **THEN** the dialog returns the next path from the test's queue and the journey continues without human input

### Requirement: Native platform smoke checks
A smoke suite SHALL run against the real app on macOS, Windows and Linux without containers (SQLite and DuckDB), and SHALL additionally verify, with the real OS facilities and a test-only service name, that: a secret written to the OS keychain can be read back and is removed afterwards; the window title bar and toolbar layout match the platform design; the Mod shortcuts work with Cmd on macOS and Ctrl on Windows; and file paths with spaces and non-ASCII characters work.

#### Scenario: Keychain round trip
- **WHEN** the smoke suite saves a connection password on macOS or Windows
- **THEN** the password is found under the test service name in the OS keychain, a reconnect succeeds without prompting, and deleting the connection removes it

#### Scenario: Platform shortcut mapping
- **WHEN** the suite sends the platform's Mod+K
- **THEN** the command palette (or the current "go to" surface) opens on every platform

### Requirement: Shared seed dataset
The project SHALL provide one logical seed dataset, the `shop` schema (users, orders, order_items, shipments with foreign keys and mixed types including NULLs, decimals, timestamps with zones, JSON and unicode text) and a 100,000-row `events` table, loaded identically into every supported database through per-database seed files, with an automated parity check that row counts and sampled checksums agree across databases.

#### Scenario: Seed parity
- **WHEN** the parity check runs against all running databases
- **THEN** every database reports the same row counts and the same checksum for the sampled columns, or the run fails naming the differing database

#### Scenario: Fresh state per test file
- **WHEN** a test file starts
- **THEN** it works in its own schema or database created from the seed, so earlier files' edits never leak into it, and the schema is dropped afterwards

### Requirement: Docker stack
`docker-compose.yml` SHALL expose the test databases through Compose profiles: `core` (PostgreSQL, PostgreSQL with TLS, MySQL, MariaDB, SSH bastion), `nosql` (MongoDB, Redis, Neo4j), `heavy` (SQL Server, Oracle, ClickHouse) and `ai-mock` (a deterministic mock LLM server speaking the OpenAI-compatible and Anthropic-compatible APIs). Every service SHALL have a health check, use test-only credentials, and publish on fixed non-default ports.

#### Scenario: Start the core stack
- **WHEN** a developer runs the stack for the `core` profile
- **THEN** the command returns only when every core service reports healthy

#### Scenario: Port clash
- **WHEN** a default database port is already in use on the machine
- **THEN** the stack still starts because it uses its own fixed ports

### Requirement: Journey catalogue
The project SHALL keep a catalogue of numbered end-to-end journeys (J-01…), each a user-level flow with preconditions, steps and expected results, linked to the spec scenarios it covers. The initial catalogue SHALL include at least:
- J-01 first run to a connected explorer (Welcome, New connection, Test, Save and connect);
- J-02 connect through the SSH bastion with a key and verify-full TLS;
- J-03 console: run statement, multi-result script, error underlined at its position, cancel a long query, history entry;
- J-04 schema-aware completion after the snapshot loads;
- J-05 table editor: filter, page, edit a cell, preview SQL, submit, verify from a second connection, and the changed-by-someone-else conflict;
- J-06 record panel: follow a foreign key and a referenced-by link;
- J-07 export 100,000 rows to CSV with progress, and cancel deleting the partial file;
- J-08 production safeguards: read-only block, switch to read-write, write confirmation, typed confirmation for DELETE without WHERE;
- J-09 encrypted connection export and import, wrong passphrase and tampered file;
- J-10 DataGrip import from a fixture folder, with consoles appearing under Scripts;
- J-11 restart restores tabs, sidebar width and explorer expansion;
- J-12 cross-driver parity: the same queries on every available SQL driver give the same grid values;
- J-13 keyboard-only operation of tabs, explorer and dialogs.
- J-20 hidden-state sweep: every combination of saved layout state at wide and narrow widths still offers a visible way to restore each hidden area;
- J-21 overlay sweep: every menu, popover, context menu, completion list and dialog reachable from the command registry is opened at each window size and checked for integrity.
Each later change SHALL add the journeys for its own features (for example J-14 NoSQL, J-15 Neo4j graph, J-16 command palette, J-17 AI assistant against the mock LLM, J-18 Oracle, SQL Server, ClickHouse and DuckDB parity).

#### Scenario: Journey fails the run
- **WHEN** any listed journey fails
- **THEN** the run fails and the report names the journey id and the first failing step

#### Scenario: New feature without a journey
- **WHEN** a change adds user-visible behaviour but no journey references its scenarios
- **THEN** the coverage check reports the uncovered scenarios and the change's task list contains an explicit task to add the journey

### Requirement: Suites and triggers
The suites SHALL be: `smoke` (no containers; macOS, Windows, Linux), `design` (the design-conformance checks of every state that needs no containers on macOS, Windows and Linux, and the container-backed states on Linux), `full` (Docker `core` and `nosql` profiles; Linux) and `heavy` (Docker `heavy` profile and Neo4j-dependent journeys; Linux). They SHALL run on pushes to `release/*` branches, on a nightly schedule and on manual dispatch, and SHALL NOT run on ordinary pull requests, where only unit, component and Rust integration tests run.

#### Scenario: Release branch push
- **WHEN** a commit is pushed to `release/0.1`
- **THEN** `smoke` and `design` run on all three platforms and `full` runs on Linux, and the branch's status shows all of them

#### Scenario: Ordinary pull request
- **WHEN** a pull request targets `main` from a feature branch
- **THEN** no end-to-end suite starts

#### Scenario: Nightly
- **WHEN** the nightly schedule fires
- **THEN** `smoke`, `design`, `full` and `heavy` all run against `main` and failures open or update a single tracking issue

### Requirement: Failure artifacts
When an end-to-end test fails, the run SHALL keep a screenshot of the window, the app's log, the browser console log, the Docker logs of services used and the test's step trace, and SHALL upload them as CI artifacts or write them under `e2e/artifacts/` for local runs. Logs SHALL not contain secrets.

#### Scenario: Debug a failure
- **WHEN** J-05 fails in CI
- **THEN** the artifacts contain a screenshot taken at the failing step and the log lines around it

### Requirement: Flake policy
A failing end-to-end test SHALL be retried once. A test that passes only on retry SHALL be reported as flaky in the summary. A test flagged flaky in three runs within 14 days SHALL be quarantined into a separate non-blocking list with an open issue, and quarantined tests SHALL be fixed or deleted within two weeks.

#### Scenario: Passes on retry
- **WHEN** a test fails once and passes on the retry
- **THEN** the run passes and the summary lists the test as flaky

#### Scenario: Repeated flake
- **WHEN** the same test is flaky in three runs within 14 days
- **THEN** it moves to quarantine, an issue is opened for it, and it no longer blocks the suite

### Requirement: Scenario traceability
End-to-end tests SHALL declare the spec scenarios they cover as `capability › Scenario name`. A script SHALL verify that every declared scenario exists in `openspec/specs/` or an active change, fail on names that no longer exist, and generate `docs/qa/coverage.md` listing each scenario with its covering levels (unit, integration, end-to-end) or "manual".

#### Scenario: Renamed scenario
- **WHEN** a spec scenario is renamed and a test still declares the old name
- **THEN** the coverage check fails and names the test and the missing scenario

#### Scenario: Coverage report
- **WHEN** the coverage script runs
- **THEN** `docs/qa/coverage.md` lists every scenario of the finished capabilities with its test levels and highlights those with none

### Requirement: Test-level policy
Each spec scenario SHALL be verified at a level that can actually observe it. Scenarios about layout, sizes, visibility, clipping, overlap, scrolling, focus, colour or window-size behaviour SHALL be covered by a real-rendering test (end-to-end or design suite); jsdom component tests SHALL NOT count for them because jsdom performs no layout. Scenarios about logic may be covered at any level. The coverage report SHALL show the level of each covering test and flag layout-class scenarios covered only by jsdom tests.

#### Scenario: Layout scenario with only a component test
- **WHEN** the scenario "Default layout" is covered only by a Vitest test
- **THEN** the coverage report marks it "needs real-render test"

#### Scenario: Token declaration is not enough
- **WHEN** a test asserts that `tokens.css` contains `--h-tabstrip: 36px` but does not measure the rendered tab strip
- **THEN** the test does not count as covering the layout scenario

### Requirement: Persisted-state sweep
The harness SHALL be able to start the app with any saved layout and UI state by writing it into the test data directory, so tests can sweep combinations (sidebar shown or hidden, side panel open or closed, results panel collapsed, tabs overflowing, explorer fully collapsed) at several window sizes without driving the UI into each state by hand.

#### Scenario: Seed a saved state
- **WHEN** a test writes `sidebar: hidden` and `sidePanel: open` into the data directory and launches the app
- **THEN** the app starts with the sidebar hidden and the side panel open

### Requirement: Spec-to-test completeness
A script SHALL check each requirement of the finished capabilities and of active changes: every scenario must be covered by at least one test at an appropriate level or be listed as manual; requirement prose that enumerates items, defaults or states (lists, "such as", "default", "for each") with fewer scenarios than enumerated items SHALL be reported as probably under-specified; and the report SHALL list requirements without any scenario. Known gaps SHALL be recorded in `docs/qa/known-gaps.json`, which can shrink but not grow without a documented reason. Before implementation of a change starts, a spec audit (the agent prompt `docs/qa/spec-audit-prompt.md`) SHALL map every SHALL clause and every enumerated item in each requirement to a scenario and add the missing scenarios.

#### Scenario: Prose claim without a scenario
- **WHEN** a requirement says "default groups follow environment" and no scenario exercises default grouping
- **THEN** the completeness report lists the requirement as probably under-specified with the unmatched phrase

#### Scenario: Known gaps cannot grow silently
- **WHEN** a new uncovered scenario appears that is not in `docs/qa/known-gaps.json`
- **THEN** the check fails and names the scenario

#### Scenario: Spec audit before implementation
- **WHEN** a change moves from specs to implementation
- **THEN** the audit output is attached to the change and every unmatched clause either gains a scenario or is recorded as intentionally untested with a reason

