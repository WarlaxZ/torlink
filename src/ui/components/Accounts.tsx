import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { windowStart, wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";
import { truncate } from "../../util/format";
import { formatAccountStatus } from "../../integrations/debrid/status";
import { getDebridProvider } from "../../integrations/debrid";
import type { DebridProviderId, DebridStatus } from "../../integrations/debrid/types";
import { formatReccStatus, type ReccStatus } from "../../recc/status";

export interface DebridAccountProps {
  provider: DebridProviderId;
  token: string;
  status: DebridStatus | null;
  envOverride?: boolean;
  onManage: () => void;
  onSignOut: () => void;
}

interface AccountsProps {
  debrid: DebridAccountProps[];
  /** Which provider actually resolves magnets, or null when none is configured. */
  activeDebrid: DebridProviderId | null;
  onSetActiveDebrid: (provider: DebridProviderId) => void;
  rutrackerUser?: string;
  reccConfigured: boolean;
  reccStatus: ReccStatus | null;
  reccEnvOverride?: boolean;
  // True while a torrent stream is active; "x" is reserved for stopping it
  // globally, so sign-out must not also fire on the same keystroke.
  streamActive?: boolean;
  onManageRutracker: () => void;
  onSignOutRutracker: () => void;
  onManageRecc: () => void;
  onSignOutRecc: () => void;
  onImportRecc: () => void;
  onClaimRecc: () => void;
  omdbConfigured: boolean;
  omdbEnvOverride?: boolean;
  onManageOmdb: () => void;
  onSignOutOmdb: () => void;
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
  // Offered only when reccd reports an account with no password yet. A claimed
  // account, or a self-hosted reccd that reports no account at all, must not
  // advertise the key — a hint for something the keypress will not do is worse
  // than no hint.
  claimable?: boolean;
  onClaim?: () => void;
  activatable?: boolean;
  isActive?: boolean;
  onActivate?: () => void;
}

export function Accounts({
  debrid,
  activeDebrid,
  onSetActiveDebrid,
  rutrackerUser,
  reccConfigured,
  reccStatus,
  reccEnvOverride = false,
  streamActive = false,
  onManageRutracker,
  onSignOutRutracker,
  onManageRecc,
  onSignOutRecc,
  onImportRecc,
  onClaimRecc,
  omdbConfigured,
  omdbEnvOverride = false,
  onManageOmdb,
  onSignOutOmdb,
}: AccountsProps) {
  const { region, section, contentWidth, listRows } = useStore();
  const focused = region === "content" && section === "accounts";
  const [cursor, setCursor] = useState(0);

  const rows: Row[] = [
    ...debrid.map((d): Row => {
      const meta = getDebridProvider(d.provider);
      const isActive = activeDebrid === d.provider;
      return {
        tag: meta.shortLabel,
        color: COLOR.good,
        label: isActive ? `${meta.label}  ${ICON.dot} active` : meta.label,
        homepage: meta.homepage,
        signedIn: d.token !== "",
        ok: d.token !== "",
        status: `${formatAccountStatus(d.status, new Date())}${d.envOverride ? " · env override active" : ""}`,
        emptyStatus: "Not connected",
        verbSignedIn: "switch",
        verbSignOut: "sign out",
        verbSignedOut: "sign in",
        onManage: d.onManage,
        onSignOut: d.onSignOut,
        activatable: d.token !== "" && !isActive,
        isActive,
        onActivate: () => onSetActiveDebrid(d.provider),
      };
    }),
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
      claimable: reccStatus?.state === "connected" && reccStatus.account?.claimed === false,
      onClaim: onClaimRecc,
    },
    {
      tag: "OMDb",
      color: "#f5c518", // IMDb yellow
      label: "OMDb",
      homepage: "omdbapi.com · plot summaries",
      signedIn: omdbConfigured,
      ok: omdbConfigured,
      status: `Key set${omdbEnvOverride ? " · env override active" : ""}`,
      emptyStatus: "Not configured",
      verbSignedIn: "edit",
      verbSignOut: "clear",
      verbSignedOut: "add key",
      onManage: onManageOmdb,
      onSignOut: onSignOutOmdb,
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
      else if (input === "c" && rows[clamped]!.claimable) rows[clamped]!.onClaim?.();
      else if (input === "a" && rows[clamped]!.activatable) rows[clamped]!.onActivate?.();
    },
    { isActive: focused },
  );

  const panelH = Math.max(5, listRows - 1);

  // Each row is two lines with a blank between, so n rows cost 3n - 1 lines. The
  // blurb and its margin take the first two, and the panel border the last. Show
  // as many whole rows as fit and scroll the rest, rather than letting a short
  // pane clip a provider the cursor can still reach.
  // An unmeasured pane (no listRows yet) shows everything rather than nothing.
  const listH = Math.max(2, panelH - 3);
  const visibleCount = Number.isFinite(listH)
    ? Math.max(1, Math.floor((listH + 1) / 3))
    : rows.length;
  const start = windowStart(clamped, rows.length, visibleCount);
  const visible = rows.slice(start, start + visibleCount);

  return (
    <Panel title="accounts" width={contentWidth} focused={focused} height={panelH}>
      <Box>
        <Text dimColor>Sign in to services that need an account to search or stream.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((r, vi) => {
          const i = start + vi;
          const here = i === clamped && focused;
          return (
            // Each row is two lines tall (name, then status). Without flexShrink={0}
            // a pane too short for every row makes Yoga compress the rows instead of
            // overflowing, and the status ends up overprinting the name on one line.
            <Box key={r.label} marginTop={vi > 0 ? 1 : 0} flexShrink={0} height={2}>
              <Box width={GUTTER} flexShrink={0}>
                <Text color={COLOR.accent} bold>{here ? ICON.pointer : ""}</Text>
              </Box>
              <Box width={5} flexShrink={0}>
                <Text color={r.color} bold={here}>{r.tag}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0} marginLeft={1} flexDirection="column">
                {/* truncate, not wrap: a long name would otherwise spill over the
                    key hints to its right and clip them mid-word. */}
                <Text bold={here} color={here ? COLOR.accent : undefined} dimColor={!here} wrap="truncate">
                  {r.label}
                  <Text dimColor>{`  ${ICON.dot} ${r.homepage}`}</Text>
                </Text>
                {r.signedIn ? (
                  <Text wrap="truncate">
                    <Text color={r.ok ? COLOR.good : COLOR.warn}>{`${r.ok ? ICON.done : ICON.warn} `}</Text>
                    <Text dimColor>{r.status}</Text>
                  </Text>
                ) : (
                  <Text dimColor wrap="truncate">{`${ICON.dot} ${r.emptyStatus}`}</Text>
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
                    {r.claimable ? (
                      <Text>
                        <Text dimColor>{`  ${ICON.dot}  `}</Text>
                        <Text color={COLOR.alt}>c</Text>
                        <Text dimColor> claim</Text>
                      </Text>
                    ) : null}
                    {r.activatable ? (
                      <Text>
                        <Text dimColor>{`  ${ICON.dot}  `}</Text>
                        <Text color={COLOR.alt}>a</Text>
                        <Text dimColor> use</Text>
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
