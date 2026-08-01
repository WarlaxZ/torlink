import { handleApi } from "../daemon/serve";
import { isAuthorized } from "../daemon/auth";
import { getPoster, POSTER_HOSTS, type CachedPoster } from "../core/posterCache";
import type { StreamSession } from "../core/streamSession";
import { classifyStreamRoute, type StreamRoute } from "../core/streamRoute";
import { discover, parseManualDevice, type CastDevice } from "../core/cast/discover";
import { CastError } from "../core/cast/connection";
import type { MediaSource } from "./stream";
import {
  historyItemFor,
  loadStreamHistory,
  nextEpisode,
  recordPlayedFile,
  recordStream,
  removeStreamHistory,
  saveStreamHistory,
  type StreamHistoryItem,
} from "../core/streamHistory";
import {
  loadConfig,
  resolveActiveDebrid,
  qualityPrefsFrom,
  resolveAdultContent,
  resolveOmdbApiKey,
  resolveReccConfig,
  sanitiseQualityPrefs,
  saveConfig,
  type Config,
  type FavouriteItem,
} from "../config/config";
import {
  fetchRecommendations,
  fetchTitleSuggestions,
  postEvent,
  type FetchRecommendationsResult,
  type FetchTitleSuggestionsResult,
  type ReccClientConfig,
  type ReccEvent,
  type ReccEventType,
  type RecommendationQuery,
} from "../recc/client";
import { getDebridProvider } from "../integrations/debrid";
import type { DebridProviderId, DebridStatus } from "../integrations/debrid/types";
import { buildMagnet, isInfoHash, normalizeInfoHash, parseInput } from "../sources/magnet";
import {
  isFavourited,
  markWatched,
  removeFavourite as removeFromFavourites,
  toggleFavourite as toggleInFavourites,
} from "../util/favouriteList";
import { enabledSources, sourcesByGroup, SOURCES } from "../sources/registry";
import { isSkipped, sourceHealth, type Health } from "../sources/sourceHealth";
import { blankPerSource, runSearch, type SearchImpl, type SearchSnapshot } from "../core/search";
import { cachedHashesFor } from "../core/cachedHashes";
import {
  fetchTitleMeta,
  fetchTitleMetaByName,
  type FetchTitleMetaResult,
  type OmdbType,
} from "../recc/omdb";
import { openSseChannel, type SseWrite } from "./sse";
import type { Source, SourceGroup, SourceId, TorrentResult } from "../sources/types";
import { addInput, type AddInputOptions, type Runtime } from "../daemon/runtime";
import { hintForGroup, parseRelease } from "../util/release";
import { shouldQuery, SUGGEST_LIMIT } from "../util/titleSuggest";
import { streamCandidates } from "../util/videoFiles";
import { toggleSavedSearches } from "../util/savedSearchList";
import {
  CHROMECAST_PROFILE,
  blockersFor,
  castContentType,
  classifyFromName,
  extensionOf,
  type Blocker,
} from "../util/playability";
import { isBrowserRenderable, subtitleLanguage } from "../util/subtitleFiles";
import { playlistTitle } from "../util/playlistTitle";
import type {
  AddResponse,
  CachedResponse,
  CastDevicesResponse,
  CastStatusResponse,
  PublicCastDevice,
  ContinueWatchingResponse,
  LibraryResponse,
  PreferencesResponse,
  PublicFavourite,
  PublicQualityPrefs,
  PublicSearchResult,
  PublicTitleParse,
  PublicSearchSnapshot,
  PublicSource,
  PublicStreamFile,
  PublicStreamHistoryItem,
  PublicReccEventAck,
  PublicReccEventType,
  PublicRecommendations,
  PublicStreamSession,
  PublicTitleMeta,
  PublicTitleSuggestions,
  SavedResponse,
  SourcesResponse,
  StartStreamResponse,
  StreamConfirmResponse,
  SavedSearchesResponse,
} from "./wire";

export interface WebDeps {
  runtime: Runtime;
  token: string | null;
  getPosterImpl?: (url: string) => Promise<CachedPoster | null>;
  /**
   * How the stream routes reach configuration. There is no config on `Runtime`
   * and none captured at boot, and that is deliberate rather than an oversight
   * to fix: this server runs inside the TUI process, where the user can paste a
   * Real-Debrid token into the Accounts tab at any moment. A config snapshot
   * taken when the server started would route their next stream over P2P — the
   * exact IP exposure `classifyStreamRoute` exists to prevent — until they
   * restarted the app. Reading per request costs one small JSON file read on a
   * route that is about to join a swarm or call an API over the network.
   *
   * Injected with a default in the same style as `getPosterImpl`, so a test
   * gets a config without touching the user's real one.
   */
  loadConfigImpl?: () => Promise<Config>;
  /**
   * Persist the config. Injected with a default in the same style as
   * `loadConfigImpl`, and for a stronger reason: the default writes the
   * developer's real `~/.config/torlnk/config.json`, so a test that forgets this
   * seam does not fail — it silently edits the machine it runs on.
   */
  saveConfigImpl?: (config: Config) => Promise<void>;
  loadStreamHistoryImpl?: () => Promise<StreamHistoryItem[]>;
  /** Injected for the reason `saveConfigImpl` is: the real one writes the developer's own data dir. */
  saveStreamHistoryImpl?: (items: readonly StreamHistoryItem[]) => Promise<void>;
  /**
   * Last-known account status for the active debrid provider's token, or null
   * when it can't be determined. Only consulted when a token is configured
   * (see the route).
   *
   * The default hits the network, because the alternative is worse: the TUI
   * keeps a live `debridStatus` in React state and the web layer has no
   * equivalent, so hardcoding null here would mean `classifyStreamRoute` could
   * never return `torrent-confirm` from a browser, and a lapsed premium
   * account would route straight to P2P — silently, which is the one outcome
   * that decision exists to prevent. A failure (offline, provider down) is
   * null, not an error: that lets the provider attempt proceed and fail with
   * its own message rather than downgrading to a swarm because a status probe
   * timed out.
   */
  debridStatusImpl?: (provider: DebridProviderId, token: string) => Promise<DebridStatus | null>;
  /**
   * How Chromecasts are found. Defaults to a real mDNS query, which is two
   * seconds of listening on a multicast socket — injected so a test never opens
   * one, and so a test can produce the "nothing answered" branch without
   * depending on what is switched on in the room.
   */
  discoverCastImpl?: () => Promise<CastDevice[]>;
  /**
   * The origin a Chromecast must fetch media from, or null when this machine has
   * none it could reach.
   *
   * A dependency rather than a call to `castOrigin` here because only the server
   * knows what it actually bound (see `startWebServer`), and because it must NOT
   * be derived from the request: `Host` is a claim by a client, and a user
   * browsing `http://localhost:9161` would otherwise hand a television a URL
   * pointing at the television.
   */
  castOriginImpl?: () => string | null;
  /**
   * What one file is and the best source for it — `mediaSourceFor`
   * (./stream.ts), the same answer the player page's `.info` gets.
   *
   * Injected because the real one spawns ffprobe and may call a debrid API, and
   * because the fields it needs (the probe cache, the HLS resolver) live in
   * `StreamDeps` rather than here; `startWebServer` closes over both.
   */
  castSourceImpl?: (session: StreamSession, index: number) => Promise<MediaSource>;
  /**
   * How one source is queried during `/api/search`. Passed straight through to
   * `runSearch`, so the default (`cachedSearch`) and every behaviour around it —
   * per-source timeout, benching, abort propagation — are the real ones; only
   * the outbound HTTP is swappable. Injected rather than stubbing `runSearch`
   * itself precisely so a test still exercises that machinery.
   */
  searchImpl?: SearchImpl;
  /**
   * The source-health map searches read and write. Defaults to the process-wide
   * one shared with the TUI — a browser search benching a dead tracker should
   * spare the TUI the same timeout. Injected so tests do not mutate global state.
   */
  sourceHealthImpl?: Map<SourceId, Health>;
  /** OMDb lookup by IMDb id, for `/api/title?imdb=`. Injected to keep tests offline. */
  fetchTitleMetaImpl?: (imdbId: string, apiKey: string) => Promise<FetchTitleMetaResult>;
  /** OMDb lookup by name, for `/api/title?name=`. Injected to keep tests offline. */
  fetchTitleMetaByNameImpl?: (
    title: string,
    apiKey: string,
    opts: { year?: number; type?: OmdbType },
  ) => Promise<FetchTitleMetaResult>;
  /** reccd's feed, for `/api/recommendations`. Injected to keep tests off the network. */
  fetchRecommendationsImpl?: (
    config: ReccClientConfig,
    query: RecommendationQuery,
  ) => Promise<FetchRecommendationsResult>;
  /** reccd's title search, for `/api/title-search`. Injected to keep tests off the network. */
  fetchTitleSuggestionsImpl?: (
    config: ReccClientConfig,
    query: { q: string; limit?: number },
  ) => Promise<FetchTitleSuggestionsResult>;
  /**
   * How `/api/recc-event` reaches reccd. Injected for the same reason, and
   * typed as returning void rather than a promise the route waits on — see the
   * route for why nothing awaits it.
   */
  postEventImpl?: (config: ReccClientConfig, event: ReccEvent) => Promise<void>;
  /**
   * Which of a batch of info hashes the active provider has cached, for
   * `POST /api/cached`. Defaults to `cachedHashesFor` against the real
   * provider client; injected so a test never dials out to TorBox or
   * Real-Debrid. Takes the provider id (not a `DebridProvider` object) so the
   * seam matches every other injected dep here, which is keyed on primitives.
   */
  checkCachedImpl?: (provider: DebridProviderId, token: string, hashes: string[]) => Promise<Set<string>>;
}

/** The path a client fetches to read one file of a session: `/stream/:sid/:idx`. */
export function streamHandle(sessionId: string, index: number): string {
  // Encoded even though ids are UUIDs today: this string is pasted into an
  // <video src> and an .m3u, and an id factory that ever returns something with
  // a slash or a space in it must not silently produce a different path.
  return `/stream/${encodeURIComponent(sessionId)}/${index}`;
}

