import { describe, it, expect, vi } from "vitest";
import { fetchAnimeFirstMeta } from "./animeMeta";
import * as anilist from "./anilist";
import * as omdb from "./omdb";
import type { FetchTitleMetaResult } from "./omdb";

const hit: FetchTitleMetaResult = { ok: true, type: "series", imdbId: null, plot: "p", posterUrl: "https://s4.anilist.co/x.jpg" };
const miss: FetchTitleMetaResult = { ok: false, error: "not found" };

describe("fetchAnimeFirstMeta", () => {
  it("returns the AniList hit and never calls OMDb", async () => {
    const a = vi.spyOn(anilist, "fetchAnimeMetaByName").mockResolvedValue(hit);
    const o = vi.spyOn(omdb, "fetchTitleMetaByName").mockResolvedValue(miss);
    const res = await fetchAnimeFirstMeta({
      rawName: "[NanakoRaws] Kestrel S01E18 [1080p]",
      omdb: { title: "Kestrel", type: "series" },
      omdbApiKey: "KEY",
    });
    expect(res).toBe(hit);
    expect(a).toHaveBeenCalledWith("Kestrel", expect.anything());
    expect(o).not.toHaveBeenCalled();
    a.mockRestore();
    o.mockRestore();
  });

  it("falls back to OMDb (no season/episode) when AniList misses and a key is present", async () => {
    const a = vi.spyOn(anilist, "fetchAnimeMetaByName").mockResolvedValue(miss);
    const o = vi.spyOn(omdb, "fetchTitleMetaByName").mockResolvedValue(hit);
    const res = await fetchAnimeFirstMeta({
      rawName: "Ashfall - 06 [1080p]",
      omdb: { title: "Ashfall", year: 1999, type: "series" },
      omdbApiKey: "KEY",
    });
    expect(res).toBe(hit);
    expect(o).toHaveBeenCalledWith("Ashfall", "KEY", { year: 1999, type: "series" });
    a.mockRestore();
    o.mockRestore();
  });

  it("does NOT call OMDb on an AniList miss when no key is configured", async () => {
    const a = vi.spyOn(anilist, "fetchAnimeMetaByName").mockResolvedValue(miss);
    const o = vi.spyOn(omdb, "fetchTitleMetaByName").mockResolvedValue(hit);
    const res = await fetchAnimeFirstMeta({
      rawName: "Ashfall - 06 [1080p]",
      omdb: { title: "Ashfall" },
      omdbApiKey: "",
    });
    expect(res).toEqual(miss);
    expect(o).not.toHaveBeenCalled();
    a.mockRestore();
    o.mockRestore();
  });

  it("skips AniList and goes straight to OMDb when the name normalizes to nothing", async () => {
    const a = vi.spyOn(anilist, "fetchAnimeMetaByName").mockResolvedValue(hit);
    const o = vi.spyOn(omdb, "fetchTitleMetaByName").mockResolvedValue(hit);
    const res = await fetchAnimeFirstMeta({
      rawName: "[Group] [1080p HEVC]",
      omdb: { title: "Fallback Title" },
      omdbApiKey: "KEY",
    });
    expect(a).not.toHaveBeenCalled();
    expect(o).toHaveBeenCalledWith("Fallback Title", "KEY", {});
    expect(res).toBe(hit);
    a.mockRestore();
    o.mockRestore();
  });
});
