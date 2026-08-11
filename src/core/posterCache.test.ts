import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import jpeg from "jpeg-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedPosterRows,
  getPoster,
  MAX_POSTER_BYTES,
  posterFileName,
  prunePosters,
} from "./posterCache";
import * as net from "../util/net";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

// A real, decodable 2x2 JPEG — the stub above has a JPEG magic number but no
// scan data, so only an encoded image exercises the render path end to end.
const REAL_JPEG = Buffer.from(
  jpeg.encode({ data: Buffer.alloc(2 * 2 * 4, 0x40), width: 2, height: 2 }, 80).data,
);

// The copy into a plain Uint8Array is for the type checker, not for the test:
// with "DOM" in tsconfig's `lib` (the browser dashboard needs it) `BodyInit`
// comes from lib.dom, whose BufferSource does not admit Buffer<ArrayBufferLike>.
function okResponse(body: Buffer): Response {
  return new Response(new Uint8Array(body), { status: 200 });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-poster-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("posterFileName", () => {
  it("is stable for the same url and differs across urls", () => {
    expect(posterFileName("https://x/a.jpg")).toBe(posterFileName("https://x/a.jpg"));
    expect(posterFileName("https://x/a.jpg")).not.toBe(posterFileName("https://x/b.jpg"));
  });

  it("is a bare filename, never a path", () => {
    expect(posterFileName("https://x/a.jpg")).toMatch(/^[0-9a-f]{40}\.jpg$/);
  });
});

describe("getPoster", () => {
  it("fetches once and serves the second call from disk", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    const first = await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl });
    const second = await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).not.toBeNull();
    expect(second?.path).toBe(first?.path);
    expect(second?.bytes).toBe(JPEG.length);
    await expect(fs.readFile(first!.path)).resolves.toEqual(JPEG);
  });

  // The regression this guards: getPoster used the global `fetch` rather than
  // torlink's `torlinkFetch`, so poster fetches silently skipped the custom-DNS
  // dispatcher every other request honours. On a box with custom DNS set (common
  // where a network sinkholes DNS), every poster 404'd while search, OMDb and
  // debrid — all routed through torlinkFetch — worked. The default MUST be the
  // shared fetch so posters resolve the same way as everything else.
  it("uses torlink's DNS-aware fetch when no fetchImpl is injected", async () => {
    const spy = vi.spyOn(net, "torlinkFetch").mockResolvedValue(okResponse(JPEG));
    try {
      const hit = await getPoster("https://m.media-amazon.com/a.jpg", { dir });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(hit).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns null for a non-http url without fetching", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    expect(await getPoster("file:///etc/passwd", { dir, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // The allowlist is enforced here, not at each call site, so that "getPoster
  // only ever fetches poster CDNs" holds for callers that never thought about it.
  it("refuses a url outside the host allowlist without fetching", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    expect(await getPoster("http://169.254.169.254/latest/meta-data", { dir, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  // The gate runs before the cache stat, so a file already sitting in the cache
  // directory under a disallowed URL's hash is still never served. Writes go
  // through the same gate, so such an entry can't get there legitimately — but
  // that argument is exactly the sort a later refactor breaks silently.
  it("refuses a disallowed url even when the cache already holds a file for it", async () => {
    const url = "http://169.254.169.254/latest/meta-data";
    await fs.writeFile(path.join(dir, posterFileName(url)), JPEG);
    const fetchImpl = vi.fn(async () => okResponse(JPEG));

    expect(await getPoster(url, { dir, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a lookalike subdomain of an allowlisted host", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    expect(
      await getPoster("https://m.media-amazon.com.evil.example/a.jpg", { dir, fetchImpl }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the fetch fails and writes nothing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl })).toBeNull();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl })).toBeNull();
  });

  it("rejects a 200 body that is not a JPEG and caches nothing", async () => {
    const fetchImpl = vi.fn(async () => okResponse(Buffer.from("<html>not an image</html>")));
    expect(await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl })).toBeNull();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("rejects a body over the size cap and caches nothing", async () => {
    const huge = Buffer.alloc(MAX_POSTER_BYTES + 1);
    huge[0] = 0xff;
    huge[1] = 0xd8;
    const fetchImpl = vi.fn(async () => okResponse(huge));
    expect(await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl })).toBeNull();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("bails on an oversized content-length without reading the body", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const fetchImpl = vi.fn(async () => {
      const res = new Response(JPEG, {
        status: 200,
        headers: { "content-length": String(MAX_POSTER_BYTES + 1) },
      });
      return Object.assign(res, { arrayBuffer }) as unknown as Response;
    });
    expect(await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl })).toBeNull();
    expect(arrayBuffer).not.toHaveBeenCalled();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });
});