/**
 * The browser-safe view of a session.
 *
 * It lives in the web layer, not next to `StreamSession` in `src/core`, because
 * core is forbidden (by lint, deliberately) from importing `./wire` — it is the
 * front-end-agnostic layer, and "what a browser is allowed to see" is not its
 * question. Keeping it here also means the wire types have exactly one
 * declaration, checked at their only producer.
 *
 * BUILT BY PICKING FIELDS, NEVER BY OMITTING THEM. There is no spread here and
 * there must never be one: `{...session, capability: undefined}` and
 * `delete copy.capability` both mean that the day someone adds a field to
 * `StreamSession` — a debrid token, a cookie, an absolute temp path — it ships
 * to every browser polling this session and nothing fails. Picking inverts the
 * default: a new field is private until a human writes a line here.
 *
 * Two things are removed rather than renamed:
 *
 * - `capability`, which is a media credential. It is returned once, in the
 *   `POST /api/stream` response, and never inside a session body — so polling a
 *   resolving session doesn't repeat it into logs and histories.
 * - every `files[].url`, which is either a Real-Debrid unrestricted link (a
 *   credential against the user's account, usable from anywhere) or a
 *   `localhost:<ephemeral>` WebTorrent URL (useless to a remote client). Both
 *   are replaced by a `/stream/:sid/:idx` handle.
 *
 * `backendHandle` (a live WebTorrent client) and `createdAt` are dropped too:
 * the first is not serialisable and the second is nobody's business.
 *
 * Deliberately takes no capability argument. Nothing it produces embeds one, so
 * accepting it would only create somewhere for one to end up.
 */
export function toPublicSession(session: StreamSession): PublicStreamSession {
  const files: PublicStreamFile[] = session.files.map((f, index) => ({
    filename: f.filename,
    bytes: f.bytes,
    index,
    handle: streamHandle(session.id, index),
  }));
  const out: PublicStreamSession = {
    id: session.id,
    backend: session.backend,
    name: session.name,
    state: session.state,
    progress: session.progress,
    files,
  };
  // Conditional rather than `error: session.error`: the wire type marks it
  // optional, and a `"error": undefined` key is dropped by JSON.stringify but
  // present to any in-process consumer, which is a difference worth not having.
  if (session.error !== undefined) out.error = session.error;
  return out;
}

// The status probe is advisory and sits in front of a user's click, so it is
// bounded and gets no retries: the provider client has no request timeout of
// its own, and without this a stalled provider API would hold POST /api/stream
// open for as long as the socket stayed alive. An unanswered probe is "unknown"
// (null), which routes to the provider and lets the resolve report its own
// failure — never a silent downgrade to a swarm because a probe timed out.
const DEBRID_STATUS_PROBE_MS = 4000;

async function fetchDebridStatus(provider: DebridProviderId, token: string): Promise<DebridStatus | null> {
  try {
    return await getDebridProvider(provider).validateToken(token, {
      retries: 0,
      signal: AbortSignal.timeout(DEBRID_STATUS_PROBE_MS),
    });
  } catch {
    return null;
  }
}

// One response shape for every route. `filePath` streams a file from disk
// (posters); `json` and `text` are written inline. Keeping this a plain value
// means the router never touches a socket and is trivially testable.
export interface WebResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  filePath?: string;
}

// The daemon's handler predates this layer and returns { status, body }; map it
// into the richer WebResponse rather than changing a shape other callers use.
function fromApi(res: { status: number; body: Record<string, unknown> }): WebResponse {
  return { status: res.status, json: res.body };
}

function posterResponse(hit: CachedPoster): WebResponse {
  return {
    status: 200,
    filePath: hit.path,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(hit.bytes),
      // Poster URLs are content-addressed by the remote CDN; a cached one never
      // changes meaning, so let the browser keep it for a day.
      "Cache-Control": "private, max-age=86400",
    },
  };
}

// The legacy scripting paths this router forwards to `handleApi`, which is the
// module that actually implements them. It lives here rather than in the HTTP
// server because the server's only question is "router or static asset?", and
// answering that from its own copy of the table is how drift starts: a path
// added to `handleApi` but not to the server's copy silently becomes an asset
// request answered 400/404, with nothing in the log to say why. Same failure
// mode as the hand-copied `statusPayload` that dropped `uploadSpeed`.
const LEGACY_API_PATHS = new Set(["/health", "/status", "/downloads", "/add", "/control"]);

const STREAM_BASE = "/api/stream";

/**
 * The `:sid` of `/api/stream/:sid`, or null when the path isn't that shape.
 *
 * Deliberately one hand-written matcher rather than a router library or a
 * regex: this is the only parameterised path in the app, and the interesting
 * property is what it *rejects*. Exactly one non-empty segment, so
 * `/api/stream` (the collection), `/api/stream/` and `/api/stream/a/b` are all
 * misses and fall through to the 404 below rather than being answered with
 * something. Matching is exact and case-sensitive for the same reason the rest
 * of this router is: `/API/stream/x` never reaches here at all (it fails
 * `startsWith("/api/")` and goes to the legacy handler, which knows no such
 * path), and nothing here lowercases a path to "help".
 *
 * The segment is decoded but not validated: an id that no session has is a 404
 * from the registry lookup, which is the same answer any other unknown id
 * gets, and is the only place that decision belongs.
 */
export function streamSessionId(urlPath: string): string | null {
  if (!urlPath.startsWith(`${STREAM_BASE}/`)) return null;
  const rest = urlPath.slice(STREAM_BASE.length + 1);
  if (!rest || rest.includes("/")) return null;
  try {
    // A stray "%" is a malformed path, not an id: decodeURIComponent throws and
    // this becomes a miss rather than a 500 out of the handler.
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

interface StartStreamBody {
  magnet?: unknown;
  infoHash?: unknown;
  name?: unknown;
  // Set by a client that has shown the user the `torrent-confirm` reason and
  // had them accept it. Never inferred, never defaulted true.
  confirm?: unknown;
}

function parseStartBody(bodyText: string): StartStreamBody | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as StartStreamBody;
  } catch {
    return null;
  }
}

/**
 * POST /api/stream — start a session and answer with its id, its capability
 * and its (public) state.
 *
 * Routing is `classifyStreamRoute`, the same decision the TUI makes, for the
 * same reason: a configured debrid account (Real-Debrid or TorBox) should be
 * used, and one that is configured but not working must not be quietly
 * swapped for a P2P swarm. The `torrent-confirm` case is reported to the
 * client as its own status and its own body and NOT downgraded to
 * `torrent-auto` here — the user set a debrid provider up precisely so their
 * IP would stay out of swarms, and a server that decides "close enough" on
 * their behalf exposes it without them ever seeing a prompt. The client asks,
 * and comes back with `confirm: true` if they accept.
 */
async function startStream(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseStartBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid json body" } };

  // Same normalisation as /add: a magnet or a bare info hash, validated here so
  // nothing hands an arbitrary string to WebTorrent or Real-Debrid. `infoHash`
  // is the fallback input, not a second source of truth — the hash used is
  // always the one the accepted magnet actually carries.
  const input = typeof body.magnet === "string" && body.magnet.trim() ? body.magnet : body.infoHash;
  if (typeof input !== "string" || !input.trim()) {
    return { status: 400, json: { error: "missing magnet or info hash" } };
  }
  const parsed = parseInput(input);
  if (!parsed) return { status: 400, json: { error: "invalid magnet or info hash" } };
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : parsed.name;

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const active = resolveActiveDebrid(config);
  // Only probe the account when there is a token to probe. classifyStreamRoute
  // would ignore the status in that case anyway, and this route is reached by a
  // click: a network round trip that cannot change the answer is one the user
  // waits through for nothing.
  const debridStatus = active
    ? await (deps.debridStatusImpl ?? fetchDebridStatus)(active.provider, active.token)
    : null;
  const classified = classifyStreamRoute(config, debridStatus);

  let route: StreamRoute = classified;
  if (classified.kind === "torrent-confirm") {
    if (body.confirm !== true) {
      const refusal: StreamConfirmResponse = { route: "torrent-confirm", reason: classified.reason };
      // 409, not 200: nothing was started. A success status with a "please ask
      // the user" body is the shape a client accidentally treats as done.
      return { status: 409, json: refusal };
    }
    // Confirmed by a human, so it proceeds as an ordinary P2P stream.
    route = { kind: "torrent-auto" };
  }

  // begin(), not start(): a Real-Debrid cache can take minutes and the answer
  // has to come back now, with a `resolving` session the client polls. The
  // client learns every outcome from the session object it holds an id for;
  // `done` is used below only to know WHEN that outcome landed, so the history
  // write can wait for it instead of guessing.
  const { session, done } = deps.runtime.sessions.begin({
    infoHash: parsed.infoHash,
    magnet: parsed.magnet,
    name,
    route,
    debridToken: active?.token,
  });
  const out: StartStreamResponse = {
    sessionId: session.id,
    // The one and only place this crosses the wire. It is NOT in
    // `toPublicSession`, so the polled session bodies below never repeat it.
    capability: session.capability,
    session: toPublicSession(session),
  };
  // History and the reccd `started` event, both hung off `done` — the session
  // RESOLVING, not the request arriving. `begin()` returns a `resolving`
  // session, so recording here would leave a permanent unplayable
  // Continue-watching row for a dead magnet or a Real-Debrid cache that never
  // fills. The TUI records only after `streamTorrent`/`resolveMagnet` returned
  // files (App.tsx), and posts `started` on the same line, so this is what
  // makes one gesture mean one thing in both front ends.
  //
  // `done` never rejects and this is the second reader of it (the first is the
  // client's polling), so nothing here can delay or fail the response the
  // browser is waiting for. The `.catch` is belt-and-braces on top of the
  // swallow inside recordStreamStart: an unhandled rejection in the server
  // process is not a price a convenience list gets to charge.
  void done.then(
    (resolved) => {
      // `ready` with nothing to offer is not something the user can watch. The
      // bar is the TUI's own: the same non-empty `streamCandidates` check
      // App.tsx applies before it opens a picker. The helper is imported rather
      // than approximated — it lives in `src/util/videoFiles.ts`, which is where
      // both front ends reach for it, and only `src/web` -> `src/ui` is
      // forbidden. Note it is WIDER than "has a video extension": a torrent with
      // nothing recognisable in it hands back every file, because an unknown
      // container is still worth handing to a player. So this is "did anything
      // resolve", said in the terminal's words, and the two surfaces cannot
      // drift apart on what counts as watchable.
      if (resolved.state !== "ready" || streamCandidates(resolved.files).length === 0) return;
      return recordStreamStart(deps, parsed.infoHash, name).catch(() => {});
    },
    () => {},
  );
  return { status: 200, json: out };
}

