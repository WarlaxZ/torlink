import { describe, expect, it } from "vitest";
import { prepareLine } from "./prepareLine";

describe("prepareLine", () => {
  // The three strings src/ui/App.tsx:2386-2393 built inline before this module
  // existed. They are asserted verbatim so the terminal's swap over to this
  // helper cannot change a word of what it renders.
  it("says who is caching and how far along, for a debrid resolve", () => {
    expect(
      prepareLine({
        source: "rd",
        phase: "caching",
        providerLabel: "Real-Debrid",
        label: "Harrowgate.S03.1080p.WEB-DL",
        pct: 42,
        elapsedSec: 12,
      }),
    ).toBe("Caching on Real-Debrid… 42% · 12s");
  });

  it("names the release while looking for peers, where there is no percent to give", () => {
    expect(
      prepareLine({
        source: "torrent",
        phase: "caching",
        label: "Kestrel.2010.1080p.BluRay.x264",
        pct: 0,
        elapsedSec: 3,
      }),
    ).toBe("Finding peers… Kestrel.2010.1080p.BluRay.x264 · 3s");
  });

  it("says only how long it has been fetching a link, which has no percent either", () => {
    expect(
      prepareLine({
        source: "rd",
        phase: "fetching",
        providerLabel: "TorBox",
        label: "Ashfall.1999.1080p",
        pct: 0,
        elapsedSec: 7,
      }),
    ).toBe("Fetching link… 7s");
  });

  it("falls back to a generic provider name rather than rendering 'undefined'", () => {
    const line = prepareLine({
      source: "rd",
      phase: "caching",
      label: "Ashfall.1999.1080p",
      pct: 5,
      elapsedSec: 1,
    });
    expect(line).toBe("Caching on debrid… 5% · 1s");
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("null");
  });

  // Floors rather than rounds, for the reason dashboard.ts gives: rounding 99.6
  // up to 100 on something still working reads as a stuck UI.
  it("clamps and floors a nonsense percent instead of rendering it", () => {
    const at = (pct: number): string =>
      prepareLine({
        source: "rd",
        phase: "caching",
        providerLabel: "RD",
        label: "n",
        pct,
        elapsedSec: 0,
      });
    expect(at(140)).toContain("100%");
    expect(at(-3)).toContain("0%");
    expect(at(Number.NaN)).toContain("0%");
    expect(at(99.7)).toContain("99%");
  });

  it("clamps a nonsense elapsed time the same way", () => {
    const at = (elapsedSec: number): string =>
      prepareLine({ source: "torrent", phase: "caching", label: "n", pct: 0, elapsedSec });
    expect(at(-1)).toContain("· 0s");
    expect(at(Number.NaN)).toContain("· 0s");
    expect(at(12.9)).toContain("· 12s");
  });
});
