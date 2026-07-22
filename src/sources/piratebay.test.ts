import { describe, expect, it } from "vitest";
import { tpbMovies, tpbTv, tpbMusic, tpbPorn } from "./piratebay";

describe("Pirate Bay sources", () => {
  it("should have tpbMovies", () => {
    expect(tpbMovies).toBeDefined();
    expect(tpbMovies.id).toBe("tpb-movies");
    expect(tpbMovies.groups).toContain("Movies");
  });

  it("should have tpbTv", () => {
    expect(tpbTv).toBeDefined();
    expect(tpbTv.id).toBe("tpb-tv");
    expect(tpbTv.groups).toContain("TV");
  });

  it("should have tpbMusic", () => {
    expect(tpbMusic).toBeDefined();
    expect(tpbMusic.id).toBe("tpb-music");
    expect(tpbMusic.groups).toContain("Music");
  });

  it("should have tpbPorn flagged as an adult Porn source", () => {
    expect(tpbPorn).toBeDefined();
    expect(tpbPorn.id).toBe("tpb-porn");
    expect(tpbPorn.groups).toContain("Porn");
    expect(tpbPorn.adult).toBe(true);
  });
});
