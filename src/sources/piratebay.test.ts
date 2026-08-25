import { describe, expect, it, vi, beforeEach } from "vitest";
import { tpbMovies, tpbTv, tpbMusic, tpbPorn } from "./piratebay";
import { fetchResilient } from "../util/net";

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

vi.mock("../util/net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/net")>();
  return { ...actual, fetchResilient: vi.fn() };
});

const mockFetch = vi.mocked(fetchResilient);

const page = (items: unknown[]): Response =>
  ({ ok: true, status: 200, json: async () => items }) as unknown as Response;

// apibay answers an empty search with this single placeholder instead of [].
const SENTINEL = {
  id: "0",
  name: "No results returned",
  info_hash: "0000000000000000000000000000000000000000",
  category: "0",
};

const movieRow = {
  id: "1",
  name: "Kestrel 2010 1080p",
  info_hash: "a".repeat(40),
  seeders: "12",
  leechers: "3",
  size: "4000",
  num_files: "2",
  added: "1700000000",
  category: "207",
};

const askedUrl = (call: number): string => String(mockFetch.mock.calls[call]![0]);

beforeEach(() => {
  mockFetch.mockReset();
});

// apibay caches search results per exact URL, and a query can be stuck with
// the sentinel on one URL form while the alternate form answers fine (live:
// q=metallica is poisoned bare but healthy with &cat=0; q=dune the other way
// around). One retry on the other form re-rolls that cache key instead of
// showing the user an empty column.
describe("apibay sentinel retry", () => {
  it("retries with cat=0 when a search comes back as the no-results sentinel", async () => {
    mockFetch.mockResolvedValueOnce(page([SENTINEL]));
    mockFetch.mockResolvedValueOnce(page([movieRow]));
    const results = await tpbMovies.search("metallica");
    expect(results.map((r) => r.name)).toEqual([movieRow.name]);
    expect(askedUrl(0)).toBe("https://apibay.org/q.php?q=metallica");
    expect(askedUrl(1)).toBe("https://apibay.org/q.php?q=metallica&cat=0");
  });

  it("asks once when the search returns real rows", async () => {
    mockFetch.mockResolvedValueOnce(page([movieRow]));
    await tpbMovies.search("dune");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns empty when both forms answer with the sentinel", async () => {
    mockFetch.mockResolvedValueOnce(page([SENTINEL]));
    mockFetch.mockResolvedValueOnce(page([SENTINEL]));
    expect(await tpbMovies.search("qqqqzzzz")).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("never retries a browse, which hits the precompiled feed", async () => {
    mockFetch.mockResolvedValueOnce(page([movieRow]));
    await tpbMovies.search("");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(askedUrl(0)).toContain("/precompiled/");
  });
});
