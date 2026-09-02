import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";
import { nextEpisode, nextLabel } from "../../core/streamHistory";
import { cleanText, truncate } from "../../util/format";
import { categoryForSource, nonEmptyCategories } from "../../sources/registry";

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
  const [category, setCategory] = useState("All");

  // Adult items are already excluded from `streamHistory` upstream (App.tsx,
  // gated by adultHistoryVisible) when the setting is off, so these tabs never
  // include "Porn" in that case — same guarantee as the web UI's tab strip.
  const categories = nonEmptyCategories(streamHistory.map((i) => categoryForSource(i.source)));
  const shown =
    category === "All" ? streamHistory : streamHistory.filter((i) => categoryForSource(i.source) === category);
  const clamped = Math.min(cursor, Math.max(0, shown.length - 1));

  // [ / ] cycle the category tab — see Favourites.tsx, which uses the same pair.
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
        const item = shown[clamped];
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
        const item = shown[clamped];
        if (item) openStreamHistory(item);
      } else if (input === "x" && !streamActive) {
        const item = shown[clamped];
        if (item) removeStreamHistory(item.key);
      } else if (input === "s") {
        const item = shown[clamped];
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
            shown.map((item, index) => {
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
            })
          )}
        </Box>
      )}
    </Panel>
  );
}
