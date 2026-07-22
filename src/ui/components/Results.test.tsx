import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCES } from "../../sources/registry";
import { StoreContext } from "../store";
import {
  KEY,
  makeTestStore,
  renderUI,
  TEST_CONTENT_WIDTH,
  type RenderedUI,
} from "../testHarness";
import { Results } from "./Results";
import type { ConcurrentSearchState } from "../hooks/useConcurrentSearch";
import type { TorrentResult } from "../../sources/types";

const searchState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../hooks/useConcurrentSearch", () => ({
  useConcurrentSearch: () => searchState.current,
}));

// Keep the preview pane's OMDb/poster lookups off the network. Unused by most
// tests (the default content width is below the split threshold), so they're
// only exercised by the preview test.
const omdb = vi.hoisted(() => ({ byName: vi.fn(), byId: vi.fn() }));
vi.mock("../../recc/omdb", () => ({
  fetchTitleMeta: omdb.byId,
  fetchTitleMetaByName: omdb.byName,
}));
vi.mock("../../util/poster", () => ({
  fetchPosterRows: vi.fn(async () => ["\x1b[38;2;9;9;9m▀\x1b[0m"]),
}));

const openUrl = vi.hoisted(() => vi.fn(async (_u: string) => true));
vi.mock("../../util/openUrl", () => ({
  openUrl: (u: string) => openUrl(u),
  imdbTitleUrl: (id: string) => `https://www.imdb.com/title/${id}/`,
  imdbFindUrl: (q: string) => `https://www.imdb.com/find/?q=${encodeURIComponent(q)}`,
}));

const t = (infoHash: string, name: string): TorrentResult => ({
  infoHash,
  name,
  source: "yts",
  sizeBytes: 2.1e9,
  seeders: 40,
  leechers: 6,
  magnet: `magnet:?xt=urn:btih:${infoHash}`,
  added: 1_760_000_000,
});

// Invented names. "ubuntu 24" exercises all three rank tiers: exact substring
// (a1), tokens in order (b2), tokens scattered (c3).
const LIST = [
  t("a1", "ubuntu 24.04 desktop amd64 iso"),
  t("b2", "ubuntu server 24.04 arm64 iso"),
  t("c3", "24 hour timelapse of ubuntu builds"),
  t("d4", "debian 12 netinst iso"),
  t("e5", "arch linux 2026.07 iso"),
  t("f6", "fedora workstation 42 iso"),
  t("g7", "gentoo stage3 tarball"),
  t("h8", "mint cinnamon 22 iso"),
];

function settled(results: TorrentResult[]): ConcurrentSearchState {
  const perSource = Object.fromEntries(
    SOURCES.map((s) => [s.id, { loading: false, error: null, code: null, count: 0 }]),
  ) as ConcurrentSearchState["perSource"];
  return { results, perSource, loading: false, done: SOURCES.length, total: SOURCES.length };
}

let ui: RenderedUI | null = null;
afterEach(() => {
  ui?.unmount();
  ui = null;
  omdb.byName.mockClear();
  omdb.byId.mockClear();
  openUrl.mockClear();
});

async function mount(results: TorrentResult[] = LIST): Promise<RenderedUI> {
  searchState.current = settled(results);
  ui = renderUI(
    <StoreContext.Provider value={makeTestStore({ query: "linux iso" })}>
      <Results />
    </StoreContext.Provider>,
  );
  const u = ui;
  await vi.waitFor(() => expect(u.frame()).toContain(`Results (${results.length})`));
  return u;
}

const lines = (u: RenderedUI): string[] => u.frame().split("\n");
const lineIndex = (u: RenderedUI, needle: string): number =>
  lines(u).findIndex((l) => l.includes(needle));
// The TextField cursor renders as SGR inverse; nothing else in this view does.
const editing = (u: RenderedUI): boolean => u.rawFrame().includes(`${KEY.esc}[7m`);

