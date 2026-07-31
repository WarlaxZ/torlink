import { describe, expect, it } from "vitest";
import { parseRelease } from "./release";
import { groupKeyFor } from "./resultGroup";
import { historyKeyFor } from "./streamHistoryKey";
import { normaliseTitle } from "./titleKey";

/** The show segment of a group key: "harrowgate" out of "harrowgate|series|s3|e1". */
const showOfGroupKey = (name: string): string => {
  const key = groupKeyFor(name, "series");
  return key.slice(0, key.indexOf("|series|"));
};

describe("normaliseTitle", () => {
  it("strips a tracker prefix, a bracket tag, pack filler and a leading article", () => {
    expect(normaliseTitle("www.uindex.org - Harrowgate")).toBe("harrowgate");
    expect(normaliseTitle("[Judas] Harrowgate")).toBe("harrowgate");
    expect(normaliseTitle("Harrowgate Complete Series")).toBe("harrowgate");
    expect(normaliseTitle("The Harrowgate")).toBe("harrowgate");
  });

  it("never reduces a title to nothing", () => {
    expect(normaliseTitle("Series")).toBe("series");
    expect(normaliseTitle("(Ashfall)")).toBe("ashfall");
  });
});

describe("the history key and the group key agree on the show", () => {
  // Four of these six disagreed before this change. A drifted key does not
  // crash — it silently stops matching the row it is looking for, which is why
  // this is asserted producer-against-producer rather than against a literal.
  const NAMES = [
    "Harrowgate.S03E01.1080p.WEB-DL",
    "[Judas] Harrowgate S03E01 (1080p)",
    "www.uindex.org - Harrowgate.S03E01.1080p",
    "The.Harrowgate.S03E01.1080p.WEB-DL",
    "Harrowgate.S03.COMPLETE.SEASON.1080p",
    "Harrowgate.Complete.Series.S03E02.1080p",
  ];

  for (const name of NAMES) {
    it(`agrees for ${name}`, () => {
      const parsed = parseRelease(name, "series");
      expect(parsed).not.toBeNull();
      expect(historyKeyFor(parsed!)).toBe(`${showOfGroupKey(name)}|series`);
    });
  }

  it("still keys a film on title, year and type", () => {
    const parsed = parseRelease("Kestrel.2010.1080p.BluRay.x264");
    expect(historyKeyFor(parsed!)).toBe(parsed!.key);
  });
});
