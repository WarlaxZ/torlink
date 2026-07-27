// The stream handle: `GET /stream/:sid/:idx?k=<capability>`.
//
// This is the only route in the app that serves media bytes, and the only one
// that authenticates with something other than the bearer token. It lives
// outside `/api/` and outside `handleWebApi` for two reasons: the router's
// contract is "one request in, one complete value out", which a 40 GiB range
// response is not; and everything under `/api/` is behind the bearer token,
// which is exactly the door this route cannot use.
//
// Two backends, one URL shape:
//
// - Real-Debrid: a `302` to the unrestricted link. The browser then talks
//   straight to their CDN — native seeking, zero bytes through this process.
// - WebTorrent: a range-forwarding reverse proxy. The backend's own URLs are
//   `http://localhost:<ephemeral>/webtorrent/…`, which is unreachable from the
//   phone on the sofa; proxying them through the port the dashboard is already
//   served on is the whole point.

import http from "node:http";
import { isAuthorized } from "../daemon/auth";
import type { StreamSessionRegistry } from "../core/streamSession";

/** Diagnostics sink. Same contract as the server's: injected, never `console`. */
export type StreamLog = (message: string) => void;

export interface StreamDeps {
  sessions: StreamSessionRegistry;
  log: StreamLog;
}
// Note there is deliberately NO injectable HTTP client here. A fake `request`
// cannot show that a Range header survived a socket, that a 206 came back with
// the matching slice, or that an abandoned request closed its connection —
// which is all three of the things this proxy has to get right. The tests stand
// up a real http.Server instead.

const STREAM_BASE = "/stream";

/** True when this path belongs to the stream handle rather than the router. */
export function isStreamPath(urlPath: string): boolean {
  return urlPath === STREAM_BASE || urlPath.startsWith(`${STREAM_BASE}/`);
}

/**
 * `/stream/:sid/:idx` → `{ sid, index }`, or null when the path is not that
 * shape.
 *
 * `idx` is matched as `\d+` and nothing else. That rejects `-1`, `1.5`, `1e3`,
 * `0x0`, `+1`, ` 1`, and the empty string before any of them reaches an array
 * index — `files[Number("-1")]` is `undefined`, which reads as "out of range"
 * and would be answered 404 anyway, but `files["length"]` is not, and a lenient
 * parser here is how an index turns into a property read. A leading zero is
 * allowed (`007` is 7): it is unambiguous and no client constructs one.
 *
 * The sid is decoded, so an id containing a reserved character round-trips
 * through `streamHandle`'s `encodeURIComponent`. It is not otherwise validated:
 * an id no session has is a 404 from the registry lookup, which is the same
 * answer every other unknown id gets.
 */
export function parseStreamPath(urlPath: string): { sid: string; index: number } | null {
  const m = /^\/stream\/([^/]+)\/(\d+)$/.exec(urlPath);
  if (!m) return null;
  let sid: string;
  try {
    sid = decodeURIComponent(m[1]!);
  } catch {
    return null; // a stray "%" is a malformed path, not an id
  }
  if (!sid) return null;
  const index = Number(m[2]);
  // `\d+` can still overflow into a float (twenty digits); a non-integer index
  // must never reach the bounds check.
  if (!Number.isSafeInteger(index)) return null;
  return { sid, index };
}

// Local, because importing the server's copy would make the dependency circular
// (server.ts mounts this module).
function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

// Headers copied from the upstream response. Exactly the set a media element
// needs to seek: everything else (Date, Connection, whatever the backend adds)
// is this proxy's business, not the client's.
const PASS_THROUGH = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

/**
 * Serve one stream request. Writes the response itself — this route owns its
 * socket, unlike everything in `routes.ts`.
 *
 * Returns the status written, so the caller logs what actually happened rather
 * than what was intended. The caller must log the *path* only: a Real-Debrid
 * unrestricted link is a credential against the user's account and must never
 * reach a log line, and the query string carries the capability.
 */
