---
type: Fixed
---
- **More vault scans keep the server responsive.** Outgoing-link lookup, wiki identity evidence, and the dry runs of hub pruning and link rewriting now yield between scan steps while preserving result order and read permissions. A real pruning or rewrite run still plans and writes in one step, so a note created or edited meanwhile cannot make it act on a stale view of the vault.
