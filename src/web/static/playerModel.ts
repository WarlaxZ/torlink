// Pure decision logic for the player page. Kept separate from the DOM binding
// in player.ts for the same reason dashboard.ts is separate from app.ts: there
// is no headless-browser test environment in this repo, and adding one for a
// page this small would be disproportionate — so everything with a decision in
// it lives here, where a plain unit test can reach it, and player.ts is left as
// wiring that reads end to end.
//
// Bundled for the browser: no node:* imports. What it may import from outside
// this directory is `src/util/`, which is the front-end-agnostic layer both
// front ends share — `npm run build` is what proves any such import is
// browser-safe, following transitive imports where a grep cannot. `URL` and
// `URLSearchParams` are globals in both runtimes, so they are fair game and are
// what parses the intent target below.
import {
  blockersFor,
  classifyFromName,
  extensionOf,
  type Blocker,
} from "../../util/playability";
import type { StreamInfoResponse } from "../wire";

/** Which session/file this page is showing, read off its own location. */
export interface PlayerTarget {
  sid: string;
  index: number;
  /** The `?k=` capability. Empty when absent — the media will then 401. */
  capability: string;
  /** The `?n=` display name. Empty when absent; see `canDirectPlay`. */
  filename: string;
}

/**
 * Parse `/play/:sid/:idx?k=…&n=…`.
 *
 * The grammar deliberately matches `parseStreamPath` on the server, `\d+` index
 * and all: the two are the same address written twice, and a page that accepted
 * an index the server rejects would render a player for a file that 404s.
 *
 * The name arrives in the query rather than from an API call because the page
 * must work for someone who was handed the URL — a phone opening a link from
 * the desktop dashboard has the capability but not the bearer token, so
 * `GET /api/stream/:sid` is not available to it. The name is display-only and
 * chooses nothing but optimism about the codec, so a wrong one costs a wrong
 * label and a fallback card. It is attacker-controlled (it is a filename out of
 * a torrent) and reaches the DOM only through `textContent`.
 */
export function parsePlayerLocation(pathname: string, search: string): PlayerTarget | null {
  const m = /^\/play\/([^/]+)\/(\d+)$/.exec(pathname);
  if (!m) return null;
  let sid: string;
  try {
    sid = decodeURIComponent(m[1]!);
  } catch {
    return null; // a stray "%" is a malformed link, not a session id
  }
  if (!sid) return null;
  const index = Number(m[2]);
  if (!Number.isSafeInteger(index)) return null;
  const params = new URLSearchParams(search);
  return {
    sid,
    index,
    capability: params.get("k") ?? "",
    filename: params.get("n") ?? "",
  };
}

/**
 * One representation of the stream handle: `/stream/:sid/:idx<suffix>?k=…`.
 *
 * Written once and shared by the four public builders below, which are the same
 * address four times over — `splitRepresentation` on the server treats them as
 * one route with one set of guards, and it would be odd for the client to spell
 * the address four times and risk them drifting apart.
 *
 * Mirrors `streamHandle` in ../routes.ts — the same encodeURIComponent, for the
 * same reason. A session id with a slash in it must not become a different path
 * here than the one the server will parse.
 */
function repPath(target: PlayerTarget, suffix: string): string {
  const base = `/stream/${encodeURIComponent(target.sid)}/${target.index}${suffix}`;
  return target.capability ? `${base}?k=${encodeURIComponent(target.capability)}` : base;
}

/** The media itself: `/stream/:sid/:idx?k=…`. */
export function streamPath(target: PlayerTarget): string {
  return repPath(target, "");
}

/** The `.m3u` path for a target. Same address, playlist representation. */
export function playlistPath(target: PlayerTarget): string {
  return repPath(target, ".m3u");
}

/** Resolve one of the paths above against the page's own origin. */
export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}

// extensionOf moved to ../../util/playability.ts when the server's .info route
// became a second consumer of it. Re-exported here so this module stays the one
// place the player page imports from.
export { extensionOf };

/** The `.info` path for a target. Same address, facts representation. */
export function infoPath(target: PlayerTarget): string {
  return repPath(target, ".info");
}

/**
 * The `.files` path for a target. Same address, session-listing representation.
 *
 * Capability-carrying like the other three, and for the reason the page exists
 * at all: this document may be a phone that was handed a link, so it holds the
 * session capability and not the server's bearer token, and `/api/stream/:sid`
 * is closed to it.
 */
export function filesPath(target: PlayerTarget): string {
  return repPath(target, ".files");
}

