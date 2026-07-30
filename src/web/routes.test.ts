import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TITLE_CACHE,
  clearTitleCache,
  handleWebApi,
  parseSearchParams,
  searchSources,
  startSearchStream,
  streamHandle,
  toPublicResult,
  toPublicSession,
  type WebDeps,
  type WebResponse,
} from "./routes";
import { DownloadQueue } from "../download/queue";
import { defaultConfig, type Config, type FavouriteItem } from "../config/config";
import { StreamSessionRegistry, type StreamSession } from "../core/streamSession";
import { SOURCES } from "../sources/registry";
import { HttpError } from "../util/net";
import type { Health } from "../sources/sourceHealth";
import type { FetchTitleMetaResult } from "../recc/omdb";
import type { ReccEvent } from "../recc/client";
import type { StreamHistoryItem } from "../core/streamHistory";
import type { Source, SourceId, TorrentResult } from "../sources/types";
import type {
  LibraryResponse,
  PublicSearchSnapshot,
  PublicStreamHistoryItem,
  SavedResponse,
  SourcesResponse,
} from "./wire";
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
    // A THROW, not a no-op: three routes now write config, and a test that
    // forgets to inject a save seam must fail loudly rather than silently edit
    // the developer's own ~/.config/torlnk/config.json.
    saveConfigImpl: async () => {
      throw new Error("test must inject saveConfigImpl");
    },
    loadStreamHistoryImpl: async () => [],
    // A THROW, for the same reason saveConfigImpl is one. NOTE it is not a
    // tripwire on POST /api/stream: that route's history write is
    // fire-and-forget with a `.catch` (a convenience list must never take a
    // stream down with it), so the throw lands in a promise nobody reads. The
    // describe that cares injects a recording seam of its own and asserts what
    // reached it — see "records stream history" below.
    saveStreamHistoryImpl: async () => {
      throw new Error("test must inject saveStreamHistoryImpl");
    },
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
        rdStatusImpl: async () => ({
          provider: "realdebrid",
          username: "u",
          active: true,
          planLabel: "premium",
          expiresAt: null,
        }),
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
      rdStatusImpl: async () => ({
        provider: "realdebrid",
        username: "u",
        active: false,
        planLabel: "free",
        expiresAt: null,
      }),
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
      reason: "your Real-Debrid plan isn't active",
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

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// Every source id except the ones named, i.e. the `disabledSources` that leaves
// exactly those enabled. Written as a subtraction from the real registry rather
// than a hand-listed array so adding a 24th source cannot silently widen a test.
function onlySources(...ids: SourceId[]): string[] {
  return SOURCES.filter((s) => !ids.includes(s.id)).map((s) => s.id);
}

