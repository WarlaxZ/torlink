import { describe, expect, it } from "vitest";
import { breadcrumbFor, upNextView } from "./upNext";
import type { PublicStreamFile, StreamFilesResponse } from "../wire";

const SID = "sid-1";
const CAP = "cap-1";

function file(index: number, filename: string, bytes = 1024 ** 3): PublicStreamFile {
  return { filename, bytes, index, handle: `/stream/${SID}/${index}` };
}

/** A season pack whose files arrive in the order the torrent happened to name them. */
const HARROWGATE: StreamFilesResponse = {
  name: "Harrowgate.S03.1080p.WEB-DL",
  infoHash: "a".repeat(40),
  files: [
    file(0, "Harrowgate.S03E03.1080p.WEB-DL.mkv"),
    file(1, "Harrowgate.S03E01.1080p.WEB-DL.mkv"),
    file(3, "Harrowgate.S03E02.1080p.WEB-DL.mkv"),
  ],
};

/** Two seasons in one torrent — the case a flat list would render as a wall. */
const KEPLER: StreamFilesResponse = {
  name: "Kepler.S01-S02.1080p.WEB-DL",
  infoHash: "a".repeat(40),
  files: [
    file(0, "Kepler.S01E01.1080p.WEB-DL.mkv"),
    file(1, "Kepler.S01E02.1080p.WEB-DL.mkv"),
    file(2, "Kepler.S02E01.1080p.WEB-DL.mkv"),
    file(3, "Kepler.S02E02.1080p.WEB-DL.mkv"),
  ],
};

const KESTREL: StreamFilesResponse = {
  name: "Kestrel.2010.1080p.BluRay.x264",
  infoHash: "a".repeat(40),
  files: [file(0, "Kestrel.2010.1080p.BluRay.x264.mkv")],
};

describe("upNextView — the rest-of-season button", () => {
  it("offers the season by name from an episode with more to come", () => {
    expect(upNextView(HARROWGATE, SID, 1, CAP).restLabel).toBe("Download rest of season .m3u");
  });

  /**
   * From the last episode there is a next FILE in some torrents (an extra) but no
   * rest of the season, and a playlist of one file is the button already at the
   * top of the page. This is why the test is `restPlaylist`'s answer and not
   * "is there a next row".
   */
  it("offers nothing from the last episode of a season", () => {
    // Session index 0 is E03, which sorts last.
    expect(upNextView(HARROWGATE, SID, 0, CAP).restLabel).toBeNull();
  });

  /**
   * An extra has no season to be the rest of. The playlist still means something
   * — everything from here — so the label says that rather than promising a
   * season it will not deliver. `Harrowgate.Trailer.mkv` sorts after the
   * episodes, so there really is something after it to include.
   */
  it("does not call an extra's playlist a season", () => {
    const withExtra: StreamFilesResponse = {
      ...HARROWGATE,
      files: [file(4, "Harrowgate.Bonus_Gag_Reel_1.mkv"), ...HARROWGATE.files],
    };
    expect(upNextView(withExtra, SID, 4, CAP).restLabel).toBe("Download the rest as .m3u");
  });

  it("offers nothing for a film", () => {
    expect(upNextView(KESTREL, SID, 0, CAP).restLabel).toBeNull();
  });
});

describe("upNextView — the list", () => {
  it("orders the files the way the picker does, not the way the torrent did", () => {
    const view = upNextView(HARROWGATE, SID, 0, CAP);
    expect(view.rows.map((r) => r.file.filename)).toEqual([
      "Harrowgate.S03E01.1080p.WEB-DL.mkv",
      "Harrowgate.S03E02.1080p.WEB-DL.mkv",
      "Harrowgate.S03E03.1080p.WEB-DL.mkv",
    ]);
  });

  it("keeps each file's SESSION index, not its position in the list", () => {
    // The .files response has already dropped a .nfo, so these are 1, 3, 0 —
    // and a row that used its list position would play a different episode.
    expect(upNextView(HARROWGATE, SID, 0, CAP).rows.map((r) => r.file.index)).toEqual([1, 3, 0]);
  });

  it("links each row at the player page for that file", () => {
    const [first] = upNextView(HARROWGATE, SID, 0, CAP).rows;
    // playerPath's URL, not a second spelling of it — the `:sid` encoding is
    // written in three places already and they have to agree.
    expect(first?.href).toBe(`/play/${SID}/1?k=${CAP}&n=Harrowgate.S03E01.1080p.WEB-DL.mkv`);
  });

  it("marks exactly the file the page is for", () => {
    const view = upNextView(HARROWGATE, SID, 3, CAP);
    expect(view.rows.filter((r) => r.current).map((r) => r.file.index)).toEqual([3]);
  });

  it("labels rows the way the picker labels them", () => {
    const [first] = upNextView(HARROWGATE, SID, 0, CAP).rows;
    // fileLabel's format, not a second one: the picker and this page have to
    // read identically or they look like different lists of different things.
    expect(first?.label).toBe("Harrowgate.S03E01.1080p.WEB-DL.mkv · 1.00 GB");
  });

  /**
   * A film has nothing to list, and an "all episodes" heading over one row that
   * is the row you are already on is noise. Empty rows means "render nothing".
   */
  it("has no rows for a single-file session", () => {
    const view = upNextView(KESTREL, SID, 0, CAP);
    expect(view.rows).toEqual([]);
    expect(view.next).toBeNull();
  });

  it("survives an index that names no file in the list", () => {
    // A hand-edited URL, or a `.nfo` index that the video filter removed.
    const view = upNextView(HARROWGATE, SID, 99, CAP);
    expect(view.rows.some((r) => r.current)).toBe(false);
    expect(view.next).toBeNull();
  });
});

