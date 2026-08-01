import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { handleApi, isAuthorized, extractMagnet, parseControl, applyControl, statusPayload } from "./serve";
import type { Runtime } from "./runtime";
import { StreamSessionRegistry } from "../core/streamSession";
import { DownloadQueue, type DebridDeps } from "../download/queue";
import { rowsFromStatus } from "../web/static/dashboard";

const HASH = "abcdef0123456789abcdef0123456789abcdef01";
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Example`;

describe("isAuthorized", () => {
  it("is open when no token is configured", () => {
    expect(isAuthorized(null, undefined)).toBe(true);
  });
  it("accepts a matching bearer token or raw token", () => {
    expect(isAuthorized("s3cret", "Bearer s3cret")).toBe(true);
    expect(isAuthorized("s3cret", "s3cret")).toBe(true);
  });
  it("rejects a missing or wrong token", () => {
    expect(isAuthorized("s3cret", undefined)).toBe(false);
    expect(isAuthorized("s3cret", "Bearer nope")).toBe(false);
  });
});

describe("extractMagnet", () => {
  it("reads a magnet from JSON", () => {
    expect(extractMagnet(`{"magnet":"${MAGNET}"}`)).toBe(MAGNET);
  });
  it("reads an infohash field", () => {
    expect(extractMagnet(`{"infohash":"${HASH}"}`)).toBe(HASH);
  });
  it("accepts a raw magnet body", () => {
    expect(extractMagnet(MAGNET)).toBe(MAGNET);
  });
  it("returns null for empty or unusable bodies", () => {
    expect(extractMagnet("")).toBeNull();
    expect(extractMagnet("{bad json")).toBeNull();
    expect(extractMagnet(`{"other":1}`)).toBeNull();
  });
});

describe("handleApi", () => {
  let dir: string;
  let add: ReturnType<typeof vi.fn>;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-serve-"));
    add = vi.fn();
    runtime = {
      queue: {
        has: () => false,
        add,
        getItems: () => [],
        getSeeds: () => [],
      } as unknown as Runtime["queue"],
      downloadDir: dir,
      sessions: new StreamSessionRegistry(),
    };
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("serves /health without auth", async () => {
    const res = await handleApi(runtime, "tok", "GET", "/health", undefined, "");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("401s a protected route without a token", async () => {
    const res = await handleApi(runtime, "tok", "POST", "/add", undefined, `{"magnet":"${MAGNET}"}`);
    expect(res.status).toBe(401);
    expect(add).not.toHaveBeenCalled();
  });

  it("adds a magnet on POST /add", async () => {
    const res = await handleApi(runtime, "tok", "POST", "/add", "Bearer tok", `{"magnet":"${MAGNET}"}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: "added" });
    expect(add).toHaveBeenCalledWith({ id: HASH, name: "Example", magnet: MAGNET }, dir);
  });

  it("400s an invalid magnet", async () => {
    const res = await handleApi(runtime, null, "POST", "/add", undefined, `{"magnet":"nope"}`);
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it("400s a .torrent file path (no filesystem reach over HTTP)", async () => {
    const res = await handleApi(runtime, null, "POST", "/add", undefined, "C:/secrets/x.torrent");
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it("lists downloads on GET /downloads", async () => {
    const res = await handleApi(runtime, null, "GET", "/downloads", undefined, "");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ downloads: [], seeds: [] });
  });

  // `progress: 50` is an integer percent, not a 0..1 fraction — the unit
  // QueueItem.progress actually uses. See the real-queue test at the bottom of
  // this file: fixtures like this one used to say 0.5 on both sides of the seam,
  // which is how the browser came to render every download at 100%.
  it("maps download and seed fields, including a seed's uploadSpeed", async () => {
    runtime.queue = {
      has: () => false,
      add,
      getItems: () => [
        { id: "d1", name: "D", status: "downloading", progress: 50, peers: 3, speed: 512, x: 1 },
      ],
      getSeeds: () => [
        { id: "s1", name: "S", status: "seeding", peers: 2, uploaded: 2048, uploadSpeed: 128, x: 1 },
      ],
    } as unknown as Runtime["queue"];
    const res = await handleApi(runtime, null, "GET", "/status", undefined, "");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      downloads: [{ id: "d1", name: "D", status: "downloading", progress: 50, peers: 3, speed: 512 }],
      seeds: [{ id: "s1", name: "S", status: "seeding", peers: 2, uploaded: 2048, uploadSpeed: 128 }],
    });
  });

  it("404s an unknown route", async () => {
    const res = await handleApi(runtime, null, "GET", "/nope", undefined, "");
    expect(res.status).toBe(404);
  });

  it("400s POST /control with a malformed body", async () => {
    const res = await handleApi(runtime, null, "POST", "/control", undefined, `{"id":"x"}`);
    expect(res.status).toBe(400);
  });

  it("400s POST /control with an unknown action", async () => {
    const res = await handleApi(runtime, null, "POST", "/control", undefined, `{"id":"${HASH}","action":"boom"}`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("unknown action");
  });

  it("404s POST /control for an unknown torrent", async () => {
    const res = await handleApi(runtime, null, "POST", "/control", undefined, `{"id":"${HASH}","action":"pause"}`);
    expect(res.status).toBe(404);
  });

  it("pauses a known download on POST /control", async () => {
    const pause = vi.fn();
    runtime.queue = { has: (id: string) => id === HASH, pause } as unknown as Runtime["queue"];
    const res = await handleApi(runtime, null, "POST", "/control", undefined, `{"id":"${HASH}","action":"pause"}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "pause" });
    expect(pause).toHaveBeenCalledWith(HASH);
  });

  /**
   * `retry` exposes `queue.retry`, which the TUI has reached since it shipped
   * (the `f` key on the queue pane) and no HTTP caller could. Without it a
   * failed download offers a browser `pause` and `resume` — one meaningless,
   * the other a no-op, since `resume` only un-pauses and a failed item is not
   * paused — so the queue's dead rows had no recovery at all.
   */
  it("retries a known download on POST /control", async () => {
    const retry = vi.fn();
    runtime.queue = { has: (id: string) => id === HASH, retry } as unknown as Runtime["queue"];
    const res = await handleApi(runtime, null, "POST", "/control", undefined, `{"id":"${HASH}","action":"retry"}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "retry" });
    expect(retry).toHaveBeenCalledWith(HASH);
  });

  it("404s a retry for an unknown torrent rather than silently doing nothing", async () => {
    runtime.queue = { has: () => false, retry: vi.fn() } as unknown as Runtime["queue"];
    const res = await handleApi(runtime, null, "POST", "/control", undefined, `{"id":"${HASH}","action":"retry"}`);
    expect(res.status).toBe(404);
  });
});

