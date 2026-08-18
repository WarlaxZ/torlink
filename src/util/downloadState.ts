import type { DownloadVia } from "../download/types";
import type { DebridProviderId } from "../integrations/debrid/types";

export type DownloadState = "downloading" | "paused" | "failed" | "done";

// What, if anything, has happened to a torrent (by infoHash) in the download
// queue or history. An active queue item takes precedence over history, so a
// re-download in progress shows its live state rather than "done".
export function downloadStateFor(
  hash: string,
  items: readonly { id: string; status: string }[],
  history: readonly { id: string }[],
): DownloadState | null {
  const active = items.find((it) => it.id === hash);
  if (active) {
    if (active.status === "paused") return "paused";
    if (active.status === "failed") return "failed";
    return "downloading";
  }
  if (history.some((h) => h.id === hash)) return "done";
  return null;
}

// Which delivery method a download uses, for the downloads-list badge. Absent
// `via` means a legacy/plain magnet, i.e. peer-to-peer. A debrid item with no
// `provider` predates that field and is Real-Debrid.
export function deliveryMethod(
  via: DownloadVia | undefined,
  provider: DebridProviderId | undefined,
): "RD" | "TB" | "P2P" {
  if (via !== "debrid") return "P2P";
  return provider === "torbox" ? "TB" : "RD";
}
