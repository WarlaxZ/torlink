import { promises as fs } from "node:fs";
import { configFile, defaultDownloadDir } from "./paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";
import { parseDnsServers } from "../util/dns";
import type { SourceId } from "../sources/types";
import type { ReccClientConfig } from "../recc/client";
import type { DebridProviderId } from "../integrations/debrid/types";
import {
  isFeatureId, isMaxResolution, NO_PREFS,
  type FeatureId, type MaxResolution, type QualityPrefs,
} from "../util/releasePick";
import { OWNER_PROFILE, isOwnerProfile } from "../core/profile";

// A pinned VIDEO torrent/series to return to, remembering which episodes have
// been streamed. Never stores stream URLs — only the magnet + metadata, so it
// is always re-resolved fresh (URLs rotate/embed session ports).
export interface FavouriteItem {
  id: string; // infoHash — dedupe key
  name: string;
  magnet: string;
  source?: SourceId;
  sizeBytes?: number;
  addedAt: number;
  watched?: string[]; // episode filenames already streamed
}

/** One friend's isolated lists. Mirrors the owner's top-level fields. */
export interface ProfileState {
  favourites?: FavouriteItem[];
  savedSearches?: string[];
  reccToken?: string;
  reccAccountName?: string;
  reccAccountClaimed?: boolean;
}

