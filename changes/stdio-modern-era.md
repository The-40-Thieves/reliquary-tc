---
type: Changed
---
- **Stdio serves both protocol revisions.** A stdio client that opens with `server/discover` or a request carrying the 2026-07-28 envelope now gets the 2026-07-28 behaviour, including the `ttlMs` and `cacheScope` hints on list results. A client that opens with a 2025-11-25 `initialize` is served exactly as before. The era is chosen by the opening message and is fixed for that connection. Resource subscriptions are not offered on 2026-07-28 over stdio yet: a client asking for them gets an empty filter and no updates. Nothing to change for existing clients.
- **`connectStdio` is no longer exported.** Code that imported it from the server package uses `serveStdioEras` instead, which takes a function that builds a server for a given era.
