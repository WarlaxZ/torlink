import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FetchImpl } from "../../util/net";
import type { ReccClientConfig } from "../../recc/client";
import type { CaptureMode, Section } from "../store";
import { useRecommendations, type ReccType } from "../hooks/useRecommendations";
import { GenrePrompt } from "./GenrePrompt";
import { Panel } from "./Panel";
import { COLOR, GUTTER, ICON } from "../theme";
import { cleanText, truncate } from "../../util/format";

interface ForYouProps {
  reccConfig: ReccClientConfig;
  visible: boolean;
  active: boolean;
  setSection: (s: Section) => void;
  submitQuery: (q: string) => void;
  setCaptureMode?: (m: CaptureMode) => void;
  fetchImpl?: FetchImpl;
  width?: number;
}

const NEXT_TYPE: Record<ReccType, ReccType> = { all: "movie", movie: "tv", tv: "all" };
const TYPE_SECTION: Record<ReccType, Section> = { all: "all", movie: "movies", tv: "tv" };

export function ForYou({
  reccConfig,
  visible,
  active,
  setSection,
  submitQuery,
  setCaptureMode,
  fetchImpl,
  width = 60,
}: ForYouProps) {
  const recs = useRecommendations(reccConfig, visible, fetchImpl);
  const [selected, setSelected] = useState(0);
  const [editingGenre, setEditingGenre] = useState(false);

  const configured = Boolean(reccConfig.reccUrl);
  const count = recs.items.length;

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
      else if (key.return) {
        const item = recs.items[selected];
        if (item) {
          setSection(TYPE_SECTION[recs.type]);
          submitQuery(item.title);
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
        <Text dimColor>To set up, add reccUrl and reccToken to config.json,</Text>
        <Text dimColor>or set TORLINK_RECC_URL / TORLINK_RECC_TOKEN.</Text>
      </Box>
    );
  }

  const filterLine = `type: ${recs.type}${recs.genre ? ` · genre: ${recs.genre}` : ""}${recs.explore ? " · explore" : ""}`;

  return (
    <Panel title="For You" width={width} focused={active}>
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
          const tag = item.reasons[0] ?? "";
          const isSel = i === selected;
          return (
            <Box key={item.imdbId}>
              <Box width={GUTTER} flexShrink={0}>
                <Text color={COLOR.accent}>{isSel ? ICON.pointer : ""}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text color={isSel ? COLOR.accent : COLOR.text} wrap="truncate-end">
                  {truncate(cleanText(item.title), 40)}
                </Text>
              </Box>
              <Text dimColor>{`  ${item.year}  `}</Text>
              <Text dimColor>{tag}</Text>
            </Box>
          );
        })
      )}
    </Panel>
  );
}
