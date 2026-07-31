// Whether the stream proxy may make a given request at all: the scheme, and how
// many redirects are left.
//
// Pure and separate from the proxy itself because these are the two decisions
// worth testing, and because exercising a real https upstream needs a TLS server
// and a self-signed certificate — disproportionate here. So the decision is
// tested and the socket behaviour is verified by hand. `src/web/stream.test.ts`
// documents the same trade when it refuses to fake its HTTP client.

export type ProxyRefusal = "unparseable" | "scheme" | "hops";

export type ProxyTarget = { ok: true; url: URL } | { ok: false; reason: ProxyRefusal };

/**
 * What the WebTorrent backend is allowed to be: plain http on loopback and
 * nothing else. Kept as a named constant so the call site reads as a decision
 * rather than as an array literal someone might "tidy up".
 */
export const HTTP_ONLY: readonly string[] = ["http:"];

/** What a debrid CDN is allowed to be. */
export const HTTP_AND_HTTPS: readonly string[] = ["http:", "https:"];

export function resolveProxyTarget(
  target: string,
  allowed: readonly string[],
  hopsRemaining: number,
): ProxyTarget {
  // Budget first: a caller with none left must not even parse, so a redirect
  // loop cannot be walked one URL further than intended.
  if (hopsRemaining <= 0) return { ok: false, reason: "hops" };
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!allowed.includes(url.protocol)) return { ok: false, reason: "scheme" };
  return { ok: true, url };
}

/**
 * The same decision for a `Location` header.
 *
 * Resolved against the URL it came from, because a provider may answer with a
 * path rather than an absolute URL. The allow-list is re-applied deliberately: a
 * redirect target comes out of a response, so it is influenced in a way the
 * original URL was not, and a `Location: file:///…` must not be followed.
 */
export function resolveRedirect(
  location: string,
  from: URL,
  allowed: readonly string[],
  hopsRemaining: number,
): ProxyTarget {
  if (hopsRemaining <= 0) return { ok: false, reason: "hops" };
  let absolute: string;
  try {
    absolute = new URL(location, from).toString();
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  return resolveProxyTarget(absolute, allowed, hopsRemaining);
}
