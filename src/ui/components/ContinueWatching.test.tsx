import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ContinueWatching } from "./ContinueWatching";
import { makeTestStore } from "../testHarness";
import type { StreamHistoryItem } from "../../core/streamHistory";
import type { SourceId } from "../../sources/types";

const item = (over: Partial<StreamHistoryItem>): StreamHistoryItem => ({
  key: "k", title: "Kepler", rawName: "Kepler.S02E04.1080p.WEB-DL",
  infoHash: "abc", magnet: "magnet:?xt=urn:btih:abc", startedAt: 0,
  type: "series", season: 2, episode: 4, ...over,
});

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); };

// `vi.mock` is HOISTED above the imports; `vi.doMock` is not, and would be a
// no-op here because `ContinueWatching` resolves `useStore` at module load.
// The mock therefore reads a mutable holder that each test reassigns.
let store = makeTestStore();
// `testHarness` pulls in `Sidebar` (for `RAIL_WIDTH`), which imports `CATEGORIES`
// from this same module at load time — so the mock must keep the real
// non-hook exports and only swap `useStore`.
vi.mock("../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store")>();
  return { ...actual, useStore: () => store };
});

function renderWith(overrides: Parameters<typeof makeTestStore>[0]) {
  store = makeTestStore({ region: "content", section: "continueWatching", ...overrides });
  return render(<ContinueWatching />);
}

describe("ContinueWatching Enter", () => {
  it("auto-plays the next episode", async () => {
    const played: unknown[] = [];
    const { stdin } = renderWith({
      streamHistory: [item({})],
      autoPlayTitle: (title, intent) => played.push({ title, intent }),
    });
    await flush();
    stdin.write("\r");
    await flush();
    expect(played).toEqual([{ title: "Kepler", intent: { kind: "episode", season: 2, episode: 5 } }]);
  });

  it("resumes the stored torrent when there is no honest next episode", async () => {
    const played: unknown[] = [];
    const resumed: string[] = [];
    const { stdin } = renderWith({
      // A season pack: type series, season known, episode unknown.
      streamHistory: [item({ rawName: "Harrowgate.S03.1080p.WEB-DL", title: "Harrowgate", season: 3, episode: undefined })],
      autoPlayTitle: (t) => played.push(t),
      openStreamHistory: (i) => resumed.push(i.title),
    });
    await flush();
    stdin.write("\r");
    await flush();
    expect(played).toEqual([]);
    expect(resumed).toEqual(["Harrowgate"]);
  });

  it("resumes a film rather than searching", async () => {
    const played: unknown[] = [];
    const resumed: string[] = [];
    const { stdin } = renderWith({
      streamHistory: [item({ title: "Kestrel", type: "movie", season: undefined, episode: undefined })],
      autoPlayTitle: (t) => played.push(t),
      openStreamHistory: (i) => resumed.push(i.title),
    });
    await flush();
    stdin.write("\r");
    await flush();
    expect(played).toEqual([]);
    expect(resumed).toEqual(["Kestrel"]);
  });

  it("r always resumes the remembered torrent, even when a next episode is known", async () => {
    const played: unknown[] = [];
    const resumed: string[] = [];
    const searched: string[] = [];
    const { stdin } = renderWith({
      streamHistory: [item({})], // Kepler S02E04 — nextEpisode(item) is non-null here
      autoPlayTitle: (t) => played.push(t),
      openStreamHistory: (i) => resumed.push(i.title),
      submitQuery: (q: string) => searched.push(q),
    });
    await flush();
    stdin.write("r");
    await flush();
    expect(resumed).toEqual(["Kepler"]);
    expect(played).toEqual([]);
    expect(searched).toEqual([]);
  });

  it("s searches without playing", async () => {
    const played: unknown[] = [];
    const searched: string[] = [];
    const sections: string[] = [];
    const { stdin } = renderWith({
      streamHistory: [item({})],
      autoPlayTitle: (t) => played.push(t),
      submitQuery: (q: string) => searched.push(q),
      setSection: (s: string) => sections.push(s),
    });
    await flush();
    stdin.write("s");
    await flush();
    expect(played).toEqual([]);
    expect(searched).toEqual(["Kepler"]);
    expect(sections).toEqual(["all"]);
  });
});

describe("ContinueWatching category tabs", () => {
  it("shows an All tab alongside the one category present, even when every item shares it", async () => {
    const { lastFrame } = renderWith({
      streamHistory: [item({ source: "eztv" as SourceId }), item({ key: "k2", source: "eztv" as SourceId })],
    });
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("All");
    expect(frame).toContain("TV");
  });

  it("[ and ] cycle tabs and filter the list, wrapping at the ends", async () => {
    const { stdin, lastFrame } = renderWith({
      streamHistory: [
        item({ key: "tv", title: "Kepler", source: "eztv" as SourceId }),
        item({ key: "movie", title: "Ashfall", type: "movie", season: undefined, episode: undefined, source: "yts" as SourceId }),
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

  it("tabs whatever categories are present in streamHistory, including Porn — adult filtering happens upstream in App.tsx, not here", async () => {
    // This component has no adult-specific logic: App.tsx filters adult items
    // out of the Store's streamHistory field before this component ever sees
    // it (gated by adultHistoryVisible). A Porn item reaching this component at
    // all means the setting was on, in which case it gets a tab like any other
    // category — pinned here so a future refactor can't quietly duplicate the
    // filter (or its absence) at this layer.
    const { lastFrame } = renderWith({
      streamHistory: [item({ source: "eztv" as SourceId }), item({ key: "k2", source: "tpb-porn" as SourceId })],
    });
    await flush();
    expect(lastFrame()).toContain("Porn");
  });
});