async function openFilter(u: RenderedUI): Promise<void> {
  u.press("f");
  await vi.waitFor(() => expect(editing(u)).toBe(true));
}

async function type(u: RenderedUI, text: string, expectCount: number): Promise<void> {
  u.press(text);
  await vi.waitFor(() => expect(u.frame()).toContain(`(${expectCount})`));
}

describe("Results filter UI", () => {
  it("shows no filter bar by default", async () => {
    const u = await mount();
    expect(u.frame()).not.toContain("Filter");
  });

  it("renders the filter bar on its own row below an intact panel", async () => {
    const u = await mount();
    await openFilter(u);
    await type(u, "ubuntu 24", 3);

    const ls = lines(u);
    const top = ls.findIndex((l) => l.includes("╭─ Results"));
    const bar = ls.findIndex((l) => l.includes("Filter ❯"));
    const lastBorder = ls.reduce((acc, l, i) => (l.includes("╰") ? i : acc), -1);

    // The bug this guards against: the bar rendered as a row sibling of the
    // panel, landing on the top border line and squeezing the title.
    expect(ls[top]).toMatch(/^╭─ Results \(3\) ─+╮$/);
    expect(ls[top]).toHaveLength(TEST_CONTENT_WIDTH);
    expect(bar).toBeGreaterThan(lastBorder);
    for (const l of ls) expect(l.length).toBeLessThanOrEqual(TEST_CONTENT_WIDTH);
  });

  it("narrows live and ranks exact > in-order > scattered", async () => {
    const u = await mount();
    await openFilter(u);
    await type(u, "ubuntu 24", 3);

    const exact = lineIndex(u, "ubuntu 24.04 desktop");
    const inOrder = lineIndex(u, "ubuntu server");
    const scattered = lineIndex(u, "24 hour timelapse");
    expect(exact).toBeGreaterThan(-1);
    expect(inOrder).toBeGreaterThan(exact);
    expect(scattered).toBeGreaterThan(inOrder);
    expect(u.frame()).not.toContain("debian 12");
  });

  it("enter commits the filter and returns keys to the list", async () => {
    const u = await mount();
    await openFilter(u);
    await type(u, "iso", 6);
    u.press(KEY.enter);
    await vi.waitFor(() => expect(editing(u)).toBe(false));
    expect(u.frame()).toContain("Filter ❯ iso");

    u.press("j");
    await vi.waitFor(() => {
      const ls = lines(u);
      expect(ls.find((l) => l.includes("ubuntu server"))).toContain("❯");
    });
    expect(lines(u).find((l) => l.includes("ubuntu 24.04 desktop"))).not.toContain("❯");
  });

  it("esc leaves editing but keeps the filter applied", async () => {
    const u = await mount();
    await openFilter(u);
    await type(u, "iso", 6);
    u.press(KEY.esc);
    await vi.waitFor(() => expect(editing(u)).toBe(false));
    expect(u.frame()).toContain("Filter ❯ iso");
    expect(u.frame()).toContain("(6)");

    u.press("j");
    await vi.waitFor(() => {
      const ls = lines(u);
      expect(ls.find((l) => l.includes("ubuntu server"))).toContain("❯");
    });
  });

  it("ctrl+u then enter clears the filter and removes the bar", async () => {
    const u = await mount();
    await openFilter(u);
    await type(u, "arch", 1);
    u.press(KEY.ctrlU);
    await vi.waitFor(() => expect(u.frame()).toContain("(8)"));
    u.press(KEY.enter);
    await vi.waitFor(() => expect(u.frame()).not.toContain("Filter"));
    expect(u.frame()).toContain("Results (8)");
  });

  it("a zero-match filter never traps the user", async () => {
    const u = await mount();
    await openFilter(u);
    u.press("zzz");
    await vi.waitFor(() => expect(u.frame()).toContain("No results for"));
    u.press(KEY.enter);
    await vi.waitFor(() => expect(editing(u)).toBe(false));
    expect(u.frame()).toContain("Filter ❯ zzz");

    u.press("f");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    u.press(KEY.ctrlU);
    // Wait between keys: TextField's input closure only refreshes on render,
    // so a same-batch ctrl+u + enter would still submit the pre-clear value
    // (pre-existing TextField trait, logged as a follow-up).
    await vi.waitFor(() => expect(u.frame()).toContain("Results (8)"));
    u.press(KEY.enter);
    await vi.waitFor(() => expect(u.frame()).not.toContain("Filter"));
    expect(u.frame()).toContain("Results (8)");
  });
});

