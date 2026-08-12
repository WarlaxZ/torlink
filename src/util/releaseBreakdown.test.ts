import { describe, it, expect } from "vitest";
import { studioFromName, releaseBreakdown, breakdownSummary } from "./releaseBreakdown";

describe("studioFromName", () => {
  it("takes the first bracketed segment and strips a trailing year", () => {
    expect(studioFromName("Kestrel [Meridian Studios 2026] XXX WEB-DL 1080p")).toBe("Meridian Studios");
  });
  it("returns the bracket as-is when it carries no year", () => {
    expect(studioFromName("Kestrel [Vantage Media] 1080p")).toBe("Vantage Media");
  });
  it("returns undefined when there is no bracket", () => {
    expect(studioFromName("Ashfall.1999.1080p.WEB-DL.x264-GROUP")).toBeUndefined();
  });
});

describe("releaseBreakdown", () => {
  it("builds ordered fields from a bracketed adult release", () => {
    const f = releaseBreakdown("Kestrel [Meridian Studios 2026] XXX WEB-DL 1080p SPLIT SCENES MP4-P2P");
    expect(f).toEqual([
      { label: "Studio", value: "Meridian Studios" },
      { label: "Year", value: "2026" },
      { label: "Resolution", value: "1080p" },
      { label: "Source", value: "WEB-DL" },
      { label: "Group", value: "P2P" },
    ]);
  });
  it("includes codec and omits an absent studio", () => {
    const f = releaseBreakdown("Ashfall.1999.1080p.WEB-DL.x264-GROUP");
    expect(f).toEqual([
      { label: "Year", value: "1999" },
      { label: "Resolution", value: "1080p" },
      { label: "Source", value: "WEB-DL" },
      { label: "Codec", value: "x264" },
      { label: "Group", value: "GROUP" },
    ]);
  });
  it("returns no fields when the name carries nothing parseable beyond a bare word", () => {
    expect(releaseBreakdown("Ashfall")).toEqual([]);
  });
});

describe("breakdownSummary", () => {
  it("joins the fields with a middot", () => {
    expect(breakdownSummary("Ashfall.1999.1080p.WEB-DL.x264-GROUP")).toBe(
      "Year: 1999 · Resolution: 1080p · Source: WEB-DL · Codec: x264 · Group: GROUP",
    );
  });
  it("falls back to an honest sentence when there are no fields", () => {
    expect(breakdownSummary("Ashfall")).toBe("No further details in the release name.");
  });
});
