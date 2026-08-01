/**
 * How a cast's progress reads, for both front ends.
 *
 * It started in `src/web/static/castModel.ts` and moved down here the moment the
 * terminal's cast row needed the same line — the pattern this codebase records
 * four copy-then-drift bugs for. `src/util/`, not `src/core/`, because it is
 * presentation shared by two front ends, and it must stay browser-safe: the web
 * bundle imports it.
 */

/** A cast's state as both front ends receive it. */
export type CastPlaybackState = "loading" | "playing" | "paused" | "idle";

/**
 * `h:mm:ss`.
 *
 * Defensive about its input because the input is a float from a television: a
 * receiver reports `currentTime` as a float, and has been seen to report a small
 * negative one while it is still seeking.
 */
export function formatCastTime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h)}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * The one line under the device's name.
 *
 * A duration the receiver has not reported is null, not zero: showing
 * "0:00:05 / 0:00:00" would read as a broken file rather than an unknown length.
 */
export function castClock(status: {
  state: CastPlaybackState;
  positionSec: number;
  durationSec: number | null;
}): string {
  if (status.state === "loading") return "Loading on the TV…";
  if (status.state === "idle") return "Finished on the TV.";
  const elapsed = formatCastTime(status.positionSec);
  const clock =
    status.durationSec === null ? elapsed : `${elapsed} / ${formatCastTime(status.durationSec)}`;
  return status.state === "paused" ? `Paused · ${clock}` : clock;
}

/**
 * Why a Chromecast is refusing this file, as a clause.
 *
 * A CLAUSE, not a sentence: both callers put "A Chromecast can't play this one —"
 * in front of it. The server briefly had its own copy that said "a Chromecast
 * won't demux this container", which read back from a real device as "A Chromecast
 * can't play this one — a Chromecast won't demux this container". One
 * implementation, so the subject is named exactly once.
 *
 * The container is named first because it is the blocker a user can recognise and
 * act on ("it's an mkv"); a codec name is not.
 */
export function castBlockerClause(blockers: readonly string[]): string {
  if (blockers.includes("container")) return "it won't demux this container";
  if (blockers.includes("video")) return "it can't decode this video";
  if (blockers.includes("audio")) return "it can't decode this audio";
  // Never empty: a refusal with no reason is the thing this feature keeps
  // refusing to ship.
  return "this file isn't something it can play";
}