async function recordStreamStart(deps: WebDeps, infoHash: string, name: string): Promise<void> {
  const item = historyItemFor({ id: infoHash, name, magnet: buildMagnet(infoHash, name) }, Date.now());
  // No title in the release name means no row worth drawing.
  if (item) {
    try {
      const current = await (deps.loadStreamHistoryImpl ?? loadStreamHistory)();
      await (deps.saveStreamHistoryImpl ?? saveStreamHistory)(recordStream(current, item));
    } catch {
      // A convenience list must never take a stream down with it.
    }
  }
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl || !name) return;
  const event: ReccEvent = { type: "started", rawName: name, ts: Date.now(), source: "torlink" };
  void (deps.postEventImpl ?? postEvent)(reccConfig, event).catch(() => {});
}

// ---- search ------------------------------------------------------------

/**
 * A `TorrentResult` narrowed to what a browser gets. Picked field by field —
 * see `PublicSearchResult` in wire.ts for why, and in particular for why
 * `magnet` is not here and must not be added.
 */
export function toPublicResult(r: TorrentResult): PublicSearchResult {
  const out: PublicSearchResult = {
    infoHash: r.infoHash,
    name: r.name,
    sizeBytes: r.sizeBytes,
    seeders: r.seeders,
    leechers: r.leechers,
    source: r.source,
    // Normalised to always-present here: `mergeDuplicateResults` sets it on
    // everything it returns, but the fallback means a snapshot that ever came
    // from somewhere else still gives the browser one shape to render.
    sources: r.sources ?? [r.source],
  };
  // Conditional, not `numFiles: r.numFiles`: an explicit `undefined` key is
  // dropped by JSON.stringify but visible to any in-process consumer, and the
  // wire type marks both of these optional.
  if (r.numFiles !== undefined) out.numFiles = r.numFiles;
  if (r.added !== undefined) out.added = r.added;
  return out;
}

/** A whole `SearchSnapshot` in its public shape. Ordering is preserved as given. */
export function toPublicSnapshot(snap: SearchSnapshot): PublicSearchSnapshot {
  const perSource: Record<string, PublicSearchSnapshot["perSource"][string]> = {};
  for (const [id, state] of Object.entries(snap.perSource)) {
    // Picked, not spread: SourceState is core's type and free to grow.
    perSource[id] = {
      loading: state.loading,
      error: state.error,
      code: state.code,
      count: state.count,
    };
  }
  return {
    results: snap.results.map(toPublicResult),
    perSource,
    done: snap.done,
    total: snap.total,
  };
}

/** The category tabs, exactly the TUI's set. "Porn" is only ever reachable when enabled. */
const SOURCE_GROUPS: readonly SourceGroup[] = [
  "Games",
  "Movies",
  "TV",
  "Anime",
  "Music",
  "Books",
  "Porn",
];

export interface SearchParams {
  query: string;
  /** null means the "All" tab: every enabled source. */
  group: SourceGroup | null;
}

/**
 * Validate `?q=` and `?group=` before a single byte of the stream is written.
 *
 * Separate from the streaming itself because SSE gives up its status code the
 * moment the headers go out: once we have written `200 text/event-stream`,
 * "you asked wrong" can only be an error *frame*, which a client has to parse
 * to discover it. So the decidable part is a pure function the socket layer
 * runs first and answers 400 from.
 *
 * A blank `q` is *valid*: it is browse mode, the empty query the TUI sends when
 * you press Enter on an empty box, which each source maps to its own top/latest
 * endpoint. But `q` must be *present* — a bare `GET /api/search` is far more
 * likely to be a stray request than an intent to fan out to every source, so
 * absent and blank are deliberately different answers.
 *
 * An unknown group is rejected rather than silently searched as "All": a typo'd
 * tab that quietly returns everything is worse than one that says no. A group
 * that exists but is entirely adult-sourced is NOT rejected here — that depends
 * on config, and it comes out as a search with zero sources and an immediate
 * `done`, which is the honest answer.
 */
export function parseSearchParams(
  query: URLSearchParams,
): { ok: true; params: SearchParams } | { ok: false; error: string } {
  const raw = query.get("q");
  if (raw === null) return { ok: false, error: "missing query" };
  const q = raw.trim();
  const rawGroup = (query.get("group") ?? "").trim();
  if (!rawGroup || rawGroup === "All") return { ok: true, params: { query: q, group: null } };
  const group = SOURCE_GROUPS.find((g) => g === rawGroup);
  if (!group) return { ok: false, error: "unknown group" };
  return { ok: true, params: { query: q, group } };
}

/** The sources one search will actually query, given the user's config and tab. */
export function searchSources(config: Config, group: SourceGroup | null): Source[] {
  // enabledSources is the single choke-point that keeps adult sources out of
  // both the "All" aggregate and per-source searching. Going around it — say by
  // filtering SOURCES here — is how the browser would end up searching a
  // tracker the user switched off.
  const adult = resolveAdultContent(config);
  const sources = enabledSources((config.disabledSources ?? []) as SourceId[], adult);
  if (!group) return sources;
  return sources.filter((s) => s.groups?.includes(group));
}

/**
 * `GET /api/search` — run one search and stream a snapshot per source that
 * settles, then a final `done`.
 *
 * Returns a stop function. THE CALLER MUST CALL IT WHEN THE CLIENT
 * DISCONNECTS. That is not tidiness: `runSearch` has up to 23 HTTP requests in
 * flight, each with a 25-second timeout, and a closed browser tab that left
 * them running would keep hammering trackers on behalf of nobody — and worse,
 * would record their timeouts as failures and bench sources that were fine.
 * Stopping aborts the signal `runSearch` is watching, which cancels the
 * in-flight fetches and suppresses both further snapshots and the failure
 * bookkeeping.
 *
 * Frames:
 * - `results` — a `PublicSearchSnapshot`: one immediately, carrying the source
 *   list with everything still loading, then one per settled source.
 * - `done` — the final snapshot, exactly once, on every non-aborted path
 *   including "every source failed" and "no sources at all". A client waits on
 *   this to stop its spinner, so a path that ends without it hangs the UI.
 * - `error` — config could not be read; followed by no `done`, and the channel
 *   closes. `runSearch` itself never rejects: a source failure is reported in
 *   that source's `perSource` slot and the search carries on.
 * - `ping` — the heartbeat, from the channel.
 */
