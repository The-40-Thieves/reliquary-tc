---
type: Fixed
---
- **A missing local embedder now says how to install it.** `npm install reliquary-tc` leaves the
  default `local` embedder out, so a zero-config start had semantic search off with only "could not
  resolve the optional package" on stderr and in `server_health`. That message now carries the install
  command for this install's layout (global or project), in the reconcile error as well as on
  stderr. A source checkout is told to build the package instead. `reliquary-tc --help` and the
  `embeddings.provider` description no longer call the embedder bundled for npm installs. Refs #1524.
