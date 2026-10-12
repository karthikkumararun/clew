# Manual QA runs

After a manual pass, copy the generated `docs/qa/checklist.md` here as
`<date>-<platform>.md` (for example `2026-10-20-macos.md`), fill in the build version and commit,
OS, and tester at the top, tick what passed and link an issue next to what failed. Commit it: the
release gate (`scripts/release-gate.ts`) looks for a run file for the commit being released.