export function startSearchStream(
  deps: WebDeps,
  params: SearchParams,
  write: SseWrite,
  onClose?: () => void,
): () => void {
  const controller = new AbortController();
  // Created before the channel because the channel's teardown fires it, and
  // that teardown can run synchronously from the very first heartbeat write.
  //
  // `onClose` runs on the same single teardown path, so the socket layer can
  // end the response when the search finishes without a second notion of
  // "finished" that could disagree with this one. Unlike /api/events, this
  // stream is finite: leaving the connection open after `done` would hold a
  // socket per completed search until the browser noticed.
  const channel = openSseChannel(write, () => {
    controller.abort();
    onClose?.();
  });

  void (async (): Promise<void> => {
    try {
      const config = await (deps.loadConfigImpl ?? loadConfig)();
      // Reading config was async, so the client may already be gone.
      if (!channel.alive) return;

      const health = deps.sourceHealthImpl ?? sourceHealth;
      // Benched sources are dropped HERE rather than left for runSearch to drop
      // itself, so the opening frame's `total` is the same number every later
      // frame reports. Filtered in both places, a browser that started with 23
      // would watch the count drop to 20 on the first update and have no way to
      // tell that from three sources vanishing mid-search.
      const now = Date.now();
      const sources = searchSources(config, params.group).filter(
        (s) => !isSkipped(health, s.id, now),
      );

      // An opening frame before any source has answered, carrying the full
      // source list all marked loading. The TUI does the same thing (see
      // useConcurrentSearch), and for the same reason: the browser can render
      // "0/23 sources" and the per-source list at once instead of showing
      // nothing until the first tracker replies, which can be seconds.
      channel.send("results", () =>
        toPublicSnapshot({
          results: [],
          perSource: blankPerSource(sources, true),
          done: 0,
          total: sources.length,
        }),
      );

      const snapshot = await runSearch(params.query, sources, {
        signal: controller.signal,
        onUpdate: (snap) => channel.send("results", () => toPublicSnapshot(snap)),
        searchImpl: deps.searchImpl,
        health,
      });
      // An aborted runSearch resolves (it does not reject) with whatever the
      // snapshot held when the abort landed — typically empty, with sources
      // still marked loading. Emitting `done` for that would tell a client that
      // a discarded search finished. `channel.alive` is false on that path
      // anyway, since abort only ever comes from the teardown; the explicit
      // check is here so a future second abort path cannot make this lie.
      if (!channel.alive || controller.signal.aborted) return;
      channel.send("done", () => toPublicSnapshot(snapshot));
    } catch (err) {
      // Reaching here means config could not be read, or `runSearch` broke its
      // own contract (it reports a source failure in that source's slot and
      // never rejects). Either way this runs detached from any caller, so an
      // escaping rejection would be a process-level unhandledRejection — one
      // unreadable config file taking down a daemon serving a dozen downloads.
      channel.send("error", () => ({
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      // The single exit. Every path above — done, error, and the two aborted
      // early returns — ends the channel here, so the socket layer's `onClose`
      // fires exactly once and no connection is left open after its search.
      channel.stop();
    }
  })();

  return channel.stop;
}

/**
 * `GET /api/sources` — the category tabs and per-source health, so the browser
 * can offer the same navigation the TUI does.
 *
 * Adult sources are absent entirely (not merely flagged) unless the adult
 * category is enabled: this response is what the browser renders a tab bar
 * from, and "hidden" has to mean hidden. Disabled sources ARE present, marked
 * `enabled: false`, because the TUI shows them greyed and the browser should
 * match — configuring them stays in the TUI.
 */
export function sourcesResponse(config: Config, health: Map<SourceId, Health>, now: number): SourcesResponse {
  const adultEnabled = resolveAdultContent(config);
  const active = resolveActiveDebrid(config);
  const disabled = new Set(config.disabledSources ?? []);
  const visible = SOURCES.filter((s) => adultEnabled || !s.adult);
  const sources: PublicSource[] = visible.map((s) => ({
    id: s.id,
    label: s.label,
    groups: [...(s.groups ?? [])],
    adult: s.adult === true,
    homepage: s.homepage,
    reportsHealth: s.reportsHealth,
    enabled: !disabled.has(s.id),
    fails: health.get(s.id)?.fails ?? 0,
    // Reported as "benched or not" at this instant rather than raw skipUntil:
    // a lapsed cooldown leaves skipUntil in the past, and a browser comparing
    // it against its own clock would call a recovered source benched.
    benchedUntil: isSkipped(health, s.id, now) ? (health.get(s.id)?.skipUntil ?? null) : null,
  }));
  return {
    groups: sourcesByGroup(adultEnabled).map((g) => ({
      group: g.group,
      sourceIds: g.sources.map((s) => s.id),
    })),
    sources,
    adultEnabled,
    // Booleans and an id, never a token. resolveActiveDebrid, not the raw
    // config fields, so both env vars count — the browser must agree with the
    // TUI about which provider is on, and the TUI resolves it the same way.
    debridConfigured: active !== null,
    debridProvider: active?.provider ?? null,
    debridCachedCheck: active ? getDebridProvider(active.provider).checkCached !== undefined : false,
    // resolveOmdbApiKey, not config.omdbApiKey, so TORLINK_OMDB_KEY counts —
    // the browser must agree with the TUI about whether artwork is available,
    // and the TUI resolves it the same way.
    omdbConfigured: resolveOmdbApiKey(config) !== "",
    // resolveReccConfig, not config.reccUrl, so TORLINK_RECC_URL counts — the
    // browser must agree with the TUI about whether reccd is on, and the TUI
    // resolves it the same way. A boolean, never the URL or the token.
    reccConfigured: resolveReccConfig(config).reccUrl !== undefined,
    // From config, never from reccd: /api/sources is the one payload the
    // browser fetches before it can render anything, and hanging a network
    // round trip off it to learn a fact that changes once per account lifetime
    // is the wrong trade. The TUI's status check is what keeps this current.
    reccAccount: config.reccAccountName
      ? { name: config.reccAccountName, claimed: config.reccAccountClaimed === true }
      : null,
    // Read only. `POST /api/preferences` is the write path; this is here so
    // fetching it costs no extra round trip on the page the browser loads first.
    preferences: toPublicQualityPrefs(config),
  };
}

/** `Config`'s quality preference, sanitised and shaped for the wire. */
function toPublicQualityPrefs(config: Config): PublicQualityPrefs {
  const prefs = qualityPrefsFrom(config);
  return {
    maxResolution: prefs.maxResolution ?? null,
    require: [...prefs.require],
    exclude: [...prefs.exclude],
  };
}

// ---- add ---------------------------------------------------------------

/**
 * `POST /api/add`.
 *
 * Two shapes go through here and only one of them is new:
 *
 * - A body with neither `name` nor `via` is forwarded to the legacy `/add`
 *   handler byte for byte. That is not laziness — `/api/add` is a documented
 *   alias that scripts already call, and the legacy handler owns the details
 *   (a bare non-JSON magnet in the body, the `infohash`/`hash` key aliases, the
 *   exact error strings). Reimplementing them here to "unify" would be the
 *   third copy of an API contract in this codebase.
 * - A body carrying either is the browser's: a search hit, identified by info
 *   hash, with the name the tracker gave it and an explicit network choice.
 *
 * `via: "debrid"` with no token configured is a 400 with the TUI's own wording,
 * not a silent fall back to peer-to-peer. Falling back would put the user's IP
 * in a public swarm after they asked for the thing that keeps it out of one.
 */
async function addToQueue(
  deps: WebDeps,
  authHeader: string | undefined,
  bodyText: string,
): Promise<WebResponse> {
  let body: Record<string, unknown> = {};
  const raw = bodyText.trim();
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Left as {}, so this falls through to the legacy handler, which answers
      // unparseable JSON exactly the way it always has.
    }
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const rawVia = typeof body.via === "string" ? body.via.trim() : "";
  if (!name && !rawVia) {
    return fromApi(await handleApi(deps.runtime, deps.token, "POST", "/add", authHeader, bodyText));
  }
  if (rawVia && rawVia !== "p2p" && rawVia !== "debrid") {
    return { status: 400, json: { error: "via must be \"p2p\" or \"debrid\"" } };
  }

  // Same precedence as POST /api/stream: a magnet wins, a bare hash is the
  // fallback, and `parseInput` (not this route) decides what is acceptable.
  const magnet = typeof body.magnet === "string" ? body.magnet.trim() : "";
  const infoHash = typeof body.infoHash === "string" ? body.infoHash.trim() : "";
  const input = magnet || infoHash;
  if (!input) return { status: 400, json: { error: "missing magnet or info hash" } };

  const options: AddInputOptions = {};
  if (name) options.name = name;
  if (typeof body.sizeBytes === "number" && Number.isFinite(body.sizeBytes) && body.sizeBytes > 0) {
    options.sizeBytes = body.sizeBytes;
  }

  if (rawVia === "debrid") {
    const config = await (deps.loadConfigImpl ?? loadConfig)();
    const active = resolveActiveDebrid(config);
    if (!active) {
      return {
        status: 400,
        json: { error: "Set a Real-Debrid or TorBox token first — open the Accounts tab." },
      };
    }
    options.debridToken = active.token;
    options.debridProvider = active.provider;
  }

  const outcome = await addInput(deps.runtime, input, options);
  if (outcome === "invalid") return { status: 400, json: { error: "invalid magnet or info hash" } };
  const out: AddResponse = { ok: true, outcome };
  return { status: 200, json: out };
}

// ---- saved lists -------------------------------------------------------
// The saved searches (config.savedSearches) and the library (config.favourites),
// which the TUI has had all along. Both are read here and mutated by the two
// routes below.
//
// EVERY MUTATION RE-READS THE CONFIG FIRST, and that is not defensive style —
// it is required. `serializeWrites()` in config.ts serializes writes within ONE
// process, and `torlnk serve --web` is a separate process from any TUI the user
// has open. A held snapshot written back would silently revert whatever the TUI
// changed meanwhile: the Real-Debrid token, the sort, disabledSources. Last
// writer wins on the one list being edited is acceptable (the TUI already does
// that to itself); last writer wins on the whole file is not.

/** A stored favourite as the browser sees it. Drops the magnet and the watched filenames. */
export function toPublicFavourite(f: FavouriteItem): PublicFavourite {
  const out: PublicFavourite = {
    id: f.id,
    name: f.name,
    addedAt: f.addedAt,
    watched: f.watched?.length ?? 0,
  };
  if (f.sizeBytes !== undefined && f.sizeBytes > 0) out.sizeBytes = f.sizeBytes;
  if (f.source !== undefined) out.source = f.source;
  return out;
}

/** A stream-history entry as the browser sees it. Drops the magnet; adds the suggested next episode. */
export function toPublicStreamHistoryItem(item: StreamHistoryItem): PublicStreamHistoryItem {
  const out: PublicStreamHistoryItem = {
    key: item.key, title: item.title, rawName: item.rawName,
    infoHash: item.infoHash, startedAt: item.startedAt, next: nextEpisode(item),
  };
  if (item.year !== undefined) out.year = item.year;
  if (item.type !== undefined) out.type = item.type;
  if (item.season !== undefined) out.season = item.season;
  if (item.episode !== undefined) out.episode = item.episode;
  return out;
}

/** `GET /api/saved`: both lists, in one round trip because the pane shows both. */
async function savedLists(deps: WebDeps): Promise<WebResponse> {
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const history = await (deps.loadStreamHistoryImpl ?? loadStreamHistory)();
  const out: SavedResponse = {
    // loadConfig already normalises both (junk dropped, caps applied), so these
    // coalesces are for a config object built in a test, not for disk data.
    savedSearches: config.savedSearches ?? [],
    library: (config.favourites ?? []).map(toPublicFavourite),
    continueWatching: history.map(toPublicStreamHistoryItem),
  };
  return { status: 200, json: out };
}

/** A JSON object body, or null for anything that is not one. */
function parseObjectBody(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function savedSearchesAction(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseObjectBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid JSON body" } };

  const action = body.action;
  if (action !== "toggle" && action !== "remove") {
    return { status: 400, json: { error: "invalid action" } };
  }

  // Trimmed here so "  tin rivers  " and "tin rivers" are one entry, matching the TUI —
  // toggleSavedSearches trims too, but the emptiness check below needs the
  // trimmed value and a second trim inside the helper is not something to rely
  // on from out here.
  const query = typeof body.query === "string" ? body.query.trim() : "";
  // A blank query would make toggleSavedSearches a no-op that still answered
  // 200, telling the browser something happened when nothing did.
  if (!query) return { status: 400, json: { error: "missing query" } };

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const current = config.savedSearches ?? [];
  const savedSearches =
    action === "remove" ? current.filter((q) => q !== query) : toggleSavedSearches(current, query);

  await (deps.saveConfigImpl ?? saveConfig)({ ...config, savedSearches });

  const out: SavedSearchesResponse = { saved: savedSearches.includes(query), savedSearches };
  return { status: 200, json: out };
}

/**
 * `POST /api/continue-watching`: the row's ✕. One action, `"remove"` — nothing
 * plays a title and then un-plays it, so there is no toggle to offer.
 *
 * Idempotent by construction: `removeStreamHistory` filters by key and a key
 * that is not there filters nothing, so a double-fired click (this is the same
 * ✕ pattern as the saved-searches remove, which exists for exactly that phone
 * behaviour) is a no-op the second time rather than an error.
 */
async function continueWatchingAction(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseObjectBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid JSON body" } };

  if (body.action !== "remove") return { status: 400, json: { error: "invalid action" } };

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) return { status: 400, json: { error: "missing key" } };

  const current = await (deps.loadStreamHistoryImpl ?? loadStreamHistory)();
  const next = removeStreamHistory(current, key);
  // Only write when something actually changed. removeStreamHistory always
  // returns a new array (it is a plain `.filter`), so the write gate here is a
  // length comparison rather than the reference check `libraryAction`'s
  // "watched" branch uses — either way, a no-op remove (a stale page, a
  // double-fired click) does not churn the history file.
  if (next.length !== current.length) {
    await (deps.saveStreamHistoryImpl ?? saveStreamHistory)(next);
  }

  const out: ContinueWatchingResponse = { continueWatching: next.map(toPublicStreamHistoryItem) };
  return { status: 200, json: out };
}

async function libraryAction(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseObjectBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid JSON body" } };

  const action = body.action;
  if (action !== "toggle" && action !== "remove" && action !== "watched") {
    return { status: 400, json: { error: "invalid action" } };
  }

  // isInfoHash is anchored to the WHOLE string, so an ordinary query can never
  // slip through; normalizeInfoHash does not itself validate, it only
  // lowercases and converts 32-char base32 to hex, so the id ends up in one
  // canonical form and the dedupe key matches whatever the TUI stored.
  // Validated rather than trusted because this string becomes a magnet the
  // download engine and Real-Debrid will act on.
  const rawHash = typeof body.infoHash === "string" ? body.infoHash.trim() : "";
  if (!isInfoHash(rawHash)) return { status: 400, json: { error: "invalid info hash" } };
  const infoHash = normalizeInfoHash(rawHash);

  // Required even on remove, where it is unused: a body missing it is a client
  // bug, and accepting it on one action but not another is the kind of
  // asymmetry that gets a caller written against the wrong shape.
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { status: 400, json: { error: "missing name" } };

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const current = config.favourites ?? [];
  const wasFavourited = isFavourited(current, infoHash);

  if (action === "watched") {
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    if (!filename) return { status: 400, json: { error: "missing filename" } };

    // markWatched returns the SAME array reference when nothing changed — the
    // id is not favourited, or the episode was already recorded. Both are
    // ordinary: this fires whenever a player launches, including for a torrent
    // the user never favourited. Writing anyway would churn config.json on
    // every re-watch, so the reference check is the write gate.
    const favourites = markWatched(current, infoHash, filename);
    if (favourites !== current) {
      await (deps.saveConfigImpl ?? saveConfig)({ ...config, favourites });
    }

    // The same moment, for the same reason as the TUI's markPlayed: this is the
    // first point at which we know WHICH episode was opened. `historyItemFor`
    // ran at stream start, hung off the session resolving, before the user had
    // picked a file at all — so for a season pack it stored no episode, and
    // there was no "next" to offer.
    //
    // Read-modify-write, never a held snapshot: a TUI may be running against
    // this same file in another process. Same reference back means nothing
    // moved, which is the write gate.
    try {
      const history = await loadStreamHistory();
      const advanced = recordPlayedFile(history, infoHash, filename);
      if (advanced !== history) await saveStreamHistory(advanced);
    } catch {
      // A convenience list must never fail a play the user already started.
    }
    const out: LibraryResponse = {
      // Not an error when absent: the browser fires this after a successful
      // play and must not be told off for playing something unfavourited.
      favourited: isFavourited(favourites, infoHash),
      library: favourites.map(toPublicFavourite),
    };
    return { status: 200, json: out };
  }

  let favourites: FavouriteItem[];
  if (action === "remove") {
    favourites = removeFromFavourites(current, infoHash);
  } else {
    const item: FavouriteItem = {
      id: infoHash,
      name,
      // The bridge this route exists to build. See LibraryRequest's comment.
      magnet: buildMagnet(infoHash, name),
      // The SERVER's clock. A browser's can be years out, and the library is
      // ordered most-recent-first — one bad addedAt pins a row to the top for
      // good.
      addedAt: Date.now(),
    };
    if (typeof body.sizeBytes === "number" && body.sizeBytes > 0) item.sizeBytes = body.sizeBytes;
    if (typeof body.source === "string" && body.source) item.source = body.source as SourceId;
    favourites = toggleInFavourites(current, item);
  }

  await (deps.saveConfigImpl ?? saveConfig)({ ...config, favourites });

  // Only a toggle rates anything. Removing a row from the library is
  // housekeeping — the TUI's ✕ posts no event either, and treating it as a
  // verdict would teach reccd that tidying up is a dislike.
  if (action === "toggle") {
    const reccConfig = resolveReccConfig(config);
    if (reccConfig.reccUrl) {
      const event: ReccEvent = {
        type: wasFavourited ? "unfavourited" : "favourited",
        rawName: name,
        // Server clock and fixed source, for the reason reccEvent states.
        ts: Date.now(),
        source: "torlink",
      };
      // `.catch` on top of postEvent's own swallowing, and for the same reason
      // reccEvent does it: this promise is unwatched, and an unhandled
      // rejection from an injected impl would take the daemon down — which is
      // the exact "reccd must never take the process with it" rule these
      // routes exist to honour.
      void (deps.postEventImpl ?? postEvent)(reccConfig, event).catch(() => {});
    }
  }

  const out: LibraryResponse = {
    favourited: isFavourited(favourites, infoHash),
    library: favourites.map(toPublicFavourite),
  };
  return { status: 200, json: out };
}

/**
 * `POST /api/preferences` — the browser's half of the quality picker.
 * `PUT` would read more naturally for a whole-resource replace, but this
 * codebase has no `PUT` route anywhere: every mutation here is `POST` with an
 * `action` discriminator (`savedSearchesAction`, `libraryAction`,
 * `continueWatchingAction` above), and a `PUT` here would be one inconsistent
 * route for a caller to trip over. `"set"` is the only action because there is
 * nothing to toggle or remove — a preference is either the current value or
 * the previous one, never a list entry.
 */
async function preferencesAction(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseObjectBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid JSON body" } };
  if (body.action !== "set") return { status: 400, json: { error: "invalid action" } };

  const raw = body.preferences;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: 400, json: { error: "missing preferences" } };
  }
  const incoming = raw as Record<string, unknown>;

  // Sanitised with the same helper `loadConfig` uses, so a value the browser
  // sends can never be stored in a form the terminal would reject — an unknown
  // feature id is dropped rather than round-tripped into the config file.
  const clean = sanitiseQualityPrefs({
    maxResolution: incoming.maxResolution,
    requireFeatures: incoming.require,
    excludeFeatures: incoming.exclude,
  });

  // Re-read, per the note at the top of the saved-lists section: `serve --web`
  // is a separate process from any running TUI, so writing back a snapshot
  // taken before this request would silently revert a token, sort, or
  // disabled-source edit the TUI made in between.
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const next: Config = {
    ...config,
    maxResolution: clean.maxResolution,
    requireFeatures: clean.requireFeatures,
    excludeFeatures: clean.excludeFeatures,
  };
  await (deps.saveConfigImpl ?? saveConfig)(next);

  const out: PreferencesResponse = { preferences: toPublicQualityPrefs(next) };
  return { status: 200, json: out };
}

