// Headless HTTP add API: torlnk exposes a tiny local server so another program
// (a seedbox web app, a script, curl) can hand it a torrent over HTTP instead of
// a keypress. It complements the watch folder — same headless runtime, a
// different doorway.
//
// Default port 9161 sits next to Tor's control port (9051 / browser 9151); it's
// deliberately non-standard and overridable with --port. Binds 127.0.0.1 by
// default; exposing it on a public interface requires a token.

import http from "node:http";
import os from "node:os";
import { startRuntime, addInput, type Runtime } from "./runtime";
import { displayHosts, webUrl, type NetInterfaces } from "../web/links";
import { disarmBootMarker } from "../download/bootguard";
import { startSeedReaper } from "./seed-reaper";
import { LOOPBACK_HOSTS, isAuthorized, hostHeaderOk, isCrossSiteHttpRequest } from "./auth";
import { startWebServer, type WebServerHandle } from "../web/server";
import type { StatusPayload } from "../web/wire";
import { VERSION } from "../version";

export { isAuthorized } from "./auth";

export const DEFAULT_API_PORT = 9161;

const MAX_BODY_BYTES = 64 * 1024; // a magnet is small; cap the body hard

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ServeOptions {
  port?: number;
  host?: string;
  token?: string;
  downloadDir?: string;
  /** Stop seeding each torrent this long after it finishes (ms). */
  seedTimeMs?: number;
  /** With seedTimeMs, also delete the files when the timer expires. */
  deleteFiles?: boolean;
  /**
   * Serve the browser UI. It binds this same host and port: the web server
   * already routes the entire daemon API (see web/routes.ts, which delegates
   * every non-/api/ path to handleApi), so a second listener would only be a
   * second copy of the same surface on a port nobody asked for.
   */
  web?: boolean;
  /**
   * Override for `os.networkInterfaces()`, consulted only for a wildcard host
   * to compute the LAN addresses printed alongside the local URL. Real callers
   * never set this — it exists so a test can hand in a fixture NIC list
   * instead of depending on the machine's actual network, the same reason
   * Task 6 injects `isTTY` and `openUrlImpl` rather than reading them live.
   */
  interfaces?: NetInterfaces;
}

// Pull a magnet / info hash out of a request body. Accepts JSON ({ magnet } or
// { infohash }) or a raw body that is itself a magnet or info hash — forgiving,
// so callers don't have to guess the exact envelope.
export function extractMagnet(bodyText: string): string | null {
  const raw = bodyText.trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const val = obj.magnet ?? obj.infohash ?? obj.infoHash ?? obj.hash;
      return typeof val === "string" && val.trim() ? val.trim() : null;
    } catch {
      return null;
    }
  }
  return raw;
}

