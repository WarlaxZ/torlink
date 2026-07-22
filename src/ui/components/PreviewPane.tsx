import { Box, Text } from "ink";
import { Panel } from "./Panel";
import { COLOR } from "../theme";
import { cleanText } from "../../util/format";

interface PreviewPaneProps {
  width: number;
  height: number;
  focused: boolean;
  title: string;
  year?: number;
  // undefined = still loading; null = looked up, none available; string = value.
  plot?: string | null;
  posterRows?: string[] | null;
  // A small dim line under the plot (For You: the top "why" reason).
  note?: string;
}

// The right-hand preview pane: a poster (rendered as truecolor half-blocks)
// above the title, plot and an optional note. Purely presentational — the
// caller owns the fetching/caching (see useTitlePreview) and passes results in.
export function PreviewPane({ width, height, focused, title, year, plot, posterRows, note }: PreviewPaneProps) {
  return (
    <Panel title="Preview" width={width} focused={focused} height={height}>
      {posterRows === undefined ? (
        <Text dimColor>Loading poster…</Text>
      ) : posterRows === null ? (
        <Text dimColor>No poster available.</Text>
      ) : (
        <Box flexDirection="column">
          {posterRows.map((row, i) => (
            <Text key={i}>{row}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={COLOR.accent} wrap="truncate-end">
          {cleanText(title)}
          {year ? <Text dimColor>{` (${year})`}</Text> : null}
        </Text>
        <Box marginTop={1}>
          {plot === undefined ? (
            <Text dimColor>Loading…</Text>
          ) : plot === null ? (
            <Text dimColor>No plot available.</Text>
          ) : (
            <Text dimColor wrap="wrap">{cleanText(plot)}</Text>
          )}
        </Box>
        {note ? (
          <Box marginTop={1}>
            <Text color={COLOR.alt} wrap="truncate-end">{cleanText(note)}</Text>
          </Box>
        ) : null}
      </Box>
    </Panel>
  );
}
