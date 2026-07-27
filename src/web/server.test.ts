import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, writeWebResponse, type WebServerHandle } from "./server";
import { DownloadQueue } from "../download/queue";
import { StreamSessionRegistry } from "../core/streamSession";
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
