---
type: Security
---
- **A hard-linked file is refused whether or not a folder ACL is configured.** The path check ran its
  hard-link guard only when an ACL object was passed. A shipped server always builds one, so this
  closes a gap for code that calls the check without an ACL: a delete or move of a hard-linked file
  is now refused there too. In that case a `bulk_move_notes` dry run is refused as a whole call
  (`acl_denied`), where it used to report the hard-linked source on its own row.
