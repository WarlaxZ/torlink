import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { hyperlink } from "../../util/terminal";
import type { Captcha } from "../../sources/rutracker/session";

export type LoginStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string };

type FieldKey = "user" | "pass" | "captcha" | "copy";

interface RutrackerPromptProps {
  width: number;
  currentUser?: string;
  status: LoginStatus;
  captcha?: Captcha;
  onSubmit: (username: string, password: string, captchaCode?: string) => void;
  onCopyCaptcha: (url: string) => void;
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

export function RutrackerPrompt({
  width,
  currentUser,
  status,
  captcha,
  onSubmit,
  onCopyCaptcha,
  onCancel,
}: RutrackerPromptProps) {
  const [field, setField] = useState<FieldKey>("user");
  const [username, setUsername] = useState(currentUser ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const busy = status.kind === "busy";

  const submit = (): void => {
    if (!username.trim() || !password) return;
    if (captcha && !code.trim()) return;
    onSubmit(username.trim(), password, captcha ? code.trim() : undefined);
  };

  const order: FieldKey[] = captcha ? ["user", "pass", "captcha", "copy"] : ["user", "pass"];

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (busy) return;
    if (key.return && field === "copy" && captcha) {
      onCopyCaptcha(captcha.imageUrl);
      return;
    }
    if (key.upArrow) {
      const i = order.indexOf(field);
      setField(order[Math.max(0, i - 1)]!);
    } else if (key.downArrow) {
      const i = order.indexOf(field);
      setField(order[Math.min(order.length - 1, i + 1)]!);
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="rutracker login" width={width} focused height={captcha ? 9 : 4}>
        <Field label="Username" active={field === "user" && !busy}>
          <TextField
            isDisabled={busy || field !== "user"}
            defaultValue={username}
            placeholder="username"
            onChange={setUsername}
            onSubmit={() => setField("pass")}
            onExitDown={() => setField("pass")}
          />
        </Field>
        <Field label="Password" active={field === "pass" && !busy}>
          <TextField
            isDisabled={busy || field !== "pass"}
            mask
            placeholder="password"
            onChange={setPassword}
            onSubmit={() => (captcha ? setField("captcha") : submit())}
            onExitDown={() => captcha && setField("captcha")}
          />
        </Field>
        {captcha ? (
          <>
            <Box marginTop={1}>
              <Text color={COLOR.warn}>
                {`${ICON.warn} Captcha required — open `}
                {hyperlink(captcha.imageUrl, "the image")}
                {`, then type the code.`}
              </Text>
            </Box>
            <Field label="Captcha" active={field === "captcha" && !busy}>
              <TextField
                isDisabled={busy || field !== "captcha"}
                placeholder="code from image"
                onChange={setCode}
                onSubmit={submit}
              />
            </Field>
            <Box>
              <Box width={10} flexShrink={0} />
              <Text
                color={field === "copy" ? COLOR.accent : COLOR.alt}
                inverse={field === "copy"}
                bold={field === "copy"}
              >
                {" Copy link "}
              </Text>
            </Box>
          </>
        ) : null}
        <Box marginTop={1}>
          {status.kind === "busy" ? (
            <Text dimColor>Signing in…</Text>
          ) : status.kind === "error" ? (
            <Text color={COLOR.bad}>{`${ICON.error} ${status.message}`}</Text>
          ) : currentUser ? (
            <Text dimColor>{`Signed in as ${currentUser}. Re-enter to switch accounts.`}</Text>
          ) : (
            <Text dimColor>Credentials are sent only to rutracker.org.</Text>
          )}
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> next / sign in</Text>
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
