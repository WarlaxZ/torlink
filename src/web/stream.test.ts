import http from "node:http";
import net from "node:net";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type WebServerHandle } from "./server";
import {
  isPlayPath,
  isStreamPath,
  parsePlayPath,
  parseStreamPath,
  playlistFilename,
  requestOrigin,
  splitRepresentation,
} from "./stream";
import { DownloadQueue } from "../download/queue";
import { StreamSessionRegistry, type StreamSessionDeps } from "../core/streamSession";
import type { TorrentStreamSession } from "../integrations/torrentStream";
import type { StreamFile } from "../util/player";
import type { Runtime } from "../daemon/runtime";

// The bytes the fake WebTorrent server serves. Big enough that a range request
// is a real slice of it and that a client can abandon one mid-flight.
const MEDIA = Buffer.from(
  Array.from({ length: 64 * 1024 }, (_, i) => (i * 7 + (i >> 8)) & 0xff),
);

interface Upstream {
  base: string;
  /** Every request the upstream actually received: what the proxy really sent. */
  seen: { method: string; url: string; range: string | undefined }[];
  /** Live TCP connections, so a leak is visible as a count rather than as output. */
  open: Set<net.Socket>;
  close: () => Promise<void>;
}

/**
 * A REAL local http.Server standing in for the WebTorrent server, honouring
 * Range the way it does.
 *
 * Deliberately not an injected fake `request`: a fake cannot show that a Range
 * header survived the wire, that a 206 came back with a matching slice, or that
 * an abandoned request closed its socket. Those are the three things this unit
 * exists to get right.
 */
async function startUpstream(): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const open = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setInterval>>();

  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    seen.push({ method: req.method ?? "", url: req.url ?? "", range: Array.isArray(range) ? range[0] : range });

    if (req.url?.startsWith("/missing")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("nope");
      return;
    }

    // Redirect chains: a provider's download URL can 302 to a specific CDN node.
    if (req.url?.startsWith("/redirect/")) {
      const hops = Number(req.url.slice("/redirect/".length));
      res.writeHead(302, { Location: hops > 1 ? `/redirect/${hops - 1}` : "/media" });
      res.end();
      return;
    }

    // Same redirect, but the connection that carried it resets instead of
    // closing cleanly — simulating a hop's socket dying right after the proxy
    // has already moved on to the next hop's request. Redirects to a
    // deliberately slow next hop so the reset is very likely to reach the
    // client (and fire the stale request's `error`) before that next hop
    // answers — the ordering the guard under test has to survive.
    if (req.url?.startsWith("/redirect-die/")) {
      res.writeHead(302, { Location: "/media-delay" });
      res.flushHeaders();
      // `resetAndDestroy`, not `destroy`: a plain close is a valid end-of-body
      // for a response with no Content-Length, so the client just sees a
      // completed (if bodyless) redirect. An RST is what actually surfaces as
      // an `error` on the client request — the case the guard exists for.
      setImmediate(() => res.socket?.resetAndDestroy());
      return;
    }

    if (req.url?.startsWith("/media-delay")) {
      setTimeout(() => {
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(MEDIA.length),
          "Accept-Ranges": "bytes",
        });
        res.end(MEDIA);
      }, 30);
      return;
    }

    // Never-ending drip, for the teardown test: headers out immediately so the
    // client is reading, then a chunk forever.
    if (req.url?.startsWith("/slow")) {
      res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" });
      const t = setInterval(() => res.write(Buffer.alloc(4096, 1)), 5);
      timers.add(t);
      res.on("close", () => {
        clearInterval(t);
        timers.delete(t);
      });
      return;
    }

    const m = /^bytes=(\d+)-(\d*)$/.exec(typeof range === "string" ? range : "");
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : MEDIA.length - 1;
      const slice = MEDIA.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${MEDIA.length}`,
        "Content-Length": String(slice.length),
        "Accept-Ranges": "bytes",
        "X-Upstream-Marker": "yes",
      });
      res.end(req.method === "HEAD" ? undefined : slice);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(MEDIA.length),
      "Accept-Ranges": "bytes",
      "X-Upstream-Marker": "yes",
    });
    res.end(req.method === "HEAD" ? undefined : MEDIA);
  });

  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    open,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearInterval(t);
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
}

let handle: WebServerHandle | null = null;
let upstream: Upstream | null = null;
const logs: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = null;
  await upstream?.close();
  upstream = null;
  logs.length = 0;
});

function runtimeWith(sessions: StreamSessionRegistry): Runtime {
  return { queue: new DownloadQueue(), downloadDir: "/tmp/dl", sessions };
}

async function start(
  sessions: StreamSessionRegistry,
  over: Parameters<typeof startWebServer>[1] = {},
): Promise<string> {
  handle = await startWebServer(runtimeWith(sessions), {
    port: 0,
    host: "127.0.0.1",
    log: (m) => logs.push(m),
    ...over,
  });
  return `http://127.0.0.1:${handle.port}`;
}

function registry(deps: StreamSessionDeps): StreamSessionRegistry {
  return new StreamSessionRegistry(deps);
}

function fakeHandle(files: StreamFile[]): TorrentStreamSession {
  return {
    name: "Copper Kettle Run",
    files,
    dir: "/tmp/none",
    isComplete: () => true,
    stop: async () => {},
  };
}

// A ready torrent-backed session whose files point at the real upstream above.
async function torrentSession(
  files: StreamFile[],
  capability = "cap-one",
  id = "sid-one",
): Promise<{ reg: StreamSessionRegistry; id: string; capability: string }> {
  const reg = registry({
    idFactory: () => id,
    capabilityFactory: () => capability,
    streamTorrentImpl: async () => fakeHandle(files),
  });
  const session = await reg.start({
    infoHash: "0".repeat(40),
    magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
    name: "Copper Kettle Run",
    route: { kind: "torrent-auto" },
  });
  expect(session.state).toBe("ready");
  return { reg, id, capability };
}

