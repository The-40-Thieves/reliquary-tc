---
type: Security
---
- **A revoked token is refused while its revocation is still pending.** An access token issued by the bundled authorization server is now rejected as soon as it is revoked, even if recording the revocation in the registry failed and is waiting for a retry. Tokens from other issuers are not affected.
