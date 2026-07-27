// Pure view state for the dashboard. Kept separate from the DOM binding in
// app.ts so the interesting logic is unit-testable without a headless browser.

export interface StatusDownload {
  id: string;
  name: string;
  status: string;
  progress: number;
  peers: number;
  speed: number;
}

export interface StatusSeed {
  id: string;
  name: string;
  status: string;
  peers: number;
  uploaded: number;
  uploadSpeed: number;
}

export interface StatusPayload {
  downloads: StatusDownload[];
  seeds: StatusSeed[];
}

export interface DashRow {
  id: string;
  name: string;
  kind: "download" | "seed";
  status: string;
  percent: number;
  peers: number;
  rate: number;
  uploaded: number;
}

// Floor, not round: this drives a completion indicator, and rounding would show
// a still-downloading torrent at 0.999 as a full "100%" bar, which reads as a
// bug in the app. Under-reporting by less than a percent is harmless.
function clampPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.floor(progress * 100)));
}

export function rowsFromStatus(payload: StatusPayload): DashRow[] {
  const downloads = (payload.downloads ?? []).map<DashRow>((d) => ({
    id: d.id,
    name: d.name,
    kind: "download",
    status: d.status,
    percent: clampPercent(d.progress),
    peers: d.peers ?? 0,
    rate: d.speed ?? 0,
    uploaded: 0,
  }));
  const seeds = (payload.seeds ?? []).map<DashRow>((s) => ({
    id: s.id,
    name: s.name,
    kind: "seed",
    status: s.status,
    percent: 100,
    peers: s.peers ?? 0,
    rate: s.uploadSpeed ?? 0,
    uploaded: s.uploaded ?? 0,
  }));
  return [...downloads, ...seeds];
}

/**
 * Fold a fresh snapshot into the displayed list without reshuffling it. The
 * server's ordering is not stable across ticks, and a list that reorders under
 * the cursor is unusable — so rows keep the position they were first seen in,
 * new rows append, and vanished rows drop out.
 */
export function mergeRows(previous: DashRow[], next: DashRow[]): DashRow[] {
  const byId = new Map(next.map((r) => [r.id, r]));
  const out: DashRow[] = [];
  for (const old of previous) {
    const fresh = byId.get(old.id);
    if (!fresh) continue;
    out.push(fresh);
    byId.delete(old.id);
  }
  for (const fresh of next) {
    if (byId.has(fresh.id)) out.push(fresh);
  }
  return out;
}

// Byte formatting for the browser. Deliberately a copy of util/format.ts rather
// than an import: that module is Node-facing and this file is bundled for the
// browser. The copies must stay in step — the same torrent is visible in the TUI
// and the browser at once, and two different numbers for one byte count makes a
// user doubt the data rather than the formatter.
function scale(bytes: number, units: string[]): { value: number; unit: number } {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return { value, unit };
}

// Mirrors formatBytes in util/format.ts: two decimals above bytes, whole bytes.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const { value, unit } = scale(bytes, units);
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

// Mirrors formatBytesPerSec in util/format.ts, which has its own precision rule
// (one decimal below 10, else whole) and its own unit table capped at GB/s — so
// this cannot just suffix formatBytes. The one deliberate difference: an idle
// rate is a dash here, where the TUI prints an empty string. Blank is right for
// a terminal row; a table cell needs something in it.
export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const { value, unit } = scale(bytesPerSec, units);
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}