function searchConfig(over: Partial<Config> = {}): Config {
  return { ...defaultConfig, downloadDir: "/tmp/dl", ...over };
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

// Parse what the route actually wrote, rather than trusting a mock's arguments:
// the frame format IS the contract with EventSource, so a test that never looks
// at the bytes cannot catch a broken one.
function parseFrames(chunks: string[]): Frame[] {
  return chunks
    .join("")
    .split("\n\n")
    .filter((f) => f.length > 0)
    .map((f) => {
      const m = /^event: ([^\n]*)\ndata: ([\s\S]*)$/.exec(f);
      if (!m) throw new Error(`unparseable SSE frame: ${JSON.stringify(f)}`);
      return { event: m[1]!, data: JSON.parse(m[2]!) as Record<string, unknown> };
    });
}

function hit(over: Partial<TorrentResult> = {}): TorrentResult {
  return {
    infoHash: "aa".repeat(20),
    name: "Copper Kettle Run 2008 1080p",
    sizeBytes: 1024,
    seeders: 10,
    leechers: 1,
    source: "yts",
    magnet: `magnet:?xt=urn:btih:${"aa".repeat(20)}&dn=Copper+Kettle+Run`,
    ...over,
  };
}

function searchDeps(over: Partial<WebDeps> = {}): WebDeps {
  return deps({
    sourceHealthImpl: new Map(),
    loadConfigImpl: async () => searchConfig(),
    ...over,
  });
}

// Drive the stream to completion. `done` is the last frame on every non-aborted
// path, so waiting for it is waiting for the search.
async function collectSearch(d: WebDeps, params: Parameters<typeof startSearchStream>[1]): Promise<Frame[]> {
  const chunks: string[] = [];
  const stop = startSearchStream(d, params, (c) => chunks.push(c));
  try {
    await vi.waitFor(() => {
      expect(parseFrames(chunks).some((f) => f.event === "done" || f.event === "error")).toBe(true);
    });
  } finally {
    stop();
  }
  return parseFrames(chunks);
}

describe("toPublicResult", () => {
  // The whole reason this function exists rather than a spread. If it ever
  // ships a magnet, every snapshot frame grows by ~1KB per result and the
  // browser gains a way to reach a swarm without a route validating the hash.
  it("never puts the magnet on the wire", () => {
    const out = toPublicResult(hit());
    expect(out).not.toHaveProperty("magnet");
    expect(JSON.stringify(out)).not.toContain("magnet:");
  });

  it("picks the display fields and normalises sources to an array", () => {
    expect(toPublicResult(hit({ seeders: 7, leechers: 2, sizeBytes: 99 }))).toEqual({
      infoHash: "aa".repeat(20),
      name: "Copper Kettle Run 2008 1080p",
      sizeBytes: 99,
      seeders: 7,
      leechers: 2,
      source: "yts",
      sources: ["yts"],
    });
  });

  it("keeps a merged source list and the optional fields when present", () => {
    const out = toPublicResult(hit({ sources: ["yts", "tpb-movies"], added: 1700000000000, numFiles: 3 }));
    expect(out.sources).toEqual(["yts", "tpb-movies"]);
    expect(out.added).toBe(1700000000000);
    expect(out.numFiles).toBe(3);
  });

  // An explicit `undefined` key survives into any in-process consumer even
  // though JSON.stringify drops it, and the wire type marks these optional.
  it("omits the optional keys entirely when the source gave none", () => {
    expect(Object.keys(toPublicResult(hit())).sort()).toEqual([
      "infoHash",
      "leechers",
      "name",
      "seeders",
      "sizeBytes",
      "source",
      "sources",
    ]);
  });
});

describe("parseSearchParams", () => {
  it("accepts a query with no group as the All tab", () => {
    expect(parseSearchParams(new URLSearchParams("q=kestrel"))).toEqual({
      ok: true,
      params: { query: "kestrel", group: null },
    });
  });

  it("trims the query and treats an explicit All as no group", () => {
    expect(parseSearchParams(new URLSearchParams("q=%20kestrel%20&group=All"))).toEqual({
      ok: true,
      params: { query: "kestrel", group: null },
    });
  });

  it("accepts a real group", () => {
    expect(parseSearchParams(new URLSearchParams("q=x&group=Movies"))).toEqual({
      ok: true,
      params: { query: "x", group: "Movies" },
    });
  });

  // Blank is browse mode, not a mistake. See parseSearchParams.
  it.each(["q=", "q=%20%20"])("accepts a blank query as browse (%s)", (qs) => {
    expect(parseSearchParams(new URLSearchParams(qs))).toEqual({
      ok: true,
      params: { query: "", group: null },
    });
  });

  it("browses one group when a blank query names a tab", () => {
    expect(parseSearchParams(new URLSearchParams("q=&group=Movies"))).toEqual({
      ok: true,
      params: { query: "", group: "Movies" },
    });
  });

  // Absent and blank are deliberately different. See parseSearchParams.
  it("rejects a request with no q at all", () => {
    expect(parseSearchParams(new URLSearchParams(""))).toEqual({ ok: false, error: "missing query" });
  });

  // A typo'd tab that quietly searches everything is worse than one that says
  // no: the user would see results they did not ask for and never learn why.
  it.each(["movies", "MOVIES", "Films", "__proto__"])("rejects the unknown group %s", (group) => {
    expect(parseSearchParams(new URLSearchParams(`q=x&group=${group}`))).toEqual({
      ok: false,
      error: "unknown group",
    });
  });
});

describe("searchSources", () => {
  it("searches every non-adult source by default", () => {
    const ids = searchSources(searchConfig(), null).map((s) => s.id);
    expect(ids).toContain("yts");
    expect(ids).not.toContain("tpb-porn");
    expect(ids).not.toContain("x1337-porn");
  });

  it("omits sources the user disabled", () => {
    const ids = searchSources(searchConfig({ disabledSources: ["yts", "eztv"] }), null).map((s) => s.id);
    expect(ids).not.toContain("yts");
    expect(ids).not.toContain("eztv");
    expect(ids).toContain("tpb-movies");
  });

  it("includes adult sources only once the adult category is on", () => {
    expect(searchSources(searchConfig({ adultContent: true }), null).map((s) => s.id)).toContain("tpb-porn");
  });

  it("narrows to one group's sources", () => {
    for (const s of searchSources(searchConfig(), "Anime")) {
      expect(s.groups).toContain("Anime");
    }
    expect(searchSources(searchConfig(), "Anime").map((s) => s.id)).toContain("nyaa");
  });
});

describe("startSearchStream", () => {
  it("streams a results frame per settled source, then exactly one done", async () => {
    const d = searchDeps({
      loadConfigImpl: async () => searchConfig({ disabledSources: onlySources("yts", "eztv") }),
      searchImpl: async (source) => [hit({ source: source.id, infoHash: source.id.padEnd(40, "0") })],
    });
    const out = await collectSearch(d, { query: "bunny", group: null });

    // One opening frame with both sources loading, then one per settled source.
    expect(out.filter((f) => f.event === "results")).toHaveLength(3);
    expect((out[0]!.data as unknown as PublicSearchSnapshot).perSource["yts"]).toEqual({
      loading: true,
      error: null,
      code: null,
      count: 0,
    });
    expect(out.filter((f) => f.event === "done")).toHaveLength(1);
    expect(out[out.length - 1]!.event).toBe("done");

    const final = out[out.length - 1]!.data as unknown as PublicSearchSnapshot;
    expect(final.total).toBe(2);
    expect(final.done).toBe(2);
    expect(final.results).toHaveLength(2);
    expect(Object.keys(final.perSource).sort()).toEqual(["eztv", "yts"]);
  });

  // The spinner stops on `done`. A path that ends without one leaves a browser
  // claiming a search is still running for as long as the tab is open.
  it("emits done even when every source fails", async () => {
    const d = searchDeps({
      loadConfigImpl: async () => searchConfig({ disabledSources: onlySources("yts") }),
      searchImpl: async () => {
        throw new HttpError(503, "boom");
      },
    });
    const out = await collectSearch(d, { query: "bunny", group: null });
    expect(out.filter((f) => f.event === "done")).toHaveLength(1);
  });

  it("emits done for a search with no sources at all", async () => {
    const d = searchDeps({
      loadConfigImpl: async () => searchConfig({ disabledSources: onlySources() }),
      searchImpl: async () => [],
    });
    const out = await collectSearch(d, { query: "bunny", group: null });
    expect(out.map((f) => f.event)).toEqual(["results", "done"]);
    expect((out[0]!.data as unknown as PublicSearchSnapshot).total).toBe(0);
  });

  // "Eight trackers errored" and "eight trackers found nothing" are different
  // searches. Dropping the error slots makes them identical on the wire.
  it("reports a per-source failure rather than swallowing it", async () => {
    const d = searchDeps({
      loadConfigImpl: async () => searchConfig({ disabledSources: onlySources("yts", "eztv") }),
      searchImpl: async (source) => {
        if (source.id === "eztv") throw new HttpError(503, "nope");
        return [hit({ source: "yts" })];
      },
    });
    const out = await collectSearch(d, { query: "bunny", group: null });
    const final = out[out.length - 1]!.data as unknown as PublicSearchSnapshot;
    expect(final.perSource["eztv"]).toEqual({ loading: false, error: "nope", code: "HTTP 503", count: 0 });
    expect(final.perSource["yts"]).toEqual({ loading: false, error: null, code: null, count: 1 });
  });

  it("does not search a source the user disabled", async () => {
    const searchImpl = vi.fn(async (_source: Source): Promise<TorrentResult[]> => []);
    const d = searchDeps({
      loadConfigImpl: async () => searchConfig({ disabledSources: onlySources("yts") }),
      searchImpl,
    });
    const out = await collectSearch(d, { query: "bunny", group: null });
    const final = out[out.length - 1]!.data as unknown as PublicSearchSnapshot;
    expect(Object.keys(final.perSource)).toEqual(["yts"]);
    expect(searchImpl.mock.calls.map((c) => c[0].id)).toEqual(["yts"]);
  });

  // The adult category is off by default and this route must not be the way
  // round it: a browser asking for the Porn tab on a default install gets a
  // search with nothing in it, not the adult trackers.
  it("never searches an adult source while the adult category is off", async () => {
    const searchImpl = vi.fn(async (_source: Source): Promise<TorrentResult[]> => []);
    const d = searchDeps({
      loadConfigImpl: async () => searchConfig({ disabledSources: onlySources("tpb-porn", "x1337-porn") }),
      searchImpl,
    });
    const out = await collectSearch(d, { query: "bunny", group: "Porn" });
    expect((out[out.length - 1]!.data as unknown as PublicSearchSnapshot).total).toBe(0);
    expect(searchImpl).not.toHaveBeenCalled();
  });

  it("searches adult sources once the adult category is on", async () => {
    const searchImpl = vi.fn(async (_source: Source): Promise<TorrentResult[]> => []);
    const d = searchDeps({
      loadConfigImpl: async () =>
        searchConfig({ adultContent: true, disabledSources: onlySources("tpb-porn") }),
      searchImpl,
    });
    const out = await collectSearch(d, { query: "bunny", group: "Porn" });
    expect((out[out.length - 1]!.data as unknown as PublicSearchSnapshot).total).toBe(1);
    expect(searchImpl.mock.calls.map((c) => c[0].id)).toEqual(["tpb-porn"]);
  });

  // A browser that opened on "0/23" and then saw "1/20" would read three
  // sources as having vanished mid-search. Benched ones are never counted.
  it("counts benched sources out of the opening frame, not just the later ones", async () => {
    const health = new Map<SourceId, Health>([["eztv", { fails: 3, skipUntil: Date.now() + 60_000 }]]);
    const d = searchDeps({
      sourceHealthImpl: health,
      loadConfigImpl: async () => searchConfig({ disabledSources: onlySources("yts", "eztv") }),
      searchImpl: async (source) => [hit({ source: source.id, infoHash: source.id.padEnd(40, "0") })],
    });
    const out = await collectSearch(d, { query: "bunny", group: null });
    const totals = out.map((f) => (f.data as unknown as PublicSearchSnapshot).total);
    expect(totals).toEqual(totals.map(() => 1));
    expect(Object.keys((out[0]!.data as unknown as PublicSearchSnapshot).perSource)).toEqual(["yts"]);
  });

  it("reports a config read failure as an error frame and no done", async () => {
    const chunks: string[] = [];
    const d = searchDeps({
      loadConfigImpl: async () => {
        throw new Error("config unreadable");
      },
    });
    const stop = startSearchStream(d, { query: "bunny", group: null }, (c) => chunks.push(c));
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
    stop();
    const out = parseFrames(chunks);
    expect(out.map((f) => f.event)).toEqual(["error"]);
    expect(out[0]!.data).toEqual({ error: "config unreadable" });
  });

  /**
   * THE DISCONNECT ABORT.
   *
   * Output assertions structurally cannot see this: a stopped channel drops
   * every frame, so a stream that leaves 23 HTTP requests running against
   * trackers looks *identical* from the outside to one that cancelled them.
   * This project has been bitten by exactly that, so what is asserted here is
   * the abort signals each source was handed, the timer count, and the fact
   * that no failure was recorded — never the bytes written.
   */
  describe("client disconnect", () => {
    it("aborts every in-flight source request and clears every timer", async () => {
      vi.useFakeTimers();
      try {
        const signals: AbortSignal[] = [];
        const health = new Map<SourceId, Health>();
        const chunks: string[] = [];
        const timersBefore = vi.getTimerCount();
        const d = searchDeps({
          sourceHealthImpl: health,
          loadConfigImpl: async () => searchConfig({ disabledSources: onlySources("yts", "eztv") }),
          // Never resolves on its own: the only way out is the abort.
          searchImpl: async (_source, _query, opts) =>
            new Promise<TorrentResult[]>((_resolve, reject) => {
              signals.push(opts.signal!);
              opts.signal!.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        });

        const stop = startSearchStream(d, { query: "bunny", group: null }, (c) => chunks.push(c));
        // Let the config read and the fan-out happen.
        await vi.advanceTimersByTimeAsync(0);
        expect(signals).toHaveLength(2);
        expect(signals.every((s) => s.aborted)).toBe(false);
        // One 25s per-source timeout each, plus the channel's heartbeat.
        expect(vi.getTimerCount()).toBe(timersBefore + 3);

        stop();
        await vi.advanceTimersByTimeAsync(0);

        expect(signals.map((s) => s.aborted)).toEqual([true, true]);
        expect(vi.getTimerCount()).toBe(timersBefore);
        // Cancelling our own work must not bench a healthy tracker.
        expect(health.size).toBe(0);
        expect(parseFrames(chunks).some((f) => f.event === "done")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops the heartbeat, so a dead client leaves no timer behind", async () => {
      vi.useFakeTimers();
      try {
        const timersBefore = vi.getTimerCount();
        const chunks: string[] = [];
        const d = searchDeps({
          loadConfigImpl: async () => searchConfig({ disabledSources: onlySources() }),
          searchImpl: async () => [],
        });
        const stop = startSearchStream(d, { query: "bunny", group: null }, (c) => chunks.push(c));
        await vi.advanceTimersByTimeAsync(0);
        stop();
        expect(vi.getTimerCount()).toBe(timersBefore);
        const after = chunks.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(chunks).toHaveLength(after);
      } finally {
        vi.useRealTimers();
      }
    });

    it("writes nothing more once the client has gone", async () => {
      const chunks: string[] = [];
      let release: (() => void) | null = null;
      const d = searchDeps({
        loadConfigImpl: async () => searchConfig({ disabledSources: onlySources("yts") }),
        searchImpl: async () =>
          new Promise<TorrentResult[]>((resolve) => {
            release = (): void => resolve([hit()]);
          }),
      });
      const stop = startSearchStream(d, { query: "bunny", group: null }, (c) => chunks.push(c));
      await vi.waitFor(() => expect(release).not.toBeNull());
      // The opening "all loading" frame is already out; nothing after it is.
      const atDisconnect = chunks.length;
      stop();
      release!();
      await new Promise((r) => setTimeout(r, 10));
      expect(chunks).toHaveLength(atDisconnect);
    });
  });
});

describe("GET /api/sources", () => {
  const health = (): Map<SourceId, Health> => new Map();

  async function get(over: Partial<WebDeps> = {}): Promise<SourcesResponse> {
    const res = await handleWebApi(
      deps({ sourceHealthImpl: health(), loadConfigImpl: async () => searchConfig(), ...over }),
      "GET",
      "/api/sources",
      new URLSearchParams(),
      AUTH,
      "",
    );
    expect(res.status).toBe(200);
    return res.json as SourcesResponse;
  }

  // Nothing under /api/ delegates to handleApi here, so this router's gate is
  // the only door. With it deleted this call would answer 200.
  it("rejects an unauthenticated caller when a token is set", async () => {
    const res = await handleWebApi(
      deps({ token: "secret" }),
      "GET",
      "/api/sources",
      new URLSearchParams(),
      undefined,
      "",
    );
    expect(res.status).toBe(401);
  });

  it("lists the TUI's groups in order with their source ids", async () => {
    const body = await get();
    expect(body.groups.map((g) => g.group)).toEqual(["Games", "Movies", "TV", "Anime", "Music", "Books"]);
    expect(body.groups.find((g) => g.group === "Movies")!.sourceIds).toContain("yts");
  });

  // A capability flag the browser needs to offer the TUI's `r` (Real-Debrid)
  // action on a result, and to know whether a plain add should warn about the
  // swarm first. Never the token itself.
  it("reports whether Real-Debrid is configured, without leaking the token", async () => {
    expect((await get()).debridConfigured).toBe(false);
    const withToken = await get({
      loadConfigImpl: async () => searchConfig({ realDebridToken: "rd-tok" }),
    });
    expect(withToken.debridConfigured).toBe(true);
    expect(JSON.stringify(withToken)).not.toContain("rd-tok");
  });

  it("counts REALDEBRID_API_TOKEN, so the browser agrees with the TUI", async () => {
    vi.stubEnv("REALDEBRID_API_TOKEN", "env-tok");
    expect((await get()).debridConfigured).toBe(true);
  });

  it("hides adult sources and the Porn tab while the adult category is off", async () => {
    const body = await get();
    expect(body.adultEnabled).toBe(false);
    expect(body.groups.map((g) => g.group)).not.toContain("Porn");
    expect(body.sources.map((s) => s.id)).not.toContain("tpb-porn");
  });

  it("surfaces adult sources and the Porn tab once it is on", async () => {
    const body = await get({ loadConfigImpl: async () => searchConfig({ adultContent: true }) });
    expect(body.adultEnabled).toBe(true);
    expect(body.groups.map((g) => g.group)).toContain("Porn");
    expect(body.sources.find((s) => s.id === "tpb-porn")).toMatchObject({ adult: true });
  });

  // Disabled is a user choice, not a health verdict: the TUI greys them rather
  // than hiding them, and the browser's tab bar has to be able to do the same.
  it("keeps a disabled source listed but marked disabled", async () => {
    const body = await get({ loadConfigImpl: async () => searchConfig({ disabledSources: ["yts"] }) });
    expect(body.sources.find((s) => s.id === "yts")).toMatchObject({ enabled: false });
    expect(body.sources.find((s) => s.id === "eztv")).toMatchObject({ enabled: true });
  });

  it("reports a benched source and its failure count", async () => {
    const map = health();
    const now = Date.now();
    map.set("eztv", { fails: 3, skipUntil: now + 60_000 });
    const body = await get({ sourceHealthImpl: map });
    const eztv = body.sources.find((s) => s.id === "eztv")!;
    expect(eztv.fails).toBe(3);
    expect(eztv.benchedUntil).toBe(now + 60_000);
  });

  // A lapsed cooldown leaves skipUntil in the past; reporting it raw would have
  // the browser call a recovered source benched.
  it("reports a lapsed bench as not benched", async () => {
    const map = health();
    map.set("eztv", { fails: 3, skipUntil: Date.now() - 1000 });
    const body = await get({ sourceHealthImpl: map });
    expect(body.sources.find((s) => s.id === "eztv")!.benchedUntil).toBeNull();
  });
});

describe("sourcesResponse — omdbConfigured", () => {
  beforeEach(() => {
    // resolveOmdbApiKey reads TORLINK_OMDB_KEY, which a developer may well have
    // exported — without this the false case passes or fails by accident.
    vi.stubEnv("TORLINK_OMDB_KEY", "");
  });

  const ask = (config: Partial<Config>) =>
    handleWebApi(
      deps({ loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...config }) }),
      "GET",
      "/api/sources",
      new URLSearchParams(),
      undefined,
      "",
    );

  it("is false with no key, so the browser fetches no posters at all", async () => {
    const res = await ask({});
    expect((res.json as SourcesResponse).omdbConfigured).toBe(false);
  });

  it("is true from the config file", async () => {
    const res = await ask({ omdbApiKey: "abc123" });
    expect((res.json as SourcesResponse).omdbConfigured).toBe(true);
  });

  it("is true from TORLINK_OMDB_KEY, so the browser agrees with the TUI", async () => {
    vi.stubEnv("TORLINK_OMDB_KEY", "from-env");
    const res = await ask({});
    expect((res.json as SourcesResponse).omdbConfigured).toBe(true);
  });

  it("never puts the key itself on the wire", async () => {
    const res = await ask({ omdbApiKey: "super-secret-key" });
    expect(JSON.stringify(res.json)).not.toContain("super-secret-key");
  });
});

// ---------------------------------------------------------------------------
// Title metadata
// ---------------------------------------------------------------------------

describe("GET /api/title", () => {
  const OK: FetchTitleMetaResult = {
    ok: true,
    imdbId: "tt9990001",
    plot: "A lone girl.",
    posterUrl: "https://m.media-amazon.com/images/M/kestrel.jpg",
  };

  beforeEach(() => {
    clearTitleCache();
    // TORLINK_OMDB_KEY overrides config inside resolveOmdbApiKey, so a
    // developer with one exported would never see the no-key path.
    vi.stubEnv("TORLINK_OMDB_KEY", "");
  });

  function titleDeps(over: Partial<WebDeps> = {}): WebDeps {
    return deps({
      loadConfigImpl: async () => searchConfig({ omdbApiKey: "key" }),
      fetchTitleMetaImpl: async () => OK,
      fetchTitleMetaByNameImpl: async () => OK,
      ...over,
    });
  }

  async function title(d: WebDeps, qs: string): Promise<WebResponse> {
    return handleWebApi(d, "GET", "/api/title", new URLSearchParams(qs), AUTH, "");
  }

  it("rejects an unauthenticated caller when a token is set", async () => {
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
    const res = await handleWebApi(
      titleDeps({ token: "secret", fetchTitleMetaByNameImpl }),
      "GET",
      "/api/title",
      new URLSearchParams("name=Kestrel"),
      undefined,
      "",
    );
    expect(res.status).toBe(401);
    expect(fetchTitleMetaByNameImpl).not.toHaveBeenCalled();
  });

  it("looks a title up by name, year and type", async () => {
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
    const res = await title(titleDeps({ fetchTitleMetaByNameImpl }), "name=Kestrel&year=2010&type=movie");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      status: "ok",
      imdbId: "tt9990001",
      plot: "A lone girl.",
      posterUrl: "https://m.media-amazon.com/images/M/kestrel.jpg",
    });
    expect(fetchTitleMetaByNameImpl).toHaveBeenCalledWith("Kestrel", "key", { year: 2010, type: "movie" });
  });

  it("looks a title up by imdb id, and prefers it over a name", async () => {
    const fetchTitleMetaImpl = vi.fn(async () => OK);
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
    await title(titleDeps({ fetchTitleMetaImpl, fetchTitleMetaByNameImpl }), "imdb=tt9990001&name=Wrong");
    expect(fetchTitleMetaImpl).toHaveBeenCalledWith("tt9990001", "key");
    expect(fetchTitleMetaByNameImpl).not.toHaveBeenCalled();
  });

  /**
   * THE NO-KEY PATH. A 500 here — or an empty `ok` — makes a perfectly healthy
   * install look broken, when all the UI needs to say is "add an OMDb key".
   */
  it("answers no-key with a 200 and its own status, never a 500", async () => {
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
    const res = await title(
      titleDeps({ loadConfigImpl: async () => searchConfig(), fetchTitleMetaByNameImpl }),
      "name=Kestrel",
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "no-key" });
    // Nothing was asked of OMDb.
    expect(fetchTitleMetaByNameImpl).not.toHaveBeenCalled();
  });

  // The one confusion the shape exists to prevent: a lookup that happened and
  // found nothing must not read the same as a server with no key.
  it("distinguishes no-key from a lookup that found nothing", async () => {
    const found = await title(
      titleDeps({ fetchTitleMetaByNameImpl: async () => ({ ok: true, imdbId: null, plot: null, posterUrl: null }) }),
      "name=Kestrel",
    );
    expect(found.json).toEqual({ status: "ok", imdbId: null, plot: null, posterUrl: null });
    expect(found.json).not.toEqual({ status: "no-key" });
  });

  it("reports an OMDb failure as an error status carrying the message", async () => {
    const res = await title(
      titleDeps({ fetchTitleMetaByNameImpl: async () => ({ ok: false, error: "Movie not found!" }) }),
      "name=Nope",
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "error", error: "Movie not found!" });
  });

  it("does not cache a no-key answer, so pasting a key takes effect at once", async () => {
    let key = "";
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
    const d = titleDeps({
      loadConfigImpl: async () => searchConfig({ omdbApiKey: key }),
      fetchTitleMetaByNameImpl,
    });
    expect((await title(d, "name=Kestrel")).json).toEqual({ status: "no-key" });
    key = "key";
    expect((await title(d, "name=Kestrel")).json).toMatchObject({ status: "ok" });
  });

  it("does not cache a failure, so a transient OMDb outage is retried", async () => {
    let answer: FetchTitleMetaResult = { ok: false, error: "couldn't reach OMDb" };
    const fetchTitleMetaByNameImpl = vi.fn(async () => answer);
    const d = titleDeps({ fetchTitleMetaByNameImpl });
    expect((await title(d, "name=Kestrel")).json).toMatchObject({ status: "error" });
    answer = OK;
    expect((await title(d, "name=Kestrel")).json).toMatchObject({ status: "ok" });
    expect(fetchTitleMetaByNameImpl).toHaveBeenCalledTimes(2);
  });

  describe("cache", () => {
    // Scrolling a result list must not become one OMDb request per row.
    it("serves a repeat lookup without touching OMDb", async () => {
      const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
      const d = titleDeps({ fetchTitleMetaByNameImpl });
      const first = await title(d, "name=Kestrel&year=2010");
      const second = await title(d, "name=Kestrel&year=2010");
      expect(second.json).toEqual(first.json);
      expect(fetchTitleMetaByNameImpl).toHaveBeenCalledTimes(1);
    });

    it("matches a repeat lookup case-insensitively, as OMDb itself does", async () => {
      const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
      const d = titleDeps({ fetchTitleMetaByNameImpl });
      await title(d, "name=Kestrel");
      await title(d, "name=kestrel");
      expect(fetchTitleMetaByNameImpl).toHaveBeenCalledTimes(1);
    });

    it("keys on every parameter that changes the answer", async () => {
      const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
      const d = titleDeps({ fetchTitleMetaByNameImpl });
      await title(d, "name=Kestrel");
      await title(d, "name=Kestrel&year=2010");
      await title(d, "name=Kestrel&year=2010&type=movie");
      await title(d, "imdb=tt9990001");
      expect(fetchTitleMetaByNameImpl).toHaveBeenCalledTimes(3);
    });

    // The bound is the point: the key space is every release name a search
    // turns up, so an unbounded map is a slow leak on a process that runs for
    // weeks. The oldest entry goes, and the entries still in the cache still hit.
    it("evicts the oldest entry past the bound rather than growing forever", async () => {
      const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
      const d = titleDeps({ fetchTitleMetaByNameImpl });
      for (let i = 0; i < MAX_TITLE_CACHE + 1; i++) await title(d, `name=title-${i}`);
      expect(fetchTitleMetaByNameImpl).toHaveBeenCalledTimes(MAX_TITLE_CACHE + 1);

      // The newest is still cached...
      await title(d, `name=title-${MAX_TITLE_CACHE}`);
      expect(fetchTitleMetaByNameImpl).toHaveBeenCalledTimes(MAX_TITLE_CACHE + 1);
      // ...and the very first was evicted.
      await title(d, "name=title-0");
      expect(fetchTitleMetaByNameImpl).toHaveBeenCalledTimes(MAX_TITLE_CACHE + 2);
    });
  });

  describe("poster URL", () => {
    // This route is the only one that takes a third party's string and hands a
    // browser back a *URL*. A preview pane that puts it straight in an <img src>
    // would fetch it directly, leaking the user's IP to whatever host OMDb named.
    it.each([
      "http://evil.example/track.gif",
      "https://evil.example/poster.jpg",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "//m.media-amazon.com/x.jpg",
      "not a url",
    ])("nulls a poster URL off the CDN allowlist (%s)", async (posterUrl) => {
      const res = await title(
        titleDeps({ fetchTitleMetaByNameImpl: async () => ({ ok: true, imdbId: "tt1", plot: "p", posterUrl }) }),
        "name=Kestrel",
      );
      expect(res.json).toMatchObject({ status: "ok", posterUrl: null });
    });

    it.each([
      "https://m.media-amazon.com/images/M/x.jpg",
      "https://ia.media-imdb.com/images/M/x.jpg",
      "https://img.omdbapi.com/?apikey=k&i=tt1",
    ])("keeps a poster URL the /api/poster allowlist accepts (%s)", async (posterUrl) => {
      const res = await title(
        titleDeps({ fetchTitleMetaByNameImpl: async () => ({ ok: true, imdbId: "tt1", plot: "p", posterUrl }) }),
        "name=Kestrel",
      );
      expect(res.json).toMatchObject({ posterUrl });
    });
  });

  describe("parameters", () => {
    it.each([
      ["", "missing name or imdb"],
      ["name=%20", "missing name or imdb"],
      ["imdb=tt12", "invalid imdb id"],
      ["imdb=nope1234567", "invalid imdb id"],
      ["imdb=tt9990001%26apikey%3Dx", "invalid imdb id"],
      ["name=Kestrel&year=20x0", "invalid year"],
      ["name=Kestrel&year=2010abc", "invalid year"],
      ["name=Kestrel&year=1200", "invalid year"],
      ["name=Kestrel&type=film", "invalid type"],
    ])("400s %s", async (qs, error) => {
      const fetchTitleMetaByNameImpl = vi.fn(async () => OK);
      const res = await title(titleDeps({ fetchTitleMetaByNameImpl }), qs);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error });
      expect(fetchTitleMetaByNameImpl).not.toHaveBeenCalled();
    });
  });
});