export async function handleStreamRequest(
  deps: StreamDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  query: URLSearchParams,
): Promise<number> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    writeJson(res, 405, { error: "method not allowed" });
    return 405;
  }

  const parsed = parseStreamPath(urlPath);
  if (!parsed) {
    writeJson(res, 404, { error: "not found" });
    return 404;
  }

  const session = deps.sessions.get(parsed.sid);
  // Unknown id is a 404 before the capability is looked at, because there is no
  // capability to compare against yet. That does make this an existence oracle
  // for session ids — 404 vs 401 — which is acceptable only because ids are
  // random UUIDs and the 401 branch leaks nothing further.
  if (!session) {
    writeJson(res, 404, { error: "unknown session" });
    return 404;
  }

  // The capability, and ONLY this session's capability. `isAuthorized` is
  // reused rather than `===` for its constant-time compare, and because a
  // second hand-rolled token comparison in this codebase is a second place to
  // get it wrong. Note the empty-capability guard: `isAuthorized` treats a
  // falsy expected token as "no auth configured" and returns true, which is
  // right for the server-wide token and catastrophic here.
  const k = query.get("k");
  if (!session.capability || !isAuthorized(session.capability, k ? `Bearer ${k}` : undefined)) {
    writeJson(res, 401, { error: "unauthorized" });
    return 401;
  }

  // A session still resolving has no files and an errored one never will. Both
  // are 404 rather than 409/500: the handle simply does not address anything
  // yet, and a <video> element does nothing useful with a status either way.
  if (session.state !== "ready") {
    writeJson(res, 404, { error: "session not ready" });
    return 404;
  }

  const file = session.files[parsed.index];
  if (!file) {
    writeJson(res, 404, { error: "unknown file" });
    return 404;
  }

  if (session.backend === "realdebrid") {
    // 302, not 307: the method is GET/HEAD either way, and 302 is what every
    // player (and every home-router HTTP client) handles without argument.
    // `Cache-Control: no-store` because an unrestricted link is time-limited
    // and account-bound — a cached redirect outlives the link it points at.
    res.writeHead(302, { Location: file.url, "Cache-Control": "no-store", "Content-Length": "0" });
    res.end();
    return 302;
  }

  return proxyUpstream(deps, req, res, file.url);
}

/**
 * Reverse-proxy one request to the local WebTorrent server.
 *
 * Resolves once the response is on its way (headers written, body piping) or
 * has failed — not when the body finishes. The caller only needs the status.
 */
function proxyUpstream(
  deps: StreamDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: string,
): Promise<number> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    deps.log("stream: upstream url is not parseable");
    writeJson(res, 502, { error: "bad upstream" });
    return Promise.resolve(502);
  }
  // The WebTorrent backend serves plain http on loopback and nothing else.
  // Refusing anything else keeps `http.request` from being handed an https URL
  // it would fail on in a much less legible way, and the log line says which
  // scheme was refused — never the URL, which can be a credential.
  if (url.protocol !== "http:") {
    deps.log(`stream: refusing upstream scheme ${url.protocol}`);
    writeJson(res, 502, { error: "bad upstream" });
    return Promise.resolve(502);
  }

  const headers: http.OutgoingHttpHeaders = {};
  // The Range header is the entire reason this proxy is not a redirect: drop it
  // and every seek restarts the file from byte zero, and a browser that asked
  // for `bytes=0-` gets a 200 it cannot scrub.
  const range = req.headers.range;
  if (range !== undefined) headers.Range = range;
  // Passed through so a backend that answers 304 can; harmless otherwise.
  if (req.headers["if-range"] !== undefined) headers["If-Range"] = req.headers["if-range"];

  return new Promise<number>((resolve) => {
    let settled = false;
    const done = (status: number): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };

    const upstream = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers,
        // No keep-alive: this proxy's client is a media element that abandons
        // requests constantly, and a pooled socket outliving an aborted request
        // is precisely the leak the teardown below exists to prevent. The
        // upstream is on loopback, so a fresh connection costs nothing.
        agent: false,
      },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const name of PASS_THROUGH) {
          const value = up.headers[name];
          if (value !== undefined) out[name] = value;
        }
        // The upstream's status, never a hardcoded 200: a 206 answered as 200
        // tells the client its Range was ignored, and a player that asked for
        // the middle of a file will treat the bytes it gets as the start of it.
        res.writeHead(up.statusCode ?? 502, out);
        done(up.statusCode ?? 502);
        up.pipe(res);
        // A mid-body upstream failure cannot become a status code; all that is
        // left is to cut the client off so it sees a truncated body rather than
        // a hang.
        up.on("error", () => res.destroy());
      },
    );

    // The teardown. A user scrubbing a timeline fires and abandons range
    // requests by the dozen; without this each one leaves a socket to the
    // WebTorrent server (and the piece requests behind it) alive with nobody
    // reading. `close` fires for both a client disconnect and our own end, so
    // `writableEnded` is what tells them apart: only the abandoned case needs
    // the upstream destroyed.
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });

    upstream.on("error", (err) => {
      // Nothing can be said to a client that is already gone or already
      // answered; writing would only turn a dead connection into a second
      // error. This branch also covers the ordinary teardown case, where the
      // destroy above is *why* the request errored.
      if (settled || res.headersSent || res.writableEnded || res.destroyed) {
        res.destroy();
        done(502);
        return;
      }
      deps.log(`stream: upstream request failed: ${String(err)}`);
      writeJson(res, 502, { error: "upstream unavailable" });
      done(502);
    });

    upstream.end();
  });
}
