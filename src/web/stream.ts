// The stream handle: `GET /stream/:sid/:idx?k=<capability>`.
//
// This is the only route in the app that serves media bytes, and the only one
// that authenticates with something other than the bearer token. It lives
// outside `/api/` and outside `handleWebApi` for two reasons: the router's
// contract is "one request in, one complete value out", which a 40 GiB range
// response is not; and everything under `/api/` is behind the bearer token,
// which is exactly the door this route cannot use.
//
// Two backends, one URL shape:
//
// - The debrid provider: a `302` to the unrestricted link. The browser then
//   talks straight to their CDN — native seeking, zero bytes through this
//   process.
// - WebTorrent: a range-forwarding reverse proxy. The backend's own URLs are
//   `http://localhost:<ephemeral>/webtorrent/…`, which is unreachable from the
//   phone on the sofa; proxying them through the port the dashboard is already
//   served on is the whole point.

import http from "node:http";
import https from "node:https";
import { isAuthorized } from "../daemon/auth";
import { streamHandle, toPublicSession } from "./routes";
import { probeUrl } from "../core/probe";
import {
  CHROMECAST_PROFILE,
  blockersFor,
  classifyFromName,
  extensionOf,
  type MediaFacts,
} from "../util/playability";
import type { ProbeCache } from "../core/probeCache";
import type { HlsVerdictCache } from "../core/hlsVerdictCache";
import type { StreamSession, StreamSessionRegistry } from "../core/streamSession";
import { streamCandidates } from "../util/videoFiles";
import { playlistTitle } from "../util/playlistTitle";
import { restPlaylist } from "../util/restPlaylist";
import type { StreamFilesResponse, StreamInfoResponse, SubtitleFile } from "./wire";
import {
  HTTP_AND_HTTPS,
  HTTP_ONLY,
  resolveProxyTarget,
  resolveRedirect,
  type ProxyRefusal,
} from "./proxyTarget";
import {
  isBrowserRenderable,
  subtitleLanguage,
  subtitlesFor,
} from "../util/subtitleFiles";
import { decodeSubtitle, srtToVtt } from "../util/srtToVtt";

/** Diagnostics sink. Same contract as the server's: injected, never `console`. */
export type StreamLog = (message: string) => void;

export interface StreamDeps {
  sessions: StreamSessionRegistry;
  log: StreamLog;
  /**
   * Honour `X-Forwarded-Proto` / `X-Forwarded-Host` when building the absolute
   * URL inside a `.m3u`. **Off unless the operator says otherwise**, because
   * both headers are just request headers: anyone who can reach this port can
   * send them, and trusting them unconditionally means any client can choose
   * the host the playlist points a media player at. Behind a reverse proxy that
   * sets them (and strips client-supplied copies) they are the only way to
   * learn the real external origin, which is why the option exists at all.
   */
  trustProxy?: boolean;
  /**
   * Remembers probe results so a page reload does not re-probe. Optional so a
   * caller that never asks for `.info` need not construct one; absent simply
   * means every `.info` request pays the probe.
   */
  probeCache?: ProbeCache;
  /**
   * Probe one upstream URL for its real container and codecs. Injected so the
   * suite never spawns ffprobe, and so a host without the binary is the default
   * rather than a special case. Returning null is normal.
   */
  probeImpl?: (url: string, container: string) => Promise<MediaFacts | null>;
  /**
   * The debrid provider's own HLS manifest for this file, or null. Left unset
   * until the player page can mount one — wiring it earlier would make a file
   * with a perfectly good manifest show a card claiming it cannot be played.
   */
  resolveHls?: (session: StreamSession, index: number) => Promise<string | null>;
  /**
   * Whether that manifest is one a browser can actually finish watching, rather
   * than merely one that exists. Injected, and absent means "offer whatever
   * `resolveHls` returned" — the behaviour before the provider was measured.
   */
  checkHls?: (manifestUrl: string) => Promise<boolean>;
  /**
   * Remembers the answer above, so a page reload does not pull a second probe
   * segment through this machine. Optional for the same reason `probeCache` is.
   */
  hlsVerdictCache?: HlsVerdictCache;
  /**
   * Proxy debrid media through this server rather than redirecting to the
   * provider. Resolved per request by the caller — this module never loads
   * config, it is handed what it needs.
   */
  proxyDebrid?: boolean;
  /**
   * Read a whole subtitle file from upstream, or null on any failure.
   *
   * Separate from the proxy because this one buffers rather than streams — a
   * subtitle has to be converted before a byte of it can be sent. Injectable so
   * the `.vtt` route is testable without a network; the default implementation
   * goes through the same `resolveProxyTarget` allowlist the proxy does, which
   * is the point of it being here rather than a bare `fetch`.
   */
  fetchSubtitle?: (
    url: string,
    allowed: readonly string[],
    signal?: AbortSignal,
  ) => Promise<Uint8Array | null>;
}
// Note there is deliberately NO injectable HTTP client here. A fake `request`
// cannot show that a Range header survived a socket, that a 206 came back with
// the matching slice, or that an abandoned request closed its connection —
// which is all three of the things this proxy has to get right. The tests stand
// up a real http.Server instead.

