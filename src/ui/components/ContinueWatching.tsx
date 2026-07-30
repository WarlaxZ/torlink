import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";
import { nextEpisode, nextLabel } from "../../core/streamHistory";
import { cleanText, truncate } from "../../util/format";

export function ContinueWatching() {
  const {
    streamHistory,
    openStreamHistory,
    removeStreamHistory,
    region,
    section,
    contentWidth,
    listRows,
    streamActive,
    autoPlayTitle,
    setSection,
    submitQuery,
  } = useStore();
  const focused = region === "content" && section === "continueWatching";
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, Math.max(0, streamHistory.length - 1));

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCursor(wrapStep(clamped, -1, streamHistory.length));
      else if (key.downArrow || input === "j") setCursor(wrapStep(clamped, 1, streamHistory.length));
      else if (key.return) {
        const item = streamHistory[clamped];
        if (!item) return;
        const next = nextEpisode(item);
        // Null for a film AND for a series watched via a season pack — see
        // streamHistory.ts. There is nothing honest to search for, so Enter
        // keeps doing exactly what it did before.
        if (!next) {
          openStreamHistory(item);
          return;
        }
        autoPlayTitle(item.title, { kind: "episode", ...next }, () => openStreamHistory(item));
      } else if (input === "r") {
        // Resume the remembered torrent outright, regardless of whether a next
        // episode is known — Enter's next-episode search has no equivalent
        // "just play what I was watching" action, and the browser row keeps
        // both a plain play and a Play next for exactly that reason.
        const item = streamHistory[clamped];
        if (item) openStreamHistory(item);
      } else if (input === "x" && !streamActive) {
        const item = streamHistory[clamped];
        if (item) removeStreamHistory(item.key);
      } else if (input === "s") {
        const item = streamHistory[clamped];
        if (item) {
          setSection("all");
          submitQuery(item.title);
        }
      }
    },
    { isActive: focused && streamHistory.length > 0 },
  );

  const nameW = Math.max(10, contentWidth - 24);

  return (
    <Panel title="continue watching" width={contentWidth} focused={focused} height={Math.max(5, listRows - 1)}>
      {streamHistory.length === 0 ? (
        <Text dimColor>Stream something and it will show up here.</Text>
      ) : (
        <Box flexDirection="column">
          {streamHistory.map((item, index) => {
            const here = focused && index === clamped;
            const next = nextLabel(item);
            return (
              <Box key={item.key}>
                <Box width={GUTTER} flexShrink={0}>
                  <Text color={COLOR.accent}>{here ? ICON.pointer : ""}</Text>
                </Box>
                <Box flexGrow={1} minWidth={0}>
                  <Text color={here ? COLOR.accent : undefined} dimColor={!here} bold={here} wrap="truncate-end">
                    {truncate(cleanText(item.title), nameW)}
                  </Text>
                </Box>
                {next ? (
                  <Box flexShrink={0} marginLeft={1}>
                    <Text dimColor>{next}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}
    </Panel>
  );
}
