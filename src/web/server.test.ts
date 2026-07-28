import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, writeWebResponse, type WebServerHandle } from "./server";
import { DownloadQueue } from "../download/queue";
import { StreamSessionRegistry } from "../core/streamSession";
import { SOURCES } from "../sources/registry";
import { defaultConfig, type Config } from "../config/config";
import type { TorrentResult } from "../sources/types";
import type { Runtime } from "../daemon/runtime";

function runtime(): Runtime {
  return {
    queue: new DownloadQueue(),
    downloadDir: "/tmp/dl",
    sessions: new StreamSessionRegistry(),
  };
}

let handle: WebServerHandle | null = null;
// The runtime the current server is running against, so a test can inspect the
// queue's listeners while a stream is open.
let live: Runtime;

// Every directory assets() has handed out, so afterEach can remove them. The
// factory records them itself rather than each test remembering to: there are
// nine call sites and closing the server handle alone left 484 stray
// /tmp/torlnk-web-* trees on one dev machine.
const assetDirs: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = null;
  while (assetDirs.length) rmSync(assetDirs.pop()!, { recursive: true, force: true });
});

async function start(over: Parameters<typeof startWebServer>[1] = {}): Promise<string> {
  live = runtime();
  handle = await startWebServer(live, { port: 0, host: "127.0.0.1", log: () => {}, ...over });
  return `http://127.0.0.1:${handle.port}`;
}

// A minimal built-assets directory, plus a subdirectory so the isFile() guard
// has something to trip over.
function assets(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "torlnk-web-"));
  assetDirs.push(dir);
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>dash</title>");
  writeFileSync(path.join(dir, "app.js"), "export const x = 1;\n");
  writeFileSync(path.join(dir, "app.js.map"), '{"version":3}');
  mkdirSync(path.join(dir, "sub"));
  return dir;
}

