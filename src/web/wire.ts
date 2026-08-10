// The wire format of the status payload, declared once for both ends.
//
// This is a *types-only* module and must stay that way: it imports nothing, so
// it drags in no Node builtin and no app module. That is what lets
// `src/web/static/dashboard.ts` — which is bundled with `platform: "browser"` —
// reference these types with `import type` (erased at build time) while
// `src/daemon/serve.ts` uses them as the declared return type of
// `statusPayload`. One declaration, checked at the producer and at the consumer.
//
// It lives here rather than in `src/web/static/` (a browser bundle the daemon
// must not import from) or in `src/download/types.ts` (the queue's internal
// shape, which is free to change without breaking a documented HTTP response).
// It is a wire contract owned by the web layer, so it sits at the top of that
// layer with no dependencies of its own.
//
// Why it exists at all: this shape has now drifted three times. A hand-copied
// `statusPayload` dropped `uploadSpeed`; the browser's own copy of these
// interfaces let `progress` be read as a 0..1 fraction when the producer sends
// an integer percent; and before this module there was no compile-time link at
// all, so renaming a field typechecked on both sides and rendered nothing.
//
// THE IMPORTS, and why neither breaks the rule above: both are `import type`,
// which TypeScript guarantees is erased at build time regardless of what the
// target module does — the specifier never reaches the emitted output, so it
// does not matter that `../util/releasePick` itself has a runtime import of
// its own (`./release`). `src/util/episode.ts` carries the narrower guarantee
// too, for the simpler reason: it declares a single interface and imports
// nothing itself, so there is nothing to drag in even if a future edit turned
// this line into a value import. `../util/releasePick` has no such second
// safety net — only the `import type` erasure protects it — so if that
// specifier is ever changed to a value import, it must be re-checked against
// the "imports nothing" rule above. Both are here because the alternative was
// a hand-written copy of the picker's shapes — `{ season, episode }` had
// already drifted once — the exact drift this file was created to stop.
// Anything with a runtime value in it still does not belong in this module.
import type { Blocker, EmbeddedSubtitle, MediaFacts } from "../util/playability";
import type { EpisodeRef } from "../util/episode";
import type { FeatureId, MaxResolution } from "../util/releasePick";
import type { TitleSuggestion } from "../util/titleSuggest";

/**
 * One in-flight (or paused / queued / failed) download.
 *
 * UNITS — the two conventions here are indistinguishable by inspection, so they
 * are spelled out. Get one wrong and the browser silently renders a plausible
 * wrong number:
 *
 * - `progress` is an **integer percent, 0–100** — `QueueItem.progress`, passed
 *   through unchanged, and exactly what the TUI prints as `${it.progress}%`. It
 *   is NOT a 0..1 fraction. A running torrent is capped at 99 by the queue, so
 *   100 means finished.
 * - `speed` is **bytes per second**.
 */
export interface StatusDownload {
  id: string;
  name: string;
  status: string;
  /** Integer percent, 0–100 (not a 0..1 fraction). */
  progress: number;
  peers: number;
  /** Bytes per second. */
  speed: number;
  /**
   * Why this download failed, when it did. Absent otherwise.
   *
   * `QueueItem.error` — the same string the TUI shows. The browser used to get
   * only the word `failed`, which told the user nothing they could act on: the
   * two most common values are "Set a Real-Debrid or TorBox token, then download
   * again" and a tracker's own refusal, and both are the difference between a
   * row you can fix and a row you can only delete.
   */
  error?: string;
}

/** One torrent being seeded. `uploaded` is bytes; `uploadSpeed` is bytes/sec. */
export interface StatusSeed {
  id: string;
  name: string;
  status: string;
  peers: number;
  /** Total bytes uploaded this session. */
  uploaded: number;
  /** Bytes per second. */
  uploadSpeed: number;
}

/** The body of GET /status, GET /downloads, GET /api/status and each SSE frame. */
export interface StatusPayload {
  downloads: StatusDownload[];
  seeds: StatusSeed[];
}

/**
 * One file inside a live stream session, as a browser is allowed to see it.
 *
 * This is deliberately NOT `StreamFile` (src/util/player.ts). That type carries
 * `url`, which is either a Real-Debrid unrestricted link — a bearer credential
 * against the user's account, valid from anywhere — or a
 * `http://localhost:<ephemeral>/…` WebTorrent URL that is meaningless to the
 * phone reading this JSON. Neither belongs in a response body, so the public
 * shape replaces the URL with a handle and nothing else changes.
 *
 * - `bytes` is the file's **total size in bytes**, not a transferred count.
 * - `index` is this file's position in the session's own file list, and is what
 *   `/stream/:sid/:idx` takes as `:idx`. It is NOT an index into a filtered
 *   video-only view: filtering happens in the client, and an index that meant
 *   different things on the two sides would silently play the wrong file.
 * - `handle` is a **path, not a URL** — `/stream/:sid/:idx`, no scheme, no host,
 *   no query. The server cannot know the origin the client reached it on (Host
 *   may be a LAN name, a tunnel, a reverse proxy), and guessing one from a
 *   request header is how redirect poisoning starts. The client resolves it
 *   against its own origin, and appends the capability as `?k=` itself.
 */
