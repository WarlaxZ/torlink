import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore, useQueueItems, useQueueHistory, type DownloadFocus } from "../store";
import { Panel } from "./Panel";
import { ProgressBar } from "./ProgressBar";
import { wrapStep, windowStart } from "../move";
import { COLOR, GUTTER, ICON, PAUSED, SOURCE_STYLE } from "../theme";
import {
  cleanText,
  formatBytes,
  formatBytesPerSec,
  formatEtaShort,
  formatRelative,
  truncate,
} from "../../util/format";
import { deliveryMethod } from "../downloadState";
import type { QueueItem } from "../../download/types";
import type { HistoryItem } from "../../download/history";
import type { SourceId } from "../../sources/types";
import { postEvent } from "../../recc/client";

const ROWS_PER_ACTIVE = 2;
const MARK = 2;

function statusColor(status: QueueItem["status"]): string {
  if (status === "failed") return COLOR.bad;
  if (status === "paused" || status === "queued") return PAUSED;
  if (status === "selecting") return COLOR.warn;
  return COLOR.accent;
}

function statusIcon(status: QueueItem["status"]): string {
  if (status === "failed") return ICON.error;
  if (status === "paused") return ICON.pause;
  if (status === "selecting" || status === "queued") return ICON.pending;
  return ICON.down;
}

function rightStats(it: QueueItem): string {
  if (it.status === "selecting") return `choose files  ${it.files ?? 0} available`;
  if (it.status === "downloading") {
    // Real-Debrid first caches the torrent on its cloud (resolving), then we
    // pull it over HTTP — no swarm, so no peer count.
    if (it.via === "realdebrid" && it.phase === "queued") {
      return "queued — waiting for Real-Debrid";
    }
    if (it.via === "realdebrid" && it.phase === "resolving") {
      return `preparing on Real-Debrid… ${it.progress}%`;
    }
    const speed = formatBytesPerSec(it.speed) || "…";
    const eta = it.eta ? `  ${formatEtaShort(it.eta)}` : "";
    if (it.via === "realdebrid") return `${it.progress}%  ${speed}${eta}`;
    return `${it.progress}%  ${speed}  ${ICON.peer}${it.peers}${eta}`;
  }
  if (it.status === "paused") return `paused  ${it.progress}%`;
  if (it.status === "queued") return `queued  ${it.progress}%`;
  return truncate(it.error || "failed", 28);
}

// The source cell: a colored delivery-method marker (RD green / P2P amber) plus
// the torrent origin tag, e.g. "RD·EZTV" / "P2P·YTS". `method` is null only for
// legacy history rows with no recorded method (shown origin-only, never
// mislabeled). With neither method nor source, falls back to a dim "mag".
function SourceBadge({
  method,
  source,
  dim,
}: {
  method: "RD" | "P2P" | null;
  source?: SourceId;
  dim?: boolean;
}) {
  const ss = source ? SOURCE_STYLE[source] : undefined;
  const methodColor = method === "RD" ? COLOR.good : COLOR.warn;
  if (!method && !ss) return <Text dimColor>mag</Text>;
  return (
    <Text>
      {method ? (
        <Text color={methodColor} dimColor={dim}>
          {method}
        </Text>
      ) : null}
      {method && ss ? <Text dimColor>·</Text> : null}
      {ss ? (
        <Text color={ss.color} dimColor={dim}>
          {ss.tag}
        </Text>
      ) : null}
    </Text>
  );
}

