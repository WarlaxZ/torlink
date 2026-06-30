import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";

interface TokenPromptProps {
  width: number;
  value: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

// Mask all but the last 4 characters of an already-saved token, just so the
// user can tell whether one is set without revealing it.
function masked(token: string): string {
  if (!token) return "";
  if (token.length <= 4) return "•".repeat(token.length);
  return `${"•".repeat(token.length - 4)}${token.slice(-4)}`;
}

export function TokenPrompt({ width, value, onSubmit, onCancel }: TokenPromptProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="real-debrid token" width={width} focused height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <TextField
              mask
              placeholder={value ? `current: ${masked(value)}` : "paste your API token"}
              onSubmit={onSubmit}
            />
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> save</Text>
          <Text dimColor>{`     ${ICON.dot}     `}</Text>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
        <Text dimColor>Get a token at real-debrid.com/apitoken</Text>
      </Box>
    </Box>
  );
}