export interface PublicStreamFile {
  filename: string;
  /** Total size of the file in bytes. */
  bytes: number;
  /** Position in the session's file list; the `:idx` of the stream handle. */
  index: number;
  /** Path of the form `/stream/:sid/:idx` — not a URL, and with no `?k=`. */
  handle: string;
}

/**
 * A subtitle file that ships alongside the video in the same torrent, as the
 * browser is allowed to see it.
 *
 * `index` addresses it on `/stream/:sid/:idx.vtt`, the same grammar as the
 * video's own handle. `renderable` is false for ass/ssa/sub: those are matched
 * and offered to external players, but `<track>` cannot show them.
 */
export interface SubtitleFile {
  index: number;
  filename: string;
  /** BCP-47 tag ("en"), or "" when the filename gave no language. */
  language: string;
  /** Human label for a track menu: "English", "English (forced)". */
  label: string;
  renderable: boolean;
}

/**
 * `GET /stream/:sid/:idx.info?k=…` — what this file is, and how to play it.
 *
 * Capability-authenticated rather than bearer-authenticated, and that is the
 * whole reason it is a representation of the stream handle rather than a route
 * under `/api/`: the player page may be a phone that was handed a link, so it
 * has the session capability and not the server's token.
 *
 * Deliberately does NOT carry the upstream URL. That is a debrid unrestricted
 * link, i.e. a credential against the user's account; the page plays through
 * `/stream/:sid/:idx` and never learns where the bytes come from.
 */
export interface StreamInfoResponse {
  facts: MediaFacts;
  /** Empty means the browser should be able to play this file as it is. */
  blockers: Blocker[];
  /**
   * Empty means a Chromecast should be able to play this file as it is.
   *
   * Separate from `blockers` because the two decoders genuinely differ: a
   * Chromecast passes AC3 and E-AC3 through to the television, which no browser
   * will decode. See `CHROMECAST_PROFILE` (src/util/playability.ts) for the
   * trade-off that allows — silence on a TV whose HDMI link cannot take
   * passthrough — and for why HEVC stays blocked on both.
   */
  castBlockers: Blocker[];
  /** A provider HLS manifest the browser can play directly, or null. */
  hls: string | null;
  /**
   * What subtitles exist for this file. `embedded` is muxed inside it and is
   * reported only — nothing extracts it. `files` are siblings in the torrent,
   * fetchable as WebVTT from `/stream/:sid/:idx.vtt`.
   */
  subtitles: { embedded: EmbeddedSubtitle[]; files: SubtitleFile[] };
}

/**
 * `GET /stream/:sid/:idx.files?k=…` — everything else in this session.
 *
 * Capability-authenticated for the same reason `.info` is: the player page is a
 * separate document that knows only what its own URL tells it, and it may be a
 * phone that was handed a link, so it holds the session capability and not the
 * server's bearer token.
 *
 * WHY THE PLAYER PAGE NEEDS THIS AT ALL. Without it the page knows about one
 * file, so finishing an episode means going Back — which, before this, threw
 * the whole search away. The terminal never had that problem: its picker stays
 * open after launching a player (`src/ui/App.tsx`, `playFromPicker`) precisely
 * so the next episode is one keypress. This is the browser catching up.
 *
 * `files` REUSES `PublicStreamFile` rather than declaring a parallel shape, and
 * is produced by `toPublicSession` — so it inherits that function's guarantee
 * that the upstream URL (a debrid credential, or a useless localhost address)
 * is replaced by a `/stream/:sid/:idx` handle. A second mapping here would be
 * the fifth copy-then-drift bug in this codebase's ledger.
 *
 * It carries only the video candidates (`streamCandidates`), and it is in
 * SESSION ORDER — `index` addresses the session, so the two cannot be conflated.
 * Display order is the page's business and it applies the same
 * `sortStreamFiles` the picker does.
 */
export interface StreamFilesResponse {
  /** The session's release name, e.g. `Harrowgate.S03.1080p.WEB-DL`. */
  name: string;
  /**
   * The torrent this session is of.
   *
   * Here so the player page can record the episode it opened — `POST
   * /api/library {action:"watched"}` is keyed by info hash, and a page that
   * knows only its own URL has no other way to learn it. Not a disclosure: an
   * info hash is a torrent's public name, the search results the user clicked
   * through already carried it, and whoever holds this session's capability can
   * already stream every byte of the thing it identifies.
   */
  infoHash: string;
  files: PublicStreamFile[];
}

/**
 * A live stream session as a browser is allowed to see it. The body of
 * `GET /api/stream/:sid`, and the `session` field of the start response.
 *
 * THE CAPABILITY IS NOT IN HERE, AND MUST NEVER BE. It is minted once and
 * returned exactly once, in the `POST /api/stream` response, and never again in
 * any session body — so a session that is polled every second while it resolves
 * does not spray a media credential across a browser's network log, a proxy's
 * access log, and every `console.log(session)` a future dashboard adds.
 * `toPublicSession` (src/core/streamSession.ts) is the only producer, and it
 * builds this by picking fields, so a field added to `StreamSession` later
 * defaults to private rather than leaking.
 *
 * UNITS, matching StatusDownload above:
 *
 * - `progress` is an **integer percent, 0–100**. While `state` is `"resolving"`
 *   it is Real-Debrid's caching progress (which can sit mid-range for minutes);
 *   `"ready"` always reports 100.
 * - `state` mirrors `StreamSessionState`. The literal union is repeated rather
 *   than imported because this module imports nothing (see the header); the
 *   producer assigns it from the real type, so a divergence fails to compile
 *   there.
 * - `error` is present only in the `"error"` state, and carries the same
 *   message the TUI would have shown.
 */
