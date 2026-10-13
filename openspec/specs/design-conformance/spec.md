# design-conformance Specification

## Purpose
TBD - created by archiving change add-e2e-testing. Update Purpose after archive.
## Requirements
### Requirement: Machine-readable design metrics
The project SHALL keep `design/metrics.json`, derived from `design/README.md` and `design/tokens.css`, listing for each named UI region the expected size, spacing, typography and radius (for example toolbar height 44px, tab strip 36px, status bar 26px, sidebar default 272px within 240–420px, side panel 380px within 320–560px, tree row 24px, grid row 26px, button height 28px, dialog radius 12px). UI regions SHALL carry a stable `data-metric` attribute so tests can find them. End-to-end tests SHALL measure the rendered boxes and computed styles of the real app and compare them to this file with a tolerance of 1px, replacing any test that only checks that a CSS token is declared.

#### Scenario: Default layout is measured, not assumed
- **WHEN** the design suite launches the app for the first time at 1440×900
- **THEN** the measured toolbar height is 44px, tab strip 36px, status bar 26px and sidebar width 272px, and a CSS rule that stopped using the token would fail the test

#### Scenario: Metric drift
- **WHEN** a region's rendered size differs from `design/metrics.json` by more than 1px
- **THEN** the run fails naming the region, the expected value and the measured value

### Requirement: Token conformance
Source files other than `tokens.css` SHALL NOT contain colour literals (hex, rgb, hsl) or font families; a lint rule SHALL enforce this in CI on every pull request. End-to-end design tests SHALL additionally verify that environment-coded elements resolve to the token values (for example the production badge text and background equal `--env-prod-badge-fg` and `--env-prod-badge-bg`).

#### Scenario: Hard-coded colour
- **WHEN** a component stylesheet contains `#F2766B`
- **THEN** the lint step fails on the pull request and names the file and line

#### Scenario: Production badge colours
- **WHEN** the design suite opens a production console
- **THEN** the badge's computed colours equal the production badge tokens

### Requirement: Screen state matrix
`design/states.json` SHALL list, for every canvas screen, the states the app must be able to reproduce (for example Main: connected production read-only console with results; DataGrid: edited, inserted and deleted rows with the pending bar; Welcome: first run and with recents; ConnectionDialog: each driver kind and each tab; AIAssistant: pending review; ImportExport: each tab and source). Each state SHALL have a fixture (connections file, seed, UI state and scripted steps) under `e2e/fixtures/states/` that reproduces it deterministically from the canvas sample data (connection names, environments and the Ada Lovelace style rows), and a design test that reaches it.

#### Scenario: Every canvas state is reachable
- **WHEN** the design suite runs
- **THEN** each state listed in `design/states.json` is reached in the real app and captured, and a state that cannot be reached fails the run

#### Scenario: New canvas screen
- **WHEN** a screen is added to `design/canvas/` without entries in `design/states.json`
- **THEN** the design-conformance check fails and names the screen

### Requirement: Side-by-side design review
`pnpm qa:design` SHALL capture each state at the reference window size (1440×900, device scale 1 and the platform's native scale) and produce an HTML report with, per state, the reference image exported from the canvas (`design/screens/<Screen>.png`), the app screenshot, a difference overlay, and the metric and token results. The maintainer or a review agent SHALL mark each state approved or file a defect; approved screenshots become the platform's baselines.

#### Scenario: Produce the report
- **WHEN** the maintainer runs `pnpm qa:design`
- **THEN** the report lists every state with reference, screenshot, overlay and verdict controls, and states whose measured metrics failed are listed first

#### Scenario: Agent-assisted review
- **WHEN** the review agent prompt `docs/qa/design-review-prompt.md` is run over the report
- **THEN** it returns a list of discrepancies per state (missing elements, copy, spacing, colours, states) each with a proposed severity S3 or S4, which the maintainer confirms before issues are filed

### Requirement: Visual regression baselines
After approval, the design suite SHALL compare each state's screenshot with the approved baseline for the same platform with a tolerance of 0.1% of pixels, masking dynamic regions (clock text, timings, random ids). Baselines SHALL be stored per platform because font rendering differs, and updating them SHALL require running `pnpm qa:design --update` and committing the changed images with a reason.

#### Scenario: Unintended visual change
- **WHEN** a change moves the toolbar menu by 6px
- **THEN** the affected states fail with a diff image attached to the run

#### Scenario: Intended change
- **WHEN** a canvas screen is updated deliberately
- **THEN** the baselines are regenerated with `--update`, reviewed in the pull request and approved there

### Requirement: Overlay integrity
Every menu, popover, tooltip, completion list, context menu and dialog that an end-to-end test opens SHALL be checked automatically by the shared page-object helpers: (a) its bounding box lies entirely inside the window; (b) hit-testing at its centre and four inner corners returns the overlay or one of its descendants, so nothing covers or clips it; (c) none of its ancestors clips it (`overflow` hidden or scrolling ancestors do not cut its box); (d) Esc closes it and focus returns to the opener. A test cannot opt out without a documented reason in the test.

#### Scenario: Clipped menu is caught
- **WHEN** a toolbar container with `overflow: hidden` cuts off the connection chip's database and schema menu
- **THEN** the integrity check fails with the clipped region and the offending ancestor

#### Scenario: Menu near the window edge
- **WHEN** a menu opens next to the right edge of a 1024px wide window
- **THEN** it is repositioned to stay fully inside the window

### Requirement: Window-size and scale matrix
Design tests SHALL run the key states at 1440×900, 1280×800, 1024×768 and 880×700 (below the 900px collapse threshold) and at the minimum supported window size, and the smoke suite on Windows SHALL also run at 125% and 150% display scaling and on macOS at standard and Retina scaling. At every combination the page SHALL have no horizontal scroll, no overlay failing the integrity check, and every control listed in `design/states.json` for that state present and reachable.

#### Scenario: Narrow window
- **WHEN** the window is 880px wide
- **THEN** the sidebar is collapsed, the toolbar shows the control that opens it, and opening it shows the overlay fully inside the window

#### Scenario: Windows scaling
- **WHEN** the app runs at 150% display scaling on Windows
- **THEN** toolbar text and icons are not clipped and the metric checks pass in CSS pixels

### Requirement: Accessibility checks
Each state captured by the design suite SHALL pass an automated accessibility scan (axe-core: names and roles, colour contrast of rendered text, form labels, ARIA validity) with no serious or critical violations, keyboard tab order SHALL visit the controls in visual order, and focused controls SHALL show a 2px outline in `--accent`.

#### Scenario: Missing accessible name
- **WHEN** an icon-only button has no accessible name
- **THEN** the scan fails the state and names the element

#### Scenario: Visible focus
- **WHEN** a test tabs to the first toolbar button
- **THEN** its computed outline is 2px wide in the accent colour

