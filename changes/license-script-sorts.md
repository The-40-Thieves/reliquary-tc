---
type: Changed
---
- **The licence-file scripts state their sort order.** They sorted package folders, file names and bundles with a bare `sort()`. Each call now names the comparison it relied on (by code unit), so the lists come out the same on every machine and the order is no longer implicit. The output is unchanged.
