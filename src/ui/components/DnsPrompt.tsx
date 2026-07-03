import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";

interface DnsPromptProps {
  width: number;
  // The current resolver spec, comma-joined (e.g. "cloudflare" or "1.1.1.1,1.0.0.1").
  value: string;
  // True when TORLINK_DNS is set, so an edit here won't take effect until it's unset.
  envOverride: boolean;
  onSubmit: (value: string) => void;
  onClear: () => void;
  onCancel: () => void;
}

export function DnsPrompt({ width, value, envOverride, onSubmit, onClear, onCancel }: DnsPromptProps) {
  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (key.ctrl && input === "x") onClear();
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="custom DNS (DNS-over-HTTPS)" width={width} focused height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <TextField
              defaultValue={value}
              placeholder="e.g. cloudflare, or 1.1.1.1,1.0.0.1"
              onSubmit={onSubmit}
            />
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> save</Text>
          {value ? (
            <>
              <Text dimColor>{`     ${ICON.dot}     `}</Text>
              <Text color={COLOR.alt}>^x</Text>
              <Text dimColor> use system DNS</Text>
            </>
          ) : null}
          <Text dimColor>{`     ${ICON.dot}     `}</Text>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
        <Text dimColor>
          Routes torlink&apos;s own lookups over HTTPS to get past networks that block torrent
          sites. Aliases: cloudflare, google, quad9, opendns — or pass resolver IPs. Empty uses
          your system DNS.
        </Text>
        {envOverride ? (
          <Text color={COLOR.warn}>
            {`${ICON.warn} Pinned by the TORLINK_DNS env var — unset it for this to take effect.`}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
