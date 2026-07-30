import { describe, expect, it } from "vitest";
import {
  applyContinueWatchingResponse,
  applyLibraryResponse,
  applySaved,
  applySavedSearchesResponse,
  continueWatchingFallbackQuery,
  continueWatchingStatus,
  continueWatchingSub,
  emptySaved,
  favouriteLabel,
  favouriteMeta,
  isInLibrary,
  libraryBody,
  libraryStatus,
  libraryToggleNotice,
  relativeAge,
  savedSearchesBody,
  savedSearchesStatus,
  savedSearchesToggleNotice,
  type SavedState,
} from "./savedModel";
import type { PublicFavourite, PublicStreamHistoryItem } from "../wire";

const HASH = "b".repeat(40);

function favourite(over: Partial<PublicFavourite> = {}): PublicFavourite {
  return { id: HASH, name: "Kepler.S02.1080p", addedAt: 1_700_000_000_000, watched: 0, ...over };
}

function loaded(over: Partial<SavedState> = {}): SavedState {
  return { ...emptySaved(), loaded: true, ...over };
}

const base: PublicStreamHistoryItem = {
  key: "k",
  title: "Kepler",
  type: "series",
  season: 2,
  episode: 4,
  next: { season: 2, episode: 5 },
  rawName: "Kepler.S02E04.1080p",
  infoHash: "a".repeat(40),
  startedAt: 1_700_000_000_000,
};
// Exactly 86,400,000 ms after `base.startedAt`, so "1 day ago" is arithmetic
// rather than a guess about how the formatter rounds.
const A_DAY_LATER = 1_700_086_400_000;

describe("emptySaved", () => {
  it("opens unloaded with no error, so the pane can say 'loading' rather than 'empty'", () => {
    // These are different sentences to a user: an empty library and a library
    // that has not arrived yet must not read the same.
    expect(emptySaved()).toEqual({
      savedSearches: [],
      library: [],
      continueWatching: [],
      loaded: false,
      error: null,
    });
  });
});

describe("savedSearchesBody", () => {
  it("sends the query and the action", () => {
    expect(savedSearchesBody("tin rivers", "toggle")).toEqual({
      query: "tin rivers",
      action: "toggle",
    });
    expect(savedSearchesBody("tin rivers", "remove")).toEqual({
      query: "tin rivers",
      action: "remove",
    });
  });

  it("trims, so the box's stray spaces cannot create a second entry", () => {
    expect(savedSearchesBody("  tin rivers  ", "toggle").query).toBe("tin rivers");
  });
});

describe("libraryBody", () => {
  it("carries the name, which is what becomes the magnet's dn server-side", () => {
    expect(
      libraryBody(
        { infoHash: HASH, name: "Kepler.S02.1080p", sizeBytes: 24_000_000_000, source: "eztv" },
        "toggle",
      ),
    ).toEqual({
      infoHash: HASH,
      name: "Kepler.S02.1080p",
      sizeBytes: 24_000_000_000,
      source: "eztv",
      action: "toggle",
    });
  });

  it("omits sizeBytes and source when absent rather than sending zero or empty", () => {
    const body = libraryBody({ infoHash: HASH, name: "Kepler" }, "remove");
    expect(body).toEqual({ infoHash: HASH, name: "Kepler", action: "remove" });
    expect("sizeBytes" in body).toBe(false);
    expect("source" in body).toBe(false);
  });

  it("omits a zero size — the server treats >0 as known and 0 would read as known-and-empty", () => {
    const body = libraryBody({ infoHash: HASH, name: "Kepler", sizeBytes: 0 }, "toggle");
    expect("sizeBytes" in body).toBe(false);
  });

  it("includes the filename for watched and omits it otherwise", () => {
    expect(libraryBody({ infoHash: HASH, name: "S" }, "watched", "ep1.mkv")).toEqual({
      infoHash: HASH,
      name: "S",
      action: "watched",
      filename: "ep1.mkv",
    });
    const toggled = libraryBody({ infoHash: HASH, name: "S" }, "toggle", "ep1.mkv");
    expect("filename" in toggled).toBe(false);
  });
});

