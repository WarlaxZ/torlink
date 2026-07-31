import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import type { FetchImpl } from "../../util/net";
import type { StreamHistoryItem } from "../../core/streamHistory";

// Captured BEFORE the fake timers installed by one describe near the bottom of
// this file: `setImmediate` is faked too, and ink's React scheduler drains its
// work through a MessageChannel message — a macrotask — so advancing fake timers
// alone never repaints the frame. Same reasoning as ForYou.test.tsx.
const yieldToLoop = setImmediate;

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
vi.mock("../../core/posterCache", () => ({
  cachedPosterRows: vi.fn(async () => ["\x1b[38;2;9;9;9m▀\x1b[0m"]),
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
      <Results reccConfig={{}} />
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
        value={makeTestStore({ query: "harrowgate", omdbApiKey: "KEY", contentWidth: 96, ...overrides })}
      >
        <Results reccConfig={{}} />
      </StoreContext.Provider>,
      { cols: 110 },
    );
    ui = u;
    return u;
  };

  it("shows a poster + plot preview for the selected result on a wide terminal", async () => {
    omdb.byName.mockResolvedValue({ ok: true, imdbId: "tt9", plot: "A great film.", posterUrl: "https://x/p.jpg" });
    const u = wide([t("v1", "Harrowgate.S01.1080p.WEB-DL.x264-GROUP")]);
    await vi.waitFor(() => expect(u.frame()).toContain("Preview"));
    await vi.waitFor(() => expect(u.frame()).toContain("A great film."));
    // Looked up by the parsed title, as a series (season detected).
    expect(omdb.byName).toHaveBeenCalled();
    const call = omdb.byName.mock.calls[0]!;
    expect(call[0]).toBe("Harrowgate");
    expect(call[2].type).toBe("series");
    await vi.waitFor(() => expect(u.rawFrame()).toContain("38;2;9;9;9")); // poster rendered
  });

  it("toggles the preview pane off and on with p", async () => {
    omdb.byName.mockResolvedValue({ ok: true, imdbId: "tt9", plot: "A great film.", posterUrl: null });
    const u = wide([t("v1", "Harrowgate.S01.1080p")]);
    await vi.waitFor(() => expect(u.frame()).toContain("Preview"));
    u.press("p");
    await vi.waitFor(() => expect(u.frame()).not.toContain("Preview"));
    u.press("p");
    await vi.waitFor(() => expect(u.frame()).toContain("Preview"));
  });

  it("stays a single column with no preview when no OMDb key is set", async () => {
    const u = wide([t("v1", "Harrowgate.S01.1080p")], { omdbApiKey: "" });
    await vi.waitFor(() => expect(u.frame()).toContain("Results (1)"));
    expect(u.frame()).not.toContain("Preview");
    expect(omdb.byName).not.toHaveBeenCalled();
  });

  it("opens the resolved IMDb title page on 'i' when matched", async () => {
    omdb.byName.mockResolvedValue({ ok: true, imdbId: "tt9", plot: "A resolved plot.", posterUrl: null });
    const u = wide([t("v1", "Harrowgate.S01.1080p.WEB-DL")]);
    // Wait for the plot to render — it lands together with the imdbId, so by now
    // the exact id is in state (rather than racing the fallback title search).
    await vi.waitFor(() => expect(u.frame()).toContain("A resolved plot."));
    u.press("i");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://www.imdb.com/title/tt9/"));
  });

  it("falls back to an IMDb title search on 'i' with no key (no exact id)", async () => {
    const u = wide([t("v1", "Tollgate.2025.1080p.BluRay.x264-GRP")], { omdbApiKey: "" });
    await vi.waitFor(() => expect(u.frame()).toContain("Results (1)"));
    u.press("i");
    await vi.waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://www.imdb.com/find/?q=Tollgate%202025"),
    );
  });
});

// Quality badges. The invented cast from CLAUDE.md: Tin Rivers is the 4K entry
// that carries features, Kestrel the plain 1080p film.
const BADGED = [
  t("t1", "Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP"),
  t("k1", "Kestrel.2010.1080p.BluRay.x264"),
];

