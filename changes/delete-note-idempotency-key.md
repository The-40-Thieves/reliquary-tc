---
type: Added
---
- **`delete_note` accepts an `idempotency_key`.** A retry with the same key and arguments returns the
  first call's result and deletes nothing more, so a client that retries after a lost response cannot
  remove a note written to that path in the meantime. The same key with different arguments is refused
  (`idempotency_key_mismatch`). A replay does not ask for confirmation again, because it deletes nothing.
