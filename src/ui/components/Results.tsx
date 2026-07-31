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
import { PreviewPane } from "./PreviewPane";
import { parseRelease, hintForSection } from "../../util/release";
// The same badges the browser's rows show, from the same table the quality
// preference under `P` reads — one vocabulary, two front ends.
import { releaseBadges } from "../../util/releaseBadges";
// The grouping engine, shared with the browser's results list. `groupCountLabel`
// is deliberately NOT used here — see the "×5" comment on the count cell below.
import { groupResults, groupRowPlan, resultAtRow } from "../../util/resultGroup";
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
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> back</Text>
      </Box>
    </Box>
  );
}

export function Results() {
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
    contentWidth,
    listRows,
    queue,
    sort,
    setSort,
    toggleSavedSearch,
    toggleFavourite,
    isFavourited,
    adultEnabled,
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
  const [cursor, setCursor] = useState(0);
  // Many releases of one title collapse to one row. ON by default, matching the
  // browser's checkbox: a browse routinely returns four uploads of every film.
  // Local state, like previewOn and aliveOnly — the browser stores its own in
  // localStorage and neither surface has ever persisted the other's view options.
  const [grouped, setGrouped] = useState(true);
  // Which group headings are open, by group key. Cleared with the query for the
  // reason the cursor is: the keys of one search name nothing in the next.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
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
  }, [query, section]);


  useEffect(() => {
    if (!focused) return;
    setCaptureMode(mode === "search" || mode === "filter" ? "text" : mode === "detail" ? "esc" : "none");
    return () => setCaptureMode("none");
  }, [mode, focused, setCaptureMode]);

  useEffect(() => {
    if (!focused) setMode("list");
  }, [focused]);

  // The rows on screen: group headings and releases, in order. The SAME
  // groupRowPlan the browser's list renders — "which rows are there" is one
  // decision with two renderers, which is why it lives in src/util.
  const rows = useMemo(
    () =>
      grouped
        ? groupRowPlan(groupResults(results, hintForSection(section)), expanded)
        : results.map((result) => ({ kind: "release" as const, key: result.infoHash, result, inGroup: false })),
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

  const searchH = 3;
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
  const preview = useTitlePreview({
    omdbApiKey,
    enabled: showPreview,
    cacheKey: parsed?.key ?? "",
    query: parsed ? { by: "name", title: parsed.title, year: parsed.year, type: parsed.type } : null,
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

  useInput(
    (input, key) => {
      if (input === "/") {
        setMode("search");
        return;
      }
      if (key.upArrow || input === "k") {
        if (rows.length > 0 && clamped > 0) moveTo(clamped - 1);
        else setMode("search");
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
        const r = resultAt(clamped);
        if (r) openStream(r);
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
    },
    { isActive: focused && mode === "detail" },
  );

  useInput(
    (_input, key) => {
      if (key.escape) setMode("list");
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
                  const isGroup = row.kind === "group";
                  const ss = sourceStyle(r.source);
                  // The disclosure arrow and the member indent live INSIDE the
                  // name cell rather than in columns of their own. At 80 columns
                  // the list has ~61 to spend and the name is already truncated;
                  // two more fixed columns would come straight out of it.
                  const label = isGroup
                    ? `${row.expanded ? ICON.caretDown : ICON.caretRight} ${row.year ? `${row.title} (${row.year})` : row.title}`
                    : `${row.inGroup ? "  " : ""}${cleanText(r.name)}`;
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
                            <Text dimColor>{r.sizeBytes > 0 ? formatBytes(r.sizeBytes) : "-"}</Text>
                          </Box>
                          <Box width={9} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                            <Text color={r.seeders > 0 ? COLOR.good : undefined} dimColor={r.seeders === 0}>
                              {r.seeders || r.leechers
                                ? `${formatCount(r.seeders)}:${formatCount(r.leechers)}`
                                : "-"}
                            </Text>
                          </Box>
                        </>
                      ) : (
                        <Box width={12} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                          <Text dimColor>{formatRelative(r.added) || "-"}</Text>
                        </Box>
                      )}
                      <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                        <Text color={ss.color} dimColor={!here}>
                          {ss.tag}
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