async function mountWide(results: TorrentResult[], contentWidth: number): Promise<RenderedUI> {
  searchState.current = settled(results);
  ui = renderUI(
    <StoreContext.Provider value={makeTestStore({ query: "linux iso", contentWidth, cols: contentWidth + 19 })}>
      <Results reccConfig={{}} />
    </StoreContext.Provider>,
    { cols: contentWidth + 19 },
  );
  const u = ui;
  await vi.waitFor(() => expect(u.frame()).toContain(`Results (${results.length})`));
  return u;
}

// A mount that also seeds the watch position, so the landing behaviour can be
// asserted. `Store.streamHistory` already exists and `makeTestStore` already
// seeds it empty, so this is an override, not a new field.
async function mountWideWithHistory(
  results: TorrentResult[],
  streamHistory: StreamHistoryItem[],
  contentWidth: number,
): Promise<RenderedUI> {
  searchState.current = settled(results);
  ui = renderUI(
    <StoreContext.Provider
      value={makeTestStore({
        query: "linux iso",
        contentWidth,
        cols: contentWidth + 19,
        streamHistory,
      })}
    >
      <Results reccConfig={{}} />
    </StoreContext.Provider>,
    { cols: contentWidth + 19 },
  );
  const u = ui;
  await vi.waitFor(() => expect(u.frame()).toContain(`Results (${results.length})`));
  return u;
}

describe("Results watch position", () => {
  const HISTORY: StreamHistoryItem[] = [
    {
      key: "harrowgate|series",
      title: "Harrowgate",
      type: "series",
      season: 3,
      episode: 1,
      rawName: "Harrowgate.S03E01.1080p.WEB-DL",
      infoHash: "a1",
      magnet: "magnet:?xt=urn:btih:a1",
      startedAt: 1,
    },
  ];

  const SHOW = [
    t("a1", "Harrowgate.S03E01.1080p.WEB-DL"),
    t("a2", "Harrowgate.S03E01.2160p.WEB-DL"),
    t("b1", "Harrowgate.S03E02.1080p.WEB-DL"),
    t("b2", "Harrowgate.S03E02.2160p.WEB-DL"),
    t("c1", "Harrowgate.S04E01.1080p.WEB-DL"),
    t("c2", "Harrowgate.S04E01.2160p.WEB-DL"),
  ];

  it("opens the season you are part-way through, not the newest one", async () => {
    const u = await mountWideWithHistory(SHOW, HISTORY, 120);
    // Seasons sort newest first, so S04 is the highest-ranked node and would be
    // the one to open without a position. This only passes if the position won.
    await vi.waitFor(() => expect(u.frame()).toContain("S03E02"));
    expect(u.frame()).toContain("Harrowgate S03");
  });

  it("says how far through the season you are", async () => {
    const u = await mountWideWithHistory(SHOW, HISTORY, 120);
    await vi.waitFor(() => expect(u.frame()).toContain("up to E01"));
  });

  it("puts the cursor on the next episode, not the season row", async () => {
    const u = await mountWideWithHistory(SHOW, HISTORY, 120);
    await vi.waitFor(() => expect(lines(u).find((l) => l.includes("S03E02"))).toContain("❯"));
    expect(lines(u).find((l) => l.includes("Harrowgate S03 "))).not.toContain("❯");
  });

  it("marks nothing and opens the newest season when the show is unwatched", async () => {
    const u = await mountWideWithHistory(SHOW, [], 120);
    await vi.waitFor(() => expect(u.frame()).toContain("Harrowgate S04"));
    expect(u.frame()).not.toContain("up to");
  });
});

describe("Results quality badges", () => {
  // ASSERTED VIA LABELS THE RELEASE NAME CANNOT PROVIDE. The name already
  // contains "2160p" and "HDR", so `toContain` on those matches whether or not a
  // badge rendered at all — the first version of this test passed vacuously.
  // "Dolby Vision" is FEATURES' label for the name's "DV" and appears nowhere
  // else, and a resolution badge shows up as a SECOND occurrence of "1080p".
  it("shows the resolution as a badge beside the name", async () => {
    const u = await mount([t("k1", "Kestrel.2010.1080p.BluRay.x264")]);
    // SPACE-DELIMITED, which is what proves it is the badge column: in the
    // release name "1080p" is surrounded by dots. Not a count of occurrences —
    // the badge costs the name six columns, so at 80 columns the name truncates
    // to "Kestrel.2010.1…" and the only "1080p" on the row is the badge.
    expect(u.frame()).toContain(" 1080p ");
  });

  // The row is a fixed-column layout and the name is what you read before
  // pressing `v`. At 80 columns there is no room for a spec sheet, so the
  // resolution wins and the features are dropped rather than eating the name.
  it("shows only the resolution at 80 columns", async () => {
    const u = await mount(BADGED);
    expect(u.frame()).not.toContain("Dolby Vision");
    expect(u.frame()).not.toContain("Atmos");
  });

  it("never pushes a row past the content width", async () => {
    const u = await mount(BADGED);
    for (const l of lines(u)) expect(l.length).toBeLessThanOrEqual(TEST_CONTENT_WIDTH);
  });

  it("adds features when the terminal is wide enough to carry them", async () => {
    const u = await mountWide(BADGED, 120);
    expect(u.frame()).toContain("Dolby Vision");
  });

  it("shows nothing where the release name carries no quality facts", async () => {
    const u = await mount([t("z9", "gentoo stage3 tarball")]);
    expect(u.frame()).not.toContain("1080p");
    expect(u.frame()).not.toContain("Dolby Vision");
  });
});