const STREAM_BASE = "/stream";

/** True when this path belongs to the stream handle rather than the router. */
export function isStreamPath(urlPath: string): boolean {
  return urlPath === STREAM_BASE || urlPath.startsWith(`${STREAM_BASE}/`);
}

/**
 * `/stream/:sid/:idx` → `{ sid, index }`, or null when the path is not that
 * shape.
 *
 * `idx` is matched as `\d+` and nothing else. That rejects `-1`, `1.5`, `1e3`,
 * `0x0`, `+1`, ` 1`, and the empty string before any of them reaches an array
 * index — `files[Number("-1")]` is `undefined`, which reads as "out of range"
 * and would be answered 404 anyway, but `files["length"]` is not, and a lenient
 * parser here is how an index turns into a property read. A leading zero is
 * allowed (`007` is 7): it is unambiguous and no client constructs one.
 *
 * The sid is decoded, so an id containing a reserved character round-trips
 * through `streamHandle`'s `encodeURIComponent`. It is not otherwise validated:
 * an id no session has is a 404 from the registry lookup, which is the same
 * answer every other unknown id gets.
 */
export function parseStreamPath(urlPath: string): { sid: string; index: number } | null {
  const m = /^\/stream\/([^/]+)\/(\d+)$/.exec(urlPath);
  if (!m) return null;
  let sid: string;
  try {
    sid = decodeURIComponent(m[1]!);
  } catch {
    return null; // a stray "%" is a malformed path, not an id
  }
  if (!sid) return null;
  const index = Number(m[2]);
  // `\d+` can still overflow into a float (twenty digits); a non-integer index
  // must never reach the bounds check.
  if (!Number.isSafeInteger(index)) return null;
  return { sid, index };
}

const PLAYLIST_SUFFIX = ".m3u";
const INFO_SUFFIX = ".info";
const FILES_SUFFIX = ".files";
const SUBTITLE_SUFFIX = ".vtt";

/** Which representation of the stream handle a path is asking for. */
export type StreamRep = "media" | "playlist" | "info" | "files" | "subtitle";

/**
 * Split a trailing `.m3u`, `.info`, `.files` or `.vtt` off a stream path.
 *
 * All are *representations* of the handle, not second resources, so none is a
 * second route: stripping the suffix here means the session lookup, the
 * capability check, the readiness check and the bounds check below are literally
 * the same code for all five. A `.m3u` that skipped the capability would hand
 * out a playable URL to anyone who guessed a session id, a `.info` that skipped
 * it would hand out a filename and codec list, a `.files` that skipped it would
 * hand out every filename in the torrent, and a `.vtt` that skipped it would
 * hand out a subtitle from someone else's session; the only durable way to stop
 * all four is for there to be one guard, not four.
 *
 * Matched with `endsWith` on an exact lowercase suffix, so `.m3u8`, `.INFO`,
 * `.information`, `.profiles` and `.VTT` are all just filenames — a near-miss
 * must fall through to the media branch rather than be helpfully interpreted.
 */
export function splitRepresentation(urlPath: string): { path: string; rep: StreamRep } {
  if (urlPath.endsWith(PLAYLIST_SUFFIX)) {
    return { path: urlPath.slice(0, -PLAYLIST_SUFFIX.length), rep: "playlist" };
  }
  if (urlPath.endsWith(INFO_SUFFIX)) {
    return { path: urlPath.slice(0, -INFO_SUFFIX.length), rep: "info" };
  }
  if (urlPath.endsWith(FILES_SUFFIX)) {
    return { path: urlPath.slice(0, -FILES_SUFFIX.length), rep: "files" };
  }
  if (urlPath.endsWith(SUBTITLE_SUFFIX)) {
    return { path: urlPath.slice(0, -SUBTITLE_SUFFIX.length), rep: "subtitle" };
  }
  return { path: urlPath, rep: "media" };
}

const PLAY_BASE = "/play";

/** True when this path is the player page rather than media or the router. */
export function isPlayPath(urlPath: string): boolean {
  return urlPath === PLAY_BASE || urlPath.startsWith(`${PLAY_BASE}/`);
}

/**
 * `/play/:sid/:idx` → `{ sid, index }`, same grammar as the stream handle.
 *
 * The server only uses this as a shape check before serving a static file: the
 * page itself carries no session data, so there is nothing here to authorise.
 * It is validated anyway so `/play/nonsense` 404s rather than silently serving
 * a player that will never load anything.
 */
