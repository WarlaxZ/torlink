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
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { handleWebApi, type WebResponse } from "./routes";
import { subscribeToQueue } from "./sse";
import { contentTypeFor, findStaticDir, resolveAssetPath } from "./staticDir";
import { readBody, statusPayload } from "../daemon/serve";
import { LOOPBACK_HOSTS, hostHeaderOk, isAuthorized } from "../daemon/auth";
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
 */
export async function writeWebResponse(
  res: http.ServerResponse,
  out: WebResponse,
  log: WebLog,
): Promise<void> {
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
        return;
      }
      size = info.size;
    } catch {
      writeJson(res, 404, { error: "not found" });
      return;
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
    return;
  }

  if (out.text !== undefined) {
    res.writeHead(out.status, {
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
      "Content-Length": String(Buffer.byteLength(out.text)),
    });
    res.end(out.text);
    return;
  }

  if (out.json !== undefined) {
    const payload = JSON.stringify(out.json);
    res.writeHead(out.status, {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
      "Content-Length": String(Buffer.byteLength(payload)),
    });
    res.end(payload);
    return;
  }

  log(`response with no body for status ${out.status}`);
  writeJson(res, 500, { error: "internal error" });
}

// Legacy scripting paths that predate the /api/ prefix. Anything not in here and
// not under /api/ is an asset request, so this set is what keeps `/app.js` from
// being answered by the JSON router.
const API_PATHS = new Set(["/health", "/status", "/downloads", "/add", "/control"]);

function isApiPath(urlPath: string): boolean {
  return urlPath.startsWith("/api/") || API_PATHS.has(urlPath);
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

  // Fail soft, not open — the same rule daemon/serve.ts enforces. The web UI
  // exposes strictly more than the add API does, so it cannot be laxer.
  if (!LOOPBACK_HOSTS.has(host) && !token) {
    throw new Error(
      `refusing to bind ${host} without a token: pass a token (or set TORLINK_API_TOKEN), or bind 127.0.0.1`,
    );
  }

  const staticRoot = options.staticDir ?? findStaticDir();
  if (!staticRoot) {
    // The only signal a user will get. Without it the API answers fine while
    // every asset 404s, so the browser shows a blank page and the cause — no
    // `npm run build` — is invisible.
    log("warning: no built web assets found (dist/web); run `npm run build`. API only.");
  }

  // Live SSE responses, so close() can end them. Without this, http's close()
  // waits for every connection to end and an event stream never does.
  const streams = new Set<{ res: http.ServerResponse; stop: () => void }>();

  const serveEvents = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: URLSearchParams,
  ): void => {
    // EventSource cannot set request headers, so the token is also accepted as
    // ?k=. Same check either way — the query form is a transport detail, not a
    // weaker door. (It does mean the token can land in a server access log; the
    // alternative is no browser stream at all without a cookie layer.)
    const k = query.get("k");
    const authHeader = req.headers.authorization ?? (k ? `Bearer ${k}` : undefined);
    if (!isAuthorized(token, authHeader)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which holds a stream's
      // frames back until the buffer fills — i.e. forever, for this traffic.
      "X-Accel-Buffering": "no",
    });
    const entry = { res, stop: (): void => {} };
    entry.stop = subscribeToQueue(
      runtime.queue,
      (chunk) => res.write(chunk),
      () => statusPayload(runtime),
    );
    streams.add(entry);
    // "close" fires for a client disconnect and for our own res.end(), which is
    // what makes the teardown single-pathed: whoever ends the stream, the queue
    // listener and both timers go with it.
    req.on("close", () => {
      entry.stop();
      streams.delete(entry);
    });
    log(`GET /api/events -> 200 (stream, ${streams.size} open)`);
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
      if (!token && !hostHeaderOk(req.headers.host)) {
        writeJson(res, 403, { error: "forbidden host" });
        log(`${method} ${urlPath} -> 403 (host)`);
        return;
      }

      // Long-lived, so it is handled before the router: the router's contract is
      // one request in, one complete response out, which a stream is not.
      if (method === "GET" && urlPath === "/api/events") {
        serveEvents(req, res, url.searchParams);
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
            { runtime, token },
            method,
            urlPath,
            url.searchParams,
            req.headers.authorization,
            body.text,
          );
        } catch (err) {
          log(`${method} ${urlPath} threw: ${String(err)}`);
          out = { status: 500, json: { error: "internal error" } };
        }
        await writeWebResponse(res, out, log);
        // /health is a supervisor's liveness poll — logging it would drown
        // everything else in a long-running process.
        if (urlPath !== "/health") log(`${method} ${urlPath} -> ${out.status}`);
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
      await writeWebResponse(
        res,
        { status: 200, filePath: file, headers: { "Content-Type": contentTypeFor(file) } },
        log,
      );
      log(`${method} ${urlPath} -> 200`);
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
  log(`web ui on http://${host}:${bound}${token ? " (token required)" : " (loopback only)"}`);

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
      // No closeIdleConnections() call: since Node 19 close() already drops
      // idle keep-alive sockets itself, so adding one is dead code (verified by
      // mutation — removing it changed nothing). package.json requires >=22.
      // Only a stream, which is never idle, needed the handling above.
      server.close(() => resolve());
    });
    return closed;
  };

  return { port: bound, close };
}