describe("parseStreamPath", () => {
  it("accepts a well-formed handle", () => {
    expect(parseStreamPath("/stream/abc/0")).toEqual({ sid: "abc", index: 0 });
    expect(parseStreamPath("/stream/abc/12")).toEqual({ sid: "abc", index: 12 });
  });

  it("decodes the session id", () => {
    expect(parseStreamPath("/stream/a%2Fb/1")).toEqual({ sid: "a/b", index: 1 });
  });

  // The point of the matcher is what it rejects: every one of these would be a
  // property read or a NaN index if the parser were `Number(segment)`.
  it.each([
    "/stream",
    "/stream/",
    "/stream/abc",
    "/stream/abc/",
    "/stream/abc/-1",
    "/stream/abc/1.5",
    "/stream/abc/1e3",
    "/stream/abc/0x1",
    "/stream/abc/ 1",
    "/stream/abc/length",
    "/stream/abc/0/extra",
    "/stream//0",
    "/stream/a%ZZ/0",
    "/stream/abc/99999999999999999999",
  ])("rejects %s", (p) => {
    expect(parseStreamPath(p)).toBeNull();
  });
});

describe("isStreamPath", () => {
  it("claims /stream and its children only", () => {
    expect(isStreamPath("/stream")).toBe(true);
    expect(isStreamPath("/stream/a/0")).toBe(true);
    expect(isStreamPath("/streaming")).toBe(false);
    expect(isStreamPath("/api/stream/a")).toBe(false);
  });
});