export interface PublicStreamSession {
  id: string;
  backend: "debrid" | "torrent";
  name: string;
  state: "resolving" | "ready" | "error";
  /** Integer percent, 0–100 (not a 0..1 fraction). */
  progress: number;
  error?: string;
  files: PublicStreamFile[];
}

/**
 * The 200 body of `POST /api/stream`.
 *
 * The only place `capability` ever appears on the wire. It is a read-only,
 * session-scoped secret for clients that cannot send an `Authorization` header
 * (`<video>`, VLC, an `.m3u` handed to another app), passed as `?k=` on
 * `/stream/…` handles only — it satisfies no `/api/*` route.
 *
 * `sessionId` duplicates `session.id` deliberately: a client that only wants to
 * poll should not have to reach into a nested object, and the pair being
 * derived from one session means they cannot disagree.
 */
export interface StartStreamResponse {
  sessionId: string;
  capability: string;
  session: PublicStreamSession;
}

/**
 * The 409 body of `POST /api/stream` when Real-Debrid is configured but not
 * usable (`classifyStreamRoute` → `torrent-confirm`).
 *
 * This is a refusal, not a session: no swarm was joined and no bytes moved. The
 * server will not quietly fall back to P2P here, because the user deliberately
 * set Real-Debrid up and a fallback would put their own IP in a public swarm
 * without them knowing. The client shows `reason` and, if the user accepts,
 * repeats the request with `confirm: true`.
 */
export interface StreamConfirmResponse {
  route: "torrent-confirm";
  /** Human-readable, e.g. "your Real-Debrid plan isn't active". */
  reason: string;
}

/**
 * One search hit as a browser is allowed to see it — the payload of every
 * `event: results` frame on `GET /api/search`.
 *
 * BUILT BY PICKING FIELDS (`toPublicResult` in routes.ts). `TorrentResult` is a
 * source-layer type that any of 23 scrapers may grow a field on; picking means
 * a new one is private until a human adds a line here.
 *
 * `magnet` IS DELIBERATELY ABSENT, and this is the one field worth arguing
 * about, so the reasoning is written down:
 *
 * - Nothing in the browser needs it. `POST /api/stream` takes `{infoHash,
 *   name}` and rebuilds the magnet server-side with `parseInput`, which for a
 *   bare hash wraps it in the same eleven public trackers `buildMagnet` gives
 *   every other add. Playing and adding both work from the hash alone.
 * - It is by far the largest field — 800–1500 bytes of percent-encoded tracker
 *   list against ~150 bytes for everything else here — and every one of the up
 *   to 23 snapshot frames repeats the *whole* result list. On a 200-hit search
 *   that is the difference between ~700KB and ~6MB over one connection.
 * - It is the only field that is a handle to *act* rather than a fact to show.
 *   Keeping it server-side means a browser can only reach the swarm through a
 *   route that validated the hash first.
 *
 * The cost, recorded so it is not rediscovered: the legacy `POST /add` takes
 * only a magnet or hash and derives the queue item's name from the magnet's
 * `dn`, so adding by bare hash names the download after its info hash. A
 * browser "add to queue" needs a name-carrying add path (or `/api/stream`'s
 * shape) — it must NOT be fixed by putting the magnet back on the wire.
 *
 * `sources` is always present here (possibly a single-element array), unlike
 * `TorrentResult.sources` which is optional until `mergeDuplicateResults` runs.
 * `sizeBytes` is bytes; `added` is epoch ms, absent when the source gave none.
 */
export interface PublicSearchResult {
  infoHash: string;
  name: string;
  /** Total size in bytes. */
  sizeBytes: number;
  seeders: number;
  leechers: number;
  numFiles?: number;
  /** The healthiest source id this hit came from. */
  source: string;
  /** Every source that returned this info hash; never empty. */
  sources: string[];
  /** Epoch ms the source published it, when it reports one. */
  added?: number;
}

/**
 * One source's state within a search, mirroring `SourceState` in core/search.
 *
 * `error` is the human message and `code` the short form ("timed out", "HTTP
 * 503", "no response"). Both are non-null exactly when that source failed, and
 * they are on the wire on purpose: a search where eight trackers quietly
 * returned nothing must not look the same to a browser as one where they
 * returned no matches.
 */
export interface PublicSourceState {
  loading: boolean;
  error: string | null;
  code: string | null;
  count: number;
}

/**
 * The payload of an `event: results` frame, and of the final `event: done`.
 *
 * `perSource` is keyed by source id and contains only the sources actually
 * being searched — benched ones are dropped by `runSearch` before it starts, so
 * `total` is that count and not the size of the registry. `done`/`total` is the
 * browser's "12/23 sources" line.
 */
export interface PublicSearchSnapshot {
  results: PublicSearchResult[];
  perSource: Record<string, PublicSourceState>;
  done: number;
  total: number;
}

