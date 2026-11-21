---
type: Security
---
- **A hard-linked file is refused whether or not a folder ACL is configured.** The path check ran its
  hard-link guard only when an ACL object was passed. Tool calls always carry one; internal code that
  calls the check with none is now refused for a delete, move or write of a hard-linked file. Reads
  were already refused by the file reader, so read-only callers such as the scheduled wiki lint see
  the same refusal one step earlier. With no ACL, a `bulk_move_notes` dry run is refused as a whole
  call (`acl_denied`), where it used to report the hard-linked source on its own row.
