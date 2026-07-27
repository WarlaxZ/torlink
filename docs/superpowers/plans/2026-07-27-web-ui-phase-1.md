# Web UI Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract torlink's search, stream-session and poster orchestration out of the React layer into a headless `src/core/`, and mount a web server over it that serves a live queue dashboard and full-quality posters.

**Architecture:** Three new `src/core/` modules own logic currently trapped in `src/ui/hooks/`. `src/daemon/runtime.ts` widens to hold a stream-session registry alongside the queue. A new `src/web/` layer is transport only: a pure router (`handleWebApi`) delegating shared routes to the existing `handleApi`, plus SSE and static assets. `startWebServer(runtime, opts)` is mounted by both `torlnk serve --web` and `torlnk --web`. The existing TUI test suite passing unchanged is the proof the extraction is invisible.

**Tech Stack:** TypeScript (ESM, node22), vitest, tsup, node:http, Ink/React (existing TUI only). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-27-web-ui-design.md`

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/core/posterCache.ts` | Fetch-once disk cache of poster originals; LRU prune. Composes with `util/poster.ts` to render TUI rows from cache. |
| `src/core/posterCache.test.ts` | Cache hit/miss/failure/prune. |
| `src/core/search.ts` | `runSearch` fan-out: per-source timeout, health bench, dedupe, order, progressive snapshots. |
| `src/core/search.test.ts` | Fan-out behaviour with injected search/health/clock. |
| `src/core/streamRoute.ts` | Moved from `src/ui/streamRoute.ts` (core must not import from `ui/`). |
| `src/core/streamRoute.test.ts` | Moved from `src/ui/streamRoute.test.ts`. |
| `src/core/streamSession.ts` | `StreamSessionRegistry`: one session type over the RD and WebTorrent backends. |
| `src/core/streamSession.test.ts` | Start/ready/error/stop lifecycle with injected backends. |
| `src/web/routes.ts` | Pure router `handleWebApi` → `{status, headers, json?, text?, filePath?}`. |
| `src/web/routes.test.ts` | Auth, aliases, poster host allowlist, 404s. |
| `src/web/sse.ts` | SSE frame formatting + queue subscription. |
| `src/web/sse.test.ts` | Frame format, heartbeat, unsubscribe. |
| `src/web/staticDir.ts` | Resolve the built asset directory; content-type map. |
| `src/web/staticDir.test.ts` | Candidate resolution, content types, traversal rejection. |
| `src/web/server.ts` | `startWebServer(runtime, opts)`: node:http wiring, injected logger. |
| `src/web/server.test.ts` | Live-socket smoke test on port 0. |
| `src/web/static/dashboard.ts` | Pure view-state reducers for the dashboard (unit-tested). |
| `src/web/static/dashboard.test.ts` | Row mapping, stable ordering, formatting. |
| `src/web/static/app.ts` | Thin DOM binding: token entry, fetch, SSE, render. Bundled to `dist/web/app.js`. |
| `src/web/static/index.html` | Dashboard shell. |
| `src/web/static/styles.css` | Styles. |

**Modified:**

| File | Change |
|---|---|
| `src/config/paths.ts` | Add `postersDir`. |
| `src/util/poster.ts` | Add `renderPosterFile` (render from a path). No behaviour change to existing exports. |
| `src/ui/hooks/useTitlePreview.ts` | Use `cachedPosterRows` instead of `fetchPosterRows`. |
| `src/ui/hooks/useConcurrentSearch.ts` | Becomes a thin throttled subscriber over `runSearch`; re-exports `mergeDuplicateResults`/`shouldBench` so existing tests and imports keep working. |
| `src/ui/App.tsx` | Import `classifyStreamRoute` from `../core/streamRoute`; mount `startWebServer` when `--web`. |
| `src/daemon/runtime.ts` | `Runtime` gains `sessions: StreamSessionRegistry`. |
| `src/daemon/serve.ts` | `ServeOptions` gains `web?: boolean`; mount `startWebServer`. |
| `src/cli/args.ts` | `serve` gains `web`; `run` gains `web`/`webPort`/`webToken`; help text. |
| `src/index.tsx` | Pass web options through to `runServe` and the TUI. |
| `tsup.config.ts` | Second build: `src/web/static/app.ts` → `dist/web/app.js`, browser platform. |
| `scripts/postbuild.cjs` | Copy `index.html` and `styles.css` into `dist/web/`. |
| `README.md` | Document `--web`, token, LAN and reverse-proxy usage. |

**Deleted:** `src/ui/streamRoute.ts`, `src/ui/streamRoute.test.ts` (moved to `src/core/`).

---

## Task 1: Poster cache directory

**Files:**
- Modify: `src/config/paths.ts`

- [ ] **Step 1: Add a cache directory and the posters directory**

Poster originals are a *cache*, not user state: they must not live under `dataDir`,
where backup and sync tools would sweep them up. Add a `cacheDir` beside the
existing `dataDir`/`configDir`, honouring the same `TORLINK_STATE_DIR` override:

```ts
const cacheDir = override ? path.join(override, "cache") : base.cache;
```

Then add after the `torrentsDir` export in `src/config/paths.ts`:

```ts
// Cached poster originals, keyed by a hash of the source URL. The browser is
// served these bytes as-is (full quality); the TUI half-blocks the same file
// rather than re-fetching it. Safe to delete at any time — it is a cache.
export const postersDir = path.join(cacheDir, "posters");
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config/paths.ts
git commit -m "feat: add posters cache directory path"
```

---

## Task 2: Poster cache — write the failing test

**Files:**
- Create: `src/core/posterCache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/posterCache.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/posterCache.test.ts`
Expected: FAIL — `Failed to resolve import "./posterCache"`.

- [ ] **Step 3: Commit the test**

```bash
git add src/core/posterCache.test.ts
git commit -m "test: poster cache hit/miss/prune expectations"
```

---

## Task 3: Poster cache — implementation

**Files:**
- Create: `src/core/posterCache.ts`
- Test: `src/core/posterCache.test.ts`

- [ ] **Step 1: Write the implementation**

Create `src/core/posterCache.ts`:

