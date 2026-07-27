import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebApi, streamHandle, toPublicSession, type WebDeps } from "./routes";
import { DownloadQueue } from "../download/queue";
import { defaultConfig } from "../config/config";
import { StreamSessionRegistry, type StreamSession } from "../core/streamSession";
import type { Runtime } from "../daemon/runtime";

function runtime(sessions = new StreamSessionRegistry()): Runtime {
  return {
    queue: new DownloadQueue(),
    downloadDir: "/tmp/dl",
    sessions,
  };
}

function deps(over: Partial<WebDeps> = {}): WebDeps {
  return {
    runtime: runtime(),
    token: null,
    getPosterImpl: async () => ({ path: "/tmp/posters/abc.jpg", bytes: 42 }),
    // Never the user's real config file, and never the real Real-Debrid API:
    // the defaults for both reach outside the test.
    loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl" }),
    rdStatusImpl: async () => null,
    ...over,
  };
}

const AUTH = "Bearer secret";

// REALDEBRID_API_TOKEN overrides the config file inside resolveRealDebridToken,
// so a developer who happens to have one exported would see the stream routes
// take the Real-Debrid path no matter what config these tests inject. Cleared
// for every test; the empty string reads as "not set".
beforeEach(() => {
  vi.stubEnv("REALDEBRID_API_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

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
    // Content-Length is load-bearing for the server unit, which streams the file
    // rather than buffering it, so it can't derive the length at write time.
    expect(res.headers?.["Content-Length"]).toBe("42");
    expect(res.headers?.["Cache-Control"]).toBe("private, max-age=86400");
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

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Some+Release";
const INFO_HASH = "0123456789abcdef0123456789abcdef01234567";
const RD_URL = "https://dl.real-debrid.com/d/A1B2C3/big.mkv";
const LOCAL_URL = "http://localhost:41573/webtorrent/abc/big.mkv";

function torrentBackend(stop = vi.fn(async () => {})) {
  return {
    name: "Swarm Name",
    files: [{ url: LOCAL_URL, filename: "big.mkv", bytes: 900 }],
    dir: "/tmp/x",
    isComplete: () => false,
    stop,
  };
}

// A registry whose backends are fakes, so nothing here joins a swarm or calls
// Real-Debrid. Ids and capabilities are fixed so assertions can name them.
function registry(over: Partial<ConstructorParameters<typeof StreamSessionRegistry>[0]> = {}) {
  return new StreamSessionRegistry({
    streamTorrentImpl: async () => torrentBackend(),
    resolveDebridImpl: async () => [{ url: RD_URL, filename: "big.mkv", bytes: 900 }],
    idFactory: () => "sess1",
    capabilityFactory: () => "cap-s3cret",
    ...over,
  });
}

function post(d: WebDeps, body: unknown, auth?: string) {
  return handleWebApi(d, "POST", "/api/stream", new URLSearchParams(), auth, JSON.stringify(body));
}

describe("toPublicSession", () => {
  const CAPABILITY = "kQ7pVnT2capabilityZ9x";
  const RD_URL = "https://dl.real-debrid.com/d/A1B2C3/big.mkv";
  const LOCAL_URL = "http://localhost:41573/webtorrent/abc/small.mkv";

  function session(over: Partial<StreamSession> = {}): StreamSession {
    return {
      id: "sess-alpha",
      capability: CAPABILITY,
      backendHandle: null,
      backend: "torrent",
      name: "Some Release",
      state: "ready",
      files: [
        { url: RD_URL, filename: "big.mkv", bytes: 900 },
        { url: LOCAL_URL, filename: "small.mkv", bytes: 100 },
      ],
      progress: 100,
      createdAt: 1_723_000_000_000,
      ...over,
    };
  }

  // Every leaf value of the source session, so the leak test can be written as
  // "nothing but the allowlist survived" rather than "these two fields are
  // gone". Strings and numbers only — those are what a body can leak.
  function leaves(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string" || typeof value === "number") out.push(String(value));
    else if (Array.isArray(value)) for (const v of value) leaves(v, out);
    else if (value && typeof value === "object") for (const v of Object.values(value)) leaves(v, out);
    return out;
  }

  it("serialises without any value the client is not meant to have", () => {
    // THE POINT OF THIS TEST: it iterates the serialised output looking for any
    // source value that isn't explicitly public, instead of asserting on a list
    // of known-bad keys. A key-list test still passes on the day someone adds
    // `debridToken` to StreamSession and spreads it into the payload; this one
    // fails, because the new value shows up in the JSON and isn't in the
    // allowlist below. Verified by temporarily adding such a field — see the
    // named assertions after it for the two leaks that exist today.
    const allowed = new Set([
      "sess-alpha", // id
      "Some Release", // name
      "ready", // state
      "torrent", // backend
      "big.mkv",
      "small.mkv", // filenames
      "900",
      "100", // file sizes and progress
    ]);
    const json = JSON.stringify(toPublicSession(session()));
    const leaked = leaves(session()).filter((v) => !allowed.has(v) && json.includes(v));
    expect(leaked).toEqual([]);
  });

  it("never puts the capability in a session body", () => {
    // Named, because this is the one that matters most: the capability is a
    // media credential, and a resolving session is polled once a second.
    expect(JSON.stringify(toPublicSession(session()))).not.toContain(CAPABILITY);
  });

  it("never puts an upstream file url in a session body", () => {
    const json = JSON.stringify(toPublicSession(session()));
    // The RD link is a credential against the user's account; the localhost one
    // is unreachable from the phone that would be reading this.
    expect(json).not.toContain(RD_URL);
    expect(json).not.toContain(LOCAL_URL);
    expect(json).not.toContain("real-debrid.com");
    expect(json).not.toContain("localhost");
  });

  it("replaces each url with a positional /stream handle", () => {
    const pub = toPublicSession(session());
    expect(pub.files).toEqual([
      { filename: "big.mkv", bytes: 900, index: 0, handle: "/stream/sess-alpha/0" },
      { filename: "small.mkv", bytes: 100, index: 1, handle: "/stream/sess-alpha/1" },
    ]);
  });

  it("carries the fields a client renders from", () => {
    expect(toPublicSession(session({ state: "resolving", progress: 42 }))).toMatchObject({
      id: "sess-alpha",
      backend: "torrent",
      name: "Some Release",
      state: "resolving",
      progress: 42,
    });
  });

  it("omits error entirely when there is none, and reports it when there is", () => {
    expect("error" in toPublicSession(session())).toBe(false);
    const failed = toPublicSession(session({ state: "error", error: "No peers found", files: [] }));
    expect(failed.error).toBe("No peers found");
  });

  it("percent-encodes a session id that would otherwise change the handle's shape", () => {
    // Ids are UUIDs today. This pins the encoding so a future id factory can't
    // silently produce a handle with an extra path segment in it.
    expect(streamHandle("a/b c", 2)).toBe("/stream/a%2Fb%20c/2");
  });
});

describe("POST /api/stream", () => {
  it("answers immediately with a resolving session rather than waiting for the backend", async () => {
    // Real-Debrid can spend minutes caching a torrent. The response carries the
    // id and capability up front and the client polls GET for the rest; holding
    // the POST open would time out somewhere in the middle and strand a session
    // the client never learned the id of.
    const sessions = registry();
    const res = await post(deps({ runtime: runtime(sessions) }), { magnet: MAGNET, name: "Some Release" });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      sessionId: "sess1",
      capability: "cap-s3cret",
      session: { id: "sess1", backend: "torrent", name: "Some Release", state: "resolving", files: [] },
    });
    expect(sessions.get("sess1")).not.toBeNull();
  });

  it("fills in the files on the session the client then polls", async () => {
    const sessions = registry();
    const d = deps({ runtime: runtime(sessions) });
    await post(d, { magnet: MAGNET });
    const res = await handleWebApi(d, "GET", "/api/stream/sess1", new URLSearchParams(), undefined, "");

    expect(res.json).toMatchObject({
      state: "ready",
      files: [{ filename: "big.mkv", bytes: 900, index: 0, handle: "/stream/sess1/0" }],
    });
  });

  it("returns the capability exactly once, and not inside the session", async () => {
    // The capability is a media credential. It is fine in the start response —
    // that is the only way a client can ever get one — but a client that logs
    // or forwards `session` must not be forwarding a credential with it.
    const res = await post(deps({ runtime: runtime(registry()) }), { magnet: MAGNET });
    const body = res.json as { capability: string; session: unknown };
    expect(body.capability).toBe("cap-s3cret");
    expect(JSON.stringify(body.session)).not.toContain("cap-s3cret");
  });

  it("never returns an upstream url", async () => {
    const sessions = registry({ streamTorrentImpl: async () => torrentBackend() });
    const res = await post(deps({ runtime: runtime(sessions) }), { magnet: MAGNET });
    expect(JSON.stringify(res.json)).not.toContain(LOCAL_URL);
  });

  it("accepts a bare info hash the way /add does", async () => {
    const sessions = registry();
    const res = await post(deps({ runtime: runtime(sessions) }), { infoHash: INFO_HASH });
    expect(res.status).toBe(200);
  });

  it("400s an unparseable magnet without starting anything", async () => {
    const sessions = registry();
    const res = await post(deps({ runtime: runtime(sessions) }), { magnet: "not-a-magnet" });
    expect(res.status).toBe(400);
    expect(sessions.list()).toEqual([]);
  });

  it("400s a missing magnet and a non-JSON body", async () => {
    const d = deps();
    expect((await post(d, { name: "nothing to stream" })).status).toBe(400);
    const raw = await handleWebApi(d, "POST", "/api/stream", new URLSearchParams(), undefined, "<html>");
    expect(raw.status).toBe(400);
  });

  it("routes through Real-Debrid when a token is configured and premium is live", async () => {
    // Exactly the TUI's preference order, from classifyStreamRoute.
    const resolveDebridImpl = vi.fn(async () => [{ url: RD_URL, filename: "big.mkv", bytes: 900 }]);
    const streamTorrentImpl = vi.fn(async () => torrentBackend());
    const sessions = registry({ resolveDebridImpl, streamTorrentImpl });
    const res = await post(
      deps({
        runtime: runtime(sessions),
        loadConfigImpl: async () => ({ ...defaultConfig, realDebridToken: "rd-token" }),
        rdStatusImpl: async () => ({ username: "u", premium: true, premiumUntil: null }),
      }),
      { magnet: MAGNET },
    );

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ session: { backend: "realdebrid" } });
    expect(resolveDebridImpl).toHaveBeenCalledWith("rd-token", MAGNET, expect.anything());
    expect(streamTorrentImpl).not.toHaveBeenCalled();
  });

  it("does not probe the Real-Debrid account when no token is configured", async () => {
    const rdStatusImpl = vi.fn(async () => null);
    await post(deps({ runtime: runtime(registry()), rdStatusImpl }), { magnet: MAGNET });
    expect(rdStatusImpl).not.toHaveBeenCalled();
  });
});

