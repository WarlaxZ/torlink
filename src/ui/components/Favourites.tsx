import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON, sourceStyle } from "../theme";
import { formatBytes, cleanText, truncate } from "../../util/format";
import { categoryForSource, nonEmptyCategories } from "../../sources/registry";

export function Favourites() {
  const { favourites, removeFavourite, openFavourite, region, section, contentWidth, listRows, streamActive } =
    useStore();
  const focused = region === "content" && section === "library";
  const [cursor, setCursor] = useState(0);
  const [category, setCategory] = useState("All");

  // Adult items are already excluded from `favourites` upstream (App.tsx,
  // gated by adultHistoryVisible) when the setting is off, so these tabs never
  // include "Porn" in that case — same guarantee as the web UI's tab strip.
  const categories = nonEmptyCategories(favourites.map((f) => categoryForSource(f.source)));
  const shown =
    category === "All" ? favourites : favourites.filter((f) => categoryForSource(f.source) === category);
  const clamped = Math.min(cursor, Math.max(0, shown.length - 1));

  // [ / ] cycle the category tab — the same key pair works for ContinueWatching,
  // chosen because neither pane's existing bindings (arrows/j/k, Return, x) use
  // it. Resets the cursor since the list under it just changed.
  const changeCategory = (delta: 1 | -1) => {
    if (categories.length <= 1) return;
    const idx = Math.max(0, categories.indexOf(category));
    setCategory(categories[wrapStep(idx, delta, categories.length)]!);
    setCursor(0);
  };

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCursor(wrapStep(clamped, -1, shown.length));
      else if (key.downArrow || input === "j") setCursor(wrapStep(clamped, 1, shown.length));
      else if (input === "[") changeCategory(-1);
      else if (input === "]") changeCategory(1);
      else if (key.return) {
        const fav = shown[clamped];
        if (fav) openFavourite(fav);
      } else if (input === "x" && !streamActive) {
        // "x" is reserved globally for stopping an active stream (App.tsx); Ink
        // fans a keypress out to every live useInput handler rather than
        // cascading, so without this guard the same "x" would both stop the
        // stream and delete this row. Skip our own "x" while one is live.
        const fav = shown[clamped];
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
          <Box marginBottom={1}>
            {categories.map((cat, i) => (
              <Box key={cat} marginRight={i < categories.length - 1 ? 1 : 0}>
                <Text color={cat === category ? COLOR.accent : undefined} dimColor={cat !== category} bold={cat === category}>
                  {cat}
                </Text>
              </Box>
            ))}
          </Box>
          {shown.length === 0 ? (
            <Text dimColor>Nothing in this category.</Text>
          ) : (
            shown.map((fav, index) => {
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
            })
          )}
        </Box>
      )}
    </Panel>
  );
}
