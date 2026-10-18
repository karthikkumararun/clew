## 1. Reproduce and diagnose

- [x] 1.1 Open a GitHub issue for the defect (#56, branch `fix/56-editor-selection`); reproduced in the E2E build: every selection forms but none is visible
- [x] 1.2 Write the failing real-render test first: drag-select, Shift+Arrow, Mod+Shift+Left/Right (macOS) and Shift+Home/End, asserting `view.state.selection` and the highlighted text (spec: sql-console › Text selection)
- [x] 1.3 Find which layer resets the selection (document-replacement effect, extension dispatch, key handling, global handler) and record it in design.md

## 2. Fix

- [x] 2.1 Fix the cause in the shared editor setup
- [x] 2.2 Other editors (value editor, Cypher/command, review) have no opaque line background; the helper is editor-generic
- [x] 2.3 Test: the real-render test J-25 (a unit test cannot see paint order)

## 3. Guard

- [x] 3.1 Add the selection journey to the E2E smoke suite with `covers('sql-console › Text selection')`
- [x] 3.2 Add the defect class to `docs/qa/defect-classes.md` and state it in the fix PR
