# Prompt: fix a defect

Hand this to a coding agent with the issue number.

```
Read issue #<N> in this repository.

1. Find the spec scenario it violates (openspec/specs/**) or the canvas screen. If the behaviour
   was never specified, write the scenario first as a change delta and say so.
2. Write the failing test first, at the lowest level that can observe the defect: unit, then
   component, then Rust integration, then end-to-end. Layout, visibility and clipping defects
   need a real-render test; jsdom cannot see them. Confirm the test fails on main.
3. Fix the code. Keep the change to what the defect needs.
4. Classify the defect (docs/qa/defect-classes.md, C1-C6, or add a class) and name the guard that
   prevents the whole class, not only this instance. Add the generic check if one is possible.
5. Run: pnpm typecheck && pnpm lint && pnpm test, and in src-tauri: cargo fmt --check &&
   cargo clippy -- -D warnings && cargo test. Re-run the suites for the affected capability
   (pnpm qa:e2e <filter>).
6. Branch fix/<issue>-<slug>. In the pull request fill the Fix section of the template: issue,
   spec scenario, defect class, guard. If no automated test is feasible, write a "No automated
   test" section with the reason and add the case to the manual checklist.
```

The maintainer re-runs the original steps before closing the issue.