/**
 * One entry of `GET /api/sources`.
 *
 * Source ids and group names are typed `string` rather than the real unions
 * because this module imports nothing (see the header); the producer assigns
 * them from `SourceId`/`SourceGroup`, so a divergence fails to compile there.
 *
 * - `enabled` is the user's `disabledSources` choice, not a health verdict. The
 *   browser shows disabled sources greyed rather than hiding them, so the list
 *   matches the TUI's; adult sources are omitted from the response entirely
 *   when the adult category is off.
 * - `benchedUntil` is epoch ms, or null when the source is not benched. `fails`
 *   is the consecutive-failure count behind that.
 */
export interface PublicSource {
  id: string;
  label: string;
  groups: string[];
  adult: boolean;
  homepage: string;
  /** False when the source's feed carries no swarm counts, so `seeders: 0` means unknown. */
  reportsHealth: boolean;
  enabled: boolean;
  fails: number;
  /** Epoch ms until which this source is skipped, or null. */
  benchedUntil: number | null;
}

/** The category tabs, in the TUI's order, each listing its source ids. */
export interface PublicSourceGroup {
  group: string;
  sourceIds: string[];
}

/**
 * The viewing preference, over the wire. `maxResolution` is `null` rather than
 * absent so the browser round-trips "no limit" explicitly — the same reason
 * `/api/recommendations` sends `type=all` rather than omitting it.
 */
export interface PublicQualityPrefs {
  maxResolution: MaxResolution | null;
  require: FeatureId[];
  exclude: FeatureId[];
}

/** The body of `POST /api/preferences`. One action: replace the whole preference. */
export interface PreferencesRequest {
  action: "set";
  preferences: PublicQualityPrefs;
}

/** The 200 body of `POST /api/preferences` — the sanitised value actually stored. */
export interface PreferencesResponse {
  preferences: PublicQualityPrefs;
}

/**
 * The reccd account this install is using, or null when there isn't one.
 *
 * The name is not a credential — it is what the user logs in *with* once
 * claimed, and reccd shows it publicly — so unlike `reccToken` it is safe to
 * put on the wire. The token never is.
 *
 * Nested rather than a flat `reccClaimed: boolean` on purpose: a flat boolean
 * is false both for "unclaimed account" and "no account at all", so every
 * reader would have to cross-reference something else to tell them apart, and
 * one reader eventually won't.
 */
export interface PublicReccAccount {
  name: string;
  claimed: boolean;
}

/** The body of `GET /api/sources`. */
export interface SourcesResponse {
  groups: PublicSourceGroup[];
  sources: PublicSource[];
  /** Whether the adult category is on; when false no adult source appears above. */
  adultEnabled: boolean;
  /**
   * Whether a debrid token is configured for whichever provider is active —
   * Real-Debrid or TorBox (file or their respective env vars).
   *
   * A capability flag, not a credential — the token itself never crosses this
   * wire. It is here rather than on its own route because this response is the
   * one thing the search UI fetches before it can render anything, and the
   * decision it drives is a search-result decision: the TUI offers `r`
   * (the active debrid provider) on a result only when `debridConfigured`, and
   * warns about the swarm before a P2P add only when it is true. The browser
   * has to make the same two choices and cannot read the user's config.
   *
   * It is NOT a health verdict. A configured-but-lapsed account still reports
   * true here and fails at the add, with the provider's own message — the same
   * thing the TUI does, and deliberately not a silent downgrade to P2P.
   */
  debridConfigured: boolean;
  /**
   * Which debrid service resolves magnets, or null when none is configured.
   * A capability flag like `debridConfigured`, never a credential: it is what
   * lets the browser label its add button the way the TUI labels `r`.
   */
  debridProvider: "realdebrid" | "torbox" | null;
  /**
   * Whether the active provider can answer "is this cached?".
   *
   * TorBox can; Real-Debrid cannot — it withdrew its instant-availability
   * endpoint in 2024. When false the browser shows no cached marker at all,
   * rather than an "unknown" state that would read as "not cached".
   */
  debridCachedCheck: boolean;
  /**
   * Whether an OMDb API key is configured (file or `TORLINK_OMDB_KEY`).
   *
   * A capability flag, never the key — the same contract as
   * `debridConfigured` above, and here for the same reason: this response is
   * the one thing the search UI fetches before it can render anything.
   *
   * WHAT IT SAVES. Without it, a keyless server has every visible result row
   * fire a `/api/title` lookup purely to be told `{status: "no-key"}` — one
   * round trip per row to learn a fact that is true for the whole page. With
   * it the browser fetches no artwork at all and shows the one setup hint.
   * That difference IS the graceful degradation.
   */
  omdbConfigured: boolean;
  /**
   * Whether reccd is configured (file or `TORLINK_RECC_URL`), which is what
   * makes title autocomplete available.
   *
   * A capability flag, never the URL or the token — the same contract as
   * `debridConfigured` and `omdbConfigured`, and here for the same reason:
   * this is the one payload the browser fetches before it can render anything.
   *
   * WHAT IT SAVES. Without it, a reccd-less server has every keystroke in the
   * search box fire `/api/title-search` purely to be told
   * `{status: "not-configured"}` — a request per character to learn a fact
   * that is true for the whole session.
   */
  reccConfigured: boolean;
  /**
   * The reccd account, or null when none is known. Null covers both "no reccd
   * configured" and "a self-hosted reccd configured by hand", which never went
   * through auto-provisioning and so has no name recorded — claiming does not
   * apply to it.
   *
   * Distinct from `reccConfigured` above, and both are needed: that one answers
   * "can this server reach reccd at all", which gates autocomplete; this one
   * carries who the account is and whether it has a password yet, which is what
   * lets the browser name it and point at the terminal to claim it. A reachable
   * reccd with no provisioned account reports `true` and `null` respectively.
   */
  reccAccount: PublicReccAccount | null;
  /**
   * The stored viewing preference — quality-picker state the TUI has always
   * had. It rides on this response rather than getting its own `GET` route for
   * the same reason `debridConfigured` and `omdbConfigured` do: this is the one
   * payload the browser fetches before it can render anything, so folding the
   * preference in costs no extra round trip. Writing is still its own route,
   * `POST /api/preferences`, because a write needs its own request body and
   * status code independent of what else this response reports.
   */
  preferences: PublicQualityPrefs;
}

