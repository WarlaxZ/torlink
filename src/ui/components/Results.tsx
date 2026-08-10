import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { useStore, useQueueItems, useQueueHistory, CATEGORIES, isCategory } from "../store";
import { Spinner } from "./Spinner";
import { SearchBar } from "./SearchBar";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { Rule } from "./Rule";
import { useConcurrentSearch } from "../hooks/useConcurrentSearch";
import { useTitlePreview } from "../hooks/useTitlePreview";
import { useTitleSuggest } from "../hooks/useTitleSuggest";
import { shouldSuggestFor } from "../../util/titleSuggest";
import { PreviewPane } from "./PreviewPane";
import { parseRelease, hintForSection } from "../../util/release";
// The same badges the browser's rows show, from the same table the quality
// preference under `P` reads — one vocabulary, two front ends.
import { releaseBadges } from "../../util/releaseBadges";
// The grouping engine, shared with the browser's results list. `groupCountLabel`
// is deliberately NOT used here — see the "×5" comment on the count cell below.
import {
  defaultExpandedKeys,
  groupHeading,
  groupResults,
  groupRowPlan,
  nextUpRowKey,
  positionNote,
  resultAtRow,
  seasonPlayPlan,
  showKeyOf,
  type PositionLookup,
} from "../../util/resultGroup";
import type { EpisodeRef } from "../../util/episode";
import { openUrl, imdbTitleUrl, imdbFindUrl } from "../../util/openUrl";
import { getSource, enabledSources } from "../../sources/registry";
import { getDebridProvider } from "../../integrations/debrid";
import { wrapStep, windowStart, resultsPanelOuter } from "../move";
import { sortResults, nextSort, sortLabel, sortArrow, type SortField } from "../sort";
import { filterResults } from "../filter";
import { COLOR, GUTTER, ICON, PAUSED, sourceStyle } from "../theme";
import { downloadStateFor, type DownloadState } from "../downloadState";
import { cleanText, formatBytes, formatCount, formatRelative, stripControl, truncate } from "../../util/format";
import type { Source, TorrentResult } from "../../sources/types";
import type { FetchImpl } from "../../util/net";
import type { ReccClientConfig } from "../../recc/client";

type Mode = "list" | "search" | "detail" | "filter";

// Glyph + colour for a result row's download state. Returns null for untouched.
function stateMark(state: DownloadState | null): { icon: string; color?: string; dim?: boolean } | null {
  switch (state) {
    case "downloading":
      return { icon: ICON.down, color: COLOR.accent };
    case "paused":
      return { icon: ICON.pause, color: PAUSED };
    case "failed":
      return { icon: ICON.error, color: COLOR.bad };
    case "done":
      return { icon: ICON.done, color: COLOR.good };
    default:
      return null;
  }
}

const PLACEHOLDER = "Search or paste a magnet link…";

// Below this the terminal is too narrow to split the results list and preview.
const PREVIEW_MIN_WIDTH = 74;

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box>
      <Box width={9} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} minWidth={0}>{value}</Box>
    </Box>
  );
}

function Detail({
  r,
  width,
  debridLabel,
  mark,
  favourited,
  onFavourite,
}: {
  r: TorrentResult;
  width: number;
  // The active provider's display name, or undefined when none is configured.
  debridLabel?: string;
  mark: { icon: string; color?: string; dim?: boolean } | null;
  favourited?: boolean;
  onFavourite?: () => void;
}) {
  const ss = sourceStyle(r.source);
  const date = formatRelative(r.added);
  const health =
    r.seeders || r.leechers ? (
      <Text>
        <Text color={r.seeders > 0 ? COLOR.good : undefined} bold={r.seeders > 0}>
          {r.seeders}
        </Text>
        <Text dimColor>{` seeders ${ICON.dot} ${r.leechers} leechers`}</Text>
      </Text>
    ) : (
      <Text dimColor>unknown</Text>
    );
  return (
    <Box flexDirection="column">
      <Box>
        {mark ? (
          <Box marginRight={1} flexShrink={0}>
            <Text color={mark.color} dimColor={mark.dim}>{mark.icon}</Text>
          </Box>
        ) : null}
        <Box flexGrow={1} minWidth={0}>
          <Text bold color={COLOR.text} wrap="truncate-end">
            {cleanText(r.name)}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text color={ss.color} bold>
            {ss.tag}
          </Text>
        </Box>
      </Box>
      <Rule width={width} />
      <Box marginTop={1} flexDirection="column">
        <DetailRow
          label="Size"
          value={
            r.sizeBytes > 0 ? (
              <Text color={COLOR.text}>{formatBytes(r.sizeBytes)}</Text>
            ) : (
              <Text dimColor>unknown</Text>
            )
          }
        />
        <DetailRow label="Health" value={health} />
        {r.numFiles ? (
          <DetailRow label="Files" value={<Text dimColor>{String(r.numFiles)}</Text>} />
        ) : null}
        {date ? <DetailRow label="Added" value={<Text dimColor>{date}</Text>} /> : null}
        {(r.sources?.length ?? 0) > 1 ? (
          <DetailRow
            label="Sources"
            value={
              <Text dimColor>
                {r.sources!.map((source) => sourceStyle(source).tag).join(", ")}
              </Text>
            }
          />
        ) : null}
        <DetailRow
          label="Hash"
          value={
            <Text color={COLOR.alt} dimColor wrap="truncate-end">
              {stripControl(r.infoHash)}
            </Text>
          }
        />
        <DetailRow
          label="Magnet"
          value={
            <Text color={COLOR.alt} dimColor wrap="truncate-end">
              {stripControl(r.magnet)}
            </Text>
          }
        />
      </Box>
      <Box marginTop={1}>
        <Text color={COLOR.accent} bold>
          d
        </Text>
        <Text color={COLOR.text}> Download</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.accent} bold>
          f
        </Text>
        <Text color={COLOR.text}> Download to</Text>
        {debridLabel ? (
          <>
            <Text dimColor>{`     ${ICON.dot}     `}</Text>
            <Text color={COLOR.accent} bold>
              r
            </Text>
            <Text color={COLOR.text}>{` ${debridLabel}`}</Text>
            <Text dimColor>{`     ${ICON.dot}     `}</Text>
            <Text color={COLOR.accent} bold>
              v
            </Text>
            <Text color={COLOR.text}> Stream</Text>
          </>
        ) : null}
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.accent} bold>
          y
        </Text>
        <Text color={COLOR.text}> Copy</Text>
        {onFavourite ? (
          <>
            <Text dimColor>{`     ${ICON.dot}     `}</Text>
            <Text color={COLOR.accent} bold>
              b
            </Text>
            <Text color={COLOR.text}>{` ${favourited ? "★" : "☆"} Favourite`}</Text>
          </>
        ) : null}
        <Text dimColor>{`  ${ICON.dot}  `}</Text>
        <Text color={COLOR.accent} bold>
          e
        </Text>
        <Text color={COLOR.text}> Export</Text>
        <Text dimColor>{`  ${ICON.dot}  `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> back</Text>
      </Box>
    </Box>
  );
}