// Read SSE frames until `want` of them have arrived, then hang up.
async function readFrames(url: string, want: number, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while ((text.match(/\n\n/g)?.length ?? 0) < want) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

describe("startWebServer", () => {
  it("listens and serves health", async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("serves the JSON status", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ downloads: [], seeds: [] });
  });

  it("requires the token when one is set", async () => {
    const base = await start({ token: "secret" });
    await expect(fetch(`${base}/api/status`).then((r) => r.status)).resolves.toBe(401);
    const ok = await fetch(`${base}/api/status`, { headers: { Authorization: "Bearer secret" } });
    expect(ok.status).toBe(200);
  });

  // Node's fetch() silently DROPS a Host header override (verified: the server
  // still sees 127.0.0.1). Use raw http.request, which honours it — otherwise
  // this test would send a loopback Host, get 200, and quietly stop covering
  // the DNS-rebinding guard it exists for.
  it("rejects a non-loopback Host header when tokenless", async () => {
    await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: handle!.port,
          path: "/api/status",
          method: "GET",
          headers: { Host: "evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("refuses to bind a public host without a token", async () => {
    await expect(
      startWebServer(runtime(), { port: 0, host: "0.0.0.0", log: () => {} }),
    ).rejects.toThrow(/token/i);
  });

  // The other half of the bind rule: a token is what makes a public bind legal,
  // so the guard must be about the *pair*. A guard that only looked at the host
  // would make --web-host 0.0.0.0 impossible however it was configured.
  it("binds a public host when a token is set", async () => {
    handle = await startWebServer(runtime(), {
      port: 0,
      host: "0.0.0.0",
      token: "secret",
      log: () => {},
    });
    expect(handle.port).toBeGreaterThan(0);
  });

  // The Host check is the *substitute* for a token, not an addition to it. A
  // tokened server is reachable by name or from another host on purpose, and
  // rebinding buys an attacker nothing there because they still lack the token.
  it("allows a non-loopback Host header once a token is set", async () => {
    await start({ token: "secret" });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: handle!.port,
          path: "/api/status",
          method: "GET",
          headers: { Host: "torlnk.example", Authorization: "Bearer secret" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  // Any console method corrupts an Ink frame, not just log, so all three are
  // spied — a stray console.warn is exactly as damaging and easier to leave in.
  it("never writes to the console", async () => {
    const spies = (["log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const base = await start();
      await fetch(`${base}/api/status`);
      await fetch(`${base}/nope.js`);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  // Supervisors liveness-poll with HEAD as often as GET, and /health is excluded
  // from the log, so a 404 here would be an invisible monitoring failure.
  it("answers HEAD on an API path like GET", async () => {
    const base = await start();
    const res = await fetch(`${base}/health`, { method: "HEAD" });
    expect(res.status).toBe(200);
    // Node drops the body for HEAD but keeps the length, so the header is the
    // only evidence the handler actually ran rather than short-circuiting.
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    await expect(res.text()).resolves.toBe("");
    expect((await fetch(`${base}/api/status`, { method: "HEAD" })).status).toBe(200);
  });

  // The server's "is this the router's or an asset's?" test must agree with what
  // handleApi actually implements. Asserting each legacy path is *not* treated as
  // an asset is what catches a path added to one table and not the other.
  it("routes every legacy API path to the router, not the asset handler", async () => {
    const base = await start({ staticDir: assets() });
    for (const p of ["/health", "/status", "/downloads"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("content-type"), p).toBe("application/json; charset=utf-8");
    }
    for (const p of ["/add", "/control"]) {
      // A GET on a POST-only route is the router's 404, not the asset 404 — the
      // point is only that the asset branch never saw it.
      const res = await fetch(`${base}${p}`);
      expect(res.headers.get("content-type"), p).toBe("application/json; charset=utf-8");
    }
  });

  it("uses the injected logger instead", async () => {
    const log = vi.fn();
    handle = await startWebServer(runtime(), { port: 0, host: "127.0.0.1", log });
    await fetch(`http://127.0.0.1:${handle.port}/api/status`);
    expect(log).toHaveBeenCalled();
  });

  it("closes cleanly", async () => {
    const base = await start();
    await handle!.close();
    const closed = handle;
    handle = null;
    await expect(fetch(`${base}/health`)).rejects.toThrow();
    await expect(closed!.close()).resolves.toBeUndefined();
  });

  // The other class of connection that blocks http.Server.close(): connected,
  // but with no complete request in flight, so it is neither idle nor
  // finishable. Browsers open speculative preconnect sockets like this, and any
  // TCP health probe or port scan leaves one — so without closeAllConnections()
  // a TUI quit blocks forever on something the user never asked for.
  it("does not hang on close() with a connected socket that never sends a request", async () => {
    await start();
    const sock = net.connect(handle!.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    const raced = await Promise.race([
      handle!.close().then(() => "closed"),
      new Promise((r) => setTimeout(() => r("hung"), 2000).unref()),
    ]);
    expect(raced).toBe("closed");
    sock.destroy();
    handle = null;
  });

  it("does not hang on close() with half-sent request headers", async () => {
    await start();
    const sock = net.connect(handle!.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    // A request line with no terminating blank line: the server is still waiting
    // for the rest, so this connection can never complete on its own.
    sock.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    await new Promise((r) => setTimeout(r, 50));
    const raced = await Promise.race([
      handle!.close().then(() => "closed"),
      new Promise((r) => setTimeout(() => r("hung"), 2000).unref()),
    ]);
    expect(raced).toBe("closed");
    sock.destroy();
    handle = null;
  });

  // CSRF. Tokenless is the normal way to run this, and tokenless means there is
  // no credential for a hostile page to forge — Host is set by the browser to
  // whatever it is targeting, so it proves nothing. `delete` reaches
  // queue.remove(id, { deleteFiles: true }).
  describe("cross-site POSTs", () => {
    const control = { id: "abc", action: "delete" };

    it("rejects a POST a browser labelled cross-site", async () => {
      const base = await start();
      const cases: Record<string, string>[] = [
        { origin: "https://evil.example" },
        { "sec-fetch-site": "cross-site" },
        { origin: "http://127.0.0.1:3000" }, // another local page, another port
      ];
      for (const headers of cases) {
        const res = await fetch(`${base}/api/control`, {
          method: "POST",
          headers,
          body: JSON.stringify(control),
        });
        expect(res.status, JSON.stringify(headers)).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: "cross-site request blocked" });
      }
    });

    // The stream routes are mutating and unauthenticated in the default
    // (tokenless, loopback) setup, exactly like /api/control: a POST starts a
    // swarm or spends the user's Real-Debrid account, a DELETE can delete
    // downloaded files. They were added on the assumption that living under
    // /api/* means the gate above already covers them — asserted here rather
    // than assumed, because the gate is in server.ts and the routes are not.
    // A 403 also proves nothing reached the router: the session registry is
    // untouched and no config was read.
    it("rejects a cross-site POST /api/stream before it reaches the router", async () => {
      const base = await start();
      const res = await fetch(`${base}/api/stream`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: JSON.stringify({ magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" }),
      });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: "cross-site request blocked" });
      expect(live.sessions.list()).toEqual([]);
    });

    it("rejects a cross-site DELETE /api/stream/:sid", async () => {
      const base = await start();
      const res = await fetch(`${base}/api/stream/sess1?keep=1`, {
        method: "DELETE",
        headers: { "sec-fetch-site": "cross-site" },
      });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: "cross-site request blocked" });
    });

    it("allows the dashboard's own same-origin POST", async () => {
      const base = await start();
      const res = await fetch(`${base}/api/control`, {
        method: "POST",
        headers: { origin: base, "sec-fetch-site": "same-origin" },
        body: JSON.stringify(control),
      });
      // 404 = "no such torrent", i.e. it reached the handler. Not 403.
      expect(res.status).toBe(404);
    });

    it("allows a curl-shaped POST with no Origin at all", async () => {
      const base = await start();
      // The existing API contract: a loopback POST from a shell works. This is
      // the request curl actually sends — no Origin, no Sec-Fetch-Site, and (as
      // curl does by default here) no JSON content type either.
      const res = await fetch(`${base}/api/control`, {
        method: "POST",
        body: JSON.stringify(control),
      });
      expect(res.status).toBe(404);
    });

    it("leaves GETs alone", async () => {
      const base = await start();
      const res = await fetch(`${base}/api/status`, { headers: { origin: "https://evil.example" } });
      // A cross-origin *read* is the browser's own CORS check to fail, and the
      // dashboard's EventSource cannot set headers, so GETs are not gated here.
      expect(res.status).toBe(200);
    });
  });

  it("caps the request body at 64KB with a 413", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/add`, { method: "POST", body: "x".repeat(64 * 1024 + 1) });
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "body too large" });
  });

  it("accepts a body just under the cap", async () => {
    const base = await start();
    // Not a magnet, so 400 — the point is that it was read rather than refused.
    const res = await fetch(`${base}/api/add`, { method: "POST", body: "x".repeat(64 * 1024) });
    expect(res.status).toBe(400);
  });

  describe("static assets", () => {
    it("serves index.html at /", async () => {
      const base = await start({ staticDir: assets() });
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      await expect(res.text()).resolves.toContain("<title>dash</title>");
    });

    it("serves a sourcemap as JSON", async () => {
      const base = await start({ staticDir: assets() });
      const res = await fetch(`${base}/app.js.map`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    });

    it("sets Content-Length from a stat at send time", async () => {
      const base = await start({ staticDir: assets() });
      const res = await fetch(`${base}/app.js`);
      const body = await res.text();
      expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
    });

    // resolveAssetPath proves containment but not that the target is a file, so
    // without the isFile() check this streams a directory and dies with EISDIR
    // *after* the 200 header is out — a hang or a truncated body, not a 404.
    it("404s a path that resolves to a directory", async () => {
      const base = await start({ staticDir: assets() });
      const res = await fetch(`${base}/sub`);
      expect(res.status).toBe(404);
    });

    it("404s a missing file", async () => {
      const base = await start({ staticDir: assets() });
      expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    });

    // A null from resolveAssetPath is an escape attempt or a malformed path —
    // the client's error, so 400, not the 404 a missing file gets.
    it("400s a traversal attempt", async () => {
      const base = await start({ staticDir: assets() });
      const res = await fetch(`${base}/%2e%2e%2fsecret`);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad path" });
    });

    it("warns through the log when no assets are found", async () => {
      const log = vi.fn();
      handle = await startWebServer(runtime(), {
        port: 0,
        host: "127.0.0.1",
        log,
        // The real null branch, injected. Not a falsy staticDir: that sentinel
        // would fall through to the real findStaticDir() the moment this
        // validated its input, and that finds dist/web on a built checkout and
        // not on a fresh one — a test that passes or fails by machine.
        findStaticDirImpl: () => null,
      });
      expect(log.mock.calls.flat().join("\n")).toMatch(/no built web assets/i);
      // API still works; only the browser half is missing.
      expect((await fetch(`http://127.0.0.1:${handle.port}/api/status`)).status).toBe(200);
    });

    // The log must report what the client received. Logging a hardcoded 200 here
    // made every per-request asset failure read as a success, which is precisely
    // what the missing-assets warning exists to prevent.
    it("logs the status the client actually got, not the one intended", async () => {
      const log = vi.fn();
      const dir = assets();
      handle = await startWebServer(runtime(), { port: 0, host: "127.0.0.1", log, staticDir: dir });
      const base = `http://127.0.0.1:${handle.port}`;
      expect((await fetch(`${base}/nope.js`)).status).toBe(404);
      expect((await fetch(`${base}/sub`)).status).toBe(404);
      const lines = log.mock.calls.flat().join("\n");
      expect(lines).toContain("GET /nope.js -> 404");
      expect(lines).toContain("GET /sub -> 404");
      expect(lines).not.toContain("-> 200");
    });
  });

  describe("/api/events", () => {
    it("streams an initial status frame", async () => {
      const base = await start();
      const text = await readFrames(`${base}/api/events`, 1);
      expect(text).toContain("event: status");
      expect(text).toContain('"downloads":[]');
    });

    it("requires the token via the Authorization header", async () => {
      const base = await start({ token: "secret" });
      expect((await fetch(`${base}/api/events`)).status).toBe(401);
      const text = await readFrames(`${base}/api/events`, 1, {
        headers: { Authorization: "Bearer secret" },
      });
      expect(text).toContain("event: status");
    });

    it("requires the token and accepts it via ?k= (EventSource cannot send headers)", async () => {
      const base = await start({ token: "secret" });
      expect((await fetch(`${base}/api/events?k=wrong`)).status).toBe(401);
      const text = await readFrames(`${base}/api/events?k=secret`, 1);
      expect(text).toContain("event: status");
    });

    // The teardown proof: subscribeToQueue registers one `update` listener per
    // client, so a disconnect that does not fire its stop() leaks one per
    // reconnect on a daemon that runs for weeks.
    it("removes its queue listener when the client disconnects", async () => {
      const base = await start();
      const before = live.queue.listenerCount("update");
      const res = await fetch(`${base}/api/events`);
      const reader = res.body!.getReader();
      await reader.read();
      expect(live.queue.listenerCount("update")).toBe(before + 1);
      await reader.cancel();
      await vi.waitFor(() => expect(live.queue.listenerCount("update")).toBe(before));
    });

    // http.Server.close() waits for open connections, and an event stream never
    // ends on its own: without close() ending the streams first, quitting the
    // TUI would block until the browser tab was shut.
    it("logs a rejected stream", async () => {
      const log = vi.fn();
      handle = await startWebServer(runtime(), { port: 0, host: "127.0.0.1", log, token: "s" });
      await fetch(`http://127.0.0.1:${handle.port}/api/events`);
      expect(log.mock.calls.flat().join("\n")).toContain("/api/events -> 401");
    });

    it("does not hang on close() with a stream open", async () => {
      const base = await start();
      const res = await fetch(`${base}/api/events`);
      const reader = res.body!.getReader();
      await reader.read();
      const closed = handle!.close();
      const raced = await Promise.race([
        closed.then(() => "closed"),
        new Promise((r) => setTimeout(() => r("hung"), 2000).unref()),
      ]);
      expect(raced).toBe("closed");
      expect(live.queue.listenerCount("update")).toBe(0);
      await reader.cancel().catch(() => {});
      handle = null;
    });
  });
});

describe("writeWebResponse", () => {
  // A stand-in for ServerResponse: only writeHead/end are reached on these paths.
  interface Rec {
    status: number | null;
    headers: Record<string, string>;
    body: string | null;
    res: http.ServerResponse;
  }
  function fakeRes(): Rec {
    const rec: Rec = { status: null, headers: {}, body: null, res: null as never };
    rec.res = {
      writeHead(status: number, headers?: Record<string, string>) {
        rec.status = status;
        rec.headers = headers ?? {};
        return this;
      },
      end(body?: string) {
        rec.body = body ?? "";
      },
    } as unknown as http.ServerResponse;
    return rec;
  }

  it("prefers text over json when both are present", async () => {
    const r = fakeRes();
    await writeWebResponse(r.res, { status: 200, text: "plain", json: { a: 1 } }, () => {});
    expect(r.body).toBe("plain");
    expect(r.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
  });

  it("serialises json when there is no text", async () => {
    const r = fakeRes();
    const wrote = await writeWebResponse(r.res, { status: 201, json: { a: 1 } }, () => {});
    expect(r.status).toBe(201);
    expect(r.body).toBe('{"a":1}');
    // The return value is what the caller logs, so it must track what was sent.
    expect(wrote).toBe(201);
  });

  it("lets a response override the default Content-Type", async () => {
    const r = fakeRes();
    await writeWebResponse(
      r.res,
      { status: 200, text: "x", headers: { "Content-Type": "text/csv" } },
      () => {},
    );
    expect(r.headers["Content-Type"]).toBe("text/csv");
  });

  // A body-less response is a router bug. Answering it with an empty 200 would
  // hand a browser a blank page with nothing in the log to explain it.
  it("turns a body-less response into a logged 500", async () => {
    const r = fakeRes();
    const log = vi.fn();
    const wrote = await writeWebResponse(r.res, { status: 200 }, log);
    expect(r.status).toBe(500);
    expect(r.body).toBe('{"error":"internal error"}');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no body/i));
    // Not 200: the caller logs this, and reporting the intended status would
    // record an internal error as a success.
    expect(wrote).toBe(500);
  });

  it("reports 404 rather than the intended status for a missing file", async () => {
    const r = fakeRes();
    const wrote = await writeWebResponse(
      r.res,
      { status: 200, filePath: path.join(tmpdir(), "torlnk-definitely-absent-file") },
      () => {},
    );
    expect(r.status).toBe(404);
    expect(wrote).toBe(404);
  });
});

