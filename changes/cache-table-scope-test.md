---
type: Changed
---
- **Every cache table states how it is scoped to a vault.** A test now requires each cache.db table to be vault-scoped, joined to a vault-scoped parent through a foreign key, or global with a reason, so a new table cannot be added without that decision. Three existing tables (`audit_reports`, `reconcile_state`, `wiki_judge_verdicts`) carry no vault identity and are listed as undecided; that list cannot grow. Test-only change.
