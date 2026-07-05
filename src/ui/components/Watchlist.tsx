import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";

export function Watchlist() {
  const { savedSearches, toggleSavedSearch, submitQuery, setSection, region, section, contentWidth, listRows } = useStore();
  const focused = region === "content" && section === "watchlist";
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, Math.max(0, savedSearches.length - 1));
  useInput((input, key) => {
    if (key.upArrow || input === "k") setCursor(wrapStep(clamped, -1, savedSearches.length));
    else if (key.downArrow || input === "j") setCursor(wrapStep(clamped, 1, savedSearches.length));
    else if (key.return) {
      const query = savedSearches[clamped];
      if (query) { submitQuery(query); setSection("all"); }
    } else if (input === "x") {
      const query = savedSearches[clamped]; if (query) toggleSavedSearch(query);
    }
  }, { isActive: focused && savedSearches.length > 0 });
  return <Panel title="watchlist" width={contentWidth} focused={focused} height={Math.max(5, listRows - 1)}>
    {savedSearches.length === 0 ? <Text dimColor>Save a search with w from the results view.</Text> :
      <Box flexDirection="column">{savedSearches.map((query, index) => <Box key={query}>
        <Box width={GUTTER}><Text color={COLOR.accent}>{focused && index === clamped ? ICON.pointer : ""}</Text></Box>
        <Text color={index === clamped ? COLOR.accent : undefined}>{query}</Text>
      </Box>)}</Box>}
  </Panel>;
}
