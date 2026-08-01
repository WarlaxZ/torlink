import { describe, expect, it } from "vitest";
import {
  castBlockerReason,
  castButtonView,
  castControls,
  castStatusLine,
  formatCastTime,
} from "./castModel";
import type { CastDevicesResponse, CastStatusResponse } from "../wire";

const ONE_DEVICE: CastDevicesResponse = {
  devices: [{ id: "abc", name: "Living Room TV", model: "Chromecast" }],
  castable: true,
  reason: null,
};
const TWO_DEVICES: CastDevicesResponse = {
  devices: [
    { id: "abc", name: "Living Room TV", model: "Chromecast" },
    { id: "k1", name: "Kitchen display", model: "Google TV Streamer" },
  ],
  castable: true,
  reason: null,
};
const NONE: CastDevicesResponse = {
  devices: [],
  castable: false,
  reason: "No Chromecast found on this network.",
};
const LOOKING: CastDevicesResponse = { devices: [], castable: false, reason: null };
const IDLE: CastStatusResponse = { casting: null, notice: null };

const casting = (
  over: Partial<NonNullable<CastStatusResponse["casting"]>> = {},
): CastStatusResponse => ({
  casting: {
    deviceName: "Living Room TV",
    title: "Kepler S02E04",
    state: "playing",
    positionSec: 0,
    durationSec: 600,
    ...over,
  },
  notice: null,
});

describe("castButtonView", () => {
  it("is hidden until the device list has been fetched, so nothing flickers", () => {
    expect(castButtonView({ devices: null, status: null, castBlockers: [], hasHls: false })).toEqual({
      state: "hidden",
      label: "",
      disabledReason: null,
    });
  });

  it("offers casting when a device answered and the file is playable", () => {
    expect(castButtonView({ devices: ONE_DEVICE, status: IDLE, castBlockers: [], hasHls: false })).toEqual({
      state: "ready",
      label: "Cast to TV",
      disabledReason: null,
    });
  });

  it("says it is looking while discovery has not reported a reason yet", () => {
    expect(castButtonView({ devices: LOOKING, status: IDLE, castBlockers: [], hasHls: false })).toEqual({
      state: "finding",
      label: "Finding devices…",
      disabledReason: null,
    });
  });

  it("is disabled with the network's reason when nothing answered", () => {
    expect(castButtonView({ devices: NONE, status: IDLE, castBlockers: [], hasHls: false })).toEqual({
      state: "disabled",
      label: "Cast to TV",
      disabledReason: "No Chromecast found on this network.",
    });
  });

  it("is disabled with the FILE's reason when no Chromecast can play it, even with a device present", () => {
    // Which of the two reasons is shown matters: "the network" and "this file"
    // send the user to completely different places.
    expect(
      castButtonView({ devices: ONE_DEVICE, status: IDLE, castBlockers: ["container"], hasHls: false }),
    ).toEqual({
      state: "disabled",
      label: "Cast to TV",
      disabledReason: "A Chromecast can't play this one — it won't demux this container.",
    });
  });

  it("offers casting for a blocked file that has an HLS manifest, which is the rung above it", () => {
    // The debrid provider's transcode. Same file, different backend, different
    // answer — which is why this takes `hasHls` rather than deciding from the
    // blockers alone.
    expect(
      castButtonView({ devices: ONE_DEVICE, status: IDLE, castBlockers: ["container"], hasHls: true }),
    ).toMatchObject({ state: "ready" });
  });

  it("prefers the file's reason over the network's when both are true", () => {
    // Nothing found AND unplayable: fixing the network would still not cast this
    // file, so the file is the more useful thing to say.
    expect(
      castButtonView({ devices: NONE, status: IDLE, castBlockers: ["video"], hasHls: false }),
    ).toMatchObject({ disabledReason: "A Chromecast can't play this one — it can't decode this video." });
  });

  it("names the device once something is casting", () => {
    expect(castButtonView({ devices: ONE_DEVICE, status: casting(), castBlockers: [], hasHls: false })).toEqual({
      state: "casting",
      label: "Playing on Living Room TV",
      disabledReason: null,
    });
  });

  it("still reports casting when the file itself is blocked, because it is already playing", () => {
    // It got there via HLS. A "can't play this" label over a playing television
    // would be absurd.
    expect(
      castButtonView({ devices: ONE_DEVICE, status: casting(), castBlockers: ["container"], hasHls: true }),
    ).toMatchObject({ state: "casting" });
  });

  it("does not depend on how many devices there are", () => {
    expect(castButtonView({ devices: TWO_DEVICES, status: IDLE, castBlockers: [], hasHls: false })).toMatchObject({
      state: "ready",
    });
  });
});

