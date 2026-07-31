import { describe, expect, it } from "vitest";
import { HlsVerdictCache } from "./hlsVerdictCache";

describe("HlsVerdictCache", () => {
  it("returns what was stored, keyed by session and index together", () => {
    const cache = new HlsVerdictCache(4);
    cache.set("sid-1", 0, true);
    cache.set("sid-1", 1, false);
    expect(cache.get("sid-1", 0)).toBe(true);
    expect(cache.get("sid-1", 1)).toBe(false);
    expect(cache.get("sid-2", 0)).toBeUndefined();
  });

  // The distinction the whole cache turns on: "no" must not read as "not asked",
  // or a manifest already found unusable is re-probed on every page load and the
  // probe segment is pulled through this machine again each time.
  it("keeps a stored false distinguishable from never having asked", () => {
    const cache = new HlsVerdictCache(4);
    cache.set("sid-1", 0, false);
    expect(cache.get("sid-1", 0)).toBe(false);
    expect(cache.get("sid-1", 0)).not.toBeUndefined();
    expect(cache.get("sid-1", 9)).toBeUndefined();
  });

  it("does not confuse a session id containing the separator", () => {
    const cache = new HlsVerdictCache(4);
    cache.set("a:1", 0, true);
    expect(cache.get("a", 1)).toBeUndefined();
  });

  it("evicts the oldest entry past its bound, so it cannot grow forever", () => {
    const cache = new HlsVerdictCache(2);
    cache.set("s", 0, true);
    cache.set("s", 1, true);
    cache.set("s", 2, false);
    expect(cache.get("s", 0)).toBeUndefined();
    expect(cache.get("s", 2)).toBe(false);
  });

  it("re-setting a key refreshes its position rather than adding a second entry", () => {
    const cache = new HlsVerdictCache(2);
    cache.set("s", 0, true);
    cache.set("s", 1, true);
    cache.set("s", 0, false);
    cache.set("s", 2, true);
    // "s,0" was rewritten last of the first two, so "s,1" is the oldest and goes.
    expect(cache.get("s", 1)).toBeUndefined();
    expect(cache.get("s", 0)).toBe(false);
    expect(cache.get("s", 2)).toBe(true);
  });
});
