---
type: Changed
---
- **Every cache table states how it is scoped to a vault.** A test now requires each cache.db table to be vault-scoped, joined to a vault-scoped parent through a foreign key, or global with a reason, so a new table cannot be added without that decision. Test-only change.
