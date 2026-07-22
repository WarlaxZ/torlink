import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { hyperlink } from "../../util/terminal";

interface OmdbPromptProps {
  width: number;
  value: string;
  onSubmit: (value: string) => void;
  onClear: () => void;
  onCancel: () => void;
}

// Mask all but the last 4 characters of an already-saved key, so the user can
// tell whether one is set without revealing it (matches TokenPrompt).
function masked(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "•".repeat(key.length);
  return `${"•".repeat(key.length - 4)}${key.slice(-4)}`;
}

export function OmdbPrompt({ width, value, onSubmit, onClear, onCancel }: OmdbPromptProps) {
  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (key.ctrl && input === "x") onClear();
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="omdb api key" width={width} focused height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <TextField
              mask
              placeholder={value ? `current: ${masked(value)}` : "paste your OMDb API key"}
              onSubmit={onSubmit}
            />
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Adds plot summaries to For You picks. Optional.</Text>
        <Box>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> save</Text>
          {value ? (
            <>
              <Text dimColor>{`     ${ICON.dot}     `}</Text>
              <Text color={COLOR.alt}>^x</Text>
              <Text dimColor> clear</Text>
            </>
          ) : null}
          <Text dimColor>{`     ${ICON.dot}     `}</Text>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
        <Text dimColor>
          Get a free key at {hyperlink("https://www.omdbapi.com/apikey.aspx", "omdbapi.com/apikey.aspx")}
        </Text>
      </Box>
    </Box>
  );
}
