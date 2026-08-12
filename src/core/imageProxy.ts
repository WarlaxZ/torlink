import { torlinkFetch, type FetchImpl } from "../util/net";
import { log } from "../util/logger";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
// A CDN-to-CDN bounce is the only legitimate redirect here, so one hop is the
// whole budget. Anything longer is either broken or someone walking us somewhere.
const MAX_REDIRECTS = 1;
const DEFAULT_TIMEOUT_MS = 8000;

export interface FetchAllowedImageOptions {
  /** Whether we are willing to issue a request for this URL at all. */
  allow: (url: string) => boolean;
  maxBytes: number;
  /** Magic-byte validation of the final body — a 200 that isn't the image type we expect is rejected. */
  accept: (buf: Buffer) => boolean;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

// The URL a redirect response points at, re-checked against `allow`, or null if
// we won't follow it. `hostname` (not `host`, not a prefix) is what defeats a
// userinfo bypass: new URL("https://ok.example@evil.example/").hostname is
// "evil.example". Scheme is re-checked so a hop can't leave http(s).
function redirectTarget(res: Response, currentUrl: string, allow: (u: string) => boolean): string | null {
  const location = res.headers.get("location");
  if (!location) return null;
  let resolved: URL;
  try {
    // Relative Locations are legal and common — resolve against the URL we actually requested.
    resolved = new URL(location, currentUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;
  if (!allow(resolved.href)) return null;
  return resolved.href;
}

/**
 * Fetch an image's bytes with an allowlist SSRF guard and content validation.
 * Returns null on any failure so callers fall back to a placeholder.
 *
 * This is the single, shared copy of the security-critical fetch span — the
 * poster cache and the screenshot cache both go through it, so the redirect
 * re-check and allowlist can never drift between them (the copy-then-drift bug
 * this codebase has recorded for exactly this kind of logic).
 *
 * We fetch with `redirect: "manual"` and resolve the hop ourselves because the
 * allowlist otherwise only guards the *first* request: an allowlisted host with
 * an open redirect could walk us to the cloud instance metadata service. A GET
 * that fires at all is already a problem, whether or not we read its body.
 */
export async function fetchAllowedImageBytes(
  url: string,
  opts: FetchAllowedImageOptions,
): Promise<Buffer | null> {
  if (!opts.allow(url)) return null;
  const fetchImpl = opts.fetchImpl ?? torlinkFetch;
  try {
    // One deadline for the whole exchange, shared across the hop, so following a
    // redirect can't double the time a caller waits.
    const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const get = (u: string): Promise<Response> => fetchImpl(u, { method: "GET", redirect: "manual", signal });

    let target = url;
    let hops = 0;
    let res = await get(target);
    while (REDIRECT_STATUS.has(res.status)) {
      if (hops++ >= MAX_REDIRECTS) return null;
      const next = redirectTarget(res, target, opts.allow);
      if (!next) return null;
      target = next;
      res = await get(target);
    }

    // The loop exits only on a non-redirect, so everything below validates the
    // *final* response: a hop is a path through these guards, never around them.
    if (!res.ok) return null;
    // Trust content-length only to bail early; the real check is the buffer
    // length below, since the header is optional and can lie.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > opts.maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > opts.maxBytes) return null;
    if (!opts.accept(buf)) return null;
    return buf;
  } catch (err) {
    log.debug(`image fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