export function parsePlayPath(urlPath: string): { sid: string; index: number } | null {
  const m = /^\/play\/([^/]+)\/(\d+)$/.exec(urlPath);
  if (!m) return null;
  let sid: string;
  try {
    sid = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  if (!sid) return null;
  const index = Number(m[2]);
  if (!Number.isSafeInteger(index)) return null;
  return { sid, index };
}

// A Host (or X-Forwarded-Host) this server will build a URL from. Deliberately
// strict: a hostname, an IPv4, or a bracketed IPv6, with an optional port. The
// value lands in a file the OS hands to a media player, so anything that could
// carry a CRLF into the response headers, a slash into the authority, or
// credentials in front of the host is refused rather than sanitised.
const HOST_RE = /^(?:[A-Za-z0-9._-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

// A comma-separated forwarded header lists the *client-most* hop first, and
// every proxy appends. The first entry is the origin the browser actually used.
function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const first = raw.split(",")[0]?.trim();
  return first ? first : undefined;
}

/**
 * The absolute origin (`scheme://host[:port]`) this request arrived on, or null
 * when the headers do not describe one.
 *
 * `Host` is the only source when `trustProxy` is off, and `http` the only
 * scheme — this server never terminates TLS itself, so claiming `https` would
 * be a guess. With `trustProxy` on, `X-Forwarded-Proto` and `X-Forwarded-Host`
 * win, which is the whole point of the option and also exactly why it is off by
 * default: those headers come from the client unless a proxy overwrites them.
 *
 * Null (rather than a fabricated default) when `Host` is missing or malformed.
 * An HTTP/1.1 request without a Host is already invalid, and inventing
 * `localhost` here would produce a playlist that silently plays on the machine
 * running the daemon and nowhere else.
 */
export function requestOrigin(
  headers: http.IncomingHttpHeaders,
  trustProxy: boolean,
): string | null {
  const forwardedHost = trustProxy ? firstHeader(headers["x-forwarded-host"]) : undefined;
  const host = forwardedHost ?? firstHeader(headers.host);
  if (!host || !HOST_RE.test(host)) return null;
  const forwardedProto = trustProxy ? firstHeader(headers["x-forwarded-proto"]) : undefined;
  const proto = forwardedProto?.toLowerCase() === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

/**
 * A `Content-Disposition` filename for the playlist, derived from the media
 * file's own name.
 *
 * The input is attacker-controlled — it comes from a torrent, i.e. from
 * whoever made the torrent — and it is about to be interpolated into a response
 * header and then written to the user's disk by their browser. So this is a
 * whitelist, not an escape: everything outside `[A-Za-z0-9._-]` collapses to
 * `_`, which removes quotes, CR, LF, path separators and every non-ASCII byte
 * in one rule. A leading dot is stripped so the download cannot land as a
 * hidden file, and the whole thing is length-capped for filesystems that care.
 */
export function playlistFilename(mediaFilename: string): string {
  const base = mediaFilename.replace(/\.[^.]{1,10}$/, "");
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 80);
  return `${safe || "stream"}.m3u`;
}

// Local, because importing the server's copy would make the dependency circular
// (server.ts mounts this module).
function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

// Headers copied from the upstream response. Exactly the set a media element
// needs to seek: everything else (Date, Connection, whatever the backend adds)
// is this proxy's business, not the client's.
const PASS_THROUGH = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

/**
 * The most a subtitle may be. A two-hour SRT is tens of kilobytes; four MiB is
 * far past any real one. This route reads the whole body into memory to convert
 * it, so without a cap a caller could aim it at a video file — the extension
 * check below is the first guard against that and this is the second.
 */
export const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;

/**
 * How long `defaultFetchSubtitle` waits for upstream before giving up. A sibling
 * `.srt`/`.vtt` on WebTorrent can be a piece that has not arrived yet, in which
 * case the connection is opened and simply never answers — without a bound the
 * promise (and its socket) would live for the rest of the process. Generous
 * relative to `MAX_SUBTITLE_BYTES`: a subtitle is at most a few MiB, so anything
 * still incomplete after this long is stalled, not slow.
 */
export const SUBTITLE_FETCH_TIMEOUT_MS = 15_000;

/**
 * The sibling subtitle files for one video, as the wire type.
 *
 * Server-side because only the server holds the whole file list with its
 * indexes — `toPublicSession` exposes them, but the `.info` response is where
 * the player page reads them from, and doing it here means the browser never
 * has to re-run the matcher.
 */
function subtitleFilesFor(session: StreamSession, index: number): SubtitleFile[] {
  const video = session.files[index];
  if (!video) return [];
  const withIndex = session.files.map((f, i) => ({ ...f, index: i }));
  return subtitlesFor(withIndex[index]!, withIndex).map((s) => {
    const { code, label } = subtitleLanguage(s.filename);
    return {
      index: s.index,
      filename: s.filename,
      language: code,
      label,
      renderable: isBrowserRenderable(s.filename),
    };
  });
}

// The same split the media branch makes: a debrid link is https, a WebTorrent
// file is served from this machine over http.
function backendProtocols(session: StreamSession): readonly string[] {
  return session.backend === "debrid" ? HTTP_AND_HTTPS : HTTP_ONLY;
}

/**
 * What one file in a session actually is, and the best source available for it.
 *
 * Extracted from the `.info` branch when casting needed the same answer. It must
 * stay one implementation: two would be the copy-then-drift bug this codebase
 * has recorded four times, and this particular pair would drift into the browser
 * and a television disagreeing about the same file.
 *
 * `facts` are the *decoder-agnostic* truth about the media. Which blockers they
 * imply is the caller's question, because a browser and a Chromecast answer it
 * differently (`blockersFor`, `src/util/playability.ts`).
 */
export interface MediaSource {
  facts: MediaFacts;
  /** A provider HLS manifest, verified usable, or null. */
  hls: string | null;
}

export async function mediaSourceFor(
  deps: StreamDeps,
  session: StreamSession,
  index: number,
): Promise<MediaSource> {
  const file = session.files[index]!;
  const container = extensionOf(file.filename);
  let facts = deps.probeCache?.get(session.id, index);
  if (!facts) {
    // Only probe a file we would otherwise refuse.
    //
    // A probe is a spawn plus a network round trip against a CDN or a
    // half-downloaded torrent, and it is bounded at 15s. Paying that on every
    // player page load — including for the mp4 that was going to play
    // instantly — to catch the uncommon mp4-carrying-HEVC would make the common
    // path markedly slower in order to serve the rare one. So the name decides
    // first, and the probe runs only when the name says this needs more than
    // direct play, where the accurate answer is what picks the rung.
    //
    // The cost of this order: an mp4 whose HEVC the name does not mention still
    // gets optimism, a decode error and the fallback card — the same as before
    // this route existed, and one tap from working. That is the trade.
    //
    // The BROWSER profile decides whether to probe, deliberately, even though a
    // cast asks about a Chromecast: probing is a cost, the browser profile is the
    // stricter of the two, and a file it would refuse is exactly the set worth
    // spending a probe on. A file only the Chromecast profile refuses (HEVC in an
    // mp4 that the name declares) is already named by `classifyFromName`.
    //
    // `session.name` is the release the file came from. A debrid provider often
    // renames the file itself ("1.mkv"), so the release name is the richer codec
    // signal and the server is the only place that has both.
    const fromName = classifyFromName(file.filename, session.name);
    if (blockersFor(fromName).length === 0) {
      facts = fromName;
    } else {
      const probe = deps.probeImpl ?? ((url: string, c: string) => probeUrl(url, c));
      // A probe failure is not an error: classifyFromName is always available.
      facts = (await probe(file.url, container)) ?? fromName;
    }
    deps.probeCache?.set(session.id, index, facts);
  }
  // Rung 2 is the provider's own manifest, which the client fetches from the
  // provider directly. That is the whole point of it — and the exact thing
  // relaying exists to stop, so the two features have to agree: while relaying,
  // no URL handed to a player may point at the provider. Offering it anyway
  // would route the containers a browser cannot demux — the ones most likely to
  // be a big remux — around the relay the user asked for, and show the provider
  // the viewer's address. The ladder falls to a direct play through this handle
  // instead.
  const resolved =
    deps.resolveHls && deps.proxyDebrid !== true ? await deps.resolveHls(session, index) : null;
  // A manifest existing is not the same as a manifest working. Measured against
  // Real-Debrid: for 1080p HEVC its transcoder runs at 0.65x realtime and serves
  // the segments it has not finished as complete 200s with a Content-Length
  // matching a truncated body — so the client cannot tell, and playback freezes a
  // few seconds in with no error event to react to. See `hlsHealth.ts` for the
  // measurements.
  //
  // So the rung is offered only when a segment past the transcoder's opening
  // burst comes back whole. The check is skipped entirely when nothing injected
  // one, which keeps a caller that has not wired it on the previous behaviour
  // rather than silently dropping every manifest.
  let hls = resolved;
  if (resolved !== null && deps.checkHls) {
    const remembered = deps.hlsVerdictCache?.get(session.id, index);
    const usable = remembered ?? (await deps.checkHls(resolved));
    deps.hlsVerdictCache?.set(session.id, index, usable);
    if (!usable) {
      // The verdict, never the URL: a transcode manifest is an unguessable URL
      // minted for one file, i.e. a capability, and belongs in a log line no more
      // than an unrestricted link does.
      deps.log("stream: provider transcode is not keeping up; not offering HLS");
      hls = null;
    }
  }
  return { facts, hls };
}

/**
 * Serve one stream request. Writes the response itself — this route owns its
 * socket, unlike everything in `routes.ts`.
 *
 * Returns the status written, so the caller logs what actually happened rather
 * than what was intended. The caller must log the *path* only: an unrestricted
 * link from the debrid provider is a credential against the user's account and
 * must never reach a log line, and the query string carries the capability.
 */
export async function handleStreamRequest(
  deps: StreamDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  query: URLSearchParams,
): Promise<number> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    writeJson(res, 405, { error: "method not allowed" });
    return 405;
  }

  const { path: handlePath, rep } = splitRepresentation(urlPath);
  const parsed = parseStreamPath(handlePath);
  if (!parsed) {
    writeJson(res, 404, { error: "not found" });
    return 404;
  }

  const session = deps.sessions.get(parsed.sid);
  // Unknown id is a 404 before the capability is looked at, because there is no
  // capability to compare against yet. That does make this an existence oracle
  // for session ids — 404 vs 401 — which is acceptable only because ids are
  // random UUIDs and the 401 branch leaks nothing further.
  if (!session) {
    writeJson(res, 404, { error: "unknown session" });
    return 404;
  }

  // The capability, and ONLY this session's capability. `isAuthorized` is
  // reused rather than `===` for its constant-time compare, and because a
  // second hand-rolled token comparison in this codebase is a second place to
  // get it wrong. Note the empty-capability guard: `isAuthorized` treats a
  // falsy expected token as "no auth configured" and returns true, which is
  // right for the server-wide token and catastrophic here.
  const k = query.get("k");
  if (!session.capability || !isAuthorized(session.capability, k ? `Bearer ${k}` : undefined)) {
    writeJson(res, 401, { error: "unauthorized" });
    return 401;
  }

  // A session still resolving has no files and an errored one never will. Both
  // are 404 rather than 409/500: the handle simply does not address anything
  // yet, and a <video> element does nothing useful with a status either way.
  if (session.state !== "ready") {
    writeJson(res, 404, { error: "session not ready" });
    return 404;
  }

  const file = session.files[parsed.index];
  if (!file) {
    writeJson(res, 404, { error: "unknown file" });
    return 404;
  }

  // The `.files`: what else is in this session, so the player page can offer
  // the next episode instead of being a dead end. Same position as `.info` and
  // the playlist — after every guard, before the backend split — because the
  // answer is about the session, not about who is serving its bytes.
  //
  // `toPublicSession` does the mapping, not a local loop: it is the one place
  // that swaps a file's upstream URL (a Real-Debrid credential, or an
  // unreachable localhost address) for a `/stream/:sid/:idx` handle, and it
  // builds by picking fields so a field added to `StreamSession` later stays
  // private by default. A second mapping here would inherit neither property.
  //
  // `streamCandidates` filters to the video files — the same rule the picker
  // uses, so the two lists cannot disagree about what is in a torrent — and it
  // falls back to every file when nothing looks like video, because a release
  // that ships one unrecognised container is still worth handing to VLC.
  if (rep === "files") {
    const body: StreamFilesResponse = {
      name: session.name,
      infoHash: session.infoHash,
      files: streamCandidates(toPublicSession(session).files),
    };
    writeJson(res, 200, body);
    return 200;
  }

  // The `.info`: what this file is, and how the player page should try to play
  // it. Same position as the playlist below — after every guard, before the
  // backend split — because the answer is about the media, not about which
  // backend happens to be serving it.
  if (rep === "info") {
    const { facts, hls } = await mediaSourceFor(deps, session, parsed.index);
    const body: StreamInfoResponse = {
      facts,
      blockers: blockersFor(facts),
      castBlockers: blockersFor(facts, CHROMECAST_PROFILE),
      hls,
      subtitles: {
        embedded: facts.subtitles,
        files: subtitleFilesFor(session, parsed.index),
      },
    };
    // Note what is NOT in that body: `file.url`. That is a debrid unrestricted
    // link, i.e. a credential against the user's account. The page plays through
    // this handle and never learns where the bytes come from.
    writeJson(res, 200, body);
    return 200;
  }

  // The `.vtt`: a sibling subtitle file, converted for a <track>.
  //
  // Two guards this representation needs that the others do not. The extension
  // check keeps it from being a general-purpose "read a whole file into memory
  // and call it text" route aimed at a 12 GB video, and the size cap is the
  // second line of that same defence.
  //
  // `isBrowserRenderable`, not `isSubtitleFilename`: this route always runs the
  // source through `srtToVtt` and answers `text/vtt`, so it must only ever
  // accept something that conversion can honestly produce. `isSubtitleFilename`
  // also passes `.ass`/`.ssa`/`.sub`, which would come back as `WEBVTT` followed
  // by raw ASS markup — neither valid WebVTT nor valid ASS. The two callers
  // (`subtitleFilesFor`'s `.m3u` filter above and `subtitleTracks` in
  // `subtitleModel.ts`) already filter to renderable files before reaching here;
  // this guard is what makes that belt-and-braces rather than the only defence.
  if (rep === "subtitle") {
    if (!isBrowserRenderable(file.filename)) {
      writeJson(res, 404, { error: "not a subtitle" });
      return 404;
    }
    if (file.bytes > MAX_SUBTITLE_BYTES) {
      writeJson(res, 413, { error: "subtitle too large" });
      return 413;
    }
    const fetchSubtitle = deps.fetchSubtitle ?? defaultFetchSubtitle;
    // This route buffers before it can answer at all, so — unlike proxyUpstream,
    // which has already written headers by the time a client goes away — there
    // is nothing yet to distinguish "our own end" from "abandoned": any close
    // this early is the client leaving, so it always aborts the fetch. The
    // listener is removed the moment the fetch settles, so a close after that
    // (the normal end of a completed request) finds nothing to abort.
    const controller = new AbortController();
    const onClientClose = (): void => controller.abort();
    res.on("close", onClientClose);
    const fetched = await fetchSubtitle(file.url, backendProtocols(session), controller.signal);
    res.off("close", onClientClose);
    if (!fetched) {
      // Same status and the same silence about the URL as proxyUpstream: an
      // unrestricted link is a credential against the user's account.
      deps.log("stream: could not fetch subtitle upstream");
      writeJson(res, 502, { error: "bad upstream" });
      return 502;
    }
    const payload = Buffer.from(srtToVtt(decodeSubtitle(fetched)), "utf8");
    res.writeHead(200, {
      "Content-Type": "text/vtt; charset=utf-8",
      "Content-Length": String(payload.length),
      // Same reason as the playlist: the URL that produced this carries a
      // capability for a session that will be reaped.
      "Cache-Control": "no-store",
      // A Chromecast's receiver runs on an HTTPS origin of Google's and fetches
      // sidecar tracks cross-origin; without this it drops the track SILENTLY,
      // which reads to the user as "casting ignores subtitles". ONLY this
      // representation gets it — the media handle must not, and a test pins that.
      // It is safe here because `?k=` has already authorised the request: the
      // header widens who may READ the response, not who may make it.
      "Access-Control-Allow-Origin": "*",
    });
    if (method !== "HEAD") res.end(payload);
    else res.end();
    return 200;
  }

  // The `.m3u`, and note where it sits: after every guard above, and *before*
  // the backend split. A debrid-backed session's playlist points at this
  // handle, not at the unrestricted link — the redirect happens when the
  // player follows it, so the credential never lands in a file on the user's
  // disk.
  //
  // This route exists because there is no registered desktop `vlc://` scheme to
  // link to. A three-line file with the right content type is the only thing
  // that reliably opens the user's default media player on Windows, macOS and
  // Linux alike.
  if (rep === "playlist") {
    const origin = requestOrigin(req.headers, deps.trustProxy === true);
    if (!origin) {
      // Not a 404: the request addressed a real file, we just cannot name it
      // absolutely, and a relative URL in an .m3u is meaningless once the file
      // has been handed to another application.
      deps.log("stream: cannot build a playlist without a usable Host header");
      writeJson(res, 400, { error: "bad host" });
      return 400;
    }
    // `streamHandle`, not the request's own path: the canonical handle for this
    // session, so nothing a client put in the URL is reflected into the body.
    // The capability is re-encoded from the value that just passed the auth
    // check — omit it and the playlist is a 401 in whatever player opens it.
    // NOTE, so nobody re-adds it: there is deliberately no
    // #EXTVLCOPT:input-slave line here for a matched subtitle. Measured
    // against a real VLC 3.0.11 — `input-slave` is on VLC's unsafe-option
    // list and is refused outright inside a `.m3u` ("unsafe option
    // \"input-slave\" has been ignored for security reasons"), precisely so a
    // downloaded playlist cannot make the player open arbitrary resources.
    // VLC users get a separate subtitle download link on the player page
    // instead; `subtitleArgs` in src/util/subtitleFlags.ts gives VLC no flag
    // for the same reason.
    const handleUrl = (index: number): string =>
      `${origin}${streamHandle(parsed.sid, index)}?k=${encodeURIComponent(k!)}`;

    // `?rest=1` — this file and the rest of its season, so a season plays
    // unattended rather than one download per episode. A PARAMETER on the
    // existing representation rather than a route of its own: the guards above,
    // the origin check, and the body rules below all apply unchanged, and a
    // second playlist route would be a second place to forget one of them.
    //
    // WHICH files that is, is `restPlaylist` in `src/util/`, not a rule written
    // here: the player page needs the same answer to word its button — "rest of
    // season" is a promise, and it was being made for playlists that were
    // nothing of the kind — and two copies of one rule is the copy-then-drift
    // bug this codebase has recorded four times.
    const wantsRest = (query.get("rest") ?? "") === "1";
    const indexes = wantsRest
      ? restPlaylist(
          session.files.map((f, index) => ({ ...f, index })),
          parsed.index,
        ).indexes
      : [parsed.index];

    // `#EXTINF` titles, and note what makes them safe rather than what makes
    // them nice: a filename comes from whoever made the torrent, and this file
    // is parsed line by line by another application. `playlistTitle` strips CR,
    // LF and every control character, so a name cannot ADD an entry pointing
    // wherever its author liked, and it can never return "" — an `#EXTINF:-1,`
    // with nothing after the comma is worse than no title. Without them a
    // thirteen-episode playlist is thirteen indistinguishable URLs.
    //
    // The URLs are still built from `streamHandle` and the request's own origin,
    // so nothing a client put in the path is reflected into the body, and
    // `file.url` — a debrid credential — appears nowhere in it.
    const entries = indexes.map(
      (index) => `#EXTINF:-1,${playlistTitle(session.files[index]?.filename ?? "")}\n${handleUrl(index)}`,
    );
    const body = `#EXTM3U\n${entries.join("\n")}\n`;
    res.writeHead(200, {
      // The content type is what makes the browser hand the file to the OS
      // instead of rendering it. text/plain and octet-stream both end with the
      // URL displayed in a tab, which is precisely the failure this route
      // exists to avoid.
      "Content-Type": "audio/x-mpegurl",
      "Content-Disposition": `attachment; filename="${playlistFilename(file.filename)}"`,
      "Content-Length": String(Buffer.byteLength(body)),
      // The URL inside carries a capability for a session that will be reaped.
      "Cache-Control": "no-store",
    });
    // Node drops the body itself for a HEAD response, so the Content-Length
    // above stays correct and this needs no HEAD branch.
    res.end(body);
    return 200;
  }

  if (session.backend === "debrid") {
    if (deps.proxyDebrid === true) {
      // HTTP_AND_HTTPS: a provider CDN is https, and this is the only call site
      // allowed to reach one.
      return proxyUpstream(deps, req, res, file.url, { allowedProtocols: HTTP_AND_HTTPS });
    }
    // 302, not 307: the method is GET/HEAD either way, and 302 is what every
    // player (and every home-router HTTP client) handles without argument.
    // `Cache-Control: no-store` because an unrestricted link is time-limited
    // and account-bound — a cached redirect outlives the link it points at.
    res.writeHead(302, { Location: file.url, "Cache-Control": "no-store", "Content-Length": "0" });
    res.end();
    return 302;
  }

  // HTTP_ONLY, deliberately: the WebTorrent backend serves plain http on
  // loopback and nothing else, and widening it here would widen it for a
  // backend whose URLs this process constructs rather than receives.
  return proxyUpstream(deps, req, res, file.url, { allowedProtocols: HTTP_ONLY });
}

