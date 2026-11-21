---
type: Security
---
- **The hard-link check refuses a file whose link count cannot be read.** The check answered "not
  hard-linked" whenever the stat failed, for any reason, so a target it could not inspect passed.
  It now refuses unless the target is simply not there yet (a write to a new path). This applies to
  the path ACL, the index's ACL identity, and what `inspect_acl` reports. A file whose stat fails is
  reported by `inspect_acl` as `denied_by: "hard_link"`.