describe("isInLibrary / favouriteLabel", () => {
  it("matches on the info hash", () => {
    const state = loaded({ library: [favourite()] });
    expect(isInLibrary(state, HASH)).toBe(true);
    expect(isInLibrary(state, "c".repeat(40))).toBe(false);
  });

  it("labels the button by what it will do, not by the current state", () => {
    // A button reading "favourited" invites a click that un-favourites, which
    // is the opposite of what it appears to promise.
    expect(favouriteLabel(false)).toBe("favourite");
    expect(favouriteLabel(true)).toBe("unfavourite");
  });
});

describe("favouriteMeta", () => {
  it("reports the watched count and the size", () => {
    expect(favouriteMeta(favourite({ watched: 3, sizeBytes: 24_000_000_000 }))).toBe(
      "3 watched · 22.35 GB",
    );
  });

  it("reports a single watched episode the same way as any other count", () => {
    // Named for what this actually pins: favouriteMeta's "N watched" is a bare
    // template string with no singular/plural branch, so 1 reads "1 watched"
    // rather than "1 watch" — there is no singularising logic to test here.
    expect(favouriteMeta(favourite({ watched: 1 }))).toBe("1 watched");
  });

  it("says nothing about zero watched — a fresh favourite is not '0 watched'", () => {
    expect(favouriteMeta(favourite({ watched: 0, sizeBytes: 24_000_000_000 }))).toBe("22.35 GB");
  });

  it("says size unknown rather than 0 B", () => {
    expect(favouriteMeta(favourite({ watched: 0 }))).toBe("size unknown");
  });
});

describe("savedSearchesStatus / libraryStatus", () => {
  it("says loading before the first response, not empty", () => {
    expect(savedSearchesStatus(emptySaved())).toEqual({ text: "Loading…", show: true, tone: "dim" });
    expect(libraryStatus(emptySaved())).toEqual({ text: "Loading…", show: true, tone: "dim" });
  });

  it("explains how to fill each list when it is empty", () => {
    expect(savedSearchesStatus(loaded())).toEqual({
      text: "Save a search to keep it here.",
      show: true,
      tone: "dim",
    });
    expect(libraryStatus(loaded())).toEqual({
      text: "Favourite a result to keep it here.",
      show: true,
      tone: "dim",
    });
  });

  it("hides the line once there are rows to look at", () => {
    expect(savedSearchesStatus(loaded({ savedSearches: ["tin rivers"] })).show).toBe(false);
    expect(libraryStatus(loaded({ library: [favourite()] })).show).toBe(false);
  });

  it("shows an error over both lists, and outranks having rows", () => {
    // A stale list next to no explanation is worse than a stale list with one:
    // the user needs to know these rows may not reflect the server.
    const broken = loaded({ savedSearches: ["tin rivers"], error: "Can't reach torlnk." });
    expect(savedSearchesStatus(broken)).toEqual({
      text: "Can't reach torlnk.",
      show: true,
      tone: "error",
    });
    expect(libraryStatus(broken).tone).toBe("error");
  });

  it("shows the error even before the first load has completed — the error check must run before the loaded check", () => {
    // Both loaded:false and error set is the one fixture that actually pins
    // statusFor's stated precedence: with no fixture combining them, swapping
    // the order of the error check and the !loaded check left every other
    // test green.
    const brokenBeforeLoad = { ...emptySaved(), error: "Can't reach torlnk." };
    expect(savedSearchesStatus(brokenBeforeLoad)).toEqual({
      text: "Can't reach torlnk.",
      show: true,
      tone: "error",
    });
  });
});