export function Downloads() {
  const {
    config,
    queue,
    region,
    section,
    contentWidth,
    listRows,
    startDownload,
    openDownloadFolder,
    setDownloadFocus,
    copyLink,
    setNotice,
    exportTorrent,
  } = useStore();
  const active = useQueueItems(queue);
  const recent = useQueueHistory(queue);
  const focused = region === "content" && section === "downloads";

  const total = active.length + recent.length;
  const [cursor, setCursor] = useState(0);
  // An active Real-Debrid item whose direct link the user asked to copy before
  // it had resolved — we copy it automatically the moment it's ready.
  const [copyWhenReady, setCopyWhenReady] = useState<string | null>(null);

  useEffect(() => {
    if (!copyWhenReady) return;
    const it = active.find((i) => i.id === copyWhenReady);
    // Item finished/removed, or failed before a link appeared — drop the intent.
    if (!it || it.status === "failed") {
      setCopyWhenReady(null);
      return;
    }
    if (it.directUrl) {
      copyLink(it.directUrl, it.name);
      setCopyWhenReady(null);
    }
  }, [active, copyWhenReady, copyLink]);
  const clamped = Math.min(cursor, Math.max(0, total - 1));
  const inActive = clamped < active.length;
  const recentCursor = clamped - active.length;

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCursor(wrapStep(clamped, -1, total));
      else if (key.downArrow || input === "j") setCursor(wrapStep(clamped, 1, total));
      else if (input === "f") queue.retryFailed();
      else if (input === "e") {
        const dir = inActive ? active[clamped]?.dir : recent[recentCursor]?.dir;
        if (dir) openDownloadFolder(dir);
      } else if (input === "s") {
        const item = inActive ? active[clamped] : recent[recentCursor];
        if (item) exportTorrent({ id: item.id, name: item.name });
      } else if (inActive) {
        const it = active[clamped];
        if (!it) return;
        if (input === "c") {
          void postEvent(
            { reccUrl: config.reccUrl, reccToken: config.reccToken },
            { type: "abandoned", rawName: it.name, ts: Date.now(), source: "torlink" },
          );
          queue.cancel(it.id);
        } else if (input === "p") queue.togglePause(it.id);
        else if (input === "y") {
          if (it.directUrl) copyLink(it.directUrl, it.name);
          else if (it.via === "realdebrid") {
            setCopyWhenReady(it.id);
            setNotice("Will copy the link once Real-Debrid is ready…");
          } else setNotice("No direct link — that's a peer-to-peer download.");
        }
      } else {
        const h = recent[recentCursor];
        if (!h) return;
        if (key.return || input === "d")
          startDownload({
            id: h.id,
            name: h.name,
            magnet: h.magnet,
            source: h.source,
            sizeBytes: h.sizeBytes,
          });
        else if (input === "c") queue.removeHistory(h.id);
        // Clear-all lives here, not at the top of the chain, so it can only
        // fire while the cursor is actually on the recent list.
        else if (input === "C") queue.clearHistory();
      }
    },
    { isActive: focused && total > 0 },
  );

  let focusKind: DownloadFocus | null = null;
  if (focused && total > 0) {
    if (!inActive) focusKind = "recent";
    else {
      const st = active[clamped]?.status;
      if (st === "downloading" || st === "paused" || st === "failed") focusKind = st;
    }
  }
  useEffect(() => {
    setDownloadFocus(focusKind);
    return () => setDownloadFocus(null);
  }, [focusKind, setDownloadFocus]);

  const panelH = Math.max(5, listRows - 1);

  if (total === 0) {
    return (
      <Panel title="downloads" width={contentWidth} focused={focused} height={panelH}>
        <Text dimColor>No downloads yet. Find something and press d to grab it.</Text>
      </Panel>
    );
  }

  const hasActive = active.length > 0;
  const hasRecent = recent.length > 0;
  const headerRows = hasRecent ? 1 : 0;
  const ceiling = Math.max(1, panelH - 1);

  let gapRows = hasActive && hasRecent ? 1 : 0;
  let maxActive = 0;
  let maxRecent = 0;
  if (!hasRecent) {
    maxActive = Math.max(1, Math.floor(ceiling / ROWS_PER_ACTIVE));
  } else if (!hasActive) {
    maxRecent = Math.max(1, ceiling - headerRows);
  } else {
    let budget = ceiling - headerRows - gapRows;
    if (budget < ROWS_PER_ACTIVE + 1) {
      gapRows = 0;
      budget = ceiling - headerRows;
    }
    const activeRowCap = Math.max(ROWS_PER_ACTIVE, Math.floor(budget * 0.55));
    maxActive = Math.min(active.length, Math.max(1, Math.floor(activeRowCap / ROWS_PER_ACTIVE)));
    maxRecent = Math.max(1, budget - maxActive * ROWS_PER_ACTIVE);
  }

  const activeStart = windowStart(inActive ? clamped : 0, active.length, maxActive);
  const activeVisible = active.slice(activeStart, activeStart + maxActive);
  const recentStart = windowStart(inActive ? 0 : recentCursor, recent.length, maxRecent);
  const recentVisible = recent.slice(recentStart, recentStart + maxRecent);

  const inner = contentWidth - 4;
  const gap = 2;
  const barW = Math.max(8, Math.min(28, Math.floor(inner * 0.4)));
  const statsW = Math.max(6, inner - MARK - GUTTER - barW - gap);

  const count = hasActive ? `(${active.length})` : undefined;

  return (
    <Panel title="downloads" width={contentWidth} focused={focused} count={count} height={panelH}>
      {activeVisible.map((it, i) => {
        const here = activeStart + i === clamped && focused && inActive;
        const sc = statusColor(it.status);
        return (
          <Box key={it.id} flexDirection="column">
            <Box>
              <Box width={MARK} flexShrink={0}>
                <Text color={COLOR.accent} bold>
                  {here ? ICON.pointer : ""}
                </Text>
              </Box>
              <Box width={GUTTER} flexShrink={0}>
                <Text color={sc}>{statusIcon(it.status)}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text
                  wrap="truncate-end"
                  bold={here}
                  color={here ? COLOR.accent : undefined}
                  dimColor={!here}
                >
                  {cleanText(it.name)}
                </Text>
              </Box>
              <Box width={10} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                <Text dimColor>{it.totalBytes > 0 ? formatBytes(it.totalBytes) : "-"}</Text>
              </Box>
              <Box width={8} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                <SourceBadge method={deliveryMethod(it.via)} source={it.source} dim={!here} />
              </Box>
            </Box>
            <Box>
              <Box width={MARK + GUTTER} flexShrink={0} />
              <ProgressBar
                pct={it.progress}
                width={barW}
                color={sc}
                animate={it.status === "downloading"}
              />
              <Box marginLeft={gap} flexShrink={0}>
                <Text dimColor>{truncate(rightStats(it), statsW)}</Text>
              </Box>
            </Box>
          </Box>
        );
      })}

      {hasRecent ? (
        <Box marginTop={gapRows ? 1 : 0}>
          <Text dimColor>{`Recently downloaded${recent.length > 1 ? `  (${recent.length})` : ""}`}</Text>
        </Box>
      ) : null}

      {recentVisible.map((h: HistoryItem, i) => {
        const here = recentStart + i === recentCursor && focused && !inActive;
        const when = formatRelative(h.completedAt / 1000);
        return (
          <Box key={h.id}>
            <Box width={MARK} flexShrink={0}>
              <Text color={COLOR.accent} bold>
                {here ? ICON.pointer : ""}
              </Text>
            </Box>
            <Box width={GUTTER} flexShrink={0}>
              <Text color={COLOR.good} dimColor={!here}>
                {ICON.done}
              </Text>
            </Box>
            <Box flexGrow={1} minWidth={0}>
              <Text
                wrap="truncate-end"
                bold={here}
                color={here ? COLOR.accent : undefined}
                dimColor={!here}
              >
                {cleanText(h.name)}
              </Text>
            </Box>
            <Box width={10} flexShrink={0} marginLeft={1} justifyContent="flex-end">
              <Text dimColor>{h.sizeBytes > 0 ? formatBytes(h.sizeBytes) : "-"}</Text>
            </Box>
            <Box width={12} flexShrink={0} marginLeft={1} justifyContent="flex-end">
              <Text dimColor>{when || "-"}</Text>
            </Box>
            <Box width={8} flexShrink={0} marginLeft={1} justifyContent="flex-end">
              <SourceBadge
                method={h.via === undefined ? null : deliveryMethod(h.via)}
                source={h.source}
                dim={!here}
              />
            </Box>
          </Box>
        );
      })}
    </Panel>
  );
}
