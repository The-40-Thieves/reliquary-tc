// `notifications/resources/updated` for `subscriptions/listen`, served in front of the SDK handler
// (transports/http.ts), beside the advisory and Tasks extensions. The SDK's own listen router
// matches a subscribed resource on its URI string alone, with no read check, so a subscriber would
// be told about notes its ACL refuses. Each event is checked against the caller's read permission
// before anything is written.
//
// Every requested URI is acknowledged, including ones the caller cannot read. The ack must not
// reveal which URIs are readable.
//
// Permission is re-checked on every event, not at subscribe time: a note's ACL can change while a
// stream is open, and the stream must follow it.

import type { ResourceChangeBus } from "../vault/note-changes";
import { type ListenSource, serveListenSources } from "./listen-stream";

/** The most URIs one subscription may name. Above it the request is refused, not truncated. */
export const MAX_RESOURCE_SUBSCRIPTION_URIS = 256;

/** The non-empty array of URIs at `params.notifications.resourceSubscriptions`, or undefined. A
 *  non-string member rejects the whole array. */
export function requestedResourceSubscriptions(body: unknown): string[] | undefined {
  const list = (body as { params?: { notifications?: Record<string, unknown> } } | null)?.params
    ?.notifications?.resourceSubscriptions;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.every((uri) => typeof uri === "string") ? (list as string[]) : undefined;
}

/** Did this `subscriptions/listen` ask for resource update notifications? Any other method that
 *  carries the same key is an ordinary request, not a subscription. */
export function subscribesToResources(body: unknown): boolean {
  if ((body as { method?: unknown } | null)?.method !== "subscriptions/listen") return false;
  return requestedResourceSubscriptions(body) !== undefined;
}

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

type Target = { vaultId: string; relPath: string } | null;

function refuseTooMany(count: number, id: string | number | null): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32602,
        message: `resource subscription names ${count} URIs; the limit is ${MAX_RESOURCE_SUBSCRIPTION_URIS}`,
      },
      id,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * This subscription's share of a listen stream: its ack lists every requested URI, and each event
 * whose note `canRead` names for a requested URI becomes one `notifications/resources/updated`.
 * Returns the over-limit refusal instead when the request names more than
 * MAX_RESOURCE_SUBSCRIPTION_URIS URIs.
 *
 * `canRead` is called on every event, with the URI the client sent, and returns the note's
 * normalized target or null.
 */
export function resourceListenSource(
  body: unknown,
  bus: ResourceChangeBus,
  canRead: (uri: string) => Target,
): ListenSource | Response {
  const id = (body as { id?: string | number | null } | null)?.id ?? null;
  const uris = requestedResourceSubscriptions(body) ?? [];
  if (uris.length > MAX_RESOURCE_SUBSCRIPTION_URIS) return refuseTooMany(uris.length, id);
  // A URI listed twice gets one update per event, not two.
  const distinct = [...new Set(uris)];
  return {
    ack: { resourceSubscriptions: uris },
    attach(send, subscriptionId) {
      return bus.onChange((event) => {
        for (const uri of distinct) {
          let target: Target = null;
          try {
            target = canRead(uri);
          } catch {
            target = null;
          }
          if (!target) continue;
          if (target.vaultId !== event.vaultId || target.relPath !== event.relPath) continue;
          send({
            jsonrpc: "2.0",
            method: "notifications/resources/updated",
            params: { uri, _meta: { [SUBSCRIPTION_ID]: subscriptionId } },
          });
        }
      });
    },
  };
}

/**
 * Serve the resource-update stream on its own. Refuses more than MAX_RESOURCE_SUBSCRIPTION_URIS URIs
 * with a JSON-RPC -32602 error (HTTP 400). Otherwise acks every URI, then sends one
 * `notifications/resources/updated` for each (uri, event) pair where `canRead(uri)` names the
 * event's vault and path, until the request is aborted.
 */
export function serveResourceSubscription(
  body: unknown,
  bus: ResourceChangeBus,
  canRead: (uri: string) => Target,
  signal: AbortSignal,
): Response {
  const source = resourceListenSource(body, bus, canRead);
  if (source instanceof Response) return source;
  const id = (body as { id?: string | number | null } | null)?.id ?? null;
  return serveListenSources(id, [source], signal);
}
