import { promises as fs } from "node:fs";
import { configFile, defaultDownloadDir } from "./paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";
import { parseDnsServers } from "../util/dns";
import type { SourceId } from "../sources/types";

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
  // Preferred media-player command for streaming (e.g. "mpv", "iina", "vlc",
  // or an absolute path). Empty/unset falls back to auto-detection. A
  // TORLINK_PLAYER env var overrides it.
  mediaPlayer?: string;
  // Set once the user has acknowledged that streaming via torrent exposes their
  // IP to the swarm (the no-Real-Debrid path). Absent/false = not yet warned.
  torrentStreamAck?: boolean;
  // Remembered UI preferences, so torlink reopens the way you left it. Both are
  // stored as opaque strings validated by the UI layer (parseSort/parseCategory)
  // so a hand-edited or stale value degrades gracefully to the default.
  sort?: string;
  category?: string;
  // Recently-run searches (most-recent first) for up-arrow recall in the
  // search bar.
  searchHistory?: string[];
  savedSearches?: string[];
  // Pinned VIDEO torrents (the "Library"), most-recent first, each remembering
  // which episodes have been watched.
  favourites?: FavouriteItem[];
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

const REALDEBRID_TOKEN_ENV = "REALDEBRID_API_TOKEN";

// The effective token: env var wins over the persisted config value so the
// token can be supplied without ever touching config.json. Always trimmed; an
// empty string means "not configured".
export function resolveRealDebridToken(config: Config): string {
  const env = process.env[REALDEBRID_TOKEN_ENV];
  return (env?.trim() || config.realDebridToken?.trim()) ?? "";
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
    return cfg;
  } catch {
    return { ...defaultConfig };
  }
}

const write = serializeWrites();

export function saveConfig(config: Config): Promise<void> {
  return write(() => writeJsonAtomic(configFile, config));
}