describe("POST /api/stream — torrent-confirm", () => {
  // A configured Real-Debrid account that isn't premium. The TUI always warns
  // here; the browser must be given the chance to do the same.
  function confirmDeps(over: Partial<WebDeps> = {}) {
    return deps({
      loadConfigImpl: async () => ({ ...defaultConfig, realDebridToken: "rd-token" }),
      rdStatusImpl: async () => ({ username: "u", premium: false, premiumUntil: null }),
      ...over,
    });
  }

  it("refuses with a distinct state instead of quietly streaming over P2P", async () => {
    // THE MUTATION THIS KILLS: treating torrent-confirm as torrent-auto. That
    // reads as a harmless simplification and puts the user's own IP into a
    // public swarm, after they deliberately set Real-Debrid up so it wouldn't
    // be. Nothing may start until a human says yes.
    const streamTorrentImpl = vi.fn(async () => torrentBackend());
    const sessions = registry({ streamTorrentImpl });
    const res = await post(confirmDeps({ runtime: runtime(sessions) }), { magnet: MAGNET });

    expect(res.status).toBe(409);
    expect(res.json).toEqual({
      route: "torrent-confirm",
      reason: "your Real-Debrid premium isn't active",
    });
    expect(streamTorrentImpl).not.toHaveBeenCalled();
    expect(sessions.list()).toEqual([]);
  });

  it("is not satisfied by a truthy-but-not-true confirm", async () => {
    const sessions = registry();
    const res = await post(confirmDeps({ runtime: runtime(sessions) }), {
      magnet: MAGNET,
      confirm: "yes",
    });
    expect(res.status).toBe(409);
    expect(sessions.list()).toEqual([]);
  });

  it("streams over P2P once the client confirms", async () => {
    const streamTorrentImpl = vi.fn(async () => torrentBackend());
    const resolveDebridImpl = vi.fn(async () => [{ url: RD_URL, filename: "big.mkv", bytes: 900 }]);
    const sessions = registry({ streamTorrentImpl, resolveDebridImpl });
    const res = await post(confirmDeps({ runtime: runtime(sessions) }), {
      magnet: MAGNET,
      confirm: true,
    });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ session: { backend: "torrent" } });
    expect(streamTorrentImpl).toHaveBeenCalled();
    // Confirmed means P2P, not "try Real-Debrid anyway with a dead account".
    expect(resolveDebridImpl).not.toHaveBeenCalled();
  });
});

