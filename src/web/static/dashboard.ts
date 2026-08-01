// Pure view state for the dashboard. Kept separate from the DOM binding in
// app.ts so the interesting logic is unit-testable without a headless browser.

// The one import this file makes from outside its directory, and it is
// `import type`: esbuild erases a type-only import entirely, so nothing from
// ../wire.ts reaches the browser bundle and `platform: "browser"` still has
// nothing to complain about. ../wire.ts is types-only and imports nothing
// itself, so even a future accidental value import could not drag in node:*.
//
// Re-exported so app.ts (and the tests) keep a single import site, and — more to
// the point — so these shapes can no longer be *redeclared* here. Hand-mirroring
// the producer's payload is what let `uploadSpeed` go missing and `progress` be
// read in the wrong unit.
export type { StatusDownload, StatusPayload, StatusSeed } from "../wire";
import type { StatusPayload } from "../wire";

export interface DashRow {
  id: string;
  name: string;
  kind: "download" | "seed";
  status: string;
  percent: number;
  peers: number;
  rate: number;
  uploaded: number;
  /** Why a failed download failed. Absent on every other row. */
  error?: string;
}

/**
 * Which actions a row offers.
 *
 * A DECISION, not a constant, and it used to be the constant
 * `["pause","resume","remove"]` for every download whatever its state. That put
 * `pause` and `resume` on a FAILED row — one meaningless, the other a no-op,
 * since `resume` un-pauses and a failed item is not paused — so the rows most
 * in need of an action were the only ones offering none that worked. `retry` is
 * what the TUI's `f` key has always called.
 */
export function rowActions(row: DashRow): readonly string[] {
  if (row.kind === "seed") return ["stop-seed", "delete"];
  if (row.status === "failed") return ["retry", "remove"];
  return ["pause", "resume", "remove"];
}

/** True when a row is a download that has given up. Drives its colour and its actions. */
export function hasFailed(row: DashRow): boolean {
  return row.kind === "download" && row.status === "failed";
}

/**
 * The meta line, or the reason it failed when there is one.
 *
 * A dead torrent's peer count and transfer rate describe nothing — they are `0
 * peers · —`, which reads as a rendering bug rather than as a state. The reason
 * is the only part of that row anyone can act on, so it takes the line.
 */
export function failureLine(row: DashRow): string | null {
  if (!hasFailed(row)) return null;
  return row.error?.trim() ? row.error.trim() : "failed — no reason given";
}

/**
 * UNIT BOUNDARY. `progress` on the wire is an **integer percent, 0–100** —
 * `QueueItem.progress` passed straight through by `statusPayload`, the same
 * number the TUI prints as `${it.progress}%`. It is NOT a 0..1 fraction.
 *
 * So there is no conversion to do here, and doing one is the bug this replaced:
 * multiplying by 100 rendered every in-progress download at 100% (progress 1 →
 * "100%", progress 42 → "100%"). The two conventions look identical at a glance,
 * which is why the unit is named in the parameter and asserted by the shared
 * types in ../wire.ts rather than left to a comment alone.
 *
 * Floor, not round, for the fractional values the type permits but the queue
 * does not currently send: this drives a completion bar, and rounding 99.6 up to
 * a full "100%" on a still-downloading torrent reads as a bug in the app.
 * Under-reporting by less than a percent is harmless. (The queue already caps a
 * running torrent at 99 itself, so 100 here means finished.)
 */
function clampPercent(progressPercent: number): number {
  if (!Number.isFinite(progressPercent)) return 0;
  return Math.max(0, Math.min(100, Math.floor(progressPercent)));
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
    ...(typeof d.error === "string" && d.error.trim() ? { error: d.error.trim() } : {}),
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

/**
 * Clip a torrent name for a `confirm()` dialog.
 *
 * A confirm() on a phone has to stay readable, and a torrent name can be several
 * hundred characters of release tags — which would push the actual question, and
 * the buttons, off the screen. The row itself still shows the full name in its
 * `title`. Lives here rather than in app.ts because both the destructive-action
 * prompts and the Real-Debrid fallback prompt need the same clipping, and two
 * copies would eventually disagree about the limit.
 */
export function shortName(name: string): string {
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
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
