import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { verifyAccessAssertion, accessIssuer, accessJwksUrl } from "./cloudflareAccess.js";

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";

// A frozen clock so token exp/iat are deterministic.
const NOW = 1_760_000_000_000; // fixed ms

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "k1";
  jwk.alg = "RS256";
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const keySet = createLocalJWKSet(jwks);
  return { privateKey, keySet };
}

async function mint(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  opts: { iss?: string; aud?: string; exp?: number; kid?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setIssuer(opts.iss ?? accessIssuer(TEAM))
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(opts.exp ?? Math.floor(NOW / 1000) + 3600)
    .sign(privateKey);
}

describe("cloudflareAccess helpers", () => {
  it("derives the JWKS url and issuer", () => {
    expect(accessJwksUrl(TEAM).toString()).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    expect(accessIssuer(TEAM)).toBe(`https://${TEAM}`);
  });
});

describe("verifyAccessAssertion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("accepts a valid assertion and returns the email", async () => {
    const { privateKey, keySet } = await setup();
    const token = await mint(privateKey, { email: "owner@example.com" });
    const res = await verifyAccessAssertion(token, keySet, { teamDomain: TEAM, aud: AUD });
    expect(res).toMatchObject({ ok: true, email: "owner@example.com" });
  });

  it("reports no-assertion for a missing token", async () => {
    const { keySet } = await setup();
    const res = await verifyAccessAssertion(undefined, keySet, { teamDomain: TEAM, aud: AUD });
    expect(res).toEqual({ ok: false, reason: "no-assertion" });
  });

  it("rejects an expired assertion", async () => {
    const { privateKey, keySet } = await setup();
    const token = await mint(privateKey, { email: "x@e.com" }, { exp: Math.floor(NOW / 1000) - 10 });
    const res = await verifyAccessAssertion(token, keySet, { teamDomain: TEAM, aud: AUD });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a wrong audience", async () => {
    const { privateKey, keySet } = await setup();
    const token = await mint(privateKey, { email: "x@e.com" }, { aud: "other-aud" });
    const res = await verifyAccessAssertion(token, keySet, { teamDomain: TEAM, aud: AUD });
    expect(res).toEqual({ ok: false, reason: "aud-mismatch" });
  });

  it("rejects a wrong issuer", async () => {
    const { privateKey, keySet } = await setup();
    const token = await mint(privateKey, { email: "x@e.com" }, { iss: "https://evil.cloudflareaccess.com" });
    const res = await verifyAccessAssertion(token, keySet, { teamDomain: TEAM, aud: AUD });
    expect(res).toEqual({ ok: false, reason: "iss-mismatch" });
  });

  it("rejects a signature from an unknown key", async () => {
    const { keySet } = await setup();
    const stranger = await generateKeyPair("RS256");
    const token = await mint(stranger.privateKey, { email: "x@e.com" }, { kid: "k1" });
    const res = await verifyAccessAssertion(token, keySet, { teamDomain: TEAM, aud: AUD });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("bad-signature");
  });

  it("reports malformed for garbage input", async () => {
    const { keySet } = await setup();
    const res = await verifyAccessAssertion("not-a-jwt", keySet, { teamDomain: TEAM, aud: AUD });
    expect(res).toEqual({ ok: false, reason: "malformed" });
  });

  it("fails closed when the key resolver throws a JWKS error", async () => {
    // A resolver that jose calls during key resolution and that throws a
    // jose-style JWKS error, so mapError's code?.startsWith("ERR_JWKS") branch runs.
    const throwingKeySet = (() => {
      const err = new Error("jwks unreachable") as Error & { code?: string };
      err.code = "ERR_JWKS_TIMEOUT";
      throw err;
    }) as unknown as JWTVerifyGetKey;
    // A valid, well-formed RS256 token so jose gets past structural checks and
    // actually invokes the resolver to look up a key.
    const { privateKey } = await setup();
    const token = await mint(privateKey, { email: "x@e.com" });
    const res = await verifyAccessAssertion(token, throwingKeySet, { teamDomain: TEAM, aud: AUD });
    expect(res).toEqual({ ok: false, reason: "jwks-error" });
  });
});
