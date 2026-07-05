import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";

export interface TransferLimits {
  downloadLimitKbps?: number;
  uploadLimitKbps?: number;
  seedRatio?: number;
  seedMinutes?: number;
}

export function parseLimits(raw: string): TransferLimits | null {
  const values = raw.split(",").map((part) => part.trim());
  if (values.length > 4) return null;
  const parsed = values.map((value) => value === "" ? undefined : Number(value));
  if (parsed.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) return null;
  return {
    downloadLimitKbps: parsed[0], uploadLimitKbps: parsed[1],
    seedRatio: parsed[2], seedMinutes: parsed[3],
  };
}

export function LimitsPrompt({ width, value, onSubmit, onCancel }: {
  width: number; value: TransferLimits; onSubmit: (limits: TransferLimits) => void; onCancel: () => void;
}) {
  useInput((_input, key) => { if (key.escape) onCancel(); });
  const initial = [value.downloadLimitKbps, value.uploadLimitKbps, value.seedRatio, value.seedMinutes]
    .map((v) => v ?? "").join(",");
  return <Box flexDirection="column" width={width}>
    <Panel title="transfer limits" width={width} focused height={2}>
      <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
      <TextField defaultValue={initial} placeholder="download KB/s, upload KB/s, ratio, minutes" onSubmit={(raw) => {
        const limits = parseLimits(raw); if (limits) onSubmit(limits);
      }} />
    </Panel>
    <Text dimColor>0 or empty = unlimited. Example: 5000,1000,2,60</Text>
  </Box>;
}
