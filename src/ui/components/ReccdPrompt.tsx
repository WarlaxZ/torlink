import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { formatReccStatus, type ReccStatus } from "../../recc/status";

type FieldKey = "url" | "token";

interface ReccdPromptProps {
  width: number;
  url: string;
  token: string;
  status: ReccStatus | null;
  onSubmit: (url: string, token: string) => void;
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
      <Box width={8} flexShrink={0}>
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

// A private, self-hosted service — reccd is a single URL + bearer token the user
// stands up themselves. Two fields, modeled on RutrackerPrompt.
export function ReccdPrompt({ width, url, token, status, onSubmit, onCancel }: ReccdPromptProps) {
  const [field, setField] = useState<FieldKey>("url");
  const [urlVal, setUrlVal] = useState(url);
  const [tokenVal, setTokenVal] = useState(token);

  const submit = (): void => onSubmit(urlVal.trim(), tokenVal);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) setField("url");
    else if (key.downArrow) setField("token");
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="reccd — private, self-hosted recommendations" width={width} focused height={4}>
        <Field label="URL" active={field === "url"}>
          <TextField
            isDisabled={field !== "url"}
            defaultValue={url}
            placeholder="http://localhost:4100"
            onChange={setUrlVal}
            onSubmit={() => setField("token")}
            onExitDown={() => setField("token")}
          />
        </Field>
        <Field label="Token" active={field === "token"}>
          <TextField
            isDisabled={field !== "token"}
            mask
            defaultValue={token}
            placeholder="bearer token from reccd `user:add`"
            onChange={setTokenVal}
            onSubmit={submit}
          />
        </Field>
        <Box marginTop={1}>
          <Text dimColor>{`status: ${formatReccStatus(status)}`}</Text>
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> next / save</Text>
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
