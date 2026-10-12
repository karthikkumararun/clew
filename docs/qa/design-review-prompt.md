# Prompt: design review of the app against the canvas

Run this with a vision-capable agent over the report from `pnpm qa:design`
(`e2e/artifacts/design/index.html` and the images next to it).

```
You are reviewing Clew's real UI against its design. For each state in the report you have the
canvas reference (design/screens/<Screen>.png), the app screenshot, and the metric and token
results. Read design/README.md and design/tokens.css first.

For every state list the discrepancies you can see between the reference and the app:
- missing or extra elements,
- copy that differs,
- spacing, alignment and size (use the measured metrics, not your eye, where they exist),
- colours and environment coding,
- state: what the canvas shows selected, hovered, edited or disabled.

For each discrepancy give: state id, what differs, where (region), and a proposed severity:
S3 (wrong but minor, or a missing element) or S4 (cosmetic). Do not report anything the metric
results already list as passing. Do not file issues; the maintainer confirms each one first.

End with the states you would approve as they are.
```

The maintainer marks each state approved or "discrepancy" in the report, files the confirmed
discrepancies with the Defect template, and records the result in `docs/qa/design-review.json`
for the release gate. Approved screenshots become the platform's baselines with
`pnpm qa:design --update`.