export interface Config {
  downloadDir: string;
  // Real-Debrid API token. Stored as-is in config.json (the user opted out of
  // encryption); a REALDEBRID_API_TOKEN env var overrides it at read time, so
  // those who prefer it can keep the token off disk entirely.
  realDebridToken?: string;
  // TorBox API token. Stored as-is in config.json, same trade-off as
  // realDebridToken above; a TORBOX_API_TOKEN env var overrides it at read time.
  torBoxToken?: string;
  // Which debrid service resolves magnets when more than one token is set.
  // Stored as an opaque string: an unrecognised value is ignored rather than
  // treated as "nothing configured" (see resolveActiveDebrid).
  debridProvider?: string;
  // Base URL of the reccd recommendation service, e.g. http://localhost:4100
  reccUrl?: string;
  // Bearer token for authenticating with reccd
  reccToken?: string;
  // The reccd account's name, for display in the Accounts pane. Written once
  // when an account is auto-provisioned, and afterwards only by the TUI, and
  // only when GET /profile reports something different -- see
  // src/recc/provision.ts for why this must not become a write-per-poll.
  reccAccountName?: string;
  // Whether that account has a username and password of the user's choosing.
  // Persisted rather than fetched because `/api/sources` is the one payload the
  // browser fetches before it can render anything, and it must not grow a
  // network round trip to learn a fact that changes once per account lifetime.
  reccAccountClaimed?: boolean;
  // Auto-provision an anonymous reccd account on first run. Absent or true
  // means yes -- absent has to mean yes, because the whole point is a fresh
  // install with no config.json at all. Set false to opt out; every path that
  // clears the reccd connection sets it, so "clear" stays cleared.
  reccAutoSignup?: boolean;
  // OMDb API key, used to fetch short plot summaries for For You picks (reccd
  // deliberately carries no plot text). Stored as-is; a TORLINK_OMDB_KEY env
  // var overrides it at read time.
  omdbApiKey?: string;
  // Preferred media-player command for streaming (e.g. "mpv", "iina", "vlc",
  // or an absolute path). Empty/unset falls back to auto-detection. A
  // TORLINK_PLAYER env var overrides it.
  mediaPlayer?: string;
  // Set once the user has acknowledged that streaming via torrent exposes their
  // IP to the swarm (the no-Real-Debrid path). Absent/false = not yet warned.
  torrentStreamAck?: boolean;
  // Send debrid media through this server instead of redirecting the client to
  // the provider's CDN. Absent/false = redirect, which is the cheap default.
  //
  // Two reasons to turn it on, and the first applies even to a single user: the
  // unrestricted link is a bearer credential against the account, and a redirect
  // hands it to the client, where proxying keeps it server-side. The second is
  // that every viewer then reaches the provider from this machine's address
  // rather than their own.
  //
  // It is NOT free: every byte is pulled down from the provider and pushed back
  // up to the viewer, so the cost lands on this machine's upstream — three
  // remote viewers of a 1080p remux need roughly 75 Mbps of upload.
  proxyDebridStreams?: boolean;
  // Opt-in adult ("Porn") category. Absent/false = OFF: the Porn tab and its
  // sources are hidden and never searched. A TORLINK_ADULT env var overrides it.
  adultContent?: boolean;
  // Screenshots pulled from adult torrent descriptions in the preview. Absent =
  // ON (adult content is already an explicit opt-in); false turns them off.
  adultScreenshots?: boolean;
  // Whether adult ("Porn") items appear in the Library and Continue Watching
  // lists. Absent/false = OFF (hidden), independent of adultContent (which
  // gates search-time results) — a user can search adult content without
  // wanting it mixed into their watch history, and items saved before this
  // setting existed had no way to be hidden at all.
  adultHistoryVisible?: boolean;
  // Remembered UI preferences, so torlink reopens the way you left it. Stored
  // as opaque strings validated by the UI layer (parseSort/parseSection) so a
  // hand-edited or stale value degrades gracefully to the default.
  sort?: string;
  // The last section the user was on (any sidebar tab). `category` is the older
  // field (categories only); still read for back-compat with pre-upgrade configs.
  lastSection?: string;
  category?: string;
  // Recently-run searches (most-recent first) for up-arrow recall in the
  // search bar.
  searchHistory?: string[];
  savedSearches?: string[];
  // Pinned VIDEO torrents (the "Library"), most-recent first, each remembering
  // which episodes have been watched.
  favourites?: FavouriteItem[];
  // The Access email that owns this install. Its profile is the existing top-level
  // fields and stream-history.json; every other authenticated email gets its own
  // profile. Host/security config: env (TORLINK_OWNER_EMAIL) or config, never
  // web-writable — mirrors cfAccessTeamDomain.
  ownerEmail?: string;
  // Per-friend state, keyed by slugForEmail(email). The OWNER never appears here —
  // the owner is the top-level fields above. Absent until a second user signs in.
  profiles?: Record<string, ProfileState>;
  // Ceiling for auto-picked releases. Absent = no ceiling. Note that with no
  // ceiling set the highest resolution available wins, which will usually be a
  // remux — that is the intended reading of "best available", not a bug.
  maxResolution?: MaxResolution;
  // Features an auto-picked release should have. SOFT: when nothing has them,
  // the pick falls back and reports which requirements it dropped.
  requireFeatures?: FeatureId[];
  // Features an auto-picked release must not have. HARD: never chosen.
  excludeFeatures?: FeatureId[];
  // Sources the user has switched off; they're skipped during search. Stored as
  // opaque strings — unknown ids are simply ignored by the registry.
  disabledSources?: string[];
  // Custom DNS resolver(s) for torlink's own HTTP, to get around networks that
  // sinkhole torrent domains at the OS resolver. IPs or aliases ("cloudflare",
  // "google", "quad9"). Empty/unset = use the system resolver. A TORLINK_DNS env
  // var overrides it.
  dnsServers?: string[];
  // Extra announce URLs (trackers) the user has added; appended to every
  // torrent added from now on.
  trackers: string[];
  downloadLimitKbps?: number;
  uploadLimitKbps?: number;
  seedRatio?: number;
  seedMinutes?: number;
  // Fail-closed P2P guard: this interface must exist and own the default route.
  vpnInterface?: string;
  /**
   * A Chromecast to offer alongside the ones mDNS finds — a host, or `host:port`.
   *
   * It exists because mDNS does not cross a Docker bridge or a VLAN, and torlink
   * is run behind both: without it, casting on those networks is dead behind a
   * message that reads like a bug. TUI-only, like every other setting — the web
   * UI is a client of this config and reads the resulting device list.
   */
  castDevice?: string;
  /**
   * The host a Chromecast should fetch media from, when it is not this machine's
   * own address — a host, or `host:port`.
   *
   * For a torlnk that a television cannot reach at the address torlnk sees on
   * itself. WSL2 in its default NAT mode is the case: inside the VM `eth0` is a
   * `172.x` address that is unroutable from the LAN, so a cast fails on the TV as
   * "couldn't play this file", blaming the file for a network problem. Set this to
   * the Windows host's LAN address (with the forwarded port, if it differs) and
   * casting works. Bridged Docker is the same shape.
   *
   * Better still, where it is available: WSL2's `networkingMode=mirrored`, which
   * removes the problem rather than working around it — mDNS discovery starts
   * working too, which this setting cannot fix.
   */
  castAdvertiseHost?: string;
  /** Cloudflare Access team domain, e.g. "myteam.cloudflareaccess.com". Host-specific; TUI/env only. */
  cfAccessTeamDomain?: string;
  /** Cloudflare Access application Audience (AUD) tag. Host-specific; TUI/env only. */
  cfAccessAud?: string;
}

