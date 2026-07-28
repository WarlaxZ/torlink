// Shared request guards for the headless HTTP servers (serve, files, web). All
// speak plain node:http on a local port, so they share the same doors: a bearer
// token, a loopback-only Host header when tokenless, and — for state-changing
// requests — a cross-site check on Origin / Sec-Fetch-Site.

import type { IncomingHttpHeaders } from "node:http";

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// Constant-ish comparison — the token isn't a password hash, but don't leak
// length via early exit on the common prefix.
function tokenMatches(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

export function isAuthorized(token: string | null, authHeader: string | undefined): boolean {
  if (!token) return true; // no token configured -> open (loopback only, enforced at bind)
  if (!authHeader) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const provided = bearer ? bearer[1]!.trim() : authHeader.trim();
  return tokenMatches(token, provided);
}

/**
 * True when the request's own headers say it came from another site.
 *
 * The gap this closes: with no token `isAuthorized(null, …)` returns true, and
 * the only other gate is `hostHeaderOk` — which a browser passes for free, since
 * it sets `Host` to the target itself. Nothing looked at `Origin`, and no
 * `Content-Type` requirement forced a preflight, so a `fetch()` from any page the
 * user happened to be visiting could reach `POST /api/control` with
 * `{"action":"delete"}` and delete their files. (The same gap exists on the
 * pre-existing 9161 API; the dashboard is what makes a tokenless server the
 * normal thing to run.)
 *
 * The rule is "reject when the headers positively indicate cross-site", NOT
 * "require the headers". Non-browser clients — curl, a shell script, a seedbox
 * web app's server side — send neither header, and a loopback POST from a shell
 * is the existing API contract. Only a browser sends these, and a browser always
 * sends them, so absence is not a bypass: a page cannot suppress its own
 * `Origin` on a POST.
 *
 * Caller's job: apply this to state-changing requests only. A GET is left alone —
 * the dashboard's own `EventSource` cannot set headers, and a cross-origin read
 * is already blocked by the browser's own CORS response check.
 */
export function isCrossSiteRequest(headers: {
  origin?: string | undefined;
  secFetchSite?: string | undefined;
  host?: string | undefined;
}): boolean {
  const site = headers.secFetchSite?.trim().toLowerCase();
  // "same-site" is rejected along with "cross-site": for an IP or bare hostname
  // (which is all this ever binds) it means another port on the same machine,
  // i.e. some other local page driving this API. `delete` is destructive enough
  // that that is not a trust boundary worth granting.
  if (site === "cross-site" || site === "same-site") return true;

  const origin = headers.origin?.trim();
  // No Origin at all: curl, a script, a supervisor. Allowed — see above.
  if (!origin) return false;
  // A browser that vouched for the request itself. "none" is a user-initiated
  // navigation (address bar, bookmark), which cannot be a cross-site POST.
  if (site === "same-origin" || site === "none") return false;
  // Opaque origin: a sandboxed iframe, a file:// page, some redirect chains.
  if (origin.toLowerCase() === "null") return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true; // unparseable Origin — no browser sends one, so don't trust it
  }
  const host = headers.host?.trim().toLowerCase();
  if (!host) return true; // an Origin with no Host to compare it against
  // Compared as host:port, so a page on another local port is cross-origin even
  // though the hostname matches. That is the DNS-rebinding-adjacent case the
  // Host check alone cannot see.
  return originHost !== host;
}

/**
 * `isCrossSiteRequest` over node:http headers, so both servers read the same
 * three fields the same way. `IncomingHttpHeaders` types every value as
 * `string | string[] | undefined`; only set-cookie is ever an array in practice,
 * but take the first element rather than letting an array stringify into "a,b"
 * and turn a duplicated header into an unparseable origin.
 */
export function isCrossSiteHttpRequest(headers: IncomingHttpHeaders): boolean {
  const one = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  return isCrossSiteRequest({
    origin: one(headers.origin),
    secFetchSite: one(headers["sec-fetch-site"]),
    host: one(headers.host),
  });
}

// A tokenless server only ever binds loopback, but DNS rebinding lets a hostile
// webpage reach loopback ports through the browser: the request arrives with
// the attacker's name in the Host header. Requiring a loopback Host defeats it.
export function hostHeaderOk(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.trim().toLowerCase();
  let name: string;
  if (raw.startsWith("[")) {
    // bracketed IPv6, e.g. [::1]:9161
    const end = raw.indexOf("]");
    if (end === -1) return false;
    name = raw.slice(1, end);
  } else {
    const colon = raw.indexOf(":");
    name = colon === -1 ? raw : raw.slice(0, colon);
  }
  return LOOPBACK_HOSTS.has(name);
}
