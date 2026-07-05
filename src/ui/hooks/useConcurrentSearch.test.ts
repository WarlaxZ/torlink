import { describe, expect, it } from "vitest";
import { mergeDuplicateResults, shouldBench } from "./useConcurrentSearch";
import { AuthRequiredError } from "../../sources/rutracker/session";
import { HttpError } from "../../util/net";

describe("shouldBench", () => {
  it("does not bench on AuthRequiredError", () => {
    expect(shouldBench(new AuthRequiredError())).toBe(false);
  });

  it("benches on a generic error", () => {
    expect(shouldBench(new Error("boom"))).toBe(true);
  });

  it("benches on an HttpError", () => {
    expect(shouldBench(new HttpError(500, "server error"))).toBe(true);
  });

  it("benches on a non-Error thrown value", () => {
    expect(shouldBench("timed out")).toBe(true);
  });
});

describe("mergeDuplicateResults", () => {
  it("keeps the healthiest copy and records every source", () => {
    const base = {
      infoHash: "abc",
      name: "Release",
      sizeBytes: 10,
      leechers: 0,
      magnet: "magnet:?xt=urn:btih:abc",
    } as const;
    const merged = mergeDuplicateResults([
      { ...base, source: "tpb-movies", seeders: 3 },
      { ...base, source: "x1337-movies", seeders: 8 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ source: "x1337-movies", seeders: 8 });
    expect(merged[0]!.sources).toEqual(["tpb-movies", "x1337-movies"]);
  });
});
