import { describe, it, expect } from "vitest";
import { parseRelease } from "./release";
import { resolutionHeight, hasFeature, FEATURE_IDS, FEATURES } from "./releasePick";

const p = (name: string) => {
  const parsed = parseRelease(name);
  if (!parsed) throw new Error(`fixture did not parse: ${name}`);
  return parsed;
};

describe("resolutionHeight", () => {
  it("reads the height out of a p or i token", () => {
    expect(resolutionHeight("1080p")).toBe(1080);
    expect(resolutionHeight("1080i")).toBe(1080);
    expect(resolutionHeight("576p")).toBe(576);
    expect(resolutionHeight("4320p")).toBe(4320);
  });

  it("treats 4k as 2160, because the parser emits it for both 4K and UHD", () => {
    expect(resolutionHeight("4k")).toBe(2160);
  });

  it("returns null for an absent or unrecognised token", () => {
    expect(resolutionHeight(undefined)).toBeNull();
    expect(resolutionHeight("")).toBeNull();
    expect(resolutionHeight("hdrip")).toBeNull();
  });
});

describe("hasFeature", () => {
  const rich = p("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP");
  const plain = p("Kestrel.2010.1080p.BluRay.x264");

  it("matches colour features from the colour list", () => {
    expect(hasFeature(rich, "hdr")).toBe(true);
    expect(hasFeature(rich, "dv")).toBe(true);
    expect(hasFeature(plain, "hdr")).toBe(false);
  });

  it("matches atmos", () => {
    expect(hasFeature(rich, "atmos")).toBe(true);
    expect(hasFeature(plain, "atmos")).toBe(false);
  });

  it("treats DD and DDP as Dolby Digital", () => {
    expect(hasFeature(p("Kepler.S02E04.1080p.WEB-DL.DD5.1"), "dd")).toBe(true);
    expect(hasFeature(p("Harrowgate.S03.1080p.WEB-DL.DDP5.1.x265"), "dd")).toBe(true);
  });

  it("is not fooled by a release group whose name contains the token", () => {
    expect(hasFeature(p("Kestrel.2010.1080p.BluRay.x264-REDDD"), "dd")).toBe(false);
  });

  it("matches the DTS family by prefix", () => {
    expect(hasFeature(p("Ashfall.1999.720p.BRRip.DTS-HD.MA"), "dts")).toBe(true);
  });

  it("matches hevc under every spelling the parser produces", () => {
    // x265 stays "x265"; HEVC, h265 and H.265 all normalise to "h265".
    expect(hasFeature(p("Harrowgate.S03.1080p.WEB-DL.DDP5.1.x265"), "hevc")).toBe(true);
    expect(hasFeature(p("Kestrel.2010.1080p.BluRay.HEVC-GROUP"), "hevc")).toBe(true);
    expect(hasFeature(p("Kestrel.2010.1080p.BluRay.h265-GROUP"), "hevc")).toBe(true);
    expect(hasFeature(plain, "hevc")).toBe(false);
  });

  it("has a label for every id", () => {
    for (const id of FEATURE_IDS) expect(FEATURES[id].label).toBeTruthy();
  });
});

import { filterCandidates, NO_PREFS, type QualityPrefs } from "./releasePick";

const c = (name: string, sizeBytes = 1, seeders = 1) => ({ name, sizeBytes, seeders });
const names = <T extends { name: string }>(s: { item: T }[]) => s.map((x) => x.item.name);
const prefs = (over: Partial<QualityPrefs> = {}): QualityPrefs => ({ ...NO_PREFS, ...over });

describe("filterCandidates", () => {
  it("drops names that parse to nothing but noise", () => {
    const out = filterCandidates([c("Kestrel.2010.1080p.BluRay.x264"), c("1080p.WEB-DL.x265")], prefs());
    expect(names(out.survivors)).toEqual(["Kestrel.2010.1080p.BluRay.x264"]);
  });

  it("drops an excluded feature and never brings it back", () => {
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP")],
      prefs({ exclude: ["dv"] }),
    );
    expect(out.survivors).toEqual([]);
    expect(out.relaxed).toEqual([]);
  });

  it("drops candidates above the cap", () => {
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP"), c("Kestrel.2010.1080p.BluRay.x264")],
      prefs({ maxResolution: "1080p" }),
    );
    expect(names(out.survivors)).toEqual(["Kestrel.2010.1080p.BluRay.x264"]);
    expect(out.overCap).toBe(false);
  });

  it("keeps a candidate whose resolution did not parse, rather than assuming it is too big", () => {
    const out = filterCandidates(
      [c("Kestrel.2010.BluRay.x264"), c("Kestrel.2010.1080p.BluRay.x264")],
      prefs({ maxResolution: "1080p" }),
    );
    expect(names(out.survivors)).toHaveLength(2);
  });

  it("ignores the cap and reports overCap when nothing is under it", () => {
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP")],
      prefs({ maxResolution: "720p" }),
    );
    expect(out.survivors).toHaveLength(1);
    expect(out.overCap).toBe(true);
  });

  it("keeps only candidates with every required feature", () => {
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP"), c("Kestrel.2010.1080p.BluRay.x264")],
      prefs({ require: ["atmos"] }),
    );
    expect(names(out.survivors)).toEqual(["Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP"]);
    expect(out.relaxed).toEqual([]);
  });

  it("relaxes a requirement nothing satisfies, and says which", () => {
    const out = filterCandidates([c("Kestrel.2010.1080p.BluRay.x264")], prefs({ require: ["atmos"] }));
    expect(out.survivors).toHaveLength(1);
    expect(out.relaxed).toEqual(["atmos"]);
  });

  it("drops the rarest requirement first so the commonest survives longest", () => {
    // Both candidates are HDR; neither is Atmos. "atmos" is the rarer, so it
    // goes and "hdr" is still enforced.
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.HDR-GROUP"), c("Kestrel.2010.1080p.BluRay.x264")],
      prefs({ require: ["atmos", "hdr"] }),
    );
    expect(out.relaxed).toEqual(["atmos"]);
    expect(names(out.survivors)).toEqual(["Tin.Rivers.2024.2160p.WEB-DL.HDR-GROUP"]);
  });
});

