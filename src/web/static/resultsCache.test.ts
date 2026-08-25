import { describe, expect, it } from "vitest";
import { matchesRoute, parseStoredResults, type StoredResults } from "./resultsCache";
import type { PublicSearchSnapshot } from "../wire";

const snapshot: PublicSearchSnapshot = {
  results: [
    {
      infoHash: "abc123",
      name: "Kestrel.2010.1080p.BluRay.x264",
      sizeBytes: 1_000_000,
      seeders: 5,
      leechers: 1,
      source: "TPB",
      sources: ["TPB"],
    },
  ],
  perSource: {},
  done: 1,
  total: 1,
};

const stored: StoredResults = { query: "kestrel", group: "All", snapshot };

describe("parseStoredResults", () => {
  it("round-trips a value this module wrote", () => {
    expect(parseStoredResults(JSON.stringify(stored))).toEqual(stored);
  });

  it("returns null for a missing value", () => {
    expect(parseStoredResults(null)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseStoredResults("{not json")).toBeNull();
  });

  it.each([
    ["not an object", JSON.stringify("kestrel")],
    ["missing query", JSON.stringify({ group: "All", snapshot })],
    ["missing group", JSON.stringify({ query: "kestrel", snapshot })],
    ["missing snapshot", JSON.stringify({ query: "kestrel", group: "All" })],
    ["snapshot with no results array", JSON.stringify({ query: "kestrel", group: "All", snapshot: { perSource: {} } })],
    ["snapshot with no perSource", JSON.stringify({ query: "kestrel", group: "All", snapshot: { results: [] } })],
  ])("returns null for %s — a past version's shape or a hostile write", (_why, raw) => {
    expect(parseStoredResults(raw)).toBeNull();
  });
});

describe("matchesRoute", () => {
  it("matches when query and group are identical", () => {
    expect(matchesRoute(stored, "kestrel", "All")).toBe(true);
  });

  it("does not match a different query", () => {
    expect(matchesRoute(stored, "ashfall", "All")).toBe(false);
  });

  it("does not match a different group", () => {
    expect(matchesRoute(stored, "kestrel", "TV")).toBe(false);
  });

  it("trims the query being matched against, the same way startSearch does", () => {
    expect(matchesRoute(stored, "  kestrel  ", "All")).toBe(true);
  });

  it("never matches when there is nothing stored", () => {
    expect(matchesRoute(null, "kestrel", "All")).toBe(false);
  });
});
