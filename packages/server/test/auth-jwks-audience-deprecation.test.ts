// A JWKS key source with no effective audience accepts a token the same issuer minted for ANOTHER
// service (confused deputy). The schema requires `audience` or `resource` with a JWKS and the
// verifier binds either, so no config that loads is in that state. The DEPRECATION (startup line,
// `doctor`, `server_health`) still guards an auth object built without the schema, which is what
// `unbound` below makes. `auth.allowMissingAudience: true` is the explicit opt-out.
import { ServerConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJwtVerifier } from "../src/auth/jwt-boot";
import { authAudienceCheck } from "../src/doctor/auth-jwks";
import { healthToolsWiringFields } from "../src/mcp/facade-auto";

const auth = (a: Record<string, unknown>) =>
  ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", ...a },
  });

/** A JWKS config with neither `audience` nor `resource`: the schema refuses it, so it is made by
 *  parsing a valid one and removing the resource. */
const unbound = (a: Record<string, unknown>) => {
  const cfg = auth({ ...a, resource: "https://r.example/mcp" });
  delete (cfg.auth as { resource?: string }).resource;
  return cfg;
};

const JWKS = {
  keys: [
    { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", kid: "k1" },
  ],
};

afterEach(() => vi.restoreAllMocks());

function stderrOf(fn: () => void): string {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  }) as never);
  fn();
  return lines.join("");
}

const build = (a: Record<string, unknown>, make = auth) => {
  const cfg = make(a);
  return stderrOf(() => buildJwtVerifier(cfg.auth));
};

describe("startup: a JWKS with no effective audience is a deprecation", () => {
  it.each([
    ["an inline jwks", { jwks: JWKS }],
    ["a jwksUri", { jwksUri: "https://as.example/jwks" }],
  ])("%s with neither audience nor resource", (_n, a) => {
    const out = build(a, unbound);
    expect(out).toMatch(/DEPRECATED/);
    expect(out).toMatch(/next minor/);
    expect(out).toMatch(/auth\.audience/);
    expect(out).toMatch(/allowMissingAudience/);
  });

  it.each([
    [
      "an explicit audience",
      { jwksUri: "https://as.example/jwks", audience: "https://r.example/mcp" },
    ],
    [
      "a complete PRM resource",
      {
        jwksUri: "https://as.example/jwks",
        resource: "https://r.example/mcp",
        authorizationServers: ["https://as.example"],
      },
    ],
    ["a resource alone", { jwksUri: "https://as.example/jwks", resource: "https://r.example/mcp" }],
    [
      "the explicit opt-out",
      {
        jwksUri: "https://as.example/jwks",
        resource: "https://r.example/mcp",
        allowMissingAudience: true,
      },
    ],
  ])("is silent with %s", (_n, a) => {
    expect(build(a)).not.toMatch(/DEPRECATED|audience/i);
  });

  it("says nothing without a JWKS key source", () => {
    expect(build({ jwtSecret: "x".repeat(40) })).toBe("");
  });
});

describe("the schema keeps its own requirement and takes the opt-out key", () => {
  it("a JWKS with neither audience nor resource is still refused at config load", () => {
    expect(() => auth({ jwksUri: "https://as.example/jwks" })).toThrow(/audience/);
    expect(() => auth({ jwksUri: "https://as.example/jwks", allowMissingAudience: true })).toThrow(
      /audience/,
    );
  });
  it("allowMissingAudience is a boolean", () => {
    expect(
      auth({ jwks: JWKS, resource: "https://r", allowMissingAudience: true }).auth
        .allowMissingAudience,
    ).toBe(true);
    expect(() =>
      auth({ jwks: JWKS, resource: "https://r", allowMissingAudience: "yes" }),
    ).toThrow();
  });
});

describe("a configured audience is enforced exactly as before", () => {
  it("rejects a token minted for another audience, accepts the right one", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA" }] };
    const v = buildJwtVerifier(auth({ jwks, audience: "https://right.example" }).auth);
    const mint = (aud: string) =>
      new SignJWT({ sub: "a" })
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setAudience(aud)
        .setExpirationTime("5m")
        .sign(privateKey);
    await expect(
      (v as NonNullable<typeof v>).verify(await mint("https://right.example")),
    ).resolves.toMatchObject({ caller: "a" });
    await expect(
      (v as NonNullable<typeof v>).verify(await mint("https://other.example")),
    ).rejects.toMatchObject({
      reason: "audience_mismatch",
    });
  });
});

describe("doctor: auth.jwks-audience", () => {
  const run = (v: Parameters<typeof authAudienceCheck>[0]) =>
    authAudienceCheck(v).run({ serverVersion: "t" });
  it("WARNS with the fix when a JWKS binds no audience", async () => {
    const r = await run({ auth: unbound({ jwks: JWKS }).auth });
    expect(r.status).toBe("warning");
    expect(JSON.stringify(r)).toMatch(/auth\.audience/);
    expect(JSON.stringify(r)).toMatch(/next minor/);
  });
  it("ok with an audience, a resource, a complete PRM, the opt-out, or no JWKS", async () => {
    for (const a of [
      { jwks: JWKS, audience: "https://r" },
      { jwks: JWKS, resource: "https://r" },
      { jwks: JWKS, resource: "https://r", authorizationServers: ["https://as"] },
      { jwks: JWKS, resource: "https://r", allowMissingAudience: true },
      { jwtSecret: "x".repeat(40) },
    ]) {
      expect((await run({ auth: auth(a).auth })).status).toBe("ok");
    }
  });
});

describe("server_health deprecations carry it", () => {
  const wiring = (a: Record<string, unknown>, make = auth) =>
    healthToolsWiringFields(
      { ...make(a), toolFacade: { mode: "triad", profile: "full" } } as never,
      undefined,
      undefined,
      [],
    );
  it("lists the audience deprecation, and not when bound or opted out", () => {
    const dep = wiring({ jwks: JWKS }, unbound).deprecations;
    expect(dep?.some((l) => /auth\.audience/.test(l) && /next minor/.test(l))).toBe(true);
    expect(wiring({ jwks: JWKS, audience: "https://r" }).deprecations).toBeUndefined();
    expect(wiring({ jwks: JWKS, resource: "https://r" }).deprecations).toBeUndefined();
    expect(
      wiring({ jwks: JWKS, resource: "https://r", allowMissingAudience: true }).deprecations,
    ).toBeUndefined();
  });
});
