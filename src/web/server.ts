// The web UI's HTTP server: the one place in this layer that touches a socket.
//
// Everything it serves was built and tested independently — the router
// (web/routes.ts), the SSE subscription (web/sse.ts), the asset resolver
// (web/staticDir.ts) — so this file is deliberately thin glue. It exists
// separately from daemon/serve.ts because that server is a scripting API (JSON
// in, JSON out, port 9161) while this one also serves a browser: static assets,
// a long-lived event stream, and a shutdown that must not block a TUI quit.
//
// Default port 9162 sits next to the add API's 9161.

import http from "node:http";
import os from "node:os";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  castStatusOf,
  handleWebApi,
  isApiPath,
  parseSearchParams,
  startSearchStream,
  type WebDeps,
  type WebResponse,
} from "./routes";
import { subscribeToCasts, subscribeToQueue } from "./sse";
import {
  handleStreamRequest,
  isPlayPath,
  isStreamPath,
  mediaSourceFor,
  parsePlayPath,
  type StreamDeps,
} from "./stream";
import { castOrigin } from "./castOrigin";
import { ProbeCache } from "../core/probeCache";
import { HlsVerdictCache } from "../core/hlsVerdictCache";
import { makeCheckHls, probeFetch } from "./hlsHealth";
import { makeResolveHls } from "./hlsSource";
import { contentTypeFor, findStaticDir, resolveAssetPath } from "./staticDir";
import { readBody, statusPayload } from "../daemon/serve";
import { LOOPBACK_HOSTS, hostHeaderOk, isAuthorized, isCrossSiteHttpRequest } from "../daemon/auth";
import { loadConfig, resolveCastAdvertiseHost } from "../config/config";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import {
  accessJwksUrl,
  accessTokenFromHeaders,
  verifyAccessAssertion,
  type AccessConfig,
} from "../core/cloudflareAccess";
import type { Runtime } from "../daemon/runtime";

export const DEFAULT_WEB_PORT = 9162;

/**
 * Where this server's diagnostics go. Injected, never `console`: in the
 * TUI-hosted mode Ink owns stdout, and a stray write from a request handler
 * lands in the middle of a rendered frame and corrupts it. Defaults to a no-op
 * so a caller that has nowhere to put logs gets silence rather than damage.
 */
export type WebLog = (message: string) => void;

export interface WebServerOptions {
  port?: number;
  host?: string;
  token?: string;
  log?: WebLog;
  /** Override the built asset directory. Injected for tests and odd installs. */
  staticDir?: string;
  /**
   * Override the asset-directory lookup. Injected so a test can exercise the
   * "no build output" branch for real, rather than approximating it with a
   * falsy `staticDir` — a sentinel that would break silently if this ever
   * validated its input, and would then fall through to the real lookup, which
   * finds `dist/web` on some machines and not others.
   */
  findStaticDirImpl?: () => string | null;
  /**
   * Trust `X-Forwarded-Proto` / `X-Forwarded-Host` when this server needs to
   * name its own absolute origin — today, only the `.m3u` playlist.
   *
   * Default off, and it must stay that way. Both headers are ordinary request
   * headers: with no proxy in front, any client can set them and choose the
   * host the generated playlist points a media player at. Turn it on only when
   * something upstream overwrites (not appends to) them.
   */
  trustProxy?: boolean;
  /**
   * Overrides for the router's injectable seams — config loading, the poster
   * fetch, the per-source search, the OMDb lookups. `runtime` and `token` are
   * owned by this server and cannot be overridden.
   *
   * It exists because without it no test can drive `/api/search` over a real
   * socket: the route's default per-source search is `cachedSearch`, which
   * fans out to 23 public trackers, and the default config loader reads the
   * developer's own `config.json`. A socket-level test of the disconnect
   * teardown is exactly the test worth having here, so the alternative was
   * either not having it or having it hit the network. Production passes
   * nothing and gets every default.
   */
  webDeps?: Omit<Partial<WebDeps>, "runtime" | "token">;
  /**
   * Overrides for the stream handle's injectable seams — today the ffprobe call
   * behind `.info`, the debrid transcode lookup and its health check, and the
   * debrid-proxying branch a test drives without a real provider. `sessions`,
   * `log`, `probeCache`, `hlsVerdictCache` and `trustProxy` are owned by this
   * server and cannot be overridden.
   *
   * Same reasoning as `webDeps`: without it, a test of `.info` would spawn
   * ffprobe against a URL that does not exist, and the interesting cases (no
   * binary, a probe that disagrees with the filename) would be unreachable.
   */
  streamDeps?: Omit<
    Partial<StreamDeps>,
    "sessions" | "log" | "probeCache" | "hlsVerdictCache" | "trustProxy"
  >;
  /** When set, verify Cloudflare Access assertions and 403 requests without one. */
  cloudflareAccess?: AccessConfig;
  /** Test seam: overrides the JWKS resolver (default: remote JWKS from the team domain). */
  accessKeySetImpl?: JWTVerifyGetKey;
}

