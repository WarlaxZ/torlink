import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { TextField } from "./TextField";
import { wrapStep } from "../move";
import { COLOR, ICON } from "../theme";
import type { CastDevice } from "../../core/cast/discover";

interface CastPromptProps {
  width: number;
  devices: CastDevice[];
  /** True while discovery is still listening. */
  finding: boolean;
  /** The configured address, shown as the field's placeholder. */
  configured?: string;
  onSelect: (device: CastDevice) => void;
  /** Save this address and cast to it. */
  onAddress: (address: string) => void;
  onCancel: () => void;
}

/**
 * Pick a Chromecast to cast to.
 *
 * TWO STATES, and only ever one at a time. With devices it is a list. With none
 * — and discovery finished — it explains that mDNS does not cross a Docker
 * bridge or a VLAN, and offers a field to type an address into.
 *
 * The field is deliberately absent while there are devices, and not merely
 * hidden: `TextField` runs its own `useInput`, so a field mounted beside the list
 * would consume the arrow keys the list needs. Confining it to the empty state
 * removes the focus problem instead of managing it.
 */
export function CastPrompt({
  width,
  devices,
  finding,
  configured,
  onSelect,
  onAddress,
  onCancel,
}: CastPromptProps) {
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, Math.max(0, devices.length - 1));
  const empty = devices.length === 0;

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    // Everything below is the list's. With no devices the field owns the keys,
    // and an enter on an empty list must select nothing rather than crash.
    if (empty) return;
    if (key.upArrow) setCursor(wrapStep(clamped, -1, devices.length));
    else if (key.downArrow) setCursor(wrapStep(clamped, 1, devices.length));
    else if (key.return) {
      const device = devices[clamped];
      if (device) onSelect(device);
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel
        title="cast to"
        width={width}
        focused
        count={empty ? undefined : `${String(clamped + 1)}/${String(devices.length)}`}
      >
        {devices.map((device, i) => {
          const selected = i === clamped;
          return (
            <Box key={device.id}>
              <Text color={selected ? COLOR.accent : undefined}>
                {selected ? `${ICON.pointer} ` : "  "}
              </Text>
              {/* A device name is whatever someone typed into the Google Home
                  app, so it is rendered as text and never parsed. */}
              <Text color={selected ? COLOR.text : undefined}>{device.name}</Text>
              {device.model ? <Text dimColor>{`  ${device.model}`}</Text> : null}
            </Box>
          );
        })}
        {empty && finding ? <Text dimColor>Looking for Chromecasts…</Text> : null}
        {empty && !finding ? (
          <Box flexDirection="column">
            <Text color={COLOR.warn}>{`${ICON.warn} No Chromecast found on this network.`}</Text>
            <Text dimColor>
              Discovery uses mDNS, which does not cross a Docker bridge or a VLAN.
            </Text>
            <Box>
              <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
              <Box flexGrow={1} minWidth={0}>
                <TextField
                  placeholder={configured ? `current: ${configured}` : "address, or host:port"}
                  onSubmit={(value) => {
                    const trimmed = value.trim();
                    if (trimmed) onAddress(trimmed);
                  }}
                />
              </Box>
            </Box>
          </Box>
        ) : null}
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor>{empty ? " save and cast" : " cast"}</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> back</Text>
      </Box>
    </Box>
  );
}