describe("Results preview pane", () => {
  const wide = (results: TorrentResult[], overrides = {}) => {
    searchState.current = settled(results);
    const u = renderUI(
      <StoreContext.Provider
        value={makeTestStore({ query: "the bear", omdbApiKey: "KEY", contentWidth: 96, ...overrides })}
      >
        <Results />
      </StoreContext.Provider>,
      { cols: 110 },
    );
    ui = u;
    return u;
  };

  it("shows a poster + plot preview for the selected result on a wide terminal", async () => {
    omdb.byName.mockResolvedValue({ ok: true, imdbId: "tt9", plot: "A great film.", posterUrl: "https://x/p.jpg" });
    const u = wide([t("v1", "The.Bear.S01.1080p.WEB-DL.x264-GROUP")]);
    await vi.waitFor(() => expect(u.frame()).toContain("Preview"));
    await vi.waitFor(() => expect(u.frame()).toContain("A great film."));
    // Looked up by the parsed title, as a series (season detected).
    expect(omdb.byName).toHaveBeenCalled();
    const call = omdb.byName.mock.calls[0]!;
    expect(call[0]).toBe("The Bear");
    expect(call[2].type).toBe("series");
    await vi.waitFor(() => expect(u.rawFrame()).toContain("38;2;9;9;9")); // poster rendered
  });

  it("toggles the preview pane off and on with p", async () => {
    omdb.byName.mockResolvedValue({ ok: true, imdbId: "tt9", plot: "A great film.", posterUrl: null });
    const u = wide([t("v1", "The.Bear.S01.1080p")]);
    await vi.waitFor(() => expect(u.frame()).toContain("Preview"));
    u.press("p");
    await vi.waitFor(() => expect(u.frame()).not.toContain("Preview"));
    u.press("p");
    await vi.waitFor(() => expect(u.frame()).toContain("Preview"));
  });

  it("stays a single column with no preview when no OMDb key is set", async () => {
    const u = wide([t("v1", "The.Bear.S01.1080p")], { omdbApiKey: "" });
    await vi.waitFor(() => expect(u.frame()).toContain("Results (1)"));
    expect(u.frame()).not.toContain("Preview");
    expect(omdb.byName).not.toHaveBeenCalled();
  });

  it("opens the resolved IMDb title page on 'i' when matched", async () => {
    omdb.byName.mockResolvedValue({ ok: true, imdbId: "tt9", plot: "A resolved plot.", posterUrl: null });
    const u = wide([t("v1", "The.Bear.S01.1080p.WEB-DL")]);
    // Wait for the plot to render — it lands together with the imdbId, so by now
    // the exact id is in state (rather than racing the fallback title search).
    await vi.waitFor(() => expect(u.frame()).toContain("A resolved plot."));
    u.press("i");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://www.imdb.com/title/tt9/"));
  });

  it("falls back to an IMDb title search on 'i' with no key (no exact id)", async () => {
    const u = wide([t("v1", "Weapons.2025.1080p.BluRay.x264-GRP")], { omdbApiKey: "" });
    await vi.waitFor(() => expect(u.frame()).toContain("Results (1)"));
    u.press("i");
    await vi.waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://www.imdb.com/find/?q=Weapons%202025"),
    );
  });
});
