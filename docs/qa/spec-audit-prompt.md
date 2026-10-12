# Prompt: spec audit before implementation

Run this on a change before it moves to implementation, and on every finished capability once.
It is the definitive check behind `pnpm check:spec-completeness`, which only screens.

```
Audit the specs of <change or capability> (openspec/changes/<change>/specs/** or
openspec/specs/<capability>/spec.md).

For every requirement:
1. List every SHALL clause and every enumerated item in its prose: lists after a colon,
   parenthetical lists, "such as", "default", "for each", "every", sizes and numbers, states.
2. Map each one to a scenario that would fail if the clause were not implemented. Quote the
   scenario heading.
3. For each clause with no scenario, write the missing scenario (WHEN / THEN, concrete values)
   as a delta for the change, or say why it is not testable and mark it `<!-- manual -->`.
4. Mark scenarios about layout, size, visibility, clipping, scrolling, focus or colour: they need
   a real-render test (end-to-end or the design suite), not a jsdom test.
5. Flag states that can be entered with no way back (a hidden or closed area without a control
   to restore it).

Output: a table requirement | clause | scenario or MISSING, then the new scenarios, then the
questions you could not answer from the spec. Do not change the code.
```

When the audit finds new gaps, add the scenarios, then run `pnpm check:spec-completeness`. A gap
that stays is recorded in `docs/qa/known-gaps.json` with a reason; the file may shrink but not
grow without one.
