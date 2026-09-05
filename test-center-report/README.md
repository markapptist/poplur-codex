# Test Center report

Run `node /Users/matrix/Developer/.codex/test-center-report/run.mjs`.

The pipeline reads production counters and local runner state, validates the report, merges that day's saved proposals, and writes dated HTML plus `latest.html` in `/Users/matrix/Developer/.claude/artifacts/test-center-reports`.

It does not modify production, apply proposals, start the synthetic runner, or schedule itself. The report window covers the last 24 hours at execution time, not a historical calendar day. Synthetic, owner-controlled, and third-party accounts are distinguished. Analytics source wiring is checked separately from delivery and event collection; missing GA4 access means unknown totals, not zero events.

To render existing data without querying production:

`node /Users/matrix/Developer/.codex/test-center-report/render.mjs /absolute/path/report.json`

The renderer accepts `--out /absolute/path/report.html` for a single output. Without it, it writes the dated file and `latest.html` beside the JSON.
