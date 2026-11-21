---
type: Security
---
- **The native platform packages are published with npm provenance.** The per-platform `reliquary-tc-native-<platform>` packages were published without a provenance attestation, while the main packages had one. The release now asks npm for provenance on them too. This takes effect from the next release; versions already published are unchanged.
