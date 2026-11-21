---
type: Fixed
---
- **The server-secret reader test no longer times out on slow macOS runners.** Its read loop is bounded by a time budget after a minimum of 500 reads, where it used to do a fixed 5,000 that took from 2 to more than 60 seconds on macOS. Test-only change.
