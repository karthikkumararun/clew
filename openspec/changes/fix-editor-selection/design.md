## Context

`Editor.tsx` builds CodeMirror 6 with `drawSelection()`, `rectangularSelection()`, `allowMultipleSelections`, `clickAddsSelectionRange` (Alt or Meta click adds a range) and the default keymap minus Mod+Enter and Escape. All the Shift+movement bindings are in that default keymap, so a missing binding is not the cause. The symptom (no selection forms at all, by mouse or keyboard) points to something outside CodeMirror's keymap: an event handler or a wrapper that swallows or resets the selection, or the selection layer not receiving the editor's state. The selection style itself (`theme.ts`) is fine.

## Approach

1. **Reproduce in the real app first** (jsdom has no selection or layout): run the E2E build, drive a drag and Shift+Arrow with real pointer and key events, and read `view.state.selection` through the test hook. This tells which layer loses it.
2. **Candidates, in order:** (a) the console's `onCursor` / `onChange` path or the `props.value` effect re-dispatching a full-document replacement on every update, which collapses the selection to the caret (the effect compares `doc.toString()` to `props.value`; any lag or normalisation difference replaces the document and resets the selection); (b) a statement-highlighting or run-marker extension that dispatches a selection; (c) `clickAddsSelectionRange` with `metaKey` interfering with Cmd+Shift key chords on macOS; (d) a global handler (shortcut registry or drag/drop) that calls `preventDefault` on pointer or Shift key events.
3. **Fix the cause, not the symptom**, and keep the fix in the shared editor setup so every CodeMirror editor benefits.
4. **Guard the class:** a real-render test that selects by mouse and by each keyboard chord in each editor kind, added to the E2E smoke suite, and a defect-class entry ("input handling that resets editor state") in `docs/qa/defect-classes.md`.

## Risks

- The defect may only reproduce in the packaged WebKit build (the reporter used the Homebrew install); the first task therefore confirms it against the release build as well as the E2E build.

## Finding

None of the candidates above. Selection formed correctly: in the E2E build the page reported the selected text for Cmd+Shift+Left/Right, Shift+Home/End and Select all. It was **not visible**. CodeMirror draws the selection in a layer behind the text (its z-index is set inline to a negative value), and the current-statement tint is an opaque `background-color` (`--bg-current-statement`) on the `.cm-line` of the statement under the cursor. The cursor is always inside its own statement, so any selection touching it was painted over, and the user saw nothing. The user's report ("nothing is selected") is what an invisible selection looks like.

The fix draws the selection layer over the lines (`.cm-selectionLayer { z-index: 1 !important }`, needed because CodeMirror sets the z-index inline). The highlight is translucent, so the text stays readable. Making the tint translucent instead would have left the selection faint, and drawing the tint as its own layer under the selection is more code for the same result.

Guard: `selectionVisibility()` in `e2e/helpers/selection.ts` finds the highlight, hit-tests the stack at its centre and fails when an opaque element is painted above it; J-25 runs it for each way of selecting, in the smoke suite. Mouse drags cannot be produced by the embedded WebDriver but draw through the same layer.