/**
 * Where the bytes for this file should come from.
 *
 * `direct` is the existing `/stream/:sid/:idx` — lossless and free. `card` is
 * the honest fallback. `provider-hls` is a manifest the debrid provider
 * transcoded for us, which costs this machine nothing.
 */
export type Rung = "direct" | "provider-hls" | "card";

/**
 * Which rung of the source ladder to play this on.
 *
 * The order is deliberate: direct play first because it is lossless and costs
 * nothing, then the provider's transcode, then the card. The provider's HLS is a
 * re-encode, so taking it for a file the browser could already play would be a
 * quality loss for no gain — hence it is consulted only once something is
 * actually blocking.
 *
 * `info === null` means the `.info` fetch failed: an offline phone, or a page
 * served by an older build. Falling back to the filename keeps the page working
 * and reproduces exactly what it did before that route existed.
 */
export function chooseSource(
  info: StreamInfoResponse | null,
  filename: string,
): { rung: Rung; reason: FallbackReason | null } {
  const blockers = info ? info.blockers : blockersFor(classifyFromName(filename));
  if (blockers.length === 0) return { rung: "direct", reason: null };
  if (info?.hls) return { rung: "provider-hls", reason: null };
  return { rung: "card", reason: reasonFor(blockers) };
}

// The container is named first when present because it is the blocker a user can
// recognise and act on ("it's an mkv"); a codec name is not.
function reasonFor(blockers: Blocker[]): FallbackReason {
  if (blockers.includes("container")) return "container";
  if (blockers.includes("video")) return "video-codec";
  return "audio-codec";
}

/**
 * How long to wait for a `<video>` that has neither errored nor produced a
 * frame before giving up on it.
 *
 * A stall is the common mkv-in-Chrome outcome and it is *silent*: no `error`
 * event fires, the element simply never reaches `loadeddata`. Without a timer
 * the page sits on a black rectangle forever, which is the exact failure mode
 * this unit exists to avoid. Twelve seconds is long enough for a cold
 * Real-Debrid CDN connection or a torrent still fetching its first pieces, and
 * short enough that nobody sits and wonders.
 */
export const STALL_MS = 12_000;

export type Platform = "ios" | "android" | "macos" | "other";

/**
 * Which VLC hand-off, if any, can work on this device.
 *
 * User-agent sniffing, which is unreliable in general and fine here: the cost
 * of being wrong is a button that does nothing (or a missing button) next to a
 * `.m3u` download that works everywhere. Feature detection is not an option —
 * there is no way to ask a browser whether a URL scheme is registered.
 *
 * Order matters. An iPad running iPadOS 13+ reports itself as "Macintosh", and
 * Android tablets often carry "Linux"; checking the mobile tokens first means
 * both land somewhere that works, and iOS/macOS take the same callback scheme
 * anyway so the iPad ambiguity is harmless either way.
 */
export function detectPlatform(userAgent: string): Platform {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/android/.test(ua)) return "android";
  if (/macintosh|mac os x/.test(ua)) return "macos";
  return "other";
}

export interface ExternalLink {
  /** Stable id for tests and for the DOM binding; never shown. */
  id: "vlc-callback" | "vlc-intent";
  label: string;
  href: string;
}

/**
 * The Android VLC hand-off, or null when the URL cannot be expressed as one.
 *
 * `intent://` re-encodes an http(s) URL as an Android intent: the authority and
 * path go in the body, the original scheme comes back via `scheme=`, and
 * `package=` pins the target app so the user is not shown a chooser containing
 * three browsers.
 *
 * The fragment is a `;`-delimited parameter list terminated by `end`, so a `;`
 * or `#` surviving from the URL would truncate or corrupt it — a capability
 * containing either would otherwise silently produce an intent that opens the
 * wrong thing. `encodeURIComponent` leaves `;` alone, so they are escaped here.
 */
function androidIntent(absolute: string): string | null {
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "http" && scheme !== "https") return null;
  const rest = `${url.host}${url.pathname}${url.search}`.replace(/[;#]/g, (c) =>
    c === ";" ? "%3B" : "%23",
  );
  return `intent://${rest}#Intent;package=org.videolan.vlc;scheme=${scheme};end`;
}

/**
 * The "open in VLC" links that can actually work on this platform.
 *
 * Empty on desktop Windows and Linux, and that is the point: neither has a
 * registered `vlc://`-style scheme, so a button there would be a button that
 * does nothing. Those platforms get the `.m3u` download, which does work, and
 * are not offered a dead control next to it.
 */
