import { describe, expect, it } from "vitest";
import { nextEpisodeIndex, packTargetFor, type PackTarget } from "./nextEpisodeFile";

// The shape both front ends' file lists satisfy: Node's ResolvedFile and the
// browser's PublicStreamFile both carry a filename, which is all this reads.
const f = (filename: string) => ({ filename });

describe("nextEpisodeIndex", () => {
  it("picks the file whose name parses to the wanted season and episode", () => {
    const files = [
      f("Harrowgate.S03E04.1080p.WEB-DL.mkv"),
      f("Harrowgate.S03E05.1080p.WEB-DL.mkv"),
      f("Harrowgate.S03E06.1080p.WEB-DL.mkv"),
    ];
    expect(nextEpisodeIndex(files, { next: { season: 3, episode: 5 } })).toBe(1);
  });

  it("reads the episode out of a path, not just a bare release name", () => {
    // What a season pack actually looks like on disk: every file nested under a
    // directory named for the pack.
    const files = [
      f("Harrowgate.S03/Harrowgate.S03E04.1080p.mkv"),
      f("Harrowgate.S03/Harrowgate.S03E05.1080p.mkv"),
    ];
    expect(nextEpisodeIndex(files, { next: { season: 3, episode: 5 } })).toBe(1);
  });

  it("falls back to the directory when the basename alone names nothing", () => {
    const files = [f("Harrowgate.S03E04/video.mkv"), f("Harrowgate.S03E05/video.mkv")];
    expect(nextEpisodeIndex(files, { next: { season: 3, episode: 5 } })).toBe(1);
  });

  // The layout the doc comment's "basename first" promise is about, with more
  // than one file per folder — which is what a scene season pack actually ships.
  // Read per-file (basename then folder, one file at a time) the folder-derived
  // match on `sample.mkv` wins, and the picker moves the cursor OFF the episode
  // the title sort had already put first. Basename-first has to be two passes
  // over the whole list, not one pass over both spellings.
  it("prefers a basename match anywhere in the list over an earlier folder match", () => {
    const files = [
      f("Harrowgate.S03E05/sample.mkv"),
      f("Harrowgate.S03E05/Harrowgate.S03E05.1080p.mkv"),
    ];
    expect(nextEpisodeIndex(files, { next: { season: 3, episode: 5 } })).toBe(1);
  });

  // The other half of the same bug, on the other code path: the wanted episode
  // is simply not in this pack, so the watched fallback fires — and "the first
  // file you haven't watched" in torrent order is `sample.mkv`. A file that
  // names SOME episode is a better guess than one that names none.
  it("skips a file that names no episode at all when falling back on watched", () => {
    const files = [
      f("sample.mkv"),
      f("Harrowgate.S03E01.mkv"),
      f("Harrowgate.S03E04.mkv"),
    ];
    expect(
      nextEpisodeIndex(files, {
        next: { season: 3, episode: 5 },
        watched: ["Harrowgate.S03E04.mkv"],
      }),
    ).toBe(1);
    // Same list, no wanted episode at all: the fallback is the only signal
    // there is, and it must not hand back the sample either.
    expect(
      nextEpisodeIndex(files, { next: null, watched: ["Harrowgate.S03E04.mkv"] }),
    ).toBe(1);
  });

  // The fallback still fires when NOTHING parses. `watched` and `next` are
  // independent signals: the wanted episode being absent from the pack says
  // nothing about whether the watched list is informative, and a picker that
  // opened on `video1.mkv` here would sit on a file the user has watched — the
  // bug this whole feature exists to fix.
  it("falls back on watched even when a wanted episode was named", () => {
    const files = [f("video1.mkv"), f("video2.mkv"), f("video3.mkv")];
    expect(
      nextEpisodeIndex(files, {
        next: { season: 3, episode: 5 },
        watched: ["video1.mkv"],
      }),
    ).toBe(1);
  });

  it("handles Windows separators", () => {
    const files = [f("Kepler.S02\\Kepler.S02E04.mkv"), f("Kepler.S02\\Kepler.S02E05.mkv")];
    expect(nextEpisodeIndex(files, { next: { season: 2, episode: 5 } })).toBe(1);
  });

  it("does not match the right episode of the wrong season", () => {
    const files = [f("Kepler.S02E05.1080p.mkv"), f("Kepler.S01E05.1080p.mkv")];
    expect(nextEpisodeIndex(files, { next: { season: 3, episode: 5 } })).toBeNull();
  });

  // "next" is a suggestion, never a claim the episode exists — a pack that stops
  // at E04 is normal, and the picker must then behave exactly as it always has.
  it("has no opinion when nothing matches and nothing is watched", () => {
    const files = [f("Harrowgate.S03E01.mkv"), f("Harrowgate.S03E02.mkv")];
    expect(nextEpisodeIndex(files, { next: { season: 3, episode: 9 } })).toBeNull();
  });

  // A film, and a season pack with no episode number, both arrive here as a null
  // `next` — that judgement is nextEpisode's (src/core/streamHistory.ts) and is
  // deliberately not re-derived here.
  it("has no opinion when there is no next episode at all", () => {
    const files = [f("Kestrel.2010.1080p.BluRay.x264.mkv"), f("sample.mkv")];
    expect(nextEpisodeIndex(files, { next: null })).toBeNull();
    expect(nextEpisodeIndex(files, {})).toBeNull();
  });

  it("falls back to the first file not in the watched list", () => {
    const files = [f("Harrowgate.S03E01.mkv"), f("Harrowgate.S03E02.mkv")];
    expect(
      nextEpisodeIndex(files, { next: null, watched: ["Harrowgate.S03E01.mkv"] }),
    ).toBe(1);
  });

  it("prefers a parsed match over the watched fallback", () => {
    const files = [f("Harrowgate.S03E01.mkv"), f("Harrowgate.S03E05.mkv")];
    // The watched list would point at index 1 too, so make them disagree: mark
    // the wanted episode's neighbour watched and put the wanted one last.
    const files2 = [f("Harrowgate.S03E01.mkv"), f("Harrowgate.S03E02.mkv"), f("Harrowgate.S03E05.mkv")];
    expect(nextEpisodeIndex(files, { next: { season: 3, episode: 5 } })).toBe(1);
    expect(
      nextEpisodeIndex(files2, {
        next: { season: 3, episode: 5 },
        watched: ["Harrowgate.S03E01.mkv"],
      }),
    ).toBe(2);
  });

  it("has no opinion when every file is already watched", () => {
    const files = [f("Harrowgate.S03E01.mkv"), f("Harrowgate.S03E02.mkv")];
    expect(
      nextEpisodeIndex(files, {
        next: null,
        watched: ["Harrowgate.S03E01.mkv", "Harrowgate.S03E02.mkv"],
      }),
    ).toBeNull();
  });

  // Filenames come from whoever uploaded the torrent, so "parses to nothing" is
  // an ordinary input, not an error.
  it("survives names that parse to nothing", () => {
    const files = [f(""), f("1080p.mkv"), f("...."), f("Harrowgate.S03E05.mkv")];
    expect(nextEpisodeIndex(files, { next: { season: 3, episode: 5 } })).toBe(3);
    expect(nextEpisodeIndex([f("....")], { next: { season: 3, episode: 5 } })).toBeNull();
  });

  it("has no opinion about an empty list", () => {
    expect(nextEpisodeIndex([], { next: { season: 3, episode: 5 } })).toBeNull();
  });
});

