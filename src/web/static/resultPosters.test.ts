import { describe, expect, it } from "vitest";
import { createPosterCache, postersApply, searchHint, type PosterDeps } from "./resultPosters";
import { NO_KEY_POSTER_NOTE, NO_POSTER_NOTE, OMDB_KEY_HINT } from "./previewModel";
import type { PublicTitleMeta } from "../wire";

const OK = (posterUrl: string | null): PublicTitleMeta => ({
  status: "ok",
  imdbId: "tt3",
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
      return OK("https://m.media-amazon.com/tinrivers.jpg");
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

describe("searchHint", () => {
  it("says nothing before /api/sources has answered, even on a tab that would otherwise get the hint", () => {
    // omdbConfigured: null means the page does not know yet — flashing "add a
    // key" before it does would be wrong for a server that turns out to have one.
    expect(searchHint(null, "Movies", null)).toBeNull();
    expect(searchHint(null, "All", "some cache hint")).toBeNull();
  });

  it("hints on a tab OMDb covers, with no key configured", () => {
    expect(searchHint(false, "Movies", null)).toBe(OMDB_KEY_HINT);
    expect(searchHint(false, "All", null)).toBe(OMDB_KEY_HINT);
  });

  it("says nothing on a tab OMDb has nothing to say about, even with no key", () => {
    // Games and Music have no artwork to explain, so no note about a key they
    // would never use.
    expect(searchHint(false, "Games", null)).toBeNull();
    expect(searchHint(false, "Music", null)).toBeNull();
  });

  it("gates a non-null cacheHint on the tab too, not only the no-key branch", () => {
    // The asymmetry finding 5 named: today a `no-key` outcome can only land in
    // cacheHint on a tab where lookups are made in the first place, so this
    // case is unreachable through the real cache — but gating only the no-key
    // branch on previewApplies, and not this one, is the trap. A key
    // configured plus a stray cacheHint on Games must still say nothing.
    expect(searchHint(true, "Games", OMDB_KEY_HINT)).toBeNull();
  });

  it("says nothing with a key configured and no cache hint — an obscure title is not a missing key", () => {
    expect(searchHint(true, "Movies", null)).toBeNull();
  });

  it("passes through the cache's own hint when a key is configured — the mid-session revocation race", () => {
    expect(searchHint(true, "Movies", OMDB_KEY_HINT)).toBe(OMDB_KEY_HINT);
  });
});

describe("postersApply — Anime is keyless", () => {
  it("applies for Anime even without an OMDb key", () => {
    expect(postersApply("Anime", false)).toBe(true);
  });
  it("still requires a key for Movies", () => {
    expect(postersApply("Movies", false)).toBe(false);
    expect(postersApply("Movies", true)).toBe(true);
  });
  it("does not apply to a non-preview group regardless", () => {
    expect(postersApply("Games", true)).toBe(false);
  });
});

describe("searchHint — no OMDb nudge on the Anime tab", () => {
  it("returns null (no key hint) for Anime with no key", () => {
    expect(searchHint(false, "Anime", null)).toBeNull();
  });
  it("still nudges for a key on Movies with no key", () => {
    expect(searchHint(false, "Movies", null)).not.toBeNull();
  });
});

describe("createPosterCache", () => {
  it("fetches metadata then bytes, and answers with the object URL", async () => {
    const { cache, metaCalls, blobCalls } = harness();
    const outcome = await cache.want("Tin.Rivers.2024.2160p.WEB-DL", "Movies");
    expect(outcome).toEqual({ kind: "poster", url: "blob:1" });
    expect(metaCalls).toEqual(["Tin.Rivers.2024.2160p.WEB-DL"]);
    expect(blobCalls).toEqual(["https://m.media-amazon.com/tinrivers.jpg"]);
  });

  it("answers a settled release from cache with no fetch at all", async () => {
    const { cache, metaCalls } = harness();
    await cache.want("Tin.Rivers.2024.2160p", "Movies");
    // Synchronous on a hit — this is what makes a 23-frame re-render free.
    const again = cache.want("Tin.Rivers.2024.2160p", "Movies");
    expect(again).toEqual({ kind: "poster", url: "blob:1" });
    expect(metaCalls).toHaveLength(1);
  });

  it("coalesces concurrent asks for one release into a single lookup", async () => {
    const { cache, metaCalls } = harness();
    // Every snapshot frame re-mounts every row. Without coalescing, one search
    // is 23 lookups per row.
    const all = await Promise.all([
      cache.want("Tin.Rivers.2024", "Movies"),
      cache.want("Tin.Rivers.2024", "Movies"),
      cache.want("Tin.Rivers.2024", "Movies"),
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
    const a = await cache.want("Tin.Rivers.2024.2160p.WEB-DL.x265-GROUP", "Movies");
    const b = await cache.want("Tin.Rivers.2024.1080p.BluRay.x264-OTHER", "Movies");
    expect(a).toEqual(b);
    expect(blobCalls).toEqual(["https://m.media-amazon.com/tinrivers.jpg"]);
  });

  it("coalesces CONCURRENT asks for different releases of one film into one blob fetch", async () => {
    // The sequential case above (await a; await b) passes even without any
    // dedupe of the blob fetch itself, because by the time b runs, a has
    // already populated the blob cache. The real scenario — renderResults()
    // mounting every row of a snapshot frame at once — is concurrent: three
    // different releases of one film, each a release-name miss, each resolving
    // to the same posterUrl before any of them has fetched its bytes. Without
    // a fetch-level dedupe keyed by posterUrl, each would call fetchBlob and
    // mint its own object URL, and the last `blobs.set` would win while the
    // others leaked.
    const { cache, blobCalls } = harness();
    const all = await Promise.all([
      cache.want("Tin.Rivers.2024.2160p.WEB-DL.x265-A", "Movies"),
      cache.want("Tin.Rivers.2024.1080p.BluRay.x264-B", "Movies"),
      cache.want("Tin.Rivers.2024.720p.HDTV.x264-C", "Movies"),
    ]);
    expect(blobCalls).toEqual(["https://m.media-amazon.com/tinrivers.jpg"]);
    expect(all).toEqual([
      { kind: "poster", url: "blob:1" },
      { kind: "poster", url: "blob:1" },
      { kind: "poster", url: "blob:1" },
    ]);
  });

  it("reports 'none' to every concurrent asker when the shared blob fetch fails, and lets a later ask retry", async () => {
    let blobAttempts = 0;
    const { cache } = harness({
      fetchBlob: async () => {
        blobAttempts += 1;
        return null;
      },
    });
    const all = await Promise.all([
      cache.want("Tin.Rivers.2024.2160p.WEB-DL.x265-A", "Movies"),
      cache.want("Tin.Rivers.2024.1080p.BluRay.x264-B", "Movies"),
    ]);
    expect(all).toEqual([{ kind: "none" }, { kind: "none" }]);
    expect(blobAttempts).toBe(1);

    // A fresh release of the same film is not stuck behind the failed fetch —
    // the in-flight entry cleaned itself up, so this one gets to retry rather
    // than being permanently answered "none" for a fetch that never happened.
    await cache.want("Tin.Rivers.2024.720p.HDTV.x264-C", "Movies");
    expect(blobAttempts).toBe(2);
  });

  it("clearing mid-flight on a shared blob fetch revokes at most once and writes nothing back", async () => {
    let resolveBlob!: (url: string | null) => void;
    const { cache, revoked } = harness({
      fetchBlob: () => new Promise<string | null>((resolve) => (resolveBlob = resolve)),
    });
    const a = cache.want("Tin.Rivers.2024.2160p.WEB-DL.x265-A", "Movies");
    const b = cache.want("Tin.Rivers.2024.1080p.BluRay.x264-B", "Movies");
    // Let both releases' fetchMeta calls settle and join the one in-flight
    // blob fetch, before it resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A new search starts while the shared blob fetch is still in flight.
    cache.clear();
    resolveBlob("blob:1");
    const [outcomeA, outcomeB] = await Promise.all([a, b]);
    expect(outcomeA).toEqual({ kind: "none" });
    expect(outcomeB).toEqual({ kind: "none" });
    // One revoke, not two — both askers shared one decision, not one each.
    expect(revoked).toEqual(["blob:1"]);
    expect(cache.peek("Tin.Rivers.2024.2160p.WEB-DL.x265-A")).toBeUndefined();
    expect(cache.peek("Tin.Rivers.2024.1080p.BluRay.x264-B")).toBeUndefined();
  });

  it("a release that goes stale mid-flight does not poison a live release naming the same poster", async () => {
    // X's want() is captured under the OLD generation, but clear() lands
    // before X's own metadata even arrives — so X only discovers it is stale
    // once its lookup resumes and reaches the blob fetch. If X were allowed to
    // become the shared blobPending owner for this posterUrl at that point, Y
    // — a row of the NEW search naming the very same poster (the ordinary case
    // of the same film reappearing after a query refinement) — would attach to
    // X's entry and inherit X's stale verdict: `none`, for a poster it very
    // much still wants.
    let releaseXMeta!: (meta: PublicTitleMeta) => void;
    let releaseXBlob!: (url: string | null) => void;
    const posterUrl = "https://m.media-amazon.com/tinrivers.jpg";
    const blobCalls: string[] = [];
    let blobs = 0;
    const deps: PosterDeps = {
      fetchMeta: async (release) =>
        release === "X.2024"
          ? new Promise<PublicTitleMeta>((resolve) => (releaseXMeta = resolve))
          : OK(posterUrl),
      fetchBlob: async (url) => {
        blobCalls.push(url);
        // X's own fetch: held open, so it is still in flight — registered
        // under the old, buggy code — when Y arrives below.
        if (blobCalls.length === 1) {
          return new Promise<string | null>((resolve) => (releaseXBlob = resolve));
        }
        blobs += 1;
        return `blob:${blobs}`;
      },
      revoke: () => {},
    };
    const cache = createPosterCache(deps);

    const stale = cache.want("X.2024", "Movies");
    cache.clear(); // a new search starts before X's metadata even arrives
    releaseXMeta(OK(posterUrl));
    // Give X's lookup a turn to resume and reach the blob fetch, so it either
    // registers itself (the bug) or takes its untracked stale path (the fix)
    // before Y (a row of the new search) asks for the same poster, while X's
    // own fetch is still outstanding.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const livePromise = cache.want("Y.2024", "Movies");
    // Unblock X's fetch now that Y has had its chance to (wrongly) attach to
    // it. A correct implementation is unaffected — Y's own fetch is separate
    // and already resolved on its own by this point.
    releaseXBlob("blob:x-stale");
    const live = await livePromise;
    // Y gets its own, independent fetch — not X's stale, revoked one.
    expect(live).toEqual({ kind: "poster", url: "blob:1" });
    expect(blobCalls).toEqual([posterUrl, posterUrl]);

    expect(await stale).toEqual({ kind: "none" });
  });

  it("carries no-key out rather than flattening it to 'no poster'", async () => {
    const { cache, blobCalls } = harness({
      fetchMeta: async () => ({ status: "no-key" }),
    });
    const outcome = await cache.want("Tin.Rivers.2024", "Movies");
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
    await cache.want("Tin.Rivers.2024", "Movies");
    cache.clear();
    // Each object URL holds its JPEG in memory until revoked; a session of
    // searches would otherwise accumulate every poster it ever loaded.
    expect(revoked).toEqual(["blob:1"]);
    expect(cache.peek("Tin.Rivers.2024")).toBeUndefined();
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
    const pending = cache.want("Tin.Rivers.2024", "Movies");
    // A new search starts while the lookup is in flight.
    cache.clear();
    release(OK("https://m.media-amazon.com/tinrivers.jpg"));
    await pending;
    // The blob was created for a row nobody is showing any more; revoked rather
    // than leaked back into an emptied cache, and NOT resurrected into it — a
    // late answer must not re-populate a cache that moved on.
    expect(revoked).toEqual(["blob:1"]);
    expect(cache.peek("Tin.Rivers.2024")).toBeUndefined();
  });

  it("a stale fetch's late finally must not evict a newer fetch's still-in-flight entry for the same poster URL", async () => {
    // Two guards work together here, and this test is the only coverage for
    // either: fetchBlobFor's `if (blobAttempt.get(posterUrl) === attempt)`
    // before deleting from blobPending (an unconditional delete would let a
    // stale fetch's finally evict a live one), and clear()'s own
    // `blobPending.clear()` (removing it would let a post-clear want() reuse a
    // dead generation's still-open fetch instead of starting its own).
    const posterUrl = "https://m.media-amazon.com/tinrivers.jpg";
    let resolveFirst!: (url: string | null) => void;
    let resolveSecond: ((url: string | null) => void) | undefined;
    const blobCalls: string[] = [];
    let call = 0;
    const { cache, revoked } = harness({
      fetchBlob: async (url) => {
        call += 1;
        blobCalls.push(url);
        if (call === 1) return new Promise<string | null>((resolve) => (resolveFirst = resolve));
        if (call === 2) return new Promise<string | null>((resolve) => (resolveSecond = resolve));
        // A third call means the second's in-flight entry was wrongly evicted
        // and this want() started its own redundant fetch instead of sharing it.
        return "blob:third-leak-should-never-happen";
      },
    });

    // Starts the first blob fetch for posterUrl, held open.
    const first = cache.want("A.2024", "Movies");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A new search starts while it is still in flight.
    cache.clear();

    // Same release name, but a fresh generation: the release-level caches were
    // just emptied by clear(), so this is a genuine new lookup, not a hit on
    // the pending map above fetchBlobFor.
    const second = cache.want("A.2024", "Movies");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Pinned here, BEFORE resolveFirst, so a removed `blobPending.clear()`
    // fails this assertion cleanly instead of hanging the test: without it,
    // `second` reuses the first (dead-generation) fetch's still-open promise
    // rather than starting its own, so only one fetchBlob call has happened
    // by this point.
    expect(blobCalls).toEqual([posterUrl, posterUrl]);

    // The first fetch resolves late, for a generation nobody is looking at.
    resolveFirst("blob:stale");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A different release naming the same poster URL, still in the live
    // generation, while the second fetch is still outstanding: it must
    // coalesce with the second fetch, not start a third one.
    const third = cache.want("B.2024", "Movies");

    resolveSecond?.("blob:live");
    const [outcomeFirst, outcomeSecond, outcomeThird] = await Promise.all([first, second, third]);

    expect(outcomeFirst).toEqual({ kind: "none" });
    expect(outcomeSecond).toEqual({ kind: "poster", url: "blob:live" });
    expect(outcomeThird).toEqual({ kind: "poster", url: "blob:live" });
    expect(blobCalls).toEqual([posterUrl, posterUrl]);
    // Exactly one revoke: the stale first fetch's late answer, and nothing else.
    expect(revoked).toEqual(["blob:stale"]);
  });

  it("passes the group through so the server can hint OMDb's type", async () => {
    const groups: string[] = [];
    const { cache } = harness({
      fetchMeta: async (_release, group) => {
        groups.push(group);
        return OK("https://m.media-amazon.com/x.jpg");
      },
    });
    await cache.want("Harrowgate.S03", "TV");
    expect(groups).toEqual(["TV"]);
  });
});