/**
 * The non-secret settings the web UI may read and write, over the wire. The
 * settings overlay renders its controls from this snapshot; `POST /api/settings`
 * writes it back.
 *
 * What is DELIBERATELY ABSENT, and stays TUI-only: every token (Real-Debrid,
 * TorBox, reccd, OMDb), and the host-specific network config — DNS, extra
 * trackers, the VPN kill-switch interface, and the cast host/device. Tokens are
 * credentials the browser must never see (the whole `/api/sources` capability-
 * flag design exists to avoid it); the network fields are configuration a client
 * of this config does not get to change.
 *
 * The four limits are `number | null` rather than absent for "no limit", so the
 * browser round-trips the cleared state explicitly — the same reason
 * `PublicQualityPrefs.maxResolution` is nullable.
 */
export interface PublicWritableSettings {
  downloadDir: string;
  /** The media-player command, or "" for auto-detect. */
  mediaPlayer: string;
  adultContent: boolean;
  proxyDebridStreams: boolean;
  downloadLimitKbps: number | null;
  uploadLimitKbps: number | null;
  seedRatio: number | null;
  seedMinutes: number | null;
  /** Ids of sources the user has switched off. */
  disabledSources: string[];
  /** The viewing preference, the same shape `POST /api/preferences` writes. */
  preferences: PublicQualityPrefs;
}

/**
 * Which settings an environment variable currently controls, so the overlay can
 * render them read-only rather than offering a write the server will refuse.
 * Mirrors the TUI, which shows "controlled by the TORLINK_* env var" and
 * declines the toggle. Only the two writable fields that have an env override
 * appear here (`TORLINK_ADULT`, `TORLINK_PLAYER`).
 */
export interface SettingsEnvLocks {
  adultContent: boolean;
  mediaPlayer: boolean;
}

/**
 * Read-only account/capability status for the settings overlay's Accounts
 * section. Booleans and ids only — never a token, exactly like
 * `SourcesResponse`. Accounts are configured in the terminal; the browser shows
 * their status and points the user there.
 */
export interface SettingsAccounts {
  debridConfigured: boolean;
  debridProvider: "realdebrid" | "torbox" | null;
  omdbConfigured: boolean;
  reccConfigured: boolean;
  reccAccount: PublicReccAccount | null;
}

/**
 * The body of both `GET /api/settings` and `POST /api/settings` — one shape, so
 * the browser re-renders the overlay from the write's response with no second
 * fetch. `refused` lists any field the write skipped because an env var controls
 * it; it is always `[]` on the GET.
 */
export interface SettingsResponse {
  settings: PublicWritableSettings;
  envLocks: SettingsEnvLocks;
  accounts: SettingsAccounts;
  refused: string[];
}

/**
 * The body of `POST /api/settings`. One action, `"set"`, that MERGES the given
 * fields (a partial patch) rather than replacing the whole object — so the
 * overlay can send just the control that changed. Env-locked fields in the patch
 * are ignored and reported in `SettingsResponse.refused`.
 */
export interface SettingsRequest {
  action: "set";
  settings: Partial<PublicWritableSettings>;
}

/**
 * The body of `POST /api/add`.
 *
 * This route existed before the search UI as a thin alias for the legacy
 * `POST /add`, which takes a magnet (or bare hash) and nothing else. Both extra
 * fields here are additive and both are optional, so a request that sends
 * neither is handled by the legacy path unchanged — scripted callers of
 * `/api/add` and of `/add` see exactly what they saw before.
 *
 * WHY `name` HAD TO EXIST. `PublicSearchResult` deliberately carries no magnet
 * (see above), so a browser adding a search hit can only send its info hash —
 * and the legacy path derives the queue item's name from the magnet's `dn`,
 * which a hash-only magnet does not have. Every add from the browser would have
 * been a queue row named after 40 hex characters. The fix is this field, not
 * putting the magnet back on the wire: that was a ~6MB-per-search decision.
 *
 * `via` mirrors the TUI's two download keys — `d` (peer-to-peer, which prompts
 * about swarm exposure when Real-Debrid is configured) and `r` (Real-Debrid).
 * It is required to be explicit rather than inferred from config, because
 * "which network did my IP just go out over" is not a question a server should
 * answer on the user's behalf. Absent means the legacy behaviour: P2P.
 */