// Control actions the headless API accepts (POST /control). A seedbox web app
// drives per-torrent buttons through these instead of the interactive keymap.
export const CONTROL_ACTIONS = [
  "pause", // pause an active/queued download
  "resume", // resume a paused download
  "start-seed", // (re)start seeding a finished torrent
  "stop-seed", // stop seeding but keep the files
  "remove", // forget the torrent, keep files on disk
  "delete", // forget the torrent AND delete its files
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export interface ControlRequest {
  id: string;
  action: string;
  deleteFiles: boolean;
}

// Parse a control request body: JSON { id, action, deleteFiles? }. Returns null
// for anything missing the two required string fields; the action string itself
// is validated later so an unknown action gets a precise error.
export function parseControl(bodyText: string): ControlRequest | null {
  const raw = bodyText.trim();
  if (!raw.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const action = typeof obj.action === "string" ? obj.action.trim() : "";
  if (!id || !action) return null;
  return { id, action, deleteFiles: obj.deleteFiles === true };
}

export type ControlOutcome = "ok" | "not-found" | "unknown-action";

// Apply a parsed control request to the queue. Pure over the runtime so it's
// unit-testable with a fake queue.
export async function applyControl(
  runtime: Runtime,
  req: ControlRequest,
): Promise<ControlOutcome> {
  const q = runtime.queue;
  const { id, action, deleteFiles } = req;
  switch (action as ControlAction) {
    case "pause":
      if (!q.has(id)) return "not-found";
      q.pause(id);
      return "ok";
    case "resume":
      if (!q.has(id)) return "not-found";
      q.resume(id);
      return "ok";
    case "stop-seed":
      if (!q.getSeed(id)) return "not-found";
      q.stopSeeding(id);
      return "ok";
    case "start-seed": {
      const h = q.getHistory().find((x) => x.id === id);
      if (!h) return "not-found";
      q.startSeeding(h);
      return "ok";
    }
    case "remove":
    case "delete": {
      const found = await q.remove(id, { deleteFiles: action === "delete" || deleteFiles });
      return found ? "ok" : "not-found";
    }
    default:
      return "unknown-action";
  }
}

// Exported because the web layer's SSE stream pushes exactly this payload. It
// must stay one implementation: a hand-copied version of this in an earlier
// draft silently dropped `uploadSpeed`, so a seed showed a real rate on the
// first fetch and an em dash on every frame after it.
//
// The return type is the shared wire contract (web/wire.ts), which the browser
// imports type-only. That is deliberate and load-bearing: it makes a renamed or
// re-typed field a compile error *here*, at the producer, instead of a field the
// dashboard reads as `undefined` and renders as nothing.
export function statusPayload(runtime: Runtime): StatusPayload {
  const downloads = runtime.queue.getItems().map((it) => ({
    id: it.id,
    name: it.name,
    status: it.status,
    // Integer percent 0–100, passed straight through — the same number the TUI
    // prints as `${it.progress}%`. Do not scale it here: the browser's
    // clampPercent once read this as a 0..1 fraction and showed every
    // in-progress download at 100%.
    progress: it.progress,
    peers: it.peers,
    speed: it.speed,
  }));
  const seeds = runtime.queue.getSeeds().map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    peers: s.peers,
    uploaded: s.uploaded,
    uploadSpeed: s.uploadSpeed,
  }));
  return { downloads, seeds };
}

// Pure request router — no node:http types, so it's trivially testable.
export async function handleApi(
  runtime: Runtime,
  token: string | null,
  method: string,
  urlPath: string,
  authHeader: string | undefined,
  bodyText: string,
): Promise<ApiResponse> {
  if (method === "GET" && urlPath === "/health") {
    return { status: 200, body: { ok: true, version: VERSION } };
  }
  if (!isAuthorized(token, authHeader)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (method === "GET" && (urlPath === "/downloads" || urlPath === "/status")) {
    // Spread, not passed through: ApiResponse.body is a Record<string, unknown>
    // and an interface has no implicit index signature, so the spread is what
    // adapts the declared payload type to it. It is a shallow copy of two array
    // references, and it keeps `statusPayload`'s return type declared (which is
    // the whole point — a renamed field must fail to compile there).
    return { status: 200, body: { ...statusPayload(runtime) } };
  }
  if (method === "POST" && urlPath === "/add") {
    const magnet = extractMagnet(bodyText);
    if (!magnet) return { status: 400, body: { error: "missing magnet or info hash" } };
    const outcome = await addInput(runtime, magnet);
    if (outcome === "invalid") return { status: 400, body: { error: "invalid magnet or info hash" } };
    return { status: 200, body: { ok: true, outcome } };
  }
  if (method === "POST" && urlPath === "/control") {
    const req = parseControl(bodyText);
    if (!req) return { status: 400, body: { error: "missing or invalid { id, action }" } };
    const outcome = await applyControl(runtime, req);
    if (outcome === "unknown-action") {
      return { status: 400, body: { error: `unknown action: ${req.action}` } };
    }
    if (outcome === "not-found") return { status: 404, body: { error: "no such torrent" } };
    return { status: 200, body: { ok: true, id: req.id, action: req.action } };
  }
  return { status: 404, body: { error: "not found" } };
}

// Read the body up to the size cap. On overflow resolve tooLarge immediately
// (further chunks are ignored) so the caller can answer 413 on a live socket
// and close the connection afterwards, instead of writing to a destroyed one.
export function readBody(req: http.IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        resolve({ text: "", tooLarge: true });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ text: Buffer.concat(chunks).toString("utf8"), tooLarge: false });
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      resolve({ text: "", tooLarge: false });
    });
  });
}

function log(message: string): void {
  console.log(`[torlnk serve] ${new Date().toISOString()} ${message}`);
}

