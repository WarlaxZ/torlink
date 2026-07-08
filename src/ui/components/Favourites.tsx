import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON, sourceStyle } from "../theme";
import { formatBytes, cleanText, truncate } from "../../util/format";

export function Favourites() {
  const { favourites, removeFavourite, openFavourite, region, section, contentWidth, listRows } =
    useStore();
  const focused = region === "content" && section === "library";
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, Math.max(0, favourites.length - 1));

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCursor(wrapStep(clamped, -1, favourites.length));
      else if (key.downArrow || input === "j") setCursor(wrapStep(clamped, 1, favourites.length));
      else if (key.return) {
        const fav = favourites[clamped];
        if (fav) openFavourite(fav);
      } else if (input === "x") {
        const fav = favourites[clamped];
        if (fav) removeFavourite(fav.id);
      }
    },
    { isActive: focused && favourites.length > 0 },
  );

  const nameW = Math.max(10, contentWidth - 26);

  return (
    <Panel title="library" width={contentWidth} focused={focused} height={Math.max(5, listRows - 1)}>
      {favourites.length === 0 ? (
        <Text dimColor>Favourite a series with b from the stream file list.</Text>
      ) : (
        <Box flexDirection="column">
          {favourites.map((fav, index) => {
            const here = focused && index === clamped;
            const ss = sourceStyle(fav.source);
            return (
              <Box key={fav.id}>
                <Box width={GUTTER} flexShrink={0}>
                  <Text color={COLOR.accent}>{here ? ICON.pointer : ""}</Text>
                </Box>
                <Box flexGrow={1} minWidth={0}>
                  <Text color={here ? COLOR.accent : undefined} dimColor={!here} bold={here} wrap="truncate-end">
                    {truncate(cleanText(fav.name), nameW)}
                  </Text>
                </Box>
                {fav.watched?.length ? (
                  <Box flexShrink={0} marginLeft={1}>
                    <Text dimColor>{`${fav.watched.length} watched`}</Text>
                  </Box>
                ) : null}
                {fav.sizeBytes && fav.sizeBytes > 0 ? (
                  <Box flexShrink={0} marginLeft={1} justifyContent="flex-end">
                    <Text dimColor>{formatBytes(fav.sizeBytes)}</Text>
                  </Box>
                ) : null}
                <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                  <Text color={ss.color} dimColor={!here}>
                    {ss.tag}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Panel>
  );
}
