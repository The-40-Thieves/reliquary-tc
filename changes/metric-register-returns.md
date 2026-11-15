---
type: Changed
---
- **Two metric register functions return their metric.** `registerProcessMemoryGauge` and
  `registerEmbedderHostRestarts` now return the gauge and counter they register, where they used to
  create and discard them. Nothing about the exported metrics changes; this clears two static-analysis
  reports of an unused object.
