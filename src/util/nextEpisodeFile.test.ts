import { describe, expect, it } from "vitest";
import { nextEpisodeIndex } from "./nextEpisodeFile";

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