describe("parseControl", () => {
  it("reads id + action from JSON", () => {
    expect(parseControl(`{"id":"abc","action":"pause"}`)).toEqual({ id: "abc", action: "pause", deleteFiles: false });
  });
  it("reads the deleteFiles flag", () => {
    expect(parseControl(`{"id":"abc","action":"delete","deleteFiles":true}`)).toEqual({
      id: "abc",
      action: "delete",
      deleteFiles: true,
    });
  });
  it("returns null when id or action is missing/blank or the body isn't JSON", () => {
    expect(parseControl(`{"id":"abc"}`)).toBeNull();
    expect(parseControl(`{"action":"pause"}`)).toBeNull();
    expect(parseControl(`{"id":"  ","action":"pause"}`)).toBeNull();
    expect(parseControl(`pause abc`)).toBeNull();
    expect(parseControl("")).toBeNull();
  });
});

describe("applyControl", () => {
  const mkRuntime = (queue: Partial<Record<string, unknown>>): Runtime =>
    ({ queue: queue as unknown as Runtime["queue"], downloadDir: "/tmp", sessions: new StreamSessionRegistry() });

  it("resumes a paused download", async () => {
    const resume = vi.fn();
    const rt = mkRuntime({ has: (id: string) => id === "x", resume });
    expect(await applyControl(rt, { id: "x", action: "resume", deleteFiles: false })).toBe("ok");
    expect(resume).toHaveBeenCalledWith("x");
  });

  it("stops seeding but keeps files", async () => {
    const stopSeeding = vi.fn();
    const rt = mkRuntime({ getSeed: (id: string) => (id === "s" ? { id } : undefined), stopSeeding });
    expect(await applyControl(rt, { id: "s", action: "stop-seed", deleteFiles: false })).toBe("ok");
    expect(stopSeeding).toHaveBeenCalledWith("s");
  });

  it("starts seeding from a history entry", async () => {
    const startSeeding = vi.fn();
    const hist = { id: "h", name: "H", magnet: "m", dir: "/d", sizeBytes: 1, completedAt: 0 };
    const rt = mkRuntime({ getHistory: () => [hist], startSeeding });
    expect(await applyControl(rt, { id: "h", action: "start-seed", deleteFiles: false })).toBe("ok");
    expect(startSeeding).toHaveBeenCalledWith(hist);
  });

  it("delete forces deleteFiles:true; remove keeps files", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const rt = mkRuntime({ remove });
    expect(await applyControl(rt, { id: "z", action: "delete", deleteFiles: false })).toBe("ok");
    expect(remove).toHaveBeenCalledWith("z", { deleteFiles: true });
    remove.mockClear();
    await applyControl(rt, { id: "z", action: "remove", deleteFiles: false });
    expect(remove).toHaveBeenCalledWith("z", { deleteFiles: false });
  });

  it("reports not-found when remove finds nothing and unknown-action otherwise", async () => {
    const rt = mkRuntime({ remove: vi.fn().mockResolvedValue(false) });
    expect(await applyControl(rt, { id: "z", action: "remove", deleteFiles: false })).toBe("not-found");
    expect(await applyControl(mkRuntime({}), { id: "z", action: "nope", deleteFiles: false })).toBe("unknown-action");
  });
});

