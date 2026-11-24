---
type: Added
---
- **The native module now ships the licence texts of the Rust crates compiled into it.** The module is one compiled library, so nothing a user installs named the 25 crates inside it. `packages/native/THIRD-PARTY-LICENSES.txt` lists them with their texts. It ships in `@the-40-thieves/reliquary-tc-native`, in each per-platform package and beside the module in the Docker image. The file is written from `cargo metadata` by `bun scripts/write-native-license-file.mjs` and committed; CI fails when it no longer matches `Cargo.lock`, so a dependency change needs that command run again.
