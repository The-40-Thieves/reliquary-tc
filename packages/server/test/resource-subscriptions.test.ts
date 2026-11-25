// Unit tests for mcp/resource-subscriptions.ts: the `notifications/resources/updated` push channel,
// served in front of the SDK's `subscriptions/listen` handler for the same reason advisories.ts is
// (the SDK's SubscriptionFilter/ServerEvent union has no resource-URI opt-in). No HTTP here; the
// wire-level behaviour lives in resource-subscriptions-http.test.ts.
//
// What matters most: the permission check runs on EVERY event, never once at subscribe time, and the
// ack must not reveal which of the requested URIs the caller can read.

import { describe, expect, it } from "vitest";
import {
  MAX_RESOURCE_SUBSCRIPTION_URIS,
  requestedResourceSubscriptions,
  serveResourceSubscription,
  subscribesToResources,
} from "../src/mcp/resource-subscriptions";
import { buildResourceUri } from "../src/mcp/resources";
import { createResourceChangeBus, type ResourceChangeEvent } from "../src/vault/note-changes";

const ACK = "notifications/subscriptions/acknowledged";
const UPDATED = "notifications/resources/updated";
const SUB_KEY = "io.modelcontextprotocol/subscriptionId";

type Frame = { jsonrpc: string; method: string; params: any };
type Target = { vaultId: string; relPath: string };
type CanRead = (uri: string) => Target | null;

function listenBody(id: unknown, resourceSubscriptions: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "subscriptions/listen",
    params: { notifications: { resourceSubscriptions } },
  };
}

/** Serve one subscription and hand back a handle to publish into it and close it. The stream's
 *  `start` runs synchronously inside the Response constructor, so the listener is registered before
 *  this returns. */
function open(reqBody: unknown, canRead: CanRead) {
  const bus = createResourceChangeBus();
  const ac = new AbortController();
  const res = serveResourceSubscription(reqBody, bus, canRead, ac.signal);
  return {
    res,
    bus,
    publish: (e: ResourceChangeEvent) => bus.publish(e),
    /** Aborts the request, then reads every frame the stream wrote. Frames already enqueued survive
     *  the close, so publishes made before this call are still read back. */
    close: async (): Promise<Frame[]> => {
      ac.abort();
      const text = await res.text();
      return text
        .split("\n\n")
        .filter((block) => block.startsWith("event: message\ndata: "))
        .map((block) => JSON.parse(block.slice("event: message\ndata: ".length)) as Frame);
    },
  };
}

const URI_A = buildResourceUri("test", "notes/a.md");
const URI_B = buildResourceUri("test", "notes/b.md");
const URI_C = buildResourceUri("test", "secret/c.md");

const READABLE: Record<string, Target> = {
  [URI_A]: { vaultId: "test", relPath: "notes/a.md" },
  [URI_B]: { vaultId: "test", relPath: "notes/b.md" },
};
const canReadFromMap: CanRead = (uri) => READABLE[uri] ?? null;

