import { describe, expect, it } from "vitest";
import { restPlaylist, type IndexedFile } from "./restPlaylist";

function file(index: number, filename: string, bytes = 1024 ** 3): IndexedFile {
  return { index, filename, bytes };
}

/**
 * A season pack shaped like the one that prompted this: episodes named out of
 * order, extras that name no episode, and a `.nfo` the picker already drops.
 *
 * TWO extras, and the difference between them is what makes these tests mean
 * anything. `Bonus_Gag_Reel_1` sorts BEFORE the episodes (`S03/` beats `S03E01`
 * under numeric collation), so a playlist starting at an episode would never
 * reach it however the filter behaved — an assertion about it alone would pass
 * without this module existing. `Harrowgate.Trailer.mkv` sorts AFTER all three
 * episodes, so only the season filter keeps it out.
 */
const PACK: IndexedFile[] = [
  file(0, "Harrowgate.S03E03.1080p.WEB-DL.mkv"),
  file(1, "Harrowgate.S03E01.1080p.WEB-DL.mkv"),
  file(2, "Harrowgate.S03/readme.nfo"),
  file(3, "Harrowgate.S03E02.1080p.WEB-DL.mkv"),
  file(4, "Harrowgate.S03/Bonus_Gag_Reel_1.mkv"),
  file(5, "Harrowgate.Trailer.mkv"),
];

describe("restPlaylist", () => {
  it("from an episode, plays the rest of that season", () => {
    expect(restPlaylist(PACK, 1)).toEqual({ kind: "season", indexes: [1, 3, 0] });
  });

  /**
   * THE BUG. Started from an episode, the old rule was "every later file in name
   * order", which swept the extras into the season playlist.
   *
   * Index 5 is the trailer, which sorts AFTER all three episodes — so this fails
   * under the old rule rather than passing by accident of the ordering. Index 4
   * is asserted too, but only the trailer proves the filter runs.
   */
  it("leaves out an extra that names no episode", () => {
    const { indexes } = restPlaylist(PACK, 1);
    expect(indexes).not.toContain(5);
    expect(indexes).not.toContain(4);
  });

  it("leaves out the non-video files the picker leaves out", () => {
    expect(restPlaylist(PACK, 1).indexes).not.toContain(2);
  });

  it("is one entry from the last episode of a season", () => {
    // Session index 0 is E03, which sorts last of the three episodes.
    expect(restPlaylist(PACK, 0)).toEqual({ kind: "season", indexes: [0] });
  });

  /**
   * From a bonus feature there is no season to be the rest of, so the meaning
   * falls back to "everything from here" — and the caller labels it that way.
   */
  it("from a bonus feature, takes everything from there on", () => {
    const out = restPlaylist(PACK, 4);
    expect(out.kind).toBe("everything");
    expect(out.indexes[0]).toBe(4);
    // It sorts first, so "everything from here" really is everything playable.
    expect(out.indexes).toEqual([4, 1, 3, 0, 5]);
  });

  it("stops at the season boundary in a multi-season pack", () => {
    const two: IndexedFile[] = [
      file(0, "Kepler.S01E01.1080p.WEB-DL.mkv"),
      file(1, "Kepler.S01E02.1080p.WEB-DL.mkv"),
      file(2, "Kepler.S02E01.1080p.WEB-DL.mkv"),
    ];
    expect(restPlaylist(two, 0)).toEqual({ kind: "season", indexes: [0, 1] });
  });

  it("is a single entry for a film", () => {
    const film = [file(0, "Kestrel.2010.1080p.BluRay.x264.mkv")];
    expect(restPlaylist(film, 0)).toEqual({ kind: "everything", indexes: [0] });
  });

  /**
   * A file that names a season but no episode is not an episode, so there is no
   * season to continue — the same branch a bonus feature takes.
   */
  it("treats a file naming a season but no episode as everything", () => {
    const pack = [
      file(0, "Harrowgate.S03.1080p.WEB-DL.mkv"),
      file(1, "Harrowgate.S03.extras.mkv"),
    ];
    expect(restPlaylist(pack, 0).kind).toBe("everything");
  });

  it("falls back to just that index when it names no candidate", () => {
    expect(restPlaylist(PACK, 99)).toEqual({ kind: "everything", indexes: [99] });
    // The .nfo is not a candidate, so asking for it is the same case.
    expect(restPlaylist(PACK, 2)).toEqual({ kind: "everything", indexes: [2] });
  });

  /**
   * RECORDED CHOICE, not an oversight: an extra that poses as an episode stays
   * in. Deduplicating by episode number would drop it — and would equally drop
   * `S03E02.Part2` next to `S03E02.Part1`, which loses half an episode to tidy up
   * a duplicate. Including one extra is the cheaper mistake.
   */
  it("keeps an extra that names an episode of its own", () => {
    const posing: IndexedFile[] = [
      file(0, "Harrowgate.S03E01.1080p.WEB-DL.mkv"),
      file(1, "Harrowgate.S03E02.1080p.WEB-DL.mkv"),
      file(2, "Harrowgate.S03E02.Deleted.Scenes.mkv"),
    ];
    expect(restPlaylist(posing, 0).indexes).toEqual([0, 1, 2]);
  });
});
