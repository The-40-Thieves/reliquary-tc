---
type: Fixed
---
- **Preference extraction counts each evidence window once.** Repeated reflection no longer inflates preference weights, and preference batches are applied atomically. Windows recorded before this change carry no evidence key, so the first extraction after upgrading can apply each of them once more; weights inflated earlier are not corrected.
