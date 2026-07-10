import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { sourcesByGroup } from "../../sources/registry";
import { isSkipped, sourceHealth } from "../../sources/sourceHealth";
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

  // A source can belong to several groups (e.g. a general index under both
  // Movies and TV), so it renders once per group. Count each source once.
  const total = new Set(flat.map((s) => s.id)).size;
  const onCount = total - disabled.length;
  // Global row index across all groups, matching `flat`'s order, so a source
  // shown under two headers is two independently selectable rows.
  let rowIndex = -1;

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="sources" width={width} focused count={`${onCount}/${total}`}>
        {groups.map((g) => (
          <Box key={g.group} flexDirection="column">
            <Text dimColor>{g.group}</Text>
            {g.sources.map((src) => {
              rowIndex += 1;
              const i = rowIndex;
              const on = !disabled.includes(src.id);
              const selected = i === clamped;
              const ss = SOURCE_STYLE[src.id];
              // Auto-benched for repeated failures (only worth showing while the
              // source is otherwise enabled).
              const skipped = on && isSkipped(sourceHealth, src.id, Date.now());
              return (
                <Box key={`${g.group}-${src.id}`}>
                  <Text color={selected ? COLOR.accent : undefined}>
                    {selected ? `${ICON.pointer} ` : "  "}
                  </Text>
                  <Text color={on ? COLOR.good : COLOR.bad}>{on ? ICON.done : ICON.error}</Text>
                  <Text color={on ? COLOR.text : COLOR.alt} dimColor={!on}>
                    {` ${src.label}`}
                  </Text>
                  <Text color={ss.color} dimColor={!on}>{`  ${ss.tag}`}</Text>
                  {skipped ? <Text color={COLOR.warn} dimColor>{`  ${ICON.warn} unreachable`}</Text> : null}
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