describe("applySaved", () => {
  it("takes the server's lists and marks the state loaded, clearing any error", () => {
    const next = applySaved(loaded({ error: "old failure" }), {
      savedSearches: ["tin rivers"],
      library: [favourite()],
      continueWatching: [base],
    });
    expect(next.savedSearches).toEqual(["tin rivers"]);
    expect(next.library).toHaveLength(1);
    expect(next.continueWatching).toEqual([base]);
    expect(next.loaded).toBe(true);
    expect(next.error).toBeNull();
  });

  it("tolerates a malformed response rather than throwing on the page", () => {
    // The body is whatever came back over the network; a proxy error page
    // parses to something that is not this shape at all.
    const next = applySaved(emptySaved(), {});
    expect(next).toEqual({
      savedSearches: [],
      library: [],
      continueWatching: [],
      loaded: true,
      error: null,
    });
  });

  it("tolerates a null body rather than throwing on the page", () => {
    const next = applySaved(emptySaved(), null);
    expect(next).toEqual({
      savedSearches: [],
      library: [],
      continueWatching: [],
      loaded: true,
      error: null,
    });
  });
});

describe("applySavedSearchesResponse", () => {
  it("takes the server's list and marks the state loaded, clearing any error", () => {
    const next = applySavedSearchesResponse(loaded({ error: "old failure" }), { savedSearches: ["tin rivers"] });
    expect(next).toEqual({
      savedSearches: ["tin rivers"],
      library: [],
      continueWatching: [],
      loaded: true,
      error: null,
    });
  });

  it("keeps the existing list on a null body rather than emptying it", () => {
    const state = loaded({ savedSearches: ["tin rivers"] });
    expect(applySavedSearchesResponse(state, null)).toEqual(state);
  });

  it("keeps the existing list when savedSearches is missing or not an array", () => {
    const state = loaded({ savedSearches: ["tin rivers"] });
    expect(applySavedSearchesResponse(state, {})).toEqual(state);
    expect(applySavedSearchesResponse(state, { savedSearches: "tin rivers" })).toEqual(state);
  });

  it("keeps the existing list when the body itself is not an object", () => {
    const state = loaded({ savedSearches: ["tin rivers"] });
    expect(applySavedSearchesResponse(state, "tin rivers")).toEqual(state);
    expect(applySavedSearchesResponse(state, 42)).toEqual(state);
    expect(applySavedSearchesResponse(state, undefined)).toEqual(state);
  });
});

describe("applyLibraryResponse", () => {
  it("takes the server's list and marks the state loaded, clearing any error", () => {
    const next = applyLibraryResponse(loaded({ error: "old failure" }), { library: [favourite()] });
    expect(next.library).toHaveLength(1);
    expect(next.loaded).toBe(true);
    expect(next.error).toBeNull();
  });

  it("keeps the existing list on a null body rather than emptying it", () => {
    const state = loaded({ library: [favourite()] });
    expect(applyLibraryResponse(state, null)).toEqual(state);
  });

  it("keeps the existing list when library is missing or not an array", () => {
    const state = loaded({ library: [favourite()] });
    expect(applyLibraryResponse(state, {})).toEqual(state);
    expect(applyLibraryResponse(state, { library: "nope" })).toEqual(state);
  });
});

describe("savedSearchesToggleNotice", () => {
  it("says saved when the server reports saved: true", () => {
    expect(savedSearchesToggleNotice({ saved: true })).toBe("Saved to your searches.");
  });

  it("says removed for saved: false and for anything malformed", () => {
    expect(savedSearchesToggleNotice({ saved: false })).toBe("Removed from your searches.");
    expect(savedSearchesToggleNotice({})).toBe("Removed from your searches.");
    expect(savedSearchesToggleNotice(null)).toBe("Removed from your searches.");
    expect(savedSearchesToggleNotice(undefined)).toBe("Removed from your searches.");
    expect(savedSearchesToggleNotice("saved")).toBe("Removed from your searches.");
  });
});

describe("libraryToggleNotice", () => {
  it("says added when the server reports favourited: true", () => {
    expect(libraryToggleNotice({ favourited: true })).toBe("Added to your library.");
  });

  it("says removed for favourited: false and for anything malformed", () => {
    expect(libraryToggleNotice({ favourited: false })).toBe("Removed from your library.");
    expect(libraryToggleNotice({})).toBe("Removed from your library.");
    expect(libraryToggleNotice(null)).toBe("Removed from your library.");
    expect(libraryToggleNotice(undefined)).toBe("Removed from your library.");
  });
});

