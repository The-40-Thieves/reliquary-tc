---
type: Security
---
- **`append_note` no longer reveals the size of a note the caller cannot read.** For a caller who may write a note but not read it, the acknowledgement omits `bytes_written`, which was the length of the whole resulting note. A caller who may read the note still gets it.
