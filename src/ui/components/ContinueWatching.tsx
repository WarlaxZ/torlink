import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";
import { nextEpisode, type StreamHistoryItem } from "../../core/streamHistory";
import { cleanText, truncate } from "../../util/format";

/** "next S02E05", or "" when there is nothing honest to offer. */
function nextLabel(item: StreamHistoryItem): string {
  const next = nextEpisode(item);
  if (!next) return "";
  return `next S${String(next.season).padStart(2, "0")}E${String(next.episode).padStart(2, "0")}`;
}

export function ContinueWatching() {
  const { streamHistory, openStreamHistory, removeStreamHistory, region, section, contentWidth, listRows, streamActive } = useStore();
  const focused = region === "content" && section === "continueWatching";
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, Math.max(0, streamHistory.length - 1));

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCursor(wrapStep(clamped, -1, streamHistory.length));
      else if (key.downArrow || input === "j") setCursor(wrapStep(clamped, 1, streamHistory.length));
      else if (key.return) {
        const item = streamHistory[clamped];
        if (item) openStreamHistory(item);
      } else if (input === "x" && !streamActive) {
        const item = streamHistory[clamped];
        if (item) removeStreamHistory(item.key);
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
