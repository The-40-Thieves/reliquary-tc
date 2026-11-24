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

/** Did this `subscriptions/listen` ask for resource update notifications? */
export function subscribesToResources(body: unknown): boolean {
  return requestedResourceSubscriptions(body) !== undefined;
}

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const encoder = new TextEncoder();

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

/** Write one SSE frame. A client that hung up between the check and the write is not an error. */
function sendFrame(
  controller: ReadableStreamDefaultController<Uint8Array>,
  frame: Record<string, unknown>,
): void {
  try {
    controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(frame)}\n\n`));
  } catch {
    /* the client hung up between the check and the write */
  }
}

interface OpenStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  bus: ResourceChangeBus;
  canRead: (uri: string) => Target;
  uris: string[];
  distinct: string[];
  id: string | number | null;
}

/** Ack every URI, then send an update per event whose note `canRead` names. Returns the unsubscribe. */
function openStream(s: OpenStream): () => void {
  sendFrame(s.controller, {
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: {
      notifications: { resourceSubscriptions: s.uris },
      _meta: { [SUBSCRIPTION_ID]: s.id },
    },
  });
  return s.bus.onChange((event) => {
    for (const uri of s.distinct) {
      let target: Target = null;
      try {
        target = s.canRead(uri);
      } catch {
        target = null;
      }
      if (!target) continue;
      if (target.vaultId !== event.vaultId || target.relPath !== event.relPath) continue;
      sendFrame(s.controller, {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri, _meta: { [SUBSCRIPTION_ID]: s.id } },
      });
    }
  });
}

/**
 * Serve the resource-update stream. Refuses more than MAX_RESOURCE_SUBSCRIPTION_URIS URIs with a
 * JSON-RPC -32602 error (HTTP 400). Otherwise acks every URI, then sends one
 * `notifications/resources/updated` for each (uri, event) pair where `canRead(uri)` names the
 * event's vault and path, until the request is aborted.
 *
 * `canRead` is called on every event, with the URI the client sent, and returns the note's
 * normalized target or null.
 */
export function serveResourceSubscription(
  body: unknown,
  bus: ResourceChangeBus,
  canRead: (uri: string) => Target,
  signal: AbortSignal,
): Response {
  const id = (body as { id?: string | number | null } | null)?.id ?? null;
  const uris = requestedResourceSubscriptions(body) ?? [];
  if (uris.length > MAX_RESOURCE_SUBSCRIPTION_URIS) return refuseTooMany(uris.length, id);
  // A URI listed twice gets one update per event, not two.
  const distinct = [...new Set(uris)];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const unsubscribe = openStream({ controller, bus, canRead, uris, distinct, id });
      const close = () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (signal.aborted) close();
      else signal.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
