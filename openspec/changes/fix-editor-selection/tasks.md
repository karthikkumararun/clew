## 1. Reproduce and diagnose

- [ ] 1.1 Open a GitHub issue for the defect (the fix branch is `fix/<issue>-editor-selection`); reproduce in the E2E build and in the 0.1.0 release build; record which of mouse drag, Shift+Arrow, Mod+Shift+Left/Right, Mod+A fail
- [ ] 1.2 Write the failing real-render test first: drag-select, Shift+Arrow, Mod+Shift+Left/Right (macOS) and Shift+Home/End, asserting `view.state.selection` and the highlighted text (spec: sql-console › Text selection)
- [ ] 1.3 Find which layer resets the selection (document-replacement effect, extension dispatch, key handling, global handler) and record it in design.md

## 2. Fix

- [ ] 2.1 Fix the cause in the shared editor setup
- [ ] 2.2 Apply to the other editors (value editor, Cypher/command, review) and cover them in the same test
- [ ] 2.3 Test: unit test for the cause (for example, an unchanged document must not be replaced) plus the real-render test above

## 3. Guard

- [ ] 3.1 Add the selection journey to the E2E smoke suite with `covers('sql-console › Text selection')`
- [ ] 3.2 Add the defect class to `docs/qa/defect-classes.md` and state it in the fix PR
