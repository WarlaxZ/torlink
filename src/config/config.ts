import { promises as fs } from "node:fs";
import { configFile, defaultDownloadDir } from "./paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";

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
}

export const defaultConfig: Config = {
  downloadDir: defaultDownloadDir,
};

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
    return cfg;
  } catch {
    return { ...defaultConfig };
  }
}

const write = serializeWrites();

export function saveConfig(config: Config): Promise<void> {
  return write(() => writeJsonAtomic(configFile, config));
}
