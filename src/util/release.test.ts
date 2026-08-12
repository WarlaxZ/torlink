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

  it("returns null when the name is only quality/codec/source noise", () => {
    // parse-torrent-title always returns *some* title, even for these — it
    // leaves the residual token it could not classify ("1080p", "x264", "WEB").
    // None of that is a title worth looking up.
    expect(parseRelease("1080p.WEB-DL.x265")).toBeNull();
    expect(parseRelease("2160p")).toBeNull();
    expect(parseRelease("x264-GROUP")).toBeNull();
    expect(parseRelease("WEB-DL")).toBeNull();
  });

  it("keeps a short real title that is a substring of a metadata token", () => {
    // "up" is inside "group". Concatenating the metadata and substring-matching
    // dropped this film entirely.
    const r = parseRelease("Up.2009.1080p.BluRay.x264-GROUP");
    expect(r?.title).toBe("Up");
    expect(r?.year).toBe(2009);
  });

  it("keeps other short titles that brush against metadata", () => {
    expect(parseRelease("Us.2019.1080p.WEB-DL-GROUP")?.title).toBe("Us");
    expect(parseRelease("Her.2013.1080p.BluRay-RARBG")?.title).toBe("Her");
  });

  it("returns null when the title is only a boolean flag word", () => {
    // parse-torrent-title represents some flags as booleans, not strings
    // ("PROPER" -> {proper: true, title: "PROPER"}), so they never reach the
    // string/array token harvest unless the boolean keys are folded in too.
    expect(parseRelease("PROPER")).toBeNull();
    expect(parseRelease("REPACK")).toBeNull();
    expect(parseRelease("REMUX")).toBeNull();
    expect(parseRelease("PROPER.1080p")).toBeNull();
    expect(parseRelease("REPACK.1080p.WEB-DL")).toBeNull();
  });

  it("keeps a real title that merely contains a flag word", () => {
    // "proper" is a recognised boolean flag, but "lady" is not, so the title
    // is not wholly accounted for by parser metadata.
    expect(parseRelease("Proper.Lady.2011.1080p.BluRay")?.title).toBe("Proper Lady");
  });

  it("still parses a real title that itself contains a resolution-like token", () => {
    // The noise check must not over-fire on a genuine title just because a
    // recognised token (here "1080p") also appears in the release name.
    const r = parseRelease("Kepler.S02E04.1080p.WEB-DL.x265-GROUP");
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Kepler");
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

describe("parseRelease quality fields", () => {
  it("exposes resolution, colour, audio, channels and group features", () => {
    const p = parseRelease("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP");
    expect(p?.resolution).toBe("2160p");
    expect(p?.colorList).toEqual(expect.arrayContaining(["HDR", "DV"]));
    expect(p?.audioList).toEqual(expect.arrayContaining(["atmos"]));
    expect(p?.channels).toBe(7.1);
  });

  it("exposes codec", () => {
    expect(parseRelease("Kestrel.2010.1080p.BluRay.x264")?.codec).toBe("x264");
  });

  it("leaves quality fields undefined when the name states none", () => {
    const p = parseRelease("Ashfall.1999.1080p");
    expect(p?.resolution).toBe("1080p");
    expect(p?.codec).toBeUndefined();
    expect(p?.audioList).toBeUndefined();
    expect(p?.remux).toBeUndefined();
  });

  it("does not change the cache key", () => {
    expect(parseRelease("Kestrel.2010.1080p.BluRay.x264")?.key).toBe("kestrel|2010|movie");
  });
});

describe("parseRelease source and group", () => {
  it("exposes the source and release group when the name states them", () => {
    const p = parseRelease("Ashfall.1999.1080p.WEB-DL.x264-GROUP");
    expect(p?.source).toBe("web-dl");
    expect(p?.group).toBe("GROUP");
  });

  it("leaves source and group undefined when the name states none", () => {
    const p = parseRelease("Ashfall.1999.1080p");
    expect(p?.source).toBeUndefined();
    expect(p?.group).toBeUndefined();
  });
});
