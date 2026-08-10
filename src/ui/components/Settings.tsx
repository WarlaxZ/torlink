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

// Kept exported from here (Accounts.tsx was folded into this pane) so App.tsx
// and the tests have one source for the shape of a debrid account row.
export interface DebridAccountProps {
  provider: DebridProviderId;
  token: string;
  status: DebridStatus | null;
  envOverride?: boolean;
  onManage: () => void;
  onSignOut: () => void;
}

interface SettingsProps {
  // ---- accounts (folded in from the old Accounts pane) ----
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
  // ---- settings dispatch (open the existing editors / flip the toggles) ----
  onEditFolder: () => void;
  onEditSources: () => void;
  onEditQuality: () => void;
  onEditDns: () => void;
  onEditTrackers: () => void;
  onEditLimits: () => void;
  onEditVpn: () => void;
  onEditPlayer: () => void;
  onEditCastDevice: () => void;
  onEditCastHost: () => void;
  onToggleAdult: () => void;
  onToggleProxy: () => void;
  dnsEnvOverride?: boolean;
  playerEnvOverride?: boolean;
  adultEnvOverride?: boolean;
  castDeviceEnvOverride?: boolean;
  castHostEnvOverride?: boolean;
}

interface RowAction {
  key: string;
  verb: string;
  run: () => void;
}

interface Row {
  tag: string;
  color: string;
  label: string;
  // The dim suffix after the label: a service homepage, or a setting's blurb.
  sub: string;
  // Account rows show a green tick / warn marker driven by `ok`; setting rows
  // show a plain dot, because a preference is neither healthy nor unhealthy.
  kind: "account" | "setting";
  // Account rows: whether an account exists. Setting rows: always true (a value
  // is always shown).
  present: boolean;
  ok: boolean;
  status: string;
  emptyStatus: string;
  primary: RowAction;
  secondary: RowAction[];
}

// A setting's value line, with an optional "env override active" note appended
// the same way the account rows note theirs.
function withEnv(value: string, env: boolean | undefined): string {
  return env ? `${value} · env override active` : value;
}

