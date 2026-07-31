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
        value={makeTestStore({ query: "harrowgate", omdbApiKey: "KEY", contentWidth: 96, ...overrides })}
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
      <Results />
    </StoreContext.Provider>,
    { cols: contentWidth + 19 },
  );
  const u = ui;
  await vi.waitFor(() => expect(u.frame()).toContain(`Results (${results.length})`));
  return u;
}

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
    expect(u.frame()).toContain("Harrowgate S03E01");
    // The pack's heading, on its own line: "Harrowgate S03" is a prefix of
    // "Harrowgate S03E01", so a plain toContain would pass without it.
    expect(u.frame()).toMatch(/Harrowgate S03(?!E)/);
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
        <Results />
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