describe("GET /api/title?release= — server-side release parsing", () => {
  const OK_META: FetchTitleMetaResult = {
    ok: true,
    imdbId: "tt9990001",
    plot: "A lone girl.",
    posterUrl: "https://m.media-amazon.com/images/M/kestrel.jpg",
  };

  function releaseDeps(over: Partial<WebDeps> = {}): WebDeps {
    return deps({
      loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl", omdbApiKey: "key" }),
      fetchTitleMetaImpl: async () => OK_META,
      fetchTitleMetaByNameImpl: async () => OK_META,
      ...over,
    });
  }

  const title = (d: WebDeps, qs: string): Promise<WebResponse> =>
    handleWebApi(d, "GET", "/api/title", new URLSearchParams(qs), AUTH, "");

  beforeEach(() => clearTitleCache());

  // THE POINT OF THE ROUTE. parse-torrent-title is a Node dependency and
  // src/web/static/ is a browser bundle, so the alternative to this round trip
  // is a second release-name parser in the browser — at which point the tab and
  // the terminal can disagree about what a release is, with no test able to
  // call either side wrong.
  it("parses a release name with the TUI's own parser", async () => {
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK_META);
    const res = await title(
      releaseDeps({ fetchTitleMetaByNameImpl }),
      "release=Kestrel.2010.1080p.BluRay.x264-GROUP&group=Movies",
    );
    expect(res.status).toBe(200);
    expect(fetchTitleMetaByNameImpl).toHaveBeenCalledWith("Kestrel", "key", {
      year: 2010,
      type: "movie",
    });
    expect(res.json).toMatchObject({
      status: "ok",
      parsed: { title: "Kestrel", year: 2010, type: "movie" },
    });
  });

  it("lets a parsed season override the tab's hint", async () => {
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK_META);
    await title(
      releaseDeps({ fetchTitleMetaByNameImpl }),
      "release=Some.Show.S01E02.1080p.WEB&group=Movies",
    );
    expect(fetchTitleMetaByNameImpl).toHaveBeenCalledWith("Some Show", "key", { type: "series" });
  });

  it("maps the TV tab onto OMDb's series type", async () => {
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK_META);
    await title(releaseDeps({ fetchTitleMetaByNameImpl }), "release=Some.Show.1080p&group=TV");
    expect(fetchTitleMetaByNameImpl).toHaveBeenCalledWith("Some Show", "key", { type: "series" });
  });

  it("answers a nameless release with a 200 miss, not a 400", async () => {
    // The preview pane renders this as its placeholder. A 400 would make an
    // ordinary torrent look like a broken app.
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK_META);
    const res = await title(releaseDeps({ fetchTitleMetaByNameImpl }), "release=%20%20%20");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "error" });
    expect(fetchTitleMetaByNameImpl).not.toHaveBeenCalled();
  });

  it("shares one OMDb call across every release of the same title", async () => {
    // Fifty releases of one film parse to one title. Without the shared cache
    // key this is fifty lookups against a 1,000/day free key.
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK_META);
    const d = releaseDeps({ fetchTitleMetaByNameImpl });
    await title(d, "release=Kestrel.2010.1080p.BluRay.x264-GROUP&group=Movies");
    await title(d, "release=Kestrel.2010.2160p.WEB-DL.HDR-OTHER&group=Movies");
    expect(fetchTitleMetaByNameImpl).toHaveBeenCalledOnce();
  });

  it("still echoes the parse on a cache hit", async () => {
    const d = releaseDeps();
    await title(d, "release=Kestrel.2010.1080p&group=Movies");
    const second = await title(d, "release=Kestrel.2010.2160p&group=Movies");
    expect(second.json).toMatchObject({ parsed: { title: "Kestrel", year: 2010 } });
  });

  it("does not leak one caller's parse into another's cached answer", async () => {
    const d = releaseDeps();
    await title(d, "release=Kestrel.2010.1080p&group=Movies");
    // A plain ?name= caller shares the cache key but asked for no parse, and
    // must get back exactly the body that route has always returned.
    const byName = await title(d, "name=Kestrel&year=2010&type=movie");
    expect(byName.json).toEqual({
      status: "ok",
      imdbId: "tt9990001",
      plot: "A lone girl.",
      posterUrl: "https://m.media-amazon.com/images/M/kestrel.jpg",
    });
  });

  it("carries the parse through the no-key answer so the pane still has a heading", async () => {
    const res = await title(
      releaseDeps({ loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl" }) }),
      "release=Kestrel.2010.1080p&group=Movies",
    );
    expect(res.json).toEqual({ status: "no-key", parsed: { title: "Kestrel", year: 2010, type: "movie" } });
  });

  it("prefers an explicit imdb id over a release name", async () => {
    const fetchTitleMetaImpl = vi.fn(async () => OK_META);
    const fetchTitleMetaByNameImpl = vi.fn(async () => OK_META);
    await title(
      releaseDeps({ fetchTitleMetaImpl, fetchTitleMetaByNameImpl }),
      "imdb=tt9990001&release=Kestrel.2010.1080p",
    );
    expect(fetchTitleMetaImpl).toHaveBeenCalledOnce();
    expect(fetchTitleMetaByNameImpl).not.toHaveBeenCalled();
  });
});

