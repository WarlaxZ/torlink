import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { PromptHints } from "./PromptHints";
import { COLOR, ICON } from "../theme";

interface GenrePromptProps {
  width: number;
  value: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

// Free-text genre filter for the For You view. reccd treats genre as an open
// string, so this is a plain text field; an empty submission clears the filter.
export function GenrePrompt({ width, value, onSubmit, onCancel }: GenrePromptProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="filter by genre" width={width} focused height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <TextField defaultValue={value} placeholder="e.g. Western — empty clears" onSubmit={onSubmit} />
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1}>
        <PromptHints submitLabel="filter" />
      </Box>
    </Box>
  );
}
