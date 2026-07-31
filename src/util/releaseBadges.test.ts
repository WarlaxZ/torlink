import { describe, expect, it } from "vitest";
import { BADGE_ORDER, releaseBadges } from "./releaseBadges";
import { FEATURE_IDS } from "./releasePick";

describe("releaseBadges", () => {
  it("leads with the resolution, which is what a viewer scans for first", () => {
    expect(releaseBadges("Kestrel.2010.1080p.BluRay.x264")[0]).toBe("1080p");
  });

  it("names the features a stacked release carries", () => {
    const badges = releaseBadges("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP");
    expect(badges[0]).toBe("2160p");
    // Labels come from FEATURES in releasePick.ts, so a badge here reads the same
    // as the same feature does in the TUI's quality prompt.
    expect(badges).toContain("HDR");
    expect(badges).toContain("Dolby Vision");
    expect(badges).toContain("Atmos");
  });

  // The order is a decision, not an accident: a viewer scanning a list wants the
  // picture facts before the audio ones, and nine badges on a row is a spec
  // sheet rather than a scan aid — so callers slice, and what survives a slice
  // has to be the part worth keeping.
  it("puts picture facts before audio ones", () => {
    const badges = releaseBadges("Tin.Rivers.2024.2160p.BluRay.REMUX.DV.HDR.TrueHD.Atmos.7.1-GROUP");
    expect(badges.indexOf("Remux")).toBeLessThan(badges.indexOf("Atmos"));
    expect(badges.indexOf("Dolby Vision")).toBeLessThan(badges.indexOf("TrueHD"));
  });

  it("returns nothing rather than guessing when the name carries no quality facts", () => {
    expect(releaseBadges("Ashfall")).toEqual([]);
  });

  it("survives a name the parser cannot read", () => {
    expect(releaseBadges("     ")).toEqual([]);
  });

  it("does not repeat a label", () => {
    const badges = releaseBadges("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.DDP5.1.Atmos-GROUP");
    expect(new Set(badges).size).toBe(badges.length);
  });

  // Without this, adding a feature to FEATURES and forgetting BADGE_ORDER means
  // the badge silently never appears — a failure with no symptom to notice.
  it("can show every feature the quality preference knows about", () => {
    expect([...BADGE_ORDER].sort()).toEqual([...FEATURE_IDS].sort());
  });

  it("reads the parser's resolution vocabulary as-is rather than tidying it", () => {
    // resolutionHeight() exists because the parser emits 1080i and 4k too;
    // rewriting the token here would be a second opinion about the release.
    expect(releaseBadges("Kestrel.2010.4k.BluRay.x265")[0]).toBe("4k");
  });
});