// ---- title metadata ----------------------------------------------------

/**
 * How many OMDb answers to keep. Each is three short strings, so this is tens
 * of KB; the bound exists because the key space is caller-supplied (any release
 * name a search turned up) and an unbounded map on a process that runs for
 * weeks is a slow leak, not because the memory matters at normal sizes.
 */
export const MAX_TITLE_CACHE = 256;

// Insertion-ordered, used as an LRU: a hit is deleted and re-set so it moves to
// the back, and eviction takes from the front. Module-level and per process,
// shared by every browser talking to this server — which is the point, since
// two tabs scrolling the same result list should cost one OMDb call.
const titleCache = new Map<string, PublicTitleMeta>();

/** Test seam: drop everything cached. Nothing in the app calls this. */
export function clearTitleCache(): void {
  titleCache.clear();
}

function cacheGet(key: string): PublicTitleMeta | undefined {
  const hit = titleCache.get(key);
  if (hit === undefined) return undefined;
  titleCache.delete(key);
  titleCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: PublicTitleMeta): void {
  titleCache.delete(key);
  titleCache.set(key, value);
  while (titleCache.size > MAX_TITLE_CACHE) {
    // Map iteration is insertion order, so the first key is the least recently
    // used. `.next().value` is undefined only for an empty map, which the loop
    // condition already excludes.
    const oldest = titleCache.keys().next().value;
    if (oldest === undefined) break;
    titleCache.delete(oldest);
  }
}

interface TitleLookup {
  cacheKey: string;
  imdbId?: string;
  name?: string;
  year?: number;
  type?: OmdbType;
  /**
   * What `?release=` parsed to, echoed back to the caller. Present only on that
   * path — the caller of `?name=` did its own parsing and needs nothing back.
   */
  parsed?: PublicTitleParse;
  /** One episode of a series, when the caller asked for that episode's own plot. */
  season?: number;
  episode?: number;
}

/**
 * Turn `?imdb=` / `?release=&group=` / `?name=&year=&type=` into a lookup, or
 * say why not.
 *
 * `imdb` wins over everything — it is the exact identifier and the rest is then
 * only a hint. `release` is the browser's form: a raw torrent release name,
 * parsed HERE with the TUI's own `parseRelease` rather than in the browser.
 * That placement is the point. `parse-torrent-title` is a Node dependency, and
 * the alternative to a round trip is a second release-name parser in the
 * browser bundle — at which point "Kestrel.2010.1080p.BluRay.x264-GROUP" could
 * mean one thing in the terminal and another in the tab, with no test able to
 * call either side wrong. One parser, server-side, and the parse comes back
 * with the answer so the UI can show the title it actually looked up.
 *
 * The cache key is built here so it cannot drift from the request it stands
 * for: it carries every parameter that changes the answer, and lowercases the
 * name so "Kestrel" and "kestrel" share an entry (OMDb's title match is
 * case-insensitive, so they genuinely do have the same answer). A `?release=`
 * lookup shares that key space deliberately — fifty releases of one film parse
 * to one title and cost one OMDb call between them, which is the whole reason
 * the TUI caches on `parsed.key` too.
 */
/**
 * `?season=&episode=` — both, or neither. A season with no episode is a pack,
 * which OMDb has no per-episode answer for, and half a pair is a caller bug the
 * safe reading of which is "no episode asked for".
 */
function episodeFromQuery(query: URLSearchParams): { season: number; episode: number } | null {
  // PRESENCE FIRST. `Number("")` is 0 and `Number.isInteger(0)` is true, so a
  // bare digit check answers "episode 0 of season 0" for every request that
  // sends neither — which sent every poster lookup down the episode path.
  const rawSeason = (query.get("season") ?? "").trim();
  const rawEpisode = (query.get("episode") ?? "").trim();
  if (!rawSeason || !rawEpisode) return null;
  const season = Number(rawSeason);
  const episode = Number(rawEpisode);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
  if (season < 0 || episode < 0) return null;
  return { season, episode };
}

