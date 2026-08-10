import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { TextField } from "./TextField";
import { COLOR, ICON } from "../theme";

// A single-line editor for a cast address — the manual Chromecast host, or the
// host a TV should fetch media from. Both are `host` or `host:port` strings, so
// one prompt serves both; the caller supplies the title, placeholder and hint.
// Modelled on VpnPrompt (empty clears the setting).
export function CastAddressPrompt({ width, title, value, placeholder, hint, onSubmit, onCancel }: {
  width: number;
  title: string;
  value: string;
  placeholder: string;
  hint: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column" width={width}>
      <Panel title={title} width={width} focused height={2}>
        <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
        <TextField defaultValue={value} placeholder={placeholder} onSubmit={onSubmit} />
      </Panel>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
