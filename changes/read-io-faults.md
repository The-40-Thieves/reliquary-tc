---
type: Fixed
---
- **A note that cannot be read is no longer mistaken for a refused one.** With the native module, an ordinary I/O fault on a note (for example a file the server has no permission to read) was reported as an access refusal, so searches skipped it silently. It is now an `internal_error` carrying the errno name and no host path, the same on the native module and the JavaScript fallback. Searches and attachment scans fail on it. `index_vault` skips the file and counts it in a new `notes_read_failed` field, apart from `notes_read_refused`.
