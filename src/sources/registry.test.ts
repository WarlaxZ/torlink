import { describe, it, expect } from "vitest";
import { SOURCES, enabledSources, toggleDisabledSource } from "./registry";

describe("enabledSources", () => {
  it("returns every source when nothing is disabled", () => {
    expect(enabledSources([])).toEqual([...SOURCES]);
  });

  it("filters out disabled sources, preserving order", () => {
    const enabled = enabledSources(["yts", "nyaa"]);
    expect(enabled.some((s) => s.id === "yts")).toBe(false);
    expect(enabled.some((s) => s.id === "nyaa")).toBe(false);
    expect(enabled).toHaveLength(SOURCES.length - 2);
    // order matches the registry
    expect(enabled.map((s) => s.id)).toEqual(
      SOURCES.filter((s) => s.id !== "yts" && s.id !== "nyaa").map((s) => s.id),
    );
  });

  it("ignores unknown ids in the disabled list", () => {
    expect(enabledSources(["not-a-source" as never])).toEqual([...SOURCES]);
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
    const books = SOURCES.filter((source) => source.group === "Books");
    expect(books.map((source) => source.id)).toEqual([
      "tpb-books",
      "nyaa-literature",
      "rt-books",
    ]);
  });
});

describe("Music sources", () => {
  it("registers dedicated TPB and 1337x sources", () => {
    const music = SOURCES.filter((source) => source.group === "Music");
    expect(music.map((source) => source.id)).toEqual([
      "tpb-music",
      "x1337-music",
      "rt-music",
    ]);
  });
});
