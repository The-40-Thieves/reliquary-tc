---
type: Security
---
- **Bulk failures and missing-path errors no longer carry absolute host paths.** A bulk item that failed on an unexpected filesystem error returned Node's raw message, which could include the vault's location on disk; it now returns `internal error` with the same `internal_error` code. A missing note, a write under a missing folder and a move of a missing note name the path relative to the vault. Other unexpected filesystem errors are unchanged.
