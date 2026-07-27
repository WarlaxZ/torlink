import { handleApi } from "../daemon/serve";
import { isAuthorized } from "../daemon/auth";
import { getPoster, POSTER_HOSTS, type CachedPoster } from "../core/posterCache";
import type { StreamSession } from "../core/streamSession";
import { classifyStreamRoute, type StreamRoute } from "../core/streamRoute";
import { type Config, loadConfig, resolveRealDebridToken } from "../config/config";
import { rdStatusFromUser, type RdStatus } from "../integrations/rdStatus";
import { validateToken } from "../integrations/realdebrid";
import { parseInput } from "../sources/magnet";
import type { Runtime } from "../daemon/runtime";
import type {
  PublicStreamFile,
  PublicStreamSession,
  StartStreamResponse,
  StreamConfirmResponse,
} from "./wire";

export interface WebDeps {
  runtime: Runtime;
  token: string | null;
  getPosterImpl?: (url: string) => Promise<CachedPoster | null>;
  /**
   * How the stream routes reach configuration. There is no config on `Runtime`
   * and none captured at boot, and that is deliberate rather than an oversight
   * to fix: this server runs inside the TUI process, where the user can paste a
   * Real-Debrid token into the Accounts tab at any moment. A config snapshot
   * taken when the server started would route their next stream over P2P — the
   * exact IP exposure `classifyStreamRoute` exists to prevent — until they
   * restarted the app. Reading per request costs one small JSON file read on a
   * route that is about to join a swarm or call an API over the network.
   *
   * Injected with a default in the same style as `getPosterImpl`, so a test
   * gets a config without touching the user's real one.
   */
  loadConfigImpl?: () => Promise<Config>;
  /**
   * Last-known Real-Debrid account status for a token, or null when it can't be
   * determined. Only consulted when a token is configured (see the route).
   *
   * The default hits the network, because the alternative is worse: the TUI
   * keeps a live `rdStatus` in React state and the web layer has no equivalent,
   * so hardcoding null here would mean `classifyStreamRoute` could never return
   * `torrent-confirm` from a browser, and a lapsed premium account would route
   * straight to P2P — silently, which is the one outcome that decision exists
   * to prevent. A failure (offline, RD down) is null, not an error: that lets
   * the RD attempt proceed and fail with its own message rather than
   * downgrading to a swarm because a status probe timed out.
   */
  rdStatusImpl?: (token: string) => Promise<RdStatus | null>;
}

/** The path a client fetches to read one file of a session: `/stream/:sid/:idx`. */
export function streamHandle(sessionId: string, index: number): string {
  // Encoded even though ids are UUIDs today: this string is pasted into an
  // <video src> and an .m3u, and an id factory that ever returns something with
  // a slash or a space in it must not silently produce a different path.
  return `/stream/${encodeURIComponent(sessionId)}/${index}`;
}

/**
 * The browser-safe view of a session.
 *
 * It lives in the web layer, not next to `StreamSession` in `src/core`, because
 * core is forbidden (by lint, deliberately) from importing `./wire` — it is the
 * front-end-agnostic layer, and "what a browser is allowed to see" is not its
 * question. Keeping it here also means the wire types have exactly one
 * declaration, checked at their only producer.
 *
 * BUILT BY PICKING FIELDS, NEVER BY OMITTING THEM. There is no spread here and
 * there must never be one: `{...session, capability: undefined}` and
 * `delete copy.capability` both mean that the day someone adds a field to
 * `StreamSession` — a debrid token, a cookie, an absolute temp path — it ships
 * to every browser polling this session and nothing fails. Picking inverts the
 * default: a new field is private until a human writes a line here.
 *
 * Two things are removed rather than renamed:
 *
 * - `capability`, which is a media credential. It is returned once, in the
 *   `POST /api/stream` response, and never inside a session body — so polling a
 *   resolving session doesn't repeat it into logs and histories.
 * - every `files[].url`, which is either a Real-Debrid unrestricted link (a
 *   credential against the user's account, usable from anywhere) or a
 *   `localhost:<ephemeral>` WebTorrent URL (useless to a remote client). Both
 *   are replaced by a `/stream/:sid/:idx` handle.
 *
 * `backendHandle` (a live WebTorrent client) and `createdAt` are dropped too:
 * the first is not serialisable and the second is nobody's business.
 *
 * Deliberately takes no capability argument. Nothing it produces embeds one, so
 * accepting it would only create somewhere for one to end up.
 */
