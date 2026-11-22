---
type: Security
---
- **The development ACL audit checks the operation, not only the path.** The opt-in audit (`RELIQUARY_TC_ACL_AUDIT`) recorded which paths a tool call had checked against the folder ACL. A call that checked a path for `write` and then deleted it passed. The audit now records the operation of each check, and the write, move and delete primitives report what they do, so a delete covered only by a write check (or the reverse) is a violation, and an error in strict mode. Nothing changes when the audit is off, which is the default.
