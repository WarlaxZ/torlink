import { describe, expect, it } from "vitest";
import {
  applyLibraryResponse,
  applySaved,
  applyWatchlistResponse,
  emptySaved,
  favouriteLabel,
  favouriteMeta,
  isInLibrary,
  libraryBody,
  libraryStatus,
  libraryToggleNotice,
  watchlistBody,
  watchlistStatus,
  watchlistToggleNotice,
  type SavedState,
} from "./savedModel";
import type { PublicFavourite } from "../wire";

const HASH = "b".repeat(40);

function favourite(over: Partial<PublicFavourite> = {}): PublicFavourite {
  return { id: HASH, name: "Severance.S02.1080p", addedAt: 1_700_000_000_000, watched: 0, ...over };
}

function loaded(over: Partial<SavedState> = {}): SavedState {
  return { ...emptySaved(), loaded: true, ...over };
}

describe("emptySaved", () => {
  it("opens unloaded with no error, so the pane can say 'loading' rather than 'empty'", () => {
    // These are different sentences to a user: an empty library and a library
    // that has not arrived yet must not read the same.
    expect(emptySaved()).toEqual({ watchlist: [], library: [], loaded: false, error: null });
  });
});

describe("watchlistBody", () => {
  it("sends the query and the action", () => {
    expect(watchlistBody("dune part two", "toggle")).toEqual({
      query: "dune part two",
      action: "toggle",
    });
    expect(watchlistBody("dune part two", "remove")).toEqual({
      query: "dune part two",
      action: "remove",
    });
  });

  it("trims, so the box's stray spaces cannot create a second entry", () => {
    expect(watchlistBody("  dune  ", "toggle").query).toBe("dune");
  });
});

describe("libraryBody", () => {
  it("carries the name, which is what becomes the magnet's dn server-side", () => {
    expect(
      libraryBody(
        { infoHash: HASH, name: "Severance.S02.1080p", sizeBytes: 24_000_000_000, source: "eztv" },
        "toggle",
      ),
    ).toEqual({
      infoHash: HASH,
      name: "Severance.S02.1080p",
      sizeBytes: 24_000_000_000,
      source: "eztv",
      action: "toggle",
    });
  });

  it("omits sizeBytes and source when absent rather than sending zero or empty", () => {
    const body = libraryBody({ infoHash: HASH, name: "Severance" }, "remove");
    expect(body).toEqual({ infoHash: HASH, name: "Severance", action: "remove" });
    expect("sizeBytes" in body).toBe(false);
    expect("source" in body).toBe(false);
  });

  it("omits a zero size — the server treats >0 as known and 0 would read as known-and-empty", () => {
    const body = libraryBody({ infoHash: HASH, name: "Severance", sizeBytes: 0 }, "toggle");
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

  it("singularises one episode", () => {
    expect(favouriteMeta(favourite({ watched: 1 }))).toBe("1 watched");
  });

  it("says nothing about zero watched — a fresh favourite is not '0 watched'", () => {
    expect(favouriteMeta(favourite({ watched: 0, sizeBytes: 24_000_000_000 }))).toBe("22.35 GB");
  });

  it("says size unknown rather than 0 B", () => {
    expect(favouriteMeta(favourite({ watched: 0 }))).toBe("size unknown");
  });
});

describe("watchlistStatus / libraryStatus", () => {
  it("says loading before the first response, not empty", () => {
    expect(watchlistStatus(emptySaved())).toEqual({ text: "Loading…", show: true, tone: "dim" });
    expect(libraryStatus(emptySaved())).toEqual({ text: "Loading…", show: true, tone: "dim" });
  });

  it("explains how to fill each list when it is empty", () => {
    expect(watchlistStatus(loaded())).toEqual({
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
    expect(watchlistStatus(loaded({ watchlist: ["dune"] })).show).toBe(false);
    expect(libraryStatus(loaded({ library: [favourite()] })).show).toBe(false);
  });

  it("shows an error over both lists, and outranks having rows", () => {
    // A stale list next to no explanation is worse than a stale list with one:
    // the user needs to know these rows may not reflect the server.
    const broken = loaded({ watchlist: ["dune"], error: "Can't reach torlnk." });
    expect(watchlistStatus(broken)).toEqual({
      text: "Can't reach torlnk.",
      show: true,
      tone: "error",
    });
    expect(libraryStatus(broken).tone).toBe("error");
  });
});

describe("applySaved", () => {
  it("takes the server's lists and marks the state loaded, clearing any error", () => {
    const next = applySaved(loaded({ error: "old failure" }), {
      watchlist: ["dune"],
      library: [favourite()],
    });
    expect(next.watchlist).toEqual(["dune"]);
    expect(next.library).toHaveLength(1);
    expect(next.loaded).toBe(true);
    expect(next.error).toBeNull();
  });

  it("tolerates a malformed response rather than throwing on the page", () => {
    // The body is whatever came back over the network; a proxy error page
    // parses to something that is not this shape at all.
    const next = applySaved(emptySaved(), {} as never);
    expect(next).toEqual({ watchlist: [], library: [], loaded: true, error: null });
  });
});

describe("applyWatchlistResponse", () => {
  it("takes the server's list and marks the state loaded, clearing any error", () => {
    const next = applyWatchlistResponse(loaded({ error: "old failure" }), { watchlist: ["dune"] });
    expect(next).toEqual({ watchlist: ["dune"], library: [], loaded: true, error: null });
  });

  it("keeps the existing list on a null body rather than emptying it", () => {
    const state = loaded({ watchlist: ["dune"] });
    expect(applyWatchlistResponse(state, null)).toEqual(state);
  });

  it("keeps the existing list when watchlist is missing or not an array", () => {
    const state = loaded({ watchlist: ["dune"] });
    expect(applyWatchlistResponse(state, {})).toEqual(state);
    expect(applyWatchlistResponse(state, { watchlist: "dune" })).toEqual(state);
  });

  it("keeps the existing list when the body itself is not an object", () => {
    const state = loaded({ watchlist: ["dune"] });
    expect(applyWatchlistResponse(state, "dune")).toEqual(state);
    expect(applyWatchlistResponse(state, 42)).toEqual(state);
    expect(applyWatchlistResponse(state, undefined)).toEqual(state);
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

describe("watchlistToggleNotice", () => {
  it("says saved when the server reports saved: true", () => {
    expect(watchlistToggleNotice({ saved: true })).toBe("Saved to your watchlist.");
  });

  it("says removed for saved: false and for anything malformed", () => {
    expect(watchlistToggleNotice({ saved: false })).toBe("Removed from your watchlist.");
    expect(watchlistToggleNotice({})).toBe("Removed from your watchlist.");
    expect(watchlistToggleNotice(null)).toBe("Removed from your watchlist.");
    expect(watchlistToggleNotice(undefined)).toBe("Removed from your watchlist.");
    expect(watchlistToggleNotice("saved")).toBe("Removed from your watchlist.");
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
