import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FetchImpl } from "../../util/net";
import type { ReccClientConfig } from "../../recc/client";
import type { CaptureMode, Section } from "../store";
import { useRecommendations, type ReccType } from "../hooks/useRecommendations";
import { useTitlePreview } from "../hooks/useTitlePreview";
import { GenrePrompt } from "./GenrePrompt";
import { Panel } from "./Panel";
import { PreviewPane } from "./PreviewPane";
import { COLOR, GUTTER, ICON } from "../theme";
import { cleanText, truncate } from "../../util/format";
import { openUrl, imdbTitleUrl } from "../../util/openUrl";

interface ForYouProps {
  reccConfig: ReccClientConfig;
  visible: boolean;
  active: boolean;
  setSection: (s: Section) => void;
  submitQuery: (q: string) => void;
  onRatePick?: (name: string, onRated: () => void) => void;
  toggleSavedSearch?: (query: string) => void;
  setCaptureMode?: (m: CaptureMode) => void;
  fetchImpl?: FetchImpl;
  width?: number;
  height?: number;
  // OMDb key (already resolved from env/config). Empty = plot/poster off.
  omdbApiKey?: string;
}

const NEXT_TYPE: Record<ReccType, ReccType> = { all: "movie", movie: "tv", tv: "all" };
const TYPE_SECTION: Record<ReccType, Section> = { all: "all", movie: "movies", tv: "tv" };

// Below this the terminal is too narrow to split usefully — show just the list.
const PREVIEW_MIN_WIDTH = 74;

