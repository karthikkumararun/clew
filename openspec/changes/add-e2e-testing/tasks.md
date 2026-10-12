## 1. Spike and harness

- [ ] 1.1 Spike: with WebdriverIO and `@wdio/tauri-service` (embedded provider), launch the app, find by role, type, click, take a screenshot and relaunch with the same data dir on macOS, Windows and Linux; record versions and the outcome in design.md (spec: e2e-testing › Real-app end-to-end harness) **macOS done; Windows and Linux pending (see design.md "Spike result")**
- [x] 1.2 Add the `e2e` Cargo feature and test mode: `CLEW_DATA_DIR`, `FileSecretStore`, dialog queue, hard-disabled network extras, fixed clock (spec: e2e-testing › Isolated test mode)
- [x] 1.3 CI check that release builds contain no test mode (feature tree + binary symbol grep) (spec: e2e-testing › Isolated test mode › Release build has no test mode)
- [ ] 1.4 Create `e2e/` with `wdio.conf.ts`, helpers (`launchApp`, `withDataDir`, `queueDialog`, `connectionFactory`, db clients) and a hello-world journey that passes on all three OSes **macOS passes; Windows and Linux pending; db clients arrive with the seed in 2.x**
- [ ] 1.5 Test-mode accessible mirror for the canvas grid and the graph view (`data-testid` rows/nodes, only in `e2e` builds)

## 2. Seed data and Docker stack

- [ ] 2.1 Write the `shop` seed for PostgreSQL, MySQL, MariaDB and SQLite, including NULLs, Unicode, 30-digit decimals, JSON, zoned timestamps and the 100,000-row `events` generator (spec: e2e-testing › Shared seed dataset)
- [ ] 2.2 Restructure `docker-compose.yml` into profiles `core`, `nosql`, `heavy`, `ai-mock`; add health checks and fixed ports for each service that exists today (spec: e2e-testing › Docker stack)
- [ ] 2.3 Per-file isolation helpers (`CREATE DATABASE … TEMPLATE`, per-file schemas, copied template files) with automatic cleanup
- [ ] 2.4 Parity script comparing counts and sampled checksums across running databases (spec: e2e-testing › Shared seed dataset › Seed parity)
- [ ] 2.5 Mock LLM server in `docker/mock-llm/`: OpenAI- and Anthropic-compatible, streaming, scripted responses by marker, request log endpoint (spec: e2e-testing › Docker stack)
- [ ] 2.6 Test: parity script passes on PostgreSQL, MySQL, MariaDB and SQLite; stack starts only when all services are healthy

## 3. Page objects

- [ ] 3.1 Page objects by role and accessible name: Toolbar, Welcome, ConnectionDialog, Explorer, TabStrip, Console, ResultsPanel, Grid (via mirror), TableEditor, RecordPanel, PendingBar, ExportDialog, ImportExportDialog, SettingsDialog
- [ ] 3.2 Add missing accessible names or roles in the app where a page object needs a CSS selector (fix the app, not the test)

## 4. Journeys for finished features

- [ ] 4.1 J-01 first run to connected explorer; J-11 restart restores tabs, sidebar and explorer expansion
- [ ] 4.2 J-02 SSH bastion with key and verify-full TLS (including host-key prompt and changed-key refusal)
- [ ] 4.3 J-03 console run, multi-result script, error position underline, cancel, history; J-04 completion after snapshot
- [ ] 4.4 J-05 table editor edit/preview/submit/verify from a second connection, plus the changed-by-someone-else conflict; J-06 record panel navigation
- [ ] 4.5 J-07 export 100,000 rows with progress and cancel-deletes-partial-file
- [ ] 4.6 J-08 production safeguards flows (after `add-production-safeguards` is archived)
- [ ] 4.7 J-09 encrypted export/import including wrong passphrase and tampered file; J-10 DataGrip import from `e2e/fixtures/datagrip/`
- [ ] 4.8 J-12 cross-driver parity over PostgreSQL, MySQL, MariaDB and SQLite; J-13 keyboard-only operation
- [ ] 4.9 Each journey declares `covers('capability › Scenario')` for every spec scenario it exercises