describe("GET /stream/:sid/:idx — WebTorrent proxy", () => {
  async function ready(): Promise<{ base: string; capability: string; id: string }> {
    upstream = await startUpstream();
    const files: StreamFile[] = [
      { url: `${upstream.base}/webtorrent/hash/one.mp4`, filename: "one.mp4", bytes: MEDIA.length },
      { url: `${upstream.base}/webtorrent/hash/two.mp4`, filename: "two.mp4", bytes: MEDIA.length },
    ];
    const { reg, id, capability } = await torrentSession(files);
    const base = await start(reg);
    return { base, capability, id };
  }

  it("serves the whole file with the right capability", async () => {
    const { base, capability, id } = await ready();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(MEDIA.length));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(MEDIA.length);
    expect(body.equals(MEDIA)).toBe(true);
  });

  it("forwards Range upstream and propagates 206 with Content-Range", async () => {
    const { base, capability, id } = await ready();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, {
      headers: { Range: "bytes=0-1023" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-1023/${MEDIA.length}`);
    expect(res.headers.get("content-length")).toBe("1024");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(1024);
    expect(body.equals(MEDIA.subarray(0, 1024))).toBe(true);
    // The upstream's own record: proof the header crossed a socket, not that a
    // fake was called with it.
    expect(upstream!.seen.at(-1)).toMatchObject({ method: "GET", range: "bytes=0-1023" });
  });

  it("forwards a mid-file range", async () => {
    const { base, capability, id } = await ready();
    const res = await fetch(`${base}/stream/${id}/1?k=${capability}`, {
      headers: { Range: "bytes=1000-1099" },
    });
    expect(res.status).toBe(206);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(MEDIA.subarray(1000, 1100))).toBe(true);
    expect(upstream!.seen.at(-1)?.url).toContain("/webtorrent/hash/two.mp4");
  });

  it("answers HEAD with headers and no body", async () => {
    const { base, capability, id } = await ready();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(MEDIA.length));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(upstream!.seen.at(-1)?.method).toBe("HEAD");
  });

  it("propagates a non-2xx upstream status", async () => {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/missing/x.mp4`, filename: "x.mp4", bytes: 1 },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(404);
  });

  it("answers 502 when the upstream is not listening", async () => {
    // A port nothing is on: the WebTorrent server died under a live session.
    const { reg, id, capability } = await torrentSession([
      { url: "http://127.0.0.1:1/webtorrent/x.mp4", filename: "x.mp4", bytes: 1 },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(502);
  });

  it("rejects a non-GET method", async () => {
    const { base, capability, id } = await ready();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  /**
   * The leak test. A seek storm is dozens of range requests abandoned mid-body;
   * without destroying the upstream request each one strands a socket to the
   * WebTorrent server. Asserted as a live-socket count on the upstream, because
   * output assertions structurally cannot see a leak — the client's bytes look
   * identical either way.
   */
  it("destroys the upstream request when the client disconnects", async () => {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/slow/x.mp4`, filename: "x.mp4", bytes: 1 << 30 },
    ]);
    const base = await start(reg);

    const ac = new AbortController();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    expect(upstream.open.size).toBe(1);

    ac.abort();
    await vi.waitFor(() => expect(upstream!.open.size).toBe(0), { timeout: 3000 });
  });

  it("closes the upstream socket after a completed response too", async () => {
    const { base, capability, id } = await ready();
    await fetch(`${base}/stream/${id}/0?k=${capability}`).then((r) => r.arrayBuffer());
    await vi.waitFor(() => expect(upstream!.open.size).toBe(0), { timeout: 3000 });
  });
});

describe("proxy redirects", () => {
  it("follows a single redirect and serves the body", async () => {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/redirect/1`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(MEDIA.length);
  });

  it("re-sends the Range header on the redirected request", async () => {
    // Dropping Range on a hop silently restarts a seek from byte zero, and the
    // client gets bytes it will treat as the start of the file.
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/redirect/1`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, {
      headers: { Range: "bytes=100-199" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${MEDIA.length}`);
    // Both hops saw it, not just the first.
    expect(upstream.seen.filter((s) => s.range === "bytes=100-199").length).toBe(2);
  });

  it("502s rather than looping when a chain is too long", async () => {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/redirect/9`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: 1 },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(502);
  });

  it("still refuses an https upstream on the torrent path", async () => {
    // The WebTorrent backend is loopback http and nothing else. This is the
    // invariant the per-call allow-list exists to preserve.
    const { reg, id, capability } = await torrentSession([
      { url: "https://cdn.example/Kestrel.2010.1080p.BluRay.x264.mkv", filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: 1 },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(502);
    expect(logs.join("\n")).toContain("https:");
    // The scheme is loggable; the URL never is.
    expect(logs.join("\n")).not.toContain("cdn.example");
  });

  /**
   * Regression test for a stale-hop race: hop 1's response handler drains its
   * 302 and calls send() for hop 2 — reassigning `current` — before hop 1's own
   * connection resets and its `error` handler fires. Without the `upstream !==
   * current` guard, that stale error settles the promise with a 502 write, and
   * hop 2's later, real answer then throws trying to writeHead a second time.
   * With the guard, the stale error is ignored and hop 2's answer wins.
   */
  it("ignores a stale hop's socket error once a later hop has taken over", async () => {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/redirect-die/1`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
    ]);
    const base = await start(reg);
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(MEDIA.length);
  });
});

describe("stream handle — capability auth", () => {
  async function ready(): Promise<{ base: string; capability: string; id: string }> {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/webtorrent/hash/one.mp4`, filename: "one.mp4", bytes: MEDIA.length },
    ]);
    const base = await start(reg);
    return { base, capability, id };
  }

  it("401s with no k at all", async () => {
    const { base, id } = await ready();
    const res = await fetch(`${base}/stream/${id}/0`);
    expect(res.status).toBe(401);
    expect(upstream!.seen).toEqual([]);
  });

  it("401s on a wrong k", async () => {
    const { base, id } = await ready();
    expect((await fetch(`${base}/stream/${id}/0?k=nope`)).status).toBe(401);
    // Same length as the real capability, so the guard cannot be passing on a
    // length check alone.
    expect((await fetch(`${base}/stream/${id}/0?k=cap-two`)).status).toBe(401);
    expect((await fetch(`${base}/stream/${id}/0?k=`)).status).toBe(401);
    expect(upstream!.seen).toEqual([]);
  });

  it("does not accept an Authorization header in place of k", async () => {
    const { base, capability, id } = await ready();
    const res = await fetch(`${base}/stream/${id}/0`, {
      headers: { Authorization: `Bearer ${capability}` },
    });
    expect(res.status).toBe(401);
  });

  /**
   * The capability is scoped to ONE session. Two live sessions, and A's
   * capability must not open B's file — otherwise a link shared for one stream
   * is a link to everything the daemon is serving.
   */
  it("does not accept another session's capability", async () => {
    upstream = await startUpstream();
    const file = (n: string): StreamFile => ({
      url: `${upstream!.base}/webtorrent/hash/${n}.mp4`,
      filename: `${n}.mp4`,
      bytes: MEDIA.length,
    });
    // One registry, two sessions: distinct ids and distinct capabilities.
    const ids = ["sid-a", "sid-b"];
    const caps = ["cap-aaaa", "cap-bbbb"];
    let n = 0;
    const reg = registry({
      idFactory: () => ids[n]!,
      capabilityFactory: () => caps[n]!,
      streamTorrentImpl: async () => fakeHandle([file(n === 0 ? "a" : "b")]),
    });
    await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "A",
      route: { kind: "torrent-auto" },
    });
    n = 1;
    await reg.start({
      infoHash: "1".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "1".repeat(40),
      name: "B",
      route: { kind: "torrent-auto" },
    });
    const base = await start(reg);

    // Each with its own capability: fine.
    expect((await fetch(`${base}/stream/sid-a/0?k=cap-aaaa`)).status).toBe(200);
    expect((await fetch(`${base}/stream/sid-b/0?k=cap-bbbb`)).status).toBe(200);
    // Crossed: not fine, and no upstream request is made for either.
    const before = upstream.seen.length;
    expect((await fetch(`${base}/stream/sid-b/0?k=cap-aaaa`)).status).toBe(401);
    expect((await fetch(`${base}/stream/sid-a/0?k=cap-bbbb`)).status).toBe(401);
    expect(upstream.seen.length).toBe(before);
  });

  /**
   * The capability is a MEDIA credential and nothing else. It must not open any
   * /api/* route — not as ?k= (which /api/events accepts as the token) and not
   * as a bearer header.
   */
  it("does not satisfy any /api/ route", async () => {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/webtorrent/hash/one.mp4`, filename: "one.mp4", bytes: 1 },
    ]);
    const base = await start(reg, { token: "server-token" });

    const asQuery = [`/api/status?k=${capability}`, `/api/stream/${id}?k=${capability}`, `/api/events?k=${capability}`];
    for (const p of asQuery) {
      expect(`${p} -> ${(await fetch(`${base}${p}`)).status}`).toBe(`${p} -> 401`);
    }
    const asHeader = ["/api/status", `/api/stream/${id}`, "/api/downloads"];
    for (const p of asHeader) {
      const res = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${capability}` } });
      expect(`${p} -> ${res.status}`).toBe(`${p} -> 401`);
    }
    // And the media handle still works on the same tokened server: the two
    // doors are genuinely separate, not both shut.
    expect((await fetch(`${base}/stream/${id}/0?k=${capability}`)).status).toBe(200);
  });
});

describe("stream handle — 404s, never 500s", () => {
  async function ready(): Promise<{ base: string; capability: string; id: string }> {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      { url: `${upstream.base}/webtorrent/hash/one.mp4`, filename: "one.mp4", bytes: MEDIA.length },
    ]);
    const base = await start(reg);
    return { base, capability, id };
  }

  it("404s an unknown session id", async () => {
    const { base, capability } = await ready();
    expect((await fetch(`${base}/stream/nope/0?k=${capability}`)).status).toBe(404);
  });

  it("404s an index past the end of the file list", async () => {
    const { base, capability, id } = await ready();
    expect((await fetch(`${base}/stream/${id}/1?k=${capability}`)).status).toBe(404);
    expect((await fetch(`${base}/stream/${id}/9?k=${capability}`)).status).toBe(404);
    expect(upstream!.seen).toEqual([]);
  });

  it.each(["-1", "1.5", "abc", "length", "", "0/0"])(
    "404s a malformed index %s",
    async (idx) => {
      const { base, capability } = await ready();
      const res = await fetch(`${base}/stream/sid-one/${idx}?k=${capability}`);
      expect(res.status).toBe(404);
    },
  );

  it("404s a session that is still resolving", async () => {
    const reg = registry({
      idFactory: () => "sid-one",
      capabilityFactory: () => "cap-one",
      // Never settles: the session stays in `resolving` for the whole test.
      streamTorrentImpl: () => new Promise<TorrentStreamSession>(() => {}),
    });
    const { session } = reg.begin({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "A",
      route: { kind: "torrent-auto" },
    });
    expect(session.state).toBe("resolving");
    const base = await start(reg);
    expect((await fetch(`${base}/stream/sid-one/0?k=cap-one`)).status).toBe(404);
  });

  it("404s a session that failed", async () => {
    const reg = registry({
      idFactory: () => "sid-one",
      capabilityFactory: () => "cap-one",
      streamTorrentImpl: async () => {
        throw new Error("swarm died");
      },
    });
    const s = await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "A",
      route: { kind: "torrent-auto" },
    });
    expect(s.state).toBe("error");
    const base = await start(reg);
    expect((await fetch(`${base}/stream/sid-one/0?k=cap-one`)).status).toBe(404);
  });
});

describe("stream handle — Real-Debrid", () => {
  const RD_URL = "https://cdn.real-debrid.example/d/SECRETTOKEN123/movie.mkv";

  async function rdSession(): Promise<{ base: string; capability: string; id: string }> {
    const reg = registry({
      idFactory: () => "sid-rd",
      capabilityFactory: () => "cap-rd",
      resolveDebridImpl: async () => [{ url: RD_URL, filename: "movie.mkv", bytes: 123 }],
    });
    const s = await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "Movie",
      route: { kind: "debrid", provider: "realdebrid" },
      debridToken: "rd-token",
    });
    expect(s.state).toBe("ready");
    const base = await start(reg);
    return { base, capability: "cap-rd", id: "sid-rd" };
  }

  it("302s to the unrestricted link", async () => {
    const { base, capability, id } = await rdSession();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(RD_URL);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("302s a HEAD probe too", async () => {
    const { base, capability, id } = await rdSession();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, {
      method: "HEAD",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(RD_URL);
  });

  it("still requires the capability", async () => {
    const { base, id } = await rdSession();
    const res = await fetch(`${base}/stream/${id}/0?k=wrong`, { redirect: "manual" });
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  /**
   * An unrestricted link is a credential against the user's Real-Debrid
   * account, usable from anywhere until it expires. It goes in exactly one
   * place — the Location header — and never into a log line or a JSON body.
   * The capability must not be logged either: it is in the query string, and
   * the log line carries the path only.
   */
  it("keeps the RD url and the capability out of the log", async () => {
    const { base, capability, id } = await rdSession();
    await fetch(`${base}/stream/${id}/0?k=${capability}`, { redirect: "manual" });
    const all = logs.join("\n");
    expect(all).toContain(`GET /stream/${id}/0 -> 302`);
    expect(all).not.toContain(RD_URL);
    expect(all).not.toContain("SECRETTOKEN123");
    expect(all).not.toContain("real-debrid.example");
    expect(all).not.toContain(capability);
    expect(all).not.toContain("k=");
  });

  it("302s by default — the flag off must change nothing", async () => {
    const { base, capability, id } = await rdSession();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(RD_URL);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("proxies instead of redirecting when the flag is on", async () => {
    upstream = await startUpstream();
    const upstreamBase = upstream.base;
    const reg = registry({
      idFactory: () => "sid-rd",
      capabilityFactory: () => "cap-rd",
      resolveDebridImpl: async () => [
        { url: `${upstreamBase}/media`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
      ],
    });
    const s = await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "Kestrel.2010.1080p.BluRay.x264-GROUP",
      route: { kind: "debrid", provider: "realdebrid" },
      debridToken: "rd-token",
    });
    expect(s.state).toBe("ready");
    const base = await start(reg, { streamDeps: { proxyDebrid: true } });

    const res = await fetch(`${base}/stream/sid-rd/0?k=cap-rd`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(MEDIA.length);
    // The client never learns where the bytes came from.
    expect(res.headers.get("location")).toBeNull();
  });

  it("forwards a Range while proxying, so seeking still works", async () => {
    upstream = await startUpstream();
    const upstreamBase = upstream.base;
    const reg = registry({
      idFactory: () => "sid-rd",
      capabilityFactory: () => "cap-rd",
      resolveDebridImpl: async () => [
        { url: `${upstreamBase}/media`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
      ],
    });
    await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "Kestrel.2010.1080p.BluRay.x264-GROUP",
      route: { kind: "debrid", provider: "realdebrid" },
      debridToken: "rd-token",
    });
    const base = await start(reg, { streamDeps: { proxyDebrid: true } });
    const res = await fetch(`${base}/stream/sid-rd/0?k=cap-rd`, {
      headers: { Range: "bytes=10-19" },
      // Manual, not "follow": a regression to the 302 branch would have the
      // upstream (which also honours Range) answer 206 on the client's behalf,
      // and this test would pass for the wrong reason.
      redirect: "manual",
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${MEDIA.length}`);
  });

  it("never logs the upstream url while proxying", async () => {
    upstream = await startUpstream();
    const upstreamBase = upstream.base;
    const reg = registry({
      idFactory: () => "sid-rd",
      capabilityFactory: () => "cap-rd",
      resolveDebridImpl: async () => [
        { url: `${upstreamBase}/media?secret=SECRETTOKEN123`, filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: MEDIA.length },
      ],
    });
    await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "Kestrel.2010.1080p.BluRay.x264-GROUP",
      route: { kind: "debrid", provider: "realdebrid" },
      debridToken: "rd-token",
    });
    const base = await start(reg, { streamDeps: { proxyDebrid: true } });
    // Manual, not "follow": a regression to the 302 branch would hand the
    // secret-bearing URL to the fetch client as a Location header rather than
    // logging it, and this test would pass despite the regression.
    await fetch(`${base}/stream/sid-rd/0?k=cap-rd`, { redirect: "manual" });
    expect(logs.join("\n")).not.toContain("SECRETTOKEN123");
  });
});

