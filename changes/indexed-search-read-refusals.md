---
type: Fixed
---
- **Indexed text searches report refused note reads.** `search_text` and the text leg of `search_vault` now count refused reads in `notes_read_refused` after filtering candidates by the caller's ACL, preserve readable hits, and propagate unexpected read errors while continuing to skip deleted notes.
