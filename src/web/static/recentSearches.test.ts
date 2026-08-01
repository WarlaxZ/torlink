import { describe, expect, it } from "vitest";
import { RECENT_MAX, foldRecent, magnetFor, parseRecent } from "./recentSearches";

describe("foldRecent", () => {
  it("puts the newest first", () => {
    expect(foldRecent(["ashfall"], "kestrel")).toEqual(["kestrel", "ashfall"]);
  });

  /**
   * A query run every day would otherwise fill the whole strip with itself.
   * Moving it to the front is also what a user means by "recent".
   */
  it("moves a repeat to the front rather than adding a second copy", () => {
    expect(foldRecent(["ashfall", "kestrel", "kepler"], "kestrel")).toEqual([
      "kestrel",
      "ashfall",
      "kepler",
    ]);
  });

  it("treats a different casing as the same search, keeping the new spelling", () => {
    // Every source lowercases the query anyway, so two chips would be noise —
    // and what the user just typed is the spelling they want to see.
    expect(foldRecent(["kestrel"], "Kestrel")).toEqual(["Kestrel"]);
  });

  it("trims, so trailing whitespace does not create a near-duplicate", () => {
    expect(foldRecent(["kestrel"], "  kestrel  ")).toEqual(["kestrel"]);
    expect(foldRecent([], "  tin rivers ")).toEqual(["tin rivers"]);
  });

  /**
   * A blank query is browse mode — a real search, but not one worth
   * remembering: there is nothing to put on a chip and nothing to go back to.
   */
  it("ignores a blank query without disturbing the list", () => {
    expect(foldRecent(["kestrel"], "")).toEqual(["kestrel"]);
    expect(foldRecent(["kestrel"], "   ")).toEqual(["kestrel"]);
  });

  it("caps the list", () => {
    let list: string[] = [];
    for (let i = 0; i < RECENT_MAX + 4; i++) list = foldRecent(list, `q${i}`);
    expect(list).toHaveLength(RECENT_MAX);
    // The newest survive and the oldest fall off the end.
    expect(list[0]).toBe(`q${RECENT_MAX + 3}`);
    expect(list).not.toContain("q0");
  });

  it("does not mutate the list it was given", () => {
    const before = ["kestrel"];
    foldRecent(before, "ashfall");
    expect(before).toEqual(["kestrel"]);
  });
});

/**
 * localStorage is user-writable and survives upgrades, and every value here
 * becomes a chip's label. A chip built from a number or an object would render
 * as "[object Object]".
 */
describe("parseRecent", () => {
  it("reads a stored list", () => {
    expect(parseRecent('["kestrel","ashfall"]')).toEqual(["kestrel", "ashfall"]);
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["not JSON", "{oh no"],
    ["not an array", '{"a":1}'],
    ["a bare string", '"kestrel"'],
    ["a number", "42"],
  ])("falls back to empty for %s", (_why, raw) => {
    expect(parseRecent(raw)).toEqual([]);
  });

  it("drops entries that are not usable queries", () => {
    expect(parseRecent('["kestrel",1,null,{"a":1},"  ","ashfall"]')).toEqual([
      "kestrel",
      "ashfall",
    ]);
  });

  it("caps a hand-edited list that is too long", () => {
    const raw = JSON.stringify(Array.from({ length: 50 }, (_, i) => `q${i}`));
    expect(parseRecent(raw)).toHaveLength(RECENT_MAX);
  });
});

describe("magnetFor", () => {
  it("builds a hash-and-name magnet", () => {
    expect(magnetFor("a".repeat(40), "Kestrel.2010.1080p.BluRay.x264")).toBe(
      `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=Kestrel.2010.1080p.BluRay.x264`,
    );
  });

  /**
   * A release name is a stranger's string and this one is handed to another
   * application. Anything that could end the parameter early has to be encoded.
   */
  it("encodes a name with characters that would break the URL", () => {
    const magnet = magnetFor("b".repeat(40), "Tin Rivers & Co #1?x=2");
    expect(magnet).toContain("dn=Tin+Rivers+%26+Co+%231%3Fx%3D2");
    expect(magnet.split("&")).toHaveLength(2);
  });

  it("encodes the info hash too", () => {
    expect(magnetFor("../evil", "x")).toContain("btih:..%2Fevil");
  });
});
