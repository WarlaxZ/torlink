# Cloudflare Access (mTLS + SSO) for a public torlink

**Date:** 2026-08-10
**Status:** Design — approved shape, pending spec review

## Problem

The owner wants to run torlink's web UI on a public domain
(`torlink.yourdomain.com`) fronted by Cloudflare Tunnel — the same way
`~/projects/reccd` is exposed — but keep it closed to the public:

- Their own devices (laptop, phone) should be authenticated **silently**, with no
  login page and no per-visit action.
- Strangers should be **stopped before they see the app** at all.
- They want to reach it **remotely** (work, holiday) and stream through a debrid
  provider (TorBox), primarily by watching in the browser's `<video>` player.
- They want to **share with a friend from day one**, accepting whatever complexity
  that adds.
- Casting to an Nvidia Shield (Android TV) at home should keep working.

torlink today is plain `node:http` with an optional shared bearer token, a
loopback-`Host` DNS-rebinding guard, and a cross-site/CSRF guard
(`src/web/server.ts`, `src/daemon/auth.ts`). It binds `127.0.0.1` by default and
refuses a non-loopback bind without a token. There is no TLS or client-certificate
machinery, and there won't be — TLS is terminated at Cloudflare's edge.

## Goals

- Silent auth for the owner's own devices (client certificate / mTLS).
- Easy, install-nothing auth for a shared friend (Cloudflare Access email/SSO).
- Strangers blocked at the Cloudflare edge, never reaching the origin.
- **Defense in depth at the origin:** torlink itself refuses any request that did
  not arrive through Cloudflare Access, so the app is safe even if the origin is
  ever directly reachable — not merely safe because of how the network is wired.
- In-browser remote playback (including debrid streams) keeps working.
- At-home casting to the Shield keeps working.

## Non-goals

- **Multi-user / per-account isolation.** torlink is single-tenant: one
  `config.json`, one debrid token, one library, one watch history. A shared friend
  uses *the owner's* instance and quota and sees the owner's library. Real accounts
  are a much larger project, explicitly out of scope.
- **App-level mTLS** (torlink terminating TLS and demanding a client cert). It is
  incompatible with Cloudflare terminating TLS at the edge and breaks cert-less
  players; rejected during brainstorming.
- **Shipping the Cloudflare setup as code.** Domain, Tunnel, Access policy, CA and
  client certs are one-time ops performed in the Cloudflare dashboard and on the
  owner's devices. They are documented here and in the README, not automated.
- **Bundling `cloudflared`** into torlink or its container.

## Architecture

```
  You / phone / laptop / friend
            │  HTTPS to torlink.yourdomain.com
            ▼
   ┌──────────────────────────────┐
   │  Cloudflare edge (Access)     │  policy: (valid client cert) OR (email ∈ allowlist)
   │                               │  strangers stopped HERE; never reach the origin
   │  stamps Cf-Access-Jwt-Assertion on every forwarded request
   └───────────────┬──────────────┘
                   │  Cloudflare Tunnel — outbound from the house; no inbound ports
                   ▼
   ┌──────────────────────────────┐
   │  Home box                     │
   │   cloudflared ─► torlink @ 127.0.0.1:9161 (plain HTTP)                 │
   │                   └─ verifies Cf-Access-Jwt-Assertion; 403 if absent   │
   │   reccd (already here)                                                 │
   └───────────────┬──────────────┘
                   │  LAN only
                   ▼
             Nvidia Shield  ← casting stays on the LAN; Cloudflare not involved
```

- The tunnel dials **out** from the house, so no router ports are opened.
- torlink binds **loopback**, reachable only via `cloudflared` on the same box.
- Cloudflare Access is the front gate; the origin JWT check is the backstop.

### Two-arm Access policy is what enables day-one sharing

A single Access application on the hostname with a policy of
**`(valid client certificate) OR (email is in {owner, friend})`**:

- The owner's devices carry a client cert and authenticate **silently**.
- The friend supplies an email one-time code (or SSO) — **nothing to install**,
  added/removed in the dashboard in seconds.

**Accepted trade-off:** the `OR email` arm means a stranger now sees a Cloudflare
*login page* rather than a blank wall. It is still locked — they cannot get in —
but the endpoint is no longer invisible. This is the unavoidable cost of
install-nothing sharing and was accepted during brainstorming.

