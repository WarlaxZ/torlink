import { describe, expect, it } from "vitest";
import { createPosterCache, postersApply, type PosterDeps } from "./resultPosters";
import { NO_KEY_POSTER_NOTE, NO_POSTER_NOTE, OMDB_KEY_HINT } from "./previewModel";
import type { PublicTitleMeta } from "../wire";

const OK = (posterUrl: string | null): PublicTitleMeta => ({
  status: "ok",
  imdbId: "tt1160419",
  plot: "Sand.",
  posterUrl,
});

function harness(over: Partial<PosterDeps> = {}) {
  const metaCalls: string[] = [];
  const blobCalls: string[] = [];
  const revoked: string[] = [];
  let blobs = 0;
  const deps: PosterDeps = {
    fetchMeta: async (release) => {
      metaCalls.push(release);
      return OK("https://m.media-amazon.com/dune.jpg");
    },
    fetchBlob: async (url) => {
      blobCalls.push(url);
      blobs += 1;
      return `blob:${blobs}`;
    },
    revoke: (url) => revoked.push(url),
    ...over,
  };
  return { cache: createPosterCache(deps), metaCalls, blobCalls, revoked };
}

describe("postersApply", () => {
  it("is true only on the tabs OMDb knows about, and only with a key", () => {
    // previewApplies is the existing predicate for this — All, Movies, TV,
    // Anime. Not a second one: OMDb has nothing useful to say about a Games or
    // Music row.
    expect(postersApply("Movies", true)).toBe(true);
    expect(postersApply("TV", true)).toBe(true);
    expect(postersApply("Anime", true)).toBe(true);
    expect(postersApply("All", true)).toBe(true);
    expect(postersApply("Games", true)).toBe(false);
    expect(postersApply("Music", true)).toBe(false);
  });

  it("is false without a key, whatever the tab", () => {
    expect(postersApply("Movies", false)).toBe(false);
    expect(postersApply("All", false)).toBe(false);
  });
});

