import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type WebServerHandle } from "./server";
import { isStreamPath, parseStreamPath } from "./stream";
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
    name: "Big Buck Bunny",
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
    name: "Big Buck Bunny",
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
      route: { kind: "realdebrid" },
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
});