// Grouping. Two releases of Kestrel plus one Ashfall: the duplicate collapses to
// a heading, the singleton stays a plain row.
const GROUPABLE = [
  t("k1", "Kestrel.2010.1080p.BluRay.x264"),
  t("k2", "Kestrel.2010.2160p.WEB-DL"),
  t("a1", "Ashfall.1999.1080p"),
];

describe("Results grouping", () => {
  // At a WIDE content width throughout. At 80 columns the list has ~61 and
  // "Kestrel (2010)" renders as "Kestrel (…", so every assertion here would be
  // testing the truncator rather than the grouping.
  const mountGrouped = () => mountWide(GROUPABLE, 120);

  it("collapses many releases of one title to a heading with a count", async () => {
    const u = await mountGrouped();
    // The parsed title and year, not a release name.
    expect(u.frame()).toContain("Kestrel (2010)");
    expect(u.frame()).toContain("\u00d72");
    // Collapsed: neither release name is on screen.
    expect(u.frame()).not.toContain("BluRay");
    expect(u.frame()).not.toContain("WEB-DL");
  });

  // The complaint this answers, in the terminal half: a season pack and every
  // episode of that season are correctly separate groups, but while a heading was
  // the bare parsed title they all rendered as the same row, and one search read
  // as five identical copies of the show.
  it("names the season and episode on a show's headings, so two never read alike", async () => {
    const u = await mountWide(
      [
        t("p1", "Harrowgate.S03.1080p.WEB-DL"),
        t("p2", "Harrowgate.S03.2160p.WEB-DL"),
        t("e1", "Harrowgate.S03E01.1080p.WEB-DL"),
        t("e2", "Harrowgate.S03E01.2160p.WEB-DL"),
      ],
      120,
    );
    // Under the season tree the show is named once, by the season row, and its
    // children take the short form. Before the tree these were sibling rows both
    // reading "Harrowgate" — which is the bug this test was written for, and it
    // still catches it: two rows that say nothing distinguishing would fail here.
    await vi.waitFor(() => expect(u.frame()).toContain("Season pack"));
    expect(u.frame()).toMatch(/Harrowgate S03(?!E)/);
    expect(u.frame()).toContain("S03E01");
  });

  it("renders a season row above its episodes, with the show named once", async () => {
    const u = await mountWide(
      [
        t("p1", "Harrowgate.S03.1080p.WEB-DL"),
        t("p2", "Harrowgate.S03.2160p.WEB-DL"),
        t("e1", "Harrowgate.S03E01.1080p.WEB-DL"),
        t("e2", "Harrowgate.S03E01.2160p.WEB-DL"),
        t("f1", "Harrowgate.S03E02.1080p.WEB-DL"),
        t("f2", "Harrowgate.S03E02.2160p.WEB-DL"),
      ],
      120,
    );
    // The highest-ranked season is seeded open, so its children are on screen.
    // Seeded in an effect, so the frame settles a tick after the first render.
    await vi.waitFor(() => expect(u.frame()).toContain("Season pack"));
    expect(u.frame()).toContain("Harrowgate S03");
    expect(u.frame()).toContain("S03E01");
    // The show's name is stated once, by the season row — not repeated per child.
    expect(u.frame()).not.toContain("Harrowgate S03E01");
  });

  it("leaves a lone release as a plain row", async () => {
    const u = await mountGrouped();
    // No heading, no count — the release name itself is the row.
    expect(u.frame()).toContain("Ashfall.1999.1080p");
    expect(u.frame()).not.toContain("Ashfall (1999)");
  });

  it("still reports the result count, not the row count", async () => {
    // 3 results behind 2 rows. The panel counts results, matching the browser.
    const u = await mountGrouped();
    expect(u.frame()).toContain("Results (3)");
  });

  it("expands the group under the cursor on space, and collapses it again", async () => {
    const u = await mountGrouped();
    u.press(" ");
    await vi.waitFor(() => expect(u.frame()).toContain("BluRay"));
    expect(u.frame()).toContain("WEB-DL");
    // The heading stays, with its count.
    expect(u.frame()).toContain("Kestrel (2010)");
    u.press(" ");
    await vi.waitFor(() => expect(u.frame()).not.toContain("BluRay"));
  });

  it("turns grouping off with g, showing every release", async () => {
    const u = await mountGrouped();
    u.press("g");
    await vi.waitFor(() => expect(u.frame()).toContain("BluRay"));
    // No headings at all now.
    expect(u.frame()).not.toContain("Kestrel (2010)");
    expect(u.frame()).not.toContain("\u00d72");
  });

  it("acts on the group's best release when the cursor is on a heading", async () => {
    // `y` copies the magnet of whatever the cursor is on. On a collapsed heading
    // that must be its first member — the reason every action key resolves
    // through resultAt rather than indexing `results` directly, which after
    // grouping would be a different row entirely.
    const copyMagnet = vi.fn();
    searchState.current = settled(GROUPABLE);
    ui = renderUI(
      <StoreContext.Provider value={makeTestStore({ query: "linux iso", contentWidth: 120, cols: 139, copyMagnet })}>
        <Results reccConfig={{}} />
      </StoreContext.Provider>,
      { cols: 139 },
    );
    const u = ui;
    await vi.waitFor(() => expect(u.frame()).toContain("Results (3)"));
    u.press("y");
    await vi.waitFor(() => expect(copyMagnet).toHaveBeenCalled());
    expect(copyMagnet.mock.calls[0]![0]).toMatchObject({
      name: "Kestrel.2010.1080p.BluRay.x264",
    });
  });
});