export interface AddRequest {
  magnet?: string;
  infoHash?: string;
  /** Display name for the queue row. Without it a hash-only add is named after its hash. */
  name?: string;
  /** Total size in bytes, when known; seeds the Real-Debrid row's progress total. */
  sizeBytes?: number;
  /** `"p2p"` (default) or `"debrid"`. Never inferred from whether a token exists. */
  via?: "p2p" | "debrid";
}

/** The 200 body of `POST /api/add`, unchanged from the legacy route. */
export interface AddResponse {
  ok: true;
  outcome: "added" | "duplicate";
}

/**
 * The body of `POST /api/export` — write a search hit's .torrent file out
 * without downloading its content. The TUI's `e` in the results detail view.
 *
 * Same shape as `AddRequest` for the same reason: `PublicSearchResult` carries
 * no magnet, so the browser sends the bare hash and the name, and the server
 * rebuilds the magnet. `name` is what the exported file is called.
 */
export interface ExportTorrentRequest {
  magnet?: string;
  infoHash?: string;
  name?: string;
}

/**
 * The 200 body of `POST /api/export`.
 *
 * `file` is a path on the SERVER, not a download the browser receives — the
 * export lands next to the user's other downloads exactly as the TUI's `e`
 * does. Saying so is the point of returning the path rather than a bare `ok`:
 * on a remote dashboard, "exported" without a location is a claim the user
 * cannot check.
 */
export interface ExportTorrentResponse {
  ok: true;
  file: string;
}

/**
 * What a release name parsed to, when `GET /api/title` was asked with `?release=`.
 *
 * PARSING HAPPENS ON THE SERVER, and this field is why the browser can live
 * without it. The TUI reads a title and year out of a release name with
 * `parse-torrent-title` (via `src/util/release.ts`), and a second parser in the
 * browser would mean the two surfaces disagreed about what "Kestrel.2010.1080p"
 * is — a divergence with no test that could catch it, since neither side would
 * be wrong on its own. So the browser posts the raw release name and gets the
 * TUI's answer back, alongside the OMDb lookup that answer produced.
 */
export interface PublicTitleParse {
  title: string;
  /** Four-digit year, or null when the name carried none. */
  year: number | null;
  /** What OMDb was asked for: a film, a series, or null for "let OMDb decide". */
  type: "movie" | "series" | null;
}

/**
 * The body of `GET /api/title` — always 200, always one of these three.
 *
 * The three-way split is the point. "The server has no OMDb key" and "OMDb was
 * asked and had nothing" are different things to a user: the first is fixable
 * by pasting a key and the UI should say so, the second is just a title OMDb
 * doesn't know. A shape that answered both with nulls would make the setup hint
 * impossible to render, and a 500 for the no-key case would make a perfectly
 * healthy install look broken.
 *
 * - `"ok"` means OMDb answered. Any of the three fields may still be null —
 *   that is "looked up, found nothing for this field", and is distinct from
 *   both other statuses.
 * - `"no-key"` means no `omdbApiKey` (and no `TORLINK_OMDB_KEY`) is configured.
 *   Nothing was requested.
 * - `"error"` means the lookup was attempted and failed: not found, a rejected
 *   key, OMDb down, a timeout. `error` is OMDb's own message where it has one.
 *
 * `posterUrl` is guaranteed to be either null or a URL on the poster CDN
 * allowlist, so it can be handed straight to `/api/poster?url=`.
 *
 * `parsed` is present exactly when the request used `?release=` — the caller
 * handed over a raw release name and the server parsed it. It is optional
 * rather than always-present so an `?imdb=` or `?name=` request (which parsed
 * nothing) answers with the same body it always did, and so a client cannot
 * mistake "you didn't ask me to parse" for "that name has no title in it".
 *
 * `type` is the medium OMDb itself reported for an `"ok"` answer — distinct
 * from `parsed.type`, which is what the *caller* asked OMDb to narrow the
 * search to. It is optional for the same reason every other field on this type
 * that can be absent is: several tests construct a `PublicTitleMeta` directly,
 * and a required field would break all of them for no benefit. This is the
 * only place the browser can learn a title's medium (Task 14 gates the Play
 * button on it), so it belongs on this route rather than a new one.
 */
export type PublicTitleMeta =
  | {
      status: "ok";
      imdbId: string | null;
      plot: string | null;
      posterUrl: string | null;
      type?: "movie" | "series" | null;
      parsed?: PublicTitleParse;
    }
  | { status: "no-key"; parsed?: PublicTitleParse }
  | { status: "error"; error: string; parsed?: PublicTitleParse };

/** One reccd pick, as `GET /api/recommendations` hands it to the browser. */
export interface PublicRecommendation {
  /** `tt…`. Doubles as the key for the per-card `/api/title?imdb=` poster lookup. */
  imdbId: string;
  title: string;
  year: number;
  score: number;
  /** reccd's own "because you liked …" lines, strongest first. Free text from a remote service. */
  reasons: string[];
}

