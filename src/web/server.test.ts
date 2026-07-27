import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type WebServerHandle } from "./server";
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

afterEach(async () => {
  await handle?.close();
  handle = null;
});

async function start(over: Parameters<typeof startWebServer>[1] = {}): Promise<string> {
  handle = await startWebServer(runtime(), { port: 0, host: "127.0.0.1", log: () => {}, ...over });
  return `http://127.0.0.1:${handle.port}`;
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

  it("never writes to the console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const base = await start();
      await fetch(`${base}/api/status`);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
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
});