interface ResultsProps {
  /**
   * reccd's address, for title suggestions in the search box. A prop rather than
   * a `Store` field for the reason `ForYou`'s is: a `Store` field needs matching
   * entries in `makeStore` and `makeTestStore`, and no other pane reads this.
   */
  reccConfig: ReccClientConfig;
  /** Only ever set by tests, so they never dial out. Same as `ForYou`'s. */
  fetchImpl?: FetchImpl;
}

export function Results({ reccConfig, fetchImpl }: ResultsProps) {
  const {
    query,
    submitQuery,
    searchHistory,
    disabledSources,
    section,
    region,
    setRegion,
    setCaptureMode,
    requestP2PDownload,
    requestDownloadTo,
    startDebridDownload,
    streamResult,
    debridProvider,
    copyMagnet,
    fetchAndExportTorrent,
    setResultFocus,
    contentWidth,
    listRows,
    queue,
    sort,
    setSort,
    toggleSavedSearch,
    toggleFavourite,
    isFavourited,
    adultEnabled,
    streamHistory,
    omdbApiKey,
    cachedHashes,
    refreshCachedHashes,
  } = useStore();
  const [previewOn, setPreviewOn] = useState(true);
  const debridLabel = debridProvider ? getDebridProvider(debridProvider).label : undefined;

  const search = useConcurrentSearch(query, disabledSources, adultEnabled);

  // Fired once a search settles (loading -> false), never before — the cached
  // lookup is advisory and must not delay the results the user actually asked
  // for. `refreshCachedHashes` itself no-ops when the active provider can't
  // answer, so this fires unconditionally and lets that live in one place.
  useEffect(() => {
    if (search.loading) return;
    refreshCachedHashes(search.results.map((r) => r.infoHash));
  }, [search.loading, search.results, refreshCachedHashes]);
  const enabled = useMemo(
    () => enabledSources(disabledSources, adultEnabled),
    [disabledSources, adultEnabled],
  );

  // Where the user is in each show, by the same normalised show key the group
  // keys use — one normaliser since titleKey.ts unified them. Memoised so the
  // seeding effects below do not re-run every render.
  const positionFor = useMemo<PositionLookup>(() => {
    const byShow = new Map<string, EpisodeRef>();
    // `?? []` is not paranoia: Results.ratePrompt.test.tsx builds a partial store
    // with `as unknown as Store`, and a crash here takes the whole results list
    // down. A missing convenience list must degrade to "no position known".
    for (const item of streamHistory ?? []) {
      if (item.type !== "series") continue;
      if (item.season === undefined || item.episode === undefined) continue;
      byShow.set(item.key.replace(/\|series$/, ""), { season: item.season, episode: item.episode });
    }
    return (showKey) => byShow.get(showKey) ?? null;
  }, [streamHistory]);

  const queueItems = useQueueItems(queue);
  const queueHistory = useQueueHistory(queue);
  const stateFor = (hash: string): DownloadState | null =>
    downloadStateFor(hash, queueItems, queueHistory);
  // `aliveOnly` is the fork's name for upstream's hideDead; `textFilter` is the
  // upstream in-memory token filter. `sort` is persisted via the store.
  const [aliveOnly, setAliveOnly] = useState(false);
  const [textFilter, setTextFilter] = useState("");

  const results = useMemo(() => {
    const cat = CATEGORIES.find((c) => c.key === section);
    const base = cat?.group
      ? search.results.filter((r) => getSource(r.source).groups?.includes(cat.group!))
      : search.results;
    return sortResults(filterResults(base, aliveOnly, textFilter), sort);
  }, [search.results, section, sort, aliveOnly, textFilter]);

  const focused = region === "content" && isCategory(section);
  const [mode, setMode] = useState<Mode>("list");
  // The live draft in the search box, which is what suggestions are for —
  // `query` is the last SUBMITTED search, and suggesting against that would lag
  // a whole search behind.
  const [draft, setDraft] = useState(query);
  const suggest = useTitleSuggest({
    reccConfig,
    query: draft,
    // Editing, AND the text has actually moved on from the last submitted search.
    // The second half is what stops `/` popping a list over the search you are
    // already looking at — see `shouldSuggestFor` for why it is derived here
    // rather than latched when the box is entered.
    enabled: mode === "search" && shouldSuggestFor(draft, query),
    fetchImpl,
  });
  const [cursor, setCursor] = useState(0);
  // Many releases of one title collapse to one row. ON by default, matching the
  // browser's checkbox: a browse routinely returns four uploads of every film.
  // Local state, like previewOn and aliveOnly — the browser stores its own in
  // localStorage and neither surface has ever persisted the other's view options.
  const [grouped, setGrouped] = useState(true);
  // Which group headings are open, by group key. Cleared with the query for the
  // reason the cursor is: the keys of one search name nothing in the next.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // The highest-ranked season opens itself once per result set. SEEDED rather
  // than applied every render, so collapsing it stays collapsed — the set means
  // "what is open", and a running rule would fight the user. The effect itself
  // lives BELOW the query-change effect that clears `expanded`: effects run in
  // declaration order, and seeding above it just gets wiped on mount.
  const seeded = useRef(false);
  // Landing on the next episode is a second one-shot, tracked separately: the
  // expansion seed runs before `rows` exists, and the cursor move needs them.
  const landed = useRef(false);
  // The row the user navigated to; null until they move. Keeps the cursor on
  // their row while streamed-in sources reshuffle the list.
  //
  // BOTH the row key and the release hash. The key is the exact identity (an
  // expanded group's heading and its first member share a hash but not a key);
  // the hash is what still finds the row when grouping has since moved that
  // release into a collapsed group under a different key.
  const selRef = useRef<{ key: string; hash: string } | null>(null);
  const [detail, setDetail] = useState<TorrentResult | null>(null);

  // A new search jumps back to the top.
  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Switching to a *different* category tab jumps to the top — but returning
  // from the Downloads/Seeding views must not, so the scroll position survives
  // that round-trip. We remember the last category and only reset when it
  // actually changes (downloads/seeding don't update it).
  const lastCategory = useRef(isCategory(section) ? section : "");
  useEffect(() => {
    if (!isCategory(section)) return;
    if (lastCategory.current !== section) {
      lastCategory.current = section;
      setCursor(0);
    }
  }, [section]);

  useEffect(() => {
    selRef.current = null;
    setCursor(0);
    setTextFilter("");
    // The group keys of one search name nothing in the next — except by accident,
    // since "kestrel|2010|movie" is the same key in every search that returns it,
    // which would silently expand a group the user never opened.
    setExpanded(new Set());
    // Let the next result set seed its season open again.
    seeded.current = false;
    landed.current = false;
  }, [query, section]);

  // Seeds the season the user most likely wants, once per result set. Declared
  // after the clear above on purpose — see the note on `seeded`.
  useEffect(() => {
    if (results.length === 0) {
      seeded.current = false;
      landed.current = false;
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    landed.current = true;
    const keys = defaultExpandedKeys(groupResults(results, hintForSection(section)), positionFor);
    if (keys.length > 0) setExpanded(new Set(keys));
  }, [results, section, positionFor]);


  useEffect(() => {
    if (!focused) return;
    setCaptureMode(mode === "search" || mode === "filter" ? "text" : mode === "detail" ? "esc" : "none");
    return () => setCaptureMode("none");
  }, [mode, focused, setCaptureMode]);

  useEffect(() => {
    if (!focused) setMode("list");
  }, [focused]);

  // Mirrors the detail/list split into the store so the footer can advertise the
  // keys the current view actually binds. Cleared on blur so another section's
  // footer is never rendered against a stale results focus.
  useEffect(() => {
    if (!focused) return;
    setResultFocus(mode === "detail" ? "detail" : "list");
    return () => setResultFocus(null);
  }, [mode, focused, setResultFocus]);

  // Entering search mode remounts the TextField with `query` in it, so the draft
  // is resynced to match. Otherwise leaving the box with text in it and arrowing
  // back up into it would suggest against the abandoned text while the box shows
  // something else.
  //
  // This is about draft CORRECTNESS only. It is deliberately not what stops a
  // list opening over text the user did not just type — that is
  // `shouldSuggestFor` in the `enabled` argument above, which is re-derived every
  // render and so cannot be defeated by a path into search mode that forgets to
  // call this.
  const enterSearch = (): void => {
    setDraft(query);
    setMode("search");
  };

  // The rows on screen: group headings and releases, in order. The SAME
  // groupRowPlan the browser's list renders — "which rows are there" is one
  // decision with two renderers, which is why it lives in src/util.
  const rows = useMemo(
    () =>
      grouped
        ? groupRowPlan(groupResults(results, hintForSection(section)), expanded)
        : results.map((result) => ({
            kind: "release" as const,
            key: result.infoHash,
            result,
            inGroup: false,
            depth: 0,
          })),
    [results, grouped, expanded, section],
  );

  // THE CURSOR INDEXES `rows`, NOT `results`. With grouping on those two disagree
  // — 210 results behind 121 rows — and every action key resolves through
  // `resultAt` so a collapsed heading hands them its best member.
  const clamped = Math.min(cursor, Math.max(0, rows.length - 1));

  /** The release a row acts on: itself, or a collapsed group's best member. */
  const resultAt = (index: number): TorrentResult | null => {
    const row = rows[index];
    return row ? resultAtRow(row) : null;
  };

  // MAKES selRef REAL. It was written in two places and read in none, so its
  // comment — "keeps the cursor on their row while streamed-in sources reshuffle
  // the list" — was a false promise. Grouping reshuffles rows for a living: a
  // frame that adds one release can turn a plain row into a heading and move
  // everything below it.
  //
  // MATCHES ON THE ROW KEY FIRST, and that ordering is the whole fix. An
  // infoHash is not a unique row identity: an expanded group's heading and its
  // first member both resolve to members[0], and the heading has the lower index.
  // Matching by hash alone therefore dragged the cursor off a member row back up
  // to its heading on every streamed frame — reintroducing, through grouping, the
  // exact wandering-cursor problem selRef exists to prevent.
  //
  // The hash is kept as the FALLBACK, for when the row key has genuinely gone:
  // a release folded into a newly-collapsed group then lands on that group's
  // heading rather than resetting to the top.
  useEffect(() => {
    const want = selRef.current;
    if (want === null) return;
    const byKey = rows.findIndex((row) => row.key === want.key);
    if (byKey >= 0) {
      setCursor(byKey);
      return;
    }
    const byHash = rows.findIndex(
      (row) =>
        resultAtRow(row)?.infoHash === want.hash ||
        (row.kind === "group" && row.members.some((m) => m.infoHash === want.hash)),
    );
    if (byHash >= 0) setCursor(byHash);
  }, [rows]);

  // The SearchBar's own rows PLUS whatever suggestion rows it is currently
  // emitting, because those sit above the results panel in the same column and
  // the parent gives this view exactly `listRows` rows with overflow hidden. Left
  // at a constant 3, an open list pushed the panel out by its own row count: Yoga
  // shrank the panel or the clip took its bottom border, and it grew back when the
  // list closed — jitter per keystroke.
  //
  // `resultsPanelOuter` floors the panel at 5 rows, so on a very short terminal a
  // long list still cannot fit and the floor wins. That is the pre-existing
  // minimum rather than something this adds, and shrinking a panel to nothing
  // would be worse than clipping.
  const searchH = 3 + suggest.items.length;
  const filterH = mode === "filter" || textFilter.trim() ? 1 : 0;
  const panelOuter = resultsPanelOuter(listRows, searchH + filterH);
  const listHeight = Math.max(3, panelOuter - 4);
  const pageJump = Math.max(1, listHeight - 1);

  // Poster/plot preview for the highlighted result. Search results carry no
  // imdbId, so we parse a title+year out of the release name and look it up by
  // name — best-effort, gated to video sections and an OMDb key.
  const selectedResult = resultAt(clamped) ?? undefined;
  const previewSection = useMemo(() => {
    const g = CATEGORIES.find((c) => c.key === section)?.group;
    return !g || g === "Movies" || g === "TV" || g === "Anime";
  }, [section]);
  const showPreview =
    previewOn && omdbApiKey !== "" && previewSection && mode !== "detail" && contentWidth >= PREVIEW_MIN_WIDTH;
  const previewWidth = showPreview ? Math.min(46, Math.max(30, Math.round(contentWidth * 0.4))) : 0;
  const listWidth = showPreview ? contentWidth - previewWidth - 1 : contentWidth;

  // How many quality badges a row can afford.
  //
  // The row is a fixed-column layout — number, mark, name, badges, size,
  // seed:lch, source — so a badge DOES cost the name width: at 80 columns one
  // badge shortens "Kestrel.2010.1080p.BluRay.x264" to "Kestrel.2010.1…". That is
  // the deliberate trade, because the six columns it costs are the ones the
  // resolution was hiding in anyway, and one badge is worth more than six more
  // characters of a release name.
  //
  // It is why releaseBadges puts the resolution first: what survives this slice
  // has to be the fact worth keeping.
  //
  // Measured against listWidth, not contentWidth: with the preview pane open the
  // list has 40% less room and the budget has to follow.
  const badgeBudget = listWidth >= 108 ? 3 : listWidth >= 88 ? 2 : listWidth >= 56 ? 1 : 0;
  const rowBadges = (name: string): string[] =>
    badgeBudget === 0 ? [] : releaseBadges(name, hintForSection(section)).slice(0, badgeBudget);
  const parsed = useMemo(
    () => (selectedResult ? parseRelease(selectedResult.name, hintForSection(section)) : null),
    [selectedResult, section],
  );

  // Open a result on IMDb: the exact title page when we've resolved an id,
  // otherwise a best-effort IMDb title search from the parsed name.
  const openImdbFor = (name: string, resolvedId?: string | null): void => {
    if (resolvedId) {
      void openUrl(imdbTitleUrl(resolvedId));
      return;
    }
    const p = parseRelease(name, hintForSection(section));
    if (p?.title) void openUrl(imdbFindUrl(p.year ? `${p.title} ${p.year}` : p.title));
  };
  // SEASON AND EPISODE ARE PART OF THE CACHE IDENTITY. `parsed.key` is
  // `title|year|type`, which for a series is the same string for every episode
  // of every season — exactly what makes quality variants share one lookup, and
  // exactly what would make every episode render episode one's plot.
  const previewEpisode =
    parsed?.type === "series" && parsed.season !== undefined && parsed.episode !== undefined
      ? { season: parsed.season, episode: parsed.episode }
      : null;
  const preview = useTitlePreview({
    omdbApiKey,
    enabled: showPreview,
    cacheKey: parsed
      ? `${parsed.key}|${previewEpisode ? `s${previewEpisode.season}e${previewEpisode.episode}` : ""}`
      : "",
    query: parsed
      ? {
          by: "name",
          title: parsed.title,
          year: parsed.year,
          type: parsed.type,
          ...(previewEpisode ?? {}),
        }
      : null,
    posterCols: Math.max(8, previewWidth - 4),
    posterMaxRows: Math.max(4, panelOuter - 8),
  });

  const inputFor = (r: TorrentResult) => ({
    id: r.infoHash,
    name: r.name,
    magnet: r.magnet,
    source: r.source,
    sizeBytes: r.sizeBytes,
  });

  const openDownload = (r: TorrentResult): void => requestP2PDownload(inputFor(r));

  const openDebrid = (r: TorrentResult): void => startDebridDownload(inputFor(r));

  const openStream = (r: TorrentResult): void => streamResult(inputFor(r));

  const openDownloadTo = (r: TorrentResult): void =>
    requestDownloadTo({
      id: r.infoHash,
      name: r.name,
      magnet: r.magnet,
      source: r.source,
      sizeBytes: r.sizeBytes,
    });

  const copyResultMagnet = (r: TorrentResult): void =>
    copyMagnet({ name: r.name, magnet: r.magnet });

  // Favourites are for video content only (Movies / TV / Anime).
  const canFavourite = (r: TorrentResult): boolean => {
    const groups = getSource(r.source).groups ?? [];
    return groups.some((g) => g === "Movies" || g === "TV" || g === "Anime");
  };

  const favInput = (r: TorrentResult) => ({
    id: r.infoHash,
    name: r.name,
    magnet: r.magnet,
    source: r.source,
    sizeBytes: r.sizeBytes,
    addedAt: Date.now(),
  });

  const moveTo = (n: number): void => {
    setCursor(n);
    const row = rows[n];
    const hash = row ? resultAtRow(row)?.infoHash : undefined;
    selRef.current = row && hash ? { key: row.key, hash } : null;
  };

  // Land on the episode you are up to. Declared AFTER moveTo, which it calls.
  //
  // Once per result set, like the expansion seed and for the same reason: a
  // running rule would drag the cursor back every time a source streams in.
  // Null when the results do not have that episode — a position is a
  // suggestion, and the results are the authority on what can be selected.
  useEffect(() => {
    if (!landed.current || rows.length === 0) return;
    const key = nextUpRowKey(groupResults(results, hintForSection(section)), positionFor);
    if (!key) {
      landed.current = false; // nothing to land on; stop looking
      return;
    }
    const at = rows.findIndex((row) => row.key === key);
    // NOT FOUND YET is not "not found". The expansion seed and this run in the
    // same commit, so on the first pass `rows` was still built from the empty
    // expanded set and the episode row does not exist. Keep the one-shot armed
    // until the row is actually there, or the cursor never moves.
    if (at < 0) return;
    landed.current = false;
    moveTo(at);
    // moveTo is recreated every render and intentionally left out: this fires
    // once per result set, and depending on it would re-run on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, results, section, positionFor]);

  useInput(
    (input, key) => {
      if (input === "/") {
        enterSearch();
        return;
      }
      if (key.upArrow || input === "k") {
        if (rows.length > 0 && clamped > 0) moveTo(clamped - 1);
        else enterSearch();
        return;
      }
      if (input === "g") {
        // Grouping on/off wholesale — the browser's `group` checkbox, as a key.
        setGrouped((v) => !v);
        setExpanded(new Set());
        return;
      }
      if (input === "s") {
        setSort(nextSort(sort));
      } else if (input === "z") {
        setAliveOnly((current) => !current);
        setCursor(0);
      } else if (input === "f") {
        setMode("filter");
      } else if (input === "w" && query.trim()) {
        toggleSavedSearch(query.trim());
      } else if (input === "p") {
        setPreviewOn((v) => !v);
      } else if (rows.length === 0) {
        return;
      } else if (input === " ") {
        // Expand or collapse the group under the cursor. Space is the tree idiom
        // and it is free here; the arrow keys are not — → and ← are pane
        // navigation in App.tsx.
        const row = rows[clamped];
        if (row?.kind === "group") {
          const key_ = row.key;
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(key_)) next.delete(key_);
            else next.add(key_);
            return next;
          });
        }
      } else if (key.downArrow || input === "j") {
        moveTo(wrapStep(clamped, 1, rows.length));
      } else if (key.pageUp) {
        moveTo(Math.max(0, clamped - pageJump));
      } else if (key.pageDown) {
        moveTo(Math.min(rows.length - 1, clamped + pageJump));
      } else if (key.return) {
        const r = resultAt(clamped);
        if (r) {
          setDetail(r);
          setMode("detail");
        }
      } else if (input === "d") {
        const r = resultAt(clamped);
        if (r) openDownload(r);
      } else if (input === "D") {
        const r = resultAt(clamped);
        if (r) openDownloadTo(r);
      } else if (input === "r") {
        const r = resultAt(clamped);
        if (r) openDebrid(r);
      } else if (input === "v") {
        const row = rows[clamped];
        if (row?.kind === "season") {
          const plan = seasonPlayPlan(
            groupResults(results, hintForSection(section)),
            row.key,
            positionFor,
          );
          if (plan.kind === "reveal") {
            // Reveal the episodes and land the cursor on the next-up one. selRef
            // moves the cursor to the row once the rebuilt rows include it.
            if (plan.select) selRef.current = { key: plan.selectKey!, hash: plan.select.infoHash };
            setExpanded((current) => new Set(current).add(plan.expandKey));
          } else if (plan.result) {
            openStream(plan.result);
          }
        } else {
          const r = resultAt(clamped);
          if (r) openStream(r);
        }
      } else if (input === "y") {
        const r = resultAt(clamped);
        if (r) copyResultMagnet(r);
      } else if (input === "i") {
        const r = resultAt(clamped);
        if (r) openImdbFor(r.name, preview.imdbId);
      }
    },
    { isActive: focused && mode === "list" },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        setMode("list");
        setDetail(null);
      } else if (input === "d" && detail) openDownload(detail);
      else if (input === "D" && detail) openDownloadTo(detail);
      else if (input === "r" && detail) openDebrid(detail);
      else if (input === "v" && detail) openStream(detail);
      else if (input === "y" && detail) copyResultMagnet(detail);
      else if (input === "i" && detail) openImdbFor(detail.name);
      else if (input === "b" && detail && canFavourite(detail)) toggleFavourite(favInput(detail));
      else if (input === "e" && detail)
        fetchAndExportTorrent({ id: detail.infoHash, name: detail.name, magnet: detail.magnet });
    },
    { isActive: focused && mode === "detail" },
  );

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      // Escape escalates: the first one puts the suggestion list away, the
      // second leaves the box. Doing both at once would make dismissing a list
      // cost you your place in the pane.
      if (mode === "search" && suggest.open) {
        suggest.dismiss();
        return;
      }
      setMode("list");
    },
    { isActive: focused && (mode === "search" || mode === "filter") },
  );

  const onSubmit = (value: string): void => {
    setMode("list");
    submitQuery(value);
  };

  const browsing = query.trim() === "";
  const erroredCount = useMemo(
    () => Object.values(search.perSource).filter((s) => s.error).length,
    [search.perSource],
  );
  const activeCat = CATEGORIES.find((c) => c.key === section);
  const tabSources = activeCat?.group
    ? enabled.filter((s) => s.groups?.includes(activeCat.group!))
    : enabled;
  const tabErrored =
    tabSources.length > 0 && tabSources.every((s) => search.perSource[s.id]?.error);
  // Only the active tab's sources hold its spinner; other groups' stragglers
  // stream in silently.
  const pending = tabSources.some((s) => search.perSource[s.id]?.loading);
  const showStats = useMemo(
    () => results.some((r) => r.sizeBytes > 0 || r.seeders > 0),
    [results],
  );
  // Numbers the ROWS, which with grouping on is fewer than the results.
  const numW = Math.max(2, String(rows.length).length);

  const outageCodes = (sources: readonly Source[]): string => {
    const codes = [
      ...new Set(sources.map((s) => search.perSource[s.id]?.code).filter(Boolean)),
    ];
    return codes.length ? ` (${codes.join(", ")})` : "";
  };

  // RuTracker sources fail closed with an auth error rather than an outage
  // code, so nudge the user toward the login prompt instead of implying the
  // site is down.
  const authHint = (sources: readonly Source[]): string =>
    sources.some(
      (s) => s.id.startsWith("rt-") && /log in|login|session/i.test(search.perSource[s.id]?.error ?? ""),
    )
      ? " Sign in from the Accounts tab to search RuTracker."
      : "";

  const sortNote = sort === "none" ? "" : `  ${ICON.dot} sort: ${sortLabel(sort)}`;
  const filterNote = aliveOnly ? `  ${ICON.dot} alive only` : "";

  const status = () => {
    if (pending) {
      // Rows are already usable: the settled header simply carries a spinner
      // until the tab's last source lands.
      if (results.length > 0)
        return <Text dimColor>{`searching… ${search.done}/${search.total} sources${sortNote}${filterNote}`}</Text>;
      return (
        <Spinner label={`${browsing ? "Loading" : "Searching"} ${search.done}/${search.total} sources`} />
      );
    }
    if (results.length === 0) {
      if (erroredCount >= search.total) {
        const downAll = enabled.filter((s) => search.perSource[s.id]?.error);
        return (
          <Text color={COLOR.warn}>
            {`Couldn't reach any source. They may be down${outageCodes(downAll)}.${authHint(downAll)}`}
          </Text>
        );
      }
      if (tabErrored && activeCat) {
        const down = tabSources.filter((s) => search.perSource[s.id]?.error);
        const who = down.length === 1 ? "The source" : `All ${down.length} sources`;
        return (
          <Text color={COLOR.warn}>
            {`Couldn't reach ${activeCat.label}. ${who} may be down${outageCodes(down)}.${authHint(down)}`}
          </Text>
        );
      }
      if (aliveOnly) {
        const cat = CATEGORIES.find((c) => c.key === section);
        const base = cat?.group
          ? search.results.filter((r) => getSource(r.source).groups?.includes(cat.group!))
          : search.results;
        if (base.length > 0 && base.every((r) => r.seeders <= 0)) {
          return (
            <Text dimColor>
              All results have zero seeders. Press z to show them.
            </Text>
          );
        }
      }
      if (search.results.length > 0 && activeCat?.group)
        return <Text dimColor>{`No ${activeCat.label.toLowerCase()} results yet. Try another tab or a search.`}</Text>;
      return (
        <Text dimColor>
          {browsing ? "Nothing new right now." : `No results for "${truncate(query, 28)}".`}
        </Text>
      );
    }
    const note = erroredCount > 0 ? `  (${erroredCount} source${erroredCount === 1 ? "" : "s"} down)` : "";
    const head = browsing
      ? "newest across all sources"
      : `${results.length} result${results.length === 1 ? "" : "s"}`;
    return <Text dimColor>{`${head}${note}${sortNote}${filterNote}`}</Text>;
  };

  const sortMark = (field: SortField, label: string): ReactNode => {
    if (sort === "none" || sort.field !== field) return label;
    return (
      <>
        <Text color={COLOR.accent} bold>{sortArrow(sort.dir)}</Text>
        {label}
      </>
    );
  };

  const start = windowStart(clamped, rows.length, listHeight);
  const visible = rows.slice(start, start + listHeight);
  const count = results.length > 0 ? `(${results.length})` : undefined;

  return (
    <Box flexDirection="column">
      <SearchBar
        width={contentWidth}
        value={query}
        editing={mode === "search"}
        placeholder={PLACEHOLDER}
        history={searchHistory}
        suggestions={suggest.items}
        completion={suggest.completion}
        onChange={setDraft}
        onComplete={(text) => {
          setDraft(text);
          suggest.accept(text);
        }}
        onSubmit={onSubmit}
        onExitDown={() => setMode("list")}
        onExitLeft={() => setRegion("sidebar")}
      />
      <Box marginTop={1}>
        <Box marginRight={showPreview ? 1 : 0}>
        <Panel
          title={mode === "detail" ? "details" : browsing ? "latest" : "results"}
          width={listWidth}
          focused={focused && mode !== "search"}
          count={mode === "detail" ? undefined : count}
          height={panelOuter}
        >
          {mode === "detail" && detail ? (
            <Detail
              r={detail}
              width={Math.max(10, contentWidth - 4)}
              debridLabel={debridLabel}
              mark={stateMark(stateFor(detail.infoHash))}
              favourited={canFavourite(detail) ? isFavourited(detail.infoHash) : false}
              onFavourite={canFavourite(detail) ? () => toggleFavourite(favInput(detail)) : undefined}
            />
          ) : (
            <>
              <Box>{status()}</Box>
              <Box flexDirection="column" marginTop={results.length > 0 ? 1 : 0}>
                {results.length > 0 ? (
                  <Box>
                    <Box width={GUTTER} flexShrink={0} />
                    <Box width={numW} flexShrink={0} justifyContent="flex-end">
                      <Text bold dimColor>#</Text>
                    </Box>
                    <Box width={1} flexShrink={0} marginLeft={1} />
                    <Box flexGrow={1} minWidth={0} marginLeft={1}>
                      <Text bold dimColor>Name</Text>
                    </Box>
                    {showStats ? (
                      <>
                        <Box width={10} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                          <Text bold dimColor>{sortMark("size", "Size")}</Text>
                        </Box>
                        <Box width={9} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                          <Text bold dimColor>{sortMark("seeders", "Seed:Lch")}</Text>
                        </Box>
                      </>
                    ) : (
                      <Box width={12} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                        <Text bold dimColor>Added</Text>
                      </Box>
                    )}
                    <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                      <Text bold dimColor>{sortMark("source", "Src")}</Text>
                    </Box>
                  </Box>
                ) : null}
                {visible.map((row, i) => {
                  const index = start + i;
                  const here = index === clamped && focused && mode === "list";
                  // A heading acts on its best member, so every column below —
                  // the state mark, the badges, the stats, the source tag — reads
                  // from the release the row would act on if you pressed `v`.
                  // Never null: groupRowPlan does not emit empty groups.
                  const r = resultAtRow(row)!;
                  const isGroup = row.kind === "group" || row.kind === "season";
                  const ss = sourceStyle(r.source);
                  // The disclosure arrow and the member indent live INSIDE the
                  // name cell rather than in columns of their own. At 80 columns
                  // the list has ~61 to spend and the name is already truncated;
                  // two more fixed columns would come straight out of it.
                  // groupHeading, not a local format: the browser's headings go
                  // through the same call, and a show's season is the only thing
                  // telling one heading from the next. Children of a season take
                  // the short form — the season row above them already states the
                  // show, and repeating it at every level is noise.
                  const indent = "  ".repeat(row.depth);
                  // How far through this season you are — "up to E07", never
                  // "watched": the store is a high-water mark, so it cannot
                  // honestly claim the episodes below it were all seen.
                  const note =
                    row.kind === "season"
                      ? positionNote(row.season, positionFor(showKeyOf(row.key)))
                      : "";
                  const label =
                    row.kind === "season"
                      ? `${indent}${row.expanded ? ICON.caretDown : ICON.caretRight} ${groupHeading(row)}${note ? ` ${ICON.dot} ${note}` : ""}`
                      : row.kind === "group"
                        ? `${indent}${row.expanded ? ICON.caretDown : ICON.caretRight} ${groupHeading(row, { underSeason: row.depth > 0 })}`
                        : `${indent}${cleanText(r.name)}`;
                  return (
                    <Box key={row.key}>
                      <Box width={GUTTER} flexShrink={0}>
                        <Text color={COLOR.accent}>{here ? ICON.pointer : ""}</Text>
                      </Box>
                      <Box width={numW} flexShrink={0} justifyContent="flex-end">
                        <Text dimColor>{index + 1}</Text>
                      </Box>
                      <Box width={1} flexShrink={0} marginLeft={1}>
                        {(() => {
                          const m = stateMark(stateFor(r.infoHash));
                          return m ? <Text color={m.color} dimColor={m.dim}>{m.icon}</Text> : <Text> </Text>;
                        })()}
                      </Box>
                      <Box flexGrow={1} minWidth={0} marginLeft={1}>
                        <Text
                          wrap="truncate-end"
                          color={here ? COLOR.accent : undefined}
                          dimColor={!here && !isGroup}
                          bold={here || isGroup}
                        >
                          {label}
                        </Text>
                      </Box>
                      {isGroup ? (
                        <Box flexShrink={0} marginLeft={1}>
                          {/* "x5", not the browser's "5 releases": this row has
                              ~61 columns and that one does not. Same trade the
                              stats columns already make, showing "40:6" where
                              the browser writes "40 seeders / 6 leechers". */}
                          <Text dimColor>{`${ICON.times}${row.members.length}`}</Text>
                        </Box>
                      ) : null}
                      {rowBadges(r.name).map((badge) => (
                        <Box key={badge} flexShrink={0} marginLeft={1}>
                          <Text dimColor>{badge}</Text>
                        </Box>
                      ))}
                      {cachedHashes.has(r.infoHash.toLowerCase()) ? (
                        <Box flexShrink={0} marginLeft={1}>
                          <Text color={COLOR.good}>cached</Text>
                        </Box>
                      ) : null}
                      {showStats ? (
                        <>
                          <Box width={10} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                            <Text
                              dimColor={!here}
                              bold={here}
                            >{r.sizeBytes > 0 ? formatBytes(r.sizeBytes) : "-"}
                            </Text>
                          </Box>
                          <Box width={9} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                            <Text
                              color={r.seeders > 0 ? COLOR.good : undefined}
                              dimColor={!here}
                              bold={here}
                            >{r.seeders || r.leechers
                                ? `${formatCount(r.seeders)}:${formatCount(r.leechers)}`
                                : "-"}
                            </Text>
                          </Box>
                        </>
                      ) : (
                        <Box width={12} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                          <Text
                            dimColor={!here}
                            bold={here}
                          >{formatRelative(r.added) || "-"}
                          </Text>
                        </Box>
                      )}
                      <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                        <Text
                          color={ss.color}
                          dimColor={!here}
                          bold={here}
                        >{ss.tag}
                        </Text>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            </>
          )}
        </Panel>
        </Box>
        {showPreview && selectedResult ? (
          <PreviewPane
            width={previewWidth}
            height={panelOuter}
            focused={focused && mode === "list"}
            title={parsed?.title ?? cleanText(selectedResult.name)}
            year={parsed?.year}
            plot={preview.plot}
            posterRows={preview.posterRows}
          />
        ) : null}
      </Box>
      {(mode === "filter" || textFilter.trim()) && (
        <Box width={contentWidth} paddingLeft={1}>
          <Box flexShrink={0}>
            <Text color={COLOR.accent}>{`Filter ${ICON.pointer} `}</Text>
          </Box>
          <Box flexGrow={1} minWidth={0}>
            {mode === "filter" ? (
              <TextField
                defaultValue={textFilter}
                width={Math.max(1, contentWidth - 10)}
                onChange={setTextFilter}
                // Commit from the submit value / functional form, not the
                // render closure: a same-tick burst (ctrl+u then enter) would
                // otherwise resurrect the pre-clear text.
                onSubmit={(value) => { setTextFilter(value.trim()); setMode("list"); }}
                onExitDown={() => { setTextFilter((cur) => cur.trim()); setMode("list"); }}
                onExitLeft={() => { setTextFilter((cur) => cur.trim()); setMode("list"); }}
              />
            ) : (
              <Text wrap="truncate-end">{textFilter}</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