/**
 * The body of `GET /api/recommendations` — always 200, always one of these three.
 *
 * DELIBERATELY THE SAME SHAPE AS `PublicTitleMeta`, for the same reason, and it
 * should stay that way: "the server has no reccd configured" is not a failure,
 * it is a thing the UI has to be able to *say* ("set up reccd to get
 * recommendations"), and a 500 for it makes a healthy install look broken. A
 * third bespoke encoding of that same idea — an empty `ok`, a 404, a `null` —
 * would be drift, and the browser would grow a third way to ask the question.
 *
 * - `"ok"` means reccd answered. `items` may still be empty: that is "reccd
 *   knows you but has nothing to suggest yet", which is distinct from both
 *   other statuses.
 * - `"not-configured"` means no `reccUrl` (and no `TORLINK_RECC_URL`). Nothing
 *   was requested.
 * - `"error"` means reccd was asked and it failed: unreachable, a rejected
 *   token, a malformed body. `error` is `fetchRecommendations`' own message, so
 *   the browser and the TUI show the user the same sentence.
 */
export type PublicRecommendations =
  | { status: "ok"; items: PublicRecommendation[] }
  | { status: "not-configured" }
  | { status: "error"; error: string };

/**
 * The body of `GET /api/title-search?q=`.
 *
 * THE SAME THREE-WAY SHAPE AS `PublicRecommendations` AND `PublicTitleMeta`,
 * deliberately: "the server has no reccd" is a thing the UI must be able to
 * say, not a failure, and a fourth bespoke encoding of that idea would be
 * drift.
 *
 * `"error"` carries reccd's own message so the browser and the TUI could show
 * the same sentence — but the browser deliberately does not. This fires per
 * keystroke, and an error banner per character is worse than no suggestions,
 * so the browser renders every non-`"ok"` status as an empty list. The field
 * is here because throwing the reason away at the wire would make a broken
 * reccd indistinguishable from a working one with no matches.
 */
export type PublicTitleSuggestions =
  | { status: "ok"; items: TitleSuggestion[] }
  | { status: "not-configured" }
  | { status: "error"; error: string };

/**
 * The event types `POST /api/recc-event` will forward.
 *
 * A deliberate SUBSET of `ReccEventType` (src/recc/client.ts): `"started"` is
 * emitted by the code that actually starts a stream, not by a button, so
 * accepting it here would let a browser fabricate watch history. The two unions
 * are tied together at the route, which assigns a value of this type into a
 * `ReccEventType` — add a member here that reccd's client does not know and the
 * build fails there rather than at runtime in front of reccd.
 */
export type PublicReccEventType =
  | "watched"
  | "liked"
  | "disliked"
  | "favourited"
  | "unfavourited"
  | "abandoned";

/** The request body of `POST /api/recc-event`. `ts` and `source` are the server's to set. */
export interface ReccEventRequest {
  type: PublicReccEventType;
  /** What was rated. The pick's title, as reccd itself returned it. */
  rawName: string;
}

/**
 * The 200 body of `POST /api/recc-event`.
 *
 * `"accepted"` means handed to `postEvent`, NOT delivered — the post is
 * fire-and-forget by design (see the comment on `postEvent`), so the route
 * cannot honestly promise more and does not wait to find out. Same
 * not-configured story as the feed: nothing is broken, there is simply nowhere
 * to send it, and that is a 200 the UI can read rather than a 500.
 */
export type PublicReccEventAck = { status: "accepted" } | { status: "not-configured" };

/**
 * One favourited torrent, as `GET /api/saved` hands it to the browser.
 *
 * TWO FIELDS ARE DELIBERATELY ABSENT.
 *
 * The MAGNET, because the page has no use for it: playing a favourite goes
 * through `POST /api/stream { infoHash, name }`, which rebuilds the magnet
 * server-side with the default tracker list. Shipping it would put a few hundred
 * bytes of tracker URLs per row on the wire to no end.
 *
 * The watched FILENAMES, replaced by a count. The pane renders "3 watched", so
 * the count is the whole requirement — and the filenames are strings from inside
 * a stranger's torrent, which is not something to hand a browser without a
 * reason.
 */
export interface PublicFavourite {
  /** The info hash, which is also the dedupe key. */
  id: string;
  name: string;
  sizeBytes?: number;
  source?: string;
  /** Epoch ms. */
  addedAt: number;
  /** How many episodes have been streamed, NOT which ones. */
  watched: number;
}

/**
 * One title the user is part-way through, as `GET /api/saved` sends it.
 *
 * The MAGNET is absent for the reason it is absent from `PublicFavourite`:
 * playing goes through `POST /api/stream { infoHash, name }`, which rebuilds it
 * server-side, so shipping it would be tracker URLs on the wire to no end.
 *
 * `next` is computed server-side by `nextEpisode` and is a SUGGESTION — null
 * for a film and for a season pack, which names a season but no episode.
 */
export interface PublicStreamHistoryItem {
  key: string;
  title: string;
  year?: number;
  type?: "movie" | "series";
  season?: number;
  episode?: number;
  next: EpisodeRef | null;
  rawName: string;
  infoHash: string;
  startedAt: number;
}

/**
 * The body of `GET /api/saved` — both saved lists in one response.
 *
 * One route rather than two because the `saved` pane shows both lists at once,
 * so two routes would mean two round trips for one screen.
 *
 * The names are the TUI's and are load-bearing: `savedSearches` is
 * `config.savedSearches` (search query strings) and `library` is
 * `config.favourites` (pinned torrents). Both clients read and write the same
 * config file, so a browser that renamed either would show a different list
 * under the same word.
 *
 * `continueWatching` is the stream-history store (Task 2), newest first, each
 * mapped by `toPublicStreamHistoryItem`.
 */