describe("packTargetFor", () => {
  it("returns the pending episode when it was set for this infohash", () => {
    const pending: PackTarget = { infoHash: "abc", next: { season: 3, episode: 5 } };
    expect(packTargetFor(pending, "abc")).toEqual({ season: 3, episode: 5 });
  });

  it("returns null for a torrent the target was not set for — the stale case", () => {
    const pending: PackTarget = { infoHash: "abc", next: { season: 3, episode: 5 } };
    expect(packTargetFor(pending, "xyz")).toBeNull();
  });

  it("returns null when nothing is pending", () => {
    expect(packTargetFor(null, "abc")).toBeNull();
  });

  // The composed behaviour `openStreamPicker` actually relies on:
  // `packTargetFor(...) ?? (recorded ? nextEpisode(recorded) : null)`. A match
  // on `packTargetFor` alone proves the lookup, not the fallback — this proves
  // a picker opened for a DIFFERENT torrent than the one auto-play set the
  // target for lands on the history row's own suggestion instead, and that the
  // two answers are genuinely different positions, not the same file twice.
  it("composed with nextEpisode: a stale target falls back to the recorded row's own suggestion", () => {
    const pending: PackTarget = { infoHash: "abc", next: { season: 3, episode: 2 } };
    const recordedNext = { season: 3, episode: 5 };
    const files = [
      f("Harrowgate.S03E02.1080p.WEB-DL.mkv"),
      f("Harrowgate.S03E04.1080p.WEB-DL.mkv"),
      f("Harrowgate.S03E05.1080p.WEB-DL.mkv"),
    ];

    // Matched hash: the picker opens on the pack's own target, S03E02.
    const matched = nextEpisodeIndex(files, { next: packTargetFor(pending, "abc") ?? recordedNext });
    expect(matched).toBe(0);

    // Mismatched hash: this picker is for a different torrent, so the stale
    // target is discarded and the recorded row's suggestion (S03E05) is used.
    const stale = nextEpisodeIndex(files, { next: packTargetFor(pending, "xyz") ?? recordedNext });
    expect(stale).toBe(2);

    expect(matched).not.toBe(stale);
  });
});
