# Real-Debrid Download Scheduler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound Real-Debrid download concurrency (max 2), treat 503/"busy" as transient with backoff + limited auto-requeue, give up gracefully on a torrent RD isn't caching, and make retry-all respect the cap — so a big batch drains steadily instead of storming the RD API.

**Architecture:** A small async `Semaphore` gates RD pipelines. `DownloadQueue.addDebrid` enqueues items as `phase: "queued"` and a new `driveDebrid` wrapper owns the queued state + the retry/backoff loop, acquiring a slot before running `runDebrid` (refactored to a single attempt that *throws*). `resolveMagnet` gains a stall timeout. Transient classification (`isTransient`) and idempotent-call retry bumps live in the RD client.

**Tech Stack:** TypeScript (ESM, Node 22), Ink 7, vitest, tsup. Tests colocate as `src/**/*.test.ts`. `npm test` / `npx vitest run <path>` / `npm run typecheck`.

**Build order:** Semaphore → transient+retry-bump → stall timeout → `"queued"` phase + UI copy → the scheduler refactor (last, so its dependencies exist and are tested).

---

## File Structure

**New**
- `src/util/semaphore.ts` — counting async semaphore (pure).
- `src/util/semaphore.test.ts` — its tests.

**Modified**
- `src/integrations/realdebrid.ts` — `isTransient`; retry bump for idempotent calls; `resolveMagnet` stall timeout.
- `src/integrations/realdebrid.test.ts` — tests for `isTransient`, retry bump, stall.
- `src/download/types.ts` — add `"queued"` to `DownloadPhase`.
- `src/ui/components/Downloads.tsx` — "queued — waiting" copy.
- `src/download/queue.ts` — semaphore, `driveDebrid`, `runDebrid` refactor, `failDebrid`, retry paths, attempts map; `DebridDeps.sleep`.
- `src/download/queue.test.ts` — concurrency cap, auto-requeue, terminal-no-requeue tests.

---

## Task 1: Async semaphore

**Files:**
- Create: `src/util/semaphore.ts`
- Test: `src/util/semaphore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/util/semaphore.test.ts
import { describe, it, expect } from "vitest";
import { Semaphore } from "./semaphore";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("Semaphore", () => {
  it("admits up to the limit immediately", async () => {
    const s = new Semaphore(2);
    await s.acquire();
    await s.acquire();
    expect(s.available).toBe(0);
  });

  it("queues waiters past the limit and resumes them FIFO on release", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const order: string[] = [];
    const a = s.acquire().then(() => order.push("a"));
    const b = s.acquire().then(() => order.push("b"));
    await tick();
    expect(order).toEqual([]); // both still waiting
    s.release();
    await a;
    expect(order).toEqual(["a"]);
    s.release();
    await b;
    expect(order).toEqual(["a", "b"]);
  });

  it("frees a slot on release when nobody is waiting", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    expect(s.available).toBe(0);
    s.release();
    expect(s.available).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/util/semaphore.test.ts`
Expected: FAIL — `Cannot find module './semaphore'`.

- [ ] **Step 3: Implement**

```typescript
// src/util/semaphore.ts
// Minimal counting semaphore. `acquire()` resolves immediately while under the
// limit, otherwise queues until a `release()` hands over a slot (FIFO). Each
// acquire must be balanced by exactly one release.
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  // Slots not currently held (0 when full). Handy for assertions.
  get available(): number {
    return Math.max(0, this.limit - this.active);
  }

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter — active count is unchanged.
      next();
      return;
    }
    if (this.active > 0) this.active--;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/util/semaphore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/semaphore.ts src/util/semaphore.test.ts
git commit -m "feat: add async Semaphore for bounded concurrency"
```

---

## Task 2: Transient classification + retry bump for idempotent RD calls

**Files:**
- Modify: `src/integrations/realdebrid.ts`
- Test: `src/integrations/realdebrid.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/integrations/realdebrid.test.ts` (add `isTransient` and `RealDebridError` to the existing `./realdebrid` import, or import them here):