```ts
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { postersDir } from "../config/paths";
import { renderPosterFile } from "../util/poster";
import type { FetchImpl } from "../util/net";
import { log } from "../util/logger";

// Cap the cache rather than letting it grow forever. Posters are ~50-200KB, so
// this holds a few thousand — far more than a session browses.
export const MAX_POSTER_CACHE_BYTES = 200 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 8000;

export interface PosterCacheOptions {
  dir?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface CachedPoster {
  path: string;
  bytes: number;
}

// Hash the URL rather than sanitising it: poster URLs contain slashes, query
// strings and arbitrary characters, and a hash is both collision-safe enough
// and incapable of escaping the cache directory.
export function posterFileName(url: string): string {
  return `${createHash("sha1").update(url).digest("hex")}.jpg`;
}

// Delete least-recently-used files until the directory fits `maxBytes`. Never
// throws — this is opportunistic housekeeping, not a correctness requirement.
export async function prunePosters(dir: string, maxBytes: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const entries: { file: string; size: number; mtimeMs: number }[] = [];
  let total = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) continue;
      entries.push({ file, size: st.size, mtimeMs: st.mtimeMs });
      total += st.size;
    } catch {
      /* vanished under us — nothing to account for */
    }
  }
  if (total <= maxBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const e of entries) {
    if (total <= maxBytes) break;
    try {
      await fs.rm(e.file, { force: true });
      total -= e.size;
    } catch {
      /* leave it; the next prune will try again */
    }
  }
}

/**
 * The cached original bytes for a poster URL, fetching once on a miss. Returns
 * null on any failure (non-http URL, network error, non-2xx) so callers fall
 * back to their placeholder rather than handling errors.
 *
 * A hit updates the file's mtime so `prunePosters` treats the cache as LRU
 * rather than first-in-first-out.
 */
export async function getPoster(
  url: string,
  opts: PosterCacheOptions = {},
): Promise<CachedPoster | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const dir = opts.dir ?? postersDir;
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  const file = path.join(dir, posterFileName(url));

  try {
    const st = await fs.stat(file);
    if (st.isFile() && st.size > 0) {
      const now = Date.now() / 1000;
      await fs.utimes(file, now, now).catch(() => {});
      return { path: file, bytes: st.size };
    }
  } catch {
    /* miss — fetch below */
  }

  let buf: Buffer;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    log.debug(`poster cache: fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (buf.length === 0) return null;

  try {
    await fs.mkdir(dir, { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
  } catch (err) {
    log.debug(`poster cache: write failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  void prunePosters(dir, opts.maxBytes ?? MAX_POSTER_CACHE_BYTES);
  return { path: file, bytes: buf.length };
}

/**
 * Terminal half-block rows for a poster, via the cache. Same signature shape as
 * `fetchPosterRows` so the TUI hook swaps one call for the other, but the bytes
 * are fetched at most once per URL across the whole app.
 */
export async function cachedPosterRows(
  url: string,
  cols: number,
  maxRows: number,
  opts: PosterCacheOptions = {},
): Promise<string[] | null> {
  const hit = await getPoster(url, opts);
  if (!hit) return null;
  return renderPosterFile(hit.path, cols, maxRows);
}
```

- [ ] **Step 2: Add `renderPosterFile` to the poster renderer**

Append to `src/util/poster.ts`:

```ts
// Render an already-downloaded poster from disk. Split from fetchPosterRows so
// the cache layer owns the network and this module stays pure pixel work.
// Returns null if the file is unreadable or not a decodable JPEG.
export async function renderPosterFile(
  file: string,
  cols: number,
  maxRows: number,
): Promise<string[] | null> {
  try {
    const buf = await readFile(file);
    return renderJpegPoster(buf, cols, maxRows);
  } catch (err) {
    log.debug(`poster render failed for ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
```

Add the import at the top of `src/util/poster.ts`, after the `jpeg` import:

```ts
import { readFile } from "node:fs/promises";
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run src/core/posterCache.test.ts src/util/poster.test.ts`
Expected: PASS — all tests in both files.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/posterCache.ts src/util/poster.ts
git commit -m "feat: cache poster originals on disk, shared by TUI and web"
```

---

## Task 4: Point the TUI preview hook at the cache

**Files:**
- Modify: `src/ui/hooks/useTitlePreview.ts`

- [ ] **Step 1: Swap the poster call**

In `src/ui/hooks/useTitlePreview.ts`, replace the import:

```ts
import { fetchPosterRows } from "../../util/poster";
```

with:

```ts
import { cachedPosterRows } from "../../core/posterCache";
```

Then in the poster effect, replace:

```ts
    void fetchPosterRows(posterUrl, posterCols, posterMaxRows, { fetchImpl }).then((rows) => {
```

with:

```ts
    void cachedPosterRows(posterUrl, posterCols, posterMaxRows, { fetchImpl }).then((rows) => {
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — every test, unchanged. This is the check that the swap is invisible to the TUI.

- [ ] **Step 3: Commit**

```bash
git add src/ui/hooks/useTitlePreview.ts
git commit -m "refactor: fetch TUI posters through the shared disk cache"
```

---

## Task 5: `runSearch` — write the failing test

**Files:**
- Create: `src/core/search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/search.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runSearch, type SearchSnapshot } from "./search";
import { AuthRequiredError } from "../sources/rutracker";
import type { Health } from "../sources/sourceHealth";
import type { Source, SourceId, TorrentResult } from "../sources/types";

function source(id: SourceId): Source {
  return {
    id,
    label: id,
    homepage: "https://example.invalid",
    reportsHealth: true,
    search: async () => [],
  };
}

function result(infoHash: string, sourceId: SourceId, seeders: number): TorrentResult {
  return {
    infoHash,
    name: `Release ${infoHash}`,
    sizeBytes: 100,
    seeders,
    leechers: 0,
    source: sourceId,
    magnet: `magnet:?xt=urn:btih:${infoHash}`,
  };
}

describe("runSearch", () => {
  it("merges duplicates across sources and orders by seeders", async () => {
    const a = source("tpb-movies");
    const b = source("x1337-movies");
    const snap = await runSearch("query", [a, b], {
      health: new Map(),
      searchImpl: async (s) =>
        s.id === "tpb-movies"
          ? [result("aaa", "tpb-movies", 3), result("bbb", "tpb-movies", 50)]
          : [result("aaa", "x1337-movies", 9)],
    });

    expect(snap.results.map((r) => r.infoHash)).toEqual(["bbb", "aaa"]);
    const dupe = snap.results.find((r) => r.infoHash === "aaa")!;
    expect(dupe.seeders).toBe(9);
    expect(dupe.sources).toEqual(["tpb-movies", "x1337-movies"]);
    expect(snap.done).toBe(2);
    expect(snap.total).toBe(2);
  });

  it("records per-source counts and errors without failing the search", async () => {
    const ok = source("yts");
    const bad = source("eztv");
    const snap = await runSearch("query", [ok, bad], {
      health: new Map(),
      searchImpl: async (s) => {
        if (s.id === "eztv") throw new Error("boom");
        return [result("aaa", "yts", 1)];
      },
    });

    expect(snap.perSource.yts).toEqual({ loading: false, error: null, code: null, count: 1 });
    expect(snap.perSource.eztv).toEqual({
      loading: false,
      error: "boom",
      code: "no response",
      count: 0,
    });
    expect(snap.results).toHaveLength(1);
  });

  it("skips benched sources and does not search them", async () => {
    const benched = source("nyaa");
    const fine = source("yts");
    const health = new Map<SourceId, Health>([["nyaa", { fails: 3, skipUntil: 5000 }]]);
    const searchImpl = vi.fn(async () => [result("aaa", "yts", 1)]);

    const snap = await runSearch("query", [benched, fine], {
      health,
      now: () => 1000,
      searchImpl,
    });

    expect(searchImpl).toHaveBeenCalledTimes(1);
    expect(snap.total).toBe(1);
    expect(snap.perSource.nyaa).toBeUndefined();
  });

  it("benches a source after repeated failures", async () => {
    const health = new Map<SourceId, Health>();
    const failing = source("eztv");
    for (let i = 0; i < 3; i++) {
      await runSearch("q", [failing], {
        health,
        now: () => 1000,
        searchImpl: async () => {
          throw new Error("boom");
        },
      });
    }
    expect(health.get("eztv")?.fails).toBe(3);
    expect(health.get("eztv")?.skipUntil).toBeGreaterThan(1000);
  });

  // Without this, deleting the `if (shouldBench(e))` guard in runSearch leaves
  // every other test passing — the benching test above only proves the true
  // branch. An auth error means "log in", not "this tracker is down".
  it("does not bench a source that only needs authentication", async () => {
    const health = new Map<SourceId, Health>();
    await runSearch("q", [source("rt-movies")], {
      health,
      now: () => 1000,
      searchImpl: async () => {
        throw new AuthRequiredError();
      },
    });
    expect(health.has("rt-movies")).toBe(false);
  });

  it("clears health on success", async () => {
    const health = new Map<SourceId, Health>([["yts", { fails: 2, skipUntil: 0 }]]);
    await runSearch("q", [source("yts")], {
      health,
      searchImpl: async () => [],
    });
    expect(health.has("yts")).toBe(false);
  });

  it("reports a hung source as timed out", async () => {
    vi.useFakeTimers();
    try {
      const health = new Map<SourceId, Health>();
      // Deliberately does NOT override timeoutMs: this must prove the real
      // PER_SOURCE_TIMEOUT_MS default applies, not some test-only value.
      const promise = runSearch("q", [source("eztv")], {
        health,
        now: () => 1000,
        searchImpl: (_s, _q, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      });
      await vi.advanceTimersByTimeAsync(25_001);
      const snap = await promise;
      expect(snap.perSource.eztv).toMatchObject({ error: "timed out", code: "timed out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a snapshot per settled source with a rising done count", async () => {
    const seen: SearchSnapshot[] = [];
    await runSearch("q", [source("yts"), source("eztv")], {
      health: new Map(),
      searchImpl: async (s) => [result(s.id, s.id, 1)],
      onUpdate: (snap) => seen.push(snap),
    });
    expect(seen.map((s) => s.done)).toEqual([1, 2]);
    expect(seen[0]!.results).toHaveLength(1);
    expect(seen[1]!.results).toHaveLength(2);
  });

  it("leaves state alone when the caller aborts", async () => {
    const ctrl = new AbortController();
    const onUpdate = vi.fn();
    const promise = runSearch("q", [source("eztv")], {
      health: new Map(),
      signal: ctrl.signal,
      onUpdate,
      searchImpl: (_s, _q, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    ctrl.abort();
    const snap = await promise;
    expect(onUpdate).not.toHaveBeenCalled();
    expect(snap.done).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/search.test.ts`
Expected: FAIL — `Failed to resolve import "./search"`.

- [ ] **Step 3: Commit the test**

```bash
git add src/core/search.test.ts
git commit -m "test: headless search fan-out expectations"
```

---

## Task 6: `runSearch` — implementation

**Files:**
- Create: `src/core/search.ts`
- Test: `src/core/search.test.ts`

- [ ] **Step 1: Write the implementation**

Create `src/core/search.ts`. The pure helpers are moved verbatim from `src/ui/hooks/useConcurrentSearch.ts` — same behaviour, same names, no React:

```ts
import { cachedSearch } from "../sources/cache";
import {
  isSkipped,
  recordFailure,
  recordSuccess,
  sourceHealth,
  type Health,
} from "../sources/sourceHealth";
import { AuthRequiredError } from "../sources/rutracker";
import { HttpError } from "../util/net";
import type { SearchOptions, Source, SourceId, TorrentResult } from "../sources/types";

export interface SourceState {
  loading: boolean;
  error: string | null;
  code: string | null;
  count: number;
}

// A source gets this long before it's abandoned. Generous: some trackers are
// slow rather than down, and benching handles the genuinely dead ones.
export const PER_SOURCE_TIMEOUT_MS = 25000;

export function errorCode(e: unknown, timedOut: boolean): string {
  if (timedOut) return "timed out";
  if (e instanceof HttpError && e.status > 0) return `HTTP ${e.status}`;
  return "no response";
}

// An auth requirement (e.g. RuTracker not logged in) is not a source
// outage — it must not bench the source, or a later successful login would
// be hidden behind the failure cooldown. Timeouts and real errors still count.
export function shouldBench(e: unknown): boolean {
  return !(e instanceof AuthRequiredError);
}

export function blankPerSource(
  sources: readonly Source[],
  loading: boolean,
): Record<SourceId, SourceState> {
  const out = {} as Record<SourceId, SourceState>;
  for (const s of sources) out[s.id] = { loading, error: null, code: null, count: 0 };
  return out;
}

export function mergeDuplicateResults(list: TorrentResult[]): TorrentResult[] {
  const byHash = new Map<string, TorrentResult>();
  for (const r of list) {
    const existing = byHash.get(r.infoHash);
    if (!existing) {
      byHash.set(r.infoHash, { ...r, sources: [r.source] });
      continue;
    }
    const sources = [...new Set([...(existing.sources ?? [existing.source]), r.source])];
    if (r.seeders > existing.seeders) byHash.set(r.infoHash, { ...r, sources });
    else existing.sources = sources;
  }
  return [...byHash.values()];
}

// torlink's default ordering: healthiest first. The results view can re-sort
// on demand (the `s` key), and its "none"/default state preserves this order.
export function defaultOrder(list: TorrentResult[]): TorrentResult[] {
  return list.sort((a, b) => {
    if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    return (b.added ?? 0) - (a.added ?? 0);
  });
}

export interface SearchSnapshot {
  results: TorrentResult[];
  perSource: Record<SourceId, SourceState>;
  done: number;
  total: number;
}

export type SearchImpl = (
  source: Source,
  query: string,
  opts: SearchOptions,
) => Promise<TorrentResult[]>;

export interface RunSearchOptions {
  signal?: AbortSignal;
  // Called with a full merged+ordered snapshot each time a source settles.
  // Deliberately unthrottled: coalescing is a rendering concern, and the TUI
  // and the browser want different windows.
  onUpdate?: (snapshot: SearchSnapshot) => void;
  searchImpl?: SearchImpl;
  health?: Map<SourceId, Health>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Search every enabled source concurrently and return the merged result.
 *
 * Sources currently benched for repeated failures are skipped outright, so one
 * dead tracker can't stall a search on its timeout. Each source gets its own
 * timeout and its own error slot: a failure is recorded against that source and
 * never rejects the whole search.
 *
 * When the caller's signal aborts, in-flight sources are cancelled and no
 * further snapshots are emitted — the caller is no longer interested, and
 * recording failures for work we cancelled ourselves would wrongly bench
 * healthy sources.
 */
export async function runSearch(
  query: string,
  sources: readonly Source[],
  opts: RunSearchOptions = {},
): Promise<SearchSnapshot> {
  const {
    signal,
    onUpdate,
    searchImpl = cachedSearch,
    health = sourceHealth,
    now = Date.now,
    timeoutMs = PER_SOURCE_TIMEOUT_MS,
  } = opts;

  const active = sources.filter((s) => !isSkipped(health, s.id, now()));
  const perSource = blankPerSource(active, true);
  const collected: TorrentResult[] = [];
  let done = 0;

  const snapshot = (): SearchSnapshot => ({
    results: defaultOrder(mergeDuplicateResults(collected.slice())),
    perSource: { ...perSource },
    done,
    total: active.length,
  });

  await Promise.all(
    active.map(async (source) => {
      const sc = new AbortController();
      const onAbort = (): void => sc.abort();
      signal?.addEventListener("abort", onAbort);
      const abortTimer = setTimeout(() => sc.abort(), timeoutMs);
      try {
        const res = await searchImpl(source, query, { signal: sc.signal });
        if (signal?.aborted) return;
        collected.push(...res);
        perSource[source.id] = { loading: false, error: null, code: null, count: res.length };
        recordSuccess(health, source.id);
      } catch (e) {
        if (signal?.aborted) return;
        const timedOut = sc.signal.aborted;
        perSource[source.id] = {
          loading: false,
          error: timedOut ? "timed out" : e instanceof Error ? e.message : String(e),
          code: errorCode(e, timedOut),
          count: 0,
        };
        // A genuine failure (timeout or error) counts toward benching it.
        if (shouldBench(e)) recordFailure(health, source.id, now());
      } finally {
        clearTimeout(abortTimer);
        signal?.removeEventListener("abort", onAbort);
        if (!signal?.aborted) {
          done += 1;
          onUpdate?.(snapshot());
        }
      }
    }),
  );

  return snapshot();
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/core/search.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 3: Commit**

```bash
git add src/core/search.ts
git commit -m "feat: headless runSearch shared by TUI and web"
```

---

## Task 7: Rewire `useConcurrentSearch` onto `runSearch`

**Files:**
- Modify: `src/ui/hooks/useConcurrentSearch.ts`
- Test: `src/ui/hooks/useConcurrentSearch.test.ts` (unchanged — it must keep passing)

- [ ] **Step 1: Replace the hook file contents**

Replace all of `src/ui/hooks/useConcurrentSearch.ts` with:

```ts
import { useEffect, useMemo, useState } from "react";
import { enabledSources } from "../../sources/registry";
import { blankPerSource, runSearch, type SearchSnapshot, type SourceState } from "../../core/search";
import type { Source, SourceId } from "../../sources/types";
import type { TorrentResult } from "../../sources/types";

// Re-exported so existing importers (and their tests) keep their entry points
// while the logic itself lives in core/search.ts.
export { mergeDuplicateResults, shouldBench } from "../../core/search";
export type { SourceState } from "../../core/search";

export interface ConcurrentSearchState {
  results: TorrentResult[];
  perSource: Record<SourceId, SourceState>;
  loading: boolean;
  done: number;
  total: number;
}

function idleState(sources: readonly Source[]): ConcurrentSearchState {
  return {
    results: [],
    perSource: blankPerSource(sources, false),
    loading: false,
    done: 0,
    total: sources.length,
  };
}

// Coalesce interval for streaming result updates. Sources finish in bursts (a
// cache hit or a couple of fast hosts land almost together), and each update
// re-sorts and re-renders the whole list. Flushing at most once per this window
// keeps a burst from flooding Ink with re-renders and blocking stdin — the same
// leading-throttle the queue hooks in store.ts use for `update` events.
const RESULT_FLUSH_MS = 150;

function toState(snap: SearchSnapshot): ConcurrentSearchState {
  return {
    results: snap.results,
    perSource: snap.perSource,
    loading: snap.done < snap.total,
    done: snap.done,
    total: snap.total,
  };
}

export function useConcurrentSearch(
  query: string,
  disabled: readonly SourceId[] = [],
  adultEnabled = false,
): ConcurrentSearchState {
  // A stable key so the search only re-runs when the *set* of enabled sources
  // changes, not on every render that hands in a fresh array.
  const disabledKey = `${disabled.join(",")}|${adultEnabled ? "1" : "0"}`;
  const sources = useMemo(() => enabledSources(disabled, adultEnabled), [disabledKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<ConcurrentSearchState>(() => idleState(sources));

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: SearchSnapshot | null = null;

    const flush = (): void => {
      if (!alive || !pending) return;
      setState(toState(pending));
      pending = null;
    };

    // Push the accumulated snapshot to the UI, but no more than once per
    // window. The final source flushes immediately so "done" / loading:false
    // is prompt.
    const onUpdate = (snap: SearchSnapshot): void => {
      if (!alive) return;
      pending = snap;
      if (snap.done >= snap.total) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, RESULT_FLUSH_MS);
    };

    setState({
      results: [],
      perSource: blankPerSource(sources, true),
      loading: sources.length > 0,
      done: 0,
      total: sources.length,
    });

    void runSearch(query, sources, { signal: ctrl.signal, onUpdate }).then((snap) => {
      if (!alive) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      setState(toState(snap));
    });

    return () => {
      alive = false;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [query, sources]);

  return state;
}
```

Note: the initial `setState` uses `sources.length` rather than the post-bench
count, and `runSearch`'s first snapshot corrects it as soon as a source settles.
That matches what the user sees today closely enough that no view changes.

- [ ] **Step 2: Run the hook's own tests**

Run: `npx vitest run src/ui/hooks/useConcurrentSearch.test.ts`
Expected: PASS — the re-exported `mergeDuplicateResults` and `shouldBench` satisfy it unchanged.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS. `Results.test.tsx` and `Results.ratePrompt.test.tsx` mock this module by path, so they must be unaffected.

- [ ] **Step 4: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/hooks/useConcurrentSearch.ts
git commit -m "refactor: useConcurrentSearch becomes a subscriber over core runSearch"
```

---

## Task 8: Move `streamRoute` into core

**Files:**
- Create: `src/core/streamRoute.ts`, `src/core/streamRoute.test.ts`
- Delete: `src/ui/streamRoute.ts`, `src/ui/streamRoute.test.ts`
- Modify: `src/ui/App.tsx`

Reason: `src/core/streamSession.ts` needs `classifyStreamRoute`, and core must never import from `ui/`.

- [ ] **Step 1: Move both files with git**

```bash
git mv src/ui/streamRoute.ts src/core/streamRoute.ts
git mv src/ui/streamRoute.test.ts src/core/streamRoute.test.ts
```

- [ ] **Step 2: Confirm the imports inside the moved files still resolve**

`src/core/streamRoute.ts` imports:

```ts
import { type Config, resolveRealDebridToken } from "../config/config";
import type { RdStatus } from "../integrations/rdStatus";
```

Both were `../`-relative from `src/ui/` and stay correct from `src/core/`, which is
a sibling directory at the same depth. The test imports `./streamRoute`, also
unchanged. So this step is a read-only confirmation: open both files and check no
import path begins with `../ui/`. If one does, it is a dependency core must not
have — stop and report it rather than adding the import.

- [ ] **Step 3: Update the App import**

In `src/ui/App.tsx`, change:

```ts
import { classifyStreamRoute } from "./streamRoute";
```

to:

```ts
import { classifyStreamRoute } from "../core/streamRoute";
```

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npx vitest run src/core/streamRoute.test.ts`
Expected: no type errors; all `streamRoute` tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A src/core/streamRoute.ts src/core/streamRoute.test.ts src/ui/streamRoute.ts src/ui/streamRoute.test.ts src/ui/App.tsx
git commit -m "refactor: move streamRoute into core so headless callers can use it"
```

---

## Task 9: Stream session registry — write the failing test

**Files:**
- Create: `src/core/streamSession.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/streamSession.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { StreamSessionRegistry } from "./streamSession";
import type { TorrentStreamSession } from "../integrations/torrentStream";
import type { StreamFile } from "../util/player";

const FILES: StreamFile[] = [
  { url: "http://localhost:1234/webtorrent/abc/big.mkv", filename: "big.mkv", bytes: 900 },
  { url: "http://localhost:1234/webtorrent/abc/small.mkv", filename: "small.mkv", bytes: 100 },
];

function fakeTorrentSession(stop = vi.fn(async () => {})): TorrentStreamSession {
  return {
    name: "Some Release",
    files: FILES,
    dir: "/tmp/x",
    isComplete: () => false,
    stop,
  };
}

const INPUT = { infoHash: "abc", magnet: "magnet:?xt=urn:btih:abc", name: "Some Release" };

describe("StreamSessionRegistry — torrent route", () => {
  it("starts a ready session with the torrent's files", async () => {
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => fakeTorrentSession(),
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
      now: () => 5000,
    });

    const session = await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });

    expect(session).toMatchObject({
      id: "sess1",
      capability: "cap1",
      route: "torrent",
      state: "ready",
      name: "Some Release",
      createdAt: 5000,
    });
    expect(session.files).toEqual(FILES);
    expect(registry.get("sess1")).toBe(session);
    expect(registry.list()).toHaveLength(1);
  });

  it("marks the session failed when the torrent never resolves", async () => {
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => {
        throw new Error("No peers found — couldn't start the stream (metadata timed out).");
      },
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
    });

    const session = await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });

    expect(session.state).toBe("error");
    expect(session.error).toBe("No peers found — couldn't start the stream (metadata timed out).");
    expect(session.files).toEqual([]);
  });

  it("stops the underlying session and forgets it", async () => {
    const stop = vi.fn(async () => {});
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => fakeTorrentSession(stop),
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
    });

    await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });
    await registry.stop("sess1", { keep: true });

    expect(stop).toHaveBeenCalledWith({ keep: true });
    expect(registry.get("sess1")).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it("stopping an unknown id is a no-op", async () => {
    const registry = new StreamSessionRegistry({});
    await expect(registry.stop("nope")).resolves.toBeUndefined();
  });
});

describe("StreamSessionRegistry — Real-Debrid route", () => {
  const RD_FILES: StreamFile[] = [
    { url: "https://dl.real-debrid.com/d/XYZ/big.mkv", filename: "big.mkv", bytes: 900 },
  ];

  it("resolves through Real-Debrid and reports progress while resolving", async () => {
    const progressSeen: number[] = [];
    const registry = new StreamSessionRegistry({
      resolveDebridImpl: async (_token, _magnet, opts) => {
        opts.onProgress?.(50);
        progressSeen.push(50);
        return RD_FILES;
      },
      idFactory: () => "sess1",
      capabilityFactory: () => "cap1",
    });

    const session = await registry.start({
      ...INPUT,
      route: { kind: "realdebrid" },
      debridToken: "tok",
    });

    expect(session.route).toBe("realdebrid");
    expect(session.state).toBe("ready");
    expect(session.files).toEqual(RD_FILES);
    expect(progressSeen).toEqual([50]);
  });

  it("passes the info hash as knownHash so an existing RD torrent is reused", async () => {
    const resolveDebridImpl = vi.fn(async () => RD_FILES);
    const registry = new StreamSessionRegistry({ resolveDebridImpl });

    await registry.start({ ...INPUT, route: { kind: "realdebrid" }, debridToken: "tok" });

    expect(resolveDebridImpl).toHaveBeenCalledWith(
      "tok",
      INPUT.magnet,
      expect.objectContaining({ knownHash: "abc" }),
    );
  });

  it("fails without a token rather than silently falling back to P2P", async () => {
    const resolveDebridImpl = vi.fn(async () => RD_FILES);
    const streamTorrentImpl = vi.fn(async () => fakeTorrentSession());
    const registry = new StreamSessionRegistry({ resolveDebridImpl, streamTorrentImpl });

    const session = await registry.start({ ...INPUT, route: { kind: "realdebrid" } });

    expect(session.state).toBe("error");
    expect(session.error).toMatch(/Real-Debrid token/i);
    expect(resolveDebridImpl).not.toHaveBeenCalled();
    expect(streamTorrentImpl).not.toHaveBeenCalled();
  });
});

describe("StreamSessionRegistry — stopAll", () => {
  it("stops every live session", async () => {
    const stopA = vi.fn(async () => {});
    const stopB = vi.fn(async () => {});
    let n = 0;
    // Counted separately from `n`: which stop a session gets must not depend on
    // whether the registry mints its id before or after it starts the backend.
    // Sharing the counter silently hands session 1 stopB and session 2
    // undefined, and the test passes while asserting nothing.
    let started = 0;
    const stops = [stopA, stopB];
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: async () => fakeTorrentSession(stops[started++]!),
      idFactory: () => `sess${++n}`,
      capabilityFactory: () => "cap",
    });

    await registry.start({ ...INPUT, route: { kind: "torrent-auto" } });
    await registry.start({ ...INPUT, infoHash: "def", route: { kind: "torrent-auto" } });
    await registry.stopAll();

    expect(stopA).toHaveBeenCalled();
    expect(stopB).toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/streamSession.test.ts`
Expected: FAIL — `Failed to resolve import "./streamSession"`.

- [ ] **Step 3: Commit the test**

```bash
git add src/core/streamSession.test.ts
git commit -m "test: stream session registry lifecycle expectations"
```

---

## Task 10: Stream session registry — implementation

**Files:**
- Create: `src/core/streamSession.ts`
- Test: `src/core/streamSession.test.ts`

- [ ] **Step 1: Write the implementation**

Create `src/core/streamSession.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { streamTorrent, type TorrentStreamSession } from "../integrations/torrentStream";
import { resolveMagnet } from "../integrations/realdebrid";
import type { ResolveOptions } from "../integrations/realdebrid";
import type { StreamFile } from "../util/player";
import type { StreamRoute } from "./streamRoute";

export type StreamSessionState = "resolving" | "ready" | "error";
export type StreamBackend = "realdebrid" | "torrent";

export interface StreamSession {
  id: string;
  // Grants read access to this session's media for clients that cannot send an
  // Authorization header (<video>, <img>, VLC). Read-only and session-scoped.
  capability: string;
  backendHandle: TorrentStreamSession | null;
  route: StreamBackend;
  name: string;
  state: StreamSessionState;
  // Upstream URLs: a Real-Debrid link, or a localhost WebTorrent URL. These stay
  // server-side; clients receive /stream/:sid/:idx handles instead (phase 2).
  files: StreamFile[];
  progress: number;
  error?: string;
  createdAt: number;
}

export type StreamTorrentImpl = (
  magnet: string,
  opts: { signal?: AbortSignal },
) => Promise<TorrentStreamSession>;

export type ResolveDebridImpl = (
  token: string,
  magnet: string,
  opts: ResolveOptions,
) => Promise<StreamFile[]>;

export interface StreamSessionDeps {
  streamTorrentImpl?: StreamTorrentImpl;
  resolveDebridImpl?: ResolveDebridImpl;
  idFactory?: () => string;
  capabilityFactory?: () => string;
  now?: () => number;
}

export interface StartStreamInput {
  infoHash: string;
  magnet: string;
  name: string;
  route: StreamRoute;
  // Required for the realdebrid route. Absent is an error, never a silent
  // downgrade to P2P: that would expose the user's IP after they deliberately
  // configured Real-Debrid.
  debridToken?: string;
}

export const NO_DEBRID_TOKEN = "No Real-Debrid token configured for this stream.";

/**
 * Owns live stream sessions for the whole process, so the TUI and the browser
 * see one list: a session started in the terminal is playable in a browser and
 * vice versa. One session type covers both backends — a Real-Debrid resolve and
 * a local WebTorrent swarm differ only in where `files` come from.
 */
export class StreamSessionRegistry {
  private readonly sessions = new Map<string, StreamSession>();
  private readonly streamTorrentImpl: StreamTorrentImpl;
  private readonly resolveDebridImpl: ResolveDebridImpl;
  private readonly idFactory: () => string;
  private readonly capabilityFactory: () => string;
  private readonly now: () => number;

  constructor(deps: StreamSessionDeps = {}) {
    this.streamTorrentImpl = deps.streamTorrentImpl ?? ((magnet, opts) => streamTorrent(magnet, opts));
    this.resolveDebridImpl = deps.resolveDebridImpl ?? resolveMagnet;
    this.idFactory = deps.idFactory ?? (() => randomUUID());
    this.capabilityFactory = deps.capabilityFactory ?? (() => randomBytes(24).toString("base64url"));
    this.now = deps.now ?? Date.now;
  }

  list(): StreamSession[] {
    return [...this.sessions.values()];
  }

  get(id: string): StreamSession | null {
    return this.sessions.get(id) ?? null;
  }

  /**
   * Start a session and resolve once its files are known (or it has failed).
   * A failure is reported as `state: "error"` with the message the TUI would
   * have shown, not a thrown exception — both front-ends render it the same way.
   */
  async start(input: StartStreamInput): Promise<StreamSession> {
    const viaDebrid = input.route.kind === "realdebrid";
    const session: StreamSession = {
      id: this.idFactory(),
      capability: this.capabilityFactory(),
      backendHandle: null,
      route: viaDebrid ? "realdebrid" : "torrent",
      name: input.name,
      state: "resolving",
      files: [],
      progress: 0,
      createdAt: this.now(),
    };
    this.sessions.set(session.id, session);

    try {
      if (viaDebrid) {
        if (!input.debridToken) throw new Error(NO_DEBRID_TOKEN);
        session.files = await this.resolveDebridImpl(input.debridToken, input.magnet, {
          knownHash: input.infoHash,
          onProgress: (percent) => {
            session.progress = percent;
          },
        });
      } else {
        const handle = await this.streamTorrentImpl(input.magnet, {});
        session.backendHandle = handle;
        session.files = handle.files;
        session.name = handle.name || input.name;
      }
      session.state = "ready";
      session.progress = 100;
    } catch (e) {
      session.state = "error";
      session.error = e instanceof Error ? e.message : String(e);
      session.files = [];
    }
    return session;
  }

  // Stop a session and forget it. `keep` is passed through to the WebTorrent
  // backend so a completed stream's files can be retained on disk.
  async stop(id: string, opts: { keep?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (session.backendHandle) {
      await session.backendHandle.stop({ keep: opts.keep === true }).catch(() => {});
    }
  }

  // Stop everything — used on shutdown so no WebTorrent client outlives the app.
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/core/streamSession.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/core/streamSession.ts
git commit -m "feat: stream session registry over the RD and WebTorrent backends"
```

---

## Task 11: Widen the runtime to own sessions

**Files:**
- Modify: `src/daemon/runtime.ts`
- Test: `src/daemon/runtime.test.ts`

- [ ] **Step 1: Add the failing assertion to the existing test**

Append to `src/daemon/runtime.test.ts`:

```ts
describe("startRuntime — stream sessions", () => {
  it("exposes an empty session registry", async () => {
    const runtime = await startRuntime();
    expect(runtime.sessions.list()).toEqual([]);
    runtime.queue.suspend();
  });
});
```

If `describe`, `it`, `expect` or `startRuntime` are not already imported in that file, add them to the existing import statements rather than duplicating them.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/daemon/runtime.test.ts`
Expected: FAIL — `runtime.sessions` is undefined (`Cannot read properties of undefined (reading 'list')`).

- [ ] **Step 3: Add sessions to the runtime**

In `src/daemon/runtime.ts`, add the import:

```ts
import { StreamSessionRegistry } from "../core/streamSession";
```

Extend the interface:

```ts
export interface Runtime {
  queue: DownloadQueue;
  downloadDir: string;
  // Live stream sessions, shared by every front-end in this process: a stream
  // started in the TUI is playable from the browser and vice versa.
  sessions: StreamSessionRegistry;
  // True when the previous run died mid-restore and this boot came up in safe
  // mode: everything paused, no engines started (see download/bootguard.ts).
  recovered?: boolean;
}
```

And in `startRuntime`, change the return statement from:

```ts
  return { queue, downloadDir, recovered: safe };
```

to:

```ts
  return { queue, downloadDir, sessions: new StreamSessionRegistry(), recovered: safe };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/daemon/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If `src/daemon/serve.test.ts` or `src/daemon/watch.test.ts` build a `Runtime` literal by hand, add `sessions: new StreamSessionRegistry()` to those literals.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/runtime.ts src/daemon/runtime.test.ts src/daemon/serve.test.ts src/daemon/watch.test.ts
git commit -m "feat: runtime owns the stream session registry"
```

---

## Task 12: Web router — write the failing test

**Files:**
- Create: `src/web/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/routes.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { POSTER_HOSTS, handleWebApi, type WebDeps } from "./routes";
import { DownloadQueue } from "../download/queue";
import { StreamSessionRegistry } from "../core/streamSession";
import type { Runtime } from "../daemon/runtime";

function runtime(): Runtime {
  return {
    queue: new DownloadQueue(),
    downloadDir: "/tmp/dl",
    sessions: new StreamSessionRegistry(),
  };
}

function deps(over: Partial<WebDeps> = {}): WebDeps {
  return {
    runtime: runtime(),
    token: null,
    getPosterImpl: async () => ({ path: "/tmp/posters/abc.jpg", bytes: 42 }),
    ...over,
  };
}

const AUTH = "Bearer secret";

describe("handleWebApi — auth", () => {
  it("serves /health without a token", async () => {
    const res = await handleWebApi(deps({ token: "secret" }), "GET", "/health", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true });
  });

  it("rejects an api call with no credentials when a token is set", async () => {
    const res = await handleWebApi(deps({ token: "secret" }), "GET", "/api/status", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(401);
  });

  it("accepts a bearer token", async () => {
    const res = await handleWebApi(deps({ token: "secret" }), "GET", "/api/status", new URLSearchParams(), AUTH, "");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ downloads: [], seeds: [] });
  });
});

describe("handleWebApi — aliases", () => {
  it("serves the same payload at /status and /api/status", async () => {
    const d = deps();
    const legacy = await handleWebApi(d, "GET", "/status", new URLSearchParams(), undefined, "");
    const modern = await handleWebApi(d, "GET", "/api/status", new URLSearchParams(), undefined, "");
    expect(modern.json).toEqual(legacy.json);
  });

  it("routes /api/add through the shared add handler", async () => {
    const res = await handleWebApi(deps(), "POST", "/api/add", new URLSearchParams(), undefined, "not-a-magnet");
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "invalid magnet or info hash" });
  });

  it("rejects an unknown control action at /api/control", async () => {
    const res = await handleWebApi(
      deps(),
      "POST",
      "/api/control",
      new URLSearchParams(),
      undefined,
      JSON.stringify({ id: "abc", action: "explode" }),
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "unknown action: explode" });
  });
});

describe("handleWebApi — /api/poster", () => {
  it("returns the cached file path for an allowed host", async () => {
    const url = "https://m.media-amazon.com/images/poster.jpg";
    const res = await handleWebApi(
      deps(),
      "GET",
      "/api/poster",
      new URLSearchParams({ url }),
      undefined,
      "",
    );
    expect(res.status).toBe(200);
    expect(res.filePath).toBe("/tmp/posters/abc.jpg");
    expect(res.headers?.["Content-Type"]).toBe("image/jpeg");
  });

  it("refuses a host outside the allowlist without fetching", async () => {
    const getPosterImpl = vi.fn(async () => ({ path: "/tmp/x.jpg", bytes: 1 }));
    const res = await handleWebApi(
      deps({ getPosterImpl }),
      "GET",
      "/api/poster",
      new URLSearchParams({ url: "http://169.254.169.254/latest/meta-data" }),
      undefined,
      "",
    );
    expect(res.status).toBe(400);
    expect(getPosterImpl).not.toHaveBeenCalled();
  });

  it("allowlists only the known poster CDNs", () => {
    expect([...POSTER_HOSTS].sort()).toEqual(
      ["ia.media-imdb.com", "img.omdbapi.com", "m.media-amazon.com"].sort(),
    );
  });

  it("404s when the poster cannot be cached", async () => {
    const res = await handleWebApi(
      deps({ getPosterImpl: async () => null }),
      "GET",
      "/api/poster",
      new URLSearchParams({ url: "https://m.media-amazon.com/a.jpg" }),
      undefined,
      "",
    );
    expect(res.status).toBe(404);
  });

  it("400s with no url parameter", async () => {
    const res = await handleWebApi(deps(), "GET", "/api/poster", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(400);
  });
});

describe("handleWebApi — unknown routes", () => {
  it("404s an unknown api path", async () => {
    const res = await handleWebApi(deps(), "GET", "/api/nope", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/routes.test.ts`
Expected: FAIL — `Failed to resolve import "./routes"`.

- [ ] **Step 3: Commit the test**

```bash
git add src/web/routes.test.ts
git commit -m "test: web router auth, aliases and poster allowlist"
```

---

## Task 13: Web router — implementation

**Files:**
- Create: `src/web/routes.ts`
- Test: `src/web/routes.test.ts`

- [ ] **Step 1: Write the implementation**

Create `src/web/routes.ts`:

```ts
import { handleApi } from "../daemon/serve";
import { isAuthorized } from "../daemon/auth";
import { getPoster, type CachedPoster } from "../core/posterCache";
import type { Runtime } from "../daemon/runtime";

// Hosts we are willing to fetch poster images from. The daemon fetching an
// arbitrary caller-supplied URL is server-side request forgery: on a cloud box
// that reaches the instance metadata service. OMDb only ever hands back these
// CDNs, so an allowlist costs nothing.
export const POSTER_HOSTS = new Set([
  "m.media-amazon.com",
  "ia.media-imdb.com",
  "img.omdbapi.com",
]);

export interface WebDeps {
  runtime: Runtime;
  token: string | null;
  getPosterImpl?: (url: string) => Promise<CachedPoster | null>;
}

// One response shape for every route. `filePath` streams a file from disk
// (posters); `json` and `text` are written inline. Keeping this a plain value
// means the router never touches a socket and is trivially testable.
export interface WebResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  filePath?: string;
}

// The daemon's handler predates this layer and returns { status, body }; map it
// into the richer WebResponse rather than changing a shape other callers use.
function fromApi(res: { status: number; body: Record<string, unknown> }): WebResponse {
  return { status: res.status, json: res.body };
}

function posterResponse(hit: CachedPoster): WebResponse {
  return {
    status: 200,
    filePath: hit.path,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(hit.bytes),
      // Poster URLs are content-addressed by the remote CDN; a cached one never
      // changes meaning, so let the browser keep it for a day.
      "Cache-Control": "private, max-age=86400",
    },
  };
}

/**
 * Pure router for the web layer. Shared routes delegate to the daemon's
 * existing `handleApi` rather than reimplementing them, so `/status` and
 * `/api/status` cannot drift apart. `/health` stays unauthenticated (it is how
 * a supervisor checks liveness); everything else requires the token when one
 * is configured.
 */
export async function handleWebApi(
  deps: WebDeps,
  method: string,
  urlPath: string,
  query: URLSearchParams,
  authHeader: string | undefined,
  bodyText: string,
): Promise<WebResponse> {
  const { runtime, token } = deps;

  // Legacy paths keep working exactly as before: /health, /status, /downloads,
  // /add, /control are a documented API that may already be scripted against.
  if (!urlPath.startsWith("/api/")) {
    return fromApi(await handleApi(runtime, token, method, urlPath, authHeader, bodyText));
  }

  if (!isAuthorized(token, authHeader)) {
    return { status: 401, json: { error: "unauthorized" } };
  }

  if (method === "GET" && urlPath === "/api/poster") {
    const url = query.get("url") ?? "";
    if (!url) return { status: 400, json: { error: "missing url" } };
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { status: 400, json: { error: "unsupported scheme" } };
      }
      host = parsed.hostname.toLowerCase();
    } catch {
      return { status: 400, json: { error: "invalid url" } };
    }
    if (!POSTER_HOSTS.has(host)) return { status: 400, json: { error: "host not allowed" } };
    const hit = await (deps.getPosterImpl ?? ((u: string) => getPoster(u)))(url);
    if (!hit) return { status: 404, json: { error: "poster unavailable" } };
    return posterResponse(hit);
  }

  // Everything else under /api/ maps onto the shared handler by stripping the
  // prefix, so /api/status, /api/add and /api/control are one implementation.
  const legacyPath = urlPath.slice("/api".length);
  if (
    (method === "GET" && (legacyPath === "/status" || legacyPath === "/downloads")) ||
    (method === "POST" && (legacyPath === "/add" || legacyPath === "/control"))
  ) {
    return fromApi(await handleApi(runtime, token, method, legacyPath, authHeader, bodyText));
  }

  return { status: 404, json: { error: "not found" } };
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/web/routes.test.ts`
Expected: PASS — all 12 tests.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes.ts
git commit -m "feat: web router with poster cache route and legacy API aliases"
```

---

## Task 14: SSE — write the failing test

**Files:**
- Create: `src/web/sse.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/sse.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_MS, sseFrame, subscribeToQueue } from "./sse";
import { DownloadQueue } from "../download/queue";

describe("sseFrame", () => {
  it("formats an event with a JSON payload", () => {
    expect(sseFrame("status", { a: 1 })).toBe('event: status\ndata: {"a":1}\n\n');
  });

  it("escapes newlines so a multi-line payload cannot break the frame", () => {
    expect(sseFrame("status", { s: "a\nb" })).toBe('event: status\ndata: {"s":"a\\nb"}\n\n');
  });

  it("emits a comment for a heartbeat", () => {
    expect(sseFrame("ping", null)).toBe("event: ping\ndata: null\n\n");
  });
});

describe("subscribeToQueue", () => {
  it("sends an immediate snapshot then one per update", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));

      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]![0]).toContain("event: status");

      queue.emit("update");
      vi.advanceTimersByTime(300);
      expect(write).toHaveBeenCalledTimes(2);

      stop();
      queue.emit("update");
      vi.advanceTimersByTime(300);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of updates into one frame", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      write.mockClear();

      for (let i = 0; i < 20; i++) queue.emit("update");
      vi.advanceTimersByTime(300);

      expect(write).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a heartbeat while idle", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn();
      const stop = subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      write.mockClear();

      vi.advanceTimersByTime(HEARTBEAT_MS + 10);

      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]![0]).toContain("event: ping");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops writing once the write callback throws", () => {
    vi.useFakeTimers();
    try {
      const queue = new DownloadQueue();
      const write = vi.fn(() => {
        throw new Error("socket closed");
      });
      subscribeToQueue(queue, write, () => ({ downloads: [], seeds: [] }));
      write.mockClear();

      queue.emit("update");
      vi.advanceTimersByTime(300);
      queue.emit("update");
      vi.advanceTimersByTime(300);

      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/sse.test.ts`
Expected: FAIL — `Failed to resolve import "./sse"`.

- [ ] **Step 3: Commit the test**

```bash
git add src/web/sse.test.ts
git commit -m "test: SSE frame format, coalescing and heartbeat"
```

---

## Task 15: SSE — implementation

**Files:**
- Create: `src/web/sse.ts`
- Test: `src/web/sse.test.ts`

- [ ] **Step 1: Write the implementation**

Create `src/web/sse.ts`:

```ts
import type { DownloadQueue } from "../download/queue";

// Idle keep-alive. Proxies and phone browsers drop a silent connection; a
// periodic comment-ish event keeps it open without pretending state changed.
export const HEARTBEAT_MS = 25_000;

// Coalesce window for queue updates. The queue emits `update` on every progress
// tick across every torrent; a browser needs a few frames a second at most.
const FLUSH_MS = 250;

export function sseFrame(event: string, data: unknown): string {
  // JSON.stringify escapes newlines, so a payload can never inject a frame
  // boundary — that is the whole reason the data is always JSON here.
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

export type SseWrite = (chunk: string) => void;

/**
 * Push queue state to one SSE client: an immediate snapshot, a coalesced frame
 * per burst of queue activity, and a heartbeat while idle. Returns an
 * unsubscribe function.
 *
 * A write that throws means the socket is gone, so the subscription tears
 * itself down rather than leaking a listener and a timer per dead client.
 */
export function subscribeToQueue(
  queue: DownloadQueue,
  write: SseWrite,
  snapshot: () => unknown,
): () => void {
  let live = true;
  let pending = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (event: string, data: unknown): void => {
    if (!live) return;
    try {
      write(sseFrame(event, data));
    } catch {
      stop();
    }
  };

  const flush = (): void => {
    flushTimer = null;
    if (!live || !pending) return;
    pending = false;
    send("status", snapshot());
  };

  const onUpdate = (): void => {
    if (!live) return;
    pending = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
    flushTimer.unref?.();
  };

  const heartbeat = setInterval(() => send("ping", null), HEARTBEAT_MS);
  heartbeat.unref?.();

  function stop(): void {
    if (!live) return;
    live = false;
    queue.off("update", onUpdate);
    clearInterval(heartbeat);
    if (flushTimer) clearTimeout(flushTimer);
  }

  queue.on("update", onUpdate);
  send("status", snapshot());

  return stop;
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/web/sse.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 3: Commit**

```bash
git add src/web/sse.ts
git commit -m "feat: SSE queue subscription with coalescing and heartbeat"
```

---

## Task 16: Static asset resolution — write the failing test

**Files:**
- Create: `src/web/staticDir.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/staticDir.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentTypeFor, resolveAssetPath } from "./staticDir";

const ROOT = path.resolve("/srv/dist/web");

describe("contentTypeFor", () => {
  it("maps the asset types the dashboard serves", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("styles.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("icon.svg")).toBe("image/svg+xml");
  });

  it("falls back to octet-stream for anything else", () => {
    expect(contentTypeFor("mystery.bin")).toBe("application/octet-stream");
  });
});

describe("resolveAssetPath", () => {
  it("maps / to index.html", () => {
    expect(resolveAssetPath(ROOT, "/")).toBe(path.join(ROOT, "index.html"));
  });

  it("resolves a normal asset", () => {
    expect(resolveAssetPath(ROOT, "/app.js")).toBe(path.join(ROOT, "app.js"));
  });

  it("rejects traversal out of the asset root", () => {
    expect(resolveAssetPath(ROOT, "/../../etc/passwd")).toBeNull();
    expect(resolveAssetPath(ROOT, "/..%2f..%2fetc/passwd")).toBeNull();
  });

  // A leading-slash-stripped path is NOT an escape: it lands inside the asset
  // root and simply 404s. Asserting null here would be asserting the wrong
  // thing — what matters is containment, not rejection.
  it("contains a leading-double-slash path inside the root", () => {
    expect(resolveAssetPath(ROOT, "//etc/passwd")).toBe(path.join(ROOT, "etc/passwd"));
  });

  it("rejects a path containing a space", () => {
    expect(resolveAssetPath(ROOT, "/app.js .png")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/staticDir.test.ts`
Expected: FAIL — `Failed to resolve import "./staticDir"`.

- [ ] **Step 3: Commit the test**

```bash
git add src/web/staticDir.test.ts
git commit -m "test: static asset path resolution and content types"
```

---

## Task 17: Static asset resolution — implementation

**Files:**
- Create: `src/web/staticDir.ts`
- Test: `src/web/staticDir.test.ts`

- [ ] **Step 1: Write the implementation**

Create `src/web/staticDir.ts`:

```ts
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map a request path to a file inside `root`, or null if it escapes.
 *
 * Percent-decoding happens before the containment check, because a check on the
 * raw path would be defeated by `%2e%2e%2f`. The final guard is a prefix test on
 * the *resolved* absolute path, which is the only reliable way to prove
 * containment across platforms.
 */
export function resolveAssetPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes(" ")) return null;
  const rel = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!rel) return null;
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/**
 * Where the built browser assets live. tsup writes them to `dist/web`, so a
 * published install resolves relative to the bundle. A source run (`npm run
 * dev`) has no bundle, so fall back to the repo's own `dist/web` — meaning the
 * web UI needs `npm run build` once before `npm run dev --web` will serve it.
 */
export function findStaticDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "web"), // dist/index.js -> dist/web
    path.resolve(here, "../../dist/web"), // src/web/staticDir.ts -> dist/web
    path.resolve(here, "../dist/web"),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, "index.html"))) ?? null;
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/web/staticDir.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 3: Commit**

```bash
git add src/web/staticDir.ts
git commit -m "feat: resolve built web assets and guard path traversal"
```

---

## Task 18: Dashboard view state — write the failing test

**Files:**
- Create: `src/web/static/dashboard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/static/dashboard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeRows, rowsFromStatus, type DashRow, type StatusPayload } from "./dashboard";

const PAYLOAD: StatusPayload = {
  downloads: [
    { id: "a", name: "A Release", status: "downloading", progress: 0.5, peers: 4, speed: 1024 },
    { id: "b", name: "B Release", status: "queued", progress: 0, peers: 0, speed: 0 },
  ],
  seeds: [{ id: "c", name: "C Release", status: "seeding", peers: 2, uploaded: 2048 }],
};

describe("rowsFromStatus", () => {
  it("maps downloads and seeds into one display list", () => {
    const rows = rowsFromStatus(PAYLOAD);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0]).toEqual<DashRow>({
      id: "a",
      name: "A Release",
      kind: "download",
      status: "downloading",
      percent: 50,
      peers: 4,
      rate: 1024,
      uploaded: 0,
    });
    expect(rows[2]).toEqual<DashRow>({
      id: "c",
      name: "C Release",
      kind: "seed",
      status: "seeding",
      percent: 100,
      peers: 2,
      rate: 0,
      uploaded: 2048,
    });
  });

  it("clamps a progress value outside 0..1", () => {
    const rows = rowsFromStatus({
      downloads: [
        { id: "a", name: "A", status: "downloading", progress: 1.4, peers: 0, speed: 0 },
        { id: "b", name: "B", status: "downloading", progress: -1, peers: 0, speed: 0 },
      ],
      seeds: [],
    });
    expect(rows[0]!.percent).toBe(100);
    expect(rows[1]!.percent).toBe(0);
  });

  it("tolerates missing arrays", () => {
    expect(rowsFromStatus({} as StatusPayload)).toEqual([]);
  });
});

describe("mergeRows", () => {
  it("keeps the previous order for rows that persist", () => {
    const before = rowsFromStatus(PAYLOAD);
    const reordered = rowsFromStatus({
      downloads: [PAYLOAD.downloads[1]!, PAYLOAD.downloads[0]!],
      seeds: PAYLOAD.seeds,
    });
    expect(mergeRows(before, reordered).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("appends new rows at the end and drops removed ones", () => {
    const before = rowsFromStatus(PAYLOAD);
    const next = rowsFromStatus({
      downloads: [
        PAYLOAD.downloads[0]!,
        { id: "z", name: "Z", status: "queued", progress: 0, peers: 0, speed: 0 },
      ],
      seeds: [],
    });
    expect(mergeRows(before, next).map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("takes updated values from the new snapshot", () => {
    const before = rowsFromStatus(PAYLOAD);
    const next = rowsFromStatus({
      downloads: [{ ...PAYLOAD.downloads[0]!, progress: 0.9, speed: 4096 }],
      seeds: [],
    });
    const merged = mergeRows(before, next);
    expect(merged[0]).toMatchObject({ percent: 90, rate: 4096 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/static/dashboard.test.ts`
Expected: FAIL — `Failed to resolve import "./dashboard"`.

- [ ] **Step 3: Commit the test**

```bash
git add src/web/static/dashboard.test.ts
git commit -m "test: dashboard row mapping and stable ordering"
```

---

## Task 19: Dashboard view state — implementation

**Files:**
- Create: `src/web/static/dashboard.ts`
- Test: `src/web/static/dashboard.test.ts`

- [ ] **Step 1: Write the implementation**

Create `src/web/static/dashboard.ts`. This file must stay free of Node imports — it is bundled for the browser:

```ts
// Pure view state for the dashboard. Kept separate from the DOM binding in
// app.ts so the interesting logic is unit-testable without a headless browser.

export interface StatusDownload {
  id: string;
  name: string;
  status: string;
  progress: number;
  peers: number;
  speed: number;
}

export interface StatusSeed {
  id: string;
  name: string;
  status: string;
  peers: number;
  uploaded: number;
}

export interface StatusPayload {
  downloads: StatusDownload[];
  seeds: StatusSeed[];
}

export interface DashRow {
  id: string;
  name: string;
  kind: "download" | "seed";
  status: string;
  percent: number;
  peers: number;
  rate: number;
  uploaded: number;
}

function clampPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

export function rowsFromStatus(payload: StatusPayload): DashRow[] {
  const downloads = (payload.downloads ?? []).map<DashRow>((d) => ({
    id: d.id,
    name: d.name,
    kind: "download",
    status: d.status,
    percent: clampPercent(d.progress),
    peers: d.peers ?? 0,
    rate: d.speed ?? 0,
    uploaded: 0,
  }));
  const seeds = (payload.seeds ?? []).map<DashRow>((s) => ({
    id: s.id,
    name: s.name,
    kind: "seed",
    status: s.status,
    percent: 100,
    peers: s.peers ?? 0,
    rate: 0,
    uploaded: s.uploaded ?? 0,
  }));
  return [...downloads, ...seeds];
}

/**
 * Fold a fresh snapshot into the displayed list without reshuffling it. The
 * server's ordering is not stable across ticks, and a list that reorders under
 * the cursor is unusable — so rows keep the position they were first seen in,
 * new rows append, and vanished rows drop out.
 */
export function mergeRows(previous: DashRow[], next: DashRow[]): DashRow[] {
  const byId = new Map(next.map((r) => [r.id, r]));
  const out: DashRow[] = [];
  for (const old of previous) {
    const fresh = byId.get(old.id);
    if (!fresh) continue;
    out.push(fresh);
    byId.delete(old.id);
  }
  for (const fresh of next) {
    if (byId.has(fresh.id)) out.push(fresh);
  }
  return out;
}

// Byte formatting for the browser. Deliberately a copy of the shape used in
// util/format.ts rather than an import: that module is Node-facing and this file
// is bundled for the browser.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatRate(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "—";
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/web/static/dashboard.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 3: Commit**

```bash
git add src/web/static/dashboard.ts
git commit -m "feat: pure dashboard view state for the web UI"
```

---

## Task 20: Dashboard markup, styles and DOM binding

**Files:**
- Create: `src/web/static/index.html`, `src/web/static/styles.css`, `src/web/static/app.ts`

- [ ] **Step 1: Create the HTML shell**

Create `src/web/static/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>torlnk</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header>
      <h1>torlnk</h1>
      <span id="conn" class="conn" data-state="connecting">connecting</span>
    </header>

    <form id="auth" class="card" hidden>
      <label for="token">Access token</label>
      <input id="token" type="password" autocomplete="current-password" />
      <button type="submit">Unlock</button>
      <p id="auth-error" class="error" hidden></p>
    </form>

    <main id="app" hidden>
      <form id="add" class="card">
        <label for="magnet">Add a magnet or info hash</label>
        <input id="magnet" type="text" placeholder="magnet:?xt=urn:btih:…" />
        <button type="submit">Add</button>
      </form>
      <p id="notice" class="notice" hidden></p>
      <ul id="rows" class="rows"></ul>
      <p id="empty" class="empty">Nothing in the queue.</p>
    </main>

    <script type="module" src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create the stylesheet**

Create `src/web/static/styles.css`:

```css
:root {
  color-scheme: dark light;
  --bg: #12131a;
  --fg: #e6e6ea;
  --dim: #8b8d9b;
  --line: #262838;
  --accent: #7aa2f7;
  --error: #f7768e;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 1.5rem;
  max-width: 60rem;
  margin-inline: auto;
  background: var(--bg);
  color: var(--fg);
}

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  padding-bottom: 0.75rem;
  margin-bottom: 1.5rem;
}

h1 {
  font-size: 1.1rem;
  letter-spacing: 0.08em;
  margin: 0;
  text-transform: uppercase;
}

.conn {
  font-size: 0.75rem;
  color: var(--dim);
}
.conn[data-state="live"] {
  color: var(--accent);
}
.conn[data-state="lost"] {
  color: var(--error);
}

.card {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1.5rem;
}

.card label {
  flex: 1 0 100%;
  font-size: 0.75rem;
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

input {
  flex: 1;
  min-width: 12rem;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 0.35rem;
  background: #0c0d13;
  color: inherit;
  font: inherit;
}

button {
  padding: 0.5rem 0.9rem;
  border: 1px solid var(--line);
  border-radius: 0.35rem;
  background: #1b1d29;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
button:hover {
  border-color: var(--accent);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.row {
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
}

.row-head {
  display: flex;
  gap: 1rem;
  justify-content: space-between;
  align-items: baseline;
}

.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  flex: 0 0 auto;
  font-size: 0.75rem;
  color: var(--dim);
}

.bar {
  height: 0.35rem;
  border-radius: 0.35rem;
  background: var(--line);
  margin-top: 0.6rem;
  overflow: hidden;
}

.bar > span {
  display: block;
  height: 100%;
  background: var(--accent);
}

.row-actions {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.6rem;
}

.row-actions button {
  font-size: 0.7rem;
  padding: 0.25rem 0.55rem;
}

.empty,
.notice,
.error {
  color: var(--dim);
  font-size: 0.8rem;
}
.error {
  color: var(--error);
}
```

- [ ] **Step 3: Create the DOM binding**

Create `src/web/static/app.ts`:

```ts
import {
  formatBytes,
  formatRate,
  mergeRows,
  rowsFromStatus,
  type DashRow,
  type StatusPayload,
} from "./dashboard";

// The token is held in sessionStorage and sent as an Authorization header on
// every API call. No cookie authenticates the API, so there is no CSRF vector
// to defend against.
const TOKEN_KEY = "torlnk.token";

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const authForm = el<HTMLFormElement>("auth");
const authError = el<HTMLParagraphElement>("auth-error");
const tokenInput = el<HTMLInputElement>("token");
const app = el<HTMLElement>("app");
const addForm = el<HTMLFormElement>("add");
const magnetInput = el<HTMLInputElement>("magnet");
const rowsList = el<HTMLUListElement>("rows");
const emptyNote = el<HTMLParagraphElement>("empty");
const notice = el<HTMLParagraphElement>("notice");
const conn = el<HTMLSpanElement>("conn");

let token = sessionStorage.getItem(TOKEN_KEY) ?? "";
let rows: DashRow[] = [];
let stream: EventSource | null = null;

function authHeaders(): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function setConn(state: "connecting" | "live" | "lost"): void {
  conn.dataset.state = state;
  conn.textContent = state;
}

function showNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = false;
  setTimeout(() => {
    notice.hidden = true;
  }, 4000);
}

function render(): void {
  emptyNote.hidden = rows.length > 0;
  rowsList.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement("li");
      li.className = "row";

      const head = document.createElement("div");
      head.className = "row-head";
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = row.name;
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent =
        row.kind === "seed"
          ? `seeding · ${row.peers} peers · ${formatBytes(row.uploaded)} up`
          : `${row.status} · ${row.percent}% · ${row.peers} peers · ${formatRate(row.rate)}`;
      head.append(name, meta);

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("span");
      fill.style.width = `${row.percent}%`;
      bar.append(fill);

      const actions = document.createElement("div");
      actions.className = "row-actions";
      for (const action of row.kind === "seed" ? ["stop-seed", "delete"] : ["pause", "resume", "remove"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action;
        button.addEventListener("click", () => void control(row.id, action));
        actions.append(button);
      }

      li.append(head, bar, actions);
      return li;
    }),
  );
}

async function control(id: string, action: string): Promise<void> {
  const res = await fetch("/api/control", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id, action }),
  });
  if (!res.ok) showNotice(`${action} failed (HTTP ${res.status})`);
}

function connect(): void {
  stream?.close();
  // EventSource cannot send headers, so a token-protected server needs the
  // capability in the query string. It grants read-only status access.
  const url = token ? `/api/events?k=${encodeURIComponent(token)}` : "/api/events";
  const source = new EventSource(url);
  stream = source;
  setConn("connecting");
  source.addEventListener("open", () => setConn("live"));
  source.addEventListener("status", (event) => {
    setConn("live");
    const payload = JSON.parse((event as MessageEvent<string>).data) as StatusPayload;
    rows = mergeRows(rows, rowsFromStatus(payload));
    render();
  });
  source.addEventListener("error", () => setConn("lost"));
}

async function unlock(): Promise<boolean> {
  const res = await fetch("/api/status", { headers: authHeaders() });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as StatusPayload;
  rows = rowsFromStatus(payload);
  render();
  authForm.hidden = true;
  app.hidden = false;
  connect();
  return true;
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  token = tokenInput.value.trim();
  void unlock().then((ok) => {
    if (ok) {
      sessionStorage.setItem(TOKEN_KEY, token);
      authError.hidden = true;
    } else {
      authError.textContent = "That token was rejected.";
      authError.hidden = false;
    }
  });
});

addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const magnet = magnetInput.value.trim();
  if (!magnet) return;
  void fetch("/api/add", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ magnet }),
  }).then(async (res) => {
    const body = (await res.json().catch(() => ({}))) as { error?: string; outcome?: string };
    if (res.ok) {
      magnetInput.value = "";
      showNotice(body.outcome === "duplicate" ? "Already in the queue." : "Added.");
    } else {
      showNotice(body.error ?? `Add failed (HTTP ${res.status})`);
    }
  });
});

// A tokenless (loopback) server unlocks immediately; otherwise show the form.
void unlock().catch(() => false).then((ok) => {
  if (!ok) {
    authForm.hidden = false;
    tokenInput.focus();
  }
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If `lib` in `tsconfig.json` lacks `DOM`, add `"DOM"` to the `lib` array — the browser file needs those types.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/index.html src/web/static/styles.css src/web/static/app.ts
git commit -m "feat: web dashboard markup, styles and DOM binding"
```

---

## Task 21: Build the browser bundle

**Files:**
- Modify: `tsup.config.ts`, `scripts/postbuild.cjs`, `package.json`

- [ ] **Step 1: Add a second tsup build for the browser**

Replace the contents of `tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.tsx"],
    format: ["esm"],
    target: "node22",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
    clean: true,
    sourcemap: false,
    dts: false,
    splitting: false,
    shims: false,
    minify: true,
    esbuildOptions(options) {
      options.jsx = "automatic";
      options.jsxImportSource = "react";
    },
  },
  // The web UI's browser bundle. Separate build because it targets a browser,
  // not node22 — and `clean` must stay off here so it doesn't wipe the CLI
  // output built above.
  {
    entry: { app: "src/web/static/app.ts" },
    outDir: "dist/web",
    format: ["esm"],
    target: "es2022",
    platform: "browser",
    clean: false,
    sourcemap: false,
    dts: false,
    splitting: false,
    minify: true,
  },
]);
```

- [ ] **Step 2: Copy the static files in postbuild**

In `scripts/postbuild.cjs`, add after the `webrtc-stub.mjs` copy:

```js
// The web UI's HTML and CSS aren't bundled by tsup (only app.ts is), so copy
// them next to the generated dist/web/app.js.
const webOut = resolve(root, 'dist/web');
mkdirSync(webOut, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  copyFileSync(resolve(root, 'src/web/static', file), resolve(webOut, file));
}
```

And extend the `node:fs` require at the top of the file:

```js
const { chmodSync, copyFileSync, mkdirSync } = require('node:fs');
```

Update the final log line:

```js
console.log('postbuild: wrote dist/cli.cjs, dist/webrtc-stub.mjs and dist/web assets');
```

- [ ] **Step 3: Ship dist/web in the package**

`package.json` already ships the whole `dist` directory via `"files": ["dist", …]`, so no change is needed there. Verify by reading the `files` array and confirming `"dist"` is present.

- [ ] **Step 4: Build and verify the assets land**

Run: `npm run build && ls dist/web`
Expected: `app.js`, `index.html`, `styles.css` all listed.

- [ ] **Step 5: Commit**

```bash
git add tsup.config.ts scripts/postbuild.cjs
git commit -m "build: bundle and ship the web UI assets to dist/web"
```

---

## Task 22: `startWebServer` — write the failing test

**Files:**
- Create: `src/web/server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/server.test.ts`:

```ts
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type WebServerHandle } from "./server";
import { DownloadQueue } from "../download/queue";
import { StreamSessionRegistry } from "../core/streamSession";
import type { Runtime } from "../daemon/runtime";

function runtime(): Runtime {
  return {
    queue: new DownloadQueue(),
    downloadDir: "/tmp/dl",
    sessions: new StreamSessionRegistry(),
  };
}

let handle: WebServerHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

async function start(over: Parameters<typeof startWebServer>[1] = {}): Promise<string> {
  handle = await startWebServer(runtime(), { port: 0, host: "127.0.0.1", log: () => {}, ...over });
  return `http://127.0.0.1:${handle.port}`;
}

describe("startWebServer", () => {
  it("listens and serves health", async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("serves the JSON status", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ downloads: [], seeds: [] });
  });

  it("requires the token when one is set", async () => {
    const base = await start({ token: "secret" });
    await expect(fetch(`${base}/api/status`).then((r) => r.status)).resolves.toBe(401);
    const ok = await fetch(`${base}/api/status`, { headers: { Authorization: "Bearer secret" } });
    expect(ok.status).toBe(200);
  });

  // Node's fetch() silently DROPS a Host header override (verified: the server
  // still sees 127.0.0.1). Use raw http.request, which honours it — otherwise
  // this test would send a loopback Host, get 200, and quietly stop covering
  // the DNS-rebinding guard it exists for.
  it("rejects a non-loopback Host header when tokenless", async () => {
    await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: handle!.port,
          path: "/api/status",
          method: "GET",
          headers: { Host: "evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("refuses to bind a public host without a token", async () => {
    await expect(
      startWebServer(runtime(), { port: 0, host: "0.0.0.0", log: () => {} }),
    ).rejects.toThrow(/token/i);
  });

  it("never writes to the console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const base = await start();
      await fetch(`${base}/api/status`);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the injected logger instead", async () => {
    const log = vi.fn();
    handle = await startWebServer(runtime(), { port: 0, host: "127.0.0.1", log });
    await fetch(`http://127.0.0.1:${handle.port}/api/status`);
    expect(log).toHaveBeenCalled();
  });

  it("closes cleanly", async () => {
    const base = await start();
    await handle!.close();
    const closed = handle;
    handle = null;
    await expect(fetch(`${base}/health`)).rejects.toThrow();
    await expect(closed!.close()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/server.test.ts`
Expected: FAIL — `Failed to resolve import "./server"`.

- [ ] **Step 3: Commit the test**

```bash
git add src/web/server.test.ts
git commit -m "test: web server binding, auth and logger injection"
```

---

## Task 23: `startWebServer` — implementation

**Files:**
- Create: `src/web/server.ts`
- Test: `src/web/server.test.ts`

- [ ] **Step 1: Write the implementation**

Create `src/web/server.ts`:

```ts
import http from "node:http";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { LOOPBACK_HOSTS, hostHeaderOk, isAuthorized } from "../daemon/auth";
import { handleWebApi, type WebResponse } from "./routes";
import { subscribeToQueue } from "./sse";
import { contentTypeFor, findStaticDir, resolveAssetPath } from "./staticDir";
import type { Runtime } from "../daemon/runtime";

const MAX_BODY_BYTES = 64 * 1024;

export type WebLog = (message: string) => void;

export interface WebServerOptions {
  port?: number;
  host?: string;
  token?: string;
  // Injected deliberately. Ink owns stdout in the TUI, so a stray console.log
  // from a request handler corrupts the rendered frame — this module must never
  // reach for the console itself.
  log?: WebLog;
  staticDir?: string | null;
}

export interface WebServerHandle {
  port: number;
  close: () => Promise<void>;
}

export const DEFAULT_WEB_PORT = 9162;

function statusPayloadFor(runtime: Runtime): unknown {
  const downloads = runtime.queue.getItems().map((it) => ({
    id: it.id,
    name: it.name,
    status: it.status,
    progress: it.progress,
    peers: it.peers,
    speed: it.speed,
  }));
  const seeds = runtime.queue.getSeeds().map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    peers: s.peers,
    uploaded: s.uploaded,
  }));
  return { downloads, seeds };
}

function readBody(req: http.IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        resolve({ text: "", tooLarge: true });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ text: Buffer.concat(chunks).toString("utf8"), tooLarge: false });
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      resolve({ text: "", tooLarge: false });
    });
  });
}

