import { describe, expect, it } from "vitest";
import {
  createTrackFailureTracker,
  embeddedNotice,
  subtitleDownload,
  subtitleErrorNotice,
  subtitleTracks,
  type TrackSpec,
} from "./subtitleModel";
import type { PlayerTarget } from "./playerModel";
import type { StreamInfoResponse } from "../wire";

const target: PlayerTarget = { sid: "abc", index: 0, capability: "cap", filename: "Kepler.S02E04.mkv" };

const info = (over: Partial<StreamInfoResponse>): StreamInfoResponse => ({
  facts: { container: "mkv", videoCodec: "h264", audioCodec: "aac", source: "probe", subtitles: [] },
  blockers: [],
  castBlockers: [],
  hls: null,
  subtitles: { embedded: [], files: [] },
  ...over,
});

describe("subtitleTracks", () => {
  it("builds a track per renderable sibling file", () => {
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "Kepler.S02E04.eng.srt", language: "en", label: "English", renderable: true },
          ],
        },
      }),
      target,
    );
    expect(tracks).toEqual([
      { src: "/stream/abc/1.vtt?k=cap", srclang: "en", label: "English", default: true },
    ]);
  });

  it("omits files the browser cannot render", () => {
    // ass/ssa/sub need a subtitle engine. Offering a <track> that shows nothing
    // is worse than offering none: the menu says the subtitle is on.
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "Kepler.S02E04.eng.ass", language: "en", label: "English", renderable: false },
          ],
        },
      }),
      target,
    );
    expect(tracks).toEqual([]);
  });

  it("defaults the first English track, not the first track", () => {
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "a.spa.srt", language: "es", label: "Spanish", renderable: true },
            { index: 2, filename: "a.eng.srt", language: "en", label: "English", renderable: true },
          ],
        },
      }),
      target,
    );
    expect(tracks.map((t) => t.default)).toEqual([false, true]);
  });

  it("defaults nothing when no track is English", () => {
    // Turning on a language the user does not read is worse than turning on
    // nothing; the menu is one click away either way.
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "a.spa.srt", language: "es", label: "Spanish", renderable: true },
          ],
        },
      }),
      target,
    );
    expect(tracks.map((t) => t.default)).toEqual([false]);
  });

  it("returns nothing for a null info", () => {
    expect(subtitleTracks(null, target)).toEqual([]);
  });

  it("encodes the capability into every src", () => {
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [{ index: 1, filename: "a.srt", language: "", label: "a", renderable: true }],
        },
      }),
      { ...target, capability: "a b&c" },
    );
    expect(tracks[0]?.src).toBe("/stream/abc/1.vtt?k=a%20b%26c");
  });
});

describe("subtitleDownload", () => {
  // Exists because the .m3u no longer carries an input-slave line (VLC 3
  // refuses it as an unsafe option) — this is what a VLC user gets instead: a
  // link they can save and open by hand.
  it("points at the preferred renderable subtitle's .vtt handle", () => {
    const download = subtitleDownload(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "Kepler.S02E04.eng.srt", language: "en", label: "English", renderable: true },
          ],
        },
      }),
      target,
    );
    expect(download).toEqual({ label: "Download subtitle", href: "/stream/abc/1.vtt?k=cap" });
  });

  it("prefers the English file among several matches", () => {
    const download = subtitleDownload(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "a.spa.srt", language: "es", label: "Spanish", renderable: true },
            { index: 2, filename: "a.eng.srt", language: "en", label: "English", renderable: true },
          ],
        },
      }),
      target,
    );
    expect(download?.href).toBe("/stream/abc/2.vtt?k=cap");
  });

  it("ignores a non-renderable match", () => {
    // Same rule as subtitleTracks: an .ass/.ssa source run through the .vtt
    // route produces bytes valid as neither format, so it must not be offered.
    const download = subtitleDownload(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "Kepler.S02E04.eng.ass", language: "en", label: "English", renderable: false },
          ],
        },
      }),
      target,
    );
    expect(download).toBeNull();
  });

  it("returns null when nothing matched", () => {
    expect(subtitleDownload(info({}), target)).toBeNull();
  });

  it("returns null for a null info", () => {
    expect(subtitleDownload(null, target)).toBeNull();
  });
});

