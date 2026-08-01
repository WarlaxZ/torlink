import { describe, expect, it } from "vitest";
import { castBlockerClause, castClock, formatCastTime } from "./castStatus";

describe("formatCastTime", () => {
  it("is h:mm:ss, zero-padded past the hours", () => {
    expect(formatCastTime(0)).toBe("0:00:00");
    expect(formatCastTime(61)).toBe("0:01:01");
    expect(formatCastTime(3_661)).toBe("1:01:01");
    expect(formatCastTime(36_000)).toBe("10:00:00");
  });

  it("floors a fractional position and clamps an unusable one", () => {
    // The input is a float from a television, and a receiver has been seen to
    // report a small negative one while it is still seeking.
    expect(formatCastTime(12.9)).toBe("0:00:12");
    expect(formatCastTime(-5)).toBe("0:00:00");
    expect(formatCastTime(NaN)).toBe("0:00:00");
    expect(formatCastTime(Infinity)).toBe("0:00:00");
  });
});

describe("castClock", () => {
  it("reads position over duration while playing", () => {
    expect(castClock({ state: "playing", positionSec: 724, durationSec: 6_512 })).toBe(
      "0:12:04 / 1:48:32",
    );
  });

  it("shows position alone when the duration is unknown, rather than inventing 0:00:00", () => {
    expect(castClock({ state: "playing", positionSec: 5, durationSec: null })).toBe("0:00:05");
  });

  it("names the state when it is not playing", () => {
    expect(castClock({ state: "loading", positionSec: 0, durationSec: null })).toBe(
      "Loading on the TV…",
    );
    expect(castClock({ state: "idle", positionSec: 0, durationSec: null })).toBe(
      "Finished on the TV.",
    );
    expect(castClock({ state: "paused", positionSec: 61, durationSec: 600 })).toBe(
      "Paused · 0:01:01 / 0:10:00",
    );
  });

  it("ignores a position a loading receiver reports, because there is nothing to be at yet", () => {
    expect(castClock({ state: "loading", positionSec: 99, durationSec: 600 })).toBe(
      "Loading on the TV…",
    );
  });
});

describe("castBlockerClause", () => {
  it("names the container first, because it is the one a user can recognise", () => {
    expect(castBlockerClause(["container", "audio"])).toBe("it won't demux this container");
    expect(castBlockerClause(["video"])).toBe("it can't decode this video");
    expect(castBlockerClause(["audio"])).toBe("it can't decode this audio");
  });

  it("never names the subject, because both callers already have", () => {
    // THE BUG THIS PINS, seen on the wire from a real device: the server had its
    // own copy of this text that began "a Chromecast…", so the refusal read
    // "A Chromecast can't play this one — a Chromecast won't demux this container".
    for (const blockers of [["container"], ["video"], ["audio"], []]) {
      expect(castBlockerClause(blockers)).not.toMatch(/chromecast/i);
    }
  });

  it("never returns an empty string, so a refusal always says why", () => {
    expect(castBlockerClause([])).not.toBe("");
  });
});
