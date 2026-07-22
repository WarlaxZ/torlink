import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";
import { truncate } from "../../util/format";
import { formatAccountStatus, type RdStatus } from "../../integrations/rdStatus";
import { formatReccStatus, type ReccStatus } from "../../recc/status";

interface AccountsProps {
  rdToken: string;
  rdStatus: RdStatus | null;
  rutrackerUser?: string;
  reccConfigured: boolean;
  reccStatus: ReccStatus | null;
  reccEnvOverride?: boolean;
  // True while a torrent stream is active; "x" is reserved for stopping it
  // globally, so sign-out must not also fire on the same keystroke.
  streamActive?: boolean;
  onManageRd: () => void;
  onSignOutRd: () => void;
  onManageRutracker: () => void;
  onSignOutRutracker: () => void;
  onManageRecc: () => void;
  onSignOutRecc: () => void;
  onImportRecc: () => void;
}

interface Row {
  tag: string;
  color: string;
  label: string;
  homepage: string;
  signedIn: boolean;
  // Drives the status icon/colour when signedIn: green tick when true, a warn
  // marker otherwise (e.g. reccd configured but unreachable / bad token).
  ok: boolean;
  status: string;
  emptyStatus: string;
  verbSignedIn: string;
  verbSignOut: string;
  verbSignedOut: string;
  onManage: () => void;
  onSignOut: () => void;
  importable?: boolean;
  onImport?: () => void;
}

export function Accounts({
  rdToken,
  rdStatus,
  rutrackerUser,
  reccConfigured,
  reccStatus,
  reccEnvOverride = false,
  streamActive = false,
  onManageRd,
  onSignOutRd,
  onManageRutracker,
  onSignOutRutracker,
  onManageRecc,
  onSignOutRecc,
  onImportRecc,
}: AccountsProps) {
  const { region, section, contentWidth, listRows } = useStore();
  const focused = region === "content" && section === "accounts";
  const [cursor, setCursor] = useState(0);

  const rows: Row[] = [
    {
      tag: "RD",
      color: COLOR.good,
      label: "Real-Debrid",
      homepage: "real-debrid.com",
      signedIn: rdToken !== "",
      ok: rdToken !== "",
      status: formatAccountStatus(rdStatus, new Date()),
      emptyStatus: "Not connected",
      verbSignedIn: "switch",
      verbSignOut: "sign out",
      verbSignedOut: "sign in",
      onManage: onManageRd,
      onSignOut: onSignOutRd,
    },
    {
      tag: "RUT",
      color: "#8fce5a",
      label: "RuTracker",
      homepage: "rutracker.org",
      signedIn: !!rutrackerUser,
      ok: !!rutrackerUser,
      status: rutrackerUser ? `Signed in as ${truncate(rutrackerUser, 24)}` : "Not signed in",
      emptyStatus: "Not signed in",
      verbSignedIn: "switch",
      verbSignOut: "sign out",
      verbSignedOut: "sign in",
      onManage: onManageRutracker,
      onSignOut: onSignOutRutracker,
    },
    {
      tag: "RCD",
      color: COLOR.accent,
      label: "reccd",
      homepage: "self-hosted · private service",
      signedIn: reccConfigured,
      ok: reccStatus?.state === "connected",
      status: `${formatReccStatus(reccStatus)}${reccEnvOverride ? " · env override active" : ""}`,
      emptyStatus: "Not configured",
      verbSignedIn: "edit",
      verbSignOut: "clear",
      verbSignedOut: "set up",
      onManage: onManageRecc,
      onSignOut: onSignOutRecc,
      importable: true,
      onImport: onImportRecc,
    },
  ];

  const clamped = Math.min(cursor, rows.length - 1);

  useInput(
    (input, key) => {
      if (key.upArrow) setCursor(wrapStep(clamped, -1, rows.length));
      else if (key.downArrow) setCursor(wrapStep(clamped, 1, rows.length));
      else if (key.return) rows[clamped]!.onManage();
      else if (input === "x" && !streamActive && rows[clamped]!.signedIn) rows[clamped]!.onSignOut();
      else if (input === "i" && rows[clamped]!.importable && rows[clamped]!.signedIn) rows[clamped]!.onImport?.();
    },
    { isActive: focused },
  );

  const panelH = Math.max(5, listRows - 1);

  return (
    <Panel title="accounts" width={contentWidth} focused={focused} height={panelH}>
      <Box>
        <Text dimColor>Sign in to services that need an account to search or stream.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r, i) => {
          const here = i === clamped && focused;
          return (
            <Box key={r.label} marginTop={i > 0 ? 1 : 0}>
              <Box width={GUTTER} flexShrink={0}>
                <Text color={COLOR.accent} bold>{here ? ICON.pointer : ""}</Text>
              </Box>
              <Box width={5} flexShrink={0}>
                <Text color={r.color} bold={here}>{r.tag}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0} marginLeft={1} flexDirection="column">
                <Text bold={here} color={here ? COLOR.accent : undefined} dimColor={!here}>
                  {r.label}
                  <Text dimColor>{`  ${ICON.dot} ${r.homepage}`}</Text>
                </Text>
                {r.signedIn ? (
                  <Text>
                    <Text color={r.ok ? COLOR.good : COLOR.warn}>{`${r.ok ? ICON.done : ICON.warn} `}</Text>
                    <Text dimColor>{r.status}</Text>
                  </Text>
                ) : (
                  <Text dimColor>{`${ICON.dot} ${r.emptyStatus}`}</Text>
                )}
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                {r.signedIn ? (
                  <Text>
                    <Text color={COLOR.alt}>↵</Text>
                    <Text dimColor>{` ${r.verbSignedIn}`}</Text>
                    <Text dimColor>{`  ${ICON.dot}  `}</Text>
                    <Text color={COLOR.alt}>x</Text>
                    <Text dimColor>{` ${r.verbSignOut}`}</Text>
                    {r.importable ? (
                      <Text>
                        <Text dimColor>{`  ${ICON.dot}  `}</Text>
                        <Text color={COLOR.alt}>i</Text>
                        <Text dimColor> import</Text>
                      </Text>
                    ) : null}
                  </Text>
                ) : (
                  <Text>
                    <Text color={COLOR.alt}>↵</Text>
                    <Text dimColor>{` ${r.verbSignedOut}`}</Text>
                  </Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}
