import { describe, expect, it } from "vitest";
import { ProbeCache } from "./probeCache";
import type { MediaFacts } from "../util/playability";

const facts = (videoCodec: string): MediaFacts => ({
  container: "mkv",
  videoCodec,
  audioCodec: "aac",
  source: "probe",
});

describe("ProbeCache", () => {
  it("returns what was stored, keyed by session and index together", () => {
    const cache = new ProbeCache(4);
    cache.set("sid-1", 0, facts("h264"));
    cache.set("sid-1", 1, facts("hevc"));
    expect(cache.get("sid-1", 0)?.videoCodec).toBe("h264");
    expect(cache.get("sid-1", 1)?.videoCodec).toBe("hevc");
    expect(cache.get("sid-2", 0)).toBeUndefined();
  });

  it("does not confuse a session id containing the separator", () => {
    // Session ids are UUIDs today, but a key built by concatenation is a bug
    // waiting for the day they aren't.
    const cache = new ProbeCache(4);
    cache.set("a:1", 0, facts("h264"));
    expect(cache.get("a", 1)).toBeUndefined();
  });

  it("evicts the oldest entry past its bound, so it cannot grow forever", () => {
    const cache = new ProbeCache(2);
    cache.set("s", 0, facts("h264"));
    cache.set("s", 1, facts("hevc"));
    cache.set("s", 2, facts("vp9"));
    expect(cache.get("s", 0)).toBeUndefined();
    expect(cache.get("s", 2)?.videoCodec).toBe("vp9");
  });

  it("re-setting a key refreshes its position rather than adding a second entry", () => {
    const cache = new ProbeCache(2);
    cache.set("s", 0, facts("h264"));
    cache.set("s", 1, facts("hevc"));
    cache.set("s", 0, facts("vp9"));
    cache.set("s", 2, facts("vp8"));
    // "s:1" was the oldest by then, so it is the one that went.
    expect(cache.get("s", 1)).toBeUndefined();
    expect(cache.get("s", 0)?.videoCodec).toBe("vp9");
    expect(cache.get("s", 2)?.videoCodec).toBe("vp8");
  });
});
