import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { StoreContext, type Store } from "../src/ui/store";
import { COLOR, ICON, SOURCE_STYLE } from "../src/ui/theme";
import { Logo } from "../src/ui/components/Logo";
import { Rule } from "../src/ui/components/Rule";
import { Footer } from "../src/ui/components/Footer";
import { Sidebar, RAIL_WIDTH } from "../src/ui/components/Sidebar";
import { SearchBar } from "../src/ui/components/SearchBar";
import { Panel } from "../src/ui/components/Panel";
import { Downloads } from "../src/ui/components/Downloads";
import { HelpOverlay } from "../src/ui/components/HelpOverlay";
import { SourcesPrompt } from "../src/ui/components/SourcesPrompt";
import { Accounts } from "../src/ui/components/Accounts";
import { Seeding } from "../src/ui/components/Seeding";
import { PreviewPane } from "../src/ui/components/PreviewPane";
import { footerHints } from "../src/ui/keymap";
import { sourcesByGroup } from "../src/sources/registry";
import { fetchPosterRows } from "../src/util/poster";
import { cleanText } from "../src/util/format";
import { ansiToSvg, type AnsiToSvgOptions } from "./ansi-to-svg";
import type { Config } from "../src/config/config";
import type { DownloadQueue } from "../src/download/queue";
import type { QueueItem, SeedItem } from "../src/download/types";
import type { HistoryItem } from "../src/download/history";
import type { SourceId, TorrentResult } from "../src/sources/types";
import type { RdStatus } from "../src/integrations/rdStatus";

const COLS = 80;
const CONTENT_WIDTH = Math.max(24, COLS - RAIL_WIDTH - 3);
const RULE_WIDTH = Math.max(10, COLS - 2);
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "preview");
mkdirSync(OUT_DIR, { recursive: true });

const NOW = Math.floor(Date.now() / 1000);
const NOW_MS = Date.now();

// The "latest" fixture, now movie-focused so the Movies view can show off the
// poster/plot preview pane. Varied sources keep the Src column lively.
const RESULTS: TorrentResult[] = [
  { infoHash: "b2", name: "Oppenheimer (2023) [1080p WEB]", source: "yts", sizeBytes: 2.1e9, seeders: 1240, leechers: 88, magnet: "", added: NOW - 7200 },
  { infoHash: "g7", name: "Dune: Part Two (2024) [2160p BluRay]", source: "tpb-movies", sizeBytes: 8.4e9, seeders: 910, leechers: 41, magnet: "", added: NOW - 90000 },
  { infoHash: "p1", name: "Poor Things (2023) 1080p BluRay x264", source: "x1337-movies", sizeBytes: 2.4e9, seeders: 612, leechers: 27, magnet: "", added: NOW - 5400 },
  { infoHash: "k1", name: "Killers of the Flower Moon (2023) 2160p", source: "yts", sizeBytes: 9.1e9, seeders: 388, leechers: 19, magnet: "", added: NOW - 172800 },
  { infoHash: "h1", name: "The Holdovers (2023) 1080p WEB-DL", source: "x1337-movies", sizeBytes: 2.0e9, seeders: 274, leechers: 14, magnet: "", added: NOW - 43200 },
  { infoHash: "z1", name: "The Zone of Interest (2023) 1080p", source: "tpb-movies", sizeBytes: 1.8e9, seeders: 141, leechers: 9, magnet: "", added: NOW - 129600 },
  { infoHash: "a2", name: "Anatomy of a Fall (2023) 1080p BluRay", source: "yts", sizeBytes: 2.3e9, seeders: 96, leechers: 5, magnet: "", added: NOW - 259200 },
];

const DOWNLOADS: QueueItem[] = [
  { id: "x1", name: "Ubuntu 24.04.1 LTS Desktop (amd64)", magnet: "", dir: "", status: "downloading", progress: 64, totalBytes: 5.9e9, downloadedBytes: 3.78e9, speed: 8.1e6, peers: 41, eta: 360, addedAt: NOW_MS },
];

const HISTORY: HistoryItem[] = [
  { id: "h1", name: "Debian 12.7.0 amd64 DVD-1", sizeBytes: 3.9e9, magnet: "", dir: "", completedAt: NOW_MS - 3_600_000 },
  { id: "h2", name: "Fedora Workstation 40 x86_64 Live", sizeBytes: 2.1e9, magnet: "", dir: "", completedAt: NOW_MS - 90_000_000 },
];

