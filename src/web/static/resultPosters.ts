// Poster artwork for search results, and the caching that makes it affordable.
//
// WHY THIS IS A MODULE AND NOT A FEW LINES IN app.ts. The results list is
// rebuilt on EVERY snapshot frame, and up to 23 of those arrive during one
// search (see startSearch's `results` listener). A row that started its own
// lookup on mount would therefore fire 23 lookups and create 23 object URLs,
// leaking 22 of them — so "have I already answered this?" has to live somewhere
// with a memory, and somewhere a test can reach.
//
// The For You feed solved the same problem inline for its ~20 cards. This is
// that solution extracted, with one change: the blob cache is keyed by the
// POSTER URL rather than by the release name, because fifty releases of one film
// name the same artwork and there is no reason to hold fifty copies of it.
//
// Bundled for the browser: no node:* imports, direct or transitive.
import {
  NO_KEY_POSTER_NOTE,
  NO_POSTER_NOTE,
  OMDB_KEY_HINT,
} from "./previewModel";
import { previewApplies } from "./searchModel";
import type { PublicTitleMeta } from "../wire";

/**
 * What a row's poster frame ended up as.
 *
 * `no-key` is carried out rather than flattened into `none` for the reason the
 * feed's own outcome type states: with no OMDb key every row answers the same
 * way, and a reader given twenty bare "No poster" boxes concludes the feature is
 * broken instead of that they are one setting away from artwork.
 */
export type PosterOutcome =
  | { kind: "poster"; url: string }
  | { kind: "no-key" }
  | { kind: "none" };

/** The two round trips and the cleanup, injected so this is testable without a DOM. */
export interface PosterDeps {
  /** `GET /api/title?release=&group=`. Null for any failure. */
  fetchMeta(release: string, group: string): Promise<PublicTitleMeta | null>;
  /** `GET /api/poster?url=` as a blob, returned as an object URL. Null for any failure. */
  fetchBlob(posterUrl: string): Promise<string | null>;
  /** `URL.revokeObjectURL`. */
  revoke(url: string): void;
}

export interface PosterCache {
  /**
   * The outcome for a release: synchronously when it is already known, a promise
   * when it has to be looked up. Concurrent asks for one release share a single
   * lookup.
   */
  want(release: string, group: string): PosterOutcome | Promise<PosterOutcome>;
  /** The settled outcome for a release, or undefined. No fetching. */
  peek(release: string): PosterOutcome | undefined;
  /** Drop everything and revoke every blob. Called when a new search starts. */
  clear(): void;
  /** The page's single "no OMDb key" sentence, or null. */
  hint(): string | null;
  /** What one empty frame should say. */
  note(outcome: PosterOutcome): string;
}

/**
 * Whether to fetch artwork for this tab at all.
 *
 * `previewApplies` is the existing predicate for "does OMDb know about this
 * category" (All, Movies, TV, Anime) and is reused rather than duplicated. The
 * key check is the other half, and it is the one that matters for cost: with no
 * key configured every lookup would return `no-key`, so a keyless server should
 * make none of them.
 */
export function postersApply(group: string, omdbConfigured: boolean): boolean {
  return omdbConfigured && previewApplies(group);
}

/**
 * The page's single "no OMDb key" line, for the current tab.
 *
 * TWO SOURCES, and the second is the one that matters. `cacheHint` (the
 * cache's own `hint()`) answers from the lookups that were actually made —
 * but with no key configured `postersApply` makes NONE, so that source would
 * stay silent on exactly the install that needs the sentence. `omdbConfigured`
 * is therefore checked first, gated on the tab having artwork to miss: a
 * Games tab has no posters to explain and must not carry a note about a key
 * it would never use.
 *
 * `cacheHint` still matters for the race — a key revoked mid-session, where
 * lookups were made and came back `no-key`.
 *
 * `omdbConfigured: null` means `/api/sources` has not answered yet — answer
 * null rather than flash "add a key" before the page even knows whether one
 * is configured. BOTH sources are gated on `previewApplies(group)`, not just
 * the no-key branch: today a `no-key` outcome can only land in `cacheHint` on
 * a tab where lookups are made in the first place, so the asymmetry is
 * unreachable — but gating only one branch is a trap for whoever changes that
 * later.
 */