## torlink-side changes (the buildable part)

### 1. Access JWT verification module

A new front-end-agnostic module (e.g. `src/core/cloudflareAccess.ts`, or
`src/util/` if it grows no core dependencies) that, given the request headers and
configured `teamDomain` + `audTag`, decides whether a request carries a valid
Cloudflare Access assertion:

- Read `Cf-Access-Jwt-Assertion` (Cloudflare also mirrors it as a `CF_Authorization`
  cookie; the header is authoritative and is what we check).
- Verify the JWT against Cloudflare's JWKS at
  `https://<teamDomain>/cdn-cgi/access/certs`, checking signature, `exp`, and that
  `aud` contains the configured application audience (AUD) tag.
- **Cache the JWKS** in memory with a bounded TTL and refetch on key-ID miss; never
  fetch per request.
- Pure, testable decision surface: `verifyAccessJwt(token, {teamDomain, audTag, now, jwks})
  → {ok: true, email, sub} | {ok: false, reason}`. Network fetch of JWKS is a
  separate, injectable function so the verifier is unit-tested with fixed keys and a
  frozen clock (matches the repo's fake-timers testing preference).

Fail soft on configuration, hard on verification: if Access verification is **not
configured**, behaviour is unchanged (feature off). If it **is** configured, a
missing/invalid assertion on a protected path is a hard `403`.

### 2. Wiring into the request guard

The check belongs in the `http.createServer` request handler in
`src/web/server.ts` (~line 454), alongside the existing loopback-`Host` and
cross-site guards — the router (`src/web/routes.ts`) never sees request headers, by
design. Order: after the `Host` and CSRF guards, before routing.

When Access verification is enabled:

- Requests to protected paths without a valid assertion → `403` (logged with reason,
  never logging the token).
- The verified identity (`email`) is made available for optional read-only display
  (see §4); it is **not** used for authorization decisions beyond
  present-and-valid, since torlink is single-tenant.

### 3. Path exemptions (stream / play / health)

Exempt from the JWT check:

- `/health` — already unauthenticated by design.
- `/stream/*` and `/play/*` — guarded by the existing per-session `?k=` capability,
  not the bearer token. Exempting them means a **cert-less external player**
  (VLC/Kodi) or a **remote cast target** fetching over the public domain still works,
  protected by the unguessable capability. The owner's *primary* flows do not depend
  on this exemption — in-browser `<video>` playback rides the browser's own cert, and
  at-home casting to the Shield stays on the LAN — but the exemption is cheap and
  keeps the external-player door open, so it is built in from the start.

Everything else (`/`, static assets, `/api/*`, the SSE routes `/api/events` and
`/api/search`) is protected. The SSE routes already accept `?k=` for `EventSource`;
Access verification sits in front and is satisfied by the browser's cert on the same
origin.

### 4. Configuration (host-specific → TUI-only, per repo rules)

Cloudflare Access `teamDomain` and `audTag` are host-specific deployment config, so
per the repo's "secrets and host-specific config are TUI-only" rule they are **not**
browser-writable via `/api/settings`:

- New optional fields on the serve/runtime config (env + flags + TUI), e.g.
  `TORLINK_CF_ACCESS_TEAM_DOMAIN` / `TORLINK_CF_ACCESS_AUD` (exact names decided in
  the plan), surfaced read-only in the TUI Settings/Accounts area as an account-status
  line ("Cloudflare Access: enforced" / "not configured").
- The browser's settings dialog does **not** gain a write control for these. If any
  status is surfaced to the browser it is read-only capability, consistent with how
  `debridConfigured` etc. are reported by `/api/sources`.

This keeps the layering rule intact (`src/web` must not import `src/ui`; shared logic
lives in `src/core`/`src/util`).

### 5. Streaming mode note (config, not new code)

For remote viewing, **direct** debrid streaming (browser fetches the TorBox CDN URL)
is preferred over relaying through the home box, to avoid consuming home upload
bandwidth and pushing heavy video through Cloudflare. torlink already exposes this
choice via `proxyDebridStreams` (`src/config/config.ts`). No new code; the deployment
docs call out the recommendation.

## Data flow — remote in-browser stream (the primary remote case)

1. Laptop/phone browser (client cert installed) requests
   `https://torlink.yourdomain.com/` → Cloudflare validates cert → forwards with
   `Cf-Access-Jwt-Assertion`.
2. torlink verifies the assertion → serves the app.
3. User picks a title; `/api/*` calls carry the cert (same origin) → verified → OK.
4. Playback: with `proxyDebridStreams` **off**, the browser plays the TorBox CDN URL
   directly (no Cloudflare, no cert needed for that leg). With it **on**, the browser
   fetches `/stream/*?k=...`; that path is exempt from the JWT check and guarded by
   `?k=`, and the browser presents the cert anyway.

## Data flow — at-home cast to the Shield (unchanged)

torlink discovers the Shield via mDNS on the home LAN and hands it a **LAN** stream
URL (`castAdvertiseHost`, `src/web/server.ts` ~313). The Shield fetches over the LAN;
Cloudflare and Access are not involved. No change required.

## Error handling

- **Access not configured:** feature off; behaviour identical to today. This is the
  default and the path all existing tests exercise.
- **Assertion missing/invalid on a protected path:** `403 {"error":"forbidden"}`,
  logged with a coarse reason (`no-assertion`, `bad-signature`, `expired`, `aud-mismatch`),
  never logging the token value.
- **JWKS fetch failure:** the verifier fails **closed** for protected paths (a `403`
  with a distinct reason) rather than failing open; the cached JWKS covers transient
  outages, and refusing is the safe default for a security gate. Logged so the
  operator can see it.
- **Clock skew:** small `exp`/`iat` leeway (a few seconds), consistent with standard
  JWT validation.

## Testing

- **Unit (pure verifier):** valid token; expired; wrong `aud`; bad signature; wrong
  key ID with successful refetch; malformed token; missing header. Fixed test keys,
  frozen clock via fake timers (repo preference). JWKS fetch injected.
- **Guard wiring:** requests to a protected path with/without a valid assertion return
  `200`/`403`; `/health`, `/stream/*`, `/play/*` bypass the check; feature-off leaves
  all current behaviour untouched. Reuse the existing web route test harness
  (`src/web/routes.test.ts` patterns), which currently asserts the bearer-token gate.
- **No secret leakage:** assert the token/assertion never appears in logs or in any
  response body (mirrors the existing `not.toContain` stream-XSS checks — and, per
  CLAUDE.md, any such negative assertion must name a string actually put in play).

## Documentation

- `README.md`: a new "Exposing torlink publicly with Cloudflare Access" section — the
  end-to-end recipe (domain → Tunnel ingress → mTLS CA → client cert install per
  device → two-arm Access policy → the two torlink config values), the single-tenant
  sharing caveat, the visibility trade-off, the Android-TV/Shield note (cast at home
  over LAN; browsing the UI on the TV itself is out of scope for mTLS), and the
  `proxyDebridStreams` recommendation for remote viewing.
- Verify the web UI's own limitations list stays accurate.

## Complexity summary

| Piece | Where | Effort |
| --- | --- | --- |
| Domain + Tunnel + Access policy + CA + client certs | Cloudflare dashboard + devices | One-time ops, no code — the bulk of the "work" |
| Access JWT verifier | `src/core` (or `src/util`) + unit tests | One focused, well-tested module |
| Guard wiring + path exemptions | `src/web/server.ts` request handler | A few lines beside existing guards |
| Serve-time config (team domain + AUD) | env + flags + TUI status line | Small; TUI-only per repo rules |
| Deployment docs | `README.md` | Small |
| Friend sharing | one Cloudflare policy line | Trivial once the above exists |

The code footprint is modest and concentrated in one new verifier plus a few lines in
the existing server guard. The real effort is the one-time Cloudflare setup, which is
ops and reusable across reccd and anything else the owner hosts.

## Open questions for the plan

- Exact env/flag/config field names and where the TUI status line lives.
- Whether the browser settings dialog shows a read-only "Access enforced" indicator or
  nothing at all.
- Log verbosity for verification failures (coarse reasons vs a single generic 403).
