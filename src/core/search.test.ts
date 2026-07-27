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
