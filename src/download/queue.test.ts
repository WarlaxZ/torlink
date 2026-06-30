import path from "node:path";
import { describe, it, expect } from "vitest";
import { DownloadQueue, strayDownload, type DebridDeps } from "./queue";
import type { HistoryItem } from "./history";

function h(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: "h1",
    name: "Some Download",
    magnet: "magnet:?xt=urn:btih:0000000000000000000000000000000000000000",
    dir: "/downloads",
    sizeBytes: 100,
    completedAt: 1,
    ...over,
  };
}

describe("DownloadQueue seeding", () => {
  it("refuses to seed an entry with no magnet (the only synchronous guard)", () => {
    const q = new DownloadQueue();
    q.startSeeding(h({ id: "h2", magnet: "" }));
    expect(q.getSeed("h2")?.status).toBe("missing");
    expect(q.seedingCount).toBe(0);
    q.suspend();
  });

  it("persistSync flushes every state file without touching the engine", () => {
    const q = new DownloadQueue();
    q.restoreHistory([h({ id: "h3" })]);
    // No engine work, so this never spins up webtorrent and never throws even
    // with a populated history.
    expect(() => q.persistSync()).not.toThrow();
  });

  it("restores a paused seed as paused and does not auto-start it", () => {
    const q = new DownloadQueue();
    q.restoreHistory([h({ id: "h4" })]);
    // A deliberately paused seed must come back paused (visible), not seeding,
    // and without spinning up the engine.
    q.restoreSeeds([{ id: "h4", status: "paused" }]);
    expect(q.getSeed("h4")?.status).toBe("paused");
    expect(q.seedingCount).toBe(0);
    q.suspend();
  });
});

describe("DownloadQueue Real-Debrid path", () => {
  const input = {
    id: "rd1",
    name: "Movie",
    magnet: "magnet:?xt=urn:btih:1111111111111111111111111111111111111111",
  };

  it("completes a Real-Debrid download into history without ever seeding it", async () => {
    const q = new DownloadQueue();
    const deps: DebridDeps = {
      resolveMagnet: async (_token, _magnet, opts) => {
        opts?.onProgress?.(100);
        return [{ url: "https://dl/f", filename: "f.mkv", bytes: 10 }];
      },
      downloadFiles: async (_files, dir, opts) => {
        opts?.onProgress?.({ downloaded: 10, total: 10, speed: 1 });
        return [path.join(dir, "f.mkv")];
      },
    };
    let completed = "";
    q.on("completed", (n: string) => (completed = n));

    await q.addDebrid(input, "/downloads", "tok", deps);

    expect(q.has("rd1")).toBe(false); // moved to history
    expect(q.getHistory().some((h) => h.id === "rd1")).toBe(true);
    expect(q.getSeed("rd1")).toBeUndefined();
    expect(q.seedingCount).toBe(0);
    expect(completed).toBe("Movie");
    q.suspend();
  });

  it("marks the item failed when Real-Debrid resolution errors", async () => {
    const q = new DownloadQueue();
    const deps: DebridDeps = {
      resolveMagnet: async () => {
        throw new Error("dead torrent");
      },
      downloadFiles: async () => [],
    };

    await q.addDebrid(input, "/downloads", "tok", deps);

    const it = q.getItems().find((i) => i.id === "rd1");
    expect(it?.status).toBe("failed");
    expect(it?.error).toContain("dead torrent");
    expect(it?.via).toBe("realdebrid");
    q.suspend();
  });
});

describe("strayDownload (missing-file safety-net)", () => {
  it("ignores a present file being verified (disk read, no network speed)", () => {
    // Large file mid-verify: progress < 1 but network speed is 0.
    expect(strayDownload({ total: 50e9, progress: 0.4, speed: 0 })).toBe(false);
  });

  it("ignores a complete, healthy seed", () => {
    expect(strayDownload({ total: 8e9, progress: 1, speed: 0 })).toBe(false);
  });

  it("flags a seed that is actually pulling missing data off the network", () => {
    expect(strayDownload({ total: 8e9, progress: 0.2, speed: 2e6 })).toBe(true);
  });

  it("ignores a seed before metadata has arrived (total unknown)", () => {
    expect(strayDownload({ total: 0, progress: 0, speed: 0 })).toBe(false);
  });
});