describe("subtitleErrorNotice", () => {
  it("names the language that failed", () => {
    const spec: TrackSpec = { src: "/stream/abc/1.vtt?k=cap", srclang: "en", label: "English", default: true };
    expect(subtitleErrorNotice(spec)).toBe(
      "English subtitles couldn't load — try another language or turn them off.",
    );
  });

  it("reads naturally when the label is empty, rather than stuttering", () => {
    const spec: TrackSpec = { src: "/stream/abc/1.vtt?k=cap", srclang: "", label: "", default: false };
    expect(subtitleErrorNotice(spec)).toBe(
      "Subtitles couldn't load — try another language or turn them off.",
    );
  });
});

describe("createTrackFailureTracker", () => {
  // A torrent can carry nine or ten subtitle files. If every one of them
  // failed, a straight one-notice-per-error wiring would produce nine or ten
  // toasts — which is its own way of drowning the user in noise instead of
  // silence. The tracker is what keeps that from reaching player.ts.
  const spec = (src: string, label: string): TrackSpec => ({ src, srclang: "en", label, default: false });

  it("reports the first failure of a track", () => {
    const tracker = createTrackFailureTracker();
    expect(tracker.report(spec("/stream/abc/1.vtt", "English"))).toBe(
      "English subtitles couldn't load — try another language or turn them off.",
    );
  });

  it("does not repeat a notice for the same track failing again", () => {
    // A retried fetch, or more than one `error` event for one selection, is
    // not new information — the user already has the answer.
    const tracker = createTrackFailureTracker();
    tracker.report(spec("/stream/abc/1.vtt", "English"));
    expect(tracker.report(spec("/stream/abc/1.vtt", "English"))).toBeNull();
  });

  it("still reports a different track failing", () => {
    // The user trying a second language after the first failed is a new
    // action with a new answer, not spam.
    const tracker = createTrackFailureTracker();
    tracker.report(spec("/stream/abc/1.vtt", "English"));
    expect(tracker.report(spec("/stream/abc/2.vtt", "Spanish"))).toBe(
      "Spanish subtitles couldn't load — try another language or turn them off.",
    );
  });

  it("does not report a track that never failed", () => {
    const tracker = createTrackFailureTracker();
    expect(tracker.report(spec("/stream/abc/1.vtt", "English"))).not.toBeNull();
    // sanity: a fresh tracker starts with nothing reported
    expect(createTrackFailureTracker().report(spec("/stream/abc/1.vtt", "English"))).not.toBeNull();
  });
});

describe("embeddedNotice", () => {
  it("names the languages muxed into the file", () => {
    // The line that turns the reported dead end into information: three tracks
    // were inside the file and nothing on screen said so.
    const notice = embeddedNotice(
      info({
        subtitles: {
          embedded: [
            { language: "spa", label: "" },
            { language: "eng", label: "" },
            { language: "por", label: "" },
          ],
          files: [],
        },
      }),
    );
    expect(notice).toBe(
      "Subtitles in this file: Spanish, English, Portuguese — pick one in your player.",
    );
  });

  it("counts untagged tracks rather than naming them", () => {
    const notice = embeddedNotice(
      info({ subtitles: { embedded: [{ language: "", label: "" }], files: [] } }),
    );
    expect(notice).toBe("This file has 1 subtitle track — pick it in your player.");
  });

  it("pluralises a count of untagged tracks", () => {
    const notice = embeddedNotice(
      info({
        subtitles: {
          embedded: [
            { language: "", label: "" },
            { language: "", label: "" },
          ],
          files: [],
        },
      }),
    );
    expect(notice).toContain("2 subtitle tracks");
  });

  it("says nothing when there are no embedded tracks", () => {
    expect(embeddedNotice(info({}))).toBe("");
  });

  it("says nothing for a null info", () => {
    expect(embeddedNotice(null)).toBe("");
  });
});