export const defaultConfig: Config = {
  downloadDir: defaultDownloadDir,
  trackers: [],
};

// Defensive guard for a persisted favourite (mirrors isHistoryItem): drops
// hand-edited junk before it reaches the UI. Coerces `watched` and `addedAt`.
function isFavouriteItem(v: unknown): v is FavouriteItem {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" && r.id.length > 0 &&
    typeof r.name === "string" && r.name.length > 0 &&
    typeof r.magnet === "string" && r.magnet.length > 0
  );
}

// Drops hand-edited junk from the per-friend profiles map before it reaches a UI,
// mirroring the top-level favourites/savedSearches validation in loadConfig.
function sanitiseProfiles(input: unknown): Record<string, ProfileState> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, ProfileState> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const state: ProfileState = {};
    if (Array.isArray(r.favourites)) {
      state.favourites = r.favourites
        .filter(isFavouriteItem)
        .map((f) => ({ ...f, addedAt: typeof f.addedAt === "number" ? f.addedAt : 0 }))
        .slice(0, 100);
    }
    if (Array.isArray(r.savedSearches)) {
      state.savedSearches = r.savedSearches
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .slice(0, 50);
    }
    if (typeof r.reccToken === "string" && r.reccToken.trim()) state.reccToken = r.reccToken;
    if (typeof r.reccAccountName === "string") state.reccAccountName = r.reccAccountName;
    if (typeof r.reccAccountClaimed === "boolean") state.reccAccountClaimed = r.reccAccountClaimed;
    out[id] = state;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface RawQualityPrefs {
  maxResolution?: unknown;
  requireFeatures?: unknown;
  excludeFeatures?: unknown;
}

function featureList(v: unknown): FeatureId[] {
  return Array.isArray(v) ? [...new Set(v.filter(isFeatureId))] : [];
}

/**
 * Drop anything a hand-edited config — or an older build with a different
 * feature set — could put here. A preference that names an id this build does
 * not know would silently match nothing, which reads as a broken picker rather
 * than a bad config.
 *
 * A collision resolves in favour of EXCLUDE. Excluding is the hard rule and
 * requiring is the soft one, so honouring the hard one loses less.
 */
export function sanitiseQualityPrefs(raw: RawQualityPrefs): {
  maxResolution?: MaxResolution;
  requireFeatures: FeatureId[];
  excludeFeatures: FeatureId[];
} {
  const excludeFeatures = featureList(raw.excludeFeatures);
  const requireFeatures = featureList(raw.requireFeatures).filter((id) => !excludeFeatures.includes(id));
  const out: { maxResolution?: MaxResolution; requireFeatures: FeatureId[]; excludeFeatures: FeatureId[] } = {
    requireFeatures,
    excludeFeatures,
  };
  if (isMaxResolution(raw.maxResolution)) out.maxResolution = raw.maxResolution;
  return out;
}

// The subset of Config the web UI is allowed to write — non-secret settings
// only. Values arrive from the browser as `unknown`, so every field is typed
// loose and validated below. Tokens, DNS, trackers, VPN and cast are absent by
// design: they stay TUI-only (secrets, or host-specific network config).
export interface RawSettingsPatch {
  downloadDir?: unknown;
  mediaPlayer?: unknown;
  adultContent?: unknown;
  adultScreenshots?: unknown;
  adultHistoryVisible?: unknown;
  proxyDebridStreams?: unknown;
  downloadLimitKbps?: unknown;
  uploadLimitKbps?: unknown;
  seedRatio?: unknown;
  seedMinutes?: unknown;
  maxResolution?: unknown;
  requireFeatures?: unknown;
  excludeFeatures?: unknown;
  disabledSources?: unknown;
}