```typescript
import { isTransient, RealDebridError, getInfo } from "./realdebrid";

describe("isTransient", () => {
  it("flags Real-Debrid 5xx/429 responses as transient", () => {
    for (const s of [429, 500, 502, 503, 504]) {
      expect(isTransient(new RealDebridError("busy", s))).toBe(true);
    }
  });

  it("treats token / not-found / status-less / non-RD errors as terminal", () => {
    expect(isTransient(new RealDebridError("bad token", 401))).toBe(false);
    expect(isTransient(new RealDebridError("gone", 404))).toBe(false);
    expect(isTransient(new RealDebridError("No seeders"))).toBe(false); // no status = dead torrent / stall
    expect(isTransient(new Error("boom"))).toBe(false);
    expect(isTransient("nope")).toBe(false);
  });
});

describe("idempotent RD calls retry past two failures", () => {
  it("getInfo retries a 503 more than twice before succeeding", async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls++;
      if (calls <= 3) return new Response("", { status: 503 });
      return new Response(JSON.stringify({ status: "downloaded", links: [] }), { status: 200 });
    };
    const info = await getInfo("tok", "id1", { fetchImpl, sleepImpl: async () => {} });
    expect(info.status).toBe("downloaded");
    expect(calls).toBe(4); // 3 × 503 then success — impossible with the old retries:2
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: FAIL — `isTransient` not exported; and `getInfo` retry test fails at the old 2-retry limit.

- [ ] **Step 3: Add `isTransient`**

In `src/integrations/realdebrid.ts`, add after the `RealDebridError` class:

```typescript
// Real-Debrid HTTP statuses worth retrying (rate limit / transient server load).
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

// A transient Real-Debrid failure worth requeuing, vs a terminal one (bad token,
// dead/removed torrent, not found, stall). Only RD's own 5xx/429 responses count:
// network-level blips are already retried inside `request()` via fetchResilient,
// and status-less RealDebridErrors (dead torrent, stall) are deliberately terminal.
export function isTransient(e: unknown): boolean {
  return e instanceof RealDebridError && e.status !== undefined && TRANSIENT_STATUS.has(e.status);
}
```

- [ ] **Step 4: Bump retries on idempotent calls**

In `src/integrations/realdebrid.ts`, change these four functions to default their retry budget to 4 while still honoring an explicit override. `addMagnet` is NOT changed (stays `retries: 0`).

`selectFiles` — change its `request(...)` call:
```typescript
  await request(token, "POST", `/torrents/selectFiles/${id}`, { files }, { ...opts, retries: opts.retries ?? 4 });
```
`listTorrents`:
```typescript
  const res = await request(token, "GET", `/torrents?limit=${limit}&page=${page}`, undefined, { ...opts, retries: opts.retries ?? 4 });
```
`getInfo`:
```typescript
  const res = await request(token, "GET", `/torrents/info/${id}`, undefined, { ...opts, retries: opts.retries ?? 4 });
```
`unrestrictLink`:
```typescript
  const res = await request(token, "POST", "/unrestrict/link", { link }, { ...opts, retries: opts.retries ?? 4 });
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/realdebrid.ts src/integrations/realdebrid.test.ts
git commit -m "feat: classify transient RD errors and retry idempotent calls harder"
```

---

## Task 3: Stall timeout in `resolveMagnet`

**Files:**
- Modify: `src/integrations/realdebrid.ts`
- Test: `src/integrations/realdebrid.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/integrations/realdebrid.test.ts` (add `resolveMagnet` to the imports if not present):

```typescript
import { resolveMagnet } from "./realdebrid";

// Minimal RD API stub. `infoSeq` supplies successive /torrents/info payloads.
function rdFetch(infoSeq: Array<Record<string, unknown>>): (url: string) => Promise<Response> {
  let i = 0;
  return async (url: string) => {
    if (url.includes("/torrents/addMagnet")) return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    if (url.includes("/torrents/selectFiles")) return new Response("", { status: 204 });
    if (url.includes("/torrents/info")) {
      const body = infoSeq[Math.min(i, infoSeq.length - 1)];
      i++;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.includes("/unrestrict/link")) {
      return new Response(JSON.stringify({ download: "https://dl/f", filename: "f.mkv", filesize: 1 }), { status: 200 });
    }
    return new Response("", { status: 200 });
  };
}