const SEEDS: SeedItem[] = [
  { id: "h1", name: "Debian 12.7.0 amd64 DVD-1", magnet: "", dir: "", sizeBytes: 3.9e9, status: "seeding", uploadSpeed: 1.4e6, uploaded: 8.2e9, peers: 12 },
  { id: "h2", name: "Fedora Workstation 40 x86_64 Live", magnet: "", dir: "", sizeBytes: 2.1e9, status: "paused", uploadSpeed: 0, uploaded: 4.1e8, peers: 0 },
];

const RD_STATUS: RdStatus = {
  username: "you",
  premium: true,
  premiumUntil: new Date(NOW_MS + 60 * 86_400_000),
};

function fakeQueue(
  items: QueueItem[],
  history: HistoryItem[],
  seeds: SeedItem[] = [],
): DownloadQueue {
  const active = items.filter((i) => i.status === "downloading").length;
  const seedingCount = seeds.filter((s) => s.status === "seeding").length;
  const seedMap = new Map(seeds.map((s) => [s.id, s]));
  const stub = {
    getItems: () => items,
    getHistory: () => history,
    getSeeds: () => seeds,
    getSeed: (id: string) => seedMap.get(id),
    activeCount: active,
    seedingCount,
    on: () => stub,
    off: () => stub,
  };
  return stub as unknown as DownloadQueue;
}

function makeStore(
  overrides: Partial<Store> = {},
  items: QueueItem[] = [],
  history: HistoryItem[] = [],
  seeds: SeedItem[] = [],
): Store {
  const noop = (): void => {};
  return {
    config: { downloadDir: "~/Downloads/torlink" } as Config,
    setConfig: noop,
    queue: fakeQueue(items, history, seeds),
    view: "browser",
    setView: noop,
    query: "",
    submitQuery: noop,
    searchHistory: [],
    savedSearches: [],
    toggleSavedSearch: noop,
    favourites: [],
    toggleFavourite: noop,
    removeFavourite: noop,
    openFavourite: noop,
    isFavourited: () => false,
    section: "all",
    setSection: noop,
    sort: "none",
    setSort: noop,
    disabledSources: [],
    toggleSource: noop,
    region: "content",
    setRegion: noop,
    captureMode: "none",
    setCaptureMode: noop,
    downloadFocus: null,
    setDownloadFocus: noop,
    seedFocus: null,
    setSeedFocus: noop,
    startDownload: noop,
    requestP2PDownload: noop,
    requestDownloadTo: noop,
    startDebridDownload: noop,
    streamResult: noop,
    debridConfigured: false,
    reccConfigured: false,
    omdbConfigured: false,
    omdbApiKey: "",
    adultEnabled: false,
    streamActive: false,
    rdStatus: null,
    copyLink: noop,
    copyMagnet: noop,
    openDownloadFolder: noop,
    exportTorrent: noop,
    notice: null,
    setNotice: noop,
    quitAll: noop,
    listRows: 14,
    compact: false,
    contentWidth: CONTENT_WIDTH,
    cols: COLS,
    rows: 24,
    ...overrides,
  };
}

