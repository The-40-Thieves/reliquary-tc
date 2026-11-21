---
type: Security
---
- **A hard-linked file is refused whether or not a folder ACL is configured.** The path check ran its
  hard-link guard only when an ACL object was passed. Tool calls always carry one, but some internal
  callers pass none (the scheduled wiki lint is one), and there a delete or write of a hard-linked
  file passed the check. It is now refused. In that case a `bulk_move_notes` dry run is refused as a
  whole call (`acl_denied`), where it used to report the hard-linked source on its own row.
