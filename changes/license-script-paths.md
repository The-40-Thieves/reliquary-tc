---
type: Fixed
---
- **The licence-file build scripts are stricter about what they touch.** The script that builds the Docker image's licence file took its output path from the command line and removed and wrote whatever it was given. It now takes no output path: it prints the text, and the image build redirects it into `THIRD-PARTY-LICENSES.txt`. The script that writes the native module's licence file ran `cargo` by name; it now runs it by full path, from `CARGO_HOME` (`~/.cargo` by default), or from `CARGO` when that is set to a full path. A cargo installed somewhere else needs `CARGO` set.