export function toPublicSession(session: StreamSession): PublicStreamSession {
  const files: PublicStreamFile[] = session.files.map((f, index) => ({
    filename: f.filename,
    bytes: f.bytes,
    index,
    handle: streamHandle(session.id, index),
  }));
  const out: PublicStreamSession = {
    id: session.id,
    backend: session.backend,
    name: session.name,
    state: session.state,
    progress: session.progress,
    files,
  };
  // Conditional rather than `error: session.error`: the wire type marks it
  // optional, and a `"error": undefined` key is dropped by JSON.stringify but
  // present to any in-process consumer, which is a difference worth not having.
  if (session.error !== undefined) out.error = session.error;
  return out;
}

// The status probe is advisory and sits in front of a user's click, so it is
// bounded and gets no retries: the Real-Debrid client has no request timeout of
// its own, and without this a stalled RD API would hold POST /api/stream open
// for as long as the socket stayed alive. An unanswered probe is "unknown"
// (null), which routes to Real-Debrid and lets the resolve report its own
// failure — never a silent downgrade to a swarm because a probe timed out.
const RD_STATUS_PROBE_MS = 4000;

async function fetchRdStatus(token: string): Promise<RdStatus | null> {
  try {
    const user = await validateToken(token, {
      retries: 0,
      signal: AbortSignal.timeout(RD_STATUS_PROBE_MS),
    });
    return rdStatusFromUser(user, new Date());
  } catch {
    return null;
  }
}

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

const STREAM_BASE = "/api/stream";

/**
 * The `:sid` of `/api/stream/:sid`, or null when the path isn't that shape.
 *
 * Deliberately one hand-written matcher rather than a router library or a
 * regex: this is the only parameterised path in the app, and the interesting
 * property is what it *rejects*. Exactly one non-empty segment, so
 * `/api/stream` (the collection), `/api/stream/` and `/api/stream/a/b` are all
 * misses and fall through to the 404 below rather than being answered with
 * something. Matching is exact and case-sensitive for the same reason the rest
 * of this router is: `/API/stream/x` never reaches here at all (it fails
 * `startsWith("/api/")` and goes to the legacy handler, which knows no such
 * path), and nothing here lowercases a path to "help".
 *
 * The segment is decoded but not validated: an id that no session has is a 404
 * from the registry lookup, which is the same answer any other unknown id
 * gets, and is the only place that decision belongs.
 */
export function streamSessionId(urlPath: string): string | null {
  if (!urlPath.startsWith(`${STREAM_BASE}/`)) return null;
  const rest = urlPath.slice(STREAM_BASE.length + 1);
  if (!rest || rest.includes("/")) return null;
  try {
    // A stray "%" is a malformed path, not an id: decodeURIComponent throws and
    // this becomes a miss rather than a 500 out of the handler.
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

interface StartStreamBody {
  magnet?: unknown;
  infoHash?: unknown;
  name?: unknown;
  // Set by a client that has shown the user the `torrent-confirm` reason and
  // had them accept it. Never inferred, never defaulted true.
  confirm?: unknown;
}

function parseStartBody(bodyText: string): StartStreamBody | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as StartStreamBody;
  } catch {
    return null;
  }
}

