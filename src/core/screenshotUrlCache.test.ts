import { describe, expect, it, vi } from "vitest";
import { ScreenshotUrlCache, cachedScreenshotsFor } from "./screenshotUrlCache";
import type { Shot } from "../util/screenshotExtract";

const shot = (full: string): Shot => ({ full, thumb: full });

describe("ScreenshotUrlCache", () => {
  it("returns what was stored, keyed by source and ref together", () => {
    const cache = new ScreenshotUrlCache(4);
    cache.set("TPB", "1", [shot("a")]);
    cache.set("TPB", "2", [shot("b")]);
    expect(cache.get("TPB", "1")?.[0]?.full).toBe("a");
    expect(cache.get("TPB", "2")?.[0]?.full).toBe("b");
    expect(cache.get("1337x", "1")).toBeUndefined();
  });

  it("does not confuse a source containing the separator", () => {
    const cache = new ScreenshotUrlCache(4);
    cache.set("a:1", "x", [shot("a")]);
    expect(cache.get("a", "1:x")).toBeUndefined();
  });

  it("evicts the oldest entry past its bound, so it cannot grow forever", () => {
    const cache = new ScreenshotUrlCache(2);
    cache.set("s", "0", [shot("a")]);
    cache.set("s", "1", [shot("b")]);
    cache.set("s", "2", [shot("c")]);
    expect(cache.get("s", "0")).toBeUndefined();
    expect(cache.get("s", "2")?.[0]?.full).toBe("c");
  });

  it("re-setting a key refreshes its position rather than adding a second entry", () => {
    const cache = new ScreenshotUrlCache(2);
    cache.set("s", "0", [shot("a")]);
    cache.set("s", "1", [shot("b")]);
    cache.set("s", "0", [shot("a2")]);
    cache.set("s", "2", [shot("c")]);
    expect(cache.get("s", "1")).toBeUndefined();
    expect(cache.get("s", "0")?.[0]?.full).toBe("a2");
    expect(cache.get("s", "2")?.[0]?.full).toBe("c");
  });

  it("caches an empty result too, so a listing page with no shots is not re-scraped forever", () => {
    const cache = new ScreenshotUrlCache(4);
    cache.set("s", "0", []);
    expect(cache.get("s", "0")).toEqual([]);
  });
});

describe("cachedScreenshotsFor", () => {
  it("fetches once per source+ref and serves the second lookup from cache", async () => {
    const cache = new ScreenshotUrlCache(4);
    const fetchImpl = vi.fn(async () => [shot("a")]);
    const first = await cachedScreenshotsFor("TPB", "42", { limit: 4 }, cache, fetchImpl);
    const second = await cachedScreenshotsFor("TPB", "42", { limit: 4 }, cache, fetchImpl);
    expect(first).toEqual([shot("a")]);
    expect(second).toEqual([shot("a")]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keys the cache by source and ref, so a different ref is fetched again", async () => {
    const cache = new ScreenshotUrlCache(4);
    const fetchImpl = vi.fn(async (source: string, ref: string) => [shot(ref)]);
    await cachedScreenshotsFor("TPB", "1", { limit: 4 }, cache, fetchImpl);
    await cachedScreenshotsFor("TPB", "2", { limit: 4 }, cache, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not fetch or cache when ref is empty", async () => {
    const cache = new ScreenshotUrlCache(4);
    const fetchImpl = vi.fn(async () => [shot("a")]);
    const result = await cachedScreenshotsFor("TPB", "", { limit: 4 }, cache, fetchImpl);
    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