// ---------------------------------------------------------------------------
// The .m3u playlist and the player page.

/**
 * A raw request, because Node's `fetch` silently DROPS a Host override (the
 * same trap server.test.ts documents) and the whole point of these tests is
 * which host header the generated URL is built from.
 */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A request with NO Host header at all, which http.request will not send. */
function hostlessGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.0\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (c: string) => (raw += c));
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);
      resolve({ status, body: raw.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
    });
  });
}

describe("splitRepresentation", () => {
  it("splits a .m3u off and leaves everything else alone", () => {
    expect(splitRepresentation("/stream/a/0.m3u")).toEqual({ path: "/stream/a/0", rep: "playlist" });
    expect(splitRepresentation("/stream/a/0")).toEqual({ path: "/stream/a/0", rep: "media" });
    expect(splitRepresentation("/stream/a/0.m3u8")).toEqual({
      path: "/stream/a/0.m3u8",
      rep: "media",
    });
  });

  it("splits a .info off", () => {
    expect(splitRepresentation("/stream/a/0.info")).toEqual({ path: "/stream/a/0", rep: "info" });
  });

  it("does not treat a near-miss suffix as a representation", () => {
    expect(splitRepresentation("/stream/a/0.information")).toEqual({
      path: "/stream/a/0.information",
      rep: "media",
    });
    expect(splitRepresentation("/stream/a/0.INFO")).toEqual({
      path: "/stream/a/0.INFO",
      rep: "media",
    });
  });
});