// The seam, driven end to end. Everything else that touches this payload —
// here and in web/static/dashboard.test.ts — uses a hand-written fixture, and
// for a while the fixtures on both sides agreed with each other (`progress` as a
// 0..1 fraction) and disagreed with reality (an integer 0–100), so every
// in-progress download rendered as "100%" in the browser and no test noticed.
//
// A real DownloadQueue is the only witness that can't be wrong about the unit.
// Reaching into web/static from a daemon test is deliberate: the producer and
// the browser's consumer are the two things being compared.
describe("statusPayload over a real DownloadQueue", () => {
  // Getting a real queue to a *known* progress value without a network: the
  // Real-Debrid path takes injectable deps, so `resolveMagnet` reports 42% and
  // then blocks forever. That runs the production code that writes
  // QueueItem.progress (queue.ts's onProgress: `Math.min(99, ...Math.round)`)
  // and leaves the item sitting at 42, status "downloading".
  //
  // The P2P path has no such seam — its progress comes from a live webtorrent
  // engine — so a genuinely swarming torrent is not reachable in a unit test.
  // Both paths write the same field in the same unit (queue.ts:397/423 for RD,
  // :611 for P2P: `Math.round(s.progress * 100)`), so this pins the convention
  // for both.
  it("renders the browser row at the same percent the TUI prints", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-realqueue-"));
    const queue = new DownloadQueue();
    try {
      const blocked = new Promise<never>(() => {});
      const deps: DebridDeps = {
        resolveMagnet: async (_provider, _token, _magnet, opts) => {
          opts?.onProgress?.(42);
          return blocked; // hold the item in-progress
        },
        downloadFiles: async () => [],
      };
      void queue.addDebrid({ id: HASH, name: "Example", magnet: MAGNET }, dir, "realdebrid", "tok", deps);

      const item = (): { progress: number; status: string } | undefined =>
        queue.getItems().find((i) => i.id === HASH);
      for (let i = 0; i < 500 && item()?.progress !== 42; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const live = item();
      expect(live).toMatchObject({ status: "downloading", progress: 42 });

      const payload = statusPayload({
        queue,
        downloadDir: dir,
        sessions: new StreamSessionRegistry(),
      });
      const rows = rowsFromStatus(payload);

      // What the TUI prints for this item is `${it.progress}%` (see
      // ui/components/Downloads.tsx), i.e. "42%". The browser row must say the
      // same, because it is the same torrent seen twice.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.percent).toBe(42);
      expect(rows[0]!.percent).toBe(live!.progress);
      expect(`${rows[0]!.percent}%`).toBe(`${live!.progress}%`);
    } finally {
      await queue.remove(HASH, { deleteFiles: false }).catch(() => {});
      queue.suspend();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