describe("POST /api/add — adding a search hit by hash and name", () => {
  const HASH = "abcdef0123456789abcdef0123456789abcdef01";

  function addRuntime(): { runtime: Runtime; add: ReturnType<typeof vi.fn>; addDebrid: ReturnType<typeof vi.fn> } {
    const add = vi.fn();
    const addDebrid = vi.fn(() => new Promise<void>(() => {}));
    return {
      runtime: {
        queue: { has: () => false, add, addDebrid } as unknown as Runtime["queue"],
        downloadDir: "/tmp/dl",
        sessions: new StreamSessionRegistry(),
      },
      add,
      addDebrid,
    };
  }

  const post = (d: WebDeps, body: unknown): Promise<WebResponse> =>
    handleWebApi(d, "POST", "/api/add", new URLSearchParams(), AUTH, JSON.stringify(body));

  it("names the queue item from the request, not from the hash", async () => {
    // MUTATION GUARD (the add path losing the name). Search results carry no
    // magnet on the wire, so this add is by bare hash; without `name` the
    // server takes the name from the magnet's `dn`, which a hash-only magnet
    // has none of, and the queue row is called "abcdef01…".
    const { runtime: rt, add } = addRuntime();
    const res = await post(deps({ runtime: rt }), { infoHash: HASH, name: "Kestrel 2010", via: "p2p" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, outcome: "added" });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: HASH, name: "Kestrel 2010" }), "/tmp/dl");
    expect(add.mock.calls[0]![0].name).not.toBe(HASH);
  });

  it("routes an explicit debrid add through Real-Debrid, like the TUI's `r`", async () => {
    const { runtime: rt, add, addDebrid } = addRuntime();
    const res = await post(
      deps({
        runtime: rt,
        loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl", realDebridToken: "rd-tok" }),
      }),
      { infoHash: HASH, name: "Kestrel", via: "debrid" },
    );
    expect(res.status).toBe(200);
    expect(addDebrid).toHaveBeenCalledWith(expect.objectContaining({ name: "Kestrel" }), "/tmp/dl", "rd-tok");
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses a debrid add with no token rather than falling back to the swarm", async () => {
    // A silent P2P fallback would put the user's IP in a public swarm right
    // after they asked for the thing that keeps it out of one.
    const { runtime: rt, add, addDebrid } = addRuntime();
    const res = await post(deps({ runtime: rt }), { infoHash: HASH, name: "Kestrel", via: "debrid" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: expect.stringContaining("Real-Debrid token") });
    expect(add).not.toHaveBeenCalled();
    expect(addDebrid).not.toHaveBeenCalled();
  });

  it("passes a known size through", async () => {
    const { runtime: rt, add } = addRuntime();
    await post(deps({ runtime: rt }), { infoHash: HASH, name: "Kestrel", via: "p2p", sizeBytes: 4096 });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: 4096 }), "/tmp/dl");
  });

  it("rejects an unknown `via` instead of guessing a network", async () => {
    const { runtime: rt, add } = addRuntime();
    const res = await post(deps({ runtime: rt }), { infoHash: HASH, name: "Kestrel", via: "carrier-pigeon" });
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it("rejects an unresolvable hash", async () => {
    const { runtime: rt, add } = addRuntime();
    const res = await post(deps({ runtime: rt }), { infoHash: "nope", name: "Kestrel", via: "p2p" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "invalid magnet or info hash" });
    expect(add).not.toHaveBeenCalled();
  });

  it("rejects a request with a name but nothing to add", async () => {
    const { runtime: rt, add } = addRuntime();
    const res = await post(deps({ runtime: rt }), { name: "Kestrel", via: "p2p" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "missing magnet or info hash" });
    expect(add).not.toHaveBeenCalled();
  });

  // The legacy shape is a documented API other scripts already call. Nothing
  // about it changes: no `name`, no `via`, straight through to the handler that
  // has always answered it.
  it("leaves a plain magnet body on the legacy path, unchanged", async () => {
    const { runtime: rt, add } = addRuntime();
    const res = await post(deps({ runtime: rt }), { magnet: `magnet:?xt=urn:btih:${HASH}&dn=Example` });
    expect(res.status).toBe(200);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: "Example" }), "/tmp/dl");
  });

  it("still answers a non-JSON body the way the legacy route always has", async () => {
    const res = await handleWebApi(deps(), "POST", "/api/add", new URLSearchParams(), AUTH, "not-a-magnet");
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "invalid magnet or info hash" });
  });

  it("does not answer POST /add through the extended path", async () => {
    // The legacy route keeps its own handler: a `name` posted there is ignored,
    // exactly as it was before this route grew one.
    const { runtime: rt, add } = addRuntime();
    const res = await handleWebApi(
      deps({ runtime: rt }),
      "POST",
      "/add",
      new URLSearchParams(),
      AUTH,
      JSON.stringify({ magnet: `magnet:?xt=urn:btih:${HASH}&dn=Example`, name: "Renamed" }),
    );
    expect(res.status).toBe(200);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: "Example" }), "/tmp/dl");
  });
});

