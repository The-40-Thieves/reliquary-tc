---
type: Fixed
---
- **Follower processes use the leader's index readiness.** A process that is not the indexing leader now reads note-index readiness from the leader's persisted state, so `search_text` and the frontmatter and tag tools use the index instead of always falling back to a disk scan. Its `server_health` also lists reconcile errors only for its own configured vaults; the overall reconcile state it shows is still the leader's, which can cover vaults this process does not configure.