describe("createPosterCache", () => {
  it("fetches metadata then bytes, and answers with the object URL", async () => {
    const { cache, metaCalls, blobCalls } = harness();
    const outcome = await cache.want("Dune.Part.Two.2024.2160p.WEB-DL", "Movies");
    expect(outcome).toEqual({ kind: "poster", url: "blob:1" });
    expect(metaCalls).toEqual(["Dune.Part.Two.2024.2160p.WEB-DL"]);
    expect(blobCalls).toEqual(["https://m.media-amazon.com/dune.jpg"]);
  });

  it("answers a settled release from cache with no fetch at all", async () => {
    const { cache, metaCalls } = harness();
    await cache.want("Dune.Part.Two.2024.2160p", "Movies");
    // Synchronous on a hit — this is what makes a 23-frame re-render free.
    const again = cache.want("Dune.Part.Two.2024.2160p", "Movies");
    expect(again).toEqual({ kind: "poster", url: "blob:1" });
    expect(metaCalls).toHaveLength(1);
  });

  it("coalesces concurrent asks for one release into a single lookup", async () => {
    const { cache, metaCalls } = harness();
    // Every snapshot frame re-mounts every row. Without coalescing, one search
    // is 23 lookups per row.
    const all = await Promise.all([
      cache.want("Dune.Part.Two.2024", "Movies"),
      cache.want("Dune.Part.Two.2024", "Movies"),
      cache.want("Dune.Part.Two.2024", "Movies"),
    ]);
    expect(metaCalls).toHaveLength(1);
    expect(all).toEqual([
      { kind: "poster", url: "blob:1" },
      { kind: "poster", url: "blob:1" },
      { kind: "poster", url: "blob:1" },
    ]);
  });

  it("shares ONE blob between different releases of the same film", async () => {
    // Fifty releases of one film parse to one title server-side, so /api/title
    // answers all fifty from its own cache — but each answer names the same
    // posterUrl, and fetching the bytes per release would be fifty blobs of
    // identical JPEG held in memory. Keyed by poster URL, not release name.
    const { cache, blobCalls } = harness();
    const a = await cache.want("Dune.Part.Two.2024.2160p.WEB-DL.x265-GROUP", "Movies");
    const b = await cache.want("Dune.Part.Two.2024.1080p.BluRay.x264-OTHER", "Movies");
    expect(a).toEqual(b);
    expect(blobCalls).toEqual(["https://m.media-amazon.com/dune.jpg"]);
  });

  it("carries no-key out rather than flattening it to 'no poster'", async () => {
    const { cache, blobCalls } = harness({
      fetchMeta: async () => ({ status: "no-key" }),
    });
    const outcome = await cache.want("Dune.Part.Two.2024", "Movies");
    expect(outcome).toEqual({ kind: "no-key" });
    // Nothing to fetch bytes from, and the note must say which fix applies.
    expect(blobCalls).toEqual([]);
    expect(cache.note(outcome as never)).toBe(NO_KEY_POSTER_NOTE);
    expect(cache.hint()).toBe(OMDB_KEY_HINT);
  });

  it("reports 'none' for a title with no artwork, and no hint", async () => {
    const { cache } = harness({ fetchMeta: async () => OK(null) });
    const outcome = await cache.want("Some.Obscure.Thing.2011", "Movies");
    expect(outcome).toEqual({ kind: "none" });
    expect(cache.note(outcome as never)).toBe(NO_POSTER_NOTE);
    // With a key configured, an obscure title having no artwork must not tell
    // the user to add a key they already have.
    expect(cache.hint()).toBeNull();
  });

  it("reports 'none' when the metadata lookup or the bytes fail", async () => {
    const noMeta = harness({ fetchMeta: async () => null });
    expect(await noMeta.cache.want("X.2024", "Movies")).toEqual({ kind: "none" });

    const noBytes = harness({ fetchBlob: async () => null });
    expect(await noBytes.cache.want("X.2024", "Movies")).toEqual({ kind: "none" });

    const errored = harness({ fetchMeta: async () => ({ status: "error", error: "OMDb down" }) });
    expect(await errored.cache.want("X.2024", "Movies")).toEqual({ kind: "none" });
  });

  it("survives a fetch that throws rather than taking the render down", async () => {
    const { cache } = harness({
      fetchMeta: async () => {
        throw new Error("offline");
      },
    });
    expect(await cache.want("X.2024", "Movies")).toEqual({ kind: "none" });
  });

  it("revokes every blob on clear, and forgets the hint with them", async () => {
    const { cache, revoked } = harness();
    await cache.want("Dune.Part.Two.2024", "Movies");
    cache.clear();
    // Each object URL holds its JPEG in memory until revoked; a session of
    // searches would otherwise accumulate every poster it ever loaded.
    expect(revoked).toEqual(["blob:1"]);
    expect(cache.peek("Dune.Part.Two.2024")).toBeUndefined();
  });

  it("forgets a no-key answer on clear, so a reload that finds a key stops nagging", async () => {
    const { cache } = harness({ fetchMeta: async () => ({ status: "no-key" }) });
    await cache.want("X.2024", "Movies");
    expect(cache.hint()).toBe(OMDB_KEY_HINT);
    cache.clear();
    expect(cache.hint()).toBeNull();
  });

  it("drops an answer that lands after a clear, and revokes its blob", async () => {
    let release!: (meta: PublicTitleMeta) => void;
    const { cache, revoked } = harness({
      fetchMeta: () => new Promise<PublicTitleMeta>((resolve) => (release = resolve)),
    });
    const pending = cache.want("Dune.Part.Two.2024", "Movies");
    // A new search starts while the lookup is in flight.
    cache.clear();
    release(OK("https://m.media-amazon.com/dune.jpg"));
    await pending;
    // The blob was created for a row nobody is showing any more; revoked rather
    // than leaked back into an emptied cache, and NOT resurrected into it — a
    // late answer must not re-populate a cache that moved on.
    expect(revoked).toEqual(["blob:1"]);
    expect(cache.peek("Dune.Part.Two.2024")).toBeUndefined();
  });

  it("passes the group through so the server can hint OMDb's type", async () => {
    const groups: string[] = [];
    const { cache } = harness({
      fetchMeta: async (_release, group) => {
        groups.push(group);
        return OK("https://m.media-amazon.com/x.jpg");
      },
    });
    await cache.want("The.Bear.S03", "TV");
    expect(groups).toEqual(["TV"]);
  });
});
