---
type: Security
---
- **`open_workspace` now requires read access to the workspaces file.** A caller that could write
  `.obsidian/workspaces.json` but not read it (the `write:workspaces` scope without `read:workspaces`,
  or a folder ACL that allows the write and not the read) got the stored layout back, could tell an
  existing workspace name from a missing one, and changed the active workspace. It now gets the same
  fixed refusal as `save_workspace`, and nothing is written. Callers that can read the file are not
  affected.