export interface WebServerHandle {
  /** The port actually bound — resolved, so `port: 0` is usable. */
  port: number;
  /** Idempotent. Ends live event streams first so it cannot block on one. */
  close: () => Promise<void>;
}

// One JSON error shape, so a failure looks the same whichever guard produced it.
function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

/**
 * Write a router result to a socket. Exported for its own tests: the precedence
 * below is a contract, and the no-body case is the interesting one.
 *
 * Precedence is explicit — filePath, then text, then json — rather than a chain
 * of `if (x !== undefined)` whose order is an accident of editing. A response
 * carrying none of the three is a router bug, not a valid empty 200: answering
 * it with a bare `res.end()` would ship a browser a blank page and leave no
 * trace, so it is logged and answered 500.
 *
 * Returns the status *actually written*, which is not always `out.status`: this
 * function answers its own 404 for a missing or non-file path and its own 500
 * for a body-less response. Callers must log the return value, or every one of
 * those failures reads as a success in the log.
 *
 * INVARIANT for `filePath`: it is streamed as given, with no containment check
 * of its own. Every caller must have proven the path safe first — the asset
 * branch via `resolveAssetPath`, the poster route via a `sha1(url).jpg` name it
 * constructs itself inside `postersDir`. A future route that puts a
 * user-influenced path here without that proof gets arbitrary file read, and
 * nothing below will stop it.
 */
export async function writeWebResponse(
  res: http.ServerResponse,
  out: WebResponse,
  log: WebLog,
): Promise<number> {
  const headers = { ...(out.headers ?? {}) };

  if (out.filePath !== undefined) {
    // stat before streaming, for two reasons. A path can resolve to a directory
    // (resolveAssetPath only proves containment), and streaming one fails with
    // EISDIR mid-response instead of a clean 404. And the Content-Length: the
    // router's poster response computes one from a stat taken back when the
    // poster was cached, which is stale if the file has since been rewritten.
    // Overriding it from a stat taken here cannot eliminate the race — the file
    // can still change during the stream — but it shrinks the window from
    // "however long the cache lookup took" to microseconds, and this stat is one
    // we need for isFile() anyway, so it is free. Dropping the header instead
    // would work but costs the browser a determinate progress bar on posters.
    let size: number;
    try {
      const info = await stat(out.filePath);
      if (!info.isFile()) {
        log(`not a file: ${out.filePath}`);
        writeJson(res, 404, { error: "not found" });
        return 404;
      }
      size = info.size;
    } catch {
      writeJson(res, 404, { error: "not found" });
      return 404;
    }
    headers["Content-Length"] = String(size);
    res.writeHead(out.status, headers);
    const stream = createReadStream(out.filePath);
    // A read error after the header is out cannot be turned into a status code;
    // all that is left is to cut the connection so the client sees a truncated
    // body rather than hanging, and to say why in the log.
    stream.on("error", (err) => {
      log(`stream failed for ${out.filePath}: ${String(err)}`);
      res.destroy();
    });
    stream.pipe(res);
    return out.status;
  }

  if (out.text !== undefined) {
    res.writeHead(out.status, {
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
      "Content-Length": String(Buffer.byteLength(out.text)),
    });
    res.end(out.text);
    return out.status;
  }

  if (out.json !== undefined) {
    const payload = JSON.stringify(out.json);
    res.writeHead(out.status, {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
      "Content-Length": String(Buffer.byteLength(payload)),
    });
    res.end(payload);
    return out.status;
  }

  log(`response with no body for status ${out.status}`);
  writeJson(res, 500, { error: "internal error" });
  return 500;
}

