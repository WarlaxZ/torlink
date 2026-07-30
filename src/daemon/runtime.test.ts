import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { addInput, policySummary, startRuntime, type Runtime } from "./runtime";
import { StreamSessionRegistry } from "../core/streamSession";
import { TorrentEngine } from "../download/engine";
import { saveConfig } from "../config/config";
import { saveQueue, saveSeeds } from "../download/persist";
import type { QueueItem } from "../download/types";
import { saveHistory } from "../download/history";
import { disarmBootMarker } from "../download/bootguard";
import { configFile, historyFile, queueFile, seedsFile } from "../config/paths";

const HASH = "abcdef0123456789abcdef0123456789abcdef01";
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Example`;

// A stand-in for DownloadQueue that records adds without spinning up webtorrent.
function fakeRuntime(dir: string, has = false): { runtime: Runtime; add: ReturnType<typeof vi.fn> } {
  const add = vi.fn();
  const runtime = {
    queue: { has: () => has, add } as unknown as Runtime["queue"],
    downloadDir: dir,
    sessions: new StreamSessionRegistry(),
  };
  return { runtime, add };
}

describe("addInput", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-rt-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("adds a magnet keyed by its info hash", async () => {
    const { runtime, add } = fakeRuntime(dir);
    expect(await addInput(runtime, MAGNET)).toBe("added");
    expect(add).toHaveBeenCalledWith(
      { id: HASH, name: "Example", magnet: MAGNET },
      dir,
    );
  });

  it("adds a bare info hash", async () => {
    const { runtime, add } = fakeRuntime(dir);
    expect(await addInput(runtime, HASH)).toBe("added");
    expect(add).toHaveBeenCalledOnce();
  });

  it("reports a duplicate without adding", async () => {
    const { runtime, add } = fakeRuntime(dir, true);
    expect(await addInput(runtime, MAGNET)).toBe("duplicate");
    expect(add).not.toHaveBeenCalled();
  });

  it("reports invalid input without adding or throwing", async () => {
    const { runtime, add } = fakeRuntime(dir);
    expect(await addInput(runtime, "not a magnet")).toBe("invalid");
    expect(add).not.toHaveBeenCalled();
  });

  it("rejects a .torrent file path unless the caller opts in", async () => {
    const { runtime, add } = fakeRuntime(dir);
    const file = path.join(dir, "example.torrent");
    expect(await addInput(runtime, file)).toBe("invalid");
    expect(add).not.toHaveBeenCalled();
    // Opted in (the watch folder), a bad file still fails soft as invalid.
    expect(await addInput(runtime, file, { allowTorrentPath: true })).toBe("invalid");
  });

  it("names the queue item from `name` rather than the magnet", async () => {
    // MUTATION GUARD (the add path losing the name). A browser adding a search
    // hit has only its info hash — search results deliberately carry no magnet
    // — and a hash-only magnet has no `dn`, so parseInput names the item after
    // the hash. Drop `options.name` and this row is called
    // "abcdef0123456789abcdef0123456789abcdef01".
    const { runtime, add } = fakeRuntime(dir);
    expect(await addInput(runtime, HASH, { name: "Kestrel 2010" })).toBe("added");
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: HASH, name: "Kestrel 2010" }), dir);
    expect(add.mock.calls[0]![0].name).not.toBe(HASH);
  });

  it("falls back to the magnet's name when the override is blank", async () => {
    const { runtime, add } = fakeRuntime(dir);
    await addInput(runtime, MAGNET, { name: "   " });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: "Example" }), dir);
  });

  it("passes a known size through so the row has a total", async () => {
    const { runtime, add } = fakeRuntime(dir);
    await addInput(runtime, HASH, { name: "Kestrel", sizeBytes: 4096 });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: 4096 }), dir);
  });

  it("routes through Real-Debrid when a token is supplied, like the TUI", async () => {
    const add = vi.fn();
    const addDebrid = vi.fn(() => new Promise<void>(() => {}));
    const runtime = {
      queue: { has: () => false, add, addDebrid } as unknown as Runtime["queue"],
      downloadDir: dir,
      sessions: new StreamSessionRegistry(),
    };
    expect(await addInput(runtime, HASH, { name: "Kestrel", debridToken: "rd-tok" })).toBe("added");
    // Not awaited: addDebrid's promise resolves when the whole download does,
    // which is minutes away. The queue row exists synchronously, which is what
    // "added" claims.
    expect(addDebrid).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Kestrel" }),
      dir,
      "realdebrid",
      "rd-tok",
    );
    expect(add).not.toHaveBeenCalled();
  });
});

describe("startRuntime — stream sessions", () => {
  it("exposes an empty session registry", async () => {
    const runtime = await startRuntime();
    expect(runtime.sessions.list()).toEqual([]);
    runtime.queue.suspend();
  });
});

// A resumed Real-Debrid item re-runs the pipeline; hang resolveMagnet so the
// test never touches the network and the item stays where resume() put it.
vi.mock("../integrations/debrid/realdebrid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integrations/debrid/realdebrid")>()),
  resolveMagnet: vi.fn(() => new Promise(() => {})),
}));

// The headless runtime must apply the same queue configuration App.tsx applies
// at boot. Each of these covers a symptom of it not doing so.
describe("startRuntime — applied config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-cfg-"));
    // startRuntime arms the crash-boot marker and only disarms it 4 s later, so
    // without this the second startRuntime in this file boots in safe mode.
    disarmBootMarker();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    disarmBootMarker();
    // Shared per-worker state dir: don't leak this file's config/queue/seeds.
    for (const f of [configFile, queueFile, historyFile, seedsFile]) {
      await fs.rm(f, { force: true }).catch(() => {});
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("applies the configured transfer limits to the engine", async () => {
    const setLimits = vi.spyOn(TorrentEngine.prototype, "setLimits");
    await saveConfig({ downloadDir: dir, trackers: [], downloadLimitKbps: 500, uploadLimitKbps: 100 });
    const runtime = await startRuntime();
    expect(setLimits).toHaveBeenCalledWith(500, 100);
    runtime.queue.suspend();
  });

  it("applies the seed policy, so a seed past its ratio auto-stops", async () => {
    await saveConfig({ downloadDir: dir, trackers: [], seedRatio: 1 });
    await saveHistory([
      { id: HASH, name: "Example", sizeBytes: 1000, magnet: MAGNET, dir, completedAt: Date.now() },
    ]);
    await saveSeeds([{ id: HASH, status: "seeding" }]);
    vi.spyOn(TorrentEngine.prototype, "add").mockImplementation(() => {});
    vi.spyOn(TorrentEngine.prototype, "remove").mockImplementation(() => {});
    vi.spyOn(TorrentEngine.prototype, "stats").mockReturnValue({
      progress: 1, downloaded: 1000, total: 1000, speed: 0,
      uploadSpeed: 10, uploaded: 2000, peers: 1, timeRemaining: 0, name: "Example",
    });
    vi.useFakeTimers();
    const runtime = await startRuntime();
    expect(runtime.queue.getSeeds()[0]?.status).toBe("seeding");
    await vi.advanceTimersByTimeAsync(600);
    expect(runtime.queue.getSeeds()[0]?.status).toBe("paused");
    runtime.queue.suspend();
  });

  it("applies the resolved Real-Debrid token, so a restored paused RD item resumes", async () => {
    await saveConfig({ downloadDir: dir, trackers: [], realDebridToken: "cfg-token" });
    await saveQueue([
      // Legacy on-disk shape (pre-provider): via is the bare string "realdebrid".
      {
        id: HASH, name: "Example", magnet: MAGNET, dir, via: "realdebrid",
        status: "paused", progress: 40, totalBytes: 1000, downloadedBytes: 400,
        speed: 0, peers: 0, addedAt: Date.now(),
      } as unknown as QueueItem,
    ]);
    const runtime = await startRuntime();
    expect(runtime.queue.getItems()[0]?.status).toBe("paused");
    runtime.queue.resume(HASH);
    const item = runtime.queue.getItems()[0];
    expect(item?.status).not.toBe("failed");
    expect(item?.status).toBe("downloading");
    expect(item?.error).toBeUndefined();
    runtime.queue.suspend();
  });

  it("prefers the REALDEBRID_API_TOKEN env var over the config file", async () => {
    vi.stubEnv("REALDEBRID_API_TOKEN", "env-token");
    await saveConfig({ downloadDir: dir, trackers: [] });
    await saveQueue([
      // Legacy on-disk shape (pre-provider): via is the bare string "realdebrid".
      {
        id: HASH, name: "Example", magnet: MAGNET, dir, via: "realdebrid",
        status: "paused", progress: 0, totalBytes: 1000, downloadedBytes: 0,
        speed: 0, peers: 0, addedAt: Date.now(),
      } as unknown as QueueItem,
    ]);
    const runtime = await startRuntime();
    runtime.queue.resume(HASH);
    expect(runtime.queue.getItems()[0]?.status).toBe("downloading");
    runtime.queue.suspend();
  });
});

describe("policySummary", () => {
  // Neutralise a real token in the developer's own environment. resolveActiveDebrid
  // now reads TorBox's env var too, so a dev with a real TorBox token locally
  // would otherwise flip these to "on" while CI stays green.
  beforeEach(() => {
    vi.stubEnv("REALDEBRID_API_TOKEN", "");
    vi.stubEnv("TORBOX_API_TOKEN", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("names the limits it applied so a capped daemon says so at startup", () => {
    expect(
      policySummary({ downloadDir: "/d", trackers: [], downloadLimitKbps: 500, seedRatio: 2 }),
    ).toBe("policy: down 500 KB/s · up unlimited · seed ratio 2 · seed time off · real-debrid off");
  });

  it("reports an unconfigured daemon as unlimited", () => {
    expect(policySummary({ downloadDir: "/d", trackers: [] })).toBe(
      "policy: down unlimited · up unlimited · seed ratio off · seed time off · real-debrid off",
    );
  });
});