describe("GET /api/stream/:sid", () => {
  async function started() {
    const sessions = registry();
    const d = deps({ runtime: runtime(sessions) });
    await post(d, { magnet: MAGNET, name: "Some Release" });
    return { sessions, d };
  }

  it("returns the public session", async () => {
    const { d } = await started();
    const res = await handleWebApi(d, "GET", "/api/stream/sess1", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: "sess1",
      state: "ready",
      progress: 100,
      files: [{ index: 0, handle: "/stream/sess1/0" }],
    });
  });

  it("does not repeat the capability or the upstream url on every poll", async () => {
    const { d } = await started();
    const res = await handleWebApi(d, "GET", "/api/stream/sess1", new URLSearchParams(), undefined, "");
    const json = JSON.stringify(res.json);
    expect(json).not.toContain("cap-s3cret");
    expect(json).not.toContain(LOCAL_URL);
  });

  it("404s an unknown session id", async () => {
    const { d } = await started();
    const res = await handleWebApi(d, "GET", "/api/stream/nope", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(404);
  });

  it("405s a verb the session route doesn't implement", async () => {
    const { d } = await started();
    const res = await handleWebApi(d, "PUT", "/api/stream/sess1", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(405);
  });
});

describe("DELETE /api/stream/:sid", () => {
  async function started() {
    const stop = vi.fn(async () => {});
    const sessions = registry({ streamTorrentImpl: async () => torrentBackend(stop) });
    const d = deps({ runtime: runtime(sessions) });
    await post(d, { magnet: MAGNET });
    return { stop, sessions, d };
  }

  it("stops the session and discards its data by default", async () => {
    const { stop, sessions, d } = await started();
    const res = await handleWebApi(d, "DELETE", "/api/stream/sess1", new URLSearchParams(), undefined, "");

    expect(res.status).toBe(200);
    expect(stop).toHaveBeenCalledWith({ keep: false });
    expect(sessions.get("sess1")).toBeNull();
  });

  it("keeps the downloaded data when asked with ?keep=1", async () => {
    // The flag reaches the WebTorrent backend or it does nothing at all: this
    // is the whole difference between "finished watching, keep the file" and
    // the file being deleted out from under the user.
    const { stop, d } = await started();
    const res = await handleWebApi(
      d,
      "DELETE",
      "/api/stream/sess1",
      new URLSearchParams({ keep: "1" }),
      undefined,
      "",
    );

    expect(res.status).toBe(200);
    expect(stop).toHaveBeenCalledWith({ keep: true });
  });

  it("404s an unknown session id", async () => {
    const { d } = await started();
    const res = await handleWebApi(d, "DELETE", "/api/stream/nope", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(404);
  });
});

describe("stream routes — the token gate", () => {
  // None of these delegate to handleApi, so the router's own gate is the only
  // thing in front of them. One test per route: a single shared gate is easy to
  // punch a per-path hole in ("just let the player start a session"), and a
  // test that only covers one route wouldn't notice.
  it("rejects an unauthenticated POST without starting a session", async () => {
    const streamTorrentImpl = vi.fn(async () => torrentBackend());
    const sessions = registry({ streamTorrentImpl });
    const res = await post(deps({ token: "secret", runtime: runtime(sessions) }), { magnet: MAGNET });

    expect(res.status).toBe(401);
    expect(streamTorrentImpl).not.toHaveBeenCalled();
    expect(sessions.list()).toEqual([]);
  });

  it("rejects an unauthenticated GET without disclosing a session", async () => {
    const sessions = registry();
    const d = deps({ token: "secret", runtime: runtime(sessions) });
    await post(d, { magnet: MAGNET }, AUTH);
    const res = await handleWebApi(d, "GET", "/api/stream/sess1", new URLSearchParams(), undefined, "");

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.json)).not.toContain("big.mkv");
  });

  it("rejects an unauthenticated DELETE without stopping the session", async () => {
    const stop = vi.fn(async () => {});
    const sessions = registry({ streamTorrentImpl: async () => torrentBackend(stop) });
    const d = deps({ token: "secret", runtime: runtime(sessions) });
    await post(d, { magnet: MAGNET }, AUTH);
    const res = await handleWebApi(d, "DELETE", "/api/stream/sess1", new URLSearchParams(), undefined, "");

    expect(res.status).toBe(401);
    expect(stop).not.toHaveBeenCalled();
    expect(sessions.get("sess1")).not.toBeNull();
  });
});

describe("stream routes — path matching", () => {
  // The :sid matcher is the first parameterised path in this router, so these
  // pin what it must NOT match. Every one of them is a 404 (or a 400 from the
  // start handler), never a match against some other session.
  it.each([
    ["GET", "/api/stream/sess1/extra"], // two segments
    ["GET", "/api/stream/"], // empty id
    ["GET", "/api/stream"], // the collection has no GET
    ["GET", "/api/streams/sess1"], // near-miss prefix
    ["GET", "/api/stream/sess1%2Fnested"], // decodes to an id no session has
    ["GET", "/api/stream/%zz"], // malformed encoding
    ["GET", "/API/stream/sess1"], // case
    ["POST", "/API/stream"], // case, mutating
    ["GET", "/api/poster/"], // trailing slash is not the poster route
    ["GET", "/api/../status"], // unnormalised traversal, as the router sees it
  ])("404s %s %s", async (method, path) => {
    const sessions = registry();
    const d = deps({ runtime: runtime(sessions) });
    await post(d, { magnet: MAGNET });
    const res = await handleWebApi(d, method, path, new URLSearchParams(), undefined, JSON.stringify({ magnet: MAGNET }));
    expect(res.status).toBe(404);
  });
});