describe("Results grouping keeps the cursor put", () => {
  // THE REGRESSION THIS GUARDS. An infoHash is not a unique row identity: an
  // expanded group's heading and its first member both resolve to members[0], and
  // the heading has the lower index. While selRef matched on the hash alone,
  // arrowing onto that first member and then receiving one more streamed result
  // dragged the cursor back up to the heading — the exact wandering-cursor
  // problem selRef exists to prevent, reintroduced through grouping.
  it("stays on a group member when a later frame adds a result", async () => {
    const u = await mountWide(GROUPABLE, 120);

    // Open the group and step onto its first member.
    u.press(" ");
    await vi.waitFor(() => expect(u.frame()).toContain("BluRay"));
    u.press("j");
    await vi.waitFor(() => expect(u.frame()).toMatch(/\u276f.*BluRay/));

    // A later source answers. `p` only toggles the preview flag (which stays off
    // at this width with no OMDb key) and is here purely to drive one more render
    // now that the mocked search state has changed — the harness has no rerender.
    searchState.current = settled([...GROUPABLE, t("n1", "Tin.Rivers.2024.2160p.WEB-DL")]);
    u.press("p");
    await vi.waitFor(() => expect(u.frame()).toContain("Results (4)"));

    // Still on the member, not yanked up to the heading above it.
    expect(u.frame()).toMatch(/\u276f.*BluRay/);
  });
});

// Title suggestions. reccd's replies are injected through the `fetchImpl` prop \u2014
// exactly the escape hatch ForYou's tests use \u2014 so nothing here dials out.
const SUGGEST_CFG = { reccUrl: "http://recc.invalid:4100", reccToken: "tok" };
const KESTREL = { imdbId: "tt1", title: "Kestrel", year: 2010, type: "movie", matchedAka: null };
// Enough hits to fill SUGGEST_ROWS_TERMINAL, for the height-budget test.
const KEPLER = { imdbId: "tt2", title: "Kepler", year: 2019, type: "tv", matchedAka: null };
const ASHFALL = { imdbId: "tt3", title: "Ashfall", year: 1999, type: "movie", matchedAka: null };
const HARROWGATE = { imdbId: "tt4", title: "Harrowgate", year: 2021, type: "tv", matchedAka: null };
const TIN_RIVERS = { imdbId: "tt5", title: "Tin Rivers", year: 2024, type: "movie", matchedAka: null };
// The row budget App.tsx hands this view (it passes `listRows === bodyH`), stated
// here rather than inherited from the harness default so the assertions below and
// the store cannot drift apart. Roomy enough that `resultsPanelOuter`'s 5-row
// floor is not what is being measured — on a terminal too short for both the
// panel minimum and a full list, the floor wins and clipping is unavoidable.
const TEST_LIST_ROWS = 24;

