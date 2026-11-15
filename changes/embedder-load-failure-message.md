---
type: Fixed
---
- **A built local embedder that fails to load is no longer told to build it.** The Docker image carries a built `packages/embedder-local`, so a load failure there (for example a missing ONNX runtime library) was reported as "this source checkout has not built it". The message now names the file and the load error, a missing platform runtime is reported as such in a checkout too, and the build advice is kept for a checkout with no build. The release smoke step's `notes_fts failed` check reads the startup output from a here-string, so it can no longer pass on a `SIGPIPE` under `pipefail`.
