import { Box, Text } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { akaNote, suggestionLabel, type TitleSuggestion } from "../../util/titleSuggest";

interface SearchBarProps {
  width: number;
  value: string;
  placeholder?: string;
  editing: boolean;
  history?: string[];
  /**
   * Title suggestions from reccd, already capped by the caller. Rendered only
   * while editing — a list under a collapsed bar is a stale artefact with
   * nothing editing it.
   */
  suggestions?: TitleSuggestion[];
  /** What tab completes to, or null. */
  completion?: string | null;
  onComplete?: (text: string) => void;
  onSubmit: (value: string) => void;
  onChange?: (value: string) => void;
  onExitDown?: () => void;
  onExitLeft?: () => void;
}

export function SearchBar({
  width,
  value,
  placeholder = "Search torrents…",
  editing,
  history,
  suggestions,
  completion = null,
  onComplete,
  onSubmit,
  onChange,
  onExitDown,
  onExitLeft,
}: SearchBarProps) {
  const rows = editing ? (suggestions ?? []) : [];
  return (
    <Box flexDirection="column">
      <Panel title="search" width={width} focused={editing} height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            {editing ? (
              <TextField
                defaultValue={value}
                placeholder={placeholder}
                history={history}
                completion={completion}
                onComplete={onComplete}
                width={Math.max(1, width - 6)}
                onSubmit={onSubmit}
                onChange={onChange}
                onExitDown={onExitDown}
                onExitLeft={onExitLeft}
              />
            ) : value ? (
              <Text wrap="truncate-end">{value}</Text>
            ) : (
              <Text dimColor>{placeholder}</Text>
            )}
          </Box>
        </Box>
      </Panel>
      {/* Rendered only when there is something to show, so an empty list costs
          no vertical space and the layout does not jitter as replies arrive. */}
      {rows.map((hit, i) => {
        const aka = akaNote(hit);
        return (
          <Box key={hit.imdbId} paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {suggestionLabel(hit)}
              {aka ? ` · ${aka}` : ""}
              {/* The top row is what tab takes, so it says so. */}
              {i === 0 && completion !== null ? "   ⇥" : ""}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