## 5. Smoke suite on all platforms

- [ ] 5.1 Container-free smoke suite on SQLite/DuckDB: J-01, J-03, J-05 (SQLite), J-09, J-11 (spec: e2e-testing › Native platform smoke checks)
- [ ] 5.2 Real-keychain round trip with service name `Clew-e2e` and cleanup on macOS and Windows
- [ ] 5.3 Platform checks: title bar/toolbar layout, Mod shortcut mapping, paths with spaces and non-ASCII characters

## 6. CI

- [ ] 6.1 `.github/workflows/e2e.yml`: triggers `release/**` pushes, nightly schedule, manual dispatch with a suite input (spec: e2e-testing › Suites and triggers)
- [ ] 6.2 Jobs `smoke` (3-OS matrix, xvfb on Linux), `full` (core, nosql, ai-mock profiles), `heavy` (scheduled/dispatch)
- [ ] 6.3 Artifacts on failure (screenshot, app log, console log, Docker logs, step trace) with secret-free logs (spec: e2e-testing › Failure artifacts)
- [ ] 6.4 Retry-once and flaky summary; quarantine list and a script that opens the tracking issue (spec: e2e-testing › Flake policy)
- [ ] 6.5 Nightly failure creates or updates a single "Nightly e2e failing" issue
- [ ] 6.6 Confirm ordinary pull requests do not start the e2e workflow

## 7. Traceability

- [ ] 7.1 `covers()` helper for e2e; convention for Vitest names and Rust doc comments (spec: e2e-testing › Scenario traceability)
- [ ] 7.2 `scripts/check-scenario-coverage.ts` parsing `openspec/specs/**` and active changes; fail on dangling references; generate `docs/qa/coverage.md`
- [ ] 7.3 Backfill `(spec: …)` references in existing Vitest and Rust tests for the finished capabilities
- [ ] 7.4 Test: renamed-scenario fixture fails the check; report lists uncovered scenarios

## 8. Release QA

- [ ] 8.1 `scripts/qa-up.ts`, `qa-e2e.ts`, `qa-down.ts` with Docker checks, profile selection and skipped-journey listing; `pnpm qa:*` scripts (spec: release-qa › One-command local QA stack)
- [ ] 8.2 `scripts/qa-checklist.ts` generating `docs/qa/checklist.md` from uncovered and manual scenarios plus the fixed manual list; `docs/qa/runs/` convention (spec: release-qa › Manual QA checklist)
- [ ] 8.3 `diagnostics_bundle` command with redaction and the About dialog "Copy diagnostics" button (spec: release-qa › Diagnostics bundle)
- [ ] 8.4 `.github/ISSUE_TEMPLATE/defect.yml` with required fields, severity S1-S4 and labels; `spec` label flow (spec: release-qa › Defect reporting)
- [ ] 8.5 `docs/qa/README.md` (the loop) and `docs/qa/fix-prompt.md` (agent prompt for a defect); fix-branch naming and regression-test rule (spec: release-qa › Fix and verify loop)
- [ ] 8.6 `scripts/release-gate.ts` checking open S1/S2 issues, workflow results for the commit, checklist run files and coverage (spec: release-qa › Release gate)
- [ ] 8.7 Test: diagnostics redaction unit tests; gate script against fixture states

## 9. Design conformance

