---
type: Fixed
---
- **Indexed text searches report refused note reads.** `search_text` and the text leg of `search_vault` now count refused reads in `notes_read_refused` after filtering candidates by the caller's ACL, preserve readable hits, and continue to skip deleted notes. Other read errors are no longer swallowed: they are handled as in the unindexed search, where a read the safe open refuses is counted and anything else is raised.
