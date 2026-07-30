import { describe, expect, it } from "vitest";
import { historyKeyFor } from "./streamHistoryKey";
import { historyKeyFor as reExported } from "../core/streamHistory";
import { parseRelease } from "./release";

// This key used to be module-private in src/core/streamHistory.ts and was only
// ever exercised through `historyItemFor`. It moved down so the browser could
// derive one (src/core imports node:fs; a browser bundle may not), which makes
// it worth pinning directly: two front ends now agree on "same title" through
// this function, and a drift here does not crash — it silently stops matching.
describe("historyKeyFor", () => {
  const keyOf = (name: string): string => {
    const parsed = parseRelease(name);
    if (!parsed) throw new Error(`unparseable fixture: ${name}`);
    return historyKeyFor(parsed);
  };

  // The reason it is not `parseRelease`'s own key: a series' release name is
  // unreliable about carrying the year, so a year in the key put one show in two
  // rows with two independent high-water marks, one permanently stale.
  it("keys a series on title and type alone, year or no year", () => {
    expect(keyOf("Kepler.2024.S02E04.1080p.WEB-DL")).toBe(keyOf("Kepler.S02E05.1080p.WEB-DL"));
    expect(keyOf("Kepler.S02E04.1080p.WEB-DL")).toBe("kepler|series");
  });

  // A season pack and a single episode of the same show are one row, which is
  // what makes the browser able to find the row for a pack it is about to play.
  it("keys a season pack the same as an episode of the same show", () => {
    expect(keyOf("Harrowgate.S03.1080p.WEB-DL")).toBe(keyOf("Harrowgate.S03E04.1080p.WEB-DL"));
  });

  // A film keeps the year, because two films can honestly share a title.
  it("leaves a film on parseRelease's own key", () => {
    const parsed = parseRelease("Kestrel.2010.1080p.BluRay.x264");
    expect(parsed).not.toBeNull();
    expect(historyKeyFor(parsed!)).toBe(parsed!.key);
    expect(keyOf("Kestrel.2010.1080p.BluRay.x264")).not.toBe(
      keyOf("Kestrel.1999.1080p.BluRay.x264"),
    );
  });

  // The move must be a move, not a copy: src/core/streamHistory.ts re-exports
  // this one rather than keeping a second implementation.
  it("is the same function src/core/streamHistory.ts exports", () => {
    expect(reExported).toBe(historyKeyFor);
  });
});
