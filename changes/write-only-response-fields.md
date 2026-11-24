---
type: Security
---
- **A write no longer reports what it could only know by reading.** A caller allowed to write a file but not to read it still gets the write, and the reply now leaves out the values worked out from the bytes it may not read: `previous_size` in the `write_attachment` overwrite confirmation and `size` from `delete_attachment` are `null`, `append_to_periodic_note` omits `appended_bytes` for a note that already existed (the count showed whether the note ended in a newline), and `end_session` omits `event_count` when the session's trace is a file inside the vault. `appended_bytes` and `event_count` are therefore optional in the two output schemas. A caller that may read the target gets every field as before.
