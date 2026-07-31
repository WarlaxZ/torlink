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

const RECC_URL_ENV = "TORLINK_RECC_URL";
const RECC_TOKEN_ENV = "TORLINK_RECC_TOKEN";

// The effective reccd connection (env wins over config, matching the other
// resolve* helpers). An undefined reccUrl means "recommendations not
// configured" — the For You view then shows a setup hint instead of fetching.
export function resolveReccConfig(config: Config): ReccClientConfig {
  const url = process.env[RECC_URL_ENV]?.trim() || config.reccUrl?.trim() || undefined;
  const token = process.env[RECC_TOKEN_ENV]?.trim() || config.reccToken?.trim() || undefined;
  return { reccUrl: url, reccToken: token };
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
    const quality = sanitiseQualityPrefs(parsed);
    cfg.maxResolution = quality.maxResolution;
    cfg.requireFeatures = quality.requireFeatures;
    cfg.excludeFeatures = quality.excludeFeatures;
    return cfg;
  } catch {
    return { ...defaultConfig };
  }
}

const write = serializeWrites();

export function saveConfig(config: Config): Promise<void> {
  return write(() => writeJsonAtomic(configFile, config));
}
