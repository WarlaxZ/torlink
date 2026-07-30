import { describe, expect, it, vi } from "vitest";
import { batchHashes, cachedHashesFor, CACHED_BATCH } from "./cachedHashes";
import type { DebridProvider } from "../integrations/debrid/types";

function provider(over: Partial<DebridProvider> = {}): DebridProvider {
  return {
    id: "torbox",
    label: "TorBox",
    shortLabel: "TB",
    homepage: "torbox.app",
    tokenUrl: "https://torbox.app/settings",
    tokenEnvVar: "TORBOX_API_TOKEN",
    validateToken: () => Promise.reject(new Error("unused")),
    resolveMagnet: () => Promise.reject(new Error("unused")),
    isTransient: () => false,
    isTokenRejection: () => false,
    ...over,
  };
}

describe("batchHashes", () => {
  it("splits into batches of at most `size`", () => {
    expect(batchHashes(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });

  it("returns no batches for no hashes", () => {
    expect(batchHashes([], 2)).toEqual([]);
  });

  it("lowercases and de-duplicates, so one hash is asked about once", () => {
    expect(batchHashes(["AA", "aa", "bb"], 10)).toEqual([["aa", "bb"]]);
  });

  it("defaults to CACHED_BATCH", () => {
    expect(batchHashes(Array.from({ length: CACHED_BATCH + 1 }, (_, i) => `h${i}`))).toHaveLength(2);
  });
});

describe("cachedHashesFor", () => {
  it("returns an empty set when the provider cannot check", async () => {
    // Real-Debrid's case: no checkCached at all, so there is nothing to call.
    expect((await cachedHashesFor(provider({ checkCached: undefined }), "t", ["aa"])).size).toBe(0);
  });

  it("returns an empty set with no token, without calling the provider", async () => {
    const checkCached = vi.fn(() => Promise.resolve(new Set(["aa"])));
    expect((await cachedHashesFor(provider({ checkCached }), "", ["aa"])).size).toBe(0);
    expect(checkCached).not.toHaveBeenCalled();
  });

  it("unions the results of every batch", async () => {
    const checkCached = vi.fn((_t: string, hashes: string[]) => Promise.resolve(new Set([hashes[0]!])));
    const cached = await cachedHashesFor(provider({ checkCached }), "t", ["aa", "bb", "cc"], { batchSize: 2 });
    expect([...cached].sort()).toEqual(["aa", "cc"]);
    expect(checkCached).toHaveBeenCalledTimes(2);
  });

  it("fails soft: a throwing batch yields no tags rather than an error", async () => {
    const checkCached = vi.fn((_t: string, hashes: string[]) =>
      hashes.includes("bb") ? Promise.reject(new Error("rate limited")) : Promise.resolve(new Set(hashes)),
    );
    const cached = await cachedHashesFor(provider({ checkCached }), "t", ["aa", "bb"], { batchSize: 1 });
    // The good batch still counts; the failed one simply contributes nothing.
    expect([...cached]).toEqual(["aa"]);
  });
});
