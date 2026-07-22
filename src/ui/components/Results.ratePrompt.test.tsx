import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Results } from "./Results";
import type { DownloadQueue } from "../../download/queue";
import type { TorrentResult } from "../../sources/types";

// Results renders results from useConcurrentSearch, which performs real
// network fetches. Stub it with a single fixed result so the `d` keybinding
// has something to act on, without needing a network harness.
const sampleResult: TorrentResult = {
  infoHash: "abc123",
  name: "Sample Movie",
  sizeBytes: 0,
  seeders: 1,
  leechers: 0,
  source: "yts",
  magnet: "magnet:?xt=urn:btih:abc123",
};

vi.mock("../hooks/useConcurrentSearch", () => ({
  useConcurrentSearch: () => ({
    results: [sampleResult],
    perSource: {},
    loading: false,
    done: 1,
    total: 1,
  }),
}));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function baseStore(overrides: Partial<Store> = {}): Store {
  const queue = {
    getItems: () => [],
    getHistory: () => [],
    on: () => {},
    off: () => {},
  } as unknown as DownloadQueue;

  return {
    query: "",
    submitQuery: () => {},
    searchHistory: [],
    disabledSources: [],
    section: "all",
    region: "content",
    setRegion: () => {},
    setCaptureMode: () => {},
    requestP2PDownload: vi.fn(),
    requestDownloadTo: () => {},
    startDebridDownload: () => {},
    streamResult: () => {},
    debridConfigured: false,
    copyMagnet: () => {},
    contentWidth: 80,
    listRows: 20,
    queue,
    sort: "none",
    setSort: () => {},
    toggleSavedSearch: () => {},
    toggleFavourite: () => {},
    isFavourited: () => false,
    ...overrides,
  } as unknown as Store;
}

describe("Results — rate-prompt input isolation", () => {
  it("pressing 'd' downloads the selected result when focused (sanity check)", async () => {
    const store = baseStore({ region: "content" });
    const { stdin } = render(
      <StoreContext.Provider value={store}>
        <Results />
      </StoreContext.Provider>,
    );
    await flush();
    stdin.write("d");
    await flush();
    expect(store.requestP2PDownload).toHaveBeenCalled();
  });

  it("pressing 'd' does NOT trigger a download while a prompt (e.g. the rate prompt) is open", async () => {
    // App.tsx derives store.region as "help" whenever any modal/prompt
    // (including ratePrompt) is open, which deactivates Results' useInput
    // subscriptions via `isActive`. This guards that invariant.
    const store = baseStore({ region: "help" });
    const { stdin } = render(
      <StoreContext.Provider value={store}>
        <Results />
      </StoreContext.Provider>,
    );
    await flush();
    stdin.write("d");
    await flush();
    expect(store.requestP2PDownload).not.toHaveBeenCalled();
  });
});