describe("GET /stream/:sid/:idx.info", () => {
  const MKV = "Kestrel.2010.1080p.BluRay.x264.mkv";
  const CDN = "https://cdn.real-debrid.example/d/SECRETTOKEN123/1.mkv";

  async function infoSession(
    over: {
      files?: StreamFile[];
      streamDeps?: NonNullable<Parameters<typeof startWebServer>[1]>["streamDeps"];
      name?: string;
    } = {},
  ): Promise<{ base: string; capability: string; id: string }> {
    const reg = registry({
      idFactory: () => "sid-info",
      capabilityFactory: () => "cap-info",
      resolveDebridImpl: async () => over.files ?? [{ url: CDN, filename: MKV, bytes: 123 }],
    });
    const s = await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: over.name ?? "Kestrel.2010.1080p.BluRay.x264-GROUP",
      route: { kind: "debrid", provider: "realdebrid" },
      debridToken: "rd-token",
    });
    expect(s.state).toBe("ready");
    const base = await start(reg, { streamDeps: over.streamDeps });
    return { base, capability: "cap-info", id: "sid-info" };
  }

  it("401s without the capability, before it probes anything", async () => {
    let probes = 0;
    const { base, id } = await infoSession({
      streamDeps: {
        probeImpl: async () => {
          probes += 1;
          return null;
        },
      },
    });
    const res = await fetch(`${base}/stream/${id}/0.info`);
    expect(res.status).toBe(401);
    // The expensive thing must be behind the guard, not beside it.
    expect(probes).toBe(0);
  });

  it("404s for an unknown session", async () => {
    const { base, capability } = await infoSession();
    const res = await fetch(`${base}/stream/nope/0.info?k=${capability}`);
    expect(res.status).toBe(404);
  });

  it("404s for an index past the end of the file list", async () => {
    const { base, capability, id } = await infoSession();
    const res = await fetch(`${base}/stream/${id}/99.info?k=${capability}`);
    expect(res.status).toBe(404);
  });

  it("classifies from the name when there is no ffprobe", async () => {
    const { base, capability, id } = await infoSession({
      streamDeps: { probeImpl: async () => null },
    });
    const res = await fetch(`${base}/stream/${id}/0.info?k=${capability}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts.source).toBe("name");
    expect(body.facts.videoCodec).toBe("h264");
    expect(body.blockers).toEqual(["container"]);
    expect(body.hls).toBeNull();
  });

  it("prefers the probe when there is one", async () => {
    const { base, capability, id } = await infoSession({
      streamDeps: {
        probeImpl: async () => ({
          container: "mkv",
          videoCodec: "hevc",
          audioCodec: "dts",
          source: "probe" as const,
        }),
      },
    });
    const body = await (await fetch(`${base}/stream/${id}/0.info?k=${capability}`)).json();
    expect(body.facts.source).toBe("probe");
    // The name said x264; the file is really hevc. This is the case the probe
    // exists for, and the name-only path would have got it wrong.
    expect(body.blockers).toEqual(["container", "video", "audio"]);
  });

  it("probes once for repeated requests", async () => {
    let probes = 0;
    const { base, capability, id } = await infoSession({
      streamDeps: {
        probeImpl: async () => {
          probes += 1;
          return { container: "mkv", videoCodec: "h264", audioCodec: "aac", source: "probe" as const };
        },
      },
    });
    await fetch(`${base}/stream/${id}/0.info?k=${capability}`);
    await fetch(`${base}/stream/${id}/0.info?k=${capability}`);
    expect(probes).toBe(1);
  });

  it("does not probe a file the name already says is playable", async () => {
    // The common path. A probe is a spawn plus a network round trip bounded at
    // 15s; paying it for an mp4 that was going to play anyway would make every
    // player page load slower to catch a rare mislabelled file.
    let probes = 0;
    const { base, capability, id } = await infoSession({
      files: [{ url: CDN, filename: "Ashfall.1999.1080p.mp4", bytes: 1 }],
      name: "Ashfall.1999.1080p-GROUP",
      streamDeps: {
        probeImpl: async () => {
          probes += 1;
          return null;
        },
      },
    });
    const body = await (await fetch(`${base}/stream/${id}/0.info?k=${capability}`)).json();
    expect(probes).toBe(0);
    expect(body.blockers).toEqual([]);
    expect(body.facts.source).toBe("name");
  });

  it("uses the session's release name for codecs, not just the filename", async () => {
    // A debrid provider often renames the file to something useless; the release
    // it came from is the richer signal and the server has both.
    const { base, capability, id } = await infoSession({
      files: [{ url: CDN, filename: "1.mkv", bytes: 1 }],
      name: "Tin.Rivers.2024.2160p.WEB-DL.x265.DTS-GROUP",
      streamDeps: { probeImpl: async () => null },
    });
    const body = await (await fetch(`${base}/stream/${id}/0.info?k=${capability}`)).json();
    expect(body.facts.videoCodec).toBe("hevc");
    expect(body.facts.audioCodec).toBe("dts");
  });

  it("reports the provider's manifest in .info when one is offered", async () => {
    const { base, capability, id } = await infoSession({
      streamDeps: {
        probeImpl: async () => null,
        resolveHls: async () => "https://4.stream.real-debrid.example/t/ID20/eng1/none/aac/full.m3u8",
      },
    });
    const body = await (await fetch(`${base}/stream/${id}/0.info?k=${capability}`)).json();
    expect(body.hls).toBe(
      "https://4.stream.real-debrid.example/t/ID20/eng1/none/aac/full.m3u8",
    );
    expect(body.blockers).toContain("container");
  });

  it("still reports null hls when the resolver declines", async () => {
    const { base, capability, id } = await infoSession({
      streamDeps: { probeImpl: async () => null, resolveHls: async () => null },
    });
    const body = await (await fetch(`${base}/stream/${id}/0.info?k=${capability}`)).json();
    expect(body.hls).toBeNull();
  });

  it("never puts the upstream url in the response", async () => {
    // The debrid link is a credential against the user's account. The page has
    // no business seeing it and must keep using /stream/:sid/:idx.
    const { base, capability, id } = await infoSession({
      streamDeps: { probeImpl: async () => null },
    });
    const text = await (await fetch(`${base}/stream/${id}/0.info?k=${capability}`)).text();
    expect(text).not.toContain("SECRETTOKEN123");
  });

  it("never logs the capability", async () => {
    const { base, capability, id } = await infoSession({
      streamDeps: { probeImpl: async () => null },
    });
    await fetch(`${base}/stream/${id}/0.info?k=${capability}`);
    expect(logs.join("\n")).not.toContain("cap-info");
  });

  it("rejects a method other than GET or HEAD", async () => {
    const { base, capability, id } = await infoSession();
    const res = await fetch(`${base}/stream/${id}/0.info?k=${capability}`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("still serves media at the unsuffixed path", async () => {
    // The suffix generalisation must not have broken the route it grew out of.
    const { base, capability, id } = await infoSession();
    const res = await fetch(`${base}/stream/${id}/0?k=${capability}`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  it("still serves the playlist at .m3u", async () => {
    const { base, capability, id } = await infoSession();
    const res = await fetch(`${base}/stream/${id}/0.m3u?k=${capability}`);
    expect(res.headers.get("content-type")).toContain("audio/x-mpegurl");
  });
});

describe("requestOrigin", () => {
  it("uses the Host header", () => {
    expect(requestOrigin({ host: "box.local:9162" }, false)).toBe("http://box.local:9162");
    expect(requestOrigin({ host: "[::1]:9162" }, false)).toBe("http://[::1]:9162");
  });

  /**
   * THE MUTATION THIS UNIT EXISTS FOR. X-Forwarded-* are ordinary request
   * headers: with nothing in front of this server, any client can set them.
   * Honouring them by default lets a caller choose the host that ends up in a
   * file the OS hands to a media player.
   */
  it("ignores forwarded headers unless trustProxy is on", () => {
    const headers = {
      host: "box.local:9162",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    };
    expect(requestOrigin(headers, false)).toBe("http://box.local:9162");
    expect(requestOrigin(headers, true)).toBe("https://evil.example");
  });

  it("takes the client-most entry of a forwarded list", () => {
    expect(
      requestOrigin(
        { host: "inner", "x-forwarded-host": "outer.example, inner.example" },
        true,
      ),
    ).toBe("http://outer.example");
  });

  it("falls back to Host when trustProxy is on but nothing was forwarded", () => {
    expect(requestOrigin({ host: "box.local" }, true)).toBe("http://box.local");
  });

  it("only ever produces http or https", () => {
    expect(requestOrigin({ host: "h", "x-forwarded-proto": "javascript" }, true)).toBe("http://h");
    expect(requestOrigin({ host: "h", "x-forwarded-proto": "HTTPS" }, true)).toBe("https://h");
  });

  // Anything that could carry a CRLF into a header, a slash into the authority,
  // or credentials in front of the host is refused rather than sanitised.
  it.each([
    undefined,
    "",
    "box.local/evil.example",
    "box.local\r\nX-Evil: 1",
    "user@box.local",
    "box.local:notaport",
    "box local",
    "http://box.local",
  ])("refuses the host %p", (host) => {
    expect(requestOrigin({ host }, false)).toBeNull();
  });

  it("refuses a malformed forwarded host too", () => {
    expect(requestOrigin({ host: "ok.local", "x-forwarded-host": "a/b" }, true)).toBeNull();
  });
});

describe("playlistFilename", () => {
  it("swaps the media extension for .m3u", () => {
    expect(playlistFilename("Copper.Kettle.Run.mp4")).toBe("Copper.Kettle.Run.m3u");
  });

  // The filename comes out of a torrent and lands in a response header and then
  // on the user's disk: a whitelist, not an escape.
  it.each([
    ['evil"; drop.mkv', "evil_drop.m3u"],
    ["a\r\nX-Evil: 1.mkv", "a_X-Evil_1.m3u"],
    ["../../etc/passwd", "etc_passwd.m3u"],
    [".hidden.mkv", "hidden.m3u"],
    ["", "stream.m3u"],
    ["🎬.mkv", "stream.m3u"],
  ])("sanitises %p to %p", (input, want) => {
    expect(playlistFilename(input)).toBe(want);
  });

  it("caps the length", () => {
    expect(playlistFilename(`${"a".repeat(300)}.mkv`).length).toBe(84);
  });
});

describe("GET /stream/:sid/:idx.m3u", () => {
  async function ready(
    over: Parameters<typeof startWebServer>[1] = {},
  ): Promise<{ base: string; port: number; capability: string; id: string }> {
    upstream = await startUpstream();
    const { reg, id, capability } = await torrentSession([
      {
        url: `${upstream.base}/webtorrent/hash/Copper.Kettle.Run.mp4`,
        filename: "Copper.Kettle.Run.mp4",
        bytes: MEDIA.length,
      },
    ]);
    const base = await start(reg, over);
    return { base, port: handle!.port, capability, id };
  }

  it("serves a playlist whose one line is the absolute handle, capability included", async () => {
    const { port, capability, id } = await ready();
    const res = await rawGet(port, `/stream/${id}/0.m3u?k=${capability}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/x-mpegurl");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="Copper.Kettle.Run.m3u"',
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    const lines = res.body.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`http://127.0.0.1:${port}/stream/${id}/0?k=${capability}`);
    // Absolute, and playable on its own: a relative URL is meaningless once the
    // file has been handed to another application.
    expect(new URL(lines[0]!).searchParams.get("k")).toBe(capability);
    // No upstream request: a playlist is metadata, not media.
    expect(upstream!.seen).toEqual([]);
  });

  it("is fetchable end to end — the URL inside it serves the bytes", async () => {
    const { port, capability, id } = await ready();
    const playlist = await rawGet(port, `/stream/${id}/0.m3u?k=${capability}`);
    const res = await fetch(playlist.body.trim());
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(MEDIA)).toBe(true);
  });

  /**
   * The `.m3u` is a representation of the handle, not a second route, so it
   * cannot skip the capability — which would make a guessed session id enough
   * to obtain a playable URL.
   */
  it("requires the capability", async () => {
    const { port, id, capability } = await ready();
    for (const q of ["", "?k=", "?k=nope", "?k=cap-two"]) {
      const res = await rawGet(port, `/stream/${id}/0.m3u${q}`);
      expect(`${q} -> ${res.status}`).toBe(`${q} -> 401`);
      expect(res.body).not.toContain("/stream/");
    }
    expect((await rawGet(port, `/stream/${id}/0.m3u?k=${capability}`)).status).toBe(200);
  });

  it("404s the same cases the handle does", async () => {
    const { port, capability, id } = await ready();
    expect((await rawGet(port, `/stream/nope/0.m3u?k=${capability}`)).status).toBe(404);
    expect((await rawGet(port, `/stream/${id}/7.m3u?k=${capability}`)).status).toBe(404);
    expect((await rawGet(port, `/stream/${id}/x.m3u?k=${capability}`)).status).toBe(404);
  });

  it("answers HEAD with the headers and no body", async () => {
    const { port, capability, id } = await ready();
    const res = await rawGet(port, `/stream/${id}/0.m3u?k=${capability}`, {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/x-mpegurl");
    expect(res.body).toBe("");
  });

  it("builds the URL from the Host the client actually used", async () => {
    // Tokened, because the tokenless server requires a loopback Host and this
    // test's whole point is a non-loopback one.
    const { port, capability, id } = await ready({ token: "server-token" });
    const res = await rawGet(port, `/stream/${id}/0.m3u?k=${capability}`, {
      Host: "nas.lan:9162",
    });
    expect(res.body.trim()).toBe(`http://nas.lan:9162/stream/${id}/0?k=${capability}`);
  });

  /**
   * MUTATION: trustProxy ignored. With the option off — the default — a client
   * that sets X-Forwarded-Host must not steer the URL the playlist points at.
   */
  it("ignores X-Forwarded-* by default", async () => {
    const { port, capability, id } = await ready({ token: "server-token" });
    const res = await rawGet(port, `/stream/${id}/0.m3u?k=${capability}`, {
      Host: "nas.lan:9162",
      "X-Forwarded-Host": "evil.example",
      "X-Forwarded-Proto": "https",
    });
    expect(res.body.trim()).toBe(`http://nas.lan:9162/stream/${id}/0?k=${capability}`);
    expect(res.body).not.toContain("evil.example");
  });

  it("honours X-Forwarded-* when trustProxy is on", async () => {
    const { port, capability, id } = await ready({ token: "server-token", trustProxy: true });
    const res = await rawGet(port, `/stream/${id}/0.m3u?k=${capability}`, {
      Host: "nas.lan:9162",
      "X-Forwarded-Host": "torlnk.example",
      "X-Forwarded-Proto": "https",
    });
    expect(res.body.trim()).toBe(`https://torlnk.example/stream/${id}/0?k=${capability}`);
  });

  it("400s rather than guessing when the Host is unusable", async () => {
    const { port, capability, id } = await ready({ token: "server-token" });
    const bad = await rawGet(port, `/stream/${id}/0.m3u?k=${capability}`, {
      Host: "nas.lan/evil.example",
    });
    expect(bad.status).toBe(400);
    const none = await hostlessGet(port, `/stream/${id}/0.m3u?k=${capability}`);
    expect(none.status).toBe(400);
    expect(none.body).not.toContain("/stream/");
  });

  /**
   * A Real-Debrid session's playlist points at THIS server's handle, never at
   * the unrestricted link: the redirect happens when the player follows it, so
   * the credential never lands in a file on the user's disk (or in whatever
   * their browser's download history syncs to).
   */
  it("never writes a Real-Debrid link into the file", async () => {
    const RD_URL = "https://cdn.real-debrid.example/d/SECRETTOKEN123/movie.mkv";
    const reg = registry({
      idFactory: () => "sid-rd",
      capabilityFactory: () => "cap-rd",
      resolveDebridImpl: async () => [{ url: RD_URL, filename: "movie.mkv", bytes: 123 }],
    });
    await reg.start({
      infoHash: "0".repeat(40),
      magnet: "magnet:?xt=urn:btih:" + "0".repeat(40),
      name: "Movie",
      route: { kind: "debrid", provider: "realdebrid" },
      debridToken: "rd-token",
    });
    await start(reg);
    const res = await rawGet(handle!.port, "/stream/sid-rd/0.m3u?k=cap-rd");
    expect(res.status).toBe(200);
    expect(res.body.trim()).toBe(
      `http://127.0.0.1:${handle!.port}/stream/sid-rd/0?k=cap-rd`,
    );
    expect(res.body).not.toContain("SECRETTOKEN123");
    expect(res.body).not.toContain("real-debrid.example");
  });

  it("keeps the capability out of the log", async () => {
    const { port, capability, id } = await ready();
    await rawGet(port, `/stream/${id}/0.m3u?k=${capability}`);
    const all = logs.join("\n");
    expect(all).toContain(`GET /stream/${id}/0.m3u -> 200`);
    expect(all).not.toContain(capability);
  });
});

