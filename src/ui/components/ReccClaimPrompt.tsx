import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";

type FieldKey = "name" | "password";

interface ReccClaimPromptProps {
  width: number;
  /** The generated name being replaced, when it is known. */
  accountName?: string;
  /** The message from a failed attempt, kept on screen so the user can retry. */
  error?: string;
  busy?: boolean;
  onSubmit: (name: string, password: string) => void;
  onCancel: () => void;
}

function Field({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Box width={10} flexShrink={0}>
        <Text color={active ? COLOR.accent : undefined} dimColor={!active}>
          {label}
        </Text>
      </Box>
      <Text color={active ? COLOR.accent : COLOR.alt}>{`${ICON.pointer} `}</Text>
      <Box flexGrow={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  );
}

// Claiming an account that already works. The account was created for the user
// automatically and holds their history; this gives it a name and a password so
// they can reach it from somewhere else. Worth saying on screen, because
// "claim" alone reads like something is currently broken.
export function ReccClaimPrompt({
  width,
  accountName,
  error,
  busy = false,
  onSubmit,
  onCancel,
}: ReccClaimPromptProps) {
  const [field, setField] = useState<FieldKey>("name");
  const [nameVal, setNameVal] = useState("");
  const [passwordVal, setPasswordVal] = useState("");

  const submit = (): void => {
    if (busy) return;
    onSubmit(nameVal.trim(), passwordVal);
  };

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) setField("name");
    else if (key.downArrow) setField("password");
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="claim your reccd account" width={width} focused height={6}>
        <Box marginBottom={1}>
          <Text dimColor wrap="truncate">
            {accountName
              ? `${accountName} holds your history. Pick a username and password to sign in elsewhere.`
              : "This account holds your history. Pick a username and password to sign in elsewhere."}
          </Text>
        </Box>
        <Field label="Username" active={field === "name"}>
          <TextField
            isDisabled={field !== "name" || busy}
            placeholder="the name you'll sign in with"
            onChange={setNameVal}
            onSubmit={() => setField("password")}
            onExitDown={() => setField("password")}
          />
        </Field>
        <Field label="Password" active={field === "password"}>
          <TextField
            isDisabled={field !== "password" || busy}
            mask
            placeholder="at least 8 characters"
            onChange={setPasswordVal}
            onSubmit={submit}
          />
        </Field>
        <Box marginTop={1}>
          {busy ? (
            <Text dimColor>Claiming…</Text>
          ) : error ? (
            <Text color={COLOR.warn} wrap="truncate">{`${ICON.warn} ${error}`}</Text>
          ) : (
            <Text dimColor>Your picks and history stay exactly as they are.</Text>
          )}
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> next / claim</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>↑↓</Text>
        <Text dimColor> field</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
