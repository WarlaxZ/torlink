import { describe, it, expect } from "vitest";
import { fetchAnimeMetaByName } from "./anilist";
import type { FetchImpl } from "../util/net";

function postImpl(status: number, body: unknown): { impl: FetchImpl; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, calls };
}

const media = (over: Record<string, unknown> = {}) => ({
  data: {
    Media: {
      id: 1,
      title: { romaji: "Kestrel no Yoru", english: "Kestrel Nights", native: "ケストレル" },
      description: "A quiet town.<br><br>Then it isn't.",
      coverImage: { extraLarge: "https://s4.anilist.co/xl.jpg", large: "https://s4.anilist.co/l.jpg" },
      format: "TV",
      siteUrl: "https://anilist.co/anime/1",
      ...over,
    },
  },
});

describe("fetchAnimeMetaByName", () => {
  it("returns poster, tag-stripped plot, series type and null imdbId on a hit", async () => {
    const { impl, calls } = postImpl(200, media());
    const res = await fetchAnimeMetaByName("Kestrel no Yoru", { fetchImpl: impl });
    expect(res).toEqual({
      ok: true,
      type: "series",
      imdbId: null,
      plot: "A quiet town. Then it isn't.",
      posterUrl: "https://s4.anilist.co/xl.jpg",
    });
    expect(calls[0]!.url).toBe("https://graphql.anilist.co");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("maps format MOVIE to movie", async () => {
    const { impl } = postImpl(200, media({ format: "MOVIE" }));
    const res = await fetchAnimeMetaByName("Kestrel", { fetchImpl: impl });
    expect(res.ok && res.type).toBe("movie");
  });

  it("falls back to coverImage.large when extraLarge is missing", async () => {
    const { impl } = postImpl(200, media({ coverImage: { large: "https://s4.anilist.co/l.jpg" } }));
    const res = await fetchAnimeMetaByName("Kestrel", { fetchImpl: impl });
    expect(res.ok && res.posterUrl).toBe("https://s4.anilist.co/l.jpg");
  });

  it("treats Media: null as a miss", async () => {
    const { impl } = postImpl(200, { data: { Media: null } });
    const res = await fetchAnimeMetaByName("Nothing Here", { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "not found" });
  });

  it("treats a GraphQL errors payload as a miss", async () => {
    const { impl } = postImpl(200, { errors: [{ message: "Not Found." }] });
    const res = await fetchAnimeMetaByName("Nothing", { fetchImpl: impl });
    expect(res.ok).toBe(false);
  });

  it("returns a reach error when the request throws", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as FetchImpl;
    const res = await fetchAnimeMetaByName("Kestrel", { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "couldn't reach AniList" });
  });

  it("returns a miss for a non-video format", async () => {
    const { impl } = postImpl(200, media({ format: "MUSIC" }));
    const res = await fetchAnimeMetaByName("Kestrel", { fetchImpl: impl });
    expect(res.ok).toBe(false);
  });

  it("returns an empty-title error without calling the network", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as FetchImpl;
    const res = await fetchAnimeMetaByName("   ", { fetchImpl: impl });
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });
});
