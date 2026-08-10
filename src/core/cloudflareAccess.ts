import type { IncomingHttpHeaders } from "node:http";
import { jwtVerify, type JWTVerifyGetKey } from "jose";

/** Host-specific Cloudflare Access settings. Never a credential — safe to log the team domain. */
export interface AccessConfig {
  /** e.g. "myteam.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  aud: string;
}

export type AccessReason =
  | "no-assertion"
  | "bad-signature"
  | "expired"
  | "aud-mismatch"
  | "iss-mismatch"
  | "jwks-error"
  | "malformed";

export type AccessResult =
  | { ok: true; email?: string; sub?: string }
  | { ok: false; reason: AccessReason };

export function accessJwksUrl(teamDomain: string): URL {
  return new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
}

export function accessIssuer(teamDomain: string): string {
  return `https://${teamDomain}`;
}

/** Cloudflare stamps this header on every request it forwards through Access. */
export function accessTokenFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  const v = headers["cf-access-jwt-assertion"];
  return Array.isArray(v) ? v[0] : v;
}

function mapError(e: unknown): AccessReason {
  const code = (e as { code?: string })?.code;
  const claim = (e as { claim?: string })?.claim;
  if (code === "ERR_JWT_EXPIRED") return "expired";
  if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") return "bad-signature";
  if (code === "ERR_JWKS_NO_MATCHING_KEY") return "bad-signature";
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    if (claim === "aud") return "aud-mismatch";
    if (claim === "iss") return "iss-mismatch";
    return "malformed";
  }
  if (code === "ERR_JOSE_GENERIC" || code?.startsWith("ERR_JWKS")) return "jwks-error";
  return "malformed";
}

/**
 * Verify a Cloudflare Access assertion. Fails CLOSED: any error (including a JWKS
 * fetch failure) returns { ok: false } rather than throwing, so callers 403.
 * `keySet` is a jose key resolver (remote JWKS in prod, local JWKS in tests).
 */
export async function verifyAccessAssertion(
  token: string | undefined,
  keySet: JWTVerifyGetKey,
  cfg: AccessConfig,
  clockTolerance = 5,
): Promise<AccessResult> {
  if (!token) return { ok: false, reason: "no-assertion" };
  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: accessIssuer(cfg.teamDomain),
      audience: cfg.aud,
      clockTolerance,
    });
    const email = typeof payload.email === "string" ? payload.email : undefined;
    return { ok: true, email, sub: payload.sub };
  } catch (e) {
    return { ok: false, reason: mapError(e) };
  }
}