// A positive, finite number floored to an integer, or undefined — where
// undefined means "no limit" (0, negative, or junk all clear the setting).
function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/**
 * Validate a settings patch coming from an untrusted client (the web UI), so a
 * value the browser sends can never be stored in a form the terminal would
 * reject — the same contract `sanitiseQualityPrefs` gives the quality picker,
 * extended to the rest of the non-secret settings.
 *
 * Only keys actually present in the input are emitted, so a caller can send a
 * partial patch and leave everything else untouched. A present-but-empty
 * `downloadDir` is dropped (it is required and must not be blanked); an empty
 * `mediaPlayer` is kept, because empty legitimately means "auto-detect".
 */
export function sanitiseSettingsPatch(raw: RawSettingsPatch): Partial<Config> {
  const out: Partial<Config> = {};
  if (raw.downloadDir !== undefined) {
    const dir = typeof raw.downloadDir === "string" ? raw.downloadDir.trim() : "";
    if (dir) out.downloadDir = dir;
  }
  if (raw.mediaPlayer !== undefined) {
    out.mediaPlayer = typeof raw.mediaPlayer === "string" ? raw.mediaPlayer.trim() : "";
  }
  if (raw.adultContent !== undefined) out.adultContent = raw.adultContent === true;
  if (raw.adultScreenshots !== undefined) out.adultScreenshots = raw.adultScreenshots === true;
  if (raw.adultHistoryVisible !== undefined)
    out.adultHistoryVisible = raw.adultHistoryVisible === true;
  if (raw.proxyDebridStreams !== undefined) out.proxyDebridStreams = raw.proxyDebridStreams === true;
  if (raw.downloadLimitKbps !== undefined) out.downloadLimitKbps = positiveInt(raw.downloadLimitKbps);
  if (raw.uploadLimitKbps !== undefined) out.uploadLimitKbps = positiveInt(raw.uploadLimitKbps);
  if (raw.seedRatio !== undefined) {
    out.seedRatio =
      typeof raw.seedRatio === "number" && Number.isFinite(raw.seedRatio) && raw.seedRatio > 0
        ? raw.seedRatio
        : undefined;
  }
  if (raw.seedMinutes !== undefined) out.seedMinutes = positiveInt(raw.seedMinutes);
  if (raw.disabledSources !== undefined) {
    out.disabledSources = Array.isArray(raw.disabledSources)
      ? [...new Set(raw.disabledSources.filter((s): s is string => typeof s === "string" && s.length > 0))]
      : [];
  }
  // The quality trio is interdependent (a require/exclude collision resolves in
  // sanitiseQualityPrefs), so if any of the three is present, normalise all three.
  if (
    raw.maxResolution !== undefined ||
    raw.requireFeatures !== undefined ||
    raw.excludeFeatures !== undefined
  ) {
    const quality = sanitiseQualityPrefs(raw);
    out.maxResolution = quality.maxResolution;
    out.requireFeatures = quality.requireFeatures;
    out.excludeFeatures = quality.excludeFeatures;
  }
  return out;
}

/** The picker's view of the config. */
export function qualityPrefsFrom(config: Config): QualityPrefs {
  const clean = sanitiseQualityPrefs(config);
  const out: QualityPrefs = {
    ...NO_PREFS,
    require: clean.requireFeatures,
    exclude: clean.excludeFeatures,
  };
  return clean.maxResolution ? { ...out, maxResolution: clean.maxResolution } : out;
}

const REALDEBRID_TOKEN_ENV = "REALDEBRID_API_TOKEN";

// The effective token: env var wins over the persisted config value so the
// token can be supplied without ever touching config.json. Always trimmed; an
// empty string means "not configured".
export function resolveRealDebridToken(config: Config): string {
  const env = process.env[REALDEBRID_TOKEN_ENV];
  return (env?.trim() || config.realDebridToken?.trim()) ?? "";
}