describe("resolveMagnet stall timeout", () => {
  const magnet = "magnet:?xt=urn:btih:1111111111111111111111111111111111111111";

  it("throws when Real-Debrid reports no caching progress within the window", async () => {
    const fetchImpl = rdFetch([{ status: "downloading", progress: 0 }]);
    await expect(
      resolveMagnet("tok", magnet, { fetchImpl, sleepImpl: async () => {}, pollIntervalMs: 1000, stallMs: 3000 }),
    ).rejects.toThrow(/isn't caching/i);
  });

  it("keeps polling while progress increases, then resolves", async () => {
    const fetchImpl = rdFetch([
      { status: "downloading", progress: 20 },
      { status: "downloading", progress: 55 },
      { status: "downloaded", progress: 100, links: ["https://rd/link"] },
    ]);
    const files = await resolveMagnet("tok", magnet, {
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1000,
      stallMs: 3000,
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.url).toBe("https://dl/f");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: FAIL — `resolveMagnet` accepts no `stallMs` and never throws a stall error (the first test hangs/loops or errors differently). (`ResolveOptions` has no `stallMs` yet.)

- [ ] **Step 3: Add `stallMs` and stall tracking**

In `src/integrations/realdebrid.ts`:

Add the default constant near the other poll constants (e.g. below `const DEFAULT_POLL_MS = 2000;`):
```typescript
// Give up on a resolve if Real-Debrid reports no caching progress for this long
// (it usually means the torrent has no seeders / was removed). Only inactivity
// counts — a torrent that keeps making progress is never timed out.
const DEFAULT_STALL_MS = 180_000;
```

Add `stallMs` to the `ResolveOptions` interface:
```typescript
export interface ResolveOptions extends RequestOptions {
  onProgress?: (percent: number) => void;
  pollIntervalMs?: number;
  // Fail if RD-side caching makes no progress for this many ms (default 3 min).
  stallMs?: number;
  knownHash?: string;
}
```

In `resolveMagnet`, add `stallMs` to the destructure:
```typescript
  const {
    onProgress,
    pollIntervalMs = DEFAULT_POLL_MS,
    sleepImpl = realSleep,
    signal,
    knownHash,
    stallMs = DEFAULT_STALL_MS,
  } = opts;
```

Replace the polling loop. The current loop is:
```typescript
  let links: string[] = [];
  for (;;) {
    throwIfAborted(signal);
    const info = await getInfo(token, id, opts);
    onProgress?.(info.progress ?? 0);
    if (info.status === DONE_STATUS) {
      links = info.links ?? [];
      break;
    }
    if (ERROR_STATUSES.has(info.status)) {
      throw new RealDebridError(messageForTorrentStatus(info.status));
    }
    if (info.status === "waiting_files_selection" && !selected) {
      await selectFiles(token, id, opts);
      selected = true;
    }
    await sleepImpl(pollIntervalMs);
  }
```
Replace with (adds stall tracking):
```typescript
  let links: string[] = [];
  let lastProgress = -1;
  let stalledMs = 0;
  for (;;) {
    throwIfAborted(signal);
    const info = await getInfo(token, id, opts);
    const progress = info.progress ?? 0;
    onProgress?.(progress);
    if (info.status === DONE_STATUS) {
      links = info.links ?? [];
      break;
    }
    if (ERROR_STATUSES.has(info.status)) {
      throw new RealDebridError(messageForTorrentStatus(info.status));
    }
    if (info.status === "waiting_files_selection" && !selected) {
      await selectFiles(token, id, opts);
      selected = true;
    }
    if (progress > lastProgress) {
      lastProgress = progress;
      stalledMs = 0;
    } else {
      stalledMs += pollIntervalMs;
      if (stalledMs >= stallMs) {
        throw new RealDebridError(
          "Real-Debrid isn't caching this torrent — it may have no seeders (removed or dead).",
        );
      }
    }
    await sleepImpl(pollIntervalMs);
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/realdebrid.ts src/integrations/realdebrid.test.ts
git commit -m "feat: fail Real-Debrid resolve gracefully when caching stalls"
```

---

## Task 4: `"queued"` phase + downloads UI copy

**Files:**
- Modify: `src/download/types.ts`
- Modify: `src/ui/components/Downloads.tsx`

- [ ] **Step 1: Add the phase value**

In `src/download/types.ts`, change:
```typescript
// Real-Debrid downloads have two phases: "resolving" while RD caches the
// torrent on its cloud, then "downloading" while we pull the direct links.
export type DownloadPhase = "resolving" | "downloading";
```
to:
```typescript
// Real-Debrid downloads move through: "queued" (waiting for a concurrency slot),
// "resolving" (RD caches the torrent on its cloud), then "downloading" (we pull
// the direct links).
export type DownloadPhase = "queued" | "resolving" | "downloading";
```

- [ ] **Step 2: Show a "queued — waiting" line**

In `src/ui/components/Downloads.tsx`, the `rightStats` function starts with:
```typescript
  if (it.status === "downloading") {
    // Real-Debrid first caches the torrent on its cloud (resolving), then we
    // pull it over HTTP — no swarm, so no peer count.
    if (it.via === "realdebrid" && it.phase === "resolving") {
      return `preparing on Real-Debrid… ${it.progress}%`;
    }
```
Insert a `queued` case immediately before the `resolving` case:
```typescript
  if (it.status === "downloading") {
    // Real-Debrid first caches the torrent on its cloud (resolving), then we
    // pull it over HTTP — no swarm, so no peer count.
    if (it.via === "realdebrid" && it.phase === "queued") {
      return "queued — waiting for Real-Debrid";
    }
    if (it.via === "realdebrid" && it.phase === "resolving") {
      return `preparing on Real-Debrid… ${it.progress}%`;
    }
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/download/types.ts src/ui/components/Downloads.tsx
git commit -m "feat: add queued phase and 'queued — waiting' downloads copy"
```

---

## Task 5: Concurrency scheduler in `DownloadQueue`

**Files:**
- Modify: `src/download/queue.ts`
- Test: `src/download/queue.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/download/queue.test.ts` (add `RealDebridError` to the imports: `import { RealDebridError } from "../integrations/realdebrid";`). Add a new describe block:

```typescript
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
    expect(started).toBe(2); // only two acquired a slot
    expect(q.getItems().filter((it) => it.phase === "queued")).toHaveLength(2);

    // Release running pipelines one at a time; each release lets a queued one start.
    for (let released = 0; released < 4; released++) {
      while (gates.length === 0) await tick();
      gates.shift()!();
      await tick();
    }
    await all;
    expect(started).toBe(4);
    expect(q.getItems()).toHaveLength(0); // all completed → history
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
      sleep: async () => {}, // skip the real backoff wait
    };
    await q.addDebrid({ id: "rd1", name: "M", magnet: "m" }, "/downloads", "tok", deps);
    expect(calls).toBe(3); // two transient failures, success on the third
    expect(q.has("rd1")).toBe(false); // completed → history
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/download/queue.test.ts`
Expected: FAIL — no concurrency cap (all 4 start → `started` is 4 not 2), no auto-requeue (transient throws once and fails), `DebridDeps` has no `sleep`.

- [ ] **Step 3: Add imports, constants, and fields**

In `src/download/queue.ts`, add imports near the top:
```typescript
import { resolveMagnet, isTransient } from "../integrations/realdebrid";
import { Semaphore } from "../util/semaphore";
import { backoffDelay } from "../util/net";
```
(The existing `import { resolveMagnet } from "../integrations/realdebrid";` line becomes the combined import above — do not duplicate it.)

Add constants near the other module constants (e.g. below `const HISTORY_MAX = 500;`):
```typescript
const MAX_ACTIVE_DEBRID = 2;
const MAX_DEBRID_ATTEMPTS = 3;
const DEBRID_BACKOFF_BASE_MS = 5_000;
const DEBRID_BACKOFF_CAP_MS = 60_000;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
```

Extend `DebridDeps` with an injectable sleep (so the backoff is instant in tests):
```typescript
export interface DebridDeps {
  resolveMagnet: typeof resolveMagnet;
  downloadFiles: typeof downloadFiles;
  // Sleep between transient-failure requeues; defaults to real time.
  sleep?: (ms: number) => Promise<void>;
}
```

Add fields to the `DownloadQueue` class (near `debridAborts`):
```typescript
  private debridSem = new Semaphore(MAX_ACTIVE_DEBRID);
  private debridAttempts = new Map<string, number>();
```

- [ ] **Step 4: Rewrite `addDebrid` to enqueue + drive**

Replace the tail of `addDebrid` (currently sets the item with `phase: "resolving"`, stores it, and `return this.runDebrid(item.id, token, deps);`) so the item starts `queued` and goes through the scheduler. The full method body after the seed-cleanup / existing-item guard becomes:

```typescript
    const item: QueueItem = {
      id: input.id,
      name: input.name,
      source: input.source,
      magnet: input.magnet,
      dir,
      via: "realdebrid",
      phase: "queued",
      status: "downloading",
      progress: 0,
      totalBytes: input.sizeBytes ?? 0,
      downloadedBytes: 0,
      speed: 0,
      peers: 0,
      addedAt: existing?.addedAt ?? Date.now(),
    };
    this.items.set(item.id, item);
    this.debridAttempts.set(item.id, 0);
    this.changed();
    void this.persist();
    return this.driveDebrid(item.id, token, deps);
```

- [ ] **Step 5: Add `driveDebrid` and `failDebrid`; refactor `runDebrid` to throw**

Add the scheduler wrapper and the failure helper, and rewrite `runDebrid` so it makes ONE attempt and throws on failure (its old `catch` that set `status "failed"` is removed — `driveDebrid` now decides). Replace the entire existing `runDebrid` method with these three methods:

```typescript
  // Schedule one Real-Debrid item: wait for a concurrency slot, run a single
  // pipeline attempt, and on a transient failure requeue with backoff until the
  // attempt budget is spent. Settles when the item reaches a terminal state.
  private async driveDebrid(id: string, token: string, deps: DebridDeps): Promise<void> {
    const sleep = deps.sleep ?? realSleep;
    for (;;) {
      const waiting = this.items.get(id);
      if (!waiting || waiting.status !== "downloading") return; // cancelled/removed while queued
      waiting.phase = "queued";
      waiting.speed = 0;
      this.changed();

      await this.debridSem.acquire();
      let retry = false;
      try {
        const it = this.items.get(id);
        if (!it || it.status !== "downloading") return; // cancelled while waiting for the slot
        await this.runDebrid(id, token, deps); // completes on success, throws on failure
        return;
      } catch (e) {
        const attempts = (this.debridAttempts.get(id) ?? 0) + 1;
        this.debridAttempts.set(id, attempts);
        const stillHere = this.items.get(id)?.status === "downloading";
        if (isTransient(e) && attempts < MAX_DEBRID_ATTEMPTS && stillHere) {
          retry = true;
        } else {
          this.failDebrid(id, e);
          return;
        }
      } finally {
        this.debridSem.release();
      }
      if (!retry) return;
      await sleep(backoffDelay(this.debridAttempts.get(id) ?? 1, DEBRID_BACKOFF_BASE_MS, DEBRID_BACKOFF_CAP_MS));
    }
  }

  // One Real-Debrid attempt: resolve the magnet to direct links, then pull them
  // over HTTP. Completes the item on success; throws on any failure (the caller
  // decides whether to requeue or fail).
  private async runDebrid(id: string, token: string, deps: DebridDeps): Promise<void> {
    const ctrl = new AbortController();
    this.debridAborts.set(id, ctrl);
    try {
      const start = this.items.get(id);
      if (start) {
        start.phase = "resolving";
        this.changed();
      }
      const files = await deps.resolveMagnet(token, this.items.get(id)?.magnet ?? "", {
        signal: ctrl.signal,
        knownHash: id, // queue item id is the torrent infoHash
        onProgress: (percent) => {
          const it = this.items.get(id);
          if (!it || it.status !== "downloading") return;
          it.phase = "resolving";
          // Reserve 100% for the actual file transfer; RD-side caching tops out at 99.
          it.progress = Math.min(99, Math.max(0, Math.round(percent)));
          this.changed();
        },
      });

      const it = this.items.get(id);
      if (!it || it.status !== "downloading") return; // cancelled mid-resolve
      it.phase = "downloading";
      it.progress = 0;
      it.directUrl = pickStreamFile(files)?.url;
      it.totalBytes = files.reduce((sum, f) => sum + (f.bytes || 0), 0) || it.totalBytes;
      this.changed();

      const dest = files.length > 1 ? path.join(it.dir, sanitizeFilename(it.name)) : it.dir;
      await deps.downloadFiles(files, dest, {
        signal: ctrl.signal,
        onProgress: (p) => {
          const cur = this.items.get(id);
          if (!cur || cur.status !== "downloading") return;
          if (p.total) cur.totalBytes = p.total;
          cur.downloadedBytes = p.downloaded;
          cur.speed = p.speed;
          cur.progress = p.total > 0 ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : cur.progress;
          this.changed();
        },
      });

      const done = this.items.get(id);
      if (done) this.completeDebrid(done);
    } finally {
      this.debridAborts.delete(id);
    }
  }

  // Mark a Real-Debrid item failed after its attempt budget is spent (or a
  // terminal error). A missing item means it was cancelled — nothing to do.
  private failDebrid(id: string, e: unknown): void {
    this.debridAttempts.delete(id);
    const it = this.items.get(id);
    if (!it) {
      this.maybeStopPoll();
      return;
    }
    it.status = "failed";
    it.error = e instanceof Error ? e.message : String(e);
    it.speed = 0;
    it.peers = 0;
    it.phase = undefined;
    this.changed();
    void this.persist();
    this.maybeStopPoll();
  }
```

- [ ] **Step 6: Clear attempts on completion and cancellation**

In `completeDebrid`, add attempt cleanup. The method starts:
```typescript
  private completeDebrid(it: QueueItem): void {
    if (it.totalBytes) it.downloadedBytes = it.totalBytes;
```
Add as the first line of the body:
```typescript
  private completeDebrid(it: QueueItem): void {
    this.debridAttempts.delete(it.id);
    if (it.totalBytes) it.downloadedBytes = it.totalBytes;
```

In `cancel`, add attempt cleanup alongside the existing abort. The method currently:
```typescript
  cancel(id: string): void {
    if (!this.items.has(id)) return;
    this.debridAborts.get(id)?.abort();
    this.engine.remove(id);
    this.items.delete(id);
```
Add the attempts delete:
```typescript
  cancel(id: string): void {
    if (!this.items.has(id)) return;
    this.debridAborts.get(id)?.abort();
    this.debridAttempts.delete(id);
    this.engine.remove(id);
    this.items.delete(id);
```

- [ ] **Step 7: Route RD retry through the scheduler**

In `retry`, the Real-Debrid branch currently sets `phase "resolving"` and calls `runDebrid`. Change it to enqueue via `driveDebrid`. The branch is:
```typescript
    if (it.via === "realdebrid") {
      if (!this.debridToken) {
        it.status = "failed";
        it.error = "Set a Real-Debrid token, then download again.";
        this.changed();
        return;
      }
      it.phase = "resolving";
      it.progress = 0;
      it.speed = 0;
      this.changed();
      void this.persist();
      void this.runDebrid(id, this.debridToken, this.debridDeps);
      return;
    }
```
Replace with:
```typescript
    if (it.via === "realdebrid") {
      if (!this.debridToken) {
        it.status = "failed";
        it.error = "Set a Real-Debrid token, then download again.";
        this.changed();
        return;
      }
      it.phase = "queued";
      it.progress = 0;
      it.speed = 0;
      this.debridAttempts.set(id, 0);
      this.changed();
      void this.persist();
      void this.driveDebrid(id, this.debridToken, this.debridDeps);
      return;
    }
```
(`retryFailed` loops over failed items calling `retry`, so it now enqueues them all through the semaphore — the cap handles the rest. No change needed there.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/download/queue.test.ts`
Expected: PASS (new scheduling tests + the pre-existing RD path tests — "completes…" and "marks the item failed when resolution errors", which still fail terminally because a plain `Error` is not transient).

- [ ] **Step 9: Full verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/cli.cjs` emitted.

- [ ] **Step 10: Commit**

```bash
git add src/download/queue.ts src/download/queue.test.ts
git commit -m "feat: cap Real-Debrid concurrency with queued state, backoff requeue, and capped retry"
```

---

## Final verification

- [ ] **Run everything**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

- [ ] **Manual end-to-end smoke** (`npm run dev`)
  - Queue a batch of ~6+ Real-Debrid downloads: at most 2 show "preparing on Real-Debrid…"; the rest show "queued — waiting for Real-Debrid"; they drain 2 at a time.
  - Press `f` (retry) with several failed RD items: they re-queue and again run only 2 at a time (no "busy" storm).
  - A torrent RD can't cache eventually fails with "isn't caching this torrent — it may have no seeders" rather than hanging on "preparing" forever.

---

## Notes

- `isTransient` is intentionally narrow (RD 5xx/429 only). Network blips are handled by `fetchResilient`'s call-level retries; status-less `RealDebridError`s (dead torrent, stall) are terminal by design, which also keeps the existing plain-`Error` "marks failed" test terminal.
- The backoff sleep is injected via `DebridDeps.sleep` so requeue tests run instantly; production uses real time.
- No change to the poll loop / P2P / seeding paths — Real-Debrid progress is pushed through `changed()` as before.
