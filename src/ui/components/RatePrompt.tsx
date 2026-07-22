import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { cleanText, truncate } from "../../util/format";

interface RatePromptProps {
  width?: number;
  name: string;
  // Heading; defaults to the post-stream phrasing. For You passes "Rate this pick".
  title?: string;
  onLike: () => void;
  onDislike: () => void;
  // Optional: when provided, a "watched" action (key `w`) is shown. Post-stream
  // callers omit it, so that prompt stays like/dislike only.
  onWatched?: () => void;
  onDismiss: () => void;
}

// Shown after a stream ends, or from For You: a quick feedback signal. Styled
// like the other inline prompts; owns keyboard input while mounted.
export function RatePrompt({ width = 40, name, title = "How was it?", onLike, onDislike, onWatched, onDismiss }: RatePromptProps) {
  useInput((input, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }
    if (onWatched && input === "w") {
      onWatched();
      return;
    }
    if (input === "l") {
      onLike();
      return;
    }
    if (input === "d") {
      onDislike();
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title={title} width={width} focused height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <Text color={COLOR.text} wrap="wrap">
              {truncate(cleanText(name), 40)}
            </Text>
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1}>
        {onWatched ? (
          <Text>
            <Text color={COLOR.alt}>w</Text>
            <Text dimColor> watched</Text>
            <Text dimColor>{`     ${ICON.dot}     `}</Text>
          </Text>
        ) : null}
        <Text color={COLOR.alt}>l</Text>
        <Text dimColor> like</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>d</Text>
        <Text dimColor> dislike</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> skip</Text>
      </Box>
    </Box>
  );
}
