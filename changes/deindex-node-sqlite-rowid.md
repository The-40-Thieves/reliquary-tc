---
type: Fixed
---
- **Deleting an indexed note no longer fails under `node:sqlite`.** An FTS5 segment flush while deleting a note's chunks left SQLite's last insert rowid above 2^53. `node:sqlite` then threw `ERR_OUT_OF_RANGE` on the next write, which rolled back the whole delete and left the note searchable. This affects the packed `.mcpb` bundle and any Node install without `better-sqlite3`.
