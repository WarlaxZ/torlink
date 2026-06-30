import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";

interface StreamPlayerPromptProps {
  width: number;
  value: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function StreamPlayerPrompt({ width, value, onSubmit, onCancel }: StreamPlayerPromptProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="media player command" width={width} focused height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <TextField defaultValue={value} placeholder="e.g. mpv, iina, vlc" onSubmit={onSubmit} />
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> save &amp; play</Text>
          <Text dimColor>{`     ${ICON.dot}     `}</Text>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
        <Text dimColor>No player found. The stream link is on your clipboard meanwhile.</Text>
      </Box>
    </Box>
  );
}
