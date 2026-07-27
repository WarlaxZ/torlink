import { handleApi } from "../daemon/serve";
import { isAuthorized } from "../daemon/auth";
import { getPoster, POSTER_HOSTS, type CachedPoster } from "../core/posterCache";
import type { Runtime } from "../daemon/runtime";

export interface WebDeps {
  runtime: Runtime;
  token: string | null;
  getPosterImpl?: (url: string) => Promise<CachedPoster | null>;
}

// NOTE for whoever serialises a StreamSession to a client (phase 2): build the
// payload by picking fields explicitly, never by omitting them from the whole
// object. `capability` and every `files[].url` must not reach a browser, and
// `JSON.stringify(session)` is the obvious wrong thing to reach for. Picking
// means a field added later defaults to private instead of leaking.

// One response shape for every route. `filePath` streams a file from disk
// (posters); `json` and `text` are written inline. Keeping this a plain value
// means the router never touches a socket and is trivially testable.
export interface WebResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  filePath?: string;
}

// The daemon's handler predates this layer and returns { status, body }; map it
// into the richer WebResponse rather than changing a shape other callers use.
function fromApi(res: { status: number; body: Record<string, unknown> }): WebResponse {
  return { status: res.status, json: res.body };
}

function posterResponse(hit: CachedPoster): WebResponse {
  return {
    status: 200,
    filePath: hit.path,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(hit.bytes),
      // Poster URLs are content-addressed by the remote CDN; a cached one never
      // changes meaning, so let the browser keep it for a day.
      "Cache-Control": "private, max-age=86400",
    },
  };
}

// The legacy scripting paths this router forwards to `handleApi`, which is the
// module that actually implements them. It lives here rather than in the HTTP
// server because the server's only question is "router or static asset?", and
// answering that from its own copy of the table is how drift starts: a path
// added to `handleApi` but not to the server's copy silently becomes an asset
// request answered 400/404, with nothing in the log to say why. Same failure
// mode as the hand-copied `statusPayload` that dropped `uploadSpeed`.
const LEGACY_API_PATHS = new Set(["/health", "/status", "/downloads", "/add", "/control"]);

/** True when `handleWebApi` owns this path; false means it is a static asset. */
export function isApiPath(urlPath: string): boolean {
  return urlPath.startsWith("/api/") || LEGACY_API_PATHS.has(urlPath);
}

/**
 * Pure router for the web layer. Shared routes delegate to the daemon's
 * existing `handleApi` rather than reimplementing them, so `/status` and
 * `/api/status` cannot drift apart. `/health` stays unauthenticated (it is how
 * a supervisor checks liveness); everything else requires the token when one
 * is configured.
 */
export async function handleWebApi(
  deps: WebDeps,
  method: string,
  urlPath: string,
  query: URLSearchParams,
  authHeader: string | undefined,
  bodyText: string,
): Promise<WebResponse> {
  const { runtime, token } = deps;

  // Legacy paths keep working exactly as before: /health, /status, /downloads,
  // /add, /control are a documented API that may already be scripted against.
  if (!urlPath.startsWith("/api/")) {
    return fromApi(await handleApi(runtime, token, method, urlPath, authHeader, bodyText));
  }

  if (!isAuthorized(token, authHeader)) {
    return { status: 401, json: { error: "unauthorized" } };
  }

  if (method === "GET" && urlPath === "/api/poster") {
    const url = query.get("url") ?? "";
    if (!url) return { status: 400, json: { error: "missing url" } };
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { status: 400, json: { error: "unsupported scheme" } };
      }
      host = parsed.hostname.toLowerCase();
    } catch {
      return { status: 400, json: { error: "invalid url" } };
    }
    // DELIBERATELY REDUNDANT: getPoster enforces this allowlist itself on every
    // hop, and that check is the authoritative one — do not delete it in favour
    // of this. This one exists only to pick the status code, because a refused
    // host is a 400 (the caller asked for something we won't do) while a cache
    // miss is a 404, and a null return can't tell the two apart.
    if (!POSTER_HOSTS.has(host)) return { status: 400, json: { error: "host not allowed" } };
    const hit = await (deps.getPosterImpl ?? getPoster)(url);
    if (!hit) return { status: 404, json: { error: "poster unavailable" } };
    return posterResponse(hit);
  }

  // Everything else under /api/ maps onto the shared handler by stripping the
  // prefix, so /api/status, /api/add and /api/control are one implementation.
  const legacyPath = urlPath.slice("/api".length);
  if (
    (method === "GET" && (legacyPath === "/status" || legacyPath === "/downloads")) ||
    (method === "POST" && (legacyPath === "/add" || legacyPath === "/control"))
  ) {
    return fromApi(await handleApi(runtime, token, method, legacyPath, authHeader, bodyText));
  }

  return { status: 404, json: { error: "not found" } };
}
