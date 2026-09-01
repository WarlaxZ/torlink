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
    expect(res).toEqual({ ok: true, type: null, imdbId: "tt1", plot: "A nuclear disaster unfolds.", posterUrl: "https://img/poster.jpg" });
    expect(urls[0]).toContain("i=tt1");
    expect(urls[0]).toContain("apikey=KEY");
  });

  it("maps 'N/A' fields to null but still succeeds", async () => {
    const { impl } = jsonImpl(200, { Response: "True", imdbID: "tt1", Plot: "N/A", Poster: "N/A" });
    const res = await fetchTitleMeta("tt1", "KEY", { fetchImpl: impl });
    expect(res).toEqual({ ok: true, type: null, imdbId: "tt1", plot: null, posterUrl: null });
  });

  it("reports the medium OMDb returned", async () => {
    const { impl } = jsonImpl(200, { Response: "True", imdbID: "tt1", Type: "movie", Plot: "x", Poster: "N/A" });
    const res = await fetchTitleMeta("tt1", "KEY", { fetchImpl: impl });
    expect(res).toEqual({ ok: true, type: "movie", imdbId: "tt1", plot: "x", posterUrl: null });
  });

  it("reports null when OMDb sends a medium it does not model", async () => {
    // OMDb also returns "episode" and "game"; neither is one of ours.
    const { impl } = jsonImpl(200, { Response: "True", imdbID: "tt1", Type: "game" });
    const res = await fetchTitleMeta("tt1", "KEY", { fetchImpl: impl });
    expect(res).toEqual({ ok: true, type: null, imdbId: "tt1", plot: null, posterUrl: null });
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
  it("builds a title lookup with year and type, for a film", async () => {
    // A film's OMDb year IS its identity — Ashfall 1999 and Ashfall 2024 are
    // different films — so unlike a series (below), it is sent unconditionally.
    const { impl, urls } = jsonImpl(200, { Response: "True", imdbID: "tt2", Plot: "P", Poster: "https://p.jpg" });
    const res = await fetchTitleMetaByName("Ashfall", "KEY", { year: 1999, type: "movie", fetchImpl: impl });
    expect(res).toEqual({ ok: true, type: null, imdbId: "tt2", plot: "P", posterUrl: "https://p.jpg" });
    const u = urls[0]!;
    expect(u).toContain("t=Ashfall");
    expect(u).toContain("y=1999");
    expect(u).toContain("type=movie");
  });

  it("drops the year for a series — it names the release's own air date, not the show's debut", async () => {
    // "The Boys S05 Season 5 2026 1080p..." parses year 2026, the season's own
    // air year. OMDb keys a series by when it DEBUTED (2019 here), so sending
    // y=2026 finds no match and OMDb falls back to an unrelated title that
    // happens to answer to that year — a real bug this protects against.
    const { impl, urls } = jsonImpl(200, { Response: "True", imdbID: "tt1190634", Plot: "P", Poster: "https://p.jpg" });
    const res = await fetchTitleMetaByName("The Boys", "KEY", { year: 2026, type: "series", fetchImpl: impl });
    expect(res).toEqual({
      ok: true,
      type: null,
      imdbId: "tt1190634",
      plot: "P",
      posterUrl: "https://p.jpg",
    });
    const u = urls[0]!;
    expect(u).toContain("t=The+Boys");
    expect(u).not.toContain("y=2026");
    expect(u).toContain("type=series");
  });

  it("asks OMDb for one episode when season and episode are given", async () => {
    const { impl, urls } = jsonImpl(200, { Response: "True", imdbID: "tt9", Plot: "The episode's own plot." });
    const res = await fetchTitleMetaByName("Harrowgate", "KEY", {
      type: "series",
      season: 3,
      episode: 2,
      fetchImpl: impl,
    });
    expect(res).toEqual({ ok: true, type: null, imdbId: "tt9", plot: "The episode's own plot.", posterUrl: null });
    expect(urls[0]).toContain("Season=3");
    expect(urls[0]).toContain("Episode=2");
  });

  it("falls back to the series poster when an episode has no artwork", async () => {
    // OMDb has per-episode stills for some episodes and not others. Without this
    // the pane blanks on every other episode as you arrow down a season, which
    // is worse than an image that simply does not change.
    const urls: string[] = [];
    const impl = (async (url: string) => {
      urls.push(String(url));
      const episode = String(url).includes("Episode=");
      return {
        ok: true,
        status: 200,
        json: async () =>
          episode
            ? { Response: "True", imdbID: "tt9", Plot: "Episode plot.", Poster: "N/A" }
            : { Response: "True", imdbID: "tt1", Plot: "Series plot.", Poster: "https://series.jpg" },
      } as unknown as Response;
    }) as unknown as FetchImpl;

    const res = await fetchTitleMetaByName("Harrowgate", "KEY", {
      type: "series",
      season: 3,
      episode: 2,
      fetchImpl: impl,
    });
    // The EPISODE's plot, the SERIES' poster.
    expect(res).toEqual({
      ok: true,
      type: null,
      imdbId: "tt9",
      plot: "Episode plot.",
      posterUrl: "https://series.jpg",
    });
    expect(urls).toHaveLength(2);
  });

  it("does not spend a second lookup when the episode has its own artwork", async () => {
    const urls: string[] = [];
    const impl = (async (url: string) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ Response: "True", imdbID: "tt9", Plot: "P", Poster: "https://ep.jpg" }),
      } as unknown as Response;
    }) as unknown as FetchImpl;

    const res = await fetchTitleMetaByName("Harrowgate", "KEY", {
      type: "series",
      season: 3,
      episode: 2,
      fetchImpl: impl,
    });
    expect(res).toEqual({ ok: true, type: null, imdbId: "tt9", plot: "P", posterUrl: "https://ep.jpg" });
    expect(urls).toHaveLength(1);
  });

  it("omits Season/Episode when not given", async () => {
    const { impl, urls } = jsonImpl(200, { Response: "True", imdbID: "tt10" });
    await fetchTitleMetaByName("Harrowgate", "KEY", { type: "series", fetchImpl: impl });
    expect(urls[0]).not.toContain("Season=");
    expect(urls[0]).not.toContain("Episode=");
  });

  it("treats an episode OMDb does not have as a miss, not a throw", async () => {
    // A season that aired more episodes than OMDb lists is ordinary. The preview
    // pane must render "no plot available", not an error state.
    const { impl } = jsonImpl(200, { Response: "False", Error: "Series or episode not found!" });
    const res = await fetchTitleMetaByName("Harrowgate", "KEY", {
      type: "series",
      season: 3,
      episode: 99,
      fetchImpl: impl,
    });
    expect(res.ok).toBe(false);
  });

  it("omits year/type when not given", async () => {
    const { impl, urls } = jsonImpl(200, { Response: "True", imdbID: "tt3" });
    await fetchTitleMetaByName("Tollgate", "KEY", { fetchImpl: impl });
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
