import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Favourites } from "./Favourites";
import { makeTestStore } from "../testHarness";
import type { FavouriteItem } from "../../config/config";
import type { SourceId } from "../../sources/types";

const fav = (over: Partial<FavouriteItem>): FavouriteItem => ({
  id: "a".repeat(40),
  name: "Kepler.S02.1080p.WEB-DL",
  magnet: "magnet:?xt=urn:btih:" + "a".repeat(40),
  addedAt: 0,
  ...over,
});

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
};

// See ContinueWatching.test.tsx for why the mock reads a mutable holder.
let store = makeTestStore();
vi.mock("../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store")>();
  return { ...actual, useStore: () => store };
});

function renderWith(overrides: Parameters<typeof makeTestStore>[0]) {
  store = makeTestStore({ region: "content", section: "library", ...overrides });
  return render(<Favourites />);
}

describe("Favourites Enter/x", () => {
  it("opens the row under the cursor on Enter", async () => {
    const opened: string[] = [];
    const { stdin } = renderWith({
      favourites: [fav({ id: "b".repeat(40), name: "Kestrel" }), fav({ name: "Kepler" })],
      openFavourite: (f) => opened.push(f.name),
    });
    await flush();
    stdin.write("\r");
    await flush();
    expect(opened).toEqual(["Kestrel"]);
  });

  it("removes the row under the cursor on x when no stream is active", async () => {
    const removed: string[] = [];
    const { stdin } = renderWith({
      favourites: [fav({})],
      removeFavourite: (id) => removed.push(id),
      streamActive: false,
    });
    await flush();
    stdin.write("x");
    await flush();
    expect(removed).toEqual(["a".repeat(40)]);
  });

  it("ignores x while a stream is active, so it doesn't fight the global stop binding", async () => {
    const removed: string[] = [];
    const { stdin } = renderWith({
      favourites: [fav({})],
      removeFavourite: (id) => removed.push(id),
      streamActive: true,
    });
    await flush();
    stdin.write("x");
    await flush();
    expect(removed).toEqual([]);
  });
});

describe("Favourites category tabs", () => {
  it("shows an All tab alongside the one category present, even when every item shares it", async () => {
    const { lastFrame } = renderWith({
      favourites: [fav({ source: "eztv" as SourceId }), fav({ id: "b".repeat(40), source: "eztv" as SourceId })],
    });
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("All");
    expect(frame).toContain("TV");
  });

  it("[ and ] cycle tabs and filter the list, wrapping at the ends", async () => {
    const { stdin, lastFrame } = renderWith({
      favourites: [
        fav({ id: "b".repeat(40), name: "Kepler", source: "eztv" as SourceId }),
        fav({ id: "c".repeat(40), name: "Ashfall", source: "yts" as SourceId }),
      ],
    });
    await flush();
    // Tab order is All, Movies, TV — see CATEGORY_ORDER in registry.ts.
    expect(lastFrame()).toContain("All");
    expect(lastFrame()).toContain("Kepler");
    expect(lastFrame()).toContain("Ashfall");

    stdin.write("]");
    await flush();
    expect(lastFrame()).toContain("Ashfall");
    expect(lastFrame()).not.toContain("Kepler");

    stdin.write("]");
    await flush();
    expect(lastFrame()).toContain("Kepler");
    expect(lastFrame()).not.toContain("Ashfall");

    // Wraps back to All.
    stdin.write("]");
    await flush();
    expect(lastFrame()).toContain("Kepler");
    expect(lastFrame()).toContain("Ashfall");
  });

  it("tabs whatever categories are present in favourites, including Porn — adult filtering happens upstream in App.tsx, not here", async () => {
    // This component has no adult-specific logic: App.tsx filters adult items
    // out of the Store's favourites field before this component ever sees it
    // (gated by adultHistoryVisible). A Porn item reaching this component at
    // all means the setting was on, in which case it gets a tab like any other
    // category — pinned here so a future refactor can't quietly duplicate the
    // filter (or its absence) at this layer.
    const { lastFrame } = renderWith({
      favourites: [fav({ source: "eztv" as SourceId }), fav({ id: "b".repeat(40), source: "tpb-porn" as SourceId })],
    });
    await flush();
    expect(lastFrame()).toContain("Porn");
  });
});
