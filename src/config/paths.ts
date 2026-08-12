import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";

export const APP_NAME = "torlink";

const base = envPaths(APP_NAME, { suffix: "" });

// Optional override that relocates all persisted state under one folder. Tests
// point this at a temp dir so they never touch the real user data; it also
// doubles as a portable-state escape hatch. Off unless the env var is set.
const override = process.env.TORLINK_STATE_DIR;
const dataDir = override ? path.join(override, "data") : base.data;
const configDir = override ? path.join(override, "config") : base.config;
const cacheDir = override ? path.join(override, "cache") : base.cache;

export const defaultDownloadDir = path.join(os.homedir(), "Downloads", APP_NAME);

export const configFile = path.join(configDir, "config.json");

// Guards auto-provisioning against a concurrent TUI and `serve --web`, which
// are separate processes sharing one config.json. In configDir rather than
// dataDir because what it protects is a config write.
export const reccProvisionLockFile = path.join(configDir, "recc-provision.lock");

export const queueFile = path.join(dataDir, "queue.json");

export const historyFile = path.join(dataDir, "history.json");

// Streams, not downloads. history.json is completed DOWNLOADS; this is what the
// user watched. Separate files because they are different facts — someone who
// downloads a season pack once and watches it over three weeks would otherwise
// see one list misreport the other.
export const streamHistoryFile = path.join(dataDir, "stream-history.json");

// Per-friend stream history. The OWNER keeps streamHistoryFile above unchanged; a
// friend's history is <dataDir>/stream-history/<profileId>.json. A directory, not a
// suffix on the same file, so listing/clearing one friend never risks the others.
export const streamHistoryDir = path.join(dataDir, "stream-history");

export const seedsFile = path.join(dataDir, "seeds.json");

export const rutrackerFile = path.join(dataDir, "rutracker.json");

export const logFile = path.join(dataDir, "torlink.log");

// Per-torrent .torrent metadata, captured during download so a re-seed can
// verify the on-disk file locally instead of re-fetching it from the swarm.
export const torrentsDir = path.join(dataDir, "torrents");

// Cached poster originals, keyed by a hash of the source URL. The browser is
// served these bytes as-is (full quality); the TUI half-blocks the same file
// rather than re-fetching it. Safe to delete at any time — it is a cache.
export const postersDir = path.join(cacheDir, "posters");

// Armed just before boot hands saved state to the torrent engine, disarmed
// once the boot settles; see download/bootguard.ts.
export const bootMarkerFile = path.join(dataDir, "boot.marker");

// Where a --daemon headless run writes its log and pidfile.
export const logsDir = path.join(dataDir, "logs");
