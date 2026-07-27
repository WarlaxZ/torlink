// Pure decision logic for the player page. Kept separate from the DOM binding
// in player.ts for the same reason dashboard.ts is separate from app.ts: there
// is no headless-browser test environment in this repo, and adding one for a
// page this small would be disproportionate — so everything with a decision in
// it lives here, where a plain unit test can reach it, and player.ts is left as
// wiring that reads end to end.
//
// Bundled for the browser: no node:* imports, and nothing from outside this
// directory except types. `URL` and `URLSearchParams` are globals in both
// runtimes, so they are fair game and are what parses the intent target below.

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
 * The stream handle path for a target: `/stream/:sid/:idx?k=…`.
 *
 * Mirrors `streamHandle` in ../routes.ts — the same encodeURIComponent, for the
 * same reason. A session id with a slash in it must not become a different
 * path here than the one the server will parse.
 */
export function streamPath(target: PlayerTarget): string {
  const base = `/stream/${encodeURIComponent(target.sid)}/${target.index}`;
  return target.capability ? `${base}?k=${encodeURIComponent(target.capability)}` : base;
}

/** The `.m3u` path for a target. Same address, playlist representation. */
export function playlistPath(target: PlayerTarget): string {
  const base = `/stream/${encodeURIComponent(target.sid)}/${target.index}.m3u`;
  return target.capability ? `${base}?k=${encodeURIComponent(target.capability)}` : base;
}

/** Resolve one of the paths above against the page's own origin. */
export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/** Lowercase extension without the dot, or "" when there isn't a usable one. */
export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filename);
  return m ? m[1]!.toLowerCase() : "";
}

/**
 * Containers a browser has a real chance with. Everything else gets the
 * fallback card instead of a `<video>`.
 *
 * This list is short on purpose and is about the *container*, which is all a
 * filename can tell us. mp4/m4v/webm are the two containers every browser
 * demuxes; mkv is not one of them in any shipping browser, and mkv is what most
 * of the scene ships. Nor is a container a guarantee — an mp4 carrying HEVC or
 * DTS fails at the decoder — which is why the extension only picks the *initial*
 * optimism and the `error`/stall path still has to exist.
 *
 * An empty or unknown extension is pessimistic: showing the card is honest and
 * takes one tap to work around, where showing a black rectangle that never
 * plays looks like the app is broken.
 */
const DIRECT_PLAY_CONTAINERS = new Set(["mp4", "m4v", "webm"]);

export function canDirectPlay(filename: string): boolean {
  return DIRECT_PLAY_CONTAINERS.has(extensionOf(filename));
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
export type FallbackReason = "container" | "error" | "stall" | "no-link";

export function fallbackMessage(reason: FallbackReason, filename: string): string {
  const name = filename || "This file";
  if (reason === "no-link") {
    return "This link is incomplete — reopen the player from the dashboard.";
  }
  if (reason === "container") {
    return `${name} is in a container browsers can't play (most releases are MKV with HEVC or DTS audio). Open it in a real player — the stream itself is fine.`;
  }
  if (reason === "error") {
    return `${name} started but this browser can't decode it. Open it in a real player instead.`;
  }
  return `${name} isn't playing here — the browser has taken it but produced nothing. Open it in a real player instead.`;
}
