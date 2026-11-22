---
type: Added
---
- **`Idempotency-Key` header over HTTP.** A tool that accepts an idempotency key now also takes it from the `Idempotency-Key` request header when the arguments carry none. A header that disagrees with the argument is refused with `validation_error`; a tool that accepts no key ignores it; a JSON-RPC batch ignores it. The hash stored with a claim no longer includes the key, so the header and argument forms of one call match each other. Claims written by an older version still replay; an older version does not recognise a claim written by this one until it expires.