describe("castStatusLine", () => {
  it("reads position over duration", () => {
    expect(castStatusLine(casting({ positionSec: 724, durationSec: 6_512 }))).toBe(
      "0:12:04 / 1:48:32",
    );
  });

  it("shows position alone when the duration is unknown, rather than inventing 0:00:00", () => {
    expect(castStatusLine(casting({ positionSec: 5, durationSec: null }))).toBe("0:00:05");
  });

  it("says what it is doing when it is not playing", () => {
    expect(castStatusLine(casting({ state: "loading", positionSec: 0, durationSec: null }))).toBe(
      "Loading on the TV…",
    );
    expect(castStatusLine(casting({ state: "paused", positionSec: 61, durationSec: 600 }))).toBe(
      "Paused · 0:01:01 / 0:10:00",
    );
    expect(castStatusLine(casting({ state: "idle", positionSec: 0, durationSec: null }))).toBe(
      "Finished on the TV.",
    );
  });

  it("is null when nothing is casting", () => {
    expect(castStatusLine(IDLE)).toBeNull();
  });
});

describe("formatCastTime", () => {
  it("is h:mm:ss, zero-padded past the hours", () => {
    expect(formatCastTime(0)).toBe("0:00:00");
    expect(formatCastTime(61)).toBe("0:01:01");
    expect(formatCastTime(3_661)).toBe("1:01:01");
    expect(formatCastTime(36_000)).toBe("10:00:00");
  });

  it("floors a fractional position and clamps a negative or unusable one", () => {
    // The receiver reports currentTime as a float, and has been seen to report a
    // small negative one while it is still seeking.
    expect(formatCastTime(12.9)).toBe("0:00:12");
    expect(formatCastTime(-5)).toBe("0:00:00");
    expect(formatCastTime(NaN)).toBe("0:00:00");
  });
});

describe("castControls", () => {
  it("offers pause and stop while playing, play and stop while paused", () => {
    expect(castControls(casting({ state: "playing" }))).toEqual(["pause", "stop"]);
    expect(castControls(casting({ state: "paused" }))).toEqual(["play", "stop"]);
  });

  it("offers only stop before playback has started, or after it has ended", () => {
    // Pausing something that has not started is a button that appears to do
    // nothing, which is the failure this whole feature keeps avoiding.
    expect(castControls(casting({ state: "loading" }))).toEqual(["stop"]);
    expect(castControls(casting({ state: "idle" }))).toEqual(["stop"]);
  });

  it("offers nothing when nothing is casting", () => {
    expect(castControls(IDLE)).toEqual([]);
  });
});

describe("castBlockerReason", () => {
  it("names the container first, because it is the one a user can recognise", () => {
    expect(castBlockerReason(["container", "audio"])).toBe("it won't demux this container");
    expect(castBlockerReason(["video"])).toBe("it can't decode this video");
    expect(castBlockerReason(["audio"])).toBe("it can't decode this audio");
  });

  it("never returns an empty string, so a disabled button always says why", () => {
    expect(castBlockerReason([])).not.toBe("");
  });
});
