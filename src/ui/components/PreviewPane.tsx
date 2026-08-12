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
  // Local (no-lookup) mode for name-only results (the adult group): the title
  // WRAPS to show a long release name in full, there is no poster region, and
  // the plot slot always renders (no "No plot available." — nothing was looked up).
  local?: boolean;
}

// The right-hand preview pane: a poster (rendered as truecolor half-blocks)
// above the title, plot and an optional note. Purely presentational — the
// caller owns the fetching/caching (see useTitlePreview) and passes results in.
export function PreviewPane({ width, height, focused, title, year, plot, posterRows, note, local }: PreviewPaneProps) {
  return (
    <Panel title="Preview" width={width} focused={focused} height={height}>
      {local ? (
        // Local mode renders a screenshot when one resolved, and nothing while it
        // is loading or absent — no "No poster available.", which would imply a
        // failed OMDb lookup that never happened.
        posterRows && posterRows.length ? (
          <Box flexDirection="column">
            {posterRows.map((row, i) => (
              <Text key={i}>{row}</Text>
            ))}
          </Box>
        ) : null
      ) : posterRows === undefined ? (
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
      <Box marginTop={local && !(posterRows && posterRows.length) ? 0 : 1} flexDirection="column">
        <Text bold color={COLOR.accent} wrap={local ? "wrap" : "truncate-end"}>
          {cleanText(title)}
          {year ? <Text dimColor>{` (${year})`}</Text> : null}
        </Text>
        <Box marginTop={1}>
          {local ? (
            <Text dimColor wrap="wrap">{cleanText(plot ?? "")}</Text>
          ) : plot === undefined ? (
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
