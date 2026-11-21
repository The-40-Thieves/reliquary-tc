---
type: Fixed
---
- **`audit_provenance` skips the vault's own daily-notes folder.** It reads the folder from the Periodic Notes or Daily Notes settings, so a vault that keeps daily notes outside `01-daily/` no longer has every daily note reported as missing provenance. `lint_wiki` uses the same scan. The built-in default exclusions still apply.
