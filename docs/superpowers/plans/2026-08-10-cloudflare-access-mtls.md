# Cloudflare Access (mTLS + SSO) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let torlink's web UI run on a public domain behind Cloudflare Tunnel + Access, with the origin itself refusing any request that lacks a valid Cloudflare Access assertion (defense in depth), while at-home casting and in-browser streaming keep working.

**Architecture:** Cloudflare enforces mTLS (owner devices) OR email/SSO (a shared friend) at the edge and stamps every forwarded request with a signed `Cf-Access-Jwt-Assertion` header. torlink verifies that JWT (via `jose`, against Cloudflare's JWKS) in the existing `http.createServer` guard block in `src/web/server.ts`, returning `403` when it is absent/invalid. `/health`, `/stream/*` and `/play/*` are exempt (the last two keep the per-session `?k=` capability so cert-less players/casting still work). Config is host-specific → env vars or `config.json`, never web-writable, surfaced read-only in both front ends.

**Tech Stack:** TypeScript (ESM, Node ≥22), `node:http`, `jose` (new dependency) for JWKS + RS256 verification, `vitest`.

---

## File Structure

- **Create** `src/core/cloudflareAccess.ts` — pure, front-end-agnostic verifier: JWKS URL/issuer derivation, `verifyAccessAssertion`, header extraction, error mapping. No `src/ui`/`src/web` imports (respects the layering lint rule).
- **Create** `src/core/cloudflareAccess.test.ts` — unit tests for the verifier with locally-minted keys and a frozen clock.
- **Modify** `src/config/config.ts` — add `cfAccessTeamDomain?`/`cfAccessAud?` to `Config`; add `resolveCloudflareAccess(config)`.
- **Create** `src/config/cloudflareAccess.resolve.test.ts` — unit tests for the resolver (env-wins precedence, null when incomplete).
- **Modify** `src/web/server.ts` — new options (`cloudflareAccess`, `accessKeySetImpl`), build the key set once, add the guard block, exempt health/stream/play.
- **Modify** `src/web/server.test.ts` — socket-level guard tests using an injected local key set.
- **Modify** `src/daemon/serve.ts` — resolve Access config at startup and pass it to `startWebServer`.
- **Modify** `src/ui/App.tsx` — pass Access config to the in-process `startWebServer`, and compute the read-only status prop.
- **Modify** `src/web/wire.ts` + `src/web/routes.ts` — add `cloudflareAccessEnforced` capability boolean to the sources/accounts payloads.
- **Modify** `src/web/routes.test.ts` — assert the new capability flag; stub the new env vars.
- **Modify** `src/ui/components/Settings.tsx` (+ `SettingsProps` and its wiring in `App.tsx`) — a read-only "Cloudflare Access" status line.
- **Modify** `src/web/static/settingsModel.ts` + `app.ts` — read-only status line in the browser settings dialog.
- **Modify** `README.md` — the end-to-end deployment recipe.

---

## Task 1: Add `jose` and the pure verifier module

**Files:**
- Modify: `package.json` (dependency)
- Create: `src/core/cloudflareAccess.ts`
- Test: `src/core/cloudflareAccess.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `npm install jose`
Expected: `jose` appears under `"dependencies"` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Write the failing test**

Create `src/core/cloudflareAccess.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from "jose";
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
    expect(res.reason).toBe("bad-signature");
  });

  it("reports malformed for garbage input", async () => {
    const { keySet } = await setup();
    const res = await verifyAccessAssertion("not-a-jwt", keySet, { teamDomain: TEAM, aud: AUD });
    expect(res).toEqual({ ok: false, reason: "malformed" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/core/cloudflareAccess.test.ts`
Expected: FAIL — cannot resolve `./cloudflareAccess.js` (module not created yet).

- [ ] **Step 4: Write the module**

Create `src/core/cloudflareAccess.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/core/cloudflareAccess.test.ts`
Expected: PASS (all cases). If `bad-signature` vs `jwks-error` differs on your `jose` version for the unknown-key case, the test already accepts `bad-signature`; adjust `mapError` only if a case fails.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/core/cloudflareAccess.ts src/core/cloudflareAccess.test.ts
git commit -m "feat(core): Cloudflare Access JWT verifier"
```

---

## Task 2: Config fields + resolver

**Files:**
- Modify: `src/config/config.ts` (the `Config` interface ~26-151; add a resolver near the other `resolve*` helpers ~291-334)
- Test: `src/config/cloudflareAccess.resolve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/config/cloudflareAccess.resolve.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, resolveCloudflareAccess } from "./config.js";

const TEAM_ENV = "TORLINK_CF_ACCESS_TEAM_DOMAIN";
const AUD_ENV = "TORLINK_CF_ACCESS_AUD";

describe("resolveCloudflareAccess", () => {
  beforeEach(() => {
    vi.stubEnv(TEAM_ENV, "");
    vi.stubEnv(AUD_ENV, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns null when nothing is configured", () => {
    expect(resolveCloudflareAccess({ ...defaultConfig })).toBeNull();
  });

  it("returns null when only one half is set", () => {
    expect(resolveCloudflareAccess({ ...defaultConfig, cfAccessTeamDomain: "t.cloudflareaccess.com" })).toBeNull();
    expect(resolveCloudflareAccess({ ...defaultConfig, cfAccessAud: "aud" })).toBeNull();
  });

  it("reads both halves from config", () => {
    const res = resolveCloudflareAccess({
      ...defaultConfig,
      cfAccessTeamDomain: "t.cloudflareaccess.com",
      cfAccessAud: "aud-1",
    });
    expect(res).toEqual({ teamDomain: "t.cloudflareaccess.com", aud: "aud-1" });
  });

  it("lets env vars win over config", () => {
    vi.stubEnv(TEAM_ENV, "env.cloudflareaccess.com");
    vi.stubEnv(AUD_ENV, "env-aud");
    const res = resolveCloudflareAccess({
      ...defaultConfig,
      cfAccessTeamDomain: "file.cloudflareaccess.com",
      cfAccessAud: "file-aud",
    });
    expect(res).toEqual({ teamDomain: "env.cloudflareaccess.com", aud: "env-aud" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/config/cloudflareAccess.resolve.test.ts`
Expected: FAIL — `resolveCloudflareAccess` is not exported.

- [ ] **Step 3: Add the config fields**

In `src/config/config.ts`, add to the `Config` interface (after `castAdvertiseHost?: string;`, before the closing brace ~line 150):

```ts
  /** Cloudflare Access team domain, e.g. "myteam.cloudflareaccess.com". Host-specific; TUI/env only. */
  cfAccessTeamDomain?: string;
  /** Cloudflare Access application Audience (AUD) tag. Host-specific; TUI/env only. */
  cfAccessAud?: string;
```

- [ ] **Step 4: Add the resolver**

In `src/config/config.ts`, near the other `resolve*` helpers (after `resolveCastAdvertiseHost`), add:

```ts
const CF_ACCESS_TEAM_DOMAIN_ENV = "TORLINK_CF_ACCESS_TEAM_DOMAIN";
const CF_ACCESS_AUD_ENV = "TORLINK_CF_ACCESS_AUD";

/**
 * Cloudflare Access enforcement config. env wins over the persisted value, both
 * trimmed. Returns null unless BOTH halves are present — a half-configured gate
 * would fail every request, so treat it as "off".
 */
export function resolveCloudflareAccess(
  config: Config,
): { teamDomain: string; aud: string } | null {
  const teamDomain = (process.env[CF_ACCESS_TEAM_DOMAIN_ENV]?.trim() || config.cfAccessTeamDomain?.trim()) ?? "";
  const aud = (process.env[CF_ACCESS_AUD_ENV]?.trim() || config.cfAccessAud?.trim()) ?? "";
  if (!teamDomain || !aud) return null;
  return { teamDomain, aud };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/config/cloudflareAccess.resolve.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the allowlist is untouched**

Confirm you did **not** add `cfAccess*` to `RawSettingsPatch`/`sanitiseSettingsPatch` (`src/config/config.ts` ~208-278). These stay TUI/env-only per repo rules.
Run: `npx vitest run src/config` and `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config/config.ts src/config/cloudflareAccess.resolve.test.ts
git commit -m "feat(config): resolveCloudflareAccess + Config fields (TUI/env-only)"
```

---

## Task 3: The origin guard in `startWebServer`

**Files:**
- Modify: `src/web/server.ts` (`WebServerOptions` ~55-109; `startWebServer` setup ~228-326; the `http.createServer` guard block ~454-486)
- Test: `src/web/server.test.ts`

- [ ] **Step 1: Write the failing socket test**

Add to `src/web/server.test.ts` (mirror the file's existing socket harness — `startWebServer` on `port: 0`, then `fetch` against `handle.port`). If the file lacks jose helpers, add these imports at the top and this `describe` block:

```ts
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from "jose";

describe("startWebServer — Cloudflare Access guard", () => {
  const TEAM = "myteam.cloudflareaccess.com";
  const AUD = "aud-tag-123";

  async function serverWithAccess() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "k1";
    jwk.alg = "RS256";
    const jwks: JSONWebKeySet = { keys: [jwk] };
    const accessKeySetImpl = createLocalJWKSet(jwks);
    const handle = await startWebServer(runtime(), {
      port: 0,
      host: "127.0.0.1",
      cloudflareAccess: { teamDomain: TEAM, aud: AUD },
      accessKeySetImpl,
    });
    const mint = (claims: Record<string, unknown>, exp?: number) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(`https://${TEAM}`)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime(exp ?? "1h")
        .sign(privateKey);
    return { handle, mint };
  }

  it("403s an api request with no assertion", async () => {
    const { handle } = await serverWithAccess();
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/status`);
    expect(res.status).toBe(403);
    await handle.close();
  });

  it("allows an api request carrying a valid assertion", async () => {
    const { handle, mint } = await serverWithAccess();
    const token = await mint({ email: "owner@example.com" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/status`, {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(res.status).toBe(200);
    await handle.close();
  });

  it("exempts /health from the assertion check", async () => {
    const { handle } = await serverWithAccess();
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    await handle.close();
  });
});
```

> Note: this test uses **real timers** (jose validates against the real clock and the tokens are freshly minted with `"1h"` expiry), so do NOT wrap it in `vi.useFakeTimers()`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/web/server.test.ts -t "Cloudflare Access guard"`
Expected: FAIL — `cloudflareAccess`/`accessKeySetImpl` are not valid options; no guard exists (requests return 200/404, not 403).

- [ ] **Step 3: Extend `WebServerOptions`**

In `src/web/server.ts`, add to the `WebServerOptions` interface (~55-109):

```ts
  /** When set, verify Cloudflare Access assertions and 403 requests without one. */
  cloudflareAccess?: import("../core/cloudflareAccess.js").AccessConfig;
  /** Test seam: overrides the JWKS resolver (default: remote JWKS from the team domain). */
  accessKeySetImpl?: import("jose").JWTVerifyGetKey;
```

- [ ] **Step 4: Build the verifier once, add the guard**

In `src/web/server.ts`, add imports near the top:

```ts
import { createRemoteJWKSet } from "jose";
import { accessJwksUrl, accessTokenFromHeaders, verifyAccessAssertion } from "../core/cloudflareAccess.js";
```

In `startWebServer`, after `const token = ...` (~line 234), add:

```ts
  const accessCfg = options.cloudflareAccess ?? null;
  const accessKeySet = accessCfg
    ? (options.accessKeySetImpl ?? createRemoteJWKSet(accessJwksUrl(accessCfg.teamDomain)))
    : null;
  if (accessCfg) log(`cloudflare access: enforcing (team ${accessCfg.teamDomain})`);
```

In the `http.createServer` handler, immediately AFTER the CSRF guard block (after the `if (method !== "GET" && ... isCrossSiteHttpRequest ...)` block, ~line 486) and BEFORE the `/api/events` handler, add:

```ts
      // Cloudflare Access: the origin refuses anything that did not arrive through
      // Access, so it is safe even if this port is ever reachable directly. Health
      // and the media routes are exempt — the latter carry the per-session ?k=
      // capability instead, because <video>/VLC/Chromecast can't present a cert.
      if (accessCfg) {
        const exempt =
          urlPath === "/health" ||
          isStreamPath(urlPath) ||
          urlPath === "/play" ||
          urlPath.startsWith("/play/");
        if (!exempt) {
          const assertion = accessTokenFromHeaders(req.headers);
          const verdict = await verifyAccessAssertion(assertion, accessKeySet!, accessCfg);
          if (!verdict.ok) {
            writeJson(res, 403, { error: "forbidden" });
            log(`${method} ${urlPath} -> 403 (access: ${verdict.reason})`);
            return;
          }
        }
      }
```

> `isStreamPath` is already imported in this file (used by the `/stream` route). If lint flags an unused import elsewhere, leave existing imports as-is.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/web/server.test.ts -t "Cloudflare Access guard"`
Expected: PASS (403 without assertion, 200 with a valid one, 200 for `/health`).

- [ ] **Step 6: Run the full web suite + typecheck**

Run: `npx vitest run src/web && npm run typecheck`
Expected: PASS — existing tests (Access-off by default) are unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/web/server.ts src/web/server.test.ts
git commit -m "feat(web): verify Cloudflare Access assertion at the origin"
```

---

## Task 4: Thread Access config through both server hosts

**Files:**
- Modify: `src/daemon/serve.ts` (option assembly ~385-393)
- Modify: `src/ui/App.tsx` (in-process `startWebServer` call ~671)

- [ ] **Step 1: Wire `serve --web`**

In `src/daemon/serve.ts`, ensure `loadConfig` and `resolveCloudflareAccess` are imported from `../config/config.js` (add to the existing import if missing). Before the `web = await startWebServer(...)` call (~385), add:

```ts
    const startupConfig = await loadConfig();
    const cloudflareAccess = resolveCloudflareAccess(startupConfig);
```

and extend the options object passed to `startWebServer`:

```ts
      web = await startWebServer(runtime, {
        port,
        host,
        ...(token ? { token } : {}),
        ...(cloudflareAccess ? { cloudflareAccess } : {}),
        log,
      });
```

- [ ] **Step 2: Wire the in-process TUI host**

In `src/ui/App.tsx`, add `resolveCloudflareAccess` to the existing `../config/config.js` import. At the `startWebServer(...)` call (~671), add the option, resolving from the `config` already in scope:

```ts
      ...(resolveCloudflareAccess(config) ? { cloudflareAccess: resolveCloudflareAccess(config)! } : {}),
```

(Place it alongside the existing `port`/`host`/`token`/`log` options in that call.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/serve.ts src/ui/App.tsx
git commit -m "feat: pass Cloudflare Access config to both web-server hosts"
```

---

## Task 5: Read-only "Access enforced" status in both front ends

This is the capability-flag surface — a boolean, never a credential — mirroring `debridConfigured`.

**Files:**
- Modify: `src/web/wire.ts` (the two capability payload types carrying `debridConfigured`, ~465 and ~584)
- Modify: `src/web/routes.ts` (the two payload assemblies, ~788 and ~1285)
- Test: `src/web/routes.test.ts`
- Modify: `src/ui/components/Settings.tsx` (+ `SettingsProps`) and its wiring in `src/ui/App.tsx`
- Modify: `src/web/static/settingsModel.ts` and `src/web/static/app.ts`

- [ ] **Step 1: Write the failing router test**

In `src/web/routes.test.ts`, add to the `beforeEach` env stubs (alongside `REALDEBRID_API_TOKEN`/`TORBOX_API_TOKEN`):

```ts
    vi.stubEnv("TORLINK_CF_ACCESS_TEAM_DOMAIN", "");
    vi.stubEnv("TORLINK_CF_ACCESS_AUD", "");
```

Then add a test in the `/api/sources` describe block:

```ts
  it("reports cloudflareAccessEnforced=false when unconfigured", async () => {
    const res = await handleWebApi(deps({ token: "secret" }), "GET", "/api/sources", new URLSearchParams(), AUTH, "");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ cloudflareAccessEnforced: false });
  });

  it("reports cloudflareAccessEnforced=true when both halves are configured", async () => {
    const loadConfigImpl = async () => ({
      ...defaultConfig,
      downloadDir: "/tmp/dl",
      cfAccessTeamDomain: "t.cloudflareaccess.com",
      cfAccessAud: "aud-1",
    });
    const res = await handleWebApi(
      deps({ token: "secret", loadConfigImpl }),
      "GET",
      "/api/sources",
      new URLSearchParams(),
      AUTH,
      "",
    );
    expect(res.json).toMatchObject({ cloudflareAccessEnforced: true });
  });
```

(Import `defaultConfig` in the test if not already imported.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/web/routes.test.ts -t "cloudflareAccessEnforced"`
Expected: FAIL — field is `undefined`.

- [ ] **Step 3: Add the wire type**

In `src/web/wire.ts`, add to BOTH capability blocks that already declare `debridConfigured: boolean;` (~465 and ~584):

```ts
  /** Whether the origin is enforcing Cloudflare Access. A capability flag, never a credential. */
  cloudflareAccessEnforced: boolean;
```

- [ ] **Step 4: Populate both payloads**

In `src/web/routes.ts`, import `resolveCloudflareAccess` from `../config/config.js` (extend the existing import). In BOTH payload assemblies (~788 and ~1285), add beside `debridConfigured`:

```ts
    cloudflareAccessEnforced: resolveCloudflareAccess(config) !== null,
```

- [ ] **Step 5: Run the router test**

Run: `npx vitest run src/web/routes.test.ts -t "cloudflareAccessEnforced"`
Expected: PASS.

- [ ] **Step 6: Browser read-only line**

In `src/web/static/settingsModel.ts`, wherever the read-only capability section is built (it already consumes `debridConfigured`/`omdbConfigured` from the sources payload — mirror that exact pattern), derive a display string from the new flag, e.g.:

```ts
  cloudflareAccess: sources.cloudflareAccessEnforced ? "Enforced" : "Not configured",
```

In `src/web/static/app.ts`, render it as a read-only row in the settings dialog's account/status area, using `createElement` + `textContent` only (NO `innerHTML`), matching how the OMDb/debrid status rows are created.

- [ ] **Step 7: TUI read-only line**

In `src/ui/components/Settings.tsx`, add `cfAccessEnforced: boolean` to `SettingsProps` (~24-65). Add a status row modelled on the OMDb row (~274-290), with no actions:

```ts
{
  tag: "CFACC",
  color: "#f38020", // Cloudflare orange
  label: "Cloudflare Access",
  sub: "edge auth · mTLS / SSO",
  kind: "account" as const,
  present: props.cfAccessEnforced,
  ok: props.cfAccessEnforced,
  status: "Enforced",
  emptyStatus: "Not configured",
  primary: { key: "", verb: "", run: () => {} },
  secondary: [],
},
```

> If the row renderer requires a non-empty `primary`, instead reuse the `"setting"` kind (renders `ICON.dot + status` with no action): push `{ ...as a setting row..., status: props.cfAccessEnforced ? "Cloudflare Access: enforced" : "Cloudflare Access: not configured" }`. Pick whichever the existing `Row` union renders cleanly without an action affordance.

In `src/ui/App.tsx`, where `<Settings ... />` props are built (near the `debridConfigured` prop ~2612), add:

```ts
        cfAccessEnforced: resolveCloudflareAccess(config) !== null,
```

- [ ] **Step 8: Keep the preview/test stores compiling**

`cfAccessEnforced` is a `Settings` prop derived from `config`, NOT a `Store` field, so `makeStore`/`makeTestStore` need no change. Confirm:
Run: `npm run typecheck && npm run previews`
Expected: PASS. (If typecheck reports the prop missing anywhere `Settings` is constructed — e.g. a preview harness — add `cfAccessEnforced: false` there.)

- [ ] **Step 9: Full suite + lint + build**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS (the one known pre-existing `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx` is fine; `npm run build` also proves `src/web/static` imports no `node:*`).

- [ ] **Step 10: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts \
  src/ui/components/Settings.tsx src/ui/App.tsx \
  src/web/static/settingsModel.ts src/web/static/app.ts
git commit -m "feat: surface Cloudflare Access status read-only in both front ends"
```

---

## Task 6: Deployment documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the deployment section**

Add a "Exposing torlink publicly with Cloudflare Access" section to `README.md` covering, in order:

1. Put the domain on Cloudflare (nameservers).
2. Create a Cloudflare Tunnel; ingress rule `torlink.example.com → http://localhost:9161` (the `serve --web` port); run `cloudflared` on the home box next to torlink and reccd. No router ports are opened.
3. Generate an mTLS root CA; upload the CA under Cloudflare mTLS; issue a client cert per device and install it (laptop/phone easy; note the Android-TV/Shield caveat).
4. Create one Access application on the hostname with policy **`(valid client certificate) OR (email ∈ allowlist)`** — cert = silent for your devices, email/SSO = install-nothing for a shared friend.
5. Set torlink's two values on the home box, via env on the service or `config.json`:
   - `TORLINK_CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com`
   - `TORLINK_CF_ACCESS_AUD=<the Access application's AUD tag>`
   Restart `serve --web`; the log prints `cloudflare access: enforcing (team …)`.
6. Caveats to state plainly: single-tenant (a shared friend uses your instance, quota, library and history); the `OR email` arm makes the login page visible to strangers (still locked); casting to the Shield stays on the LAN and is unaffected; browsing the UI *on* the Shield with mTLS is not supported; for remote viewing prefer direct debrid streaming (`proxyDebridStreams` off) so video doesn't relay through your home uplink and Cloudflare.

- [ ] **Step 2: Verify the web UI limitations list is still accurate**

Re-read the web-UI limitations/notes list in `README.md`; adjust if it claims anything now untrue about auth/exposure.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Cloudflare Access deployment guide"
```

---

## Self-Review (completed while writing)

**Spec coverage:**
- Silent owner auth / friend SSO / strangers blocked at edge → Cloudflare setup (Task 6) + two-arm policy.
- Origin defense-in-depth (verify `Cf-Access-Jwt-Assertion`) → Tasks 1 + 3.
- Fail-closed on JWKS failure → `verifyAccessAssertion` returns `{ok:false}` on any throw (Task 1); guard 403s.
- Path exemptions (`/health`, `/stream`, `/play`) → Task 3 guard.
- Host-specific config, NOT web-writable → Task 2 (resolver, fields) + Step 6 (allowlist untouched).
- Both server hosts (`serve --web` and in-process TUI) → Task 4.
- Read-only status in both front ends → Task 5.
- Direct-stream recommendation, single-tenant + visibility caveats, Shield notes → Task 6.

**Placeholder scan:** No TBD/TODO; every code step carries full code. The one conditional ("if the row renderer requires a non-empty primary…") gives a concrete fallback, not a deferral.

**Type consistency:** `AccessConfig`/`AccessResult`/`verifyAccessAssertion`/`accessJwksUrl`/`accessIssuer`/`accessTokenFromHeaders` are defined in Task 1 and used unchanged in Task 3. `resolveCloudflareAccess` (Task 2) returns `{teamDomain, aud} | null`, matching `WebServerOptions.cloudflareAccess?: AccessConfig` (Task 3) and the call sites (Task 4). `cloudflareAccessEnforced` (wire) and `cfAccessEnforced` (TUI prop) are intentionally distinct names for the wire field vs the React prop — both consistently used within their layers.

**Out of scope (stated in the spec):** multi-user accounts; app-level mTLS; bundling `cloudflared`; verifying Access on the bare `createApiServer` (non-`--web`) path (loopback-only, not the public deployment) — add later if that server is ever exposed.
