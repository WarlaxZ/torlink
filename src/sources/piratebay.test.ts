import { describe, expect, it } from "vitest";
import { tpbMovies, tpbTv, tpbMusic } from "./piratebay";

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
});
