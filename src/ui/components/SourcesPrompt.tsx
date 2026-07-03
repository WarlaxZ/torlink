import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { sourcesByGroup } from "../../sources/registry";
import { wrapStep } from "../move";
import { COLOR, ICON, SOURCE_STYLE } from "../theme";
import type { SourceId } from "../../sources/types";

interface SourcesPromptProps {
  width: number;
  disabled: SourceId[];
  onToggle: (id: SourceId) => void;
  onCancel: () => void;
}

export function SourcesPrompt({ width, disabled, onToggle, onCancel }: SourcesPromptProps) {
  const groups = sourcesByGroup();
  const flat = groups.flatMap((g) => g.sources);
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(cursor, Math.max(0, flat.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) setCursor(wrapStep(clamped, -1, flat.length));
    else if (key.downArrow) setCursor(wrapStep(clamped, 1, flat.length));
    else if (input === " " || key.return) {
      const src = flat[clamped];
      if (src) onToggle(src.id);
    }
  });

  const onCount = flat.length - disabled.length;

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="sources" width={width} focused count={`${onCount}/${flat.length}`}>
        {groups.map((g) => (
          <Box key={g.group} flexDirection="column">
            <Text dimColor>{g.group}</Text>
            {g.sources.map((src) => {
              const i = flat.indexOf(src);
              const on = !disabled.includes(src.id);
              const selected = i === clamped;
              const ss = SOURCE_STYLE[src.id];
              return (
                <Box key={src.id}>
                  <Text color={selected ? COLOR.accent : undefined}>
                    {selected ? `${ICON.pointer} ` : "  "}
                  </Text>
                  <Text color={on ? COLOR.good : COLOR.bad}>{on ? ICON.done : ICON.error}</Text>
                  <Text color={on ? COLOR.text : COLOR.alt} dimColor={!on}>
                    {` ${src.label}`}
                  </Text>
                  <Text color={ss.color} dimColor={!on}>{`  ${ss.tag}`}</Text>
                </Box>
              );
            })}
          </Box>
        ))}
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↑↓</Text>
        <Text dimColor> move</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>space</Text>
        <Text dimColor> toggle</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> done</Text>
      </Box>
    </Box>
  );
}
