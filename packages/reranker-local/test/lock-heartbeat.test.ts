import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fetchAndVerifyModel, modelDirFor } from "../src/model-fetch.js";

it("refreshes a long download's lock and prevents a second downloader taking over", async () => {
  const root = await mkdtemp(join(tmpdir(), "reranker-heartbeat-"));
  const spec = {
    modelId: "test/model",
    revision: "rev",
    pinnedFiles: [{ path: "a", sha256: "", sizeBytes: 1 }],
    lockStaleMs: 45_000,
    lockPollMs: 10,
  };
  let finish!: (response: Response) => void;
  const fetchFn = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(new Response(null, { status: 500 }));
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  let first: Promise<string> | undefined;
  let second: Promise<string> | undefined;
  try {
    first = fetchAndVerifyModel(root, { ...spec, fetchFn: fetchFn as typeof fetch });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const ownerPath = `${modelDirFor(root, spec)}.lock/owner.json`;
    const initial = JSON.parse(await readFile(ownerPath, "utf8")).startedAt;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(ownerPath, "utf8")).startedAt).toBeGreaterThan(initial),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    second = fetchAndVerifyModel(root, { ...spec, fetchFn: fetchFn as typeof fetch });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    finish?.(new Response(null, { status: 500 }));
    await Promise.allSettled([first, second].filter((p): p is Promise<string> => p !== undefined));
    await rm(root, { recursive: true, force: true });
  }
});
