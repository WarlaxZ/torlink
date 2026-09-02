import { describe, it, expect } from "vitest";
import {
  SOURCES,
  enabledSources,
  sourcesByGroup,
  toggleDisabledSource,
  categoryForSource,
  isAdultSource,
  visibleWithAdultHistory,
  nonEmptyCategories,
} from "./registry";

// Adult sources are hidden unless the adult flag is passed, so the default
// enabled set is the non-adult subset.
const NON_ADULT = SOURCES.filter((s) => !s.adult);

describe("enabledSources", () => {
  it("returns every non-adult source when nothing is disabled", () => {
    expect(enabledSources([])).toEqual(NON_ADULT);
  });

  it("includes adult sources when adult content is enabled", () => {
    expect(enabledSources([], true)).toEqual([...SOURCES]);
    // At least one adult source exists and is otherwise hidden.
    expect(SOURCES.some((s) => s.adult)).toBe(true);
    expect(enabledSources([]).some((s) => s.adult)).toBe(false);
  });

  it("filters out disabled sources, preserving order", () => {
    const enabled = enabledSources(["yts", "nyaa"]);
    expect(enabled.some((s) => s.id === "yts")).toBe(false);
    expect(enabled.some((s) => s.id === "nyaa")).toBe(false);
    expect(enabled).toHaveLength(NON_ADULT.length - 2);
    // order matches the registry
    expect(enabled.map((s) => s.id)).toEqual(
      NON_ADULT.filter((s) => s.id !== "yts" && s.id !== "nyaa").map((s) => s.id),
    );
  });

  it("still hides adult sources even when they are not in the disabled list", () => {
    expect(enabledSources(["not-a-source" as never])).toEqual(NON_ADULT);
  });
});

describe("sourcesByGroup adult gating", () => {
  it("omits the Porn group unless adult content is enabled", () => {
    expect(sourcesByGroup().some((g) => g.group === "Porn")).toBe(false);
    const withAdult = sourcesByGroup(true);
    const porn = withAdult.find((g) => g.group === "Porn");
    expect(porn?.sources.map((s) => s.id)).toEqual(["tpb-porn", "x1337-porn"]);
    // Porn is ordered last.
    expect(withAdult.at(-1)?.group).toBe("Porn");
  });
});

describe("toggleDisabledSource", () => {
  it("adds a source that wasn't disabled", () => {
    expect(toggleDisabledSource([], "yts")).toEqual(["yts"]);
  });

  it("removes a source that was disabled", () => {
    expect(toggleDisabledSource(["yts", "nyaa"], "yts")).toEqual(["nyaa"]);
  });

  it("does not mutate the input", () => {
    const input = ["yts"] as const;
    toggleDisabledSource([...input], "nyaa");
    expect(input).toEqual(["yts"]);
  });
});

describe("categoryForSource", () => {
  it("returns the source's first group", () => {
    expect(categoryForSource("yts")).toBe("Movies");
    expect(categoryForSource("tpb-porn")).toBe("Porn");
    // bittorrented has multiple groups; the first is the documented pick.
    expect(categoryForSource("bittorrented")).toBe("Movies");
  });

  it("returns Unknown for an unrecognised or missing source id", () => {
    expect(categoryForSource("not-a-source" as never)).toBe("Unknown");
    expect(categoryForSource(undefined)).toBe("Unknown");
  });
});

describe("isAdultSource", () => {
  it("is true only for adult sources", () => {
    expect(isAdultSource("tpb-porn")).toBe(true);
    expect(isAdultSource("x1337-porn")).toBe(true);
    expect(isAdultSource("yts")).toBe(false);
  });

  it("treats an unrecognised or missing source id as non-adult", () => {
    expect(isAdultSource("not-a-source" as never)).toBe(false);
    expect(isAdultSource(undefined)).toBe(false);
  });
});

describe("visibleWithAdultHistory", () => {
  const items = [{ source: "yts" as const }, { source: "tpb-porn" as const }, { source: undefined }];

  it("drops adult items when the flag is off", () => {
    expect(visibleWithAdultHistory(items, false)).toEqual([
      { source: "yts" },
      { source: undefined },
    ]);
  });

  it("keeps every item when the flag is on", () => {
    expect(visibleWithAdultHistory(items, true)).toEqual(items);
  });

  it("does not mutate the input", () => {
    const input = [...items];
    visibleWithAdultHistory(input, false);
    expect(input).toEqual(items);
  });
});

describe("nonEmptyCategories", () => {
  it("always keeps All first, even with no items", () => {
    expect(nonEmptyCategories([])).toEqual(["All"]);
  });

  it("keeps only categories that are present, in fixed order", () => {
    expect(nonEmptyCategories(["Porn", "TV", "TV", "Movies"])).toEqual([
      "All",
      "Movies",
      "TV",
      "Porn",
    ]);
  });
});

describe("RuTracker sources", () => {
  it("includes the six RuTracker sources", () => {
    const ids = SOURCES.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(["rt-games", "rt-movies", "rt-tv", "rt-anime", "rt-music", "rt-books"]),
    );
    for (const s of SOURCES.filter((x) => x.id.startsWith("rt-"))) {
      expect(s.label).toBe("RuTracker");
    }
  });
});

describe("Books sources", () => {
  it("registers dedicated TPB, Nyaa, and RuTracker sources", () => {
    const books = SOURCES.filter((source) => source.groups?.includes("Books"));
    expect(books.map((source) => source.id)).toEqual([
      "tpb-books",
      "nyaa-literature",
      "rt-books",
    ]);
  });
});

describe("Music sources", () => {
  it("registers dedicated TPB and 1337x sources", () => {
    const music = SOURCES.filter((source) => source.groups?.includes("Music"));
    expect(music.map((source) => source.id)).toEqual([
      "tpb-music",
      "x1337-music",
      "rt-music",
    ]);
  });
});