function writeJson(res: http.ServerResponse, out: WebResponse): void {
  res.writeHead(out.status, { "Content-Type": "application/json", ...out.headers });
  res.end(JSON.stringify(out.json ?? {}));
}

/**
 * Mount the web UI and its JSON API on a port. Called by both `torlnk serve
 * --web` (daemon) and `torlnk --web` (TUI), which is why every side effect —
 * logging in particular — arrives as an injected dependency.
 */
export async function startWebServer(
  runtime: Runtime,
  options: WebServerOptions = {},
): Promise<WebServerHandle> {
  const port = options.port ?? DEFAULT_WEB_PORT;
  const host = options.host ?? "127.0.0.1";
  const token = options.token && options.token.trim() ? options.token.trim() : null;
  const log: WebLog = options.log ?? (() => {});

  // Fail soft, not open — the same rule serve.ts enforces. A public bind with
  // no token would expose the queue (and, in phase 2, streams) to the network.
  if (!LOOPBACK_HOSTS.has(host) && !token) {
    throw new Error(
      `refusing to bind ${host} without a token. Pass --token <secret> (or set TORLINK_API_TOKEN), or bind 127.0.0.1.`,
    );
  }

  const staticDir = options.staticDir === undefined ? findStaticDir() : options.staticDir;
  if (!staticDir) {
    log("web assets not found — API only. Run `npm run build` to generate dist/web.");
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const urlPath = url.pathname;

      // Tokenless means loopback-bound; require a loopback Host so a hostile
      // webpage can't reach us through DNS rebinding.
      if (!token && !hostHeaderOk(req.headers.host)) {
        writeJson(res, { status: 403, json: { error: "forbidden host" } });
        log(`${method} ${urlPath} -> 403 (host)`);
        return;
      }

      // SSE: long-lived, so it is handled before the request/response router.
      if (method === "GET" && urlPath === "/api/events") {
        // EventSource cannot set headers, so accept the token from ?k= here.
        const provided = url.searchParams.get("k");
        const authorized = isAuthorized(token, req.headers.authorization) ||
          (provided !== null && isAuthorized(token, `Bearer ${provided}`));
        if (!authorized) {
          writeJson(res, { status: 401, json: { error: "unauthorized" } });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const stop = subscribeToQueue(runtime.queue, (chunk) => res.write(chunk), () =>
          statusPayloadFor(runtime),
        );
        req.on("close", stop);
        log(`${method} ${urlPath} -> 200 (sse)`);
        return;
      }

      const body = method === "POST" ? await readBody(req) : { text: "", tooLarge: false };
      if (body.tooLarge) {
        res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ error: "body too large" }));
        res.once("finish", () => req.destroy());
        log(`${method} ${urlPath} -> 413`);
        return;
      }

      const isApi =
        urlPath.startsWith("/api/") ||
        ["/health", "/status", "/downloads", "/add", "/control"].includes(urlPath);

      if (isApi) {
        let out: WebResponse;
        try {
          out = await handleWebApi(
            { runtime, token },
            method,
            urlPath,
            url.searchParams,
            req.headers.authorization,
            body.text,
          );
        } catch {
          out = { status: 500, json: { error: "internal error" } };
        }
        if (out.filePath) {
          res.writeHead(out.status, out.headers);
          createReadStream(out.filePath)
            .on("error", () => res.destroy())
            .pipe(res);
        } else if (out.text !== undefined) {
          res.writeHead(out.status, { "Content-Type": "text/plain; charset=utf-8", ...out.headers });
          res.end(out.text);
        } else {
          writeJson(res, out);
        }
        if (urlPath !== "/health") log(`${method} ${urlPath} -> ${out.status}`);
        return;
      }

      // Static assets. Requires the token too: the dashboard shell is not
      // secret, but serving it to an unauthenticated caller invites confusion
      // about what is protected.
      if (method !== "GET" || !staticDir) {
        writeJson(res, { status: 404, json: { error: "not found" } });
        return;
      }
      const file = resolveAssetPath(staticDir, urlPath);
      if (!file) {
        writeJson(res, { status: 400, json: { error: "bad path" } });
        log(`${method} ${urlPath} -> 400 (path)`);
        return;
      }
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) throw new Error("not a file");
        res.writeHead(200, {
          "Content-Type": contentTypeFor(file),
          "Content-Length": String(stat.size),
        });
        createReadStream(file)
          .on("error", () => res.destroy())
          .pipe(res);
      } catch {
        writeJson(res, { status: 404, json: { error: "not found" } });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = address && typeof address === "object" ? address.port : port;
  log(`web UI on http://${host}:${boundPort}${token ? " (token required)" : " (loopback only)"}`);

  let closed = false;
  return {
    port: boundPort,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/web/server.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts
git commit -m "feat: startWebServer mounting the API, SSE and static assets"
```

---

## Task 24: CLI flags — write the failing test

**Files:**
- Modify: `src/cli/args.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `src/cli/args.test.ts` (reuse the file's existing `describe`/`it`/`expect` imports and `parseCliArgs` import):

```ts
describe("web flags", () => {
  it("enables the web UI on serve", () => {
    expect(parseCliArgs(["serve", "--web"])).toMatchObject({ kind: "serve", web: true });
  });

  it("defaults serve web to off", () => {
    expect(parseCliArgs(["serve"])).toMatchObject({ kind: "serve", web: false });
  });

  it("reads a web port and token on serve", () => {
    expect(parseCliArgs(["serve", "--web", "--web-port", "8080", "--token", "s3cret"])).toMatchObject({
      kind: "serve",
      web: true,
      webPort: 8080,
      token: "s3cret",
    });
  });

  it("enables the web UI alongside the TUI", () => {
    expect(parseCliArgs(["--web"])).toMatchObject({ kind: "run", web: true });
  });

  it("reads a web port and token for the TUI", () => {
    expect(parseCliArgs(["--web", "--web-port", "8080", "--web-host", "0.0.0.0", "--token", "s3cret"])).toMatchObject({
      kind: "run",
      web: true,
      webPort: 8080,
      webHost: "0.0.0.0",
      webToken: "s3cret",
    });
  });

  it("still treats a bare magnet as a run", () => {
    expect(parseCliArgs(["magnet:?xt=urn:btih:abc"])).toMatchObject({
      kind: "run",
      initialMagnet: "magnet:?xt=urn:btih:abc",
    });
  });

  it("rejects an invalid web port rather than binding a random one", () => {
    expect(parseCliArgs(["serve", "--web", "--web-port", "nope"])).toMatchObject({
      kind: "serve",
      web: true,
      webPort: undefined,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/cli/args.test.ts`
Expected: FAIL — `web` is undefined on both `serve` and `run`.

- [ ] **Step 3: Commit the test**

```bash
git add src/cli/args.test.ts
git commit -m "test: --web CLI flags for serve and the TUI"
```

---

## Task 25: CLI flags — implementation

**Files:**
- Modify: `src/cli/args.ts`
- Test: `src/cli/args.test.ts`

- [ ] **Step 1: Extend the command types**

In `src/cli/args.ts`, change the `run` variant from:

```ts
  | { kind: "run"; initialMagnet?: string; initialTorrent?: string }
```

to:

```ts
  | {
      kind: "run";
      initialMagnet?: string;
      initialTorrent?: string;
      // Serve the web UI alongside the TUI, from the same process and the same
      // in-memory queue.
      web?: boolean;
      webPort?: number;
      webHost?: string;
      webToken?: string;
    }
```

And add `web?: boolean;` plus `webPort?: number;` to the `serve` variant, after `token`:

```ts
  | {
      kind: "serve";
      port?: number;
      host?: string;
      token?: string;
      // Mount the browser UI in addition to the JSON API.
      web?: boolean;
      webPort?: number;
      downloadDir?: string;
      seedTimeMs?: number;
      deleteFiles?: boolean;
      daemon?: boolean;
    }
```

- [ ] **Step 2: Register `--web` as a boolean flag**

Change:

```ts
const BOOL_FLAGS = new Set(["delete-files", "daemon"]);
```

to:

```ts
const BOOL_FLAGS = new Set(["delete-files", "daemon", "web"]);
```

- [ ] **Step 3: Read the flags in `serve`**

In the `serve` branch, add `web` and `webPort` to the returned object:

```ts
    return {
      kind: "serve",
      port: parsePort(flags.port),
      host: flags.host,
      token: flags.token,
      web: bools.has("web"),
      webPort: parsePort(flags["web-port"]),
      downloadDir: flags.to ?? flags.dir,
      seedTimeMs: seedTimeFrom(flags["seed-time"]),
      deleteFiles: bools.has("delete-files"),
      daemon: bools.has("daemon"),
    };
```

- [ ] **Step 4: Parse the interactive-run flags**

The `run` command has no flag parsing today. Replace the final block of `parseCliArgs`:

```ts
  if (/^magnet:\?/i.test(a)) return { kind: "run", initialMagnet: a };
  if (isInfoHash(a)) return { kind: "run", initialMagnet: a };
  if (/\.torrent$/i.test(a)) return { kind: "run", initialTorrent: a };
  return { kind: "invalid", arg: a };
```

with:

```ts
  if (/^magnet:\?/i.test(a)) return { kind: "run", initialMagnet: a };
  if (isInfoHash(a)) return { kind: "run", initialMagnet: a };
  if (/\.torrent$/i.test(a)) return { kind: "run", initialTorrent: a };
  // The interactive run accepts --web (and its options) so the TUI can host the
  // browser UI from the same process.
  if (a === "--web") {
    const { bools, rest: r0 } = splitBooleans(args);
    const { flags } = readFlags(r0);
    return {
      kind: "run",
      web: bools.has("web"),
      webPort: parsePort(flags["web-port"]),
      webHost: flags["web-host"],
      webToken: flags.token ?? flags["web-token"],
    };
  }
  return { kind: "invalid", arg: a };
```

Also add `web: false` to the no-arguments case so the shape is consistent — change:

```ts
  if (args.length === 0) return { kind: "run" };
```

to:

```ts
  if (args.length === 0) return { kind: "run", web: false };
```

- [ ] **Step 5: Update the help text**

In `HELP_TEXT`, add these lines after the `torlnk serve` line:

```
torlnk --web                interactive, plus the web UI on :9162
torlnk serve --web          headless: JSON API + web UI on one port
```

And in the flags section of the same template string, add:

```
  --web                     serve the browser UI as well as the API
  --web-port <n>            port for the web UI (default 9162)
  --web-host <addr>         interface for the web UI (default 127.0.0.1)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/cli/args.test.ts`
Expected: PASS — all tests, including the 7 new ones.

- [ ] **Step 7: Commit**

```bash
git add src/cli/args.ts
git commit -m "feat: --web flags for serve and the interactive TUI"
```

---

## Task 26: Mount the web server from the daemon

**Files:**
- Modify: `src/daemon/serve.ts`, `src/index.tsx`

- [ ] **Step 1: Extend `ServeOptions` and mount the server**

In `src/daemon/serve.ts`, add to `ServeOptions`:

```ts
  /** Also serve the browser UI. */
  web?: boolean;
  /** Port for the browser UI; defaults to the API port + 1. */
  webPort?: number;
```

Add the import at the top:

```ts
import { startWebServer, type WebServerHandle } from "../web/server";
```

In `runServe`, after the `startSeedReaper` block and before `http.createServer`, add:

```ts
  // The browser UI listens on its own port so the JSON API's port stays a
  // stable, documented contract and can be firewalled separately.
  let web: WebServerHandle | null = null;
  if (options.web) {
    try {
      web = await startWebServer(runtime, {
        port: options.webPort ?? port + 1,
        host,
        ...(token ? { token } : {}),
        log,
      });
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
      return;
    }
  }
```

And in the shutdown handler, change:

```ts
    const shutdown = (): void => {
      server.close();
      runtime.queue.suspend();
      resolve();
    };
```

to:

```ts
    const shutdown = (): void => {
      server.close();
      void web?.close();
      void runtime.sessions.stopAll();
      runtime.queue.suspend();
      resolve();
    };
```

- [ ] **Step 2: Pass the flags through from the entry point**

In `src/index.tsx`, find where `runServe` is called with the parsed `serve` command and add the two new options to the object it passes, alongside the existing `port`/`host`/`token`:

```ts
        web: cmd.web,
        webPort: cmd.webPort,
```

If the call spreads the command object wholesale, no change is needed — verify by reading the call site.

- [ ] **Step 3: Verify end to end**

Run:

```bash
npm run build
node dist/index.js serve --web --port 19161 --web-port 19162 &
sleep 2
curl -s http://127.0.0.1:19162/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19162/
kill %1
```

Expected: `{"ok":true,"version":"…"}` then `200`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/serve.ts src/index.tsx
git commit -m "feat: torlnk serve --web mounts the browser UI"
```

---

## Task 27: Mount the web server from the TUI

**Files:**
- Modify: `src/ui/App.tsx`, `src/index.tsx`

- [ ] **Step 1: Accept web options as App props**

In `src/ui/App.tsx`, locate the props interface for `App` and add:

```ts
  // When set, the TUI also hosts the browser UI from this process, sharing the
  // same in-memory queue.
  web?: boolean;
  webPort?: number;
  webHost?: string;
  webToken?: string;
```

- [ ] **Step 2: Start the server in an effect**

Add the import:

```ts
import { startWebServer, type WebServerHandle } from "../web/server";
```

Add this effect alongside the other boot effects, after `queue` and `config` are available:

```ts
  // Host the browser UI in-process when --web is passed. The logger is the
  // TUI's own notice channel: Ink owns stdout, so the web server must never
  // write to the console or it will corrupt the rendered frame.
  useEffect(() => {
    if (!web || !queue) return;
    let handle: WebServerHandle | null = null;
    let alive = true;
    void (async () => {
      try {
        const started = await startWebServer(
          { queue, downloadDir: config?.downloadDir ?? "", sessions: sessionsRef.current },
          {
            ...(webPort === undefined ? {} : { port: webPort }),
            ...(webHost === undefined ? {} : { host: webHost }),
            ...(webToken === undefined ? {} : { token: webToken }),
            log: (message) => log.debug(`[web] ${message}`),
          },
        );
        if (!alive) {
          await started.close();
          return;
        }
        handle = started;
        setNotice(`${ICON.done} Web UI on http://${webHost ?? "127.0.0.1"}:${started.port}`);
      } catch (e) {
        setNotice(`Web UI failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      alive = false;
      void handle?.close();
    };
  }, [web, webPort, webHost, webToken, queue, config?.downloadDir]);
```

Add the session registry ref near the other refs in `App`:

```ts
  // One registry for the process, so a stream started here is visible to the
  // browser and vice versa.
  const sessionsRef = useRef(new StreamSessionRegistry());
```

with the import:

```ts
import { StreamSessionRegistry } from "../core/streamSession";
```

If `log` is not already imported in `App.tsx`, add:

```ts
import { log } from "../util/logger";
```

- [ ] **Step 3: Pass the flags from the entry point**

In `src/index.tsx`, find where `<App />` is rendered for the `run` command and pass the four props through:

```tsx
      <App
        initialMagnet={cmd.initialMagnet}
        initialTorrent={cmd.initialTorrent}
        web={cmd.web}
        webPort={cmd.webPort}
        webHost={cmd.webHost}
        webToken={cmd.webToken}
      />
```

Keep any other existing props on that element.

- [ ] **Step 4: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests pass. Existing `App` tests pass no `web` prop, so the effect returns early and behaviour is unchanged.

- [ ] **Step 5: Verify no stdout corruption by hand**

Run: `npm run build && node dist/index.js --web --web-port 19162`

Then in another terminal: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19162/api/status`

Expected: `200`, and the TUI still renders cleanly with no stray log lines breaking the frame. Quit with `q`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx src/index.tsx
git commit -m "feat: torlnk --web hosts the browser UI beside the TUI"
```

---

## Task 28: Document it

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a web UI section**

Add to `README.md`, after the existing headless/`serve` documentation:

````markdown
## Web UI

torlnk can serve a browser dashboard over the same queue the TUI drives — live
progress, add-by-magnet, pause/resume/remove, and full-quality poster art.

```bash
torlnk --web                 # interactive TUI + web UI on 127.0.0.1:9162
torlnk serve --web           # headless: JSON API on :9161, web UI on :9162
```

### Reaching it from another device

Binding anything other than loopback **requires** a token — torlnk refuses to
start otherwise rather than exposing your queue to the network:

```bash
torlnk serve --web --host 0.0.0.0 --token "$(openssl rand -hex 16)"
```

Open `http://<your-machine>:9162`, paste the token once, and it is kept in the
tab's `sessionStorage`. The token is sent as an `Authorization` header on every
API call; no cookie authenticates the API, so there is nothing for a hostile
page to forge.

### Off-network access

Don't port-forward this to the internet. Either put it behind a reverse proxy
that terminates TLS:

```
torlnk.example.com {
  reverse_proxy 127.0.0.1:9162
}
```

…or — simpler and recommended — join the machine and your phone to a
[Tailscale](https://tailscale.com) network and bind the tailnet address.

> Behind a reverse proxy the dashboard works today because every URL it uses is
> relative. Streaming (coming next) generates absolute URLs for playlists and
> will add a `--trust-proxy` flag for forwarded-host handling.

### Posters

Poster images are fetched once and cached on disk, then served at full quality
to the browser. The TUI renders its half-block previews from the same cache, so
enabling the web UI makes terminal browsing slightly faster too. The cache is
capped and pruned least-recently-used; deleting it is always safe.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document the web UI, LAN access and poster caching"
```

---

## Task 28b: Remove the superseded poster fetcher

**Files:**
- Modify: `src/util/poster.ts`, `src/util/poster.test.ts`

Deferred from Task 3 deliberately: deleting it mid-phase would have added diff
noise to an unrelated review. By this point `cachedPosterRows` has replaced it
everywhere, so leaving it would strand a second implementation of the same job —
its own scheme guard, its own 8s timeout, its own error handling — that no caller
exercises and that can silently drift from the cache's behaviour.

- [ ] **Step 1: Confirm it is genuinely unused**

Run: `grep -rn "fetchPosterRows" src/`
Expected: matches only in `src/util/poster.ts` (the definition) and
`src/util/poster.test.ts` (its tests). If anything else references it, stop —
something in an earlier task did not get rewired, and that is the real bug.

- [ ] **Step 2: Delete the function and its tests**

Remove the `fetchPosterRows` export from `src/util/poster.ts` and its
`describe("fetchPosterRows", …)` block from `src/util/poster.test.ts`. Leave
`renderJpegPoster`, `renderPosterFile`, `downscale` and `halfBlockRows` alone —
they are all still used.

- [ ] **Step 3: Verify nothing depended on it**

Run: `npm run typecheck && npm test`
Expected: no type errors; the full suite passes with the `fetchPosterRows` tests
gone and no other test newly failing.

- [ ] **Step 4: Commit**

```bash
git add src/util/poster.ts src/util/poster.test.ts
git commit -m "refactor: drop fetchPosterRows, superseded by the poster cache"
```

---

## Task 29: Final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS, no skipped or failing tests.

- [ ] **Step 2: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: no errors, no warnings.

- [ ] **Step 3: Build**

Run: `npm run build && ls dist/web`
Expected: build succeeds; `app.js`, `index.html`, `styles.css` present.

- [ ] **Step 4: Confirm the TUI is unchanged**

Run: `node dist/index.js`

Search for something, open a preview pane with a poster, quit with `q`. Expected: identical behaviour to before this plan — posters render, search streams in progressively, nothing about the terminal experience has changed. This is the acceptance criterion for the whole extraction.

- [ ] **Step 5: Confirm the dashboard works**

Run: `node dist/index.js serve --web --port 19161 --web-port 19162`

Open `http://127.0.0.1:19162`, add a magnet, watch progress update live, pause and resume it. Expected: rows update without a page refresh; the connection indicator reads `live`.

- [ ] **Step 6: Note the phase 2 boundary**

Confirm that no `/stream`, `.m3u`, or player route exists yet — those are phase 2, specified in `docs/superpowers/specs/2026-07-27-web-ui-design.md`. Streaming from the browser is expected NOT to work at the end of this plan.

---

## Deferred to later phases

Per the spec, these are deliberately absent from this plan:

- `/stream/:sid/:idx` handles, the RD 302, the WebTorrent range proxy, `.m3u`, and the player page — **phase 2**.
- Search, poster grid and add-from-result in the browser — **phase 3**.
- `core/feed.ts` and the For You pane — **phase 4**.
- ffmpeg transcoding, client-side mkv demuxing, RD byte proxying, user accounts — out of scope entirely.