export function Settings(props: SettingsProps) {
  const { region, section, contentWidth, listRows, config, adultEnabled } = useStore();
  const focused = region === "content" && section === "settings";
  const [cursor, setCursor] = useState(0);

  const disabledCount = config.disabledSources?.length ?? 0;
  const dnsCount = config.dnsServers?.length ?? 0;
  const trackerCount = config.trackers?.length ?? 0;
  const quality: string[] = [];
  if (config.maxResolution) quality.push(`≤ ${config.maxResolution}`);
  if (config.requireFeatures?.length) quality.push(`${config.requireFeatures.length} required`);
  if (config.excludeFeatures?.length) quality.push(`${config.excludeFeatures.length} excluded`);
  const limits: string[] = [];
  if (config.downloadLimitKbps) limits.push(`↓ ${config.downloadLimitKbps} KB/s`);
  if (config.uploadLimitKbps) limits.push(`↑ ${config.uploadLimitKbps} KB/s`);
  if (config.seedRatio) limits.push(`ratio ${config.seedRatio}`);
  if (config.seedMinutes) limits.push(`${config.seedMinutes} min`);

  const setting = (
    tag: string,
    label: string,
    sub: string,
    status: string,
    onPrimary: () => void,
    verb = "change",
  ): Row => ({
    tag,
    color: COLOR.accent,
    label,
    sub,
    kind: "setting",
    present: true,
    ok: true,
    status,
    emptyStatus: status,
    primary: { key: "↵", verb, run: onPrimary },
    secondary: [],
  });

  const settingRows: Row[] = [
    setting("DIR", "Download folder", "where finished downloads land", config.downloadDir, props.onEditFolder),
    setting(
      "SRC",
      "Sources",
      "which indexers are searched",
      disabledCount > 0 ? `${disabledCount} switched off` : "all on",
      props.onEditSources,
    ),
    setting(
      "QLTY",
      "Playback quality",
      "resolution and feature preferences",
      quality.length ? quality.join(" · ") : "best available",
      props.onEditQuality,
    ),
    setting(
      "DNS",
      "Custom DNS",
      "bypass networks that block trackers",
      withEnv(dnsCount > 0 ? `${dnsCount} server${dnsCount === 1 ? "" : "s"}` : "system resolver", props.dnsEnvOverride),
      props.onEditDns,
    ),
    setting(
      "TRK",
      "Extra trackers",
      "announce URLs added to every torrent",
      trackerCount > 0 ? `${trackerCount} added` : "none",
      props.onEditTrackers,
    ),
    setting(
      "LIM",
      "Transfer limits",
      "download, upload and seeding caps",
      limits.length ? limits.join(" · ") : "unlimited",
      props.onEditLimits,
    ),
    setting("VPN", "VPN kill switch", "fail closed if this interface drops", config.vpnInterface || "off", props.onEditVpn),
    setting(
      "CAST",
      "Cast device",
      "a Chromecast mDNS can't reach",
      withEnv(config.castDevice || "auto-discover", props.castDeviceEnvOverride),
      props.onEditCastDevice,
    ),
    setting(
      "HOST",
      "Cast host",
      "LAN address a TV fetches media from",
      withEnv(config.castAdvertiseHost || "auto", props.castHostEnvOverride),
      props.onEditCastHost,
    ),
    setting(
      "PLAY",
      "Media player",
      "command used for streaming",
      withEnv(config.mediaPlayer || "auto-detect", props.playerEnvOverride),
      props.onEditPlayer,
    ),
    setting(
      "XXX",
      "Adult content",
      "show the Porn category and sources",
      withEnv(adultEnabled ? "on" : "off", props.adultEnvOverride),
      props.onToggleAdult,
      "toggle",
    ),
    setting(
      "RLY",
      "Relay debrid streams",
      "proxy media through this machine",
      config.proxyDebridStreams ? "on" : "off",
      props.onToggleProxy,
      "toggle",
    ),
  ];

  const accountRows: Row[] = [
    ...props.debrid.map((d): Row => {
      const meta = getDebridProvider(d.provider);
      const isActive = props.activeDebrid === d.provider;
      const signedIn = d.token !== "";
      const secondary: RowAction[] = [];
      if (signedIn && !props.streamActive) secondary.push({ key: "x", verb: "sign out", run: d.onSignOut });
      if (signedIn && !isActive) secondary.push({ key: "a", verb: "use", run: () => props.onSetActiveDebrid(d.provider) });
      return {
        tag: meta.shortLabel,
        color: COLOR.good,
        label: isActive ? `${meta.label}  ${ICON.dot} active` : meta.label,
        sub: meta.homepage,
        kind: "account",
        present: signedIn,
        ok: signedIn,
        status: `${formatAccountStatus(d.status, new Date())}${d.envOverride ? " · env override active" : ""}`,
        emptyStatus: "Not connected",
        primary: { key: "↵", verb: signedIn ? "switch" : "sign in", run: d.onManage },
        secondary,
      };
    }),
    (() => {
      const signedIn = !!props.rutrackerUser;
      const secondary: RowAction[] = [];
      if (signedIn && !props.streamActive) secondary.push({ key: "x", verb: "sign out", run: props.onSignOutRutracker });
      return {
        tag: "RUT",
        color: "#8fce5a",
        label: "RuTracker",
        sub: "rutracker.org",
        kind: "account" as const,
        present: signedIn,
        ok: signedIn,
        status: signedIn ? `Signed in as ${truncate(props.rutrackerUser!, 24)}` : "Not signed in",
        emptyStatus: "Not signed in",
        primary: { key: "↵", verb: signedIn ? "switch" : "sign in", run: props.onManageRutracker },
        secondary,
      };
    })(),
    (() => {
      const claimable = props.reccStatus?.state === "connected" && props.reccStatus.account?.claimed === false;
      const secondary: RowAction[] = [];
      if (props.reccConfigured && !props.streamActive) secondary.push({ key: "x", verb: "clear", run: props.onSignOutRecc });
      if (props.reccConfigured) secondary.push({ key: "i", verb: "import", run: props.onImportRecc });
      if (claimable) secondary.push({ key: "c", verb: "claim", run: props.onClaimRecc });
      return {
        tag: "RCD",
        color: COLOR.accent,
        label: "reccd",
        sub: "self-hosted · private service",
        kind: "account" as const,
        present: props.reccConfigured,
        ok: props.reccStatus?.state === "connected",
        status: `${formatReccStatus(props.reccStatus)}${props.reccEnvOverride ? " · env override active" : ""}`,
        emptyStatus: "Not configured",
        primary: { key: "↵", verb: props.reccConfigured ? "edit" : "set up", run: props.onManageRecc },
        secondary,
      };
    })(),
    (() => {
      const secondary: RowAction[] = [];
      if (props.omdbConfigured && !props.streamActive) secondary.push({ key: "x", verb: "clear", run: props.onSignOutOmdb });
      return {
        tag: "OMDb",
        color: "#f5c518", // IMDb yellow
        label: "OMDb",
        sub: "omdbapi.com · plot summaries",
        kind: "account" as const,
        present: props.omdbConfigured,
        ok: props.omdbConfigured,
        status: `Key set${props.omdbEnvOverride ? " · env override active" : ""}`,
        emptyStatus: "Not configured",
        primary: { key: "↵", verb: props.omdbConfigured ? "edit" : "add key", run: props.onManageOmdb },
        secondary,
      };
    })(),
  ];

  const rows: Row[] = [...settingRows, ...accountRows];
  const clamped = Math.min(cursor, rows.length - 1);

  useInput(
    (input, key) => {
      if (key.upArrow) setCursor(wrapStep(clamped, -1, rows.length));
      else if (key.downArrow) setCursor(wrapStep(clamped, 1, rows.length));
      else if (key.return) rows[clamped]!.primary.run();
      else {
        const action = rows[clamped]!.secondary.find((a) => a.key === input);
        if (action) action.run();
      }
    },
    { isActive: focused },
  );

  const panelH = Math.max(5, listRows - 1);

  // Each row is two lines with a blank between, so n rows cost 3n - 1 lines. The
  // blurb and its margin take the first two, and the panel border the last. Show
  // as many whole rows as fit and scroll the rest, rather than letting a short
  // pane clip a row the cursor can still reach. Identical to the old Accounts
  // pane's windowing, which this replaced.
  const listH = Math.max(2, panelH - 3);
  const visibleCount = Number.isFinite(listH) ? Math.max(1, Math.floor((listH + 1) / 3)) : rows.length;
  const start = windowStart(clamped, rows.length, visibleCount);
  const visible = rows.slice(start, start + visibleCount);

  return (
    <Panel title="settings" width={contentWidth} focused={focused} height={panelH}>
      <Box>
        <Text dimColor>Preferences and accounts. ↵ to change; accounts are signed in here too.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((r, vi) => {
          const i = start + vi;
          const here = i === clamped && focused;
          return (
            // Each row is two lines tall (name, then status). flexShrink={0} and a
            // fixed height keep Yoga from squashing the status onto the name line
            // when the pane is too short — the exact bug Accounts.tsx documented.
            <Box key={`${r.kind}:${r.tag}:${r.label}`} marginTop={vi > 0 ? 1 : 0} flexShrink={0} height={2}>
              <Box width={GUTTER} flexShrink={0}>
                <Text color={COLOR.accent} bold>{here ? ICON.pointer : ""}</Text>
              </Box>
              <Box width={5} flexShrink={0}>
                <Text color={r.color} bold={here}>{r.tag}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0} marginLeft={1} flexDirection="column">
                {/* truncate, not wrap: a long value would otherwise spill over the
                    key hints to its right and clip them mid-word. */}
                <Text bold={here} color={here ? COLOR.accent : undefined} dimColor={!here} wrap="truncate">
                  {r.label}
                  <Text dimColor>{`  ${ICON.dot} ${r.sub}`}</Text>
                </Text>
                {r.kind === "setting" ? (
                  <Text wrap="truncate">
                    <Text dimColor>{`${ICON.dot} ${r.status}`}</Text>
                  </Text>
                ) : r.present ? (
                  <Text wrap="truncate">
                    <Text color={r.ok ? COLOR.good : COLOR.warn}>{`${r.ok ? ICON.done : ICON.warn} `}</Text>
                    <Text dimColor>{r.status}</Text>
                  </Text>
                ) : (
                  <Text dimColor wrap="truncate">{`${ICON.dot} ${r.emptyStatus}`}</Text>
                )}
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                <Text>
                  <Text color={COLOR.alt}>{r.primary.key}</Text>
                  <Text dimColor>{` ${r.primary.verb}`}</Text>
                  {r.secondary.map((a) => (
                    <Text key={a.key}>
                      <Text dimColor>{`  ${ICON.dot}  `}</Text>
                      <Text color={COLOR.alt}>{a.key}</Text>
                      <Text dimColor>{` ${a.verb}`}</Text>
                    </Text>
                  ))}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}
