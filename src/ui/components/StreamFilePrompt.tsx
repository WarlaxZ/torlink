import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, GUTTER, ICON } from "../theme";
import { formatBytes, cleanText, truncate } from "../../util/format";
import type { ResolvedFile } from "../../integrations/realdebrid";

interface StreamFilePromptProps {
  width: number;
  files: ResolvedFile[];
  onSelect: (file: ResolvedFile) => void;
  onCancel: () => void;
}

// Pick a file to stream when a torrent holds several videos. Files arrive
// largest-first (sorted by the caller), so cursor 0 is the most likely pick.
export function StreamFilePrompt({ width, files, onSelect, onCancel }: StreamFilePromptProps) {
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, Math.max(0, files.length - 1));

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) setCursor(Math.max(0, clamped - 1));
    else if (key.downArrow) setCursor(Math.min(files.length - 1, clamped + 1));
    else if (key.return) {
      const file = files[clamped];
      if (file) onSelect(file);
    }
  });

  const nameW = Math.max(10, width - 16);

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="choose a file to stream" width={width} focused height={Math.min(files.length, 8)}>
        {files.slice(0, 8).map((file, i) => {
          const here = i === clamped;
          return (
            <Box key={file.url}>
              <Box width={GUTTER} flexShrink={0}>
                <Text color={COLOR.accent}>{here ? ICON.pointer : ""}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text color={here ? COLOR.accent : undefined} dimColor={!here} bold={here} wrap="truncate-end">
                  {truncate(cleanText(file.filename), nameW)}
                </Text>
              </Box>
              <Box flexShrink={0} marginLeft={1} justifyContent="flex-end">
                <Text dimColor>{file.bytes > 0 ? formatBytes(file.bytes) : "-"}</Text>
              </Box>
            </Box>
          );
        })}
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↑↓</Text>
        <Text dimColor> move</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> stream</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