const TORBOX_TOKEN_ENV = "TORBOX_API_TOKEN";

export function resolveTorBoxToken(config: Config): string {
  const env = process.env[TORBOX_TOKEN_ENV];
  return (env?.trim() || config.torBoxToken?.trim()) ?? "";
}

export function resolveDebridTokenFor(config: Config, provider: DebridProviderId): string {
  return provider === "torbox" ? resolveTorBoxToken(config) : resolveRealDebridToken(config);
}

/**
 * The debrid provider that will actually resolve a magnet, and its token — the
 * single read point for that decision.
 *
 * The explicit `debridProvider` preference wins, but only if its token
 * resolves: a preference pointing at a provider the user has since signed out
 * of must not read as "no debrid configured", which would silently route a
 * stream into a public swarm. Otherwise the one configured provider is used,
 * and with both configured and no preference, Real-Debrid — the provider
 * torlink had first, so an upgrading user's behaviour does not change.
 */
export function resolveActiveDebrid(config: Config): { provider: DebridProviderId; token: string } | null {
  const preferred = config.debridProvider;
  if (preferred === "realdebrid" || preferred === "torbox") {
    const token = resolveDebridTokenFor(config, preferred);
    if (token) return { provider: preferred, token };
  }
  const rd = resolveRealDebridToken(config);
  if (rd) return { provider: "realdebrid", token: rd };
  const tb = resolveTorBoxToken(config);
  if (tb) return { provider: "torbox", token: tb };
  return null;
}

const MEDIA_PLAYER_ENV = "TORLINK_PLAYER";

// The configured media-player command (env wins over config). Empty string
// means "not set" — callers should then fall back to auto-detection.
export function resolveMediaPlayer(config: Config): string {
  const env = process.env[MEDIA_PLAYER_ENV];
  return (env?.trim() || config.mediaPlayer?.trim()) ?? "";
}

const DNS_ENV = "TORLINK_DNS";

// The effective DNS resolver list (env wins over config), expanded from any
// aliases into concrete IPs. Empty means "use the system resolver".
export function resolveDnsServers(config: Config): string[] {
  const env = process.env[DNS_ENV];
  const raw = env !== undefined ? env : (config.dnsServers ?? []).join(",");
  return parseDnsServers(raw);
}

const ADULT_ENV = "TORLINK_ADULT";

// Whether the adult ("Porn") category is enabled. The env var wins over the
// persisted config (matching the other resolve* helpers) so it can be turned on
// or off per-session without touching config.json. Anything other than a
// truthy token (1/true/yes/on) in the env var forces it off.
export function resolveAdultContent(config: Config): boolean {
  const env = process.env[ADULT_ENV];
  if (env !== undefined) return /^(1|true|yes|on)$/i.test(env.trim());
  return config.adultContent === true;
}

// Whether adult-result screenshots are shown. Default ON — absent means enabled,
// since adult content is already an explicit opt-in; only an explicit `false`
// turns them off. No env override: it is a plain preference, not host config.
export function resolveAdultScreenshots(config: Config): boolean {
  return config.adultScreenshots !== false;
}

// Whether adult items show in Library/Continue Watching. Default OFF: unlike
// adultScreenshots (which only ever appears once adultContent is already an
// explicit opt-in), history items can predate the user ever having touched
// adultContent, so this must not surprise anyone browsing history for the
// first time after this feature ships. No env override: a plain preference,
// not host config.
export function resolveAdultHistoryVisible(config: Config): boolean {
  return config.adultHistoryVisible === true;
}

const RECC_URL_ENV = "TORLINK_RECC_URL";
const RECC_TOKEN_ENV = "TORLINK_RECC_TOKEN";

// The effective reccd connection (env wins over config, matching the other
// resolve* helpers). An undefined reccUrl means "recommendations not
// configured" — the For You view then shows a setup hint instead of fetching.
//
// With a friend's profileId, the token comes from that profile alone: reccUrl is
// shared infrastructure (every profile talks to the same reccd host), but a friend
// never inherits the env/owner token — isolating their recommendations is the point.
export function resolveReccConfig(config: Config, profileId: string = OWNER_PROFILE): ReccClientConfig {
  const url = process.env[RECC_URL_ENV]?.trim() || config.reccUrl?.trim() || undefined;
  if (isOwnerProfile(profileId)) {
    const token = process.env[RECC_TOKEN_ENV]?.trim() || config.reccToken?.trim() || undefined;
    return { reccUrl: url, reccToken: token };
  }
  const token = config.profiles?.[profileId]?.reccToken?.trim() || undefined;
  return { reccUrl: url, reccToken: token };
}

