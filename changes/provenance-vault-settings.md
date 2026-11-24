---
type: Changed
tool-description-change: audit_provenance
---
- **`audit_provenance` follows the vault's template folder, type key and source fields.** It excludes the Obsidian and Templater template folders, reads note types from the configured type key (default `type`), and counts a non-empty `source` or `references` as sources when no `field` is given. Notes flagged only for lacking `sources` may now pass; each is listed in `field_aliases`, capped by `limit`, with the full number in `field_aliases_count`. `lint_wiki`'s `missing_sources` rule uses the same scan. An explicit `field` is still checked exactly.
