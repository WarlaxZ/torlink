import { Box, Text } from "ink";
import { HELP_GROUPS } from "../keymap";
import { useStore } from "../store";
import { COLOR, RULE, lerpHex } from "../theme";

const CARD_BORDER = lerpHex(COLOR.accent, RULE, 0.55);

const KEY_GAP = 2;
const COL_GAP = 2;
const KEY_W = HELP_GROUPS.map(
  (g) => Math.max(...g.hints.map((h) => h.keys.length)) + KEY_GAP,
);
const COL_W = HELP_GROUPS.map(
  (g, i) => KEY_W[i]! + Math.max(...g.hints.map((h) => h.label.length)),
);
const CARD_W =
  COL_W.reduce((a, b) => a + b, 0) + (HELP_GROUPS.length - 1) * COL_GAP + 4;
const KEY_W_STACKED = Math.max(...KEY_W);

// Rows a group occupies: its title plus one row per hint.
const GROUP_H = HELP_GROUPS.map((g) => 1 + g.hints.length);

// Natural height (in rows) of the scrollable groups area for a given terminal
// width. Wide terminals lay the groups side by side, so the tallest column
// wins; narrow ones stack them with a one-row gap between each.
export function helpContentHeight(cols: number): number {
  const columns = cols >= CARD_W;
  return columns
    ? Math.max(...GROUP_H)
    : GROUP_H.reduce((a, b) => a + b, 0) + (HELP_GROUPS.length - 1);
}

interface HelpOverlayProps {
  // Height cap for the groups area. When the content is taller, the excess is
  // clipped and `scroll` pages through it; the header and footer stay pinned.
  maxRows?: number;
  scroll?: number;
}

export function HelpOverlay({ maxRows, scroll = 0 }: HelpOverlayProps) {
  const { cols } = useStore();
  const columns = cols >= CARD_W;

  const contentH = helpContentHeight(cols);
  const viewport = maxRows && maxRows < contentH ? maxRows : contentH;
  const scrollable = contentH > viewport;
  const offset = scrollable ? Math.max(0, Math.min(scroll, contentH - viewport)) : 0;

  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      borderStyle="round"
      borderColor={CARD_BORDER}
      paddingX={columns ? 1 : 2}
      paddingY={1}
    >
      <Text bold color={COLOR.accent}>
        Keyboard
      </Text>
      <Box marginTop={1} height={viewport} overflow="hidden" flexDirection="column">
        <Box
          flexShrink={0}
          marginTop={-offset}
          flexDirection={columns ? "row" : "column"}
        >
          {HELP_GROUPS.map((group, gi) => (
            <Box
              key={group.title}
              flexDirection="column"
              width={columns ? COL_W[gi] : undefined}
              marginRight={columns && gi < HELP_GROUPS.length - 1 ? COL_GAP : 0}
              marginTop={!columns && gi > 0 ? 1 : 0}
            >
              <Text bold>{group.title}</Text>
              {group.hints.map((h) => (
                <Box key={h.keys + h.label}>
                  <Box width={columns ? KEY_W[gi] : KEY_W_STACKED} flexShrink={0}>
                    <Text color={COLOR.alt}>{h.keys}</Text>
                  </Box>
                  <Text dimColor>{h.label}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Your downloaded files always stay on disk.</Text>
        <Text dimColor>
          {scrollable ? "↑↓ scroll · ? or esc to close" : "Press ? or esc to close"}
        </Text>
      </Box>
    </Box>
  );
}
