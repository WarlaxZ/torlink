import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { useStore, useQueueItems, useQueueHistory, CATEGORIES, isCategory } from "../store";
import { Spinner } from "./Spinner";
import { SearchBar } from "./SearchBar";
import { Panel } from "./Panel";
import { Rule } from "./Rule";
import { useConcurrentSearch } from "../hooks/useConcurrentSearch";
import { getSource, enabledSources } from "../../sources/registry";
import { wrapStep, windowStart } from "../move";
import { sortResults, nextSort, sortLabel, sortArrow, type SortField } from "../sort";
import { COLOR, GUTTER, ICON, PAUSED, SOURCE_STYLE } from "../theme";
import { downloadStateFor, type DownloadState } from "../downloadState";
import { cleanText, formatBytes, formatRelative, truncate } from "../../util/format";
import type { Source, TorrentResult } from "../../sources/types";

type Mode = "list" | "search" | "detail";

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
  debridConfigured,
  mark,
}: {
  r: TorrentResult;
  width: number;
  debridConfigured: boolean;
  mark: { icon: string; color?: string; dim?: boolean } | null;
}) {
  const ss = SOURCE_STYLE[r.source];
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
        <DetailRow
          label="Hash"
          value={
            <Text color={COLOR.alt} dimColor wrap="truncate-end">
              {r.infoHash}
            </Text>
          }
        />
        <DetailRow
          label="Magnet"
          value={
            <Text color={COLOR.alt} dimColor wrap="truncate-end">
              {r.magnet}
            </Text>
          }
        />
      </Box>
      <Box marginTop={1}>
        <Text color={COLOR.accent} bold>
          d
        </Text>
        <Text color={COLOR.text}> Download</Text>
        {debridConfigured ? (
          <>
            <Text dimColor>{`     ${ICON.dot}     `}</Text>
            <Text color={COLOR.accent} bold>
              r
            </Text>
            <Text color={COLOR.text}> Real-Debrid</Text>
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
        <Text color={COLOR.text}> Copy magnet</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
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
    startDebridDownload,
    streamResult,
    debridConfigured,
    copyMagnet,
    contentWidth,
    listRows,
    queue,
    sort,
    setSort,
  } = useStore();

  const search = useConcurrentSearch(query, disabledSources);
  const enabled = useMemo(() => enabledSources(disabledSources), [disabledSources]);

  const queueItems = useQueueItems(queue);
  const queueHistory = useQueueHistory(queue);
  const stateFor = (hash: string): DownloadState | null =>
    downloadStateFor(hash, queueItems, queueHistory);

  const results = useMemo(() => {
    const cat = CATEGORIES.find((c) => c.key === section);
    const base = cat?.group
      ? search.results.filter((r) => getSource(r.source).group === cat.group)
      : search.results;
    return sortResults(base, sort);
  }, [search.results, section, sort]);

  const focused = region === "content" && isCategory(section);
  const [mode, setMode] = useState<Mode>("list");
  const [cursor, setCursor] = useState(0);
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
    if (!focused) return;
    setCaptureMode(mode === "search" ? "text" : mode === "detail" ? "esc" : "none");
    return () => setCaptureMode("none");
  }, [mode, focused, setCaptureMode]);

  useEffect(() => {
    if (!focused) setMode("list");
  }, [focused]);

  const clamped = Math.min(cursor, Math.max(0, results.length - 1));

  const searchH = 3;
  const panelOuter = Math.max(5, listRows - searchH - 1);
  const listHeight = Math.max(3, panelOuter - 4);
  const pageJump = Math.max(1, listHeight - 1);

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

  const copyResultMagnet = (r: TorrentResult): void =>
    copyMagnet({ name: r.name, magnet: r.magnet });

  useInput(
    (input, key) => {
      if (input === "/") {
        setMode("search");
        return;
      }
      if (key.upArrow) {
        if (results.length > 0 && clamped > 0) setCursor(clamped - 1);
        else setMode("search");
        return;
      }
      if (results.length === 0) return;
      if (key.downArrow) setCursor(wrapStep(clamped, 1, results.length));
      else if (key.pageUp) setCursor(Math.max(0, clamped - pageJump));
      else if (key.pageDown) setCursor(Math.min(results.length - 1, clamped + pageJump));
      else if (key.return) {
        const r = results[clamped];
        if (r) {
          setDetail(r);
          setMode("detail");
        }
      } else if (input === "d") {
        const r = results[clamped];
        if (r) openDownload(r);
      } else if (input === "r") {
        const r = results[clamped];
        if (r) openDebrid(r);
      } else if (input === "v") {
        const r = results[clamped];
        if (r) openStream(r);
      } else if (input === "y") {
        const r = results[clamped];
        if (r) copyResultMagnet(r);
      } else if (input === "s") {
        setSort(nextSort(sort));
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
      else if (input === "r" && detail) openDebrid(detail);
      else if (input === "v" && detail) openStream(detail);
      else if (input === "y" && detail) copyResultMagnet(detail);
    },
    { isActive: focused && mode === "detail" },
  );

  useInput(
    (_input, key) => {
      if (key.escape) setMode("list");
    },
    { isActive: focused && mode === "search" },
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
  const tabSources = activeCat?.group ? enabled.filter((s) => s.group === activeCat.group) : enabled;
  const tabErrored =
    tabSources.length > 0 && tabSources.every((s) => search.perSource[s.id]?.error);
  const showStats = useMemo(
    () => results.some((r) => r.sizeBytes > 0 || r.seeders > 0),
    [results],
  );
  const numW = Math.max(2, String(results.length).length);

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

  const status = () => {
    if (search.loading) {
      if (results.length > 0)
        return <Text dimColor>{`searching… ${search.done}/${search.total} sources${sortNote}`}</Text>;
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
    return <Text dimColor>{`${head}${note}${sortNote}`}</Text>;
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

  const start = windowStart(clamped, results.length, listHeight);
  const visible = results.slice(start, start + listHeight);
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
        <Panel
          title={mode === "detail" ? "details" : browsing ? "latest" : "results"}
          width={contentWidth}
          focused={focused && mode !== "search"}
          count={mode === "detail" ? undefined : count}
          height={panelOuter}
        >
          {mode === "detail" && detail ? (
            <Detail
              r={detail}
              width={Math.max(10, contentWidth - 4)}
              debridConfigured={debridConfigured}
              mark={stateMark(stateFor(detail.infoHash))}
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
                {visible.map((r, i) => {
                  const index = start + i;
                  const here = index === clamped && focused && mode === "list";
                  const ss = SOURCE_STYLE[r.source];
                  return (
                    <Box key={r.infoHash}>
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
                          dimColor={!here}
                          bold={here}
                        >
                          {cleanText(r.name)}
                        </Text>
                      </Box>
                      {showStats ? (
                        <>
                          <Box width={10} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                            <Text dimColor>{r.sizeBytes > 0 ? formatBytes(r.sizeBytes) : "-"}</Text>
                          </Box>
                          <Box width={9} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                            <Text color={r.seeders > 0 ? COLOR.good : undefined} dimColor={r.seeders === 0}>
                              {r.seeders || r.leechers ? `${r.seeders}:${r.leechers}` : "-"}
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
    </Box>
  );
}