export function parseTitleLookup(
  query: URLSearchParams,
): { ok: true; lookup: TitleLookup } | { ok: false; error: string; soft?: true } {
  const imdb = (query.get("imdb") ?? "").trim();
  if (imdb) {
    // Anchored: this is interpolated into an OMDb query string, and an id shape
    // is cheap to insist on. tt + 7 or more digits covers everything IMDb has
    // issued and everything it plausibly will.
    if (!/^tt\d{7,}$/.test(imdb)) return { ok: false, error: "invalid imdb id" };
    return { ok: true, lookup: { cacheKey: `i:${imdb}`, imdbId: imdb } };
  }

  // NOT trimmed before the emptiness test, unlike `name` below. A caller that
  // sent `?release=` at all asked the release question, and answering a
  // whitespace-only release with "missing name or imdb" would send the preview
  // pane looking for a parameter it did deliberately supply. Non-empty means
  // "parse this"; what parsing makes of it is the next line's problem.
  // OPT-IN, and only the preview pane sends them. The poster cache asks this
  // same route with `?release=` and must keep getting the SERIES, whose artwork
  // OMDb reliably has — an episode lookup answers with the episode's own poster,
  // which is missing often enough that grid cards would blank at random.
  const ep = episodeFromQuery(query);

  const release = query.get("release") ?? "";
  if (release !== "") {
    const parsed = parseRelease(release, hintForGroup(query.get("group")));
    // A name that is only quality/codec noise ("1080p.WEB-DL.x265") parses to
    // nothing. That is a miss, not a bad request: the caller asked a reasonable
    // question about a real search hit and the honest answer is "no title in
    // there", which the UI renders as its placeholder. A 400 would make the
    // preview pane look broken for a perfectly ordinary torrent.
    if (!parsed) return { ok: false, error: "no title in that release name", soft: true };
    const lookup: TitleLookup = {
      // Season and episode ARE part of the identity. Without them every episode
      // of a season shares one cache entry and renders the first one's plot — a
      // bug that reads as OMDb being wrong rather than a key being too coarse.
      cacheKey: `n:${parsed.title.toLowerCase()}|${parsed.year ?? ""}|${parsed.type ?? ""}${
        ep ? `|s${ep.season}e${ep.episode}` : ""
      }`,
      name: parsed.title,
      parsed: { title: parsed.title, year: parsed.year ?? null, type: parsed.type ?? null },
    };
    if (parsed.year !== undefined) lookup.year = parsed.year;
    if (parsed.type !== undefined) lookup.type = parsed.type;
    if (ep) {
      lookup.season = ep.season;
      lookup.episode = ep.episode;
    }
    return { ok: true, lookup };
  }

  const name = (query.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "missing name or imdb" };

  const rawYear = (query.get("year") ?? "").trim();
  let year: number | undefined;
  if (rawYear) {
    // Strict rather than parseInt: "2010abc" must not silently become 2010, and
    // a year outside this range is a caller bug, not a title from the future.
    if (!/^\d{4}$/.test(rawYear)) return { ok: false, error: "invalid year" };
    year = Number(rawYear);
    if (year < 1870 || year > 2200) return { ok: false, error: "invalid year" };
  }

  const rawType = (query.get("type") ?? "").trim();
  let type: OmdbType | undefined;
  if (rawType) {
    if (rawType !== "movie" && rawType !== "series") return { ok: false, error: "invalid type" };
    type = rawType;
  }

  const lookup: TitleLookup = {
    cacheKey: `n:${name.toLowerCase()}|${year ?? ""}|${type ?? ""}`,
    name,
  };
  if (year !== undefined) lookup.year = year;
  if (type !== undefined) lookup.type = type;
  return { ok: true, lookup };
}

/**
 * A poster URL we are willing to hand a browser, or null.
 *
 * The allowlist in `getPoster` is the authoritative one and this does not
 * replace it — but downstream enforcement alone is not enough here, for two
 * reasons that only apply at this end. First, the URL crosses into the browser:
 * `/api/title` is the one route that takes a third party's string and returns
 * it as a *URL*, and a page that puts it in an `<img src>` — the obvious thing
 * to write, and what the preview pane will be tempted into — fetches it
 * directly, leaking the user's IP and referer to whatever host OMDb named.
 * Second, an unlisted host degrades far better as a null (the UI shows its
 * placeholder) than as a URL that 400s from `/api/poster` and renders a broken
 * image with no way to tell why.
 *
 * OMDb serves `m.media-amazon.com` today and `ia.media-imdb.com` historically,
 * both listed, so in normal operation this nulls nothing.
 */
export function allowedPosterUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!POSTER_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Attach the release parse (when there was one) to a cached-or-fresh answer.
 *
 * A copy, never a mutation: `meta` may be the object living in `titleCache`,
 * and writing `parsed` onto it would pin one caller's release name to every
 * later caller's cache hit — including the `?name=` callers who never asked for
 * a parse and whose response shape would silently grow a field.
 */
function withParse(meta: PublicTitleMeta, parsed: PublicTitleParse | undefined): PublicTitleMeta {
  if (!parsed) return meta;
  if (meta.status === "ok") {
    return {
      status: "ok",
      imdbId: meta.imdbId,
      plot: meta.plot,
      posterUrl: meta.posterUrl,
      ...(meta.type !== undefined ? { type: meta.type } : {}),
      parsed,
    };
  }
  if (meta.status === "no-key") return { status: "no-key", parsed };
  return { status: "error", error: meta.error, parsed };
}

async function titleMeta(deps: WebDeps, query: URLSearchParams): Promise<WebResponse> {
  const parsedQuery = parseTitleLookup(query);
  if (!parsedQuery.ok) {
    // `soft` means the request was well-formed and simply has no answer — a
    // release name with no title in it. That is a 200 miss the preview pane
    // renders as its placeholder, not a 400 that makes it look broken.
    if (parsedQuery.soft) {
      const out: PublicTitleMeta = { status: "error", error: parsedQuery.error };
      return { status: 200, json: out };
    }
    return { status: 400, json: { error: parsedQuery.error } };
  }
  const { lookup } = parsedQuery;

  const cached = cacheGet(lookup.cacheKey);
  if (cached) return { status: 200, json: withParse(cached, lookup.parsed) };

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const apiKey = resolveOmdbApiKey(config);
  if (!apiKey) {
    // 200 with its own status, NOT a 500 and not an empty "ok". Nothing is
    // broken — the user simply has no key — and the UI needs to tell them that
    // rather than showing a failure or an empty plot. Deliberately not cached:
    // this server runs inside the TUI, where a key can be pasted into the
    // Accounts tab at any moment, and a cached "no-key" would outlast it.
    const out: PublicTitleMeta = { status: "no-key" };
    return { status: 200, json: withParse(out, lookup.parsed) };
  }

  const result =
    lookup.imdbId !== undefined
      ? await (deps.fetchTitleMetaImpl ?? fetchTitleMeta)(lookup.imdbId, apiKey)
      : await (deps.fetchTitleMetaByNameImpl ?? fetchTitleMetaByName)(lookup.name ?? "", apiKey, {
          ...(lookup.year !== undefined ? { year: lookup.year } : {}),
          ...(lookup.type !== undefined ? { type: lookup.type } : {}),
          ...(lookup.season !== undefined ? { season: lookup.season } : {}),
          ...(lookup.episode !== undefined ? { episode: lookup.episode } : {}),
        });

  if (!result.ok) {
    // Not cached either, and this is the deliberate half of the caching policy:
    // `fetchTitleMeta` flattens "OMDb has never heard of this" and "the request
    // timed out" into the same `{ok: false}`, so caching a failure would pin a
    // transient network blip to a title for the life of the process. The cost
    // is that a genuinely unknown title is re-asked on every hover; the debounce
    // in front of this route is what keeps that bounded.
    const out: PublicTitleMeta = { status: "error", error: result.error };
    return { status: 200, json: withParse(out, lookup.parsed) };
  }

  const out: PublicTitleMeta = {
    status: "ok",
    imdbId: result.imdbId,
    plot: result.plot,
    posterUrl: allowedPosterUrl(result.posterUrl),
    // Optional, and only added when OMDb actually reported a `Type` — the
    // `?imdb=`/`?name=` fixtures used throughout this file's existing tests
    // never set it, and adding an always-present `type: null` would change
    // their exact-equality assertions for no benefit. Task 14's Play-button
    // gate is the reason this field exists at all; see PublicTitleMeta.
    ...(result.type !== undefined ? { type: result.type } : {}),
  };
  cacheSet(lookup.cacheKey, out);
  return { status: 200, json: withParse(out, lookup.parsed) };
}

// ---- recommendations ---------------------------------------------------

/**
 * How many picks to ask reccd for. THE TUI'S NUMBER (`useRecommendations`), and
 * not caller-supplied on purpose: the browser has no reason to want a different
 * feed length than the terminal does, and a `?limit=` would let an anonymous —
 * or merely enthusiastic — caller turn one click into reccd scoring ten thousand
 * titles.
 */
const RECC_LIMIT = 20;

/**
 * `GET /api/recommendations?type=&genre=&explore=` — the For You feed.
 *
 * Config is read per request through the same `loadConfigImpl` seam as the
 * stream routes, for the same reason: this server runs inside the TUI, where a
 * reccd URL can be pasted into the Accounts pane at any moment, and a snapshot
 * taken at boot would answer "not configured" until the app restarted.
 */
