import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPoster, posterFileName, prunePosters } from "./posterCache";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function okResponse(body: Buffer): Response {
  return new Response(body, { status: 200 });
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

    await expect(fs.readdir(dir)).resolves.toEqual(["mid.jpg", "new.jpg"]);
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