/**
 * POST /api/stream — start a session and answer with its id, its capability
 * and its (public) state.
 *
 * Routing is `classifyStreamRoute`, the same decision the TUI makes, for the
 * same reason: a configured Real-Debrid account should be used, and one that is
 * configured but not working must not be quietly swapped for a P2P swarm. The
 * `torrent-confirm` case is reported to the client as its own status and its
 * own body and NOT downgraded to `torrent-auto` here — the user set Real-Debrid
 * up precisely so their IP would stay out of swarms, and a server that decides
 * "close enough" on their behalf exposes it without them ever seeing a prompt.
 * The client asks, and comes back with `confirm: true` if they accept.
 */
async function startStream(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseStartBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid json body" } };

  // Same normalisation as /add: a magnet or a bare info hash, validated here so
  // nothing hands an arbitrary string to WebTorrent or Real-Debrid. `infoHash`
  // is the fallback input, not a second source of truth — the hash used is
  // always the one the accepted magnet actually carries.
  const input = typeof body.magnet === "string" && body.magnet.trim() ? body.magnet : body.infoHash;
  if (typeof input !== "string" || !input.trim()) {
    return { status: 400, json: { error: "missing magnet or info hash" } };
  }
  const parsed = parseInput(input);
  if (!parsed) return { status: 400, json: { error: "invalid magnet or info hash" } };
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : parsed.name;

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const debridToken = resolveRealDebridToken(config);
  // Only probe the account when there is a token to probe. classifyStreamRoute
  // would ignore the status in that case anyway, and this route is reached by a
  // click: a network round trip that cannot change the answer is one the user
  // waits through for nothing.
  const rdStatus = debridToken ? await (deps.rdStatusImpl ?? fetchRdStatus)(debridToken) : null;
  const classified = classifyStreamRoute(config, rdStatus);

  let route: StreamRoute = classified;
  if (classified.kind === "torrent-confirm") {
    if (body.confirm !== true) {
      const refusal: StreamConfirmResponse = { route: "torrent-confirm", reason: classified.reason };
      // 409, not 200: nothing was started. A success status with a "please ask
      // the user" body is the shape a client accidentally treats as done.
      return { status: 409, json: refusal };
    }
    // Confirmed by a human, so it proceeds as an ordinary P2P stream.
    route = { kind: "torrent-auto" };
  }

  // begin(), not start(): a Real-Debrid cache can take minutes and the answer
  // has to come back now, with a `resolving` session the client polls. `done`
  // is deliberately dropped — it never rejects, and every outcome it has is
  // written onto the session the client is already holding an id for.
  const { session } = deps.runtime.sessions.begin({
    infoHash: parsed.infoHash,
    magnet: parsed.magnet,
    name,
    route,
    debridToken: debridToken || undefined,
  });
  const out: StartStreamResponse = {
    sessionId: session.id,
    // The one and only place this crosses the wire. It is NOT in
    // `toPublicSession`, so the polled session bodies below never repeat it.
    capability: session.capability,
    session: toPublicSession(session),
  };
  return { status: 200, json: out };
}

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

  // ---- streaming -------------------------------------------------------
  // Everything below this line is past the token gate above. That gate is the
  // only thing standing between an anonymous caller and joining a swarm or
  // spending the user's Real-Debrid account, because — unlike /api/status —
  // none of these delegate to handleApi, which re-checks.

  if (method === "POST" && urlPath === STREAM_BASE) {
    return startStream(deps, bodyText);
  }

  const sid = streamSessionId(urlPath);
  if (sid !== null) {
    const session = runtime.sessions.get(sid);
    // Unknown id is a 404 for both verbs, and says nothing about whether some
    // other client holds that session.
    if (!session) return { status: 404, json: { error: "unknown session" } };
    if (method === "GET") return { status: 200, json: toPublicSession(session) };
    if (method === "DELETE") {
      // `keep` is the WebTorrent backend's "leave the downloaded data on disk"
      // flag. Absent means discard, which is what a stream that was only ever
      // watched should do — the opposite default would quietly fill the disk
      // with temp copies of everything the user previewed.
      await runtime.sessions.stop(sid, { keep: query.get("keep") === "1" });
      return { status: 200, json: { stopped: true } };
    }
    return { status: 405, json: { error: "method not allowed" } };
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
