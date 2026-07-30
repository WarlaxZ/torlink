import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ContinueWatching } from "./ContinueWatching";
import { makeTestStore } from "../testHarness";
import type { StreamHistoryItem } from "../../core/streamHistory";

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
