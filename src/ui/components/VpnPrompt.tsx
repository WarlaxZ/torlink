import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { TextField } from "./TextField";
import { COLOR, ICON } from "../theme";

export function VpnPrompt({ width, value, onSubmit, onCancel }: {
  width: number; value: string; onSubmit: (value: string) => void; onCancel: () => void;
}) {
  useInput((_input, key) => { if (key.escape) onCancel(); });
  return <Box flexDirection="column" width={width}>
    <Panel title="VPN kill switch" width={width} focused height={2}>
      <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
      <TextField defaultValue={value} placeholder="interface name (tun0, utun4, My VPN)" onSubmit={onSubmit} />
    </Panel>
    <Text dimColor>Empty disables. P2P is blocked unless this interface owns the default route.</Text>
  </Box>;
}
