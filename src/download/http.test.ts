import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { downloadFiles } from "./http";
import type { ResolvedFile } from "../integrations/realdebrid";

const tmpRoots: string[] = [];

async function makeDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `torlink-http-${process.pid}-${tmpRoots.length}`);
  await fs.rm(dir, { recursive: true, force: true });
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((d) => fs.rm(d, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

function file(url: string, filename: string, bytes: number): ResolvedFile {
  return { url, filename, bytes };
}

describe("downloadFiles", () => {
  it("streams each file to disk and reports aggregate progress", async () => {
    const dir = await makeDir();
    const bodies: Record<string, string> = {
      "https://dl/a": "hello",
      "https://dl/b": "world!!",
    };
    const progress: number[] = [];
    const written = await downloadFiles(
      [file("https://dl/a", "a.txt", 5), file("https://dl/b", "b.txt", 7)],
      dir,
      {
        fetchImpl: async (url) => new Response(bodies[url as string]),
        onProgress: (p) => progress.push(p.downloaded),
      },
    );

    expect(written).toEqual([path.join(dir, "a.txt"), path.join(dir, "b.txt")]);
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("hello");
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe("world!!");
    expect(progress.at(-1)).toBe(12); // 5 + 7 bytes total downloaded
  });

  it("sanitizes filenames to a basename (no path traversal)", async () => {
    const dir = await makeDir();
    const written = await downloadFiles([file("https://dl/x", "../../evil.txt", 2)], dir, {
      fetchImpl: async () => new Response("ok"),
    });
    expect(written).toEqual([path.join(dir, "evil.txt")]);
  });

  it("removes partial files and throws on a failed response", async () => {
    const dir = await makeDir();
    await expect(
      downloadFiles([file("https://dl/a", "a.txt", 5), file("https://dl/b", "b.txt", 7)], dir, {
        fetchImpl: async (url) =>
          url === "https://dl/a"
            ? new Response("hello")
            : new Response("nope", { status: 500 }),
      }),
    ).rejects.toBeTruthy();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("throws and writes nothing when the signal is already aborted", async () => {
    const dir = await makeDir();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
        fetchImpl: async () => new Response("hello"),
        signal: ctrl.signal,
      }),
    ).rejects.toBeTruthy();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("resumes a partial file via Range and appends the rest", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hel"); // 3 of 5 bytes
    let seenRange: string | null = null;
    const written = await downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
      fetchImpl: async (_url, init) => {
        seenRange = ((init?.headers as Record<string, string>) ?? {})["Range"] ?? null;
        return new Response("lo", { status: 206 });
      },
    });
    expect(seenRange).toBe("bytes=3-");
    expect(written).toEqual([path.join(dir, "a.txt")]);
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("hello");
  });

  it("restarts a file when the server ignores Range (200)", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "XX"); // stale partial
    await downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
      fetchImpl: async () => new Response("hello", { status: 200 }),
    });
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("hello");
  });

  it("skips a file that is already complete on disk", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hello"); // complete
    let fetched = false;
    const written = await downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
      fetchImpl: async () => {
        fetched = true;
        return new Response("hello");
      },
    });
    expect(fetched).toBe(false);
    expect(written).toEqual([path.join(dir, "a.txt")]);
  });

  it("keeps partial files when aborted with reason 'pause'", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hel");
    const ctrl = new AbortController();
    ctrl.abort("pause");
    await expect(
      downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
        fetchImpl: async () => new Response("lo", { status: 206 }),
        signal: ctrl.signal,
      }),
    ).rejects.toBeTruthy();
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("hel");
  });

  it("deletes partial files when aborted with reason 'cancel'", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hel");
    const ctrl = new AbortController();
    ctrl.abort("cancel");
    await expect(
      downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
        fetchImpl: async () => new Response("lo", { status: 206 }),
        signal: ctrl.signal,
      }),
    ).rejects.toBeTruthy();
    await expect(fs.access(path.join(dir, "a.txt"))).rejects.toBeTruthy();
  });
});
