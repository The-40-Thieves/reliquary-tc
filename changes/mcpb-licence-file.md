---
type: Added
---
- **The MCPB bundle now carries its third-party licence texts.** `reliquary-tc.mcpb` has a `THIRD-PARTY-LICENSES.txt` at its root: the project's LICENSE and NOTICE, then the licence text of every package in the bundle. That covers the dependencies built into the server, the local embedder, the `sqlite-vec` loader with all five platform libraries, and the ONNX Runtime files for every platform. The list is read from what was built, so a package that is installed but not bundled is not in it. Packing stops if a bundled package has no licence text, and again if the finished archive lacks `LICENSE`, `NOTICE` or the new file.