export function ForYou({
  reccConfig,
  visible,
  active,
  setSection,
  submitQuery,
  onRatePick,
  toggleSavedSearch,
  setCaptureMode,
  fetchImpl,
  width = 60,
  height = 20,
  omdbApiKey = "",
}: ForYouProps) {
  const recs = useRecommendations(reccConfig, visible, fetchImpl);
  const [selected, setSelected] = useState(0);
  const [editingGenre, setEditingGenre] = useState(false);
  const [showReasons, setShowReasons] = useState(true);
  const [previewOn, setPreviewOn] = useState(true);

  const configured = Boolean(reccConfig.reccUrl);
  const count = recs.items.length;
  const selectedItem = recs.items[selected];
  const selectedId = selectedItem?.imdbId;

  const showPreview = previewOn && omdbApiKey !== "" && width >= PREVIEW_MIN_WIDTH;
  const previewWidth = showPreview ? Math.min(46, Math.max(30, Math.round(width * 0.4))) : 0;
  const listWidth = showPreview ? width - previewWidth - 1 : width;
  // Poster sizing: fill the preview's inner width, capped so the caption fits.
  const posterCols = Math.max(8, previewWidth - 4);
  const posterMaxRows = Math.max(4, height - 9);

  // Resolve the highlighted pick's plot + poster (by its reccd imdbId). Meta is
  // fetched whenever a key is set (drives the inline plot too); the poster only
  // when the split preview is on screen.
  const preview = useTitlePreview({
    omdbApiKey,
    enabled: omdbApiKey !== "",
    posterEnabled: showPreview,
    cacheKey: selectedId ?? "",
    query: selectedId ? { by: "id", imdbId: selectedId } : null,
    posterCols,
    posterMaxRows,
    fetchImpl,
  });

  // Keep the highlight in range when the list shrinks (e.g. after a pick is
  // rated and dismissed).
  useEffect(() => {
    if (selected >= count && count > 0) setSelected(count - 1);
  }, [count, selected]);

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setSelected((i) => (count ? (i - 1 + count) % count : 0));
      else if (key.downArrow || input === "j") setSelected((i) => (count ? (i + 1) % count : 0));
      else if (input === "t") { setSelected(0); recs.setType(NEXT_TYPE[recs.type]); }
      else if (input === "e") { setSelected(0); recs.toggleExplore(); }
      else if (input === "g") {
        setEditingGenre(true);
        setCaptureMode?.("text");
      }
      else if (input === "r") recs.refresh();
      else if (input === "b") setShowReasons((v) => !v);
      else if (input === "p") setPreviewOn((v) => !v);
      else if (input === "i") {
        if (selectedItem) void openUrl(imdbTitleUrl(selectedItem.imdbId));
      }
      else if (input === "w") {
        if (selectedItem) toggleSavedSearch?.(selectedItem.title);
      }
      else if (input === "f") {
        if (selectedItem) onRatePick?.(selectedItem.title, () => recs.dismiss(selectedItem.imdbId));
      }
      else if (key.return) {
        if (selectedItem) {
          setSection(TYPE_SECTION[recs.type]);
          submitQuery(selectedItem.title);
        }
      }
    },
    { isActive: active && configured && !editingGenre },
  );

  if (editingGenre) {
    return (
      <GenrePrompt
        width={width}
        value={recs.genre}
        onSubmit={(g) => {
          setEditingGenre(false);
          setCaptureMode?.("none");
          setSelected(0);
          recs.setGenre(g.trim());
        }}
        onCancel={() => {
          setEditingGenre(false);
          setCaptureMode?.("none");
        }}
      />
    );
  }

  if (!configured) {
    return (
      <Box flexDirection="column">
        <Text color={COLOR.text}>Recommendations aren't set up yet.</Text>
        <Text dimColor>Set up reccd in the Accounts pane (↵ on reccd),</Text>
        <Text dimColor>or set TORLINK_RECC_URL / TORLINK_RECC_TOKEN.</Text>
      </Box>
    );
  }

  const filterLine = `type: ${recs.type}${recs.genre ? ` · genre: ${recs.genre}` : ""}${recs.explore ? " · explore" : ""}${showReasons ? "" : " · reasons hidden"}`;
  // Cap the title so the "(year)" suffix (and, when the preview is hidden, the
  // inline plot) have room; the flexing cell + truncate-end still guard the edge.
  const titleMax = Math.max(16, listWidth - 34);

  return (
    <Box>
      <Box marginRight={showPreview ? 1 : 0}>
        <Panel title="For You" width={listWidth} focused={active} height={height}>
          <Box marginBottom={1}>
            <Text dimColor>{filterLine}</Text>
          </Box>
          {recs.loading ? (
            <Text dimColor>Finding recommendations…</Text>
          ) : recs.error ? (
            <Box flexDirection="column">
              <Text color={COLOR.text}>{recs.error}</Text>
              <Text dimColor>press r to retry</Text>
            </Box>
          ) : count === 0 ? (
            <Text dimColor>No picks yet — stream something and they'll show up here.</Text>
          ) : (
            recs.items.map((item, i) => {
              const isSel = i === selected;
              const tag = item.reasons[0] ?? "";
              // With the preview open the plot lives there; inline it only when
              // the list is on its own.
              const inlinePlot = isSel && !showPreview ? preview.plot : undefined;
              return (
                <Box key={item.imdbId}>
                  <Box width={GUTTER} flexShrink={0}>
                    <Text color={COLOR.accent}>{isSel ? ICON.pointer : ""}</Text>
                  </Box>
                  <Box flexGrow={1} minWidth={0}>
                    <Text color={isSel ? COLOR.accent : COLOR.text} wrap="truncate-end">
                      {truncate(cleanText(item.title), titleMax)}
                      <Text dimColor>{` (${item.year})`}</Text>
                      {inlinePlot ? <Text dimColor>{`  ·  ${cleanText(inlinePlot)}`}</Text> : null}
                    </Text>
                  </Box>
                  {showReasons && tag ? (
                    <Box flexShrink={0} marginLeft={2}>
                      <Text dimColor>{truncate(tag, 30)}</Text>
                    </Box>
                  ) : null}
                </Box>
              );
            })
          )}
        </Panel>
      </Box>
      {showPreview && selectedItem ? (
        <PreviewPane
          width={previewWidth}
          height={height}
          focused={active}
          title={selectedItem.title}
          year={selectedItem.year}
          plot={preview.plot}
          posterRows={preview.posterRows}
          note={showReasons ? selectedItem.reasons[0] : undefined}
        />
      ) : null}
    </Box>
  );
}
