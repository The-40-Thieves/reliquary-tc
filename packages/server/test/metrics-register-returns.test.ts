import { Registry } from "@prometheus-io/client";
import { describe, expect, it } from "vitest";
import { registerEmbedderHostRestarts } from "../src/metrics/embedder-host-counters";
import { registerProcessMemoryGauge } from "../src/metrics/process-memory";

// Each register function hands back the metric it put in the registry. The metric registers itself
// through its constructor's `registers` option, so an unassigned `new Gauge(...)` works but reads
// as a discarded object to static analysis.
describe("scrape-time metric register functions", () => {
  it("registerProcessMemoryGauge returns the gauge it registered", () => {
    const registry = new Registry();
    const gauge = registerProcessMemoryGauge([registry]);
    expect(gauge).toBe(registry.getSingleMetric("reliquary_tc_process_memory_bytes"));
    expect(gauge).toBeDefined();
  });

  it("registerEmbedderHostRestarts returns the counter it registered", () => {
    const registry = new Registry();
    const counter = registerEmbedderHostRestarts([registry]);
    expect(counter).toBe(registry.getSingleMetric("reliquary_tc_embedder_host_recycles_total"));
    expect(counter).toBeDefined();
  });
});
