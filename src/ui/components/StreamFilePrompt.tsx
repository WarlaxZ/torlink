import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, GUTTER, ICON } from "../theme";
import { formatBytes, cleanText, truncate } from "../../util/format";
import type { StreamFile } from "../../util/player";
// The ordering rule itself, which used to be a `sortFiles` local to this file.
// It moved down to src/util when the browser's picker needed it: a season pack
// listed E01…E10 here and in torrent order there is the copy-then-drift bug this
// codebase has recorded four times, arrived at by omission instead of by copy.
import { nextSort, sortStreamFiles, type StreamFileSort } from "../../util/streamFileSort";

interface StreamFilePromptProps {
  width: number;
  files: StreamFile[];
  onSelect: (file: StreamFile) => void;
  onCancel: () => void;
  // Max rows the file list body may occupy. The caller sizes this from the
  // available window height so the list fills most of the screen.
  maxRows?: number;
  // Filenames already watched (this session ∪ persisted favourite) — marked ✓.
  watched?: string[];
  /**
   * Where to open the cursor: an index into `files` AS GIVEN, from
   * `nextEpisodeIndex` (src/util/nextEpisodeFile.ts). Omitted, or pointing at
   * nothing, means the first row — exactly today's behaviour.
   *
   * Resolved to the file's own `url` and looked up in the sorted list, because
   * the list is REORDERED for display and an index into `files` is therefore not
   * a row on screen.
   *
   * That lookup happens on every render while the cursor is untouched rather than
   * once in a `useState` initialiser. In today's call graph the two are
   * equivalent — `openStreamPicker` sets `streamPreselect` and `streamFiles` in
   * one synchronous batch, so a preselect can never arrive after mount — and this
   * form is preferred only because it has no stale-initialisation failure mode if
   * that ever stops being true. No test covers a late arrival, deliberately:
   * nothing can produce one.
   */
  preselect?: number;
  // Toggle the current torrent as a favourite (the `b` key).
  onFavourite?: () => void;
  // Whether the current torrent is already favourited (drives the star glyph).
  favourited?: boolean;
}

// Pick a file to stream when a torrent holds several videos. Defaults to sorting
// by title; press "s" to toggle between title and size ordering.
export function StreamFilePrompt({
  width,
  files,
  onSelect,
  onCancel,
  maxRows = 8,
  watched = [],
  onFavourite,
  favourited = false,
  preselect,
}: StreamFilePromptProps) {
  // null means "wherever the preselection says", so a re-sort cannot strand the
  // highlight. Any keypress makes the cursor a number and the preselection stops
  // being consulted.
  const [cursor, setCursor] = useState<number | null>(null);
  const [sortMode, setSortMode] = useState<StreamFileSort>("name");
  const sorted = useMemo(() => sortStreamFiles(files, sortMode), [files, sortMode]);
  const preselectUrl = preselect !== undefined ? files[preselect]?.url : undefined;
  const opening = preselectUrl !== undefined
    ? Math.max(0, sorted.findIndex((f) => f.url === preselectUrl))
    : 0;
  const clamped = Math.min(cursor ?? opening, Math.max(0, sorted.length - 1));
  const watchedSet = useMemo(() => new Set(watched), [watched]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (input === "b" || input === "B") {
      onFavourite?.();
      return;
    }
    if (input === "s" || input === "S") {
      // Keep the highlighted file selected across the re-sort.
      const current = sorted[clamped];
      const next = nextSort(sortMode);
      setSortMode(next);
      if (current) {
        const idx = sortStreamFiles(files, next).findIndex((f) => f.url === current.url);
        if (idx >= 0) setCursor(idx);
      }
      return;
    }
    if (key.upArrow) setCursor(Math.max(0, clamped - 1));
    else if (key.downArrow) setCursor(Math.min(sorted.length - 1, clamped + 1));
    else if (key.return) {
      const file = sorted[clamped];
      if (file) {
        onSelect(file);
        // Keep the picker open and jump to the next not-yet-watched episode
        // (treating the one just picked as watched, since the prop lags a tick).
        const nextIdx = sorted.findIndex(
          (f, i) => i > clamped && !watchedSet.has(f.filename) && f.filename !== file.filename,
        );
        setCursor(nextIdx >= 0 ? nextIdx : Math.min(sorted.length - 1, clamped + 1));
      }
    }
  });

  const nameW = Math.max(10, width - 16);
  // Scroll a window over the list so the cursor stays visible when the archive
  // holds more files than fit on screen.
  const visible = Math.max(1, Math.min(sorted.length, maxRows));
  const start = Math.min(
    Math.max(0, clamped - visible + 1),
    Math.max(0, sorted.length - visible),
  );
  const windowFiles = sorted.slice(start, start + visible);

  return (
    <Box flexDirection="column" width={width}>
      <Panel
        title="choose a file to stream"
        width={width}
        focused
        count={`${clamped + 1}/${sorted.length}`}
        height={visible + 1}
      >
        {windowFiles.map((file, i) => {
          const index = start + i;
          const here = index === clamped;
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
              <Box width={2} flexShrink={0} marginLeft={1}>
                <Text dimColor>{watchedSet.has(file.filename) ? ICON.done : ""}</Text>
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
        <Text color={COLOR.alt}>s</Text>
        <Text dimColor>{` sort: ${sortMode}`}</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>b</Text>
        <Text dimColor>{` ${favourited ? "★" : "☆"} favourite`}</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