const CAST_ADVERTISE_ENV = "TORLINK_CAST_HOST";
const CAST_DEVICE_ENV = "TORLINK_CAST_DEVICE";

/**
 * The host a Chromecast should fetch media from, or undefined to work it out.
 *
 * Env wins over config, matching every other resolve* helper — and it matters
 * more here than most: the setups that need this are the ones torlnk is *deployed*
 * into rather than configured on. A WSL user's `.bashrc` and a compose file's
 * `environment:` are where this naturally lives, and neither has a TUI to open.
 */
export function resolveCastAdvertiseHost(config: Config): string | undefined {
  const env = process.env[CAST_ADVERTISE_ENV]?.trim();
  return env || config.castAdvertiseHost?.trim() || undefined;
}

/** The configured Chromecast address, if any. Env wins, for the reason above. */
export function resolveCastDevice(config: Config): string | undefined {
  const env = process.env[CAST_DEVICE_ENV]?.trim();
  return env || config.castDevice?.trim() || undefined;
}

const OWNER_EMAIL_ENV = "TORLINK_OWNER_EMAIL";

/**
 * The Access email that owns this install, normalised (trimmed + lower-cased), or
 * undefined. env wins over config, matching every other resolve* helper. Undefined
 * means "no owner set" — the whole feature then fails soft to single-user.
 */
export function resolveOwnerEmail(config: Config): string | undefined {
  const v = process.env[OWNER_EMAIL_ENV]?.trim() || config.ownerEmail?.trim();
  return v ? v.toLowerCase() : undefined;
}

const CF_ACCESS_TEAM_DOMAIN_ENV = "TORLINK_CF_ACCESS_TEAM_DOMAIN";
const CF_ACCESS_AUD_ENV = "TORLINK_CF_ACCESS_AUD";

/**
 * Cloudflare Access enforcement config. env wins over the persisted value, both
 * trimmed. Returns null unless BOTH halves are present — a half-configured gate
 * would fail every request, so treat it as "off".
 */
export function resolveCloudflareAccess(
  config: Config,
): { teamDomain: string; aud: string } | null {
  const teamDomain = (process.env[CF_ACCESS_TEAM_DOMAIN_ENV]?.trim() || config.cfAccessTeamDomain?.trim()) ?? "";
  const aud = (process.env[CF_ACCESS_AUD_ENV]?.trim() || config.cfAccessAud?.trim()) ?? "";
  if (!teamDomain || !aud) return null;
  return { teamDomain, aud };
}

/**
 * True when exactly one of the two Cloudflare Access settings is present — a
 * likely misconfiguration that leaves the origin gate silently OFF. Callers log
 * a warning so it isn't mistaken for "enforced".
 */
export function isCloudflareAccessHalfConfigured(config: Config): boolean {
  const teamDomain = (process.env[CF_ACCESS_TEAM_DOMAIN_ENV]?.trim() || config.cfAccessTeamDomain?.trim()) ?? "";
  const aud = (process.env[CF_ACCESS_AUD_ENV]?.trim() || config.cfAccessAud?.trim()) ?? "";
  return (teamDomain === "") !== (aud === "");
}

const OMDB_KEY_ENV = "TORLINK_OMDB_KEY";

// The effective OMDb API key (env wins over config, matching the other resolve*
// helpers). Empty string means "not configured" — For You then skips plot
// fetching and just deep-links to IMDb instead.
export function resolveOmdbApiKey(config: Config): string {
  const env = process.env[OMDB_KEY_ENV];
  return (env?.trim() || config.omdbApiKey?.trim()) ?? "";
}

