import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { DownloadQueue, seedPolicyReached, strayDownload, type DebridDeps } from "./queue";
import type { HistoryItem } from "./history";
import { RealDebridError } from "../integrations/debrid/realdebrid";
import { TorBoxError } from "../integrations/debrid/torbox";
import { deleteTorrentMeta, saveTorrentMeta } from "./persist";

const tmpDirs: string[] = [];

describe("seedPolicyReached", () => {
  it("stops at either the configured ratio or duration", () => {
    expect(seedPolicyReached(200, 100, 1_000, 2, 0)).toBe(true);
    expect(seedPolicyReached(0, 100, 60_000, 0, 1)).toBe(true);
    expect(seedPolicyReached(50, 100, 30_000, 2, 1)).toBe(false);
  });
  it("treats zero values as unlimited", () => {
    expect(seedPolicyReached(10_000, 100, 10_000_000, 0, 0)).toBe(false);
  });
});
async function tmpDir(): Promise<string> {
  const d = path.join(os.tmpdir(), `torlink-queue-${process.pid}-${tmpDirs.length}`);
  await fs.rm(d, { recursive: true, force: true });
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  tmpDirs.length = 0;
});

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

  it("exports cached .torrent metadata for a history item", async () => {
    const q = new DownloadQueue();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-queue-export-"));
    // Unique id: saveTorrentMeta writes into the shared torrents dir keyed by id,
    // so a fixed id would collide with any concurrent run using the same one.
    const item = h({ id: `export-${path.basename(outDir)}`, name: "Some/Torrent", dir: outDir });
    try {
      q.restoreHistory([item]);
      await saveTorrentMeta(item.id, new Uint8Array([5, 6, 7]));

      const file = await q.exportTorrentFile(item.id);

      expect(file).toBe(path.join(outDir, "Some Torrent.torrent"));
      await expect(fs.readFile(file!)).resolves.toEqual(Buffer.from([5, 6, 7]));
    } finally {
      deleteTorrentMeta(item.id);
      await fs.rm(outDir, { recursive: true, force: true });
      q.suspend();
    }
  });
});

describe("DownloadQueue file selection", () => {
  it("rejects an empty or unknown selection", () => {
    const q = new DownloadQueue();
    q.restore([{
      id: "pick1",
      name: "Collection",
      magnet: "magnet:?xt=urn:btih:2222222222222222222222222222222222222222",
      dir: "/downloads",
      status: "selecting",
      progress: 0,
      totalBytes: 30,
      downloadedBytes: 0,
      speed: 0,
      peers: 0,
      addedAt: 1,
      availableFiles: [{ index: 0, name: "a", path: "a.epub", length: 10 }],
    }]);
    expect(q.selectFiles("pick1", [])).toBe(false);
    expect(q.selectFiles("pick1", [99])).toBe(false);
    q.suspend();
  });
});