async function recommendations(deps: WebDeps, query: URLSearchParams): Promise<WebResponse> {
  const rawType = (query.get("type") ?? "").trim();
  // "all" is the browser's own name for "no filter" and is accepted as such, so
  // the UI can round-trip its select value without a special case. Anything
  // else that is not a reccd type is a 400: silently searching everything would
  // hide a typo behind a plausible-looking feed.
  let type: "movie" | "tv" | undefined;
  if (rawType && rawType !== "all") {
    if (rawType !== "movie" && rawType !== "tv") return { status: 400, json: { error: "invalid type" } };
    type = rawType;
  }
  const genre = (query.get("genre") ?? "").trim();
  const rawExplore = (query.get("explore") ?? "").trim();
  const explore = rawExplore === "true" || rawExplore === "1";

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl) {
    // 200 with its own status, NOT a 500 — the same call `/api/title` makes for
    // a missing OMDb key. Nothing is broken: the user has no reccd, and the
    // browser needs to be able to say "set up reccd" rather than looking like
    // the server fell over. Deliberately not cached, and reccd is not asked.
    const out: PublicRecommendations = { status: "not-configured" };
    return { status: 200, json: out };
  }

  const reccQuery: RecommendationQuery = { explore, limit: RECC_LIMIT };
  if (type) reccQuery.type = type;
  if (genre) reccQuery.genre = genre;

  // `fetchRecommendations` never throws and bounds itself with its own timeout,
  // so a reccd that is down or hanging costs this request that timeout and
  // nothing else — it cannot reject into the server's request handler.
  const result = await (deps.fetchRecommendationsImpl ?? fetchRecommendations)(reccConfig, reccQuery);
  if (!result.ok) {
    const out: PublicRecommendations = { status: "error", error: result.error };
    return { status: 200, json: out };
  }
  // Assigned, not spread or re-mapped: `Recommendation` and
  // `PublicRecommendation` are field-for-field the same, and this assignment is
  // where the compiler checks they still are. Nothing in a pick is private —
  // every field of it is already on screen in the TUI.
  const out: PublicRecommendations = { status: "ok", items: result.items };
  return { status: 200, json: out };
}

/**
 * `GET /api/title-search?q=` — reccd's catalog search, proxied.
 *
 * THIS ROUTE EXISTS SO THE BROWSER NEVER SEES `reccToken`. The TUI calls
 * `fetchTitleSuggestions` directly; a page cannot, and handing it the token so
 * it could would put the user's reccd credentials in a tab.
 *
 * `loadConfig()` per request, not a boot snapshot, for the same reason
 * `recommendations` does it: a reccd URL can be pasted into the Accounts pane
 * at any moment, and `serve --web` is a separate process from any running TUI.
 */
async function titleSearch(deps: WebDeps, query: URLSearchParams): Promise<WebResponse> {
  const raw = query.get("q");
  // Absent, not empty: a client that forgot the param is a bug worth a 400,
  // and it matches reccd's own behaviour for a missing q.
  if (raw === null) return { status: 400, json: { error: "missing q" } };

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl) {
    const out: PublicTitleSuggestions = { status: "not-configured" };
    return { status: 200, json: out };
  }

  // reccd answers a shorter query with [] and no DB round trip. Not asking is
  // the same answer without the round trip, and it keeps the min-length rule in
  // exactly one place (util/titleSuggest.ts) for both front ends.
  if (!shouldQuery(raw)) {
    const out: PublicTitleSuggestions = { status: "ok", items: [] };
    return { status: 200, json: out };
  }

  // `fetchTitleSuggestions` never throws and bounds itself with its own
  // timeout, so a reccd that is down or hanging costs this request that timeout
  // and nothing else.
  const result = await (deps.fetchTitleSuggestionsImpl ?? fetchTitleSuggestions)(reccConfig, {
    q: raw,
    limit: SUGGEST_LIMIT,
  });
  if (!result.ok) {
    const out: PublicTitleSuggestions = { status: "error", error: result.error };
    return { status: 200, json: out };
  }
  // Assigned, not re-mapped: the client already narrowed reccd's row to the
  // fields torlink renders, and this assignment is where the compiler checks
  // that `TitleSuggestion` and the wire type still agree.
  const out: PublicTitleSuggestions = { status: "ok", items: result.items };
  return { status: 200, json: out };
}

/** The event types this route will forward, as a set for the body check. */
const RECC_EVENTS: ReadonlySet<string> = new Set<PublicReccEventType>([
  "watched",
  "liked",
  "disliked",
  "favourited",
  "unfavourited",
  "abandoned",
]);

/**
 * `POST /api/recc-event` — forward one rating to reccd.
 *
 * NOTHING AWAITS THE POST, and that is the point rather than an oversight.
 * `postEvent` is deliberately fire-and-forget with a single attempt (read its
 * comment: retrying a dropped event during a reccd outage piles up concurrent
 * requests exactly when the target is struggling). Awaiting it here would undo
 * half of that at the HTTP layer — every rating click would hold a connection
 * open for reccd's full timeout while a user taps like on the next card, and a
 * reccd that hangs would turn into a queue of stuck requests inside the TUI's
 * own process. So the 200 says "accepted", meaning handed off, and says so in
 * the type.
 */
async function reccEvent(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return { status: 400, json: { error: "invalid JSON body" } };
  }

  const rawType = typeof body.type === "string" ? body.type.trim() : "";
  if (!RECC_EVENTS.has(rawType)) return { status: 400, json: { error: "invalid event type" } };
  // The one line that ties `PublicReccEventType` to reccd's own `ReccEventType`:
  // widen a member of the first into the second and the build fails the day the
  // wire union grows something the client cannot send.
  const type: ReccEventType = rawType as PublicReccEventType;

  const rawName = typeof body.rawName === "string" ? body.rawName.trim() : "";
  if (!rawName) return { status: 400, json: { error: "missing rawName" } };

  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl) {
    // Same clean answer as the feed. `postEvent` would no-op on this anyway;
    // saying so explicitly is what lets the browser stop offering the buttons.
    const out: PublicReccEventAck = { status: "not-configured" };
    return { status: 200, json: out };
  }

  // `ts` is the server's clock and `source` is fixed: both are ours to state.
  // A browser's clock can be years out, and an event that claims to be from
  // 2031 poisons a recommender's recency weighting for good.
  const event: ReccEvent = { type, rawName, ts: Date.now(), source: "torlink" };
  // `.catch` on top of postEvent's own swallowing: this promise is unwatched,
  // and an unhandled rejection from an injected impl would take the process
  // down — which is the exact "reccd must never take the daemon with it" rule
  // this route exists to honour.
  void (deps.postEventImpl ?? postEvent)(reccConfig, event).catch(() => {});

  const out: PublicReccEventAck = { status: "accepted" };
  return { status: 200, json: out };
}

/**
 * Which of the posted hashes the active provider has cached.
 *
 * 409, not an empty list, when the active provider cannot answer: an empty
 * `cached` array is a claim ("none of these are cached") and Real-Debrid — which
 * withdrew its instant-availability endpoint in 2024 — cannot make it. The
 * browser learns the same thing from `/api/sources`'s `debridCachedCheck` and
 * does not render the marker at all; this status is the guard for a client that
 * asks anyway.
 */
async function checkCached(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseObjectBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid JSON body" } };
  if (!Array.isArray(body.hashes)) {
    return { status: 400, json: { error: "hashes must be an array of info hashes" } };
  }
  const hashes = body.hashes.filter((h): h is string => typeof h === "string" && h.length > 0);
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const active = resolveActiveDebrid(config);
  if (!active || getDebridProvider(active.provider).checkCached === undefined) {
    return { status: 409, json: { error: "the active debrid provider cannot check cached availability" } };
  }
  if (hashes.length === 0) {
    const empty: CachedResponse = { cached: [] };
    return { status: 200, json: empty };
  }
  const cached = await (deps.checkCachedImpl ??
    ((p: DebridProviderId, t: string, h: string[]) => cachedHashesFor(getDebridProvider(p), t, h)))(
    active.provider,
    active.token,
    hashes,
  );
  const out: CachedResponse = { cached: hashes.map((h) => h.toLowerCase()).filter((h) => cached.has(h)) };
  return { status: 200, json: out };
}

// ---- casting ----------------------------------------------------------------
//
// Three routes and a status read. What is NOT here is the protocol, the discovery
// or the session bookkeeping: those are `src/core/cast/`, front-end-agnostic, and
// the TUI drives the same registry through the same methods. These routes only
// turn an HTTP request into one of those calls, and pick the URL a device fetches.

const NO_DEVICES = "No Chromecast found on this network.";
const NO_ORIGIN = "This machine has no network address a Chromecast could reach it on.";

/** What a device may be told about this file, as the browser sees a device. */
function toPublicCastDevice(device: CastDevice): PublicCastDevice {
  return { id: device.id, name: device.name, model: device.model };
}

/**
 * Every device that could be cast to: what answered, plus the configured address.
 *
 * The configured one goes last and only when discovery did not already report the
 * same host, so a user who typed an address that mDNS also finds sees one row.
 */
async function castDevices(deps: WebDeps): Promise<CastDevice[]> {
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const found = await (deps.discoverCastImpl ?? (() => discover()))();
  // Typed rather than trusted: `loadConfig` spreads the parsed JSON, so a
  // hand-edited `castDevice: 8009` would arrive here as a number.
  const manual = parseManualDevice(
    typeof config.castDevice === "string" ? config.castDevice : undefined,
  );
  if (!manual || found.some((d) => d.host === manual.host && d.port === manual.port)) return found;
  return [...found, manual];
}

async function castDevicesRoute(deps: WebDeps): Promise<WebResponse> {
  const devices = await castDevices(deps);
  const origin = (deps.castOriginImpl ?? (() => null))();
  // Two independent reasons casting cannot happen, and the file's own blockers
  // are a third the client already knows from `.info`. Naming which one is the
  // difference between "the network" and "this file" for the person looking at a
  // disabled button.
  const reason = devices.length === 0 ? NO_DEVICES : origin === null ? NO_ORIGIN : null;
  const out: CastDevicesResponse = {
    devices: devices.map(toPublicCastDevice),
    castable: reason === null,
    reason,
  };
  return { status: 200, json: out };
}

/** The status shape, shared by the route and the SSE event so a page has one parser. */
export function castStatusOf(casts: Runtime["casts"]): CastStatusResponse {
  const active = casts.active();
  return {
    casting: active
      ? {
          deviceName: active.device.name,
          title: active.title,
          state: active.status.state,
          positionSec: active.status.positionSec,
          durationSec: active.status.durationSec,
        }
      : null,
    notice: casts.takeNotice(),
  };
}

interface StartCastBody {
  deviceId?: unknown;
  sid?: unknown;
  index?: unknown;
  subtitleIndex?: unknown;
}

