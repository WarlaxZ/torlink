import { describe, it, expect } from "vitest";
import { parseRelease, hintForSection } from "./release";

describe("hintForSection", () => {
  it("maps sections to an OMDb medium", () => {
    expect(hintForSection("movies")).toBe("movie");
    expect(hintForSection("tv")).toBe("series");
    expect(hintForSection("all")).toBeUndefined();
  });
});

describe("parseRelease", () => {
  it("pulls a clean title and year out of a movie release", () => {
    const r = parseRelease("Weapons.2025.2160p.UHD.BluRay.x265-TERMINAL");
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Weapons");
    expect(r!.year).toBe(2025);
    expect(r!.type).toBe("movie"); // year, no season → movie
  });

  it("detects a series from season/episode markers", () => {
    const r = parseRelease("The.Bear.S01.1080p.WEB-DL.x264-GROUP");
    expect(r!.title).toBe("The Bear");
    expect(r!.type).toBe("series");
  });

  it("uses the section hint when the name has no season/year signal", () => {
    expect(parseRelease("Dune Part Two 1080p", "series")!.type).toBe("series");
    expect(parseRelease("Dune Part Two 1080p", "movie")!.type).toBe("movie");
    expect(parseRelease("Dune Part Two 1080p")!.type).toBeUndefined();
  });

  it("lets a parsed season override a movie hint", () => {
    expect(parseRelease("Chernobyl.S01E01.1080p", "movie")!.type).toBe("series");
  });

  it("returns null when no title can be parsed", () => {
    expect(parseRelease("")).toBeNull();
  });

  it("exposes a cache key that ignores quality/group noise", () => {
    const a = parseRelease("Weapons.2025.2160p.UHD.BluRay.x265-TERMINAL");
    const b = parseRelease("Weapons.2025.1080p.WEB-DL.x264-OTHER");
    expect(a!.key).toBe(b!.key); // same film → one OMDb lookup
  });
});