describe("DownloadQueue debrid path", () => {
  const input = {
    id: "rd1",
    name: "Movie",
    magnet: "magnet:?xt=urn:btih:1111111111111111111111111111111111111111",
  };

  it("completes a Real-Debrid download into history without ever seeding it", async () => {
    const q = new DownloadQueue();
    const deps: DebridDeps = {
      resolveMagnet: async (_provider, _token, _magnet, opts) => {
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

    await q.addDebrid(input, "/downloads", "realdebrid", "tok", deps);

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

    await q.addDebrid(input, "/downloads", "realdebrid", "tok", deps);

    const it = q.getItems().find((i) => i.id === "rd1");
    expect(it?.status).toBe("failed");
    expect(it?.error).toContain("dead torrent");
    expect(it?.via).toBe("debrid");
    expect(it?.provider).toBe("realdebrid");
    q.suspend();
  });

  it("records the provider on the item and in history", async () => {
    const q = new DownloadQueue();
    const deps: DebridDeps = {
      resolveMagnet: (provider, _t, _m) => {
        expect(provider).toBe("torbox");
        return Promise.resolve([{ url: "https://cdn.torbox.app/dl/a.mkv", filename: "a.mkv", bytes: 10 }]);
      },
      downloadFiles: async (_files, dir) => [path.join(dir, "a.mkv")],
    };
    await q.addDebrid(
      { id: "tb1", name: "Kestrel.2010.1080p.BluRay.x264", magnet: "magnet:?xt=urn:btih:2222222222222222222222222222222222222222" },
      "/downloads",
      "torbox",
      "tb-1",
      deps,
    );
    const entry = q.getHistory().find((h) => h.id === "tb1")!;
    expect(entry.via).toBe("debrid");
    expect(entry.provider).toBe("torbox");
    q.suspend();
  });

  it("classifies a transient failure using the ACTIVE provider's rules", async () => {
    // A TorBox rate limit is transient; RD's isTransient would not recognise it,
    // so a shared classifier would fail the item instead of requeuing it.
    let attempts = 0;
    const deps: DebridDeps = {
      resolveMagnet: () => {
        attempts += 1;
        if (attempts === 1) {
          const e = new TorBoxError("TorBox rate limit — wait a moment and retry.", 200, "TOO_MANY_REQUESTS");
          return Promise.reject(e);
        }
        return Promise.resolve([{ url: "https://cdn.torbox.app/dl/a.mkv", filename: "a.mkv", bytes: 10 }]);
      },
      downloadFiles: async (_files, dir) => [path.join(dir, "a.mkv")],
      sleep: async () => {},
    };
    const q = new DownloadQueue();
    await q.addDebrid(
      { id: "tb2", name: "Ashfall.1999.1080p", magnet: "magnet:?xt=urn:btih:3333333333333333333333333333333333333333" },
      "/downloads",
      "torbox",
      "tb-1",
      deps,
    );
    expect(attempts).toBe(2);
    expect(q.getHistory().some((h) => h.id === "tb2")).toBe(true);
    q.suspend();
  });

  it("stamps the item's provider to the currently active one on retry, not the one it was added with", async () => {
    // Add a TorBox item, let it fail, then switch the active debrid auth to
    // Real-Debrid before retrying. The retry re-resolves through Real-Debrid,
    // so the item (and the history it produces) must say so too — not carry
    // the stale "torbox" it was created with.
    const q = new DownloadQueue();
    let sawProvider: string | undefined;
    // A single mutable deps object, reused across the whole test: addDebrid
    // stashes this exact object on the queue as `this.debridDeps`, and retry()
    // re-reads `resolveMagnet` off it at call time — so swapping the function
    // in place (rather than passing a second deps object retry has no way to
    // receive) is how the test drives "the retry actually used realdebrid".
    const deps: DebridDeps = {
      resolveMagnet: async () => {
        throw new TorBoxError("dead torrent"); // no status/code = terminal, fails immediately
      },
      downloadFiles: async (_files, dir) => [path.join(dir, "f.mkv")],
    };
    await q.addDebrid(
      { id: "tb3", name: "Kestrel.2010.1080p.BluRay.x264", magnet: "magnet:?xt=urn:btih:4444444444444444444444444444444444444444" },
      "/downloads",
      "torbox",
      "tb-1",
      deps,
    );
    const failed = q.getItems().find((i) => i.id === "tb3");
    expect(failed?.status).toBe("failed");
    expect(failed?.provider).toBe("torbox");

    // Switch the active debrid provider, as the app does on a provider switch.
    q.setDebridToken("realdebrid", "rd-tok");
    let stampedOnItem: string | undefined;
    deps.resolveMagnet = async (provider) => {
      sawProvider = provider;
      // Capture mid-flight: completeDebrid deletes the item from `items` once
      // the pipeline finishes, so this is the only point it can be read.
      stampedOnItem = q.getItems().find((i) => i.id === "tb3")?.provider;
      return [{ url: "https://dl/f", filename: "f.mkv", bytes: 10 }];
    };
    q.retry("tb3");
    for (let i = 0; i < 50 && !q.getHistory().some((h) => h.id === "tb3"); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(sawProvider).toBe("realdebrid");
    expect(stampedOnItem).toBe("realdebrid");
    const entry = q.getHistory().find((h) => h.id === "tb3")!;
    expect(entry).toBeDefined();
    expect(entry.provider).toBe("realdebrid");
    q.suspend();
  });
});

describe("DownloadQueue Real-Debrid scheduling", () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  // Poll the event loop until `cond` holds, yielding a real macrotask each time
  // so injected async deps and real fs I/O can settle. Waiting on observable
  // state instead of a fixed number of ticks keeps these tests deterministic
  // under load; the generous cap still fails fast on a genuine hang.
  const waitFor = async (
    cond: () => boolean | Promise<boolean>,
    label = "condition",
  ): Promise<void> => {
    for (let i = 0; i < 500; i++) {
      if (await cond()) return;
      await tick();
    }
    throw new Error(`waitFor timed out waiting for ${label}`);
  };
  const fileExists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

  it("runs at most two Real-Debrid downloads at once; the rest wait as queued", async () => {
    const q = new DownloadQueue();
    const gates: Array<() => void> = [];
    let started = 0;
    const deps: DebridDeps = {
      resolveMagnet: async (_p, _t, _m, opts) => {
        started++;
        await new Promise<void>((res) => gates.push(res)); // block until released
        opts?.onProgress?.(100);
        return [{ url: "u", filename: "f.mkv", bytes: 1 }];
      },
      downloadFiles: async () => [],
      sleep: async () => {},
    };
    const inputs = [1, 2, 3, 4].map((n) => ({ id: `rd${n}`, name: `M${n}`, magnet: `m${n}` }));
    const all = Promise.all(inputs.map((i) => q.addDebrid(i, "/downloads", "realdebrid", "tok", deps)));

    await waitFor(() => started === 2, "2 downloads started");
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
      resolveMagnet: async (_p, _t, _m, opts) => {
        calls++;
        if (calls < 3) throw new RealDebridError("busy", 503);
        opts?.onProgress?.(100);
        return [{ url: "u", filename: "f.mkv", bytes: 1 }];
      },
      downloadFiles: async () => [],
      sleep: async () => {},
    };
    await q.addDebrid({ id: "rd1", name: "M", magnet: "m" }, "/downloads", "realdebrid", "tok", deps);
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
    await q.addDebrid({ id: "rd1", name: "M", magnet: "m" }, "/downloads", "realdebrid", "tok", deps);
    expect(calls).toBe(1);
    expect(q.getItems().find((i) => i.id === "rd1")?.status).toBe("failed");
    q.suspend();
  });

  it("frees the concurrency slot when a running item is cancelled, letting a queued one start", async () => {
    const q = new DownloadQueue();
    const gates: Array<() => void> = [];
    const started: string[] = [];
    const deps: DebridDeps = {
      resolveMagnet: async (_p, _t, magnet, opts) => {
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
    const all = Promise.all(inputs.map((i) => q.addDebrid(i, "/downloads", "realdebrid", "tok", deps)));

    await waitFor(() => started.length === 2, "cap of 2 started"); // cap = 2; rd3 waiting
    expect(started).toHaveLength(2);

    q.cancel("rd1"); // cancel a running item → its slot should free
    await waitFor(() => started.length === 3, "rd3 starts after slot frees");
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
          const abortErr = (): Error =>
            Object.assign(new Error("Download aborted."), { name: "AbortError" });
          await new Promise<void>((_res, rej) => {
            if (opts?.signal?.aborted) return rej(abortErr());
            opts?.signal?.addEventListener("abort", () => rej(abortErr()));
          });
        }
        opts?.onProgress?.({ downloaded: 10, total: 10, speed: 0 });
        return ["/downloads/f.mkv"];
      },
      sleep: async () => {},
    };

    const p = q.addDebrid({ id: "rd1", name: "M", magnet: "m" }, "/downloads", "realdebrid", "tok", deps);
    await waitFor(
      () => q.getItems().find((i) => i.id === "rd1")?.phase === "downloading",
      "download in progress",
    );

    q.pause("rd1");
    await p; // driveDebrid returns once the pause abort unwinds
    expect(q.getItems().find((i) => i.id === "rd1")?.status).toBe("paused");

    q.resume("rd1");
    await waitFor(() => !q.has("rd1"), "resumed download completes"); // second run → history
    expect(q.has("rd1")).toBe(false); // second download run completed → history
    expect(downloadCalls).toBe(2);
    q.suspend();
  });

  it("deletes the partial file when a paused Real-Debrid download is cancelled", async () => {
    const q = new DownloadQueue();
    const dir = await tmpDir();
    const deps: DebridDeps = {
      resolveMagnet: async () => [{ url: "u", filename: "f.mkv", bytes: 10 }],
      downloadFiles: async (_files, destDir, opts) => {
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(path.join(destDir, "f.mkv"), "partial");
        const abortErr = (): Error =>
          Object.assign(new Error("Download aborted."), { name: "AbortError" });
        await new Promise<void>((_res, rej) => {
          // The abort may already have fired while the writes above were in
          // flight; adding a listener after the fact would never see it and the
          // pipeline would hang. Reject immediately in that case.
          if (opts?.signal?.aborted) return rej(abortErr());
          opts?.signal?.addEventListener("abort", () => rej(abortErr()));
        });
        return [];
      },
      sleep: async () => {},
    };
    const file = path.join(dir, "f.mkv");
    const p = q.addDebrid({ id: "rd1", name: "M", magnet: "m" }, dir, "realdebrid", "tok", deps);
    await waitFor(() => fileExists(file), "partial file written"); // download reached the abort wait
    q.pause("rd1");
    await p;
    expect(await fs.readFile(file, "utf8")).toBe("partial"); // kept on pause

    q.cancel("rd1");
    await waitFor(async () => !(await fileExists(file)), "partial file deleted"); // async best-effort cleanup
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

describe("DownloadQueue error resilience on boot", () => {
  it("restore() marks item failed if engine.add throws synchronously", () => {
    const q = new DownloadQueue();
    // Spy on internal engine to force synchronous throw when add is called
    const fakeEngine = (q as unknown as { engine: { add: () => void } }).engine;
    fakeEngine.add = () => {
      throw new Error("Disk error during add");
    };

    expect(() =>
      q.restore([
        {
          id: "err1",
          name: "Broken Download",
          source: undefined,
          magnet: "magnet:?xt=urn:btih:1111111111111111111111111111111111111111",
          dir: "/downloads",
          status: "downloading",
          progress: 0,
          totalBytes: 100,
          downloadedBytes: 0,
          speed: 0,
          peers: 0,
          addedAt: Date.now(),
        },
      ])
    ).not.toThrow();

    const errItem = q.getItems().find((i) => i.id === "err1");
    expect(errItem?.status).toBe("failed");
    expect(errItem?.error).toContain("Disk error during add");
    q.suspend();
  });

  it("restoreSeeds() marks seed paused if engine.add throws synchronously", () => {
    const q = new DownloadQueue();
    q.restoreHistory([h({ id: "h-broken" })]);
    const fakeEngine = (q as unknown as { engine: { add: () => void } }).engine;
    fakeEngine.add = () => {
      throw new Error("Chunk store init failed");
    };

    expect(() =>
      q.restoreSeeds([{ id: "h-broken", status: "seeding" }])
    ).not.toThrow();

    expect(q.getSeed("h-broken")?.status).toBe("paused");
    q.suspend();
  });

  it("never hands a debrid item to the webtorrent engine, even a corrupted one that claims to be queued", () => {
    // No debrid item should ever carry status "queued" (addDebrid always
    // starts "downloading"), but a hand-edited or corrupted queue.json could
    // claim otherwise. promote() picks up "queued" items regardless of via,
    // so the guard against ever reaching startEngine's engine.add has to be
    // structural, not incidental on debrid items never actually being queued.
    const q = new DownloadQueue();
    let addCalls = 0;
    const fakeEngine = (q as unknown as { engine: { add: () => void } }).engine;
    fakeEngine.add = () => {
      addCalls++;
    };

    q.restore([
      {
        id: "corrupt1",
        name: "Kestrel.2010.1080p.BluRay.x264",
        magnet: "magnet:?xt=urn:btih:5555555555555555555555555555555555555555",
        dir: "/downloads",
        via: "debrid",
        provider: "torbox",
        status: "queued",
        progress: 0,
        totalBytes: 100,
        downloadedBytes: 0,
        speed: 0,
        peers: 0,
        addedAt: Date.now(),
      },
    ]);

    expect(addCalls).toBe(0);
    q.suspend();
  });
});
