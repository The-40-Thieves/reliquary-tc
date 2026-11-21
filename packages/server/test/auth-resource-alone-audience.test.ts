// `auth.resource` WITHOUT `auth.authorizationServers` on a JWKS-backed jwt server.
//
// The config schema counts `resource` alone as satisfying "bind an audience". The verifier now
// agrees: with a JWKS key source and no explicit `auth.audience`, `resource` is the audience, so a
// token the same issuer minted for another service is refused. `auth.allowMissingAudience: true`
// keeps the old behaviour, and a server with only a shared secret is not affected.
import { ServerConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { buildJwtVerifier } from "../src/auth/jwt-boot";
import { effectiveAudience, jwksWithoutAudience } from "../src/auth/protected-resource";

const RESOURCE = "https://r.example/mcp";
const parse = (a: Record<string, unknown>) =>
  ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", ...a },
  });

async function keyed() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA" }] };
  const mint = (aud?: string) => {
    const jwt = new SignJWT({ sub: "a" }).setProtectedHeader({ alg: "EdDSA", kid: "k1" });
    if (aud !== undefined) jwt.setAudience(aud);
    return jwt.setExpirationTime("5m").sign(privateKey);
  };
  return { jwks, mint };
}
const verifier = (a: Record<string, unknown>) => {
  const v = buildJwtVerifier(parse(a).auth);
  if (!v) throw new Error("no verifier built");
  return v;
};

describe("auth.resource alone (no authorizationServers) with a JWKS", () => {
  it.each([
    ["an inline jwks", { jwks: { keys: [{ kty: "OKP", crv: "Ed25519", x: "AAAA", kid: "k" }] } }],
    ["a jwksUri", { jwksUri: "https://as.example/jwks" }],
  ])("the resource is the audience with %s", (_n, source) => {
    const { auth } = parse({ ...source, resource: RESOURCE });
    expect(effectiveAudience(auth)).toBe(RESOURCE);
    expect(jwksWithoutAudience(auth)).toBe(false);
  });

  it("a token minted for another audience is refused", async () => {
    const { jwks, mint } = await keyed();
    await expect(
      verifier({ jwks, resource: RESOURCE }).verify(await mint("https://other.example")),
    ).rejects.toMatchObject({ reason: "audience_mismatch" });
  });

  it("a token with no audience is refused", async () => {
    const { jwks, mint } = await keyed();
    await expect(verifier({ jwks, resource: RESOURCE }).verify(await mint())).rejects.toThrow();
  });

  it("a token minted for the resource is accepted", async () => {
    const { jwks, mint } = await keyed();
    await expect(
      verifier({ jwks, resource: RESOURCE }).verify(await mint(RESOURCE)),
    ).resolves.toMatchObject({ caller: "a" });
  });

  it("an explicit auth.audience still wins over the resource", async () => {
    const { jwks, mint } = await keyed();
    const v = verifier({ jwks, resource: RESOURCE, audience: "api://vault" });
    await expect(v.verify(await mint("api://vault"))).resolves.toMatchObject({ caller: "a" });
    await expect(v.verify(await mint(RESOURCE))).rejects.toMatchObject({
      reason: "audience_mismatch",
    });
  });

  it("allowMissingAudience keeps the old behaviour: nothing is bound", async () => {
    const { jwks, mint } = await keyed();
    const a = { jwks, resource: RESOURCE, allowMissingAudience: true };
    expect(effectiveAudience(parse(a).auth)).toBeUndefined();
    await expect(verifier(a).verify(await mint("https://other.example"))).resolves.toMatchObject({
      caller: "a",
    });
  });
});

describe("a shared-secret server is not affected", () => {
  it("binds no audience from the resource alone", () => {
    const { auth } = parse({ jwtSecret: "x".repeat(40), resource: RESOURCE });
    expect(effectiveAudience(auth)).toBeUndefined();
  });

  it("with authorizationServers too, the resource is the audience as before", () => {
    const { auth } = parse({
      jwtSecret: "x".repeat(40),
      resource: RESOURCE,
      authorizationServers: ["https://as.example"],
    });
    expect(effectiveAudience(auth)).toBe(RESOURCE);
  });
});