// `fetchTitleSuggestions` validates EVERY element and fails the whole reply on
// one bad one, which the hook renders as an empty list \u2014 so `matchedAka` is not
// optional decoration here, it is what makes the stub a valid reply.
function suggestStub(items: unknown[] = [KESTREL]): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ results: items }) } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

// Browsing (an empty submitted query) so the draft starts empty and the only
// request the hook makes is the one the test types.
async function mountSuggest(
  impl: FetchImpl,
  overrides: Parameters<typeof makeTestStore>[0] = {},
): Promise<RenderedUI> {
  searchState.current = settled(LIST);
  ui = renderUI(
    <StoreContext.Provider value={makeTestStore({ query: "", ...overrides })}>
      <Results reccConfig={SUGGEST_CFG} fetchImpl={impl} />
    </StoreContext.Provider>,
  );
  const u = ui;
  // The count, not the panel title: the title is "Latest" while browsing and
  // "Results" once a query has been submitted, and these tests use both.
  await vi.waitFor(() => expect(u.frame()).toContain(`(${LIST.length})`));
  return u;
}

describe("Results search suggestions", () => {
  // Escape has two jobs now, and the order matters to the user: the first
  // escape puts the list away, the second leaves the box. Collapsing both into
  // one keypress would make dismissing a list cost you your place.
  it("dismisses the suggestion list before leaving the search box", async () => {
    const { impl } = suggestStub();
    const u = await mountSuggest(impl);

    u.press("/");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    u.press("ke");
    // Polls the whole keystroke -> debounce -> reply -> repaint chain rather
    // than sleeping past it, which is fragile on a loaded machine.
    await vi.waitFor(() => expect(u.frame()).toContain("Kestrel (2010) \u00b7 film"), {
      timeout: 5000,
    });

    // First escape: the list goes, the box stays.
    u.press(KEY.esc);
    await vi.waitFor(() => expect(u.frame()).not.toContain("Kestrel (2010)"));
    expect(editing(u)).toBe(true);

    // Second escape: now the pane leaves search mode.
    u.press(KEY.esc);
    await vi.waitFor(() => expect(editing(u)).toBe(false));
  });

  it("completes the field to the top suggestion on tab instead of leaving the box", async () => {
    const { impl } = suggestStub();
    const u = await mountSuggest(impl);

    u.press("/");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    u.press("ke");
    await vi.waitFor(() => expect(u.frame()).toContain("Kestrel (2010) \u00b7 film"), {
      timeout: 5000,
    });

    u.press("\t");
    // Title AND year \u2014 the whole point of canonicalising through a catalog.
    await vi.waitFor(() => expect(u.frame()).toContain("Kestrel 2010"));
    // Still editing: tab completed rather than exiting downward.
    expect(editing(u)).toBe(true);
    // Accepting suppresses the text just taken, so the list does not
    // immediately reopen on it.
    await vi.waitFor(() => expect(u.frame()).not.toContain("Kestrel (2010) \u00b7 film"));
  });

  it("leaves the search box on tab when there is nothing to complete", async () => {
    // reccd configured, and ONE character typed \u2014 below the two reccd will answer
    // \u2014 so there is no list and tab must behave exactly as it did before
    // suggestions existed. The subject is tab, and `editing` is what pins it.
    //
    // Deliberately asserts NOTHING about requests. This describe runs on real
    // timers, where `vi.waitFor` resolves in tens of milliseconds and the
    // debounce is 250ms, so "no request fired" here would only mean "the timer
    // has not fired yet" \u2014 vacuous, as the comment above the fake-timer describe
    // below says. The min-length gate is covered there instead, by
    // "clears the rows when backspacing below the minimum query length".
    const { impl } = suggestStub();
    const u = await mountSuggest(impl);

    u.press("/");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    u.press("k");
    await vi.waitFor(() => expect(u.frame()).toContain("\u276f k"));
    u.press("\t");
    await vi.waitFor(() => expect(editing(u)).toBe(false));
  });

  it("still recalls the previous search on the up arrow with a list on screen", async () => {
    const { impl } = suggestStub();
    const u = await mountSuggest(impl, { searchHistory: ["harrowgate s03"] });

    u.press("/");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    u.press("ke");
    await vi.waitFor(() => expect(u.frame()).toContain("Kestrel (2010) \u00b7 film"), {
      timeout: 5000,
    });

    // The suggestion rows are not a list the arrows walk \u2014 history recall still
    // owns the up arrow inside the field.
    u.press(`${KEY.esc}[A`);
    await vi.waitFor(() => expect(u.frame()).toContain("harrowgate s03"));
  });

  it("does not reopen the list on abandoned text when the box is re-entered", async () => {
    // The draft is separate state from the submitted query, and entering search
    // mode REMOUNTS the TextField with `query` in it. Without a resync, leaving
    // the box with text in it and coming back would suggest against the
    // abandoned text under a box showing something else.
    //
    // Committed with ENTER, not escape, on purpose: escape sets `suppressedText`
    // and would make this pass whether the resync exists or not.
    const { impl } = suggestStub();
    const u = await mountSuggest(impl);

    u.press("/");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    u.press("ke");
    await vi.waitFor(() => expect(u.frame()).toContain("Kestrel (2010) \u00b7 film"), {
      timeout: 5000,
    });
    u.press(KEY.enter);
    await vi.waitFor(() => expect(editing(u)).toBe(false));

    // Back into an empty box: nothing to suggest on, so no list. A waitFor, not
    // a bare assertion \u2014 the rows the previous visit left in state can survive
    // one frame, and without the resync they never go away at all.
    u.press("/");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    await vi.waitFor(() => expect(u.frame()).not.toContain("Kestrel (2010) \u00b7 film"), {
      timeout: 5000,
    });
  });

  it("still opens a list once the text in the box is actually changed", async () => {
    // The regression guard on the suppression above: "suppress everything
    // forever" would satisfy the no-unbidden-dropdown test, and would also
    // silently turn suggestions off on this screen for anyone who searched once.
    const { impl } = suggestStub();
    const u = await mountSuggest(impl, { query: "kestrel 2010" });

    u.press("/");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    // One new character is enough: the text no longer equals the latched string.
    u.press("x");
    await vi.waitFor(() => expect(u.frame()).toContain("Kestrel (2010) \u00b7 film"), {
      timeout: 5000,
    });
  });

  it("leaves the search box on a single escape when no list was ever opened", async () => {
    // Half the point of suppressing the resynced text: escape escalates only
    // when there is really something on screen to put away. Entering a box that
    // shows a previous search must not cost two presses to leave.
    const { impl } = suggestStub();
    const u = await mountSuggest(impl, { query: "kestrel 2010" });

    u.press("/");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    u.press(KEY.esc);
    await vi.waitFor(() => expect(editing(u)).toBe(false));
  });

  /**
   * THE HEIGHT BUDGET, which had no coverage at all.
   *
   * App.tsx gives this view a `height={bodyH}` box with `overflow="hidden"`, and
   * `listRows === bodyH`. `resultsPanelOuter` subtracts `searchH + 2` from that
   * budget, and `searchH + 2` is exactly the SearchBar's rendered rows plus its
   * one-row `marginTop` — so the column consumes precisely the budget with the
   * deliberate one row of slack (see `resultsPanelOuter`'s own comment on issue
   * #21) and nothing to spare. The suggestion rows sit ABOVE the results panel,
   * so rows they add come out of the panel below them: Yoga shrinks it, or the
   * parent's clip takes its bottom border off. Either way the results panel
   * loses rows while a list is open and gets them back when it closes — jitter
   * per keystroke, which the spec explicitly promises does not happen.
   *
   * Asserted against `listRows` from the store rather than a literal, and the
   * closed-list height is asserted too, so this cannot pass by the view being
   * uniformly short.
   */
  it("keeps the results panel inside the row budget while a list is open", async () => {
    const { impl } = suggestStub([KESTREL, KEPLER, ASHFALL, HARROWGATE, TIN_RIVERS]);
    const u = await mountSuggest(impl, { listRows: TEST_LIST_ROWS });
    const height = (): number => u.frame().split("\n").length;
    // Two: the search bar's and the results panel's. The results panel's is the
    // LAST line of the view, so losing it to a clip or a shrink shows up here.
    const bottomBorders = (): number => u.frame().split("\n").filter((l) => l.includes("╰")).length;
    const endsWithPanelBottom = (): boolean => (u.frame().split("\n").at(-1) ?? "").includes("╰");

    u.press("/");
    await vi.waitFor(() => expect(editing(u)).toBe(true));
    const closedHeight = height();
    // The whole budget, exactly — this view has no slack in it to lend.
    expect(closedHeight).toBe(TEST_LIST_ROWS);
    expect(bottomBorders()).toBe(2);
    expect(endsWithPanelBottom()).toBe(true);

    u.press("ke");
    await vi.waitFor(() => expect(u.frame()).toContain("Tin Rivers (2024) · film"), {
      timeout: 5000,
    });
    // Five suggestion rows are on screen and the view is still inside its budget.
    expect(u.frame()).toContain("Kestrel (2010) · film");
    expect(height()).toBe(closedHeight);
    // And the panel is intact rather than clipped out of its own bottom border.
    expect(bottomBorders()).toBe(2);
    expect(endsWithPanelBottom()).toBe(true);
  });
});