describe("createResourceChangeBus", () => {
  it("publishing with no listener is a no-op, not a throw", () => {
    const bus = createResourceChangeBus();
    expect(() => bus.publish({ vaultId: "test", relPath: "notes/a.md" })).not.toThrow();
  });

  it("delivers to a listener and stops after unsubscribe", () => {
    const bus = createResourceChangeBus();
    const seen: ResourceChangeEvent[] = [];
    const unsubscribe = bus.onChange((e) => seen.push(e));
    bus.publish({ vaultId: "test", relPath: "notes/a.md" });
    expect(seen).toEqual([{ vaultId: "test", relPath: "notes/a.md" }]);
    unsubscribe();
    bus.publish({ vaultId: "test", relPath: "notes/a.md" });
    expect(seen).toHaveLength(1);
  });

  it("one listener's throw does not break delivery to another", () => {
    const bus = createResourceChangeBus();
    const seen: ResourceChangeEvent[] = [];
    bus.onChange(() => {
      throw new Error("boom");
    });
    bus.onChange((e) => seen.push(e));
    expect(() => bus.publish({ vaultId: "test", relPath: "notes/a.md" })).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe("requestedResourceSubscriptions", () => {
  it("returns the URIs, in the requested order, when the array is present", () => {
    expect(requestedResourceSubscriptions(listenBody(1, [URI_B, URI_A]))).toEqual([URI_B, URI_A]);
  });

  it("is undefined when the key is absent", () => {
    expect(requestedResourceSubscriptions({ params: { notifications: {} } })).toBeUndefined();
    expect(
      requestedResourceSubscriptions({ params: { notifications: { toolsListChanged: true } } }),
    ).toBeUndefined();
    expect(requestedResourceSubscriptions({ params: {} })).toBeUndefined();
    expect(requestedResourceSubscriptions(null)).toBeUndefined();
    expect(requestedResourceSubscriptions(undefined)).toBeUndefined();
  });

  it("is undefined for an empty array (nothing was asked for)", () => {
    expect(requestedResourceSubscriptions(listenBody(1, []))).toBeUndefined();
  });

  it("is undefined when the value is not an array", () => {
    expect(requestedResourceSubscriptions(listenBody(1, URI_A))).toBeUndefined();
    expect(requestedResourceSubscriptions(listenBody(1, { 0: URI_A }))).toBeUndefined();
    expect(requestedResourceSubscriptions(listenBody(1, true))).toBeUndefined();
  });

  it("is undefined when any member is not a string (the array is not an array of strings)", () => {
    // Brief reading: the result is "the non-empty array of strings", so one bad member rejects the
    // whole array rather than being filtered out. Pinned here so the choice is visible.
    expect(requestedResourceSubscriptions(listenBody(1, [3, null]))).toBeUndefined();
    expect(requestedResourceSubscriptions(listenBody(1, [URI_A, 3]))).toBeUndefined();
    expect(requestedResourceSubscriptions(listenBody(1, [{ uri: URI_A }]))).toBeUndefined();
  });
});

describe("subscribesToResources", () => {
  it("is true exactly when a non-empty string array is requested", () => {
    expect(subscribesToResources(listenBody(1, [URI_A]))).toBe(true);
    expect(subscribesToResources(listenBody(1, []))).toBe(false);
    expect(subscribesToResources(listenBody(1, [3]))).toBe(false);
    expect(subscribesToResources({ params: { notifications: {} } })).toBe(false);
    expect(subscribesToResources(null)).toBe(false);
  });

  it("is false for another RPC method that carries the same notifications key", () => {
    const toolsCall = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { notifications: { resourceSubscriptions: [URI_A] } },
    };
    expect(subscribesToResources(toolsCall)).toBe(false);
  });

  it("is false when the method is missing", () => {
    const noMethod = {
      jsonrpc: "2.0",
      id: 1,
      params: { notifications: { resourceSubscriptions: [URI_A] } },
    };
    expect(subscribesToResources(noMethod)).toBe(false);
  });
});

describe("serveResourceSubscription", () => {
  it("answers with an SSE stream whose first frame acknowledges EVERY requested URI in order", async () => {
    const s = open(listenBody(7, [URI_C, URI_A, URI_B]), canReadFromMap);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    const frames = await s.close();
    const ack = frames[0];
    expect(ack?.method).toBe(ACK);
    // The unreadable URI is acknowledged too: the ack must not reveal which URIs are readable.
    expect(ack?.params.notifications.resourceSubscriptions).toEqual([URI_C, URI_A, URI_B]);
    expect(ack?.params._meta[SUB_KEY]).toBe(7);
  });

  it("a matching publish yields exactly one resources/updated frame with the client's URI and the subscription id", async () => {
    const s = open(listenBody(7, [URI_A]), canReadFromMap);
    s.publish({ vaultId: "test", relPath: "notes/a.md" });
    const updates = (await s.close()).filter((f) => f.method === UPDATED);
    expect(updates).toEqual([
      { jsonrpc: "2.0", method: UPDATED, params: { uri: URI_A, _meta: { [SUB_KEY]: 7 } } },
    ]);
  });

  it("a publish for another path in the same vault, or the same path in another vault, yields nothing", async () => {
    const s = open(listenBody(7, [URI_A]), canReadFromMap);
    s.publish({ vaultId: "test", relPath: "notes/zzz.md" });
    s.publish({ vaultId: "other", relPath: "notes/a.md" });
    const frames = await s.close();
    expect(frames.some((f) => f.method === UPDATED)).toBe(false);
  });

  it("a URI canRead refuses sends nothing, while a readable URI in the same subscription still does", async () => {
    const s = open(listenBody(7, [URI_A, URI_C]), canReadFromMap);
    // URI_C is not in the readable map, so canRead returns null for it at every event.
    s.publish({ vaultId: "test", relPath: "secret/c.md" });
    s.publish({ vaultId: "test", relPath: "notes/a.md" });
    const updates = (await s.close()).filter((f) => f.method === UPDATED);
    expect(updates.map((f) => f.params.uri)).toEqual([URI_A]);
  });

  it("re-checks permission on every event: allow, then deny, delivers the first and not the second", async () => {
    let allowed = true;
    let calls = 0;
    const canRead: CanRead = (uri) => {
      calls++;
      return allowed ? (READABLE[uri] ?? null) : null;
    };
    const s = open(listenBody(7, [URI_A]), canRead);
    s.publish({ vaultId: "test", relPath: "notes/a.md" });
    allowed = false;
    s.publish({ vaultId: "test", relPath: "notes/a.md" });
    const updates = (await s.close()).filter((f) => f.method === UPDATED);
    expect(updates).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("accepts exactly MAX_RESOURCE_SUBSCRIPTION_URIS (256) URIs", async () => {
    expect(MAX_RESOURCE_SUBSCRIPTION_URIS).toBe(256);
    const uris = Array.from({ length: 256 }, (_, i) => buildResourceUri("test", `n/${i}.md`));
    const s = open(listenBody(3, uris), () => null);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    const frames = await s.close();
    expect(frames[0]?.params.notifications.resourceSubscriptions).toHaveLength(256);
  });

  it("257 URIs is a JSON-RPC -32602 error (not a stream), HTTP 400, echoing the request id", async () => {
    const uris = Array.from({ length: 257 }, (_, i) => buildResourceUri("test", `n/${i}.md`));
    const bus = createResourceChangeBus();
    const res = serveResourceSubscription(
      listenBody("req-9", uris),
      bus,
      () => null,
      new AbortController().signal,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = (await res.json()) as { jsonrpc: string; error: { code: number }; id: unknown };
    expect(json).toMatchObject({ jsonrpc: "2.0", error: { code: -32602 }, id: "req-9" });
  });

  it("aborting the signal removes the bus listener: a later publish delivers nothing, does not throw, and does not call canRead", async () => {
    let calls = 0;
    const canRead: CanRead = (uri) => {
      calls++;
      return READABLE[uri] ?? null;
    };
    const s = open(listenBody(7, [URI_A]), canRead);
    const before = await s.close();
    expect(before[0]?.method).toBe(ACK);
    const callsAtClose = calls;
    expect(() => s.publish({ vaultId: "test", relPath: "notes/a.md" })).not.toThrow();
    expect(calls).toBe(callsAtClose);
  });
});
