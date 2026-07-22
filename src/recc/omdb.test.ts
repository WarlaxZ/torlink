import { describe, it, expect } from "vitest";
import { fetchTitleMeta, fetchTitleMetaByName } from "./omdb";
import type { FetchImpl } from "../util/net";

function jsonImpl(status: number, body: unknown): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

describe("fetchTitleMeta (by id)", () => {
  it("returns imdbId, plot and poster URL on a successful lookup", async () => {
    const { impl, urls } = jsonImpl(200, {
      Response: "True",
      imdbID: "tt1",
      Plot: "A nuclear disaster unfolds.",
      Poster: "https://img/poster.jpg",
    });
    const res = await fetchTitleMeta("tt1", "KEY", { fetchImpl: impl });
    expect(res).toEqual({ ok: true, imdbId: "tt1", plot: "A nuclear disaster unfolds.", posterUrl: "https://img/poster.jpg" });
    expect(urls[0]).toContain("i=tt1");
    expect(urls[0]).toContain("apikey=KEY");
  });

  it("maps 'N/A' fields to null but still succeeds", async () => {
    const { impl } = jsonImpl(200, { Response: "True", imdbID: "tt1", Plot: "N/A", Poster: "N/A" });
    const res = await fetchTitleMeta("tt1", "KEY", { fetchImpl: impl });
    expect(res).toEqual({ ok: true, imdbId: "tt1", plot: null, posterUrl: null });
  });

  it("skips the request entirely when no key is configured", async () => {
    const { impl, urls } = jsonImpl(200, {});
    const res = await fetchTitleMeta("tt1", "", { fetchImpl: impl });
    expect(res.ok).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it("treats OMDb's 200 + Response:False as an error", async () => {
    const { impl } = jsonImpl(200, { Response: "False", Error: "Movie not found!" });
    const res = await fetchTitleMeta("tt1", "KEY", { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "Movie not found!" });
  });

  it("surfaces a bad-key rejection", async () => {
    const { impl } = jsonImpl(401, {});
    const res = await fetchTitleMeta("tt1", "KEY", { fetchImpl: impl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("key");
  });
});

describe("fetchTitleMetaByName", () => {
  it("builds a title lookup with year and type", async () => {
    const { impl, urls } = jsonImpl(200, { Response: "True", imdbID: "tt2", Plot: "P", Poster: "https://p.jpg" });
    const res = await fetchTitleMetaByName("The Bear", "KEY", { year: 2022, type: "series", fetchImpl: impl });
    expect(res).toEqual({ ok: true, imdbId: "tt2", plot: "P", posterUrl: "https://p.jpg" });
    const u = urls[0]!;
    expect(u).toContain("t=The+Bear");
    expect(u).toContain("y=2022");
    expect(u).toContain("type=series");
  });

  it("omits year/type when not given", async () => {
    const { impl, urls } = jsonImpl(200, { Response: "True", imdbID: "tt3" });
    await fetchTitleMetaByName("Weapons", "KEY", { fetchImpl: impl });
    expect(urls[0]).not.toContain("&y=");
    expect(urls[0]).not.toContain("type=");
  });

  it("skips the request when the title is blank", async () => {
    const { impl, urls } = jsonImpl(200, {});
    const res = await fetchTitleMetaByName("  ", "KEY", { fetchImpl: impl });
    expect(res.ok).toBe(false);
    expect(urls).toHaveLength(0);
  });
});
