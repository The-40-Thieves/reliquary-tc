// One `subscriptions/listen` stream for every private extension that a single request may ask for.
// Each extension (resource updates, advisory push) contributes a source: the part of the ack it
// acknowledges, and how to start sending its events. The stream itself is written once here, so a
// request naming both kinds gets one ack frame and one SSE body.

export type ListenSend = (frame: Record<string, unknown>) => void;

export interface ListenSource {
  /** This source's part of the acknowledged `notifications` object. */
  ack: Record<string, unknown>;
  /** Start sending this source's events; returns the unsubscribe. */
  attach(send: ListenSend, id: string | number | null): () => void;
}

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const encoder = new TextEncoder();

/**
 * Ack once with every source's part merged, then let each source attach. The stream ends, and every
 * source detaches, when the request is aborted.
 */
export function serveListenSources(
  id: string | number | null,
  sources: ListenSource[],
  signal: AbortSignal,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send: ListenSend = (frame) => {
        try {
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(frame)}\n\n`));
        } catch {
          /* the client hung up between the check and the write */
        }
      };
      const notifications = Object.assign({}, ...sources.map((source) => source.ack));
      send({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: { notifications, _meta: { [SUBSCRIPTION_ID]: id } },
      });
      const detach = sources.map((source) => source.attach(send, id));
      const close = () => {
        for (const unsubscribe of detach) unsubscribe();
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
