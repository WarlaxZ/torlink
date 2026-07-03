import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";
import { truncate } from "../../util/format";
import { formatAccountStatus, type RdStatus } from "../../integrations/rdStatus";

interface AccountsProps {
  rdToken: string;
  rdStatus: RdStatus | null;
  rutrackerUser?: string;
  onManageRd: () => void;
  onSignOutRd: () => void;
  onManageRutracker: () => void;
  onSignOutRutracker: () => void;
}

interface Row {
  tag: string;
  color: string;
  label: string;
  homepage: string;
  signedIn: boolean;
  status: string;
  onManage: () => void;
  onSignOut: () => void;
}

export function Accounts({
  rdToken,
  rdStatus,
  rutrackerUser,
  onManageRd,
  onSignOutRd,
  onManageRutracker,
  onSignOutRutracker,
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
      status: formatAccountStatus(rdStatus, new Date()),
      onManage: onManageRd,
      onSignOut: onSignOutRd,
    },
    {
      tag: "RUT",
      color: "#8fce5a",
      label: "RuTracker",
      homepage: "rutracker.org",
      signedIn: !!rutrackerUser,
      status: rutrackerUser ? `Signed in as ${truncate(rutrackerUser, 24)}` : "Not signed in",
      onManage: onManageRutracker,
      onSignOut: onSignOutRutracker,
    },
  ];

  const clamped = Math.min(cursor, rows.length - 1);

  useInput(
    (input, key) => {
      if (key.upArrow) setCursor(wrapStep(clamped, -1, rows.length));
      else if (key.downArrow) setCursor(wrapStep(clamped, 1, rows.length));
      else if (key.return) rows[clamped]!.onManage();
      else if (input === "x" && rows[clamped]!.signedIn) rows[clamped]!.onSignOut();
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
                    <Text color={COLOR.good}>{`${ICON.done} `}</Text>
                    <Text dimColor>{r.status}</Text>
                  </Text>
                ) : (
                  <Text dimColor>{`${ICON.dot} ${r.label === "Real-Debrid" ? "Not connected" : "Not signed in"}`}</Text>
                )}
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                {r.signedIn ? (
                  <Text>
                    <Text color={COLOR.alt}>↵</Text>
                    <Text dimColor> switch</Text>
                    <Text dimColor>{`  ${ICON.dot}  `}</Text>
                    <Text color={COLOR.alt}>x</Text>
                    <Text dimColor> sign out</Text>
                  </Text>
                ) : (
                  <Text>
                    <Text color={COLOR.alt}>↵</Text>
                    <Text dimColor> sign in</Text>
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
