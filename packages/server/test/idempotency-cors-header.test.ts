import { Hono } from "hono";
import { expect, it } from "vitest";
import { corsMiddleware } from "../src/transports/cors";

it("allows the idempotency header in CORS preflight", async () => {
  const app = new Hono();
  app.use("*", corsMiddleware(new Set(["https://client.example"])));
  const response = await app.request("http://localhost/mcp", {
    method: "OPTIONS",
    headers: {
      origin: "https://client.example",
      "access-control-request-headers": "idempotency-key",
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");
});
