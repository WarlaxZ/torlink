import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, GUTTER, ICON } from "../theme";
import { cleanText, formatBytes, truncate } from "../../util/format";
import type { TorrentFileChoice } from "../../download/types";

export function DownloadFilePrompt({
  width,
  files,
  onSubmit,
  onCancel,
}: {
  width: number;
  files: TorrentFileChoice[];
  onSubmit: (indices: number[]) => void;
  onCancel: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(files.map((f) => f.index)));
  const clamped = Math.min(cursor, Math.max(0, files.length - 1));
  const chosen = useMemo(() => [...selected], [selected]);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow || input === "k") setCursor(Math.max(0, clamped - 1));
    else if (key.downArrow || input === "j") setCursor(Math.min(files.length - 1, clamped + 1));
    else if (input === " ") {
      const index = files[clamped]?.index;
      if (index === undefined) return;
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(index)) next.delete(index); else next.add(index);
        return next;
      });
    } else if (input === "a") setSelected(new Set(files.map((f) => f.index)));
    else if (key.return && chosen.length > 0) onSubmit(chosen);
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="choose files to download" width={width} focused height={Math.min(files.length + 1, 10)}>
        {files.slice(0, 9).map((file, i) => {
          const here = i === clamped;
          return (
            <Box key={file.index}>
              <Box width={GUTTER}><Text color={COLOR.accent}>{here ? ICON.pointer : ""}</Text></Box>
              <Text color={selected.has(file.index) ? COLOR.good : COLOR.alt}>
                {selected.has(file.index) ? "[x]" : "[ ]"}
              </Text>
              <Box flexGrow={1} minWidth={0} marginLeft={1}>
                <Text bold={here} wrap="truncate-end">{truncate(cleanText(file.path), Math.max(10, width - 22))}</Text>
              </Box>
              <Text dimColor>{formatBytes(file.length)}</Text>
            </Box>
          );
        })}
      </Panel>
      <Text dimColor>↑↓ move  ·  space toggle  ·  a all  ·  ↵ download  ·  esc cancel</Text>
    </Box>
  );
}