export async function loadConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(configFile, "utf8");
  } catch {
    return { ...defaultConfig };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    const cfg = { ...defaultConfig, ...parsed };
    if (!cfg.downloadDir || typeof cfg.downloadDir !== "string") {
      cfg.downloadDir = defaultDownloadDir;
    }
    // Drop non-string / empty announce URLs so a hand-edited trackers list
    // can't feed junk into the download engine.
    cfg.trackers = Array.isArray(parsed.trackers)
      ? parsed.trackers.filter((t): t is string => typeof t === "string" && t.length > 0)
      : [];
    cfg.savedSearches = Array.isArray(parsed.savedSearches)
      ? parsed.savedSearches.filter((query): query is string => typeof query === "string" && query.trim().length > 0).slice(0, 50)
      : [];
    cfg.favourites = Array.isArray(parsed.favourites)
      ? parsed.favourites
          .filter(isFavouriteItem)
          .map((f) => {
            const watched = Array.isArray(f.watched)
              ? f.watched.filter((w): w is string => typeof w === "string")
              : undefined;
            return {
              ...f,
              addedAt: typeof f.addedAt === "number" ? f.addedAt : 0,
              ...(watched ? { watched } : { watched: undefined }),
            };
          })
          .slice(0, 100)
      : [];
    cfg.ownerEmail =
      typeof parsed.ownerEmail === "string" && parsed.ownerEmail.trim().length > 0
        ? parsed.ownerEmail.trim()
        : undefined;
    cfg.profiles = sanitiseProfiles(parsed.profiles);
    const quality = sanitiseQualityPrefs(parsed);
    cfg.maxResolution = quality.maxResolution;
    cfg.requireFeatures = quality.requireFeatures;
    cfg.excludeFeatures = quality.excludeFeatures;
    return cfg;
  } catch {
    return { ...defaultConfig };
  }
}

// Per-profile list accessors. The owner reads/writes the top-level fields; a friend
// reads/writes profiles[id], leaving the owner and every other friend untouched. All
// setters return a fresh Config for the caller to saveConfig — read-modify-write, per
// CLAUDE.md, never a held snapshot.

export function profileFavourites(config: Config, profileId: string): FavouriteItem[] {
  if (isOwnerProfile(profileId)) return config.favourites ?? [];
  return config.profiles?.[profileId]?.favourites ?? [];
}

export function withProfileFavourites(
  config: Config,
  profileId: string,
  favourites: FavouriteItem[],
): Config {
  if (isOwnerProfile(profileId)) return { ...config, favourites };
  const prev = config.profiles?.[profileId] ?? {};
  return { ...config, profiles: { ...config.profiles, [profileId]: { ...prev, favourites } } };
}

export function profileSavedSearches(config: Config, profileId: string): string[] {
  if (isOwnerProfile(profileId)) return config.savedSearches ?? [];
  return config.profiles?.[profileId]?.savedSearches ?? [];
}

export function withProfileSavedSearches(
  config: Config,
  profileId: string,
  savedSearches: string[],
): Config {
  if (isOwnerProfile(profileId)) return { ...config, savedSearches };
  const prev = config.profiles?.[profileId] ?? {};
  return { ...config, profiles: { ...config.profiles, [profileId]: { ...prev, savedSearches } } };
}

export function withProfileReccAccount(
  config: Config,
  profileId: string,
  patch: { reccToken: string; reccAccountName: string; reccAccountClaimed: boolean; reccUrl?: string },
): Config {
  const { reccUrl, ...account } = patch;
  // Owner: spread onto the top level, exactly as provisioning did before profiles
  // existed (reccUrl included, when the caller supplies it). The caller passes the
  // URL rather than this file importing DEFAULT_RECC_URL out of src/recc, which
  // would create a cycle (src/recc already imports this module).
  if (isOwnerProfile(profileId)) {
    return { ...config, ...account, ...(reccUrl ? { reccUrl } : {}) };
  }
  // A friend never gets its own reccUrl — the reccd host is shared top-level infra.
  const prev = config.profiles?.[profileId] ?? {};
  return { ...config, profiles: { ...config.profiles, [profileId]: { ...prev, ...account } } };
}

const write = serializeWrites();

export function saveConfig(config: Config): Promise<void> {
  return write(() => writeJsonAtomic(configFile, config));
}
