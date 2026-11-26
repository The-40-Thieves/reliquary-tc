// clientRoots, clientSupportsSampling and sampleViaClient judge the capabilities they are given
// (the request's own, on 2026-07-28 stdio), and fall back to the handshake's when given none.

import type { Server } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import {
  clientFeatureContext,
  clientRoots,
  clientSupportsSampling,
  sampleViaClient,
} from "../src/mcp/client-features";

/** A server whose handshake slot holds `handshake`, with recording listRoots and createMessage. */
function fakeServer(handshake: unknown, negotiated?: string) {
  const listRoots = vi.fn(async () => ({ roots: [{ uri: "file:///work" }] }));
  const createMessage = vi.fn(async () => ({ role: "assistant" }));
  const server = {
    getClientCapabilities: () => handshake,
    getNegotiatedProtocolVersion: () => negotiated,
    listRoots,
    createMessage,
  };
  return { server: server as unknown as Server, listRoots, createMessage };
}

const BOTH = { roots: {}, sampling: {} };

const SAMPLE = { messages: [], maxTokens: 1 };

describe("client features judged on the request's declared capabilities", () => {
  it("roots: asked for when the request declares them, though the handshake slot is empty", async () => {
    const { server, listRoots } = fakeServer(undefined);
    expect(await clientRoots(server, { roots: {} })).toEqual([{ uri: "file:///work" }]);
    expect(listRoots).toHaveBeenCalledTimes(1);
  });

  it("roots: not asked for when the request declares none, though the handshake did", async () => {
    const { server, listRoots } = fakeServer({ roots: {} });
    expect(await clientRoots(server, {})).toBeUndefined();
    expect(listRoots).not.toHaveBeenCalled();
  });

  it("sampling: supported and sent on the request's declaration alone", async () => {
    const { server, createMessage } = fakeServer(undefined);
    expect(clientSupportsSampling(server, { sampling: {} })).toBe(true);
    expect(await sampleViaClient(server, SAMPLE, { sampling: {} })).toEqual({ role: "assistant" });
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("with no capabilities given, the handshake's still decide", async () => {
    const { server, listRoots } = fakeServer({ roots: {}, sampling: {} });
    expect(await clientRoots(server)).toEqual([{ uri: "file:///work" }]);
    expect(clientSupportsSampling(server)).toBe(true);
    expect(listRoots).toHaveBeenCalledTimes(1);
    expect(clientSupportsSampling(fakeServer(undefined).server)).toBe(false);
  });

  it("the tool context carries sample only when the given capabilities declare sampling", () => {
    const { server } = fakeServer(undefined);
    expect(typeof clientFeatureContext(server, { sampling: {} }).sample).toBe("function");
    expect("sample" in clientFeatureContext(server, {})).toBe(false);
    expect(typeof clientFeatureContext(server, {}).roots).toBe("function");
  });
});

// SDK 2.4.0 refuses createMessage and listRoots on a 2026-07-28 connection before anything is sent,
// so a hook attached there can only fail. The context carries none, and asks the SDK for nothing.
describe("client features on a 2026-07-28 connection", () => {
  it("a per-request modern server carries no sample and resolves no roots, without asking", async () => {
    const { server, listRoots, createMessage } = fakeServer(undefined);
    const ctx = clientFeatureContext(server, BOTH, true);
    expect("sample" in ctx).toBe(false);
    expect(await ctx.roots()).toBeUndefined();
    expect(listRoots).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("a long-lived connection that negotiated 2026-07-28 is judged the same way", async () => {
    const { server, listRoots } = fakeServer(BOTH, "2026-07-28");
    const ctx = clientFeatureContext(server, BOTH, false);
    expect("sample" in ctx).toBe(false);
    expect(await ctx.roots()).toBeUndefined();
    expect(listRoots).not.toHaveBeenCalled();
  });

  it("a connection that negotiated 2025-11-25 keeps both", async () => {
    const { server, listRoots } = fakeServer(BOTH, "2025-11-25");
    const ctx = clientFeatureContext(server, BOTH, false);
    expect(typeof ctx.sample).toBe("function");
    expect(await ctx.roots()).toEqual([{ uri: "file:///work" }]);
    expect(listRoots).toHaveBeenCalledTimes(1);
  });
});