describe("parsePlayPath / isPlayPath", () => {
  it("claims /play and its children only", () => {
    expect(isPlayPath("/play")).toBe(true);
    expect(isPlayPath("/play/a/0")).toBe(true);
    expect(isPlayPath("/player.html")).toBe(false);
    expect(isPlayPath("/playlist")).toBe(false);
  });

  it("parses the same grammar as the stream handle", () => {
    expect(parsePlayPath("/play/abc/3")).toEqual({ sid: "abc", index: 3 });
    expect(parsePlayPath("/play/a%2Fb/0")).toEqual({ sid: "a/b", index: 0 });
  });

  it.each([
    "/play",
    "/play/abc",
    "/play/abc/-1",
    "/play/abc/1.5",
    "/play/abc/length",
    "/play//0",
    "/play/a%ZZ/0",
    "/play/abc/99999999999999999999",
    "/stream/abc/0",
  ])("rejects %s", (p) => {
    expect(parsePlayPath(p)).toBeNull();
  });
});

describe("GET /play/:sid/:idx", () => {
  const assetDirs: string[] = [];

  afterEach(() => {
    while (assetDirs.length) rmSync(assetDirs.pop()!, { recursive: true, force: true });
  });

  function assets(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "torlnk-play-"));
    assetDirs.push(dir);
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>dash</title>");
    writeFileSync(path.join(dir, "player.html"), "<!doctype html><title>player</title>");
    return dir;
  }

  async function serve(over: Parameters<typeof startWebServer>[1] = {}): Promise<string> {
    const { reg } = await torrentSession([
      { url: "http://127.0.0.1:1/x.mp4", filename: "x.mp4", bytes: 1 },
    ]);
    return start(reg, { staticDir: assets(), ...over });
  }

  /**
   * The page is served as static bytes with NOTHING templated into it — it
   * learns which session it is for by parsing its own location. Server-side
   * templating would mean interpolating a torrent's name into HTML.
   */
  it("serves the player HTML", async () => {
    const base = await serve();
    const res = await fetch(`${base}/play/sid-one/0?k=cap-one&n=Copper%20Kettle.mkv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<title>player</title>");
    // Whatever was in the URL is not reflected into the response.
    expect(body).not.toContain("Copper Kettle");
    expect(body).not.toContain("cap-one");
  });

  it("serves the same page for any session — it holds no session data", async () => {
    const base = await serve();
    const a = await fetch(`${base}/play/sid-one/0?k=cap-one`);
    const b = await fetch(`${base}/play/does-not-exist/9`);
    expect(b.status).toBe(200);
    expect(await b.text()).toBe(await a.text());
  });

  it("404s a malformed play path", async () => {
    const base = await serve();
    for (const p of ["/play", "/play/abc", "/play/abc/-1", "/play/abc/x"]) {
      expect(`${p} -> ${(await fetch(`${base}${p}`)).status}`).toBe(`${p} -> 404`);
    }
  });

  it("404s when there are no built assets", async () => {
    const { reg } = await torrentSession([
      { url: "http://127.0.0.1:1/x.mp4", filename: "x.mp4", bytes: 1 },
    ]);
    const base = await start(reg, { findStaticDirImpl: () => null });
    expect((await fetch(`${base}/play/sid-one/0`)).status).toBe(404);
  });

  it("rejects a non-GET method", async () => {
    const base = await serve();
    expect((await fetch(`${base}/play/sid-one/0`, { method: "POST" })).status).toBe(404);
  });
});
