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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

// A real, decodable 2x2 JPEG — the stub above has a JPEG magic number but no
// scan data, so only an encoded image exercises the render path end to end.
const REAL_JPEG = Buffer.from(
  jpeg.encode({ data: Buffer.alloc(2 * 2 * 4, 0x40), width: 2, height: 2 }, 80).data,
);

function okResponse(body: Buffer): Response {
  return new Response(body, { status: 200 });
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

  it("returns null for a non-http url without fetching", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    expect(await getPoster("file:///etc/passwd", { dir, fetchImpl })).toBeNull();
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
    const fetchImpl = vi.fn(async (u: string) =>
      u.includes("omdbapi")
        ? redirectResponse("https://m.media-amazon.com/real.jpg")
        : okResponse(JPEG),
    );
    const hit = await getPoster("https://img.omdbapi.com/?i=tt1", { dir, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(hit).not.toBeNull();
    expect(hit?.bytes).toBe(JPEG.length);
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

describe("cachedPosterRows", () => {
  it("returns null when the poster can't be fetched", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await cachedPosterRows("https://x/a.jpg", 4, 4, { dir, fetchImpl })).toBeNull();
  });

  it("renders rows from the cached file on a hit", async () => {
    const fetchImpl = vi.fn(async () => okResponse(REAL_JPEG));
    const rows = await cachedPosterRows("https://x/a.jpg", 2, 2, { dir, fetchImpl });
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(0);
    expect(rows![0]).toContain("▀");
  });

  it("returns null when the cached bytes aren't decodable", async () => {
    const fetchImpl = vi.fn(async () => okResponse(JPEG));
    expect(await cachedPosterRows("https://x/a.jpg", 4, 4, { dir, fetchImpl })).toBeNull();
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
