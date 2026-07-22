import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { formatImportSummary, type NetflixImportResult } from "../../recc/netflixImport";

export interface NetflixImportView {
  phase: "form" | "running" | "done";
  progress?: { done: number; total: number };
  result?: NetflixImportResult;
  error?: string;
}

interface NetflixImportPromptProps {
  width: number;
  state: NetflixImportView;
  onSubmit: (path: string) => void;
  onClose: () => void;
}

// How many unmatched titles are visible at once; the rest are reachable by scrolling.
const MAX_VISIBLE_UNMATCHED = 8;

export function NetflixImportPrompt({ width, state, onSubmit, onClose }: NetflixImportPromptProps) {
  const [screen, setScreen] = useState<"intro" | "path">("intro");
  const [pathVal, setPathVal] = useState("");
  const [scroll, setScroll] = useState(0);

  const unmatched = state.result?.unresolvedTitles ?? [];
  const maxScroll = Math.max(0, unmatched.length - MAX_VISIBLE_UNMATCHED);

  // Reset the unmatched-list scroll each time we leave the result screen, so a
  // later import doesn't open mid-scrolled.
  useEffect(() => {
    if (state.phase !== "done") setScroll(0);
  }, [state.phase]);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    // Advance the intro screen with Enter. On the path screen the TextField owns
    // Enter (it fires onSubmit), so we do nothing here.
    if (state.phase === "form" && screen === "intro" && key.return) setScreen("path");
    // On the result screen, Enter closes and ↑/↓ scroll the unmatched list.
    if (state.phase === "done") {
      if (key.return) onClose();
      else if (key.upArrow) setScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow) setScroll((s) => Math.min(maxScroll, s + 1));
    }
  });

  if (state.phase === "running") {
    const p = state.progress;
    const label = p && p.total > 1 ? `Uploading chunk ${p.done}/${p.total}…` : "Uploading…";
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Netflix history" width={width} focused height={3}>
          <Text>
            <Text color={COLOR.accent}>{`${ICON.dot} `}</Text>
            {label}
          </Text>
        </Panel>
      </Box>
    );
  }

  if (state.phase === "done") {
    const offset = Math.min(scroll, maxScroll);
    const visible = unmatched.slice(offset, offset + MAX_VISIBLE_UNMATCHED);
    const scrollable = unmatched.length > MAX_VISIBLE_UNMATCHED;
    const listHeader = scrollable
      ? `unmatched titles (${offset + 1}–${offset + visible.length} of ${unmatched.length}):`
      : "unmatched titles:";
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Netflix history" width={width} focused height={4 + visible.length + (unmatched.length > 0 ? 1 : 0)}>
          {state.error ? (
            <Text color={COLOR.warn}>{`${ICON.warn} ${state.error}`}</Text>
          ) : null}
          {state.result ? (
            <Text>
              <Text color={COLOR.good}>{`${ICON.done} `}</Text>
              {formatImportSummary(state.result)}
              {state.error ? <Text dimColor> (partial)</Text> : null}
            </Text>
          ) : null}
          {unmatched.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>{listHeader}</Text>
              {visible.map((t, i) => (
                <Text key={`${offset + i}-${t}`} dimColor>{`  ${t}`}</Text>
              ))}
            </Box>
          ) : null}
        </Panel>
        <Box marginTop={1}>
          {scrollable ? (
            <Text>
              <Text color={COLOR.alt}>↑↓</Text>
              <Text dimColor> scroll</Text>
              <Text dimColor>{`     ${ICON.dot}     `}</Text>
            </Text>
          ) : null}
          <Text color={COLOR.alt}>↵ / esc</Text>
          <Text dimColor> close</Text>
        </Box>
      </Box>
    );
  }

  // phase === "form"
  if (screen === "intro") {
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Netflix history" width={width} focused height={9}>
          <Text>Import what you've watched on Netflix so reccd can tailor recommendations.</Text>
          <Box marginTop={1}>
            <Text dimColor>
              Your privacy: torlink doesn't care what you watch. Titles are sent only to your own
              reccd server to seed recommendations — nothing else is done with them, and nothing
              leaves your setup.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Get the file: Netflix → Account → Profile &amp; Parental Controls → Viewing activity →
              Download all. You'll get a CSV.
            </Text>
          </Box>
        </Panel>
        <Box marginTop={1}>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> continue</Text>
          <Text dimColor>{`     ${ICON.dot}     `}</Text>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="import Netflix history" width={width} focused height={4}>
        <Text dimColor>Path to your Netflix CSV (tip: drag the file onto the terminal to paste it):</Text>
        <Box marginTop={1}>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <TextField
              placeholder="~/Downloads/NetflixViewingActivity.csv"
              onChange={setPathVal}
              onSubmit={() => {
                const trimmed = pathVal.trim();
                if (trimmed) onSubmit(trimmed);
              }}
            />
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> import</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