describe("GET /api/recommendations", () => {
  const PICK = {
    imdbId: "tt1",
    title: "Ashfall",
    year: 1999,
    score: 0.91,
    reasons: ["because you liked Harrowgate"],
  };

  beforeEach(() => {
    // Both override the config file inside resolveReccConfig, so a developer
    // with a real reccd exported would never see the not-configured path — and
    // the "configured" tests would talk to their actual service.
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  function reccDeps(over: Partial<WebDeps> = {}): WebDeps {
    return deps({
      loadConfigImpl: async () => searchConfig({ reccUrl: "http://recc.local", reccToken: "t" }),
      fetchRecommendationsImpl: async () => ({ ok: true, items: [PICK] }),
      ...over,
    });
  }

  async function feed(d: WebDeps, qs = ""): Promise<WebResponse> {
    return handleWebApi(d, "GET", "/api/recommendations", new URLSearchParams(qs), AUTH, "");
  }

  // The gate is the only thing between an anonymous caller and the user's taste
  // profile: this route does not delegate to handleApi, so nothing re-checks.
  it("rejects an unauthenticated caller when a token is set", async () => {
    const fetchRecommendationsImpl = vi.fn(async () => ({ ok: true as const, items: [PICK] }));
    const res = await handleWebApi(
      reccDeps({ token: "secret", fetchRecommendationsImpl }),
      "GET",
      "/api/recommendations",
      new URLSearchParams(),
      undefined,
      "",
    );
    expect(res.status).toBe(401);
    expect(fetchRecommendationsImpl).not.toHaveBeenCalled();
  });

  it("returns reccd's picks with the reasons intact", async () => {
    const res = await feed(reccDeps());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "ok", items: [PICK] });
  });

  /**
   * THE NOT-CONFIGURED PATH, and the same call `/api/title` makes for a missing
   * OMDb key: a 200 with its own status. A 500 here makes a healthy install
   * look broken when all the UI needs to say is "set up reccd".
   */
  it("answers not-configured with a 200 and its own status, never a 500", async () => {
    const fetchRecommendationsImpl = vi.fn(async () => ({ ok: true as const, items: [PICK] }));
    const res = await feed(reccDeps({ loadConfigImpl: async () => searchConfig(), fetchRecommendationsImpl }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "not-configured" });
    // reccd was never asked.
    expect(fetchRecommendationsImpl).not.toHaveBeenCalled();
  });

  // The confusion the shape exists to prevent: reccd answering "nothing yet"
  // must not read as "you have no reccd".
  it("distinguishes not-configured from a configured reccd with no picks", async () => {
    const res = await feed(reccDeps({ fetchRecommendationsImpl: async () => ({ ok: true, items: [] }) }));
    expect(res.json).toEqual({ status: "ok", items: [] });
    expect(res.json).not.toEqual({ status: "not-configured" });
  });

  it("reports a reccd failure as an error status carrying the message, still a 200", async () => {
    const res = await feed(
      reccDeps({ fetchRecommendationsImpl: async () => ({ ok: false, error: "couldn't reach reccd" }) }),
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "error", error: "couldn't reach reccd" });
  });

  it("passes the filters through to reccd, capped at the TUI's limit", async () => {
    const fetchRecommendationsImpl = vi.fn(async () => ({ ok: true as const, items: [] }));
    await feed(reccDeps({ fetchRecommendationsImpl }), "type=tv&genre=%20horror%20&explore=true");
    expect(fetchRecommendationsImpl).toHaveBeenCalledWith(
      { reccUrl: "http://recc.local", reccToken: "t" },
      { type: "tv", genre: "horror", explore: true, limit: 20 },
    );
  });

  it("treats type=all and an absent explore as no filter at all", async () => {
    const fetchRecommendationsImpl = vi.fn(async () => ({ ok: true as const, items: [] }));
    await feed(reccDeps({ fetchRecommendationsImpl }), "type=all&genre=");
    expect(fetchRecommendationsImpl).toHaveBeenCalledWith(expect.anything(), {
      explore: false,
      limit: 20,
    });
  });

  it("rejects a type reccd does not have rather than quietly searching everything", async () => {
    const fetchRecommendationsImpl = vi.fn(async () => ({ ok: true as const, items: [] }));
    const res = await feed(reccDeps({ fetchRecommendationsImpl }), "type=film");
    expect(res.status).toBe(400);
    expect(fetchRecommendationsImpl).not.toHaveBeenCalled();
  });

  it("ignores a caller-supplied limit", async () => {
    const fetchRecommendationsImpl = vi.fn(async () => ({ ok: true as const, items: [] }));
    await feed(reccDeps({ fetchRecommendationsImpl }), "limit=10000");
    expect(fetchRecommendationsImpl).toHaveBeenCalledWith(expect.anything(), { explore: false, limit: 20 });
  });
});

describe("POST /api/recc-event", () => {
  beforeEach(() => {
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  function eventDeps(over: Partial<WebDeps> = {}): WebDeps {
    return deps({
      loadConfigImpl: async () => searchConfig({ reccUrl: "http://recc.local", reccToken: "t" }),
      postEventImpl: async () => {},
      ...over,
    });
  }

  async function post(d: WebDeps, body: unknown): Promise<WebResponse> {
    return handleWebApi(d, "POST", "/api/recc-event", new URLSearchParams(), AUTH, JSON.stringify(body));
  }

  it("rejects an unauthenticated caller when a token is set", async () => {
    const postEventImpl = vi.fn(async () => {});
    const res = await handleWebApi(
      eventDeps({ token: "secret", postEventImpl }),
      "POST",
      "/api/recc-event",
      new URLSearchParams(),
      undefined,
      JSON.stringify({ type: "liked", rawName: "Ashfall" }),
    );
    expect(res.status).toBe(401);
    expect(postEventImpl).not.toHaveBeenCalled();
  });

  it.each(["watched", "liked", "disliked", "favourited", "unfavourited", "abandoned"] as const)(
    "forwards a %s event with the server's clock and source",
    async (type) => {
      const postEventImpl = vi.fn(async () => {});
      const res = await post(eventDeps({ postEventImpl }), { type, rawName: "Ashfall" });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ status: "accepted" });
      expect(postEventImpl).toHaveBeenCalledWith(
        { reccUrl: "http://recc.local", reccToken: "t" },
        { type, rawName: "Ashfall", ts: expect.any(Number), source: "torlink" },
      );
    },
  );

  // "started" is emitted by the code that actually starts a stream. Accepting
  // it from a button would let a browser fabricate watch history.
  it("refuses to forward a started event", async () => {
    const postEventImpl = vi.fn(async () => {});
    const res = await post(eventDeps({ postEventImpl }), { type: "started", rawName: "Ashfall" });
    expect(res.status).toBe(400);
    expect(postEventImpl).not.toHaveBeenCalled();
  });

  it("rejects an unknown event type and a missing name", async () => {
    const postEventImpl = vi.fn(async () => {});
    const d = eventDeps({ postEventImpl });
    expect((await post(d, { type: "loved", rawName: "x" })).status).toBe(400);
    expect((await post(d, { type: "liked", rawName: "   " })).status).toBe(400);
    expect((await post(d, { rawName: "x" })).status).toBe(400);
    expect(
      (await handleWebApi(d, "POST", "/api/recc-event", new URLSearchParams(), AUTH, "not json")).status,
    ).toBe(400);
    expect(postEventImpl).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied ts and source", async () => {
    const sent: { ts: number; source: string }[] = [];
    const postEventImpl = vi.fn(async (...args: unknown[]) => {
      sent.push(args[1] as { ts: number; source: string });
    });
    const before = Date.now();
    await post(eventDeps({ postEventImpl }), {
      type: "liked",
      rawName: "Ashfall",
      ts: 1924992000000,
      source: "somebody-else",
    });
    const event = sent[0]!;
    expect(event.source).toBe("torlink");
    expect(event.ts).toBeGreaterThanOrEqual(before);
    expect(event.ts).toBeLessThanOrEqual(Date.now());
  });

  it("answers not-configured with a 200, never a 500, and posts nothing", async () => {
    const postEventImpl = vi.fn(async () => {});
    const res = await post(eventDeps({ loadConfigImpl: async () => searchConfig(), postEventImpl }), {
      type: "liked",
      rawName: "Ashfall",
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "not-configured" });
    expect(postEventImpl).not.toHaveBeenCalled();
  });

  /**
   * The fire-and-forget rule, at the HTTP layer. `postEvent` is deliberately a
   * single attempt that swallows everything (see its comment); a route that
   * awaited it would hold the connection open for reccd's whole timeout on
   * every rating click, and a hung reccd would become a queue of stuck requests
   * inside the TUI's own process.
   */
  it("answers without waiting for reccd, and survives a post that rejects", async () => {
    let settle: (() => void) | null = null;
    const postEventImpl = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          settle = () => reject(new Error("reccd exploded"));
        }),
    );
    const res = await post(eventDeps({ postEventImpl }), { type: "watched", rawName: "Ashfall" });
    // Answered while the post is still in flight — nothing awaited it.
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "accepted" });
    expect(settle).not.toBeNull();
    // And the failure it eventually reports is swallowed rather than becoming
    // an unhandled rejection.
    settle!();
    await Promise.resolve();
  });
});

