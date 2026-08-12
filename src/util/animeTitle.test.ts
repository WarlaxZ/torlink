// src/util/animeTitle.test.ts
import { describe, it, expect } from "vitest";
import { animeSearchTitle } from "./animeTitle";

// FIXTURES: invented cast only (Kestrel/Ashfall/Harrowgate per CLAUDE.md).
// ケストレル / ケストレルの夜 are katakana of the invented "Kestrel" — used for
// the CJK cases so no real title appears in a test.
describe("animeSearchTitle", () => {
  it("strips a leading fansub group tag", () => {
    expect(animeSearchTitle("[NanakoRaws] Kestrel S01E18 (AT-X TV 1080p HEVC AAC)")).toBe("Kestrel");
  });

  it("strips the SubsPlease absolute-episode tail and resolution block", () => {
    expect(animeSearchTitle("Ashfall - 06 [1080p]")).toBe("Ashfall");
  });

  it("cuts a trailing quality/codec/subtitle block", () => {
    expect(animeSearchTitle("Ashfall [WebRip 1080p HEVC-10bit AAC][subs]")).toBe("Ashfall");
  });

  it("prefers a Latin-script alternative over a CJK one when titles are slash-joined", () => {
    expect(animeSearchTitle("[LoliHouse] ケストレル / Kestrel - 06 [WebRip 1080p]")).toBe("Kestrel");
  });

  it("keeps the first segment when every alternative is CJK", () => {
    expect(animeSearchTitle("[Doomdos] ケストレルの夜 - 06 [1080p BILIBILI COM WEB-DL]")).toBe("ケストレルの夜");
  });

  it("strips a Chinese episode-counter tail (第N话)", () => {
    expect(animeSearchTitle("[ANi] ケストレルの夜 - 第12话 [1080p]")).toBe("ケストレルの夜");
  });

  it("drops an SxxExx marker", () => {
    expect(animeSearchTitle("Harrowgate S03E04 [1080p]")).toBe("Harrowgate");
  });

  it("returns null when only noise survives", () => {
    expect(animeSearchTitle("[Group] [1080p HEVC AAC]")).toBeNull();
  });
});
