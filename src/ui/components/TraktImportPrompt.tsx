import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { formatImportSummary } from "../../recc/importSummary";
import type { TraktImportResult } from "../../recc/traktImport";

export interface TraktImportView {
  phase: "checking" | "connect" | "running" | "done";
  connect?: { userCode: string; verificationUrl: string };
  progress?: { message: string };
  result?: TraktImportResult;
  error?: string;
}

interface TraktImportPromptProps {
  width: number;
  state: TraktImportView;
  onClose: () => void;
}

const MAX_VISIBLE_UNMATCHED = 8;

export function TraktImportPrompt({ width, state, onClose }: TraktImportPromptProps) {
  const [scroll, setScroll] = useState(0);
  const unmatched = state.result?.unresolvedTitles ?? [];
  const maxScroll = Math.max(0, unmatched.length - MAX_VISIBLE_UNMATCHED);

  useEffect(() => {
    if (state.phase !== "done") setScroll(0);
  }, [state.phase]);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (state.phase === "done") {
      if (key.return) onClose();
      else if (key.upArrow) setScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow) setScroll((s) => Math.min(maxScroll, s + 1));
    }
  });

  if (state.phase === "checking") {
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Trakt history" width={width} focused height={3}>
          <Text>
            <Text color={COLOR.accent}>{`${ICON.dot} `}</Text>
            Checking your Trakt connection…
          </Text>
        </Panel>
      </Box>
    );
  }

  if (state.phase === "connect") {
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Trakt history" width={width} focused height={7}>
          <Text>To connect Trakt, open this page and enter the code:</Text>
          <Box marginTop={1}>
            <Text color={COLOR.accent}>{state.connect?.verificationUrl ?? "https://trakt.tv/activate"}</Text>
          </Box>
          <Box marginTop={1}>
            <Text>code: </Text>
            <Text color={COLOR.good} bold>{state.connect?.userCode ?? ""}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{`${ICON.dot} Waiting for you to authorize…`}</Text>
          </Box>
        </Panel>
        <Box marginTop={1}>
          <Text color={COLOR.alt}>esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === "running") {
    return (
      <Box flexDirection="column" width={width}>
        <Panel title="import Trakt history" width={width} focused height={3}>
          <Text>
            <Text color={COLOR.accent}>{`${ICON.dot} `}</Text>
            {state.progress?.message ?? "Importing from Trakt…"}
          </Text>
        </Panel>
      </Box>
    );
  }

  // phase === "done"
  const offset = Math.min(scroll, maxScroll);
  const visible = unmatched.slice(offset, offset + MAX_VISIBLE_UNMATCHED);
  const scrollable = unmatched.length > MAX_VISIBLE_UNMATCHED;
  const listHeader = scrollable
    ? `unmatched titles (${offset + 1}–${offset + visible.length} of ${unmatched.length}):`
    : "unmatched titles:";
  return (
    <Box flexDirection="column" width={width}>
      <Panel title="import Trakt history" width={width} focused height={4 + visible.length + (unmatched.length > 0 ? 1 : 0)}>
        {state.error ? <Text color={COLOR.warn}>{`${ICON.warn} ${state.error}`}</Text> : null}
        {state.result ? (
          <Text>
            <Text color={COLOR.good}>{`${ICON.done} `}</Text>
            {formatImportSummary(state.result)}
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