/**
 * Bail out of a startup that has already called `startRuntime()`.
 *
 * `startRuntime` arms the crash-boot marker (download/bootguard.ts) just before
 * it hands persisted state to the engine, and only two things disarm it: a
 * 4-second **unref'd** timer, and `queue.suspend()` on a clean quit. A bind
 * failure lands in milliseconds, so `process.exit(1)` here used to leave the
 * marker on disk — and the *next* launch of any mode (TUI included) came up in
 * safe mode with every restored download and seed paused, announcing "recovered
 * from a crashed start". `torlnk serve --web` against a port a TUI is already
 * hosting on is an easy way to trigger it.
 *
 * `disarmBootMarker()`, not `queue.suspend()`: the marker file is the only thing
 * that outlives this process, and it is exactly what needs clearing. `suspend()`
 * would clear it too (via persistSync) but would also write the whole restored
 * queue, history and seed set back to disk from a run that never started — a
 * state write with nothing to add and a mid-write window to lose. Everything
 * else `suspend()` tears down (the poll interval, the webtorrent engine) dies
 * with the process on the next line.
 *
 * The web server does need closing: it binds a real socket and, on the API
 * failure path, is already listening.
 */
async function failStartup(message: string, web: WebServerHandle | null): Promise<void> {
  console.error(message);
  await web?.close();
  disarmBootMarker();
  process.exit(1);
}

