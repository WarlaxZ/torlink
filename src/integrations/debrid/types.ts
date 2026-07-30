import type { FetchImpl } from "../../util/net";
import type { StreamFile } from "../../util/player";

/** Every debrid service torlink can resolve a magnet through. */
export type DebridProviderId = "realdebrid" | "torbox";

/**
 * A render-ready, provider-blind view of a connected debrid account. Both front
 * ends and `classifyStreamRoute` read only this — nothing above
 * `src/integrations/debrid/` knows a provider's own account shape.
 */
export interface DebridStatus {
  provider: DebridProviderId;
  username: string;
  /** Can this account add torrents at all? Drives the torrent-confirm refusal. */
  active: boolean;
  /** Lowercase, e.g. "premium", "free", "pro". Rendered directly. */
  planLabel: string;
  /** Best estimate of when the plan lapses; null when unknown or not applicable. */
  expiresAt: Date | null;
}

export interface RequestOptions {
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Retry budget. Set 0 for non-idempotent calls where a retry could duplicate work. */
  retries?: number;
}

export interface ResolveOptions extends RequestOptions {
  /** Provider-side caching progress, 0–100 (never a 0..1 fraction). */
  onProgress?: (percent: number) => void;
  pollIntervalMs?: number;
  /** The torrent's infoHash (hex), so an already-added torrent is reused. */
  knownHash?: string;
  /** Fail if provider-side caching makes no progress for this many ms. */
  stallMs?: number;
}

/**
 * One debrid service. `label`, `homepage` and `tokenUrl` exist so no UI copy
 * anywhere hardcodes a provider's name — a second provider would otherwise mean
 * hunting every "Real-Debrid" string again.
 */
export interface DebridProvider {
  id: DebridProviderId;
  /** Display name, e.g. "Real-Debrid". */
  label: string;
  /** Two-letter tag for the compact header badge and the downloads list. */
  shortLabel: string;
  homepage: string;
  /** Where the user gets an API token. */
  tokenUrl: string;
  /** Env var that overrides the persisted token. */
  tokenEnvVar: string;
  validateToken(token: string, opts?: RequestOptions): Promise<DebridStatus>;
  resolveMagnet(token: string, magnet: string, opts?: ResolveOptions): Promise<StreamFile[]>;
  /**
   * Which of `hashes` the provider already has cached. Present ONLY where the
   * provider supports it — its absence is the capability flag. Real-Debrid
   * removed its instant-availability endpoint in 2024 and so does not have it.
   */
  checkCached?(token: string, hashes: string[], opts?: RequestOptions): Promise<Set<string>>;
  /** Worth requeuing (rate limit, transient server load) vs terminal. */
  isTransient(e: unknown): boolean;
  /** The token was rejected — the UI should re-prompt for THIS provider. */
  isTokenRejection(e: unknown): boolean;
}