// How many requests this proxy may make for one client request — the original
// plus MAX_PROXY_HOPS - 1 followed redirects, so 3 means 2 followed redirects.
// That is enough for the "unrestrict → CDN region → node" shape seen in
// practice, because the "unrestrict" step itself is an API call rather than an
// HTTP hop this proxy follows — and small enough that a loop costs three
// requests rather than a hang.
const MAX_PROXY_HOPS = 3;

export interface ProxyOptions {
  /**
   * Which URL schemes this call may reach. REQUIRED rather than defaulted, so a
   * future caller cannot get the permissive set by forgetting the argument.
   * `HTTP_ONLY` for the WebTorrent backend, `HTTP_AND_HTTPS` for a debrid CDN.
   */
  allowedProtocols: readonly string[];
}

/**
 * Reverse-proxy one request to an upstream.
 *
 * Resolves once the response is on its way (headers written, body piping) or has
 * failed — not when the body finishes. The caller only needs the status.
 *
 * Two things this does beyond a single request: it refuses any scheme outside
 * `opts.allowedProtocols`, and it follows up to MAX_PROXY_HOPS - 1 (2) redirects
 * — MAX_PROXY_HOPS requests in total — because `http.request` does not and a
 * debrid download URL can 302 to a CDN node.
 */
function proxyUpstream(
  deps: StreamDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: string,
  opts: ProxyOptions,
): Promise<number> {
  const first = resolveProxyTarget(target, opts.allowedProtocols, MAX_PROXY_HOPS);
  if (!first.ok) {
    // The reason, never the URL: an unrestricted link is a credential. The
    // refused scheme is named because it is the one part of a URL that
    // carries no secret, and the only thing that makes this line actionable.
    let scheme = "";
    if (first.reason === "scheme") {
      try {
        scheme = ` ${new URL(target).protocol}`;
      } catch {
        // Unreachable: a "scheme" refusal means resolveProxyTarget parsed it.
      }
    }
    deps.log(`stream: refusing upstream (${first.reason})${scheme}`);
    writeJson(res, 502, { error: "bad upstream" });
    return Promise.resolve(502);
  }

  const headers: http.OutgoingHttpHeaders = {};
  // The Range header is the entire reason this proxy is not a redirect: drop it
  // and every seek restarts the file from byte zero, and a browser that asked
  // for `bytes=0-` gets a 200 it cannot scrub. It is re-sent on every hop for
  // the same reason.
  const range = req.headers.range;
  if (range !== undefined) headers.Range = range;
  // Passed through so a backend that answers 304 can; harmless otherwise.
  if (req.headers["if-range"] !== undefined) headers["If-Range"] = req.headers["if-range"];

  return new Promise<number>((resolve) => {
    let settled = false;
    const done = (status: number): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    // Which request the teardown below must destroy. Reassigned on each hop,
    // because destroying the first one after a redirect would leak the second.
    let current: http.ClientRequest | null = null;

    const fail = (reason: ProxyRefusal | "socket", scheme = ""): void => {
      deps.log(`stream: upstream failed (${reason})${scheme}`);
      if (settled || res.headersSent || res.writableEnded || res.destroyed) {
        res.destroy();
        done(502);
        return;
      }
      writeJson(res, 502, { error: "bad upstream" });
      done(502);
    };

    const send = (url: URL, hopsRemaining: number): void => {
      const transport = url.protocol === "https:" ? https : http;
      const upstream = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: req.method === "HEAD" ? "HEAD" : "GET",
          headers,
          // No keep-alive: this proxy's client is a media element that abandons
          // requests constantly, and a pooled socket outliving an aborted
          // request is precisely the leak the teardown below exists to prevent.
          agent: false,
        },
        (up) => {
          const status = up.statusCode ?? 502;
          const location = up.headers.location;
          if (status >= 300 && status < 400 && typeof location === "string") {
            // Drain rather than destroy: a redirect body is small and reading it
            // lets the socket close cleanly instead of resetting.
            up.resume();
            // A hop we have already read the Location out of has nothing left to
            // say, but its socket can still die while the next hop is in flight
            // — and an unhandled `error` on a stream is a process exit, not a
            // 502. The stale-hop guard below covers the request; this covers the
            // response.
            up.on("error", () => {});
            const next = resolveRedirect(location, url, opts.allowedProtocols, hopsRemaining - 1);
            if (!next.ok) {
              // Same reasoning as the initial refusal above: the scheme carries
              // no secret, and naming it here too is what makes a redirect
              // refusal actionable instead of just a bare category.
              let scheme = "";
              if (next.reason === "scheme") {
                try {
                  scheme = ` ${new URL(location, url).protocol}`;
                } catch {
                  // Unreachable: a "scheme" refusal means resolveRedirect parsed it.
                }
              }
              fail(next.reason, scheme);
              return;
            }
            send(next.url, hopsRemaining - 1);
            return;
          }

          const out: http.OutgoingHttpHeaders = {};
          for (const name of PASS_THROUGH) {
            const value = up.headers[name];
            if (value !== undefined) out[name] = value;
          }
          // A redirect chain means more than one hop's response can arrive:
          // a stale hop that already failed (or a hop whose response we
          // already used) must not writeHead a second time on top of one
          // that already answered.
          if (settled || res.headersSent) {
            up.resume();
            return;
          }
          // The upstream's status, never a hardcoded 200: a 206 answered as 200
          // tells the client its Range was ignored, and a player that asked for
          // the middle of a file will treat the bytes it gets as the start.
          res.writeHead(status, out);
          done(status);
          up.pipe(res);
          // A mid-body upstream failure cannot become a status code; all that is
          // left is to cut the client off so it sees a truncated body rather
          // than a hang.
          up.on("error", () => res.destroy());
        },
      );
      current = upstream;

      upstream.on("error", () => {
        // A redirect chain means more than one request can be in flight or
        // dying at once: a socket this hop replaced (its own redirect already
        // sent us on to the next hop) errors out from under it, and that
        // stale error must not fail a request nobody is waiting on any more.
        if (upstream !== current) return;
        // Nothing can be said to a client that is already gone or already
        // answered. This branch also covers the ordinary teardown case, where
        // the destroy below is *why* the request errored.
        fail("socket");
      });
      upstream.end();
    };

    // The teardown. A user scrubbing a timeline fires and abandons range
    // requests by the dozen; without this each one leaves a socket to the
    // upstream (and the piece requests behind it) alive with nobody reading.
    // `close` fires for both a client disconnect and our own end, so
    // `writableEnded` is what tells them apart: only the abandoned case needs
    // the upstream destroyed.
    res.on("close", () => {
      if (!res.writableEnded) current?.destroy();
    });

    send(first.url, MAX_PROXY_HOPS);
  });
}