function save(
  name: string,
  store: Store,
  node: React.ReactNode,
  extra: Partial<AnsiToSvgOptions> = {},
): void {
  const { lastFrame, unmount } = render(
    <StoreContext.Provider value={store}>{node}</StoreContext.Provider>,
  );
  const frame = lastFrame() ?? "";
  unmount();
  if (!/\x1b\[/.test(frame)) {
    throw new Error(`${name}: frame has no ANSI colors (FORCE_COLOR didn't take)`);
  }
  writeFileSync(
    join(OUT_DIR, `${name}.svg`),
    ansiToSvg(frame, { cols: COLS, title: "torlink", ...extra }),
  );
  console.log(`preview/${name}.svg`);
}

const CATEGORIES = sourcesByGroup()
  .map((g) => g.group.toLowerCase())
  .join(`  ${ICON.dot}  `);

save(
  "splash",
  makeStore({ view: "splash", region: "content" }),
  <Box height={18} flexDirection="column" justifyContent="center" alignItems="center" width={COLS}>
    <Logo />
    <Box marginTop={2}>
      <Text color={COLOR.text}>A curated, terminal-native torrent downloader.</Text>
    </Box>
    <Box>
      <Text dimColor>{CATEGORIES}</Text>
    </Box>
    <Box marginTop={1} width={62}>
      <SearchBar width={62} value="" editing placeholder="Search or paste a magnet link…" onSubmit={() => {}} />
    </Box>
    <Box marginTop={1}>
      <Text>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> search</Text>
        <Text dimColor>{`  ${ICON.dot}  `}</Text>
        <Text dimColor>empty </Text>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> browse</Text>
        <Text dimColor>{`  ${ICON.dot}  `}</Text>
        <Text color={COLOR.alt}>^c</Text>
        <Text dimColor> quit</Text>
      </Text>
    </Box>
  </Box>,
);

const browseResults = RESULTS;
const numW = Math.max(2, String(browseResults.length).length);

// A 100-column terminal (the widest the preview renderer models) is where the
// results list splits to reveal the poster/plot preview pane — so this scene
// renders wider and taller than the others to show it off.
const BROWSE_COLS = 100;
const BROWSE_CW = Math.max(24, BROWSE_COLS - RAIL_WIDTH - 3);
const BROWSE_RULE = Math.max(10, BROWSE_COLS - 2);
const PANEL_H = 20;
const PREVIEW_W = Math.min(46, Math.max(30, Math.round(BROWSE_CW * 0.4)));
const LIST_W = BROWSE_CW - PREVIEW_W - 1;

// Fetch a real poster (OMDb's public sample) and render it as half-blocks, just
// as the app does at runtime. Requires network access when regenerating.
const browsePoster = await fetchPosterRows(
  "https://www.omdbapi.com/src/poster.jpg",
  Math.max(8, PREVIEW_W - 4),
  Math.max(4, PANEL_H - 6),
);
if (!browsePoster) {
  console.warn("browse: poster fetch failed — screenshot will show the empty state");
}

const OPPENHEIMER_PLOT =
  "A dramatization of J. Robert Oppenheimer and his role in developing the atomic bomb during World War II.";

save(
  "browse",
  makeStore({ section: "movies", reccConfigured: true, contentWidth: BROWSE_CW, listRows: PANEL_H, cols: BROWSE_COLS, rows: 28 }),
  <Box flexDirection="column" width={BROWSE_COLS} paddingX={1}>
    <Box justifyContent="space-between">
      <Logo />
    </Box>
    <Rule width={BROWSE_RULE} />
    <Box marginTop={1}>
      <Sidebar />
      <Box flexGrow={1} flexDirection="column">
        <SearchBar width={BROWSE_CW} value="oppenheimer" editing={false} placeholder="Search or paste a magnet link…" onSubmit={() => {}} />
        <Box marginTop={1}>
          <Box marginRight={1}>
            <Panel title="results" width={LIST_W} focused count={`(${browseResults.length})`} height={PANEL_H}>
              <Box><Text dimColor>{`${browseResults.length} results`}</Text></Box>
              <Box flexDirection="column" marginTop={1}>
                <Box>
                  <Box width={2} flexShrink={0} />
                  <Box width={numW} flexShrink={0} justifyContent="flex-end"><Text bold dimColor>#</Text></Box>
                  <Box flexGrow={1} minWidth={0} marginLeft={1}><Text bold dimColor>Name</Text></Box>
                  <Box width={9} flexShrink={0} marginLeft={1} justifyContent="flex-end"><Text bold dimColor>Seed:Lch</Text></Box>
                  <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end"><Text bold dimColor>Src</Text></Box>
                </Box>
                {browseResults.map((r, i) => {
                  const here = i === 0;
                  const ss = SOURCE_STYLE[r.source];
                  return (
                    <Box key={r.infoHash}>
                      <Box width={2} flexShrink={0}>
                        <Text color={COLOR.accent}>{here ? ICON.pointer : ""}</Text>
                      </Box>
                      <Box width={numW} flexShrink={0} justifyContent="flex-end">
                        <Text dimColor>{i + 1}</Text>
                      </Box>
                      <Box flexGrow={1} minWidth={0} marginLeft={1}>
                        <Text wrap="truncate-end" color={here ? COLOR.accent : undefined} dimColor={!here} bold={here}>
                          {cleanText(r.name)}
                        </Text>
                      </Box>
                      <Box width={9} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                        <Text color={r.seeders > 0 ? COLOR.good : undefined} dimColor={r.seeders === 0}>
                          {r.seeders || r.leechers ? `${r.seeders}:${r.leechers}` : "-"}
                        </Text>
                      </Box>
                      <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                        <Text color={ss.color} dimColor={!here}>
                          {ss.tag}
                        </Text>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            </Panel>
          </Box>
          <PreviewPane
            width={PREVIEW_W}
            height={PANEL_H}
            focused
            title="Oppenheimer"
            year={2023}
            plot={OPPENHEIMER_PLOT}
            posterRows={browsePoster}
          />
        </Box>
      </Box>
    </Box>
    <Footer hints={footerHints("content", "movies")} />
  </Box>,
  { cols: BROWSE_COLS },
);

save(
  "downloads",
  makeStore({ section: "downloads", contentWidth: CONTENT_WIDTH, listRows: 14, cols: COLS, rows: 24 }, DOWNLOADS, HISTORY),
  <Box flexDirection="column" width={COLS} paddingX={1}>
    <Box justifyContent="space-between">
      <Logo />
    </Box>
    <Rule width={RULE_WIDTH} />
    <Box height={14} marginTop={1}>
      <Sidebar />
      <Box flexGrow={1} flexDirection="column">
        <Downloads />
      </Box>
    </Box>
    <Footer hints={footerHints("content", "downloads")} />
  </Box>,
  { shimmer: true },
);

save(
  "seeding",
  makeStore(
    { section: "seeding", region: "content", contentWidth: CONTENT_WIDTH, listRows: 14, cols: COLS, rows: 24 },
    [],
    HISTORY,
    SEEDS,
  ),
  <Box flexDirection="column" width={COLS} paddingX={1}>
    <Box justifyContent="space-between">
      <Logo />
    </Box>
    <Rule width={RULE_WIDTH} />
    <Box height={14} marginTop={1}>
      <Sidebar />
      <Box flexGrow={1} flexDirection="column">
        <Seeding />
      </Box>
    </Box>
    <Footer hints={footerHints("content", "seeding")} />
  </Box>,
);

save(
  "accounts",
  makeStore({ section: "accounts", region: "content", contentWidth: CONTENT_WIDTH, listRows: 14, cols: COLS, rows: 24 }),
  <Box flexDirection="column" width={COLS} paddingX={1}>
    <Box justifyContent="space-between">
      <Logo />
    </Box>
    <Rule width={RULE_WIDTH} />
    <Box height={14} marginTop={1}>
      <Sidebar />
      <Box flexGrow={1} flexDirection="column">
        <Accounts
          rdToken="rd_live_xxx"
          rdStatus={RD_STATUS}
          rutrackerUser="you"
          reccConfigured
          reccStatus={{ state: "connected", host: "reccd.local:4100" }}
          onManageRd={() => {}}
          onSignOutRd={() => {}}
          onManageRutracker={() => {}}
          onSignOutRutracker={() => {}}
          onManageRecc={() => {}}
          onSignOutRecc={() => {}}
          onImportRecc={() => {}}
          omdbConfigured
          onManageOmdb={() => {}}
          onSignOutOmdb={() => {}}
        />
      </Box>
    </Box>
    <Footer hints={footerHints("content", "accounts")} />
  </Box>,
);

const PROMPT_WIDTH = Math.max(24, Math.min(COLS - 4, 62));

save(
  "sources",
  makeStore({ region: "content", cols: COLS }),
  <Box flexDirection="column" width={COLS} paddingX={1}>
    <Box justifyContent="space-between">
      <Logo />
    </Box>
    <Rule width={RULE_WIDTH} />
    <Box marginTop={1}>
      <SourcesPrompt
        width={PROMPT_WIDTH}
        disabled={["torrents-csv", "x1337-music"] as SourceId[]}
        adultEnabled={false}
        onToggle={() => {}}
        onCancel={() => {}}
      />
    </Box>
  </Box>,
);

save(
  "help",
  makeStore({ region: "content", cols: COLS }),
  <Box flexDirection="column" width={COLS} paddingX={1}>
    <Box justifyContent="space-between">
      <Logo />
    </Box>
    <Rule width={RULE_WIDTH} />
    <Box marginTop={1}>
      <HelpOverlay />
    </Box>
  </Box>,
);