// The unbidden-dropdown fix can only be proved EXACTLY under fake time: on real
// timers "no request fired" after a few awaits is unbounded, and therefore
// vacuous. Scoped to this describe \u2014 the rest of the file polls with `vi.waitFor`
// on real timers and a file-level install would change every test in it.
describe("Results search suggestions on entering the box", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  // Lets ink's MessageChannel-scheduled render and the fetch promise chain drain
  // without moving the clock.
  const settleFrames = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
      await new Promise<void>((r) => yieldToLoop(() => r()));
    }
  };
  const tick = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await settleFrames();
  };

  it("asks reccd nothing about text that was already in the box", async () => {
    // Entering the box after a search resyncs the draft to the submitted query.
    // That text is not a question the user just asked, so it must be suppressed
    // as well as resynced \u2014 otherwise `/` pops a dropdown nobody opened.
    const { impl, urls } = suggestStub();
    searchState.current = settled(LIST);
    ui = renderUI(
      <StoreContext.Provider value={makeTestStore({ query: "kestrel 2010" })}>
        <Results reccConfig={SUGGEST_CFG} fetchImpl={impl} />
      </StoreContext.Provider>,
    );
    const u = ui;
    await settleFrames();
    u.press("/");
    // A full second of fake time \u2014 four debounce windows \u2014 so nothing can still
    // be pending. This is what makes the negative exact rather than hopeful.
    await tick(1000);
    expect(urls).toHaveLength(0);
    expect(u.frame()).not.toContain("Kestrel (2010) \u00b7 film");
  });

  it("holds when the box reaches the submitted text without entering search mode", async () => {
    // THE POINT OF THE DERIVED GUARD. `enterSearch` resyncing the draft is not
    // what keeps the list shut \u2014 the `draft === query` condition is, and it is
    // re-read every render. This drives the box to `draft === query` by TYPING,
    // so `enterSearch` is provably not the thing suppressing anything, and no
    // latch is involved either (no tab, no escape, so `suppressedText` stays
    // null). Whatever path a future caller takes into search mode, it lands in
    // this same state and gets this same answer.
    //
    // It doubles as documentation of the one behaviour the guard gives up:
    // clearing the box and retyping your last search exactly gets no suggestions.
    const { impl, urls } = suggestStub();
    searchState.current = settled(LIST);
    ui = renderUI(
      <StoreContext.Provider value={makeTestStore({ query: "kestrel" })}>
        <Results reccConfig={SUGGEST_CFG} fetchImpl={impl} />
      </StoreContext.Provider>,
    );
    const u = ui;
    await settleFrames();

    u.press("/");
    await tick(1000);
    expect(urls).toHaveLength(0); // nothing asked for the text already there

    // Clear it and type most of the same search back: the drafts differ, so
    // suggestions work normally. The two presses are separated by a tick because
    // TextField's input closure only refreshes on render \u2014 same-batch keys apply
    // against the pre-clear value (a pre-existing trait this file already
    // documents on the filter tests), which would insert into "kestrel" rather
    // than into an empty box.
    u.press(KEY.ctrlU);
    await tick(1000);
    u.press("kestre");
    await tick(1000);
    // Pinned with the trailing separator so it cannot be satisfied by a longer
    // query that merely starts the same way \u2014 the first version of this
    // assertion passed against "q=kestrelkestre".
    expect(urls).toEqual([expect.stringContaining("q=kestre&limit=")]);
    expect(u.frame()).toContain("Kestrel (2010) \u00b7 film");

    // One more character and the draft equals the submitted search again. The
    // list must close and nothing more may be asked \u2014 reached purely by typing.
    u.press("l");
    await tick(1000);
    expect(urls).toHaveLength(1);
    expect(u.frame()).not.toContain("Kestrel (2010) \u00b7 film");
  });

  /**
   * ESCAPE MUST STICK EVEN WITH A REQUEST STILL OUT, and this is the test that
   * pins the WIRING \u2014 `dismiss` handing the hook's live seq counter to
   * `suppressFor`, not the seq of the last reply applied. The module's own unit
   * tests pass either way; only a render distinguishes them.
   *
   * Dismissing does not change an effect dependency, so the pending request is
   * neither cancelled nor cleared: it fires, answers, and (before the fix)
   * applied, because its number was higher than anything yet applied. The list
   * the user had just closed came back, and leaving the box then cost a THIRD
   * escape \u2014 against help text promising one.
   */
  it("does not reopen a dismissed list when the request already in flight answers", async () => {
    const { impl, urls } = suggestStub();
    searchState.current = settled(LIST);
    ui = renderUI(
      <StoreContext.Provider value={makeTestStore({ query: "" })}>
        <Results reccConfig={SUGGEST_CFG} fetchImpl={impl} />
      </StoreContext.Provider>,
    );
    const u = ui;
    await settleFrames();

    u.press("/");
    await settleFrames();
    u.press("ke");
    await tick(1000);
    expect(u.frame()).toContain("Kestrel (2010) \u00b7 film");

    // One more character, so a second request is queued for "ker", then escape
    // WITHOUT moving the clock \u2014 the fast-typist case, where the reply is still
    // owed when the list is dismissed.
    u.press("r");
    await settleFrames();
    u.press(KEY.esc);
    // 50ms, well inside the 250ms debounce, so the request for "ker" is still
    // pending: enough for ink to settle an escape byte, not enough to send it.
    await tick(50);
    expect(u.frame()).not.toContain("Kestrel (2010) \u00b7 film");

    // Now let the owed reply land. Two requests really were made, so the negative
    // below is about a reply being DISCARDED and not about one never arriving.
    await tick(2000);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toEqual(expect.stringContaining("q=ker&limit="));
    expect(u.frame()).not.toContain("Kestrel (2010) \u00b7 film");

    // And leaving costs the promised second press, not a third.
    expect(editing(u)).toBe(true);
    u.press(KEY.esc);
    await tick(100);
    expect(editing(u)).toBe(false);
  });

  /**
   * Backspacing out of a search must not leave stale rows behind. Five rows
   * hanging under a one-character box is the symptom; the min-length branch in
   * `useTitleSuggest` is what prevents it, and nothing covered it.
   *
   * Backspaces to exactly ONE character on purpose. Emptying the box entirely
   * would make `shouldSuggestFor("", "")`... \u2014 well, here the submitted query is
   * empty, so an empty draft turns `enabled` off and the rows would clear via the
   * cap on `items` instead, with the branch under test never running.
   */
  it("clears the rows when backspacing below the minimum query length", async () => {
    const { impl, urls } = suggestStub();
    searchState.current = settled(LIST);
    ui = renderUI(
      <StoreContext.Provider value={makeTestStore({ query: "" })}>
        <Results reccConfig={SUGGEST_CFG} fetchImpl={impl} />
      </StoreContext.Provider>,
    );
    const u = ui;
    await settleFrames();

    u.press("/");
    await settleFrames();
    u.press("ke");
    await tick(1000);
    expect(u.frame()).toContain("Kestrel (2010) \u00b7 film");

    // One backspace: "ke" -> "k", one character, below reccd's minimum.
    u.press("\u007f");
    await tick(1000);
    expect(u.frame()).not.toContain("Kestrel (2010) \u00b7 film");
    // And nothing was asked about a query reccd would answer with [] anyway.
    expect(urls).toHaveLength(1);
  });
});
