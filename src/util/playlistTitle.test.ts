import { describe, expect, it } from "vitest";
import { playlistTitle } from "./playlistTitle";

describe("playlistTitle", () => {
  it("names an episode by its show and tag, without the release junk", () => {
    expect(playlistTitle("Harrowgate.S03E01.1080p.WEB-DL.mkv")).toBe("Harrowgate S03E01");
  });

  /**
   * The Sonarr/Plex shape, which is the one that actually carries an episode
   * name. The spaced dash is what marks it as a name rather than release junk.
   */
  it("keeps a spaced-dash episode name", () => {
    expect(
      playlistTitle("Kepler (2019) - S02E04 - Ashfall Rising (1080p BluRay x265 GROUP).mkv"),
    ).toBe("Kepler S02E04 · Ashfall Rising");
  });

  it("does not mistake dot-delimited junk for an episode name", () => {
    const title = playlistTitle("Kepler.S02E04.1080p.WEB-DL.mkv");
    expect(title).toBe("Kepler S02E04");
    expect(title).not.toContain("1080p");
  });

  it("carries a multi-episode tag whole", () => {
    expect(playlistTitle("Harrowgate.S03E01E02.1080p.WEB-DL.mkv")).toBe("Harrowgate S03E01E02");
  });

  it("names a film by title and year", () => {
    expect(playlistTitle("Kestrel.2010.1080p.BluRay.x264.mkv")).toBe("Kestrel 2010");
  });

  it("names a season pack that commits to no episode by its title", () => {
    expect(playlistTitle("Harrowgate.S03.1080p.WEB-DL.mkv")).toBe("Harrowgate");
  });

  /**
   * The case that started this: a bonus feature in a season pack. The directory
   * is dropped — a playlist row reading "Harrowgate.S03/" tells you nothing —
   * and the underscores become spaces.
   */
  it("reads a bonus feature as its own name, without the directory", () => {
    const title = playlistTitle("Harrowgate.S03/Bonus_Gag_Reel_1.mkv");
    expect(title).toBe("Bonus Gag Reel 1");
    expect(title).not.toContain("/");
  });

  /**
   * THE SECURITY CASE. A filename comes from whoever made the torrent, and this
   * string is written into a file another application parses line by line. A
   * newline would let it ADD AN ENTRY pointing anywhere it liked.
   */
  it("strips every character that could add or forge a line", () => {
    const title = playlistTitle("evil\r\nhttp://attacker.example/x\nmore.mkv");
    expect(title).not.toContain("\n");
    expect(title).not.toContain("\r");
  });

  it("cannot pose as a playlist directive", () => {
    expect(playlistTitle("#EXTINF:-1,nope.mkv").startsWith("#")).toBe(false);
  });

  // C1 as well as C0: a terminal escape or a stray U+009F is no more welcome in a
  // file another application parses line by line than a newline is.
  it("strips control characters", () => {
    expect(playlistTitle("a\u0007b\u009fc.mkv")).toBe("abc");
  });

  it("caps the length", () => {
    expect(playlistTitle(`${"a".repeat(300)}.mkv`).length).toBe(120);
  });

  it("keeps commas, which #EXTINF allows after the first one", () => {
    expect(playlistTitle("Kepler (2019) - S02E04 - Ashfall, Rising.mkv")).toBe(
      "Kepler S02E04 · Ashfall, Rising",
    );
  });

  it("never returns an empty title", () => {
    for (const name of ["", ".mkv", "###", " ", "\u0000\u0001"]) {
      expect(playlistTitle(name)).toBe("stream");
    }
  });
});