import { rankReleases, pickBestRelease, type PickIntent } from "./releasePick";

const FILM: PickIntent = { kind: "film" };
const EP2: PickIntent = { kind: "episode", season: 3, episode: 2 };

describe("pickBestRelease", () => {
  it("returns null for an empty list", () => {
    expect(pickBestRelease([], NO_PREFS, FILM)).toBeNull();
  });

  it("returns null when exclusions removed everything", () => {
    const out = pickBestRelease(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP")],
      prefs({ exclude: ["dv"] }),
      FILM,
    );
    expect(out).toBeNull();
  });

  it("ranks resolution above size", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.1080p.BluRay.REMUX", 42_000), c("Kestrel.2010.2160p.WEB-DL", 15_000)],
      NO_PREFS,
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.2160p.WEB-DL");
  });

  it("uses size only to break a resolution tie", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.2160p.WEB-DL", 9_000), c("Kestrel.2010.2160p.WEB-DL.DV.HDR", 15_000)],
      NO_PREFS,
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.2160p.WEB-DL.DV.HDR");
  });

  it("prefers the single episode over a pack at the same resolution, even when smaller", () => {
    const out = pickBestRelease(
      [c("Harrowgate.S03.1080p.WEB-DL", 50_000), c("Harrowgate.S03E02.1080p.WEB-DL", 2_000)],
      NO_PREFS,
      EP2,
    );
    expect(out?.chosen.name).toBe("Harrowgate.S03E02.1080p.WEB-DL");
    expect(out?.fromPack).toBe(false);
  });

  it("prefers a higher-resolution pack over a lower-resolution episode", () => {
    const out = pickBestRelease(
      [c("Harrowgate.S03.2160p.WEB-DL", 58_000), c("Harrowgate.S03E02.720p.WEB-DL", 1_000)],
      NO_PREFS,
      EP2,
    );
    expect(out?.chosen.name).toBe("Harrowgate.S03.2160p.WEB-DL");
    expect(out?.fromPack).toBe(true);
  });

  it("takes the episode once the cap removes the bigger pack", () => {
    const out = pickBestRelease(
      [c("Harrowgate.S03.2160p.WEB-DL", 58_000), c("Harrowgate.S03E02.720p.WEB-DL", 1_000)],
      prefs({ maxResolution: "1080p" }),
      EP2,
    );
    expect(out?.chosen.name).toBe("Harrowgate.S03E02.720p.WEB-DL");
  });

  it("picks the closest above the cap, not the biggest, when nothing fits", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.4320p.WEB-DL"), c("Kestrel.2010.2160p.WEB-DL")],
      prefs({ maxResolution: "1080p" }),
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.2160p.WEB-DL");
    expect(out?.overCap).toBe(true);
  });

  it("lets a requirement beat a higher resolution", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.2160p.WEB-DL"), c("Kestrel.2010.1080p.WEB-DL.Atmos")],
      prefs({ require: ["atmos"] }),
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.1080p.WEB-DL.Atmos");
    expect(out?.relaxed).toEqual([]);
  });

  it("reports a relaxed requirement rather than refusing", () => {
    const out = pickBestRelease([c("Kestrel.2010.1080p.BluRay.x264")], prefs({ require: ["atmos"] }), FILM);
    expect(out?.chosen.name).toBe("Kestrel.2010.1080p.BluRay.x264");
    expect(out?.relaxed).toEqual(["atmos"]);
  });

  it("breaks a full tie deterministically by name", () => {
    const a = c("Kestrel.2010.1080p.WEB-DL.AAA", 100, 5);
    const b = c("Kestrel.2010.1080p.WEB-DL.BBB", 100, 5);
    expect(pickBestRelease([b, a], NO_PREFS, FILM)?.chosen.name).toBe(a.name);
  });

  it("ranks a release with no stated resolution below one that has it, but still picks it alone", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.BluRay.x264", 90_000), c("Kestrel.2010.720p.BluRay.x264", 1_000)],
      NO_PREFS,
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.720p.BluRay.x264");
    expect(pickBestRelease([c("Kestrel.2010.BluRay.x264")], NO_PREFS, FILM)?.chosen.name)
      .toBe("Kestrel.2010.BluRay.x264");
  });
});

describe("rankReleases", () => {
  it("returns every survivor best-first, and pickBestRelease is its head", () => {
    const list = [c("Kestrel.2010.720p.WEB-DL"), c("Kestrel.2010.2160p.WEB-DL"), c("Kestrel.2010.1080p.WEB-DL")];
    const ranked = rankReleases(list, NO_PREFS, FILM);
    expect(ranked.map((r) => r.chosen.name)).toEqual([
      "Kestrel.2010.2160p.WEB-DL",
      "Kestrel.2010.1080p.WEB-DL",
      "Kestrel.2010.720p.WEB-DL",
    ]);
    expect(pickBestRelease(list, NO_PREFS, FILM)).toEqual(ranked[0]);
  });
});