/**
 * The default `StreamDeps.fetchSubtitle`: read a whole subtitle body from
 * upstream through the same allowlist and redirect handling `proxyUpstream`
 * uses, buffered rather than piped because the bytes must be fully in hand
 * before `srtToVtt` can run.
 *
 * Enforces `MAX_SUBTITLE_BYTES` against what upstream actually SENDS, not just
 * what it claimed — the response is destroyed the moment the buffered total
 * would exceed the cap, which is the second half of that guard (`file.bytes` in
 * the caller is the first, and it is only what upstream claimed).
 *
 * Two teardowns, matching `proxyUpstream`'s shape rather than inventing a
 * second one: a `SUBTITLE_FETCH_TIMEOUT_MS` timer for the case webtorrent just
 * never answers (a sibling `.srt` whose pieces have not arrived yet holds the
 * connection open indefinitely), and `signal` for the caller's own
 * client-disconnect teardown. Either one destroys the in-flight request and
 * resolves null, exactly like any other upstream failure.
 */
function defaultFetchSubtitle(
  target: string,
  allowedProtocols: readonly string[],
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const first = resolveProxyTarget(target, allowedProtocols, MAX_PROXY_HOPS);
  if (!first.ok) return Promise.resolve(null);

  return new Promise<Uint8Array | null>((resolve) => {
    let settled = false;
    let current: http.ClientRequest | null = null;
    const done = (value: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      current?.destroy();
      done(null);
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      current?.destroy();
      done(null);
    }, SUBTITLE_FETCH_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort);

    const send = (url: URL, hopsRemaining: number): void => {
      const transport = url.protocol === "https:" ? https : http;
      const upstream = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          agent: false,
        },
        (up) => {
          const status = up.statusCode ?? 502;
          const location = up.headers.location;
          if (status >= 300 && status < 400 && typeof location === "string") {
            up.resume();
            up.on("error", () => {});
            const next = resolveRedirect(location, url, allowedProtocols, hopsRemaining - 1);
            if (!next.ok) {
              done(null);
              return;
            }
            send(next.url, hopsRemaining - 1);
            return;
          }
          if (status < 200 || status >= 300) {
            up.resume();
            done(null);
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          up.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_SUBTITLE_BYTES) {
              // What upstream actually sent, not what it claimed in
              // Content-Length. The caller has already checked `file.bytes`;
              // this is the check against the body itself.
              up.destroy();
              done(null);
              return;
            }
            chunks.push(chunk);
          });
          up.on("end", () => {
            if (!settled) done(new Uint8Array(Buffer.concat(chunks)));
          });
          up.on("error", () => done(null));
        },
      );
      current = upstream;
      upstream.on("error", () => {
        if (upstream !== current) return;
        done(null);
      });
      upstream.end();
    };

    send(first.url, MAX_PROXY_HOPS);
  });
}
