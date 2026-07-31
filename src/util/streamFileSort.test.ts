import { describe, expect, it } from "vitest";
import { nextSort, sortStreamFiles } from "./streamFileSort";

const f = (filename: string, bytes = 1024) => ({ filename, bytes });

describe("sortStreamFiles", () => {
  // The reported bug: a season pack arrives in whatever order the torrent
  // happens to list its files, and the picker showed E08 above E02.
  it("puts episodes in episode order, whatever order the torrent listed them", () => {
    const files = [
      f("Harrowgate - S03E08 - The Long Way Down.mkv"),
      f("Harrowgate - S03E02 - Salt.mkv"),
      f("Harrowgate - S03E01 - Low Tide.mkv"),
      f("Harrowgate - S03E10 - Last Light.mkv"),
    ];
    expect(sortStreamFiles(files, "name").map((x) => x.filename)).toEqual([
      "Harrowgate - S03E01 - Low Tide.mkv",
      "Harrowgate - S03E02 - Salt.mkv",
      "Harrowgate - S03E08 - The Long Way Down.mkv",
      "Harrowgate - S03E10 - Last Light.mkv",
    ]);
  });

  // Numeric collation, not byte order: "10" after "2" — the whole reason the
  // compare passes `numeric: true`. Plain string order would put E10 second.
  it("collates numbers as numbers", () => {
    const files = [f("Bonus Gag Reel 10.mkv"), f("Bonus Gag Reel 2.mkv")];
    expect(sortStreamFiles(files, "name").map((x) => x.filename)).toEqual([
      "Bonus Gag Reel 2.mkv",
      "Bonus Gag Reel 10.mkv",
    ]);
  });

  // Case is not a sort key: sensitivity "base". A release that shouts one
  // filename should not have it float to the top.
  it("ignores case when ordering by title", () => {
    const files = [f("beta.mkv"), f("ALPHA.mkv")];
    expect(sortStreamFiles(files, "name").map((x) => x.filename)).toEqual([
      "ALPHA.mkv",
      "beta.mkv",
    ]);
  });

  // The names come out of a stranger's torrent, so they get cleanText's
  // treatment before being compared — otherwise a decorative glyph nobody can
  // see in the rendered row silently decides the order.
  it("compares the cleaned name, so junk glyphs do not decide the order", () => {
    const files = [f("Kestrel.2010.mkv"), f("\u{1f3ac} Ashfall.1999.mkv")];
    expect(sortStreamFiles(files, "name").map((x) => x.filename)).toEqual([
      "\u{1f3ac} Ashfall.1999.mkv",
      "Kestrel.2010.mkv",
    ]);
  });

  it("orders by size largest-first", () => {
    const files = [f("small.mkv", 10), f("big.mkv", 900), f("middling.mkv", 100)];
    expect(sortStreamFiles(files, "size").map((x) => x.filename)).toEqual([
      "big.mkv",
      "middling.mkv",
      "small.mkv",
    ]);
  });

  // Both callers hold the list they were given (the TUI keeps `files` to resolve
  // a preselect back to a row; the browser re-sorts the same array on toggle),
  // so sorting in place would corrupt the caller's own indexes.
  // Two modes, so the toggle both pickers offer is one rule rather than a `? :`
  // written once per surface.
  it("toggles between the two modes", () => {
    expect(nextSort("name")).toBe("size");
    expect(nextSort("size")).toBe("name");
  });

  it("does not mutate the caller's array", () => {
    const files = [f("b.mkv"), f("a.mkv")];
    const before = files.map((x) => x.filename);
    sortStreamFiles(files, "name");
    expect(files.map((x) => x.filename)).toEqual(before);
  });

  it("returns the caller's own element type, extras and all", () => {
    const files = [
      { filename: "b.mkv", bytes: 1, index: 7 },
      { filename: "a.mkv", bytes: 2, index: 3 },
    ];
    expect(sortStreamFiles(files, "name").map((x) => x.index)).toEqual([3, 7]);
  });
});
