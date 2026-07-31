import { describe, it, expect } from "vitest";
import { autoPlayableFilm } from "./autoPlayableFilm";

describe("autoPlayableFilm", () => {
  it("trusts OMDb's medium over the filter", () => {
    expect(autoPlayableFilm("movie", "all")).toBe(true);
    expect(autoPlayableFilm("series", "movie")).toBe(false);
  });

  it("falls back to the filter when OMDb said nothing", () => {
    expect(autoPlayableFilm(null, "movie")).toBe(true);
    expect(autoPlayableFilm(undefined, "all")).toBe(false);
    expect(autoPlayableFilm(null, "tv")).toBe(false);
  });
});
