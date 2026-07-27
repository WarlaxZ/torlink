import { describe, expect, it, vi } from "vitest";
import { handleWebApi, type WebDeps } from "./routes";
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

function deps(over: Partial<WebDeps> = {}): WebDeps {
  return {
    runtime: runtime(),
    token: null,
    getPosterImpl: async () => ({ path: "/tmp/posters/abc.jpg", bytes: 42 }),
    ...over,
  };
}

const AUTH = "Bearer secret";

describe("handleWebApi — auth", () => {
  it("serves /health without a token", async () => {
    const res = await handleWebApi(deps({ token: "secret" }), "GET", "/health", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true });
  });

  it("rejects an api call with no credentials when a token is set", async () => {
    const res = await handleWebApi(deps({ token: "secret" }), "GET", "/api/status", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(401);
  });

  // /api/poster is the one route that does NOT delegate to the daemon's
  // handleApi, so it is the only place the router's own token gate is the sole
  // thing standing between an anonymous caller and a server-side fetch. The
  // /api/status case above passes even with the gate deleted, because handleApi
  // re-checks; this one does not.
  it("rejects /api/poster with no credentials when a token is set", async () => {
    const getPosterImpl = vi.fn(async () => ({ path: "/tmp/x.jpg", bytes: 1 }));
    const res = await handleWebApi(
      deps({ token: "secret", getPosterImpl }),
      "GET",
      "/api/poster",
      new URLSearchParams({ url: "https://m.media-amazon.com/a.jpg" }),
      undefined,
      "",
    );
    expect(res.status).toBe(401);
    expect(getPosterImpl).not.toHaveBeenCalled();
  });

  it("accepts a bearer token", async () => {
    const res = await handleWebApi(deps({ token: "secret" }), "GET", "/api/status", new URLSearchParams(), AUTH, "");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ downloads: [], seeds: [] });
  });
});

describe("handleWebApi — aliases", () => {
  it("serves the same payload at /status and /api/status", async () => {
    const d = deps();
    const legacy = await handleWebApi(d, "GET", "/status", new URLSearchParams(), undefined, "");
    const modern = await handleWebApi(d, "GET", "/api/status", new URLSearchParams(), undefined, "");
    expect(modern.json).toEqual(legacy.json);
  });

  it("routes /api/add through the shared add handler", async () => {
    const res = await handleWebApi(deps(), "POST", "/api/add", new URLSearchParams(), undefined, "not-a-magnet");
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "invalid magnet or info hash" });
  });

  it("rejects an unknown control action at /api/control", async () => {
    const res = await handleWebApi(
      deps(),
      "POST",
      "/api/control",
      new URLSearchParams(),
      undefined,
      JSON.stringify({ id: "abc", action: "explode" }),
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "unknown action: explode" });
  });
});

describe("handleWebApi — /api/poster", () => {
  it("returns the cached file path for an allowed host", async () => {
    const url = "https://m.media-amazon.com/images/poster.jpg";
    const res = await handleWebApi(
      deps(),
      "GET",
      "/api/poster",
      new URLSearchParams({ url }),
      undefined,
      "",
    );
    expect(res.status).toBe(200);
    expect(res.filePath).toBe("/tmp/posters/abc.jpg");
    expect(res.headers?.["Content-Type"]).toBe("image/jpeg");
  });

  it("refuses a host outside the allowlist without fetching", async () => {
    const getPosterImpl = vi.fn(async () => ({ path: "/tmp/x.jpg", bytes: 1 }));
    const res = await handleWebApi(
      deps({ getPosterImpl }),
      "GET",
      "/api/poster",
      new URLSearchParams({ url: "http://169.254.169.254/latest/meta-data" }),
      undefined,
      "",
    );
    expect(res.status).toBe(400);
    expect(getPosterImpl).not.toHaveBeenCalled();
  });

  // An allowlisted hostname under a non-http scheme (ftp:, gopher:) clears the
  // host check, so the scheme check is what stops it reaching the fetcher.
  it("refuses a non-http scheme even on an allowed host", async () => {
    const getPosterImpl = vi.fn(async () => ({ path: "/tmp/x.jpg", bytes: 1 }));
    const res = await handleWebApi(
      deps({ getPosterImpl }),
      "GET",
      "/api/poster",
      new URLSearchParams({ url: "ftp://m.media-amazon.com/a.jpg" }),
      undefined,
      "",
    );
    expect(res.status).toBe(400);
    expect(getPosterImpl).not.toHaveBeenCalled();
  });

  it("404s when the poster cannot be cached", async () => {
    const res = await handleWebApi(
      deps({ getPosterImpl: async () => null }),
      "GET",
      "/api/poster",
      new URLSearchParams({ url: "https://m.media-amazon.com/a.jpg" }),
      undefined,
      "",
    );
    expect(res.status).toBe(404);
  });

  it("400s with no url parameter", async () => {
    const res = await handleWebApi(deps(), "GET", "/api/poster", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(400);
  });
});

describe("handleWebApi — unknown routes", () => {
  it("404s an unknown api path", async () => {
    const res = await handleWebApi(deps(), "GET", "/api/nope", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(404);
  });
});
