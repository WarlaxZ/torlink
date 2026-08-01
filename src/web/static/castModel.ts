import type { Blocker } from "../../util/playability";
import type { CastDevicesResponse, CastStatusResponse } from "../wire";

/**
 * Every decision the cast button makes, as functions.
 *
 * It exists because `player.ts` is DOM wiring with no test reachable without
 * jsdom — which this repo deliberately does not have — and this codebase has
 * twice caught a decision that belonged in a module like this sitting in the
 * wiring instead. If you are about to write a conditional in `player.ts` that
 * chooses what to show or what to send, it belongs here.
 *
 * Nothing here imports `node:*`: this module is bundled for the browser, and
 * `npm run build` is the only thing that proves it stayed that way.
 */

export type CastButtonState = "hidden" | "ready" | "finding" | "disabled" | "casting";

export interface CastButtonView {
  state: CastButtonState;
  label: string;
  /** Shown beside a disabled button. Null in every other state. */
  disabledReason: string | null;
}

export interface CastButtonInput {
  /** Null until `/api/cast/devices` has answered. */
  devices: CastDevicesResponse | null;
  /** Null until the first `cast` event or status read. */
  status: CastStatusResponse | null;
  /** From `.info` — what a Chromecast would refuse about this file. */
  castBlockers: Blocker[];
  /** Whether a provider HLS manifest exists: the one rung above direct play. */
  hasHls: boolean;
}

/** The container is named first, because it is the blocker a user can recognise. */
export function castBlockerReason(blockers: Blocker[]): string {
  if (blockers.includes("container")) return "it won't demux this container";
  if (blockers.includes("video")) return "it can't decode this video";
  if (blockers.includes("audio")) return "it can't decode this audio";
  // Never empty: a disabled button with no reason is the thing this whole
  // feature is written to avoid.
  return "this file isn't something it can play";
}

export function castButtonView(input: CastButtonInput): CastButtonView {
  const { devices, status, castBlockers, hasHls } = input;
  // Hidden rather than disabled while the list is unknown: a button that appears
  // disabled and then becomes enabled a moment later reads as a glitch.
  if (!devices) return { state: "hidden", label: "", disabledReason: null };

  if (status?.casting) {
    return {
      state: "casting",
      label: `Playing on ${status.casting.deviceName}`,
      disabledReason: null,
    };
  }

  // The file's own limit comes first, because fixing the network would not help.
  // Not consulted while something is casting: it got there via HLS, and a
  // "can't play this" label over a playing television would be absurd.
  if (castBlockers.length > 0 && !hasHls) {
    return {
      state: "disabled",
      label: "Cast to TV",
      disabledReason: `A Chromecast can't play this one — ${castBlockerReason(castBlockers)}.`,
    };
  }

  // No devices and no reason means discovery has not finished. With a reason, it
  // has, and the reason is the useful thing to say.
  if (!devices.castable) {
    return devices.reason === null
      ? { state: "finding", label: "Finding devices…", disabledReason: null }
      : { state: "disabled", label: "Cast to TV", disabledReason: devices.reason };
  }

  return { state: "ready", label: "Cast to TV", disabledReason: null };
}

/**
 * `h:mm:ss`.
 *
 * Defensive about its input because the input is a float from a television: the
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

/** The line under "Playing on <device>", or null when nothing is casting. */
export function castStatusLine(status: CastStatusResponse): string | null {
  const casting = status.casting;
  if (!casting) return null;
  if (casting.state === "loading") return "Loading on the TV…";
  if (casting.state === "idle") return "Finished on the TV.";
  // A duration the receiver has not reported is null, not zero: showing
  // "0:00:05 / 0:00:00" would read as a broken file rather than an unknown length.
  const elapsed = formatCastTime(casting.positionSec);
  const clock =
    casting.durationSec === null ? elapsed : `${elapsed} / ${formatCastTime(casting.durationSec)}`;
  return casting.state === "paused" ? `Paused · ${clock}` : clock;
}

export type CastControl = "play" | "pause" | "stop";

/** Which controls to offer. Stop is always available once something is casting. */
export function castControls(status: CastStatusResponse): CastControl[] {
  const casting = status.casting;
  if (!casting) return [];
  if (casting.state === "playing") return ["pause", "stop"];
  if (casting.state === "paused") return ["play", "stop"];
  // Loading, or finished. Pausing something that has not started is a button
  // that appears to do nothing.
  return ["stop"];
}
