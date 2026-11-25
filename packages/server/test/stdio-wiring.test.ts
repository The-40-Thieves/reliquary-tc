// startStdioServing's EOF routing, in process: the SDK transport is stubbed, so the recorded
// callbacks are driven directly and nothing spawns. The child-process test (stdio-eof-http-keepalive)
// covers the real process.exit; these cases cover each branch where coverage can see it.

import type { ServerConfig } from "@the-40-thieves/reliquary-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type StdioWiringDeps, startStdioServing } from "../src/runtime/stdio-wiring";
import type { StdioEraOptions } from "../src/transports/stdio";

const mocks = vi.hoisted(() => ({ serveStdioEras: vi.fn() }));
vi.mock("../src/transports/stdio", () => ({ serveStdioEras: mocks.serveStdioEras }));

afterEach(() => {
  vi.restoreAllMocks();
});

const httpConfig = (enabled: boolean) =>
  ({ transports: { http: { enabled }, stdio: true } }) as unknown as ServerConfig;

const buildStdioServer = (): never => {
  throw new Error("not built in this test: serveStdioEras is stubbed");
};

/** Starts stdio serving against the stub, returning the recorded options and the stub handle. */
function start(config: ServerConfig, close: StdioWiringDeps["close"]) {
  const handle = { close: vi.fn(async () => {}) };
  let recorded: StdioEraOptions | undefined;
  mocks.serveStdioEras.mockImplementation((_build: unknown, opts: StdioEraOptions) => {
    recorded = opts;
    return handle;
  });
  const serving = startStdioServing({ config, buildStdioServer, close });
  if (recorded === undefined) throw new Error("serveStdioEras was not called");
  return { serving, handle, opts: recorded };
}

describe("stdin EOF with HTTP also enabled", () => {
  it("writes the keep-serving notice and neither closes nor exits", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const close = vi.fn(async (_reason: string) => {});
    const { opts } = start(httpConfig(true), close);
    opts.onEof?.();
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain("HTTP transport still serving");
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("stdin EOF with stdio as the only transport", () => {
  it("closes once with transport:stdio-eof, then exits 0", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const close = vi.fn(async (_reason: string) => {});
    const { opts } = start(httpConfig(false), close);
    opts.onEof?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("transport:stdio-eof");
  });

  it("still exits 0 when the shutdown close rejects, logging the error", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const close = vi.fn(async (_reason: string): Promise<void> => {
      throw new Error("close failed");
    });
    const { opts } = start(httpConfig(false), close);
    opts.onEof?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("close failed");
  });
});

describe("the handshake and close handles", () => {
  it("resolves initialized on the recorded handshake, and close() closes the stub handle", async () => {
    const { serving, handle, opts } = start(
      httpConfig(false),
      vi.fn(async () => {}),
    );
    opts.onHandshake?.();
    await expect(serving.initialized).resolves.toBeUndefined();
    await serving.close();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});
