import { describe, expect, it } from "vitest";
import { embeddedNotice, subtitleTracks } from "./subtitleModel";
import type { PlayerTarget } from "./playerModel";
import type { StreamInfoResponse } from "../wire";

const target: PlayerTarget = { sid: "abc", index: 0, capability: "cap", filename: "Kepler.S02E04.mkv" };

const info = (over: Partial<StreamInfoResponse>): StreamInfoResponse => ({
  facts: { container: "mkv", videoCodec: "h264", audioCodec: "aac", source: "probe", subtitles: [] },
  blockers: [],
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