// The allowlist only ever validated the URL a caller handed us, and fetch
// follows redirects by default — so an allowlisted CDN with an open redirect
// could bounce us anywhere, and the outbound request fires whether or not we
// ever look at the response. These pin the hop itself.
describe("getPoster redirects", () => {
  it("follows one hop to another allowlisted CDN", async () => {
    // Typed with the init param so the shared-signal assertion below can reach it.
    const fetchImpl = vi.fn(async (u: string, _init?: RequestInit) =>
      u.includes("omdbapi")
        ? redirectResponse("https://m.media-amazon.com/real.jpg")
        : okResponse(JPEG),
    );
    const hit = await getPoster("https://img.omdbapi.com/?i=tt1", { dir, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(hit).not.toBeNull();
    expect(hit?.bytes).toBe(JPEG.length);
    // One deadline for the whole exchange: a fresh timeout per hop would let a
    // redirect chain double the time a caller can be made to wait.
    expect(fetchImpl.mock.calls[0]![1]!.signal).toBe(fetchImpl.mock.calls[1]![1]!.signal);
  });

  // Without redirect: "manual" the real fetch follows hops internally and every
  // check in redirectTarget becomes unreachable dead code. Injected fakes ignore
  // init, so asserting on it is the only way to pin the guard that makes the
  // rest of this describe block mean anything in production.
  it("asks fetch not to follow redirects itself", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://m.media-amazon.com/a.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  // 302 is the only status the other tests here exercise, so without this every
  // other redirect status is an untested claim: a real 301 from a CDN would fall
  // through to the !res.ok check and silently produce a placeholder.
  it.each([301, 303, 307, 308])("follows a %i redirect to an allowlisted CDN", async (status) => {
    const fetchImpl = vi.fn(async (u: string) =>
      u.includes("omdbapi")
        ? new Response(null, { status, headers: { location: "https://m.media-amazon.com/real.jpg" } })
        : okResponse(JPEG),
    );
    const hit = await getPoster(`https://img.omdbapi.com/?i=tt${status}`, { dir, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(hit).not.toBeNull();
  });

  // A relative Location is legal and common; resolving it needs the URL we
  // actually requested as a base, or it throws and degrades to a placeholder.
  it("resolves a relative Location against the requested url", async () => {
    const fetchImpl = vi.fn(async (u: string) =>
      u.endsWith("/a.jpg") ? redirectResponse("/b.jpg") : okResponse(JPEG),
    );
    const hit = await getPoster("https://m.media-amazon.com/images/a.jpg", { dir, fetchImpl });

    expect(hit).not.toBeNull();
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://m.media-amazon.com/b.jpg", expect.anything());
  });

  it("refuses a redirect off the allowlist without following it", async () => {
    const fetchImpl = vi.fn(async () =>
      redirectResponse("http://169.254.169.254/latest/meta-data"),
    );
    expect(await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl })).toBeNull();

    // Exactly one call: the metadata service is never contacted at all.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("refuses an endless redirect chain", async () => {
    const fetchImpl = vi.fn(async () => redirectResponse("https://m.media-amazon.com/next.jpg"));
    expect(await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl })).toBeNull();

    // One hop is the whole budget: the original request plus a single follow.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  // A redirect target must clear the same bar as a directly-supplied URL, or the
  // hop becomes a way around the body checks rather than a path through them.
  it("holds the redirect target to the magic-byte check", async () => {
    const fetchImpl = vi.fn(async (u: string) =>
      u.endsWith("/a.jpg")
        ? redirectResponse("https://ia.media-imdb.com/evil.jpg")
        : okResponse(Buffer.from("<html>not an image</html>")),
    );
    expect(await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl })).toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("returns null when a redirect has no location header", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));
    expect(await getPoster("https://m.media-amazon.com/a.jpg", { dir, fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// Two properties getPoster's docblock asserts but nothing exercised: the cache
// cap is actually enforced from the write path, and a hit is LRU rather than FIFO.
// Both fail silently — the cache just grows, or evicts the wrong thing.
describe("getPoster housekeeping", () => {
  it("prunes to the cap from the write path", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    // Pin the directory for the whole loop. `dir` is module state that beforeEach
    // reassigns, and an async test body keeps running after vitest abandons it on
    // timeout — so reading `dir` per iteration lets a slow runner spray this
    // loop's writes into a *later* test's directory. That fails as a stray
    // sha1 .jpg/.tmp in the prunePosters assertions, and as ENOTEMPTY from
    // afterEach racing a write, which reads as a bug anywhere but here.
    const own = dir;
    // writesSincePrune is module state shared with the tests above, so make no
    // assumption about its value: PRUNE_EVERY_N_WRITES successful writes cross
    // the threshold from anywhere in its range.
    for (let i = 0; i < 50; i++) {
      await getPoster(`https://m.media-amazon.com/p${i}.jpg`, {
        dir: own,
        fetchImpl,
        maxBytes: 100,
      });
    }

    // prunePosters is fire-and-forget from getPoster, so wait for it to land.
    await vi.waitFor(async () => {
      expect((await fs.readdir(own)).length).toBeLessThan(50);
    });
    // 50 sequential write-then-rename round trips are ~10ms locally but have
    // exceeded the 5s default on a loaded Windows runner.
  }, 30_000);

  it("touches mtime on a cache hit so eviction is LRU, not FIFO", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    const url = "https://m.media-amazon.com/lru.jpg";
    const hit = await getPoster(url, { dir, fetchImpl });

    // Backdate the cached file, then read it through the cache again.
    const old = new Date("2000-01-01T00:00:00Z").getTime() / 1000;
    await fs.utimes(hit!.path, old, old);
    await getPoster(url, { dir, fetchImpl });

    const { mtimeMs } = await fs.stat(hit!.path);
    expect(mtimeMs).toBeGreaterThan(old * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // served from disk, not refetched
  });
});

describe("cachedPosterRows", () => {
  it("returns null when the poster can't be fetched", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await cachedPosterRows("https://m.media-amazon.com/a.jpg", 4, 4, { dir, fetchImpl })).toBeNull();
  });

  it("renders rows from the cached file on a hit", async () => {
    const fetchImpl = vi.fn(async () => okResponse(REAL_JPEG));
    const rows = await cachedPosterRows("https://m.media-amazon.com/a.jpg", 2, 2, { dir, fetchImpl });
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(0);
    expect(rows![0]).toContain("▀");
  });

  it("returns null when the cached bytes aren't decodable", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    expect(await cachedPosterRows("https://m.media-amazon.com/a.jpg", 4, 4, { dir, fetchImpl })).toBeNull();
  });
});

describe("prunePosters", () => {
  it("deletes the oldest files until under the cap", async () => {
    const write = async (name: string, size: number, mtimeMs: number): Promise<void> => {
      const file = path.join(dir, name);
      await fs.writeFile(file, Buffer.alloc(size));
      await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
    };
    await write("old.jpg", 100, 1_000_000);
    await write("mid.jpg", 100, 2_000_000);
    await write("new.jpg", 100, 3_000_000);

    await prunePosters(dir, 250);

    // readdir order is not guaranteed by POSIX; compare the set, sorted.
    expect((await fs.readdir(dir)).sort()).toEqual(["mid.jpg", "new.jpg"]);
  });

  it("is a no-op under the cap", async () => {
    await fs.writeFile(path.join(dir, "a.jpg"), Buffer.alloc(10));
    await prunePosters(dir, 1000);
    await expect(fs.readdir(dir)).resolves.toEqual(["a.jpg"]);
  });

  it("never throws on a missing directory", async () => {
    await expect(prunePosters(path.join(dir, "nope"), 10)).resolves.toBeUndefined();
  });
});
