---
type: Changed
---
- **The test-duplication gate is back to its configured limit.** `check:duplication:tests` no longer passes `--fail-on-new-clones 81`, the one-off allowance added while existing test clones changed fingerprint; the limit is again the `failOnNewClones: 3` in `.jscpd.tests.json`.