export interface SavedResponse {
  savedSearches: string[];
  library: PublicFavourite[];
  continueWatching: PublicStreamHistoryItem[];
}

/**
 * The body of `POST /api/saved-searches`.
 *
 * `toggle` mirrors the TUI's `w` key: save this query, or unsave it if it is
 * already there. `remove` is a separate, idempotent action rather than a second
 * toggle, for the ✕ in the list — a toggle there would RE-ADD a row the user
 * just deleted if the click double-fired, which on a phone it does.
 */
export interface SavedSearchesRequest {
  query: string;
  action: "toggle" | "remove";
}

/**
 * The 200 body of `POST /api/saved-searches`.
 *
 * The whole list comes back, not just the verdict, so the browser never has to
 * predict server state: it flips the button optimistically and then renders
 * whatever this says. `saved` is the state of THIS query afterwards, which the
 * caller would otherwise have to search the list for.
 */
export interface SavedSearchesResponse {
  saved: boolean;
  savedSearches: string[];
}

/**
 * The body of `POST /api/library`.
 *
 * IDENTIFIED BY INFO HASH, WITH NO MAGNET, and that is forced rather than
 * chosen: `PublicSearchResult` carries no magnet (it would be ~6MB a search)
 * while a stored favourite REQUIRES one — `isFavouriteItem` drops an entry
 * without it. The server bridges that with `buildMagnet(infoHash, name)`, the
 * same reconstruction `POST /api/stream` already does for a hash-only play. So
 * `name` is not decoration here: it becomes the magnet's `dn` and the row's
 * label, and without it a favourite is 40 hex characters.
 *
 * `"watched"` records one episode filename against an existing favourite,
 * mirroring the TUI's `markWatchedInFavourite`. It requires `filename`.
 */
export interface LibraryRequest {
  /** 40 hex characters, or 32 base32. Also the dedupe key. */
  infoHash: string;
  name: string;
  sizeBytes?: number;
  source?: string;
  action: "toggle" | "remove" | "watched";
  /** Required for `"watched"`, ignored otherwise. */
  filename?: string;
}

/** The 200 body of `POST /api/library`. Same contract as `SavedSearchesResponse`: the caller renders what comes back. */
export interface LibraryResponse {
  /** Whether THIS torrent is in the library afterwards. */
  favourited: boolean;
  library: PublicFavourite[];
}

/**
 * The body of `POST /api/continue-watching`.
 *
 * ONE ACTION, not `"toggle"`: nothing plays a title and then un-plays it, so
 * there is nothing for a toggle to mean here. `key` rather than `infoHash`
 * because it is `PublicStreamHistoryItem.key` — the store's own dedupe key,
 * one row per title rather than per stream — so it identifies the row the
 * user actually clicked remove on even if two entries somehow shared an info
 * hash.
 */
export interface ContinueWatchingRequest {
  key: string;
  action: "remove";
}

/** The 200 body of `POST /api/continue-watching`. Same contract as `LibraryResponse`: the caller renders what comes back. */
export interface ContinueWatchingResponse {
  continueWatching: PublicStreamHistoryItem[];
}

/**
 * `POST /api/cached` — which of these torrents the active debrid provider
 * already has, so a result can be marked before the user commits to it.
 *
 * Info hashes only: a search result carries no magnet on this wire (that was a
 * ~6MB-per-search decision) and a hash is all the provider needs.
 */
export interface CachedRequest {
  hashes: string[];
}

/** Lowercase hex info hashes the provider has cached. A subset of the request. */
export interface CachedResponse {
  cached: string[];
}

/**
 * One Chromecast, as the browser sees it.
 *
 * NOTE WHAT IS OMITTED: `host` and `port`. The page picks a device by `id` and
 * the server holds the address, because a page has no use for it and publishing
 * the LAN topology of the user's house to any tab buys nothing.
 */
export interface PublicCastDevice {
  id: string;
  name: string;
  /** e.g. "Chromecast". Empty when the device did not say. */
  model: string;
}

/**
 * `GET /api/cast/devices` — what can be cast to, and why not when nothing can.
 *
 * `castable` is not just "the list is non-empty": casting also needs an address
 * on this machine that a device could fetch from, which a loopback-bound server
 * does not have. `reason` is null while discovery has not finished, which is what
 * lets the button say "Finding devices…" rather than "none found".
 */
export interface CastDevicesResponse {
  devices: PublicCastDevice[];
  castable: boolean;
  reason: string | null;
}

/**
 * `GET /api/cast/status`, and the `cast` SSE event — the same shape, so a page
 * has one parser for both.
 *
 * `positionSec` is state, not a store: nothing in torlink persists a playback
 * position (`StreamHistoryItem` tracks a season and an episode), so this drives
 * the line on screen and is never written to disk.
 */
export interface CastStatusResponse {
  casting: null | {
    deviceName: string;
    title: string;
    state: "loading" | "playing" | "paused" | "idle";
    positionSec: number;
    /** Null when the device has not said — a manifest it is still reading. */
    durationSec: number | null;
  };
  /** A cast that ended badly, handed over exactly once. */
  notice: string | null;
}
