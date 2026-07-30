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

  it("matches hevc under either spelling", () => {
    expect(hasFeature(p("Harrowgate.S03.1080p.WEB-DL.DDP5.1.x265"), "hevc")).toBe(true);
    expect(hasFeature(plain, "hevc")).toBe(false);
  });

  it("has a label for every id", () => {
    for (const id of FEATURE_IDS) expect(FEATURES[id].label).toBeTruthy();
  });
});