describe("upNextView — season headings", () => {
  /**
   * THE TEST THAT PINS THE DECISION. A flat list and a season-grouped list are
   * indistinguishable on a single-season pack, so without a multi-season case
   * the suite would pass whichever was built.
   */
  it("heads each season exactly once, at its first episode", () => {
    const rows = upNextView(KEPLER, SID, 0, CAP).rows;
    expect(rows.map((r) => r.heading)).toEqual(["Season 1", null, "Season 2", null]);
  });

  it("puts no heading on a pack that is all one season", () => {
    expect(upNextView(HARROWGATE, SID, 0, CAP).rows.map((r) => r.heading)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("puts no heading on files that name no season at all", () => {
    const parts: StreamFilesResponse = {
      name: "Kestrel.2010.1080p.BluRay.x264",
      infoHash: "a".repeat(40),
      files: [file(0, "Kestrel.part1.mkv"), file(1, "Kestrel.part2.mkv")],
    };
    expect(upNextView(parts, SID, 0, CAP).rows.map((r) => r.heading)).toEqual([null, null]);
  });
});

describe("upNextView — what is next", () => {
  /**
   * "The next file after this one, in the order shown." Not "the next unwatched
   * episode": the user has just played the current file, which is a fact this
   * page has and a picker opening cold does not, so there is nothing to infer.
   */
  it("is the row after the current one in display order", () => {
    // Session index 1 is E01, which sorts first — so next is E02, index 3.
    expect(upNextView(HARROWGATE, SID, 1, CAP).next?.file.index).toBe(3);
  });

  it("crosses a season boundary", () => {
    expect(upNextView(KEPLER, SID, 1, CAP).next?.file.filename).toBe(
      "Kepler.S02E01.1080p.WEB-DL.mkv",
    );
  });

  it("is null on the last episode", () => {
    // Session index 0 is E03, which sorts last.
    expect(upNextView(HARROWGATE, SID, 0, CAP).next).toBeNull();
  });

  it("is one of the rows, not a copy of one", () => {
    const view = upNextView(HARROWGATE, SID, 1, CAP);
    expect(view.rows).toContain(view.next);
  });
});

describe("upNextView — the breadcrumb", () => {
  it("names the show and links to a search for it", () => {
    const crumb = upNextView(HARROWGATE, SID, 0, CAP).breadcrumb;
    expect(crumb?.label).toBe("Harrowgate");
    expect(crumb?.href).toBe("/?q=Harrowgate&group=TV");
  });

  it("sends a film to the Movies tab", () => {
    const crumb = upNextView(KESTREL, SID, 0, CAP).breadcrumb;
    expect(crumb?.label).toBe("Kestrel");
    expect(crumb?.href).toBe("/?q=Kestrel&group=Movies");
  });

  /**
   * The breadcrumb is the escape hatch that works with no history to go back
   * through — a bookmarked player URL, a link opened in a new tab. It must
   * never be the only thing missing in exactly that case, so an unparseable
   * release name falls back to the dashboard rather than to nothing.
   */
  it("falls back to the dashboard when the name parses to nothing", () => {
    const odd: StreamFilesResponse = {
      name: "   ",
      infoHash: "a".repeat(40),
      files: [file(0, "a.mkv"), file(1, "b.mkv")],
    };
    const crumb = upNextView(odd, SID, 0, CAP).breadcrumb;
    expect(crumb?.href).toBe("/");
    expect(crumb?.label).toBe("torlnk");
  });

  /**
   * The player page renders the breadcrumb from `?n=` before it fetches
   * anything, so that a session the registry has already reaped — which cannot
   * play, cannot list its files, and cannot say why — still offers a way out.
   * A breadcrumb that only worked off the `.files` response would be missing in
   * exactly that case.
   */
  it("works from one episode's filename, not just the session name", () => {
    expect(breadcrumbFor("Harrowgate.S03E02.1080p.WEB-DL.mkv")).toEqual({
      label: "Harrowgate",
      href: "/?q=Harrowgate&group=TV",
    });
    expect(breadcrumbFor("Kestrel.2010.1080p.BluRay.x264.mkv")).toEqual({
      label: "Kestrel",
      href: "/?q=Kestrel&group=Movies",
    });
  });

  it("falls back to the dashboard for a filename that parses to nothing", () => {
    expect(breadcrumbFor("").href).toBe("/");
    expect(breadcrumbFor("   ").href).toBe("/");
  });

  /**
   * A bare filename with no year and no episode still yields a search, on the
   * All tab. It is a poor query, and it is deliberately not special-cased:
   * "is this title meaningful?" has no rule that would not also throw away
   * one-word titles like Kestrel and Ashfall.
   */
  it("searches for a bare name rather than giving up on it", () => {
    expect(breadcrumbFor("video.mkv")).toEqual({ label: "video", href: "/?q=video" });
  });

  it("encodes a title that needs it", () => {
    const two: StreamFilesResponse = {
      name: "Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP",
      infoHash: "a".repeat(40),
      files: [file(0, "Tin.Rivers.2024.2160p.mkv")],
    };
    expect(upNextView(two, SID, 0, CAP).breadcrumb?.href).toBe("/?q=Tin+Rivers&group=Movies");
  });
});