describe("handleWebApi — GET /api/saved", () => {
  it("returns both lists, favourites without their magnets", async () => {
    const res = await handleWebApi(
      deps({
        loadConfigImpl: async () => ({
          ...defaultConfig,
          downloadDir: "/tmp/dl",
          savedSearches: ["tin rivers", "harrowgate s03"],
          favourites: [
            {
              id: "a".repeat(40),
              name: "Kepler.S02.1080p.WEB-DL",
              magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
              source: "eztv" as SourceId,
              sizeBytes: 24_000_000_000,
              addedAt: 1_700_000_000_000,
              watched: ["ep1.mkv", "ep2.mkv", "ep3.mkv"],
            },
          ],
        }),
      }),
      "GET",
      "/api/saved",
      new URLSearchParams(),
      undefined,
      "",
    );

    expect(res.status).toBe(200);
    const body = res.json as SavedResponse;
    expect(body.savedSearches).toEqual(["tin rivers", "harrowgate s03"]);
    expect(body.library).toEqual([
      {
        id: "a".repeat(40),
        name: "Kepler.S02.1080p.WEB-DL",
        source: "eztv",
        sizeBytes: 24_000_000_000,
        addedAt: 1_700_000_000_000,
        watched: 3,
      },
    ]);
    // The magnet must not cross this wire: the page never needs it (playing a
    // favourite goes through POST /api/stream { infoHash, name }), and neither
    // must the episode FILENAMES — `watched` is a count, because the pane
    // renders "3 watched" and the filenames are strings from inside a
    // stranger's torrent.
    expect(JSON.stringify(body)).not.toContain("magnet:");
    expect(JSON.stringify(body)).not.toContain("ep1.mkv");
  });

  it("omits sizeBytes for a favourite stored with a zero size, matching the client's own guard", async () => {
    // savedModel.test.ts's libraryBody test pins the client half of this
    // contract (a zero size is never sent); this pins the server half
    // (toPublicFavourite must not hand one back either, if one is ever on disk).
    const res = await handleWebApi(
      deps({
        loadConfigImpl: async () => ({
          ...defaultConfig,
          downloadDir: "/tmp/dl",
          favourites: [
            {
              id: "a".repeat(40),
              name: "Kepler",
              magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
              sizeBytes: 0,
              addedAt: 1_700_000_000_000,
            },
          ],
        }),
      }),
      "GET",
      "/api/saved",
      new URLSearchParams(),
      undefined,
      "",
    );
    const body = res.json as SavedResponse;
    expect("sizeBytes" in body.library[0]!).toBe(false);
  });

  it("answers empty lists for a config with neither", async () => {
    const res = await handleWebApi(
      deps(),
      "GET",
      "/api/saved",
      new URLSearchParams(),
      undefined,
      "",
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ savedSearches: [], library: [], continueWatching: [] });
  });

  it("requires the token when one is configured", async () => {
    const res = await handleWebApi(
      deps({ token: "secret" }),
      "GET",
      "/api/saved",
      new URLSearchParams(),
      undefined,
      "",
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/saved — continueWatching", () => {
  it("reports titles with their next episode, and no magnets", async () => {
    const res = await handleWebApi(
      deps({
        loadStreamHistoryImpl: async () => [
          { key: "kepler||series", title: "Kepler", type: "series", season: 2, episode: 4,
            rawName: "Kepler.S02E04.1080p", infoHash: "a".repeat(40),
            magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, startedAt: 1_700_000_000_000 },
          { key: "harrowgate||series", title: "Harrowgate", type: "series", season: 3,
            rawName: "Harrowgate.S03.1080p", infoHash: "b".repeat(40),
            magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`, startedAt: 1_600_000_000_000 },
        ],
      }),
      "GET", "/api/saved", new URLSearchParams(), undefined, "",
    );

    const body = res.json as SavedResponse;
    expect(body.continueWatching).toHaveLength(2);
    expect(body.continueWatching[0]).toEqual({
      key: "kepler||series", title: "Kepler", type: "series",
      season: 2, episode: 4, next: { season: 2, episode: 5 },
      rawName: "Kepler.S02E04.1080p", infoHash: "a".repeat(40),
      startedAt: 1_700_000_000_000,
    });
    // A season pack names no episode, so there is no honest next to offer.
    expect(body.continueWatching[1]?.next).toBeNull();
    // Same exclusion as PublicFavourite: playing goes through
    // POST /api/stream { infoHash, name }, which rebuilds the magnet.
    expect(JSON.stringify(body)).not.toContain("magnet:");
  });

  // `SavedResponse.continueWatching` documents "newest first", and the browser
  // deliberately does not re-sort. Ordering is guaranteed by construction
  // (recordStream prepends), so this pins that the route passes the store's
  // order STRAIGHT THROUGH. The fixture's stored order is the reverse of its
  // alphabetical and of its startedAt-ascending order, so any re-sort fails.
  it("passes the store's newest-first order through untouched", async () => {
    const res = await handleWebApi(
      deps({
        loadStreamHistoryImpl: async () => [
          { key: "kepler|series", title: "Kepler", type: "series", season: 2, episode: 4,
            rawName: "Kepler.S02E04.1080p", infoHash: "a".repeat(40),
            magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, startedAt: 1_700_000_000_000 },
          { key: "ashfall|1999|movie", title: "Ashfall", type: "movie", year: 1999,
            rawName: "Ashfall.1999.1080p", infoHash: "b".repeat(40),
            magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`, startedAt: 1_600_000_000_000 },
          { key: "harrowgate|series", title: "Harrowgate", type: "series", season: 3,
            rawName: "Harrowgate.S03.1080p", infoHash: "c".repeat(40),
            magnet: `magnet:?xt=urn:btih:${"c".repeat(40)}`, startedAt: 1_500_000_000_000 },
        ],
      }),
      "GET", "/api/saved", new URLSearchParams(), undefined, "",
    );
    expect((res.json as SavedResponse).continueWatching.map((e) => e.key)).toEqual([
      "kepler|series",
      "ashfall|1999|movie",
      "harrowgate|series",
    ]);
  });

  it("answers an empty list when nothing has been streamed", async () => {
    const res = await handleWebApi(deps(), "GET", "/api/saved", new URLSearchParams(), undefined, "");
    expect((res.json as SavedResponse).continueWatching).toEqual([]);
  });
});

describe("handleWebApi — POST /api/continue-watching", () => {
  function item(over: Partial<StreamHistoryItem> = {}): StreamHistoryItem {
    return {
      key: "kepler||series",
      title: "Kepler",
      type: "series",
      season: 2,
      episode: 4,
      rawName: "Kepler.S02E04.1080p",
      infoHash: "a".repeat(40),
      magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
      startedAt: 1_700_000_000_000,
      ...over,
    };
  }

  const post = (d: WebDeps, body: unknown) =>
    handleWebApi(d, "POST", "/api/continue-watching", new URLSearchParams(), undefined, JSON.stringify(body));

  it("removes the matching entry and returns the rest, dropped magnets included", async () => {
    const saved: StreamHistoryItem[][] = [];
    const d = deps({
      loadStreamHistoryImpl: async () => [item(), item({ key: "harrowgate||series", title: "Harrowgate" })],
      saveStreamHistoryImpl: async (items) => {
        saved.push([...items]);
      },
    });
    const res = await post(d, { key: "kepler||series", action: "remove" });
    expect(res.status).toBe(200);
    const body = res.json as { continueWatching: PublicStreamHistoryItem[] };
    expect(body.continueWatching).toHaveLength(1);
    expect(body.continueWatching[0]?.key).toBe("harrowgate||series");
    expect(JSON.stringify(body)).not.toContain("magnet:");
    expect(saved[0]).toHaveLength(1);
  });

  it("is idempotent — removing a key that is not there changes nothing", async () => {
    const d = deps({
      loadStreamHistoryImpl: async () => [item()],
      saveStreamHistoryImpl: async () => {
        throw new Error("must not be called for a no-op remove");
      },
    });
    const res = await post(d, { key: "no-such-key", action: "remove" });
    expect(res.status).toBe(200);
    expect((res.json as { continueWatching: PublicStreamHistoryItem[] }).continueWatching).toHaveLength(1);
  });

  it("rejects a body missing the key", async () => {
    const d = deps({ loadStreamHistoryImpl: async () => [item()] });
    const res = await post(d, { action: "remove" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown action", async () => {
    const d = deps({ loadStreamHistoryImpl: async () => [item()] });
    const res = await post(d, { key: "kepler||series", action: "toggle" });
    expect(res.status).toBe(400);
  });
});

describe("handleWebApi — POST /api/saved-searches", () => {
  // A fresh capture per test: the route must WRITE, and asserting on what it
  // wrote is the only way to know it persisted rather than answered from memory.
  function capture(config: Partial<Config> = {}) {
    const saved: Config[] = [];
    const d = deps({
      loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...config }),
      saveConfigImpl: async (c: Config) => {
        saved.push(c);
      },
    });
    return { deps: d, saved };
  }

  const post = (d: WebDeps, body: unknown) =>
    handleWebApi(d, "POST", "/api/saved-searches", new URLSearchParams(), undefined, JSON.stringify(body));

  it("adds a query, most-recent first, and persists it", async () => {
    const { deps: d, saved } = capture({ savedSearches: ["harrowgate s03"] });
    const res = await post(d, { query: "tin rivers", action: "toggle" });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ saved: true, savedSearches: ["tin rivers", "harrowgate s03"] });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.savedSearches).toEqual(["tin rivers", "harrowgate s03"]);
  });

  it("toggle removes a query that is already saved", async () => {
    const { deps: d, saved } = capture({ savedSearches: ["tin rivers", "harrowgate s03"] });
    const res = await post(d, { query: "tin rivers", action: "toggle" });

    expect(res.json).toEqual({ saved: false, savedSearches: ["harrowgate s03"] });
    expect(saved[0]?.savedSearches).toEqual(["harrowgate s03"]);
  });

  it("trims the query, so the same search cannot be saved twice", async () => {
    const { deps: d } = capture({ savedSearches: ["tin rivers"] });
    const res = await post(d, { query: "  tin rivers  ", action: "toggle" });
    expect(res.json).toEqual({ saved: false, savedSearches: [] });
  });

  it("remove is idempotent — a double-fired click must not re-add", async () => {
    const { deps: d } = capture({ savedSearches: ["tin rivers"] });
    const first = await post(d, { query: "tin rivers", action: "remove" });
    expect(first.json).toEqual({ saved: false, savedSearches: [] });

    // The SAME query again, on the SAME fixture. loadConfigImpl is a fixed
    // closure over the original config (not the "saved" array from the first
    // call), so this stands in for the second of two clicks that both fired
    // before either write landed. It only pins that "remove" (unlike
    // "toggle") does not flip a *present* entry off and back on twice — see
    // the case below for the one that actually catches remove silently
    // becoming toggle.
    const second = await post(d, { query: "tin rivers", action: "remove" });
    expect(second.json).toEqual({ saved: false, savedSearches: [] });

    // The state a genuinely second-in-line click reads: the entry is already
    // gone. remove() is a no-op here; if it were toggleSavedSearches (i.e.
    // "remove" secretly meant "toggle"), this would ADD "tin rivers" back —
    // which is the actual "must not re-add" this test is named for.
    const { deps: gone } = capture({ savedSearches: [] });
    const third = await post(gone, { query: "tin rivers", action: "remove" });
    expect(third.json).toEqual({ saved: false, savedSearches: [] });
  });

  it("rejects a blank query rather than answering 200 to a no-op", async () => {
    const { deps: d, saved } = capture();
    const res = await post(d, { query: "   ", action: "toggle" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "missing query" });
    expect(saved).toHaveLength(0);
  });

  it("rejects an unknown action and an unparseable body", async () => {
    const { deps: d } = capture();
    const bad = await post(d, { query: "tin rivers", action: "explode" });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: "invalid action" });

    const junk = await handleWebApi(
      d,
      "POST",
      "/api/saved-searches",
      new URLSearchParams(),
      undefined,
      "not json",
    );
    expect(junk.status).toBe(400);
    expect(junk.json).toEqual({ error: "invalid JSON body" });
  });

  it("preserves unrelated config fields — it must not clobber the file", async () => {
    const { deps: d, saved } = capture({
      realDebridToken: "rd-token",
      sort: "seeders:desc",
      disabledSources: ["eztv"],
    });
    await post(d, { query: "tin rivers", action: "toggle" });
    expect(saved[0]?.realDebridToken).toBe("rd-token");
    expect(saved[0]?.sort).toBe("seeders:desc");
    expect(saved[0]?.disabledSources).toEqual(["eztv"]);
  });

  it("requires the token when one is configured", async () => {
    const res = await handleWebApi(
      deps({ token: "secret" }),
      "POST",
      "/api/saved-searches",
      new URLSearchParams(),
      undefined,
      JSON.stringify({ query: "tin rivers", action: "toggle" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("handleWebApi — POST /api/library", () => {
  const HASH = "b".repeat(40);

  beforeEach(() => {
    // Both override the config file inside resolveReccConfig, so a developer
    // with a real reccd exported would never see the not-configured path — and
    // the "configured" tests would talk to their actual service.
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  function fav(over: Partial<FavouriteItem> = {}): FavouriteItem {
    return {
      id: HASH,
      name: "Kepler.S02.1080p.WEB-DL",
      magnet: `magnet:?xt=urn:btih:${HASH}`,
      addedAt: 1_700_000_000_000,
      ...over,
    };
  }

  function capture(config: Partial<Config> = {}) {
    const saved: Config[] = [];
    const events: ReccEvent[] = [];
    const d = deps({
      loadConfigImpl: async () => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...config }),
      saveConfigImpl: async (c: Config) => {
        saved.push(c);
      },
      postEventImpl: async (_cfg, e) => {
        events.push(e);
      },
    });
    return { deps: d, saved, events };
  }

  const post = (d: WebDeps, body: unknown) =>
    handleWebApi(d, "POST", "/api/library", new URLSearchParams(), undefined, JSON.stringify(body));

  it("favourites a search hit, building a magnet the config layer accepts", async () => {
    const { deps: d, saved } = capture();
    const res = await post(d, {
      infoHash: HASH,
      name: "Kepler.S02.1080p.WEB-DL",
      sizeBytes: 24_000_000_000,
      source: "eztv",
      action: "toggle",
    });

    expect(res.status).toBe(200);
    const body = res.json as LibraryResponse;
    expect(body.favourited).toBe(true);
    expect(body.library).toHaveLength(1);
    expect(body.library[0]?.name).toBe("Kepler.S02.1080p.WEB-DL");
    expect(body.library[0]?.watched).toBe(0);

    // The stored entry MUST carry a magnet: a search result has none on the
    // wire, and isFavouriteItem drops an entry without one — so without
    // buildMagnet this favourite would vanish on the next loadConfig.
    const stored = saved[0]?.favourites?.[0];
    expect(stored?.magnet).toContain(`xt=urn:btih:${HASH}`);
    expect(stored?.magnet).toContain("dn=Kepler.S02.1080p.WEB-DL");
    expect(stored?.magnet).toContain("tr=");
  });

  it("omits a zero sizeBytes rather than storing it as a known-and-empty size", async () => {
    const { deps: d, saved } = capture();
    await post(d, { infoHash: HASH, name: "Kepler", sizeBytes: 0, action: "toggle" });
    const stored = saved[0]?.favourites?.[0];
    expect(stored && "sizeBytes" in stored).toBe(false);
  });

  it("stamps addedAt with the server clock, never the browser's", async () => {
    const { deps: d, saved } = capture();
    const before = Date.now();
    await post(d, { infoHash: HASH, name: "Kepler", action: "toggle" });
    const stored = saved[0]?.favourites?.[0];
    expect(stored?.addedAt).toBeGreaterThanOrEqual(before);
    expect(stored?.addedAt).toBeLessThanOrEqual(Date.now());
  });

  it("toggle unfavourites a torrent already in the library", async () => {
    const { deps: d, saved } = capture({ favourites: [fav()] });
    const res = await post(d, { infoHash: HASH, name: "Kepler", action: "toggle" });

    expect((res.json as LibraryResponse).favourited).toBe(false);
    expect((res.json as LibraryResponse).library).toEqual([]);
    expect(saved[0]?.favourites).toEqual([]);
  });

  it("remove is idempotent", async () => {
    const { deps: d } = capture({ favourites: [fav()] });
    const gone = await post(d, { infoHash: HASH, name: "Kepler", action: "remove" });
    expect((gone.json as LibraryResponse).library).toEqual([]);

    const again = await post(d, { infoHash: "c".repeat(40), name: "Other", action: "remove" });
    expect((again.json as LibraryResponse).library).toHaveLength(1);
    expect((again.json as LibraryResponse).favourited).toBe(false);
  });

  it("posts favourited / unfavourited to reccd, so the taste profile matches the TUI", async () => {
    const on = capture({ reccUrl: "http://localhost:4100" });
    await post(on.deps, { infoHash: HASH, name: "Kepler.S02", action: "toggle" });
    expect(on.events).toEqual([
      expect.objectContaining({ type: "favourited", rawName: "Kepler.S02", source: "torlink" }),
    ]);

    const off = capture({ reccUrl: "http://localhost:4100", favourites: [fav()] });
    await post(off.deps, { infoHash: HASH, name: "Kepler.S02", action: "toggle" });
    expect(off.events).toEqual([expect.objectContaining({ type: "unfavourited" })]);
  });

  it("uses the server clock for the event ts, not a browser's", async () => {
    const { deps: d, events } = capture({ reccUrl: "http://localhost:4100" });
    const before = Date.now();
    await post(d, { infoHash: HASH, name: "Kepler", action: "toggle" });
    expect(events[0]?.ts).toBeGreaterThanOrEqual(before);
  });

  it("posts no event on remove — the TUI's ✕ does not rate anything either", async () => {
    const { deps: d, events } = capture({
      reccUrl: "http://localhost:4100",
      favourites: [fav()],
    });
    await post(d, { infoHash: HASH, name: "Kepler", action: "remove" });
    expect(events).toEqual([]);
  });

  it("succeeds with reccd unconfigured, and when the event post rejects", async () => {
    const quiet = capture(); // no reccUrl
    const ok = await post(quiet.deps, { infoHash: HASH, name: "Kepler", action: "toggle" });
    expect(ok.status).toBe(200);
    expect(quiet.events).toEqual([]);

    const broken = deps({
      loadConfigImpl: async () => ({
        ...defaultConfig,
        downloadDir: "/tmp/dl",
        reccUrl: "http://localhost:4100",
      }),
      saveConfigImpl: async () => {},
      postEventImpl: async () => {
        throw new Error("reccd is down");
      },
    });
    const survives = await post(broken, { infoHash: HASH, name: "Kepler", action: "toggle" });
    // reccd must never take a favourite with it: the event is fire-and-forget.
    expect(survives.status).toBe(200);
  });

  it("rejects a bad hash, a missing name, and an unknown action", async () => {
    const { deps: d, saved } = capture();

    const badHash = await post(d, { infoHash: "nope", name: "X", action: "toggle" });
    expect(badHash.status).toBe(400);
    expect(badHash.json).toEqual({ error: "invalid info hash" });

    const blankName = await post(d, { infoHash: HASH, name: "   ", action: "toggle" });
    expect(blankName.status).toBe(400);
    expect(blankName.json).toEqual({ error: "missing name" });

    const badAction = await post(d, { infoHash: HASH, name: "X", action: "explode" });
    expect(badAction.status).toBe(400);
    expect(badAction.json).toEqual({ error: "invalid action" });

    expect(saved).toHaveLength(0);
  });

  it("preserves unrelated config fields", async () => {
    const { deps: d, saved } = capture({ realDebridToken: "rd-token", trackers: ["udp://x/announce"] });
    await post(d, { infoHash: HASH, name: "Kepler", action: "toggle" });
    expect(saved[0]?.realDebridToken).toBe("rd-token");
    expect(saved[0]?.trackers).toEqual(["udp://x/announce"]);
  });

  it("requires the token when one is configured", async () => {
    const res = await handleWebApi(
      deps({ token: "secret" }),
      "POST",
      "/api/library",
      new URLSearchParams(),
      undefined,
      JSON.stringify({ infoHash: HASH, name: "X", action: "toggle" }),
    );
    expect(res.status).toBe(401);
  });

  it("normalizes an uppercase hex hash to lowercase before storing, matching the TUI's dedupe key", async () => {
    const { deps: d, saved } = capture();
    const res = await post(d, { infoHash: HASH.toUpperCase(), name: "Kepler", action: "toggle" });
    expect(res.status).toBe(200);
    const stored = saved[0]?.favourites?.[0];
    expect(stored?.id).toBe(HASH);
    expect(stored?.id).toMatch(/^[a-f0-9]{40}$/);
  });

  it("normalizes a 32-char base32 hash to lowercase hex before storing", async () => {
    // XO53XO53... is the base32 encoding of forty repeated 0xbb bytes, i.e. HASH.
    const { deps: d, saved } = capture();
    const res = await post(d, {
      infoHash: "XO53XO53XO53XO53XO53XO53XO53XO53",
      name: "Kepler",
      action: "toggle",
    });
    expect(res.status).toBe(200);
    const stored = saved[0]?.favourites?.[0];
    expect(stored?.id).toBe(HASH);
    expect(stored?.id).toMatch(/^[a-f0-9]{40}$/);
  });

  it("stores an entry that survives loadConfig's own validation", async () => {
    const { deps: d, saved } = capture();
    await post(d, { infoHash: HASH, name: "Kepler.S02", action: "toggle" });
    const stored = saved[0]?.favourites?.[0];
    // isFavouriteItem's three requirements, which is what would silently drop
    // this entry on the next boot if buildMagnet were ever removed.
    expect(typeof stored?.id).toBe("string");
    expect(stored?.id.length).toBeGreaterThan(0);
    expect(stored?.name.length).toBeGreaterThan(0);
    expect(stored?.magnet.length).toBeGreaterThan(0);
  });

  it("records a watched episode against a favourite", async () => {
    const { deps: d, saved } = capture({ favourites: [fav({ watched: ["ep1.mkv"] })] });
    const res = await post(d, {
      infoHash: HASH,
      name: "Kepler",
      action: "watched",
      filename: "ep2.mkv",
    });

    expect(res.status).toBe(200);
    expect((res.json as LibraryResponse).library[0]?.watched).toBe(2);
    expect(saved[0]?.favourites?.[0]?.watched).toEqual(["ep1.mkv", "ep2.mkv"]);
  });

  it("skips the disk write when nothing changed", async () => {
    // Already recorded: markWatched returns the same array reference, and
    // writing anyway would churn the config file every time a user re-watched
    // an episode.
    const dupe = capture({ favourites: [fav({ watched: ["ep1.mkv"] })] });
    await post(dupe.deps, { infoHash: HASH, name: "Kepler", action: "watched", filename: "ep1.mkv" });
    expect(dupe.saved).toHaveLength(0);

    // Not favourited at all: there is nothing to record against. Still a 200 —
    // the browser fires this after a player launches and must not be handed an
    // error for playing something it never favourited.
    const absent = capture();
    const res = await post(absent.deps, {
      infoHash: HASH,
      name: "Kepler",
      action: "watched",
      filename: "ep1.mkv",
    });
    expect(res.status).toBe(200);
    expect((res.json as LibraryResponse).favourited).toBe(false);
    expect(absent.saved).toHaveLength(0);
  });

  it("rejects watched without a filename", async () => {
    const { deps: d, saved } = capture({ favourites: [fav()] });
    const res = await post(d, { infoHash: HASH, name: "Kepler", action: "watched" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "missing filename" });
    expect(saved).toHaveLength(0);
  });

  it("posts no reccd event for watched — it is progress, not a rating", async () => {
    // The reccd-event gate literally checks `action === "toggle"`, so this
    // already passed before its own fix existed — it does not prove the gate
    // exists, it guards against a FUTURE widening of that gate (e.g. someone
    // adding a "record progress" event type and forgetting to keep "watched"
    // out of it).
    const { deps: d, events } = capture({
      reccUrl: "http://localhost:4100",
      favourites: [fav()],
    });
    await post(d, { infoHash: HASH, name: "Kepler", action: "watched", filename: "ep1.mkv" });
    expect(events).toEqual([]);
  });
});

describe("POST /api/stream — records stream history", () => {
  const HASH = "c".repeat(40);

  // Recording hangs off the session's own resolution, so every test here drives
  // a FAKE registry: with the default one these would each join a real swarm.
  //
  // THE WRITE SEAM IS ALWAYS INJECTED, and every write is captured in `writes`,
  // so no test here can forget it. Enforced by COMPOSITION rather than by
  // convention: the recorder is installed after `over` is spread and delegates to
  // whatever the caller passed, so a test may decide what happens after a write
  // (one deliberately rejects) but cannot decide whether it is counted. Spreading
  // `over` last, as this once did, silently disarms the recorder — and a silently
  // empty `writes` is how the next vacuous `expect(writes).toHaveLength(0)` gets
  // written and believed.
  // deps()'s default seam throws so a forgotten one fails loudly — but on THIS
  // route the throw is swallowed by the fire-and-forget history write (a
  // convenience list must never take a stream down with it), so it is no
  // tripwire here: a test that forgot to inject would pass having recorded
  // nothing, anywhere. Recording unconditionally and asserting `writes` is the
  // loud version of the same check, and it cannot reach real state either way.
  //
  // Scoped to this describe on purpose. A module-wide version was tried and is
  // wrong: the write lands a tick or more after the request, so the test running
  // when it arrives is not the test that caused it, and every attribution — and
  // therefore every failure message — names the wrong test.
  function streamDeps(over: Partial<WebDeps> = {}, sessionsOver = {}) {
    const sessions = registry(sessionsOver);
    const writes: StreamHistoryItem[][] = [];
    const alsoSave = over.saveStreamHistoryImpl;
    const d = deps({
      runtime: runtime(sessions),
      ...over,
      // Record first, then delegate: a caller's own impl still runs (and may
      // still reject, which is a test in here), and the record already happened.
      saveStreamHistoryImpl: async (items) => {
        writes.push([...items]);
        if (alsoSave) await alsoSave(items);
      },
    });
    return { d, sessions, writes };
  }

  it("records the title and posts started to reccd once the session resolves", async () => {
    const events: ReccEvent[] = [];
    const { d, writes } = streamDeps({
      loadConfigImpl: async () => ({
        ...defaultConfig, downloadDir: "/tmp/dl", reccUrl: "http://localhost:4100",
      }),
      loadStreamHistoryImpl: async () => [],
      postEventImpl: async (_c, e) => { events.push(e); },
    });
    const res = await handleWebApi(
      d, "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "Kepler.S02E04.1080p.WEB-DL", confirm: true }),
    );

    expect(res.status).toBeLessThan(500);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.[0]?.title).toBe("Kepler");
    expect(writes[0]?.[0]?.episode).toBe(4);
    // The web posted NO started event before this change — a browser stream
    // taught reccd nothing about having begun.
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events).toEqual([
      expect.objectContaining({ type: "started", rawName: "Kepler.S02E04.1080p.WEB-DL" }),
    ]);
  });

  // The finding this fixes: begin() hands back a `resolving` session, so
  // recording at request time left a permanent unplayable Continue-watching row
  // for a dead magnet. The TUI records only AFTER the resolve returns files, so
  // the same gesture in a terminal wrote nothing. Two front ends, one gesture.
  it("writes nothing when the session never resolves", async () => {
    let loadCalls = 0;
    const { d, sessions, writes } = streamDeps(
      { loadStreamHistoryImpl: async () => { loadCalls += 1; return []; } },
      { streamTorrentImpl: async () => { throw new Error("dead swarm"); } },
    );
    const res = await handleWebApi(
      d, "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "Kepler.S02E04.1080p.WEB-DL", confirm: true }),
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sessions.get("sess1")?.state).toBe("error"));
    expect(writes).toHaveLength(0);
    // As in the no-title case below: an untouched load seam is what separates a
    // clean skip from a crash the catch swallowed.
    expect(loadCalls).toBe(0);
  });

  it("writes exactly one row for one resolved stream", async () => {
    const { d, sessions, writes } = streamDeps({ loadStreamHistoryImpl: async () => [] });
    await handleWebApi(
      d, "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "Kepler.S02E04.1080p.WEB-DL", confirm: true }),
    );
    await vi.waitFor(() => expect(sessions.get("sess1")?.state).toBe("ready"));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toHaveLength(1);
  });

  // The bar for "watchable" is streamCandidates, the TUI's own helper — and the
  // point of pinning it here is that the helper is WIDER than "has a video
  // extension": with nothing playable in the torrent it hands back every file, so
  // a single unrecognised container is still offered to a player rather than
  // silently dropped. A gate that filtered on extension instead would give the
  // browser a stricter rule than the terminal, which is the divergence this pair
  // of tests exists to prevent in either direction.
  it("still records a torrent whose only file is not obviously video", async () => {
    const { d, sessions, writes } = streamDeps(
      { loadStreamHistoryImpl: async () => [] },
      {
        streamTorrentImpl: async () => ({
          name: "Swarm Name",
          files: [{ url: LOCAL_URL, filename: "Kestrel.2010.1080p.BluRay.bin", bytes: 900 }],
          dir: "/tmp/x",
          isComplete: () => false,
          stop: vi.fn(async () => {}),
        }),
      },
    );
    await handleWebApi(
      d, "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "Kestrel.2010.1080p.BluRay.x264", confirm: true }),
    );
    await vi.waitFor(() => expect(sessions.get("sess1")?.state).toBe("ready"));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
  });

  it("writes nothing when the session resolves with no files at all", async () => {
    let loadCalls = 0;
    const { d, sessions, writes } = streamDeps(
      { loadStreamHistoryImpl: async () => { loadCalls += 1; return []; } },
      {
        streamTorrentImpl: async () => ({
          name: "Swarm Name",
          files: [],
          dir: "/tmp/x",
          isComplete: () => false,
          stop: vi.fn(async () => {}),
        }),
      },
    );
    await handleWebApi(
      d, "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "Kepler.S02E04.1080p.WEB-DL", confirm: true }),
    );
    await vi.waitFor(() => expect(sessions.get("sess1")?.state).toBe("ready"));
    expect(writes).toHaveLength(0);
    expect(loadCalls).toBe(0);
  });

  it("does not write history for a name with no title in it", async () => {
    let loadCalls = 0;
    const { d, sessions, writes } = streamDeps({
      loadStreamHistoryImpl: async () => { loadCalls += 1; return []; },
    });
    await handleWebApi(
      d, "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "1080p.WEB-DL.x265", confirm: true }),
    );
    await vi.waitFor(() => expect(sessions.get("sess1")?.state).toBe("ready"));
    expect(writes).toHaveLength(0);
    // `writes` staying empty alone doesn't distinguish "the null guard worked"
    // from "recordStream threw on a null item and the try/catch swallowed
    // it" — both leave `writes` empty. Asserting the persistence seams were
    // never even reached is what actually pins the guard: a clean early
    // return never calls loadStreamHistoryImpl; a crash-and-swallow would
    // have called it first.
    expect(loadCalls).toBe(0);
  });

  // The seam's whole value is that it CANNOT be lost, so that a future
  // `expect(writes).toHaveLength(0)` cannot pass for the wrong reason. Spreading
  // a caller's overrides last made the recorder replaceable, and the test below
  // ("survives a history write that rejects") already replaces it — so the
  // invariant this helper's comment claims has to be enforced, not asserted.
  it("records a write even when the caller brings its own write impl", async () => {
    const own: StreamHistoryItem[][] = [];
    const { d, writes } = streamDeps({
      loadStreamHistoryImpl: async () => [],
      saveStreamHistoryImpl: async (items) => { own.push([...items]); },
    });
    const res = await handleWebApi(
      d, "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "Kepler.S02E04.1080p.WEB-DL", confirm: true }),
    );
    expect(res.status).toBeLessThan(500);
    // Both see it: the recorder is composed with the override, not replaced by it.
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(own).toHaveLength(1);
  });

  it("survives a history write that rejects", async () => {
    // History is a convenience. It must never take a stream down with it.
    // Now that the write happens AFTER the response, "survives" is about the
    // process: the rejection lands in a promise nobody awaits, so vitest would
    // report an unhandled rejection if either the inner try/catch or the outer
    // .catch were removed.
    const { d, sessions } = streamDeps({
      loadStreamHistoryImpl: async () => [],
      saveStreamHistoryImpl: async () => { throw new Error("disk full"); },
    });
    const res = await handleWebApi(
      d, "POST", "/api/stream", new URLSearchParams(), undefined,
      JSON.stringify({ infoHash: HASH, name: "Kepler.S02E04.1080p", confirm: true }),
    );
    expect(res.status).toBeLessThan(500);
    await vi.waitFor(() => expect(sessions.get("sess1")?.state).toBe("ready"));
  });
});