describe("applyContinueWatchingResponse", () => {
  it("takes the server's list and marks the state loaded, clearing any error", () => {
    const next = applyContinueWatchingResponse(loaded({ error: "old failure" }), {
      continueWatching: [base],
    });
    expect(next.continueWatching).toEqual([base]);
    expect(next.loaded).toBe(true);
    expect(next.error).toBeNull();
  });

  it("keeps the existing list on a null body rather than emptying it", () => {
    const state = loaded({ continueWatching: [base] });
    expect(applyContinueWatchingResponse(state, null)).toEqual(state);
  });

  it("keeps the existing list when continueWatching is missing or not an array", () => {
    const state = loaded({ continueWatching: [base] });
    expect(applyContinueWatchingResponse(state, {})).toEqual(state);
    expect(applyContinueWatchingResponse(state, { continueWatching: "nope" })).toEqual(state);
  });
});

describe("relativeAge", () => {
  it("says just now for anything under a minute", () => {
    expect(relativeAge(1_700_000_000_000, 1_700_000_000_000)).toBe("just now");
    expect(relativeAge(1_700_000_000_000, 1_700_000_000_000 + 59_000)).toBe("just now");
  });

  it("says 1 day ago exactly 86,400,000 ms later", () => {
    expect(relativeAge(1_700_000_000_000, 1_700_000_000_000 + 86_400_000)).toBe("1 day ago");
  });

  it("says 2 weeks ago 14 days later", () => {
    expect(relativeAge(1_700_000_000_000, 1_700_000_000_000 + 14 * 86_400_000)).toBe("2 weeks ago");
  });
});

describe("continueWatchingSub", () => {
  it("reports the last episode and the next one", () => {
    expect(continueWatchingSub(base, A_DAY_LATER)).toBe("1 day ago · last S02E04 · next S02E05");
  });

  it("omits next when there is none to offer", () => {
    // A season pack, or a film.
    expect(continueWatchingSub({ ...base, next: null }, A_DAY_LATER)).toBe("1 day ago · last S02E04");
  });

  it("says only the age for a film", () => {
    expect(
      continueWatchingSub(
        { ...base, type: "movie", season: undefined, episode: undefined, next: null },
        A_DAY_LATER,
      ),
    ).toBe("1 day ago");
  });
});

describe("continueWatchingFallbackQuery", () => {
  it("asks for the next episode when there is one", () => {
    // The remembered torrent is dead, so we search — and searching for the
    // episode you have NOT seen beats searching for the one you just watched.
    expect(continueWatchingFallbackQuery(base)).toBe("Kepler S02E05");
  });

  it("asks for the bare title when there is no next episode", () => {
    // A season pack that named no episode.
    expect(continueWatchingFallbackQuery({ ...base, next: null })).toBe("Kepler");
  });

  it("asks for the bare title for a film", () => {
    expect(
      continueWatchingFallbackQuery({
        ...base,
        title: "Tin Rivers",
        type: "movie",
        season: undefined,
        episode: undefined,
        next: null,
      }),
    ).toBe("Tin Rivers");
  });
});

describe("continueWatchingStatus", () => {
  it("says loading before the first response, not empty", () => {
    expect(continueWatchingStatus(emptySaved())).toEqual({ text: "Loading…", show: true, tone: "dim" });
  });

  it("explains how to fill it when empty", () => {
    expect(continueWatchingStatus({ ...emptySaved(), loaded: true })).toEqual({
      text: "Stream something and it will show up here.",
      show: true,
      tone: "dim",
    });
  });

  it("hides once there are rows", () => {
    const state = { ...emptySaved(), loaded: true, continueWatching: [{ ...base }] };
    expect(continueWatchingStatus(state).show).toBe(false);
  });
});
