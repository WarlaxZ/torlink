import path from "node:path";
import { describe, it, expect } from "vitest";
import { DownloadQueue, strayDownload, type DebridDeps } from "./queue";
import type { HistoryItem } from "./history";
import { RealDebridError } from "../integrations/realdebrid";

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

describe("DownloadQueue Real-Debrid scheduling", () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("runs at most two Real-Debrid downloads at once; the rest wait as queued", async () => {
    const q = new DownloadQueue();
    const gates: Array<() => void> = [];
    let started = 0;
    const deps: DebridDeps = {
      resolveMagnet: async (_t, _m, opts) => {
        started++;
        await new Promise<void>((res) => gates.push(res)); // block until released
        opts?.onProgress?.(100);
        return [{ url: "u", filename: "f.mkv", bytes: 1 }];
      },
      downloadFiles: async () => [],
      sleep: async () => {},
    };
    const inputs = [1, 2, 3, 4].map((n) => ({ id: `rd${n}`, name: `M${n}`, magnet: `m${n}` }));
    const all = Promise.all(inputs.map((i) => q.addDebrid(i, "/downloads", "tok", deps)));

    await tick();
    await tick();
    expect(started).toBe(2);
    expect(q.getItems().filter((it) => it.phase === "queued")).toHaveLength(2);

    for (let released = 0; released < 4; released++) {
      while (gates.length === 0) await tick();
      gates.shift()!();
      await tick();
    }
    await all;
    expect(started).toBe(4);
    expect(q.getItems()).toHaveLength(0);
    q.suspend();
  });

  it("auto-requeues a transient (503) failure and eventually succeeds", async () => {
    const q = new DownloadQueue();
    let calls = 0;
    const deps: DebridDeps = {
      resolveMagnet: async (_t, _m, opts) => {
        calls++;
        if (calls < 3) throw new RealDebridError("busy", 503);
        opts?.onProgress?.(100);
        return [{ url: "u", filename: "f.mkv", bytes: 1 }];
      },
      downloadFiles: async () => [],
      sleep: async () => {},
    };
    await q.addDebrid({ id: "rd1", name: "M", magnet: "m" }, "/downloads", "tok", deps);
    expect(calls).toBe(3);
    expect(q.has("rd1")).toBe(false);
    q.suspend();
  });

  it("fails a terminal error immediately without requeuing", async () => {
    const q = new DownloadQueue();
    let calls = 0;
    const deps: DebridDeps = {
      resolveMagnet: async () => {
        calls++;
        throw new RealDebridError("No seeders — Real-Debrid can't fetch this torrent."); // no status = terminal
      },
      downloadFiles: async () => [],
      sleep: async () => {},
    };
    await q.addDebrid({ id: "rd1", name: "M", magnet: "m" }, "/downloads", "tok", deps);
    expect(calls).toBe(1);
    expect(q.getItems().find((i) => i.id === "rd1")?.status).toBe("failed");
    q.suspend();
  });

  it("frees the concurrency slot when a running item is cancelled, letting a queued one start", async () => {
    const q = new DownloadQueue();
    const gates: Array<() => void> = [];
    const started: string[] = [];
    const deps: DebridDeps = {
      resolveMagnet: async (_t, magnet, opts) => {
        started.push(magnet);
        await new Promise<void>((res, rej) => {
          gates.push(res);
          // Respect cancellation the way the real resolveMagnet does.
          opts?.signal?.addEventListener("abort", () =>
            rej(new RealDebridError("Real-Debrid request cancelled.")),
          );
        });
        opts?.onProgress?.(100);
        return [{ url: "u", filename: "f.mkv", bytes: 1 }];
      },
      downloadFiles: async () => [],
      sleep: async () => {},
    };
    const inputs = [1, 2, 3].map((n) => ({ id: `rd${n}`, name: `M${n}`, magnet: `m${n}` }));
    const all = Promise.all(inputs.map((i) => q.addDebrid(i, "/downloads", "tok", deps)));

    await tick();
    await tick();
    expect(started).toHaveLength(2); // cap = 2; rd3 waiting

    q.cancel("rd1"); // cancel a running item → its slot should free
    await tick();
    await tick();
    expect(started).toHaveLength(3); // rd3 acquired the freed slot
    expect(q.has("rd1")).toBe(false); // cancelled item is gone

    // Let the two remaining pipelines finish so the test settles.
    while (gates.length > 0) {
      gates.shift()!();
      await tick();
    }
    await all;
    q.suspend();
  });

  it("pauses an in-progress Real-Debrid download and resumes it to completion", async () => {
    const q = new DownloadQueue();
    let downloadCalls = 0;
    const deps: DebridDeps = {
      resolveMagnet: async () => [{ url: "u", filename: "f.mkv", bytes: 10 }],
      downloadFiles: async (_files, _dir, opts) => {
        downloadCalls++;
        if (downloadCalls === 1) {
          // First run: block until the pause aborts us, then throw like a real abort.
          await new Promise<void>((_res, rej) => {
            opts?.signal?.addEventListener("abort", () =>
              rej(Object.assign(new Error("Download aborted."), { name: "AbortError" })),
            );
          });
        }
        opts?.onProgress?.({ downloaded: 10, total: 10, speed: 0 });
        return ["/downloads/f.mkv"];
      },
      sleep: async () => {},
    };

    const p = q.addDebrid({ id: "rd1", name: "M", magnet: "m" }, "/downloads", "tok", deps);
    await tick();
    await tick();

    q.pause("rd1");
    await p; // driveDebrid returns once the pause abort unwinds
    expect(q.getItems().find((i) => i.id === "rd1")?.status).toBe("paused");

    q.resume("rd1");
    for (let n = 0; n < 5 && q.has("rd1"); n++) await tick();
    expect(q.has("rd1")).toBe(false); // second download run completed → history
    expect(downloadCalls).toBe(2);
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