async function startCast(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  let body: StartCastBody;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: 400, json: { error: "invalid json body" } };
    }
    body = parsed as StartCastBody;
  } catch {
    return { status: 400, json: { error: "invalid json body" } };
  }
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  const sid = typeof body.sid === "string" ? body.sid : "";
  const index = typeof body.index === "number" ? body.index : NaN;
  if (!deviceId || !sid || !Number.isInteger(index)) {
    return { status: 400, json: { error: "missing deviceId, sid or index" } };
  }

  const session = deps.runtime.sessions.get(sid);
  if (!session) return { status: 404, json: { error: "unknown session" } };
  const file = session.files[index];
  if (!file) return { status: 404, json: { error: "unknown file" } };
  const device = (await castDevices(deps)).find((d) => d.id === deviceId);
  // 404 for a device that is not in the list, and it says nothing about whether
  // some other id would have been found.
  if (!device) return { status: 404, json: { error: "unknown device" } };

  const origin = (deps.castOriginImpl ?? (() => null))();
  if (origin === null) return { status: 409, json: { error: NO_ORIGIN } };

  const source = await (deps.castSourceImpl ??
    (() => Promise.resolve({ facts: classifyFromName(file.filename, session.name), hls: null })))(
    session,
    index,
  );
  const blockers = blockersFor(source.facts, CHROMECAST_PROFILE);
  // The ladder, with the Chromecast profile in place of the browser's: direct
  // play, then the provider's transcode, then an honest refusal. There is no
  // local-ffmpeg rung in this tree — `src/util/ffmpegBin.ts` is used only for
  // ffprobe — so a blocked file with no manifest cannot be cast, and says so.
  if (blockers.length > 0 && !source.hls) {
    return { status: 409, json: { error: `A Chromecast can't play this one — ${castRefusal(blockers)}.` } };
  }
  const useHls = blockers.length > 0 && source.hls !== null;
  const url = useHls
    ? source.hls!
    : `${origin}/stream/${sid}/${index}?k=${encodeURIComponent(session.capability)}`;

  // The subtitle handle, only when the index names something `<track>`-shaped —
  // the same guard the `.vtt` representation applies. Casting a video as a text
  // track would be a LOAD the device silently ignores.
  const subtitleFile =
    typeof body.subtitleIndex === "number" ? session.files[body.subtitleIndex] : undefined;
  const subtitle =
    subtitleFile && isBrowserRenderable(subtitleFile.filename)
      ? {
          subtitleUrl: `${origin}/stream/${sid}/${String(body.subtitleIndex)}.vtt?k=${encodeURIComponent(session.capability)}`,
          subtitleLabel: subtitleLanguage(subtitleFile.filename).label,
        }
      : {};

  try {
    await deps.runtime.casts.start({
      device,
      sid,
      index,
      infoHash: session.infoHash,
      filename: file.filename,
      title: playlistTitle(file.filename),
      media: {
        url,
        contentType: castContentType(extensionOf(file.filename), useHls),
        title: playlistTitle(file.filename),
        ...subtitle,
      },
    });
  } catch (e) {
    // A CastError's message is already fit for the screen — that is what the type
    // means. 502, because the failure is upstream of us: the device refused, or
    // never answered.
    const message = e instanceof CastError ? e.message : "Could not cast to that device.";
    return { status: 502, json: { error: message } };
  }
  return { status: 200, json: castStatusOf(deps.runtime.casts) };
}

/** The container is named first, because it is the blocker a user can recognise. */
function castRefusal(blockers: Blocker[]): string {
  if (blockers.includes("container")) return "a Chromecast won't demux this container";
  if (blockers.includes("video")) return "it can't decode this video codec";
  return "it can't decode this audio";
}

async function castCommand(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  let action = "";
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = (parsed as { action?: unknown }).action;
      if (typeof value === "string") action = value;
    }
  } catch {
    return { status: 400, json: { error: "invalid json body" } };
  }
  if (action !== "play" && action !== "pause" && action !== "stop") {
    return { status: 400, json: { error: "unknown action" } };
  }
  try {
    if (action === "play") await deps.runtime.casts.play();
    else if (action === "pause") await deps.runtime.casts.pause();
    else await deps.runtime.casts.stop();
  } catch (e) {
    // Nothing casting is a 409 and not a 500: the client asked for something
    // reasonable against state that has moved on, which is ordinary when a cast
    // ended on the device itself.
    const message = e instanceof Error ? e.message : "Nothing is casting.";
    return { status: 409, json: { error: message } };
  }
  return { status: 200, json: castStatusOf(deps.runtime.casts) };
}

/** True when `handleWebApi` owns this path; false means it is a static asset. */
export function isApiPath(urlPath: string): boolean {
  return urlPath.startsWith("/api/") || LEGACY_API_PATHS.has(urlPath);
}

/**
 * Pure router for the web layer. Shared routes delegate to the daemon's
 * existing `handleApi` rather than reimplementing them, so `/status` and
 * `/api/status` cannot drift apart. `/health` stays unauthenticated (it is how
 * a supervisor checks liveness); everything else requires the token when one
 * is configured.
 */
export async function handleWebApi(
  deps: WebDeps,
  method: string,
  urlPath: string,
  query: URLSearchParams,
  authHeader: string | undefined,
  bodyText: string,
): Promise<WebResponse> {
  const { runtime, token } = deps;

  // Legacy paths keep working exactly as before: /health, /status, /downloads,
  // /add, /control are a documented API that may already be scripted against.
  if (!urlPath.startsWith("/api/")) {
    return fromApi(await handleApi(runtime, token, method, urlPath, authHeader, bodyText));
  }

  if (!isAuthorized(token, authHeader)) {
    return { status: 401, json: { error: "unauthorized" } };
  }

  if (method === "GET" && urlPath === "/api/poster") {
    const url = query.get("url") ?? "";
    if (!url) return { status: 400, json: { error: "missing url" } };
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { status: 400, json: { error: "unsupported scheme" } };
      }
      host = parsed.hostname.toLowerCase();
    } catch {
      return { status: 400, json: { error: "invalid url" } };
    }
    // DELIBERATELY REDUNDANT: getPoster enforces this allowlist itself on every
    // hop, and that check is the authoritative one — do not delete it in favour
    // of this. This one exists only to pick the status code, because a refused
    // host is a 400 (the caller asked for something we won't do) while a cache
    // miss is a 404, and a null return can't tell the two apart.
    if (!POSTER_HOSTS.has(host)) return { status: 400, json: { error: "host not allowed" } };
    const hit = await (deps.getPosterImpl ?? getPoster)(url);
    if (!hit) return { status: 404, json: { error: "poster unavailable" } };
    return posterResponse(hit);
  }

  if (method === "GET" && urlPath === "/api/sources") {
    const config = await (deps.loadConfigImpl ?? loadConfig)();
    return {
      status: 200,
      json: sourcesResponse(config, deps.sourceHealthImpl ?? sourceHealth, Date.now()),
    };
  }

  if (method === "GET" && urlPath === "/api/saved") {
    return savedLists(deps);
  }

  if (method === "POST" && urlPath === "/api/saved-searches") {
    return savedSearchesAction(deps, bodyText);
  }

  if (method === "POST" && urlPath === "/api/library") {
    return libraryAction(deps, bodyText);
  }

  if (method === "POST" && urlPath === "/api/continue-watching") {
    return continueWatchingAction(deps, bodyText);
  }

  if (method === "POST" && urlPath === "/api/preferences") {
    return preferencesAction(deps, bodyText);
  }

  if (method === "GET" && urlPath === "/api/title") {
    return titleMeta(deps, query);
  }

  if (method === "POST" && urlPath === "/api/cached") {
    return checkCached(deps, bodyText);
  }

  // All three past the token gate above, and all three need it: none delegates
  // to handleApi, so this is the only check between an anonymous caller and the
  // user's taste profile or reccd's catalog — reading it, searching it, or
  // writing to it.
  if (method === "GET" && urlPath === "/api/recommendations") {
    return recommendations(deps, query);
  }

  if (method === "GET" && urlPath === "/api/title-search") {
    return titleSearch(deps, query);
  }

  if (method === "POST" && urlPath === "/api/recc-event") {
    return reccEvent(deps, bodyText);
  }

  // Ahead of the legacy passthrough below, which still owns `POST /add` and the
  // no-name/no-via shape this delegates back to.
  if (method === "POST" && urlPath === "/api/add") {
    return addToQueue(deps, authHeader, bodyText);
  }

  // ---- streaming -------------------------------------------------------
  // Everything below this line is past the token gate above. That gate is the
  // only thing standing between an anonymous caller and joining a swarm or
  // spending the user's Real-Debrid account, because — unlike /api/status —
  // none of these delegate to handleApi, which re-checks.

  if (method === "POST" && urlPath === STREAM_BASE) {
    return startStream(deps, bodyText);
  }

  // Casting. Past the same token gate, and it needs it for the same reason: none
  // of these delegates to handleApi, and `start` spends the user's debrid account
  // and puts their stream on a screen in their house.
  if (method === "GET" && urlPath === "/api/cast/devices") {
    return castDevicesRoute(deps);
  }

  if (method === "GET" && urlPath === "/api/cast/status") {
    return { status: 200, json: castStatusOf(deps.runtime.casts) };
  }

  if (method === "POST" && urlPath === "/api/cast/start") {
    return startCast(deps, bodyText);
  }

  if (method === "POST" && urlPath === "/api/cast/command") {
    return castCommand(deps, bodyText);
  }

  const sid = streamSessionId(urlPath);
  if (sid !== null) {
    const session = runtime.sessions.get(sid);
    // Unknown id is a 404 for both verbs, and says nothing about whether some
    // other client holds that session.
    if (!session) return { status: 404, json: { error: "unknown session" } };
    if (method === "GET") return { status: 200, json: toPublicSession(session) };
    if (method === "DELETE") {
      // `keep` is the WebTorrent backend's "leave the downloaded data on disk"
      // flag. Absent means discard, which is what a stream that was only ever
      // watched should do — the opposite default would quietly fill the disk
      // with temp copies of everything the user previewed.
      await runtime.sessions.stop(sid, { keep: query.get("keep") === "1" });
      return { status: 200, json: { stopped: true } };
    }
    return { status: 405, json: { error: "method not allowed" } };
  }

  // Everything else under /api/ maps onto the shared handler by stripping the
  // prefix, so /api/status, /api/add and /api/control are one implementation.
  const legacyPath = urlPath.slice("/api".length);
  if (
    (method === "GET" && (legacyPath === "/status" || legacyPath === "/downloads")) ||
    (method === "POST" && (legacyPath === "/add" || legacyPath === "/control"))
  ) {
    return fromApi(await handleApi(runtime, token, method, legacyPath, authHeader, bodyText));
  }

  return { status: 404, json: { error: "not found" } };
}
