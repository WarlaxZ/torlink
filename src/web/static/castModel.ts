import type { Blocker } from "../../util/playability";
import { castClock, formatCastTime } from "../../util/castStatus";
import type { CastDevicesResponse, CastStatusResponse, StreamInfoResponse } from "../wire";

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
 * The line under "Playing on <device>", or null when nothing is casting.
 *
 * The formatting itself is `castClock` in `src/util/`, shared with the terminal's
 * cast row — this is only the "is anything casting" half.
 */
export function castStatusLine(status: CastStatusResponse): string | null {
  return status.casting ? castClock(status.casting) : null;
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

/**
 * Which subtitle to send with the cast, as an index into the session's files.
 *
 * The page cannot know which track the browser's own subtitle menu has selected
 * — that state lives inside the `<video>` element and is not readable — so the
 * cast takes the one the page marked `default`, which is the same rule
 * `subtitleTracks` (./subtitleModel.ts) applies. The television then shows what
 * the browser would have shown.
 *
 * Renderable only, for the same reason the `.vtt` route refuses anything else:
 * an ass/ssa track converted to WebVTT is neither.
 */
export function castSubtitleIndex(info: StreamInfoResponse | null): number | undefined {
  const files = (info?.subtitles.files ?? []).filter((f) => f.renderable);
  const chosen = files.find((f) => f.language === "en") ?? files[0];
  return chosen?.index;
}

// Re-exported so this module stays the browser's one cast vocabulary, even though
// the implementation now lives in src/util for the terminal to share.
export { formatCastTime };
