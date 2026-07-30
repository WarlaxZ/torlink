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
