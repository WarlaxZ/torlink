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
    const r = parseRelease("Tollgate.2025.2160p.UHD.BluRay.x265-TERMINAL");
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Tollgate");
    expect(r!.year).toBe(2025);
    expect(r!.type).toBe("movie"); // year, no season → movie
  });

  it("detects a series from season/episode markers", () => {
    const r = parseRelease("Harrowgate.S01.1080p.WEB-DL.x264-GROUP");
    expect(r!.title).toBe("Harrowgate");
    expect(r!.type).toBe("series");
  });

  it("uses the section hint when the name has no season/year signal", () => {
    expect(parseRelease("Tin Rivers 1080p", "series")!.type).toBe("series");
    expect(parseRelease("Tin Rivers 1080p", "movie")!.type).toBe("movie");
    expect(parseRelease("Tin Rivers 1080p")!.type).toBeUndefined();
  });

  it("lets a parsed season override a movie hint", () => {
    expect(parseRelease("Windmere.S01E01.1080p", "movie")!.type).toBe("series");
  });

  it("returns null when no title can be parsed", () => {
    expect(parseRelease("")).toBeNull();
  });

  it("exposes a cache key that ignores quality/group noise", () => {
    const a = parseRelease("Tollgate.2025.2160p.UHD.BluRay.x265-TERMINAL");
    const b = parseRelease("Tollgate.2025.1080p.WEB-DL.x264-OTHER");
    expect(a!.key).toBe(b!.key); // same film → one OMDb lookup
  });
});

describe("parseRelease — season and episode", () => {
  it("returns both for an episode release", () => {
    const p = parseRelease("Kepler.S02E04.1080p.WEB-DL.x265-GROUP");
    expect(p?.title).toBe("Kepler");
    expect(p?.season).toBe(2);
    expect(p?.episode).toBe(4);
  });

  it("returns season but NOT episode for a season pack", () => {
    // A pack names the season and no episode. The history store must not
    // invent episode 1 from this — see nextEpisode in Task 2.
    const p = parseRelease("Harrowgate.S03.1080p.WEB-DL");
    expect(p?.title).toBe("Harrowgate");
    expect(p?.season).toBe(3);
    expect(p?.episode).toBeUndefined();
  });

  it("returns neither for a film", () => {
    const p = parseRelease("Tin.Rivers.2024.2160p.BluRay");
    expect(p?.title).toBe("Tin Rivers");
    expect(p?.season).toBeUndefined();
    expect(p?.episode).toBeUndefined();
  });

  it("still classifies an episode release as a series", () => {
    // The existing isSeries behaviour must not regress: season/episode were
    // already being read for exactly this, they were just not returned.
    expect(parseRelease("Kepler.S02E04.1080p")?.type).toBe("series");
  });
});