describe("/api/search", () => {
  const cfg = (over: Partial<Config> = {}): Config => ({
    ...defaultConfig,
    downloadDir: "/tmp/dl",
    ...over,
  });

  // Everything except the two named, i.e. the disabledSources that leaves those
  // two enabled. Keeps these socket-level tests to a two-source fan-out.
  const onlyTwo = SOURCES.filter((s) => s.id !== "yts" && s.id !== "eztv").map((s) => s.id);

  function hit(source: string): TorrentResult {
    return {
      infoHash: source.padEnd(40, "0"),
      name: `${source} result`,
      sizeBytes: 10,
      seeders: 1,
      leechers: 0,
      source: source as TorrentResult["source"],
      magnet: `magnet:?xt=urn:btih:${source.padEnd(40, "0")}`,
    };
  }

  function searchServer(over: Parameters<typeof startWebServer>[1] = {}): Promise<string> {
    return start({
      webDeps: {
        loadConfigImpl: async () => cfg({ disabledSources: onlyTwo }),
        sourceHealthImpl: new Map(),
        searchImpl: async (source) => [hit(source.id)],
      },
      ...over,
    });
  }

  it("streams a frame per source and then done", async () => {
    const base = await searchServer();
    const res = await fetch(`${base}/api/search?q=bunny`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const text = await res.text();
    // The opening "all loading" frame, then one per settled source.
    expect(text.match(/event: results/g)).toHaveLength(3);
    expect(text).toContain("event: done");
    expect(text).toContain("yts result");
    // The magnet must not be on the wire. See PublicSearchResult in wire.ts.
    expect(text).not.toContain("magnet:");
  });

  it("narrows to a group", async () => {
    const base = await searchServer({
      webDeps: {
        loadConfigImpl: async () => cfg({ disabledSources: onlyTwo }),
        sourceHealthImpl: new Map(),
        searchImpl: async (source) => [hit(source.id)],
      },
    });
    const text = await (await fetch(`${base}/api/search?q=bunny&group=TV`)).text();
    expect(text).toContain("eztv result");
    expect(text).not.toContain("yts result");
  });

  // Browse mode: q present but blank. The server must not 400 this, and the
  // stream must complete exactly like a real search.
  it("streams a blank query as browse", async () => {
    const base = await searchServer();
    const res = await fetch(`${base}/api/search?q=`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const text = await res.text();
    expect(text.match(/event: results/g)).toHaveLength(3);
    expect(text).toContain("event: done");
    expect(text).toContain("yts result");
  });

  it("narrows a browse to a group", async () => {
    const base = await searchServer();
    const text = await (await fetch(`${base}/api/search?q=&group=TV`)).text();
    expect(text).toContain("eztv result");
    expect(text).not.toContain("yts result");
  });

  // A search spends the user's bandwidth on up to 23 requests to public
  // trackers, so an anonymous caller with a loop is a traffic amplifier.
  it("401s without credentials when a token is set", async () => {
    const base = await searchServer({ token: "secret" });
    const res = await fetch(`${base}/api/search?q=bunny`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("401s on a wrong ?k= and accepts the right one", async () => {
    const base = await searchServer({ token: "secret" });
    expect((await fetch(`${base}/api/search?q=bunny&k=wrong`)).status).toBe(401);
    const ok = await fetch(`${base}/api/search?q=bunny&k=secret`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("event: done");
  });

  it("accepts a bearer header too", async () => {
    const base = await searchServer({ token: "secret" });
    const res = await fetch(`${base}/api/search?q=bunny`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  // Validated before the headers go out: once a 200 text/event-stream is on the
  // socket, "you asked wrong" can only be a frame the client has to parse.
  it.each([
    ["/api/search", "missing query"],
    ["/api/search?q=x&group=Films", "unknown group"],
  ])("400s %s as a real status, not an error frame", async (path, error) => {
    const base = await searchServer();
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it("does not log the user's search terms", async () => {
    const log = vi.fn();
    const base = await searchServer({ log });
    await (await fetch(`${base}/api/search?q=something%20private`)).text();
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).toContain("/api/search -> 200");
    expect(logged).not.toContain("private");
  });

  /**
   * THE DISCONNECT ABORT, over a real socket.
   *
   * The frames prove nothing here — a stopped channel writes nothing whether or
   * not the sources were cancelled — so this asserts the abort signals the
   * sources were actually handed. Without the teardown, a closed tab leaves two
   * (in production, 23) tracker requests running to their 25s timeouts.
   */
  it("aborts every in-flight source request when the client hangs up", async () => {
    const signals: AbortSignal[] = [];
    const base = await start({
      webDeps: {
        loadConfigImpl: async () => cfg({ disabledSources: onlyTwo }),
        sourceHealthImpl: new Map(),
        searchImpl: async (_source, _query, opts) =>
          new Promise<TorrentResult[]>((_resolve, reject) => {
            signals.push(opts.signal!);
            opts.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    });

    const controller = new AbortController();
    const res = await fetch(`${base}/api/search?q=bunny`, { signal: controller.signal });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals.some((s) => s.aborted)).toBe(false);

    controller.abort();
    await vi.waitFor(() => expect(signals.every((s) => s.aborted)).toBe(true));
  });

  it("aborts the search when the server closes rather than blocking on it", async () => {
    const signals: AbortSignal[] = [];
    const base = await start({
      webDeps: {
        loadConfigImpl: async () => cfg({ disabledSources: onlyTwo }),
        sourceHealthImpl: new Map(),
        searchImpl: async (_source, _query, opts) =>
          new Promise<TorrentResult[]>((_resolve, reject) => {
            signals.push(opts.signal!);
            opts.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    });
    const controller = new AbortController();
    void fetch(`${base}/api/search?q=bunny`, { signal: controller.signal }).catch(() => {});
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    await handle!.close();
    handle = null;
    expect(signals.every((s) => s.aborted)).toBe(true);
    controller.abort();
  });
});

describe("/api/sources and /api/title over HTTP", () => {
  it("serves the source list", async () => {
    const base = await start({
      webDeps: { loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl" }) },
    });
    const res = await fetch(`${base}/api/sources`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: { group: string }[]; adultEnabled: boolean };
    expect(body.adultEnabled).toBe(false);
    expect(body.groups.map((g) => g.group)).toContain("Movies");
  });

  it("answers the no-key title lookup with a 200, not a 500", async () => {
    vi.stubEnv("TORLINK_OMDB_KEY", "");
    try {
      const base = await start({
        webDeps: { loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl" }) },
      });
      const res = await fetch(`${base}/api/title?name=Sintel&year=2010`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "no-key" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
