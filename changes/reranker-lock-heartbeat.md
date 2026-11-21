---
type: Fixed
---
- **A long reranker model download keeps its lock.** The local reranker now refreshes its download lock every 30 seconds, as the local embedder already did. Before, a download that ran past the stale threshold could be taken over by a second process, and the first one then deleted the second's lock when it finished.