export function vlcLinks(absolute: string, platform: Platform): ExternalLink[] {
  if (platform === "ios" || platform === "macos") {
    return [
      {
        id: "vlc-callback",
        label: "Open in VLC",
        href: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(absolute)}`,
      },
    ];
  }
  if (platform === "android") {
    const href = androidIntent(absolute);
    return href ? [{ id: "vlc-intent", label: "Open in VLC", href }] : [];
  }
  return [];
}

/** Why the fallback card is showing. Drives the wording, nothing else. */
export type FallbackReason =
  | "container"
  | "video-codec"
  | "audio-codec"
  | "error"
  | "stall"
  | "no-link";

export function fallbackMessage(reason: FallbackReason, filename: string): string {
  const name = filename || "This file";
  if (reason === "no-link") {
    return "This link is incomplete — reopen the player from the dashboard.";
  }
  if (reason === "container") {
    return `${name} is in a container browsers can't play (most releases are MKV with HEVC or DTS audio). Open it in a real player — the stream itself is fine.`;
  }
  // The two below are only reachable now that the server reports real codecs:
  // before that, a container browsers accept was assumed playable and these
  // files failed at the decoder instead, twelve seconds later.
  if (reason === "video-codec") {
    return `${name} is in a container browsers accept, but its video (HEVC or AV1) is something they can't decode. Open it in a real player — the stream itself is fine.`;
  }
  if (reason === "audio-codec") {
    return `${name} has audio browsers can't decode — usually DTS or TrueHD. Open it in a real player — the stream itself is fine.`;
  }
  if (reason === "error") {
    return `${name} started but this browser can't decode it. Open it in a real player instead.`;
  }
  return `${name} isn't playing here — the browser has taken it but produced nothing. Open it in a real player instead.`;
}

/** Where a failure should be reported: replace the player, or annotate it. */
export type FailureRoute = "card" | "notice";

/**
 * Which of the two a failure goes to, given whether playback ever started.
 *
 * One line, and it lives here rather than in `player.ts` because it decides
 * *what the user sees* — the rule in CLAUDE.md that keeps such conditionals out
 * of the DOM-wiring files where no test can reach them. This one was a bug: the
 * wiring latched a single `settled` flag on the first `playing` event and then
 * dropped every later failure on the floor, so a stream that died mid-playback
 * left a frozen `<video>` and no explanation anywhere.
 *
 * `card` destroys the element, which is right for a file that was never going to
 * play and wrong for one that already did — the user would lose their position
 * to be told something that is not true of what they just watched.
 */
export function routeFailure(started: boolean): FailureRoute {
  return started ? "notice" : "card";
}

/**
 * How long a starved player may sit without advancing before we say so.
 *
 * Distinct from `STALL_MS`, which covers *start-up* — an element that never
 * produced a frame — and is disarmed as soon as one arrives. This one covers the
 * opposite half: playback that ran and then stopped advancing.
 *
 * Thirty seconds, and the number is set by hls.js rather than by taste. Its
 * default `fragLoadPolicy.errorRetry` is 6 attempts with a delay backing off to
 * 8s, so a fragment it can eventually recover can legitimately take upwards of
 * twenty seconds to arrive. Anything shorter would cry stall over a gap that was
 * about to fill itself.
 */
export const PLAYBACK_STALL_MS = 30_000;

/**
 * What to say when playback that had ALREADY STARTED dies partway through.
 *
 * A separate message from `fallbackMessage` because the causes are disjoint and
 * so is the honest wording. The startup card explains why a file was never going
 * to play here ("browsers can't play this container"); by the time this fires the
 * user has watched the thing run, so that explanation would be a plain lie. What
 * actually happened is upstream: a provider transcode that stopped producing
 * segments, or a stream that died mid-flight.
 *
 * Deliberately does NOT name the file. The card is a full replacement for the
 * video and has room; this is a one-line notice sitting under a player the user
 * is still looking at, and they know what they were watching.
 *
 * Both branches point at the `.m3u` and VLC, because those buttons are still on
 * screen and — for the provider-transcode failure this exists for — they are the
 * route that genuinely works: the playlist streams the original file rather than
 * anything the provider had to transcode first.
 */
export function interruptedNotice(reason: FallbackReason): string {
  if (reason === "stall") {
    return "Playback stopped — no more of the stream arrived. Download the .m3u or open it in VLC to carry on watching.";
  }
  return "Playback stopped partway through — the stream failed upstream. Download the .m3u or open it in VLC to carry on watching.";
}
