---
type: Added
---
- **Each standalone binary now ships with its licence file.** A release carries `reliquary-tc-<target>-licenses.txt` beside every binary: the project's LICENSE and NOTICE, then the licence text of every third-party package bundled into that executable, including the `sqlite-vec` library and the ONNX Runtime files embedded for that platform. The list is taken from what the bundler put into each target, so it differs per platform where the binaries do. The file is in `SHASUMS256.txt` and has its own cosign bundle, which takes a release from 24 signature bundles to 29. A build stops if a bundled package has no licence text or declares a licence that has not been accepted.
