---
type: Fixed
---
- **`inspect_acl` agrees with enforcement.** It reported `allowed: true` for a hard-linked file that `read_note` refuses, for a symlinked name inside an immutable folder, and for a new note name the write path rejects. It now reports each as denied; `denied_by` gains the values `hard_link` and `invalid_write_path`.