- [ ] 9.1 Add `data-metric` attributes to the main regions (toolbar, tab strip, status bar, sidebar, side panel, tree row, grid row, dialogs) and write `design/metrics.json` from `design/README.md`; script that cross-checks it with `tokens.css` (spec: design-conformance › Machine-readable design metrics)
- [ ] 9.2 Replace token-declaration assertions in `src/shell/layout.test.tsx` and similar with rendered-box measurements in the design suite
- [ ] 9.3 Token lint (stylelint + ESLint rule) in PR CI; fix existing violations (spec: design-conformance › Token conformance)
- [ ] 9.4 Write `design/states.json` for all canvas screens and the fixtures under `e2e/fixtures/states/` reproducing canvas sample data (spec: design-conformance › Screen state matrix)
- [ ] 9.5 Maintainer exports `design/screens/<Screen>.png` from the canvas (Share › Export) and commits them
- [ ] 9.6 `pnpm qa:design`: capture each state, produce the side-by-side HTML report with overlay and metric results; `docs/qa/design-review-prompt.md` (spec: design-conformance › Side-by-side design review)
- [ ] 9.7 Per-platform baselines, masks and `--update` flow (spec: design-conformance › Visual regression baselines)
- [ ] 9.8 Overlay-integrity helper wired into page-object `openMenu/openDialog/openPopover`; J-21 overlay sweep (spec: design-conformance › Overlay integrity)
- [ ] 9.9 Window-size and display-scale matrix runner; Windows 125%/150% and macOS Retina legs (spec: design-conformance › Window-size and scale matrix)
- [ ] 9.10 axe-core scan, tab-order walk and focus-ring check per state (spec: design-conformance › Accessibility checks)
- [ ] 9.11 Add the `design` suite to the e2e workflow (release branches, nightly, dispatch) (spec: e2e-testing › Suites and triggers)
- [ ] 9.12 Test: a deliberately clipped menu, a 6px-shifted element and a missing accessible name each fail the matching check (use fixtures, then remove the fixture)

## 10. Guards for the defects found by hand

- [ ] 10.1 Implement the persisted-state seeding helper and J-20 hidden-state sweep (spec: e2e-testing › Persisted-state sweep; app-shell › Hidden areas can always be restored)
- [ ] 10.2 Make the app satisfy the new `app-shell` scenarios: sidebar, side-panel, results-panel and record-panel restore controls at wide and narrow widths; overlays reposition inside the window (spec: app-shell › Overlays are fully visible)
- [ ] 10.3 Make the explorer satisfy the new default-grouping scenarios and test them in the component tests and in J-01/J-20 (spec: database-explorer › Default grouping by environment)
- [ ] 10.4 Test-level policy in the coverage script: classify scenarios as layout-class and report those covered only by jsdom (spec: e2e-testing › Test-level policy)
- [ ] 10.5 `scripts/check-spec-completeness.ts`, `docs/qa/known-gaps.json` baseline and `docs/qa/spec-audit-prompt.md`; run the audit on every finished capability and add the missing scenarios (spec: e2e-testing › Spec-to-test completeness)
- [ ] 10.6 `docs/qa/defect-classes.md` (C1–C6 with guards) and `docs/qa/charters.md` (spec: release-qa › Defect class guards, Exploratory charters)
- [ ] 10.7 Fix-PR check workflow and PR template section (class, guard, scenario, test or "No automated test") (spec: release-qa › Fix pull request check)
- [ ] 10.8 Add the design-review result to `scripts/release-gate.ts` (spec: release-qa › Release gate)

## 11. Process updates

- [x] 11.1 Add task rules to `openspec/config.yaml`: every change with user-visible behaviour ends with "E2E: add or extend journey J-nn" and lists the scenarios it covers
- [x] 11.2 Update `CLAUDE.md` workflow with the end-to-end requirement and the QA loop pointer
- [x] 11.3 Append an E2E task group to the unbuilt changes (`add-more-sql-drivers`, `add-nosql-browser`, `add-graph-browser`, `add-command-palette`, `add-ai-assistant`, `add-release-packaging`)
- [x] 11.4 Add the spec-writing and design-conformance rules to `openspec/config.yaml` and the fix-PR requirements to `CLAUDE.md`