export function searchHint(
  omdbConfigured: boolean | null,
  group: string,
  cacheHint: string | null,
): string | null {
  if (omdbConfigured === null) return null;
  if (!previewApplies(group)) return null;
  if (!omdbConfigured) return OMDB_KEY_HINT;
  return cacheHint;
}

export function createPosterCache(deps: PosterDeps): PosterCache {
  // Settled outcomes by release name. The release name is the key here (not the
  // parsed title) because it is what a row has; the server's own cache collapses
  // release names to titles behind /api/title, so fifty releases of one film
  // still cost one OMDb call.
  const settled = new Map<string, PosterOutcome>();
  // Lookups in flight, so 23 re-renders share one.
  const pending = new Map<string, Promise<PosterOutcome>>();
  // Object URLs by POSTER url, so different releases of one film share a blob.
  const blobs = new Map<string, string>();
  // Blob fetches in flight, keyed by POSTER URL — the second dedupe this module
  // needs and `pending` above cannot provide, because `pending` is keyed by
  // release name. Fifty releases of one film are fifty distinct release-name
  // misses that each resolve to the same posterUrl; without this map, each of
  // those fifty would call fetchBlob and mint its own object URL, and the last
  // `blobs.set` would win while the other forty-nine leaked.
  const blobPending = new Map<string, Promise<string | null>>();
  // The attempt number current for a given poster URL, so a settling fetch can
  // tell whether it is still the one blobPending points at (see below) without
  // referencing its own promise before that promise finishes initializing.
  const blobAttempt = new Map<string, number>();
  // Bumped by clear(). An answer stamped with an older generation belongs to a
  // search that is gone: its blob is revoked and it is NOT written back, or a
  // slow answer would resurrect a cache that has moved on.
  let generation = 0;

  // Fetches the bytes for a poster URL, coalescing concurrent askers into one
  // deps.fetchBlob call and one decision about the result. The decision (keep
  // vs revoke-because-stale) is made exactly once, by whichever caller happens
  // to create the shared promise, and baked into the value every awaiter
  // receives — so there is no way for two callers to race each other into a
  // double revoke.
  //
  // A caller can arrive here already stale: `forGeneration` is captured back in
  // `want()`, but fetchMeta's own await sits between that capture and this
  // call, and a clear() can land in that gap. Such a caller must NEVER become
  // the shared entry's owner — if it did, a live caller for the same posterUrl
  // (e.g. the same film appearing again after a query refinement) would attach
  // to it and inherit a dead search's verdict, receiving `none` for a poster
  // that is very much still wanted. So a stale caller gets its own private
  // fetch-and-revoke below, untracked, and only a caller whose generation is
  // still current is allowed to register in `blobPending`.
  function fetchBlobFor(posterUrl: string, forGeneration: number): Promise<string | null> {
    if (forGeneration !== generation) {
      // want()'s own generation guard discards whatever this caller gets back
      // either way, but the brief's own contract is that a stale answer still
      // revokes its blob rather than leaking it — so still fetch, still revoke,
      // just never publish it for a live caller to find.
      return (async (): Promise<string | null> => {
        const url = await deps.fetchBlob(posterUrl);
        if (url !== null) deps.revoke(url);
        return null;
      })();
    }

    const inflight = blobPending.get(posterUrl);
    if (inflight !== undefined) return inflight;

    const attempt = (blobAttempt.get(posterUrl) ?? 0) + 1;
    blobAttempt.set(posterUrl, attempt);

    const posterFetch = (async (): Promise<string | null> => {
      try {
        const url = await deps.fetchBlob(posterUrl);
        if (url === null) return null;
        if (forGeneration !== generation) {
          // Created for a search nobody is looking at. Revoke rather than
          // leak, and do not record it.
          deps.revoke(url);
          return null;
        }
        blobs.set(posterUrl, url);
        return url;
      } finally {
        // Guarded by attempt number: clear() may already have dropped this
        // entry from blobPending (or a newer fetch for the same posterUrl may
        // already have replaced it), and an unconditional delete here would
        // erase that newer entry out from under its own still-in-flight fetch.
        if (blobAttempt.get(posterUrl) === attempt) blobPending.delete(posterUrl);
      }
    })();
    blobPending.set(posterUrl, posterFetch);
    return posterFetch;
  }

  async function lookup(release: string, group: string, forGeneration: number): Promise<PosterOutcome> {
    const meta = await deps.fetchMeta(release, group);
    if (!meta) return { kind: "none" };
    if (meta.status === "no-key") return { kind: "no-key" };
    if (meta.status !== "ok" || !meta.posterUrl) return { kind: "none" };

    const posterUrl = meta.posterUrl;
    const existing = blobs.get(posterUrl);
    // Only valid if it belongs to this generation — clear() emptied the map, so
    // a hit here is necessarily current.
    if (existing !== undefined) return { kind: "poster", url: existing };

    const url = await fetchBlobFor(posterUrl, forGeneration);
    if (url === null) return { kind: "none" };
    return { kind: "poster", url };
  }

  return {
    want(release, group) {
      const hit = settled.get(release);
      if (hit !== undefined) return hit;
      const inflight = pending.get(release);
      if (inflight !== undefined) return inflight;

      const forGeneration = generation;
      const promise = lookup(release, group, forGeneration)
        // Every failure path ends at a labelled frame. A throw here would leave
        // the frame saying "Loading" for the life of the page.
        .catch((): PosterOutcome => ({ kind: "none" }))
        .then((outcome) => {
          pending.delete(release);
          // A clear() while this was in flight: drop it. lookup() has already
          // revoked any blob it made.
          if (forGeneration !== generation) return { kind: "none" } as PosterOutcome;
          settled.set(release, outcome);
          return outcome;
        });
      pending.set(release, promise);
      return promise;
    },

    peek(release) {
      return settled.get(release);
    },

    clear() {
      generation += 1;
      for (const url of blobs.values()) deps.revoke(url);
      blobs.clear();
      settled.clear();
      pending.clear();
      // A blob fetch already in flight for this generation must not be handed
      // to a caller in the next one — a fresh want() for the same posterUrl
      // starts its own fetch rather than awaiting a promise for a search that
      // just ended. The in-flight fetch itself keeps running; its own stale
      // check (above) revokes the URL it eventually produces.
      blobPending.clear();
      // Deliberately NOT cleared: `blobAttempt` numbers must keep counting up
      // across generations. If they reset to 1 here, a fetch already in flight
      // stamped attempt 1 would collide with the next generation's first fetch
      // for the same posterUrl — also stamped 1 — and whichever of the two
      // settles first would delete the other's still-in-flight blobPending
      // entry. The cost is one small int retained per poster URL ever seen in
      // the session, alongside `blobs` itself, which already grows the same way.
    },

    hint() {
      // One answer is enough to know, and waiting for all of them would leave
      // the frames unexplained meanwhile. A `none` must never trigger it: with a
      // key configured, an obscure title with no artwork would otherwise tell
      // the user to add a key they already have.
      for (const outcome of settled.values()) {
        if (outcome.kind === "no-key") return OMDB_KEY_HINT;
      }
      return null;
    },

    note(outcome) {
      // The search pane's own wording, from the search pane's own constants: one
      // condition must not be described two ways on two tabs.
      return outcome.kind === "no-key" ? NO_KEY_POSTER_NOTE : NO_POSTER_NOTE;
    },
  };
}