export async function runServe(options: ServeOptions = {}): Promise<void> {
  const port = options.port ?? DEFAULT_API_PORT;
  const host = options.host ?? "127.0.0.1";
  const token = options.token && options.token.trim() ? options.token.trim() : null;

  // Fail soft, not open: never expose a public interface without a token.
  if (!LOOPBACK_HOSTS.has(host) && !token) {
    console.error(
      `error: refusing to bind ${host} without a token. Pass --token <secret> ` +
        `(or set TORLINK_API_TOKEN), or bind 127.0.0.1.`,
    );
    process.exit(1);
    return;
  }

  const runtime = await startRuntime(options.downloadDir);

  if (options.seedTimeMs && options.seedTimeMs > 0) {
    startSeedReaper(runtime.queue, options.seedTimeMs, { deleteFiles: options.deleteFiles, log });
  }

  // With --web there is one server, not two. It binds the port the user chose,
  // and answers both the dashboard and the add API — one process, one address,
  // one exposure decision.

  // The URL a browser on this machine should open — set once the web server is
  // up, so the browser-open below and the log above cannot disagree.
  let localUrl: string | null = null;
  let web: WebServerHandle | null = null;
  if (options.web) {
    try {
      web = await startWebServer(runtime, {
        port,
        host,
        ...(token ? { token } : {}),
        log,
      });
    } catch (e) {
      // A startup failure, not a degraded mode: coming up with the dashboard
      // silently missing is worse than not coming up at all.
      await failStartup(
        `error: could not start the web ui on port ${port}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        null,
      );
      return;
    }
    // The handle's port, not the requested one: it reports what was actually
    // bound, which is the only correct answer once `port: 0` is in play.
    const bound = web.port;
    const { local, lan } = displayHosts(host, options.interfaces ?? os.networkInterfaces());
    // One place for token + bound to reach every URL this block logs, so
    // Task 6's browser-open target (`localUrl`) and every line below it are
    // built the same way and cannot drift apart.
    const link = (h: string): string => webUrl(h, bound, token ?? undefined);
    localUrl = link(local);
    // The marker comes before the URL, not after: it lines up in a column
    // regardless of address width, and it leaves the pasteable URL last on the
    // line, which is where an 80-column wrap does the least damage. The bind
    // line above (web/server.ts) already states the auth mode, so it is not
    // repeated here.
    log(`open on this machine:  ${localUrl}`);
    for (const address of lan) {
      log(`open from your LAN:    ${link(address)}`);
    }
    log(`api + web ui on one port, downloads -> ${runtime.downloadDir}`);
  }

  // The bare JSON API, for a daemon running without the dashboard. A function
  // rather than an inline expression so the --web case reads as one line: with
  // --web this server is not built at all, because the web server above already
  // answers every route it would have.
  const createApiServer = (): http.Server =>
    http.createServer((req, res) => {
      void (async () => {
        const method = req.method ?? "GET";
        const urlPath = (req.url ?? "/").split("?")[0]!;
        // Tokenless means loopback-bound; require a loopback Host so a hostile
        // webpage can't reach us through DNS rebinding.
        if (!token && !hostHeaderOk(req.headers.host)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "forbidden host" }));
          log(`${method} ${urlPath} -> 403 (host)`);
          return;
        }
        // CSRF: a browser page on another origin can reach this port with a POST
        // that passes both guards above (it sets Host itself, and tokenless means
        // no credential to forge), which for `{"action":"delete"}` means deleting
        // a visitor's files. Rejected only when the headers positively say
        // cross-site, so curl and scripts — which send neither header — keep
        // working. GETs are untouched.
        if (method !== "GET" && method !== "HEAD" && isCrossSiteHttpRequest(req.headers)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "cross-site request blocked" }));
          log(`${method} ${urlPath} -> 403 (cross-site)`);
          return;
        }
        const body = method === "POST" ? await readBody(req) : { text: "", tooLarge: false };
        if (body.tooLarge) {
          res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ error: "body too large" }));
          res.once("finish", () => req.destroy());
          log(`${method} ${urlPath} -> 413`);
          return;
        }
        const bodyText = body.text;
        let out: ApiResponse;
        try {
          out = await handleApi(runtime, token, method, urlPath, req.headers.authorization, bodyText);
        } catch {
          out = { status: 500, body: { error: "internal error" } };
        }
        const payload = JSON.stringify(out.body);
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(payload);
        if (method !== "GET" || urlPath !== "/health") {
          log(`${method} ${urlPath} -> ${out.status}`);
        }
      })();
    });

  const server = options.web ? null : createApiServer();

  // A bind failure arrives as an 'error' event, not a throw. Unhandled it is an
  // uncaught exception — an EADDRINUSE stack trace, which reads like a crash
  // rather than "that port is taken". Turned into the same one-line refusal the
  // host/token guard above uses. Detached once listening so a later runtime error
  // still goes somewhere.
  if (server) {
    const listenErr = await new Promise<Error | null>((resolve) => {
      const onError = (err: Error): void => resolve(err);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        log(`listening on http://${host}:${port}  (downloads -> ${runtime.downloadDir})`);
        log(token ? "auth: token required" : "auth: none (loopback only)");
        resolve(null);
      });
    });
    if (listenErr) {
      await failStartup(`error: could not start the api on port ${port}: ${listenErr.message}`, web);
      return;
    }
  }

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      // Re-entry guard, and the handlers come off immediately: SIGINT and SIGTERM
      // can both arrive (a supervisor signalling while the user hits Ctrl-C), and
      // a second pass would call suspend() again mid-teardown. It also means the
      // *third* Ctrl-C reaches Node's default handler and kills the process,
      // which is the escape hatch a hung shutdown needs to leave open.
      if (shuttingDown) return;
      shuttingDown = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void (async () => {
        // Order matters. The API server first, so nothing new arrives. Then the web
        // server, which ends its event streams and cuts any half-open browser
        // socket — a request genuinely mid-flight is sacrificed, deliberately, so a
        // quit can never block on a browser. Then the stream sessions, which can
        // only shrink once no new one can be started. The queue last: it is what
        // the streams and requests were reading, so suspending it first would tear
        // state out from under work still unwinding.
        if (server) {
          await new Promise<void>((done) => {
            server.close(() => done());
            // The same fix web/server.ts documents for the web server, and for
            // the same reason: close() stops accepting and then waits for open
            // connections to end, and a socket that is connected with no
            // *complete* request in flight — a browser preconnect, a TCP health
            // probe, a port scan, half-sent headers — never ends. One bare
            // `net.connect` used to make Ctrl-C hang here forever, which is also
            // what made `daemon/restart.ts` give up after 10s and report
            // stillRunning: true, leaving `torlnk update` with the old daemon
            // still alive.
            server.closeAllConnections();
          });
        }
        // Both are awaited so the order above is real, and both swallow a
        // rejection: a failure to tear one thing down must not skip suspend()
        // (which is what flushes state and disarms the boot marker) or leave this
        // promise unsettled, i.e. hang the very quit it was meant to unblock.
        await web?.close().catch(() => {});
        await runtime.sessions.stopAll().catch(() => {});
        runtime.queue.suspend();
        // Resolved only once everything above is actually down, so a caller that
        // awaits runServe (the tests, and any future in-process host) is waiting
        // on a finished shutdown rather than on a started one.
        resolve();
      })();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
