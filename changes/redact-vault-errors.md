---
type: Security
---
- **Error messages no longer carry absolute host paths.** A bulk item that failed on an unexpected filesystem error returned Node's raw message, which could include the vault's location on disk; it now returns `internal error` with the same `internal_error` code. Missing-note errors name the path relative to the vault.
