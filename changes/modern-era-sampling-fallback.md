---
type: Fixed
---
- **`suggest_tags` no longer blames the client on a 2026-07-28 connection.** The MCP SDK refuses the sampling and roots requests a server makes of a client on that protocol version, before anything is sent. The server still attached the sampling hook when the client declared `sampling`, so every call failed inside the SDK and `suggest_tags` answered `declined_or_failed` with "The client's sampling reply was unusable". On a 2026-07-28 connection, HTTP or stdio, a tool context now carries no sampling hook and asks for no roots. `suggest_tags` reports `unsupported` there, and its note says sampling is not available on the connection. The heuristic suggestions are unchanged, and older connections behave as before.
