import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { cleanText, truncate } from "../../util/format";

interface RatePromptProps {
  width?: number;
  name: string;
  onLike: () => void;
  onDislike: () => void;
  onDismiss: () => void;
}

// Shown after a stream ends: a quick like/dislike signal beyond passive
// watching. Styled like the other inline prompts; owns keyboard input while
// mounted.
export function RatePrompt({ width = 40, name, onLike, onDislike, onDismiss }: RatePromptProps) {
  useInput((input, key) => {
    if (key.escape) {
      onDismiss();
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
      <Panel title="How was it?" width={width} focused height={2}>
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
