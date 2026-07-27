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

function clampPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
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
    rate: 0,
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

// Byte formatting for the browser. Deliberately a copy of the shape used in
// util/format.ts rather than an import: that module is Node-facing and this file
// is bundled for the browser.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatRate(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "—";
}
