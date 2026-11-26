---
type: Added
---
- **Resource subscriptions push note updates.** A `subscriptions/listen` on the HTTP transport (2026-07-28 protocol only) that names note URIs in `resourceSubscriptions` now receives `notifications/resources/updated` when a note the caller can read is written, deleted, or changed on disk. A note the caller cannot read is never announced; the subscription is still acknowledged, so the ack does not reveal which notes are readable. Clients that subscribed before this change received no updates and should resubscribe to get them.
