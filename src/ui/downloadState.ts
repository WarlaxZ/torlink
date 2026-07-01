import type { DownloadVia } from "../download/types";

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
// `via` means a legacy/plain magnet, i.e. peer-to-peer.
export function deliveryMethod(via: DownloadVia | undefined): "RD" | "P2P" {
  return via === "realdebrid" ? "RD" : "P2P";
}
