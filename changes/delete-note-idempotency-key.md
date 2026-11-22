---
type: Added
---
- **`delete_note` accepts an `idempotency_key`.** A retry with the same key and arguments returns the
  first call's result and deletes nothing more, so a client that retries after a lost response cannot
  remove a note written to that path in the meantime. The same key with different arguments is refused
  (`idempotency_key_mismatch`). A replay does not ask for confirmation again, because it deletes nothing.
  One exception: if the first call failed or crashed after the removal had started, the retry is
  answered `indeterminate_outcome` and nothing runs. Check whether the note still exists, and use a new
  key to delete it.
