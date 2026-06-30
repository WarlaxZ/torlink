import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";

interface ConfirmPromptProps {
  width: number;
  title: string;
  message: string;
  // Optional third action (e.g. "switch to Real-Debrid") bound to a key.
  altKey?: string;
  altLabel?: string;
  onConfirm: () => void;
  onAlt?: () => void;
  onCancel: () => void;
}

// A small inline yes/no (optionally yes/alt/no) confirmation, styled like the
// other prompts. Owns keyboard input while mounted.
export function ConfirmPrompt({
  width,
  title,
  message,
  altKey,
  altLabel,
  onConfirm,
  onAlt,
  onCancel,
}: ConfirmPromptProps) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return || input === "y") {
      onConfirm();
      return;
    }
    if (altKey && onAlt && input === altKey) {
      onAlt();
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title={title} width={width} focused height={3}>
        <Box>
          <Text color={COLOR.warn}>{`${ICON.error ?? "!"} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <Text color={COLOR.text} wrap="wrap">
              {message}
            </Text>
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>y</Text>
        <Text dimColor> continue</Text>
        {altKey && altLabel ? (
          <>
            <Text dimColor>{`     ${ICON.dot}     `}</Text>
            <Text color={COLOR.alt}>{altKey}</Text>
            <Text dimColor> {altLabel}</Text>
          </>
        ) : null}
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
