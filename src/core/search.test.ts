import { describe, expect, it, vi } from "vitest";
import { defaultOrder, mergeDuplicateResults, runSearch, shouldBench, type SearchSnapshot } from "./search";
import { AuthRequiredError } from "../sources/rutracker";
import { HttpError } from "../util/net";
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

  it("surfaces the HTTP status as the failure code", async () => {
    const snap = await runSearch("query", [source("eztv")], {
      health: new Map(),
      searchImpl: async () => {
        throw new HttpError(503, "service unavailable");
      },
    });

    expect(snap.perSource.eztv).toMatchObject({
      error: "service unavailable",
      code: "HTTP 503",
    });
  });

  it("breaks a seeder tie on recency", async () => {
    const snap = await runSearch("query", [source("yts")], {
      health: new Map(),
      searchImpl: async () => [
        { ...result("older", "yts", 5), added: 100 },
        { ...result("newer", "yts", 5), added: 900 },
      ],
    });

    expect(snap.results.map((r) => r.infoHash)).toEqual(["newer", "older"]);
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

  it("benches a source after repeated failures but not on an auth error", async () => {
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

  it("does not count an auth error against a source's health", async () => {
    const health = new Map<SourceId, Health>();
    for (let i = 0; i < 3; i++) {
      await runSearch("q", [source("eztv")], {
        health,
        now: () => 1000,
        searchImpl: async () => {
          throw new AuthRequiredError();
        },
      });
    }
    expect(health.has("eztv")).toBe(false);
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

  it("honours a caller-supplied timeout budget", async () => {
    vi.useFakeTimers();
    try {
      const promise = runSearch("q", [source("eztv")], {
        health: new Map(),
        now: () => 1000,
        timeoutMs: 50,
        searchImpl: (_s, _q, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      });
      await vi.advanceTimersByTimeAsync(51);
      const snap = await promise;
      expect(snap.perSource.eztv).toMatchObject({ code: "timed out" });
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
    // Asserted after the search has finished, so this also pins the snapshot's
    // defensive copy: a shared perSource object would have been overwritten by
    // the time the second source settled.
    expect(seen[0]!.perSource.eztv).toEqual({
      loading: true,
      error: null,
      code: null,
      count: 0,
    });
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

  it("does not bench a source we cancelled ourselves", async () => {
    const health = new Map<SourceId, Health>();
    const ctrl = new AbortController();
    const promise = runSearch("q", [source("eztv")], {
      health,
      signal: ctrl.signal,
      now: () => 1000,
      searchImpl: (_s, _q, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    ctrl.abort();
    await promise;
    expect(health.has("eztv")).toBe(false);
  });

  it("cancels sources when handed a signal that already aborted", async () => {
    // An already-fired signal never calls an abort listener, so without an
    // explicit check each source would run to completion before being discarded.
    const ctrl = new AbortController();
    ctrl.abort();
    let sawAborted: boolean | undefined;
    await runSearch("q", [source("eztv")], {
      health: new Map(),
      signal: ctrl.signal,
      searchImpl: async (_s, _q, opts) => {
        sawAborted = opts.signal?.aborted;
        return [];
      },
    });
    expect(sawAborted).toBe(true);
  });

  it("discards results that land after the caller aborts", async () => {
    // Seeded as unhealthy-but-not-benched: a stray recordSuccess would clear it.
    const health = new Map<SourceId, Health>([["yts", { fails: 2, skipUntil: 0 }]]);
    const ctrl = new AbortController();
    let land: (() => void) | undefined;
    const promise = runSearch("q", [source("yts")], {
      health,
      signal: ctrl.signal,
      searchImpl: () =>
        new Promise((resolve) => {
          land = () => resolve([result("aaa", "yts", 1)]);
        }),
    });
    ctrl.abort();
    land!();
    const snap = await promise;

    expect(snap.results).toEqual([]);
    expect(health.get("yts")?.fails).toBe(2);
  });
});

describe("shouldBench", () => {
  it("does not bench on AuthRequiredError", () => {
    expect(shouldBench(new AuthRequiredError())).toBe(false);
  });

  it("benches on a generic error", () => {
    expect(shouldBench(new Error("boom"))).toBe(true);
  });

  it("benches on an HttpError", () => {
    expect(shouldBench(new HttpError(500, "server error"))).toBe(true);
  });

  it("benches on a non-Error thrown value", () => {
    expect(shouldBench("timed out")).toBe(true);
  });
});

describe("mergeDuplicateResults", () => {
  it("keeps the healthiest copy and records every source", () => {
    const base = {
      infoHash: "abc",
      name: "Release",
      sizeBytes: 10,
      leechers: 0,
      magnet: "magnet:?xt=urn:btih:abc",
    } as const;
    const merged = mergeDuplicateResults([
      { ...base, source: "tpb-movies", seeders: 3 },
      { ...base, source: "x1337-movies", seeders: 8 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ source: "x1337-movies", seeders: 8 });
    expect(merged[0]!.sources).toEqual(["tpb-movies", "x1337-movies"]);
  });
});

describe("defaultOrder", () => {
  function withAdded(infoHash: string, seeders: number, added?: number): TorrentResult {
    return { ...result(infoHash, "tpb-movies", seeders), added };
  }

  it("orders by seeders, then newest first", () => {
    const ordered = defaultOrder([
      withAdded("few", 2, 300),
      withAdded("older", 8, 100),
      withAdded("newer", 8, 200),
      withAdded("undated", 8),
    ]);
    expect(ordered.map((r) => r.infoHash)).toEqual(["newer", "older", "undated", "few"]);
  });

  // The TUI and the headless `search` command both order through this, so a
  // change here has to stay one change rather than two that drift.
  it("puts a missing added last among equal seeders", () => {
    const ordered = defaultOrder([withAdded("undated", 5), withAdded("dated", 5, 1)]);
    expect(ordered.map((r) => r.infoHash)).toEqual(["dated", "undated"]);
  });
});