/**
 * Start the web UI server. Resolves once it is listening.
 *
 * Throws rather than exiting on a bad configuration: this runs inside the TUI
 * process as well as the daemon, and a `process.exit` there would kill an
 * interactive session with a half-torn-down terminal.
 */
export async function startWebServer(
  runtime: Runtime,
  options: WebServerOptions = {},
): Promise<WebServerHandle> {
  const port = options.port ?? DEFAULT_WEB_PORT;
  const host = options.host ?? "127.0.0.1";
  const token = options.token && options.token.trim() ? options.token.trim() : null;
  const log: WebLog = options.log ?? ((): void => {});

  // Cloudflare Access: built once, since the JWKS resolver caches its own keys.
  // A null config leaves the guard below inert, so every default install (and
  // every existing test) is unchanged.
  const accessCfg = options.cloudflareAccess ?? null;
  const accessKeySet = accessCfg
    ? (options.accessKeySetImpl ?? createRemoteJWKSet(accessJwksUrl(accessCfg.teamDomain)))
    : null;
  if (accessCfg) log(`cloudflare access: enforcing (team ${accessCfg.teamDomain})`);

  // Fail soft, not open — the same rule daemon/serve.ts enforces. The web UI
  // exposes strictly more than the add API does, so it cannot be laxer. When
  // Access is enforced the origin JWT check is a strictly stronger gate than a
  // token, so a tokenless non-loopback bind is allowed then (and not minted —
  // a token would break the browser UI behind a tunnel).
  if (!LOOPBACK_HOSTS.has(host) && !token && !accessCfg) {
    throw new Error(
      `refusing to bind ${host} without a token: pass a token (or set TORLINK_API_TOKEN), ` +
        `enforce Cloudflare Access, or bind 127.0.0.1`,
    );
  }

  const staticRoot = options.staticDir ?? (options.findStaticDirImpl ?? findStaticDir)();
  if (!staticRoot) {
    // The only signal a user will get. Without it the API answers fine while
    // every asset 404s, so the browser shows a blank page and the cause — no
    // `npm run build` — is invisible.
    log("warning: no built web assets found (dist/web); run `npm run build`. API only.");
  }

  // One probe cache for this process, so opening a player page twice does not
  // spawn ffprobe twice. Bounded, so it needs no teardown of its own.
  const probeCache = new ProbeCache();

  // Rung 2 of the player's source ladder: the debrid provider's own HLS
  // transcode, which lets a browser play an MKV without this machine
  // transcoding or carrying a byte. Built once; it reads config per call, so a
  // token changed in the TUI is picked up without a restart.
  const resolveHls = makeResolveHls();

  // ...and the check that it is worth offering. A manifest existing does not mean
  // the provider's transcoder can keep up with it; measured against Real-Debrid,
  // 1080p HEVC runs at 0.65x realtime and hands out truncated segments as
  // complete responses, which freezes a browser a few seconds in. One verdict per
  // (session, file), cached, so a reload costs nothing.
  const checkHls = makeCheckHls({ fetchImpl: probeFetch });
  const hlsVerdictCache = new HlsVerdictCache();

  /**
   * The stream route's deps, rebuilt per use rather than held.
   *
   * `proxyDebrid` is resolved fresh every time, not read once at boot: `serve
   * --web` is a separate process from any TUI that might flip the flag, so a held
   * snapshot would silently serve a stale value. An explicit
   * `options.streamDeps.proxyDebrid` (a test, driving the branch without a real
   * debrid provider) still wins over the config read.
   *
   * A function rather than an inline literal because the cast routes need the
   * same deps to answer the same source question — see `castSourceImpl` below.
   */
  const buildStreamDeps = async (): Promise<StreamDeps> => ({
    resolveHls,
    checkHls,
    // Spread after the defaults so a test can override them, and before the
    // fields below so it cannot override those.
    ...options.streamDeps,
    sessions: runtime.sessions,
    log,
    trustProxy: options.trustProxy === true,
    probeCache,
    hlsVerdictCache,
    proxyDebrid:
      options.streamDeps?.proxyDebrid ??
      (await (options.webDeps?.loadConfigImpl ?? loadConfig)()).proxyDebridStreams === true,
  });

  // Set once the socket is bound, because `port: 0` means the requested port is
  // not the real one — the same reason the log line below reads it back from the
  // server. A cast before the server is listening is impossible, so the null
  // window is not reachable from a request.
  let boundPort = port;

  // One deps object for every route, built once. `runtime` and `token` come last
  // so an override cannot swap the queue or weaken the gate; the two cast seams
  // sit before the spread so a test can replace them.
  const routeDeps: WebDeps = {
    // The origin a television fetches from. NOT the request's `Host`, which is a
    // claim by a client: a user browsing `http://localhost:9161` would otherwise
    // hand the device a URL pointing at the device itself. `host` is what this
    // server actually bound, which is a fact about what is reachable.
    castOriginImpl: async () => {
      // Config per call, never a snapshot: `serve --web` is a separate process
      // from any TUI where the user may have just fixed this very setting, and a
      // held copy would keep handing a television an address that does not work.
      const cfg = await (options.webDeps?.loadConfigImpl ?? loadConfig)();
      return castOrigin(host, boundPort, os.networkInterfaces(), resolveCastAdvertiseHost(cfg));
    },
    // The same answer the player page's `.info` gets, from the same function, so
    // a browser and a television cannot disagree about one file.
    castSourceImpl: async (session, index) => mediaSourceFor(await buildStreamDeps(), session, index),
    ...options.webDeps,
    runtime,
    token,
  };

  // Live SSE responses, so close() can end them. Without this, http's close()
  // waits for every connection to end and an event stream never does.
  const streams = new Set<{ res: http.ServerResponse; stop: () => void }>();

  /**
   * The bearer token as an SSE client can send it. `EventSource` cannot set
   * request headers, so the token is also accepted as `?k=`. Same check either
   * way — the query form is a transport detail, not a weaker door. (It does mean
   * the token can land in a server access log; the alternative is no browser
   * stream at all without a cookie layer.)
   *
   * This is NOT the `/stream/:sid` capability, which is a different, per-session
   * secret that satisfies no `/api/*` route.
   */
  const sseAuthorized = (req: http.IncomingMessage, query: URLSearchParams): boolean => {
    const k = query.get("k");
    return isAuthorized(token, req.headers.authorization ?? (k ? `Bearer ${k}` : undefined));
  };

  /**
   * Write the event-stream headers, start a producer, and bind its teardown to
   * the connection closing. Shared by every SSE route so the framing, the
   * header set and — the part that actually matters — the disconnect teardown
   * cannot differ between them.
   *
   * `start` gets the write function and returns its own stop; that stop runs on
   * client disconnect, on `res.end()` from `close()` below, and never twice.
   */
  const serveStream = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    start: (write: (chunk: string) => void) => () => void,
  ): void => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which holds a stream's
      // frames back until the buffer fills — i.e. forever, for this traffic.
      "X-Accel-Buffering": "no",
    });
    // Push the headers out now rather than letting Node hold them until the
    // first write. A producer whose first frame waits on something slow (the
    // search route reads config before it knows its source list) would
    // otherwise leave the client's `fetch`/`EventSource` unresolved until then,
    // which reads as "the server never answered".
    res.flushHeaders();
    const entry = { res, stop: (): void => {} };
    // DEFERRED: no backpressure handling. res.write returns false once the
    // socket's buffer is full and we ignore it, so a client that stops reading
    // (a phone that slept, a slow link) accumulates frames in this process's
    // memory until it disconnects. Doing it properly means pausing the producer
    // on a false return and resuming on the socket's "drain" — real
    // per-connection state, not worth it for a loopback/LAN tool with a handful
    // of clients. Start here if this ever sits behind a slow link.
    entry.stop = start((chunk) => res.write(chunk));
    streams.add(entry);
    // "close" fires for a client disconnect and for our own res.end(), which is
    // what makes the teardown single-pathed: whoever ends the stream, the
    // producer's listeners, timers and in-flight requests go with it.
    req.on("close", () => {
      entry.stop();
      streams.delete(entry);
    });
  };

  const serveEvents = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: URLSearchParams,
  ): void => {
    if (!sseAuthorized(req, query)) {
      writeJson(res, 401, { error: "unauthorized" });
      log(`GET /api/events -> 401`);
      return;
    }
    serveStream(req, res, (write) =>
      subscribeToQueue(
        runtime.queue,
        write,
        () => statusPayload(runtime),
        // On the same channel, so one EventSource carries both. It is what lets a
        // cast started from a laptop appear on a phone pointed at this server —
        // within this process, which is the limit `Runtime.casts` documents.
        subscribeToCasts(runtime.casts, () => castStatusOf(runtime.casts)),
      ),
    );
    log(`GET /api/events -> 200 (stream, ${streams.size} open)`);
  };

  /**
   * `GET /api/search?q=…&group=…`. Token-gated exactly like `/api/events`, and
   * for the same reason it has to be: this route spends the user's bandwidth on
   * up to 23 outbound requests to public trackers, so an anonymous caller with
   * a loop is a traffic amplifier pointed at third parties.
   *
   * Parameters are validated before the headers go out, so a bad request is a
   * real 400 rather than an error frame inside a 200 stream.
   */
  const serveSearch = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: URLSearchParams,
  ): void => {
    if (!sseAuthorized(req, query)) {
      writeJson(res, 401, { error: "unauthorized" });
      log(`GET /api/search -> 401`);
      return;
    }
    const parsed = parseSearchParams(query);
    if (!parsed.ok) {
      writeJson(res, 400, { error: parsed.error });
      log(`GET /api/search -> 400 (${parsed.error})`);
      return;
    }
    serveStream(req, res, (write) =>
      // res.end() on teardown, so a finished search closes its connection
      // instead of holding a socket open forever like /api/events does. It is
      // reached from the same stop the disconnect path uses, so ending here
      // cannot race with the client having already gone.
      startSearchStream(routeDeps, parsed.params, write, () => res.end()),
    );
    // The query itself is not logged: it is the user's search terms.
    log(`GET /api/search -> 200 (stream, ${streams.size} open)`);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      // A fixed base, because req.url is origin-form: only pathname and search
      // are read off it. The literal "localhost" is never trusted for anything —
      // the real Host header is checked separately, just below.
      const url = new URL(req.url ?? "/", "http://localhost");
      const urlPath = url.pathname;

      // Tokenless means loopback-bound, so require a loopback Host: a hostile
      // page can otherwise reach this port through DNS rebinding, arriving with
      // the attacker's name in Host and the user's cookies... and full API access.
      //
      // The loopback-Host check defends a tokenless loopback bind against DNS
      // rebinding. When Cloudflare Access is enforced it is redundant — a rebinding
      // page can't mint a valid assertion — and it would otherwise 403 the public
      // Host that cloudflared forwards. So skip it when Access is on.
      if (!token && !accessCfg && !hostHeaderOk(req.headers.host)) {
        writeJson(res, 403, { error: "forbidden host" });
        log(`${method} ${urlPath} -> 403 (host)`);
        return;
      }

      // CSRF, and the reason it sits here rather than in the router: the router
      // never sees the request headers. Tokenless is the normal way to run the
      // dashboard, and tokenless means `isAuthorized` says yes to anyone —
      // leaving `Host`, which a browser sets to the target itself, as the only
      // gate. So `POST /api/control {"action":"delete"}` from any page the user
      // was visiting reached `queue.remove(id, { deleteFiles: true })`.
      //
      // Only state-changing methods, and only when the headers positively say
      // cross-site: the dashboard's own fetch sends a same-origin `Origin` and
      // passes, while curl and scripts send neither header and also pass.
      if (method !== "GET" && method !== "HEAD" && isCrossSiteHttpRequest(req.headers)) {
        writeJson(res, 403, { error: "cross-site request blocked" });
        log(`${method} ${urlPath} -> 403 (cross-site)`);
        return;
      }

      // Cloudflare Access: the origin refuses anything that did not arrive through
      // Access, so it is safe even if this port is ever reachable directly. Health
      // and the media routes are exempt — the latter carry the per-session ?k=
      // capability instead, because <video>/VLC/Chromecast can't present a cert.
      // The Access-verified email for this request, threaded into the router so
      // per-user lists (watch history, favourites, saved searches, reccd) are
      // partitioned by login. Undefined for exempt paths and when Access is off.
      let accessEmail: string | undefined;
      if (accessCfg) {
        // INVARIANT: any path added here MUST carry its own capability (the
        // stream/play ?k=) or return nothing sensitive — under Access the
        // loopback-Host guard above is skipped, so an exempt path is otherwise
        // reachable directly via DNS rebinding.
        const exempt = urlPath === "/health" || isStreamPath(urlPath) || isPlayPath(urlPath);
        if (!exempt) {
          const assertion = accessTokenFromHeaders(req.headers);
          const verdict = await verifyAccessAssertion(assertion, accessKeySet!, accessCfg);
          if (!verdict.ok) {
            writeJson(res, 403, { error: "forbidden" });
            log(`${method} ${urlPath} -> 403 (access: ${verdict.reason})`);
            return;
          }
          accessEmail = verdict.email;
        }
      }

      // Long-lived, so it is handled before the router: the router's contract is
      // one request in, one complete response out, which a stream is not.
      if (method === "GET" && urlPath === "/api/events") {
        serveEvents(req, res, url.searchParams);
        return;
      }

      if (method === "GET" && urlPath === "/api/search") {
        serveSearch(req, res, url.searchParams);
        return;
      }

      // Media, and the second route that owns its own socket: a range response
      // is a long body the router's one-value-out contract cannot express.
      // Mounted outside /api/ deliberately — it authenticates with a session
      // capability in ?k=, not the bearer token, because <video> and VLC cannot
      // send an Authorization header. Only the path is logged: the query string
      // carries that capability, and a Real-Debrid Location is a credential.
      if (isStreamPath(urlPath)) {
        const streamDeps = await buildStreamDeps();
        const wrote = await handleStreamRequest(
          streamDeps,
          req,
          res,
          urlPath,
          url.searchParams,
        );
        log(`${method} ${urlPath} -> ${wrote}`);
        return;
      }

      // The player page. A path route rather than `player.html?s=…&i=…` so the
      // URL is shareable and reads like one, but the response is the *static*
      // asset with nothing templated into it: the page learns which session it
      // is for by parsing its own location. Server-side templating here would
      // mean interpolating a torrent's name into HTML, and the whole front end
      // is built on the rule that attacker-controlled text only ever reaches
      // the DOM through textContent.
      //
      // No capability check: the file is the same bytes for everybody and
      // contains no session data. The media it points at is still behind ?k=.
      if ((method === "GET" || method === "HEAD") && isPlayPath(urlPath)) {
        const asset = staticRoot && parsePlayPath(urlPath) ? resolveAssetPath(staticRoot, "/player.html") : null;
        if (!asset) {
          writeJson(res, 404, { error: "not found" });
          log(`${method} ${urlPath} -> 404`);
          return;
        }
        const wrote = await writeWebResponse(
          res,
          { status: 200, filePath: asset, headers: { "Content-Type": contentTypeFor(asset) } },
          log,
        );
        log(`${method} ${urlPath} -> ${wrote}`);
        return;
      }

      if (isApiPath(urlPath)) {
        const body = method === "POST" ? await readBody(req) : { text: "", tooLarge: false };
        if (body.tooLarge) {
          // Answer on the still-live socket, then cut it: the client is mid-send
          // and will otherwise keep pushing into a half-closed connection.
          res.writeHead(413, {
            "Content-Type": "application/json; charset=utf-8",
            Connection: "close",
          });
          res.end(JSON.stringify({ error: "body too large" }));
          res.once("finish", () => req.destroy());
          log(`${method} ${urlPath} -> 413`);
          return;
        }
        let out: WebResponse;
        try {
          out = await handleWebApi(
            routeDeps,
            // HEAD is routed as GET. Supervisors liveness-poll with it, and the
            // router only knows GET, so without this HEAD /health is a 404 —
            // silently, since /health is excluded from the log below. Node drops
            // the body for a HEAD response itself (res._hasBody), so the handler
            // needs no HEAD awareness and the Content-Length stays correct.
            method === "HEAD" ? "GET" : method,
            urlPath,
            url.searchParams,
            req.headers.authorization,
            body.text,
            accessEmail,
          );
        } catch (err) {
          log(`${method} ${urlPath} threw: ${String(err)}`);
          out = { status: 500, json: { error: "internal error" } };
        }
        // The status writeWebResponse *wrote*, not the one the router intended:
        // it answers its own 404 and 500, and logging out.status would report
        // those as whatever they were before it overrode them.
        const wrote = await writeWebResponse(res, out, log);
        // /health is a supervisor's liveness poll — logging it would drown
        // everything else in a long-running process.
        if (urlPath !== "/health") log(`${method} ${urlPath} -> ${wrote}`);
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        writeJson(res, 404, { error: "not found" });
        log(`${method} ${urlPath} -> 404`);
        return;
      }

      if (!staticRoot) {
        writeJson(res, 404, { error: "not found" });
        log(`${method} ${urlPath} -> 404 (no assets)`);
        return;
      }
      const file = resolveAssetPath(staticRoot, urlPath);
      if (!file) {
        // Not a 404: null means the path was malformed or tried to escape the
        // root, which is the client's error and worth being able to grep for.
        writeJson(res, 400, { error: "bad path" });
        log(`${method} ${urlPath} -> 400 (bad path)`);
        return;
      }
      // Again the written status, not a hardcoded 200: a missing file or a
      // directory is answered 404 in there, and logging 200 regardless made
      // every asset failure read as a success — which defeats the point of
      // warning about missing assets at all.
      const wrote = await writeWebResponse(
        res,
        { status: 200, filePath: file, headers: { "Content-Type": contentTypeFor(file) } },
        log,
      );
      log(`${method} ${urlPath} -> ${wrote}`);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    // Bind errors (EADDRINUSE) arrive as an event, not a throw, so they have to
    // be turned back into a rejection or startWebServer would resolve on a dead
    // server. Removed once listening, so a later runtime error goes to the log.
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      server.on("error", (err) => log(`server error: ${String(err)}`));
      resolve();
    });
  });

  const address = server.address();
  // `port: 0` asks the OS to pick, so the caller can only learn the real port
  // from here. A string address means a unix socket, which this never binds.
  const bound = address && typeof address === "object" ? address.port : port;
  // What `castOriginImpl` names, now that it is known.
  boundPort = bound;
  // The bind, not a URL. This server knows where it is listening; it does not
  // know what a browser should type — a wildcard bind has no single answer, and
  // printing `http://0.0.0.0:9161` here is what sent users to a dead address.
  // The browsable URLs are the caller's to log (see web/links.ts).
  log(`web ui bound to ${host}:${bound}${token ? " (token required)" : " (loopback only)"}`);

  let closed: Promise<void> | null = null;
  const close = (): Promise<void> => {
    // Idempotent: the daemon closes on SIGINT and the TUI closes on quit, and
    // both can fire. Returning the same promise means the second caller waits
    // for the first close rather than starting a second one.
    if (closed) return closed;
    closed = new Promise<void>((resolve) => {
      // Event streams first. http.Server.close() stops accepting and then waits
      // for open connections to end; an SSE connection never ends on its own, so
      // closing without this hangs forever — fatal for a TUI quit.
      for (const entry of streams) {
        entry.stop();
        entry.res.end();
      }
      streams.clear();
      server.close(() => resolve());
      // Ending the streams above closes one door; this closes the class. Any
      // socket that is connected but has no *complete* request in flight — a
      // browser's speculative preconnect, a TCP health probe, a port scan, a
      // client that sent half its headers — is neither idle nor finishable, so
      // close() waits on it forever. Reproduced with a bare net.connect.
      //
      // Note this is NOT the closeIdleConnections() removed earlier: that one
      // really was dead (close() has dropped idle sockets itself since Node 19).
      // "That call did nothing" was true and still didn't mean nothing needed
      // doing. The cost is that a response genuinely mid-flight is cut off, which
      // is the right trade here: quitting the TUI must never block on a browser.
      server.closeAllConnections();
    });
    return closed;
  };

  return { port: bound, close };
}
