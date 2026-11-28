---
type: Added
---
- **`indexing.writePreparation` selects how a single note is prepared before it is written.** The default, `"legacy"`, keeps the existing path. `"modular"` opts into an isolated preparation step that plans and embeds a note before the write transaction opens. Both modes produce the same index rows under the same chunk and embedding limits, and both apply the same egress exclusions and stale-write fencing. To switch back, change the setting and restart; the index does not need a rebuild.
