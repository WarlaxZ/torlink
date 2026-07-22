import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";

export type ImportSource = "netflix" | "trakt";

interface ImportSourcePromptProps {
  width: number;
  onSelect: (source: ImportSource) => void;
  onCancel: () => void;
}

const OPTIONS: Array<{ id: ImportSource; label: string; hint: string }> = [
  { id: "netflix", label: "Netflix", hint: "upload your viewing-activity CSV" },
  { id: "trakt", label: "Trakt", hint: "connect trakt.tv and pull your history" },
];

export function ImportSourcePrompt({ width, onSelect, onCancel }: ImportSourcePromptProps) {
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, OPTIONS.length - 1);

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setCursor(wrapStep(clamped, -1, OPTIONS.length));
    else if (key.downArrow) setCursor(wrapStep(clamped, 1, OPTIONS.length));
    else if (key.return) onSelect(OPTIONS[clamped]!.id);
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="import history" width={width} focused height={3 + OPTIONS.length}>
        <Text dimColor>Import your watch history into reccd from:</Text>
        <Box flexDirection="column" marginTop={1}>
          {OPTIONS.map((o, i) => {
            const here = i === clamped;
            return (
              <Box key={o.id}>
                <Box width={GUTTER} flexShrink={0}>
                  <Text color={COLOR.accent} bold>{here ? ICON.pointer : ""}</Text>
                </Box>
                <Text bold={here} color={here ? COLOR.accent : undefined} dimColor={!here}>
                  {o.label}
                  <Text dimColor>{`  ${ICON.dot} ${o.hint}`}</Text>
                </Text>
              </Box>
            );
          })}
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> choose</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
