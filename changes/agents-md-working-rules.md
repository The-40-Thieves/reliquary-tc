---
type: Changed
---
- **`AGENTS.md` now states the working rules for every change.** Agents that read `AGENTS.md` rather than `CLAUDE.md` get the same rules: premise check, no private tracker ids, DCO sign-off, a `changes/` fragment, tests first, and the CI gates beyond `bun run lint`. The install command gains `--ignore-scripts`.
