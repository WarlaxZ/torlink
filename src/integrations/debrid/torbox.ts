import { fetchResilient, HttpError, USER_AGENT } from "../../util/net";
import { log } from "../../util/logger";
import type { DebridStatus, RequestOptions, ResolveOptions } from "./types";
import type { StreamFile } from "../../util/player";

const BASE = "https://api.torbox.app/v1";

/** A user-facing failure from TorBox. `message` is safe to show in the UI. */
export class TorBoxError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "TorBoxError";
    this.status = status;
    this.code = code;
  }
}

export const TOKEN_REJECTED_MESSAGE = "TorBox rejected the token (invalid or expired).";

// HTTP statuses worth retrying (rate limit / transient server load).
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

// TorBox reports its own limits in the envelope's `error` slug rather than as a
// 429: 60/hour for uncached createtorrent, 300/minute otherwise. These are worth
// requeuing; a bad token or a dead magnet is not.
const TRANSIENT_SLUGS = new Set([
  "TOO_MANY_REQUESTS",
  "MONTHLY_LIMIT",
  "ACTIVE_LIMIT",
  "DATABASE_ERROR",
  "UNKNOWN_ERROR",
]);

const AUTH_SLUGS = new Set(["BAD_TOKEN", "AUTH_ERROR", "OAUTH_VERIFICATION_ERROR"]);

export function isTransient(e: unknown): boolean {
  if (!(e instanceof TorBoxError)) return false;
  if (e.status !== undefined && TRANSIENT_STATUS.has(e.status)) return true;
  return e.code !== undefined && TRANSIENT_SLUGS.has(e.code);
}

export function isTokenRejection(e: unknown): boolean {
  if (e instanceof TorBoxError) {
    if (e.status === 401 || e.status === 403) return true;
    if (e.code && AUTH_SLUGS.has(e.code)) return true;
  }
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.includes(TOKEN_REJECTED_MESSAGE);
}

function mapFailure(status: number | undefined, slug: string | undefined, detail: string | undefined): TorBoxError {
  if (status === 401 || status === 403 || (slug && AUTH_SLUGS.has(slug))) {
    return new TorBoxError(TOKEN_REJECTED_MESSAGE, status, slug);
  }
  if (slug === "TOO_MANY_REQUESTS" || slug === "ACTIVE_LIMIT") {
    return new TorBoxError("TorBox rate limit — wait a moment and retry.", status, slug);
  }
  if (slug === "MONTHLY_LIMIT") {
    return new TorBoxError("TorBox monthly download limit reached.", status, slug);
  }
  if (slug === "DOWNLOAD_TOO_LARGE") {
    return new TorBoxError("TorBox won't take this torrent — it exceeds your plan's size limit.", status, slug);
  }
  if (slug === "NO_SERVERS_AVAILABLE_ERROR") {
    return new TorBoxError("TorBox has no free servers — try again shortly.", status, slug);
  }
  // `detail` is TorBox's own human-readable sentence; prefer it when present.
  if (detail) return new TorBoxError(`TorBox: ${detail}`, status, slug);
  if (slug) return new TorBoxError(`TorBox error: ${slug}.`, status, slug);
  return new TorBoxError(`TorBox request failed${status ? ` (HTTP ${status})` : ""}.`, status, slug);
}

/** Every TorBox JSON response is wrapped in this. */
interface Envelope<T> {
  success?: boolean;
  error?: unknown;
  detail?: string;
  data?: T;
}

function slugOf(error: unknown): string | undefined {
  return typeof error === "string" ? error : undefined;
}

// Strip the query string before anything reaches the log. requestdl carries the
// API token as `?token=`, and RD's client logs the path on every call — a
// straight port of that would write the user's token to disk.
function logPath(path: string): string {
  const q = path.indexOf("?");
  return q === -1 ? path : `${path.slice(0, q)}?…`;
}

// A network-layer error message often embeds the full request URL, and
// requestdl carries the API token in its query string — so the raw message
// cannot be surfaced. logPath() protects the log; this protects the error the
// user sees.
function redactToken(message: string): string {
  return message.replace(/([?&]token=)[^&\s]*/gi, "$1…");
}

/**
 * One TorBox call, returning the envelope's `data`.
 *
 * TorBox answers `{success: false}` with HTTP 200, so unlike the Real-Debrid
 * client this cannot key off `res.ok` alone — the envelope is checked whatever
 * the status was.
 */
async function request<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  body: Record<string, string> | undefined,
  opts: RequestOptions,
): Promise<T> {
  const shown = logPath(path);
  log.debug(`torbox ${method} ${shown} →`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
  };
  let bodyStr: string | undefined;
  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    bodyStr = new URLSearchParams(body).toString();
  }

  let res: Response;
  try {
    res = await fetchResilient(`${BASE}${path}`, {
      method,
      headers,
      body: bodyStr,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      retries: opts.retries ?? 2,
      retryCdn503: true,
      baseMs: 2000,
      capMs: 30000,
      minBackoffMs: 2000,
      onAttempt: ({ status, attempt, retries, retryAfterMs, willRetry }) =>
        log.warn(
          `torbox ${method} ${shown} status=${status} attempt=${attempt + 1}/${retries + 1}` +
            (retryAfterMs !== undefined ? ` retryAfter=${Math.round(retryAfterMs / 1000)}s` : "") +
            (willRetry ? " retrying" : " giving up"),
        ),
    });
  } catch (e) {
    if (e instanceof HttpError) {
      let slug: string | undefined;
      let detail: string | undefined;
      try {
        const parsed = JSON.parse(e.body ?? "") as Envelope<unknown>;
        slug = slugOf(parsed.error);
        detail = parsed.detail;
      } catch {
        /* body may be empty or non-JSON */
      }
      log.warn(`torbox ${method} ${shown} failed status=${e.status}${slug ? ` slug=${slug}` : ""}`);
      throw mapFailure(e.status, slug, detail);
    }
    const rawMessage = e instanceof Error ? e.message : String(e);
    log.warn(`torbox ${method} ${shown} error=${redactToken(rawMessage)}`);
    throw new TorBoxError(redactToken(rawMessage));
  }

  let env: Envelope<T>;
  try {
    env = (await res.json()) as Envelope<T>;
  } catch {
    if (!res.ok) throw mapFailure(res.status, undefined, undefined);
    throw new TorBoxError("TorBox returned a response torlink could not read.", res.status);
  }

  // The load-bearing difference from the Real-Debrid client: success is the
  // envelope's business, not the HTTP status's.
  //
  // ASSUMPTION, unverified against a live account: a 2xx response with no
  // `success` key at all (env.success === undefined) is treated as success.
  // TorBox's docs are not explicit that every endpoint always includes the
  // key, so this is a reasonable reading rather than a confirmed one.
  if (!res.ok || env.success === false) {
    const slug = slugOf(env.error);
    log.warn(`torbox ${method} ${shown} failed status=${res.status}${slug ? ` slug=${slug}` : ""}`);
    throw mapFailure(res.status, slug, env.detail);
  }
  log.debug(`torbox ${method} ${shown} ${res.status}`);
  return env.data as T;
}

// TorBox's plan integers, from its API docs. An unrecognised integer is
// labelled generically rather than guessed at.
const PLAN_LABELS: Record<number, string> = {
  0: "free",
  1: "essential",
  2: "pro",
  3: "standard",
};

interface TorBoxUser {
  email?: string;
  plan?: number;
  premiumExpiresAt?: string;
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function validateToken(token: string, opts: RequestOptions = {}): Promise<DebridStatus> {
  const user = await request<TorBoxUser>(token, "GET", "/api/user/me", undefined, opts);
  const plan = user?.plan ?? 0;
  return {
    provider: "torbox",
    // TorBox has no usernames; the account's email is what it identifies by.
    username: user?.email ?? "TorBox account",
    // ASSUMPTION, unverified against a live account: every TorBox plan —
    // including free (plan 0) — can add torrents, unlike Real-Debrid where a
    // non-premium account cannot. If the free tier turns out to refuse
    // torrents, this becomes `plan > 0` and classifyStreamRoute's existing
    // torrent-confirm path covers it with no other change.
    active: true,
    planLabel: PLAN_LABELS[plan] ?? `plan ${plan}`,
    expiresAt: parseDate(user?.premiumExpiresAt),
  };
}

const DEFAULT_POLL_MS = 2000;

// Give up if TorBox reports no caching progress for this long (usually no
// seeders). Only inactivity counts — a torrent still making progress is never
// timed out. Same policy and value as the Real-Debrid client.
const DEFAULT_STALL_MS = 180_000;

// ASSUMPTION, unverified against a live account: these are the download_state
// values that mean "this will never finish". TorBox's docs do not enumerate
// the full state vocabulary, so this is a guess at the terminal-failure set.
const ERROR_STATES = new Set(["error", "stalled", "missingFiles", "uploading (no peers)"]);

interface TorBoxFile {
  id?: number;
  name?: string;
  short_name?: string;
  size?: number;
}

interface TorBoxTorrent {
  id?: number;
  hash?: string;
  name?: string;
  download_finished?: boolean;
  download_present?: boolean;
  download_state?: string;
  /**
   * ASSUMPTION, unverified against a live account: a 0..1 fraction (not
   * 0-100). This is the highest-consequence guess in this module — every
   * onProgress consumer in torlink assumes 0-100 — so it is converted exactly
   * once, at the boundary below, before it leaves this module.
   */
  progress?: number;
  files?: TorBoxFile[];
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TorBoxError("TorBox request cancelled.");
}

async function createTorrent(token: string, magnet: string, opts: ResolveOptions): Promise<number> {
  // No retries: createtorrent isn't idempotent, and a retry after a transient
  // 5xx that actually succeeded would leave a duplicate in the account.
  const data = await request<Record<string, unknown>>(
    token,
    "POST",
    "/api/torrents/createtorrent",
    { magnet },
    { ...opts, retries: 0 },
  );
  // ASSUMPTION, unverified against a live account: the id arrives as
  // `torrent_id`. The SDK docs type `data` loosely, so `id` is accepted too and
  // a missing id fails loudly rather than being guessed at.
  const raw = data?.["torrent_id"] ?? data?.["id"];
  const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(id)) {
    throw new TorBoxError("TorBox did not return a torrent id for this magnet.");
  }
  return id;
}

async function getTorrent(token: string, id: number, opts: ResolveOptions): Promise<TorBoxTorrent> {
  const data = await request<TorBoxTorrent | TorBoxTorrent[]>(
    token,
    "GET",
    `/api/torrents/mylist?id=${id}&bypass_cache=true`,
    undefined,
    { ...opts, retries: opts.retries ?? 4 },
  );
  // mylist returns an object when queried by id and a list otherwise; accept both.
  return Array.isArray(data) ? (data[0] ?? {}) : (data ?? {});
}

async function requestDownloadLink(
  token: string,
  torrentId: number,
  fileId: number,
  opts: ResolveOptions,
): Promise<string> {
  // The token goes in the query string here — that is TorBox's contract for
  // this route. `request()` strips the query before logging, and redactToken()
  // strips it again from any network-layer error message that embeds the URL.
  const url = await request<string>(
    token,
    "GET",
    `/api/torrents/requestdl?token=${encodeURIComponent(token)}&torrent_id=${torrentId}&file_id=${fileId}`,
    undefined,
    { ...opts, retries: opts.retries ?? 4 },
  );
  if (typeof url !== "string" || !url) {
    throw new TorBoxError("TorBox returned no download link for this file.");
  }
  return url;
}

/**
 * Drive a magnet through the full TorBox pipeline and return direct,
 * downloadable links:
 *   createtorrent → poll mylist until download_finished → requestdl per file.
 * `onProgress` reports TorBox-side caching progress as 0-100.
 */
export async function resolveMagnet(
  token: string,
  magnet: string,
  opts: ResolveOptions = {},
): Promise<StreamFile[]> {
  const {
    onProgress,
    pollIntervalMs = DEFAULT_POLL_MS,
    sleepImpl = realSleep,
    signal,
    stallMs = DEFAULT_STALL_MS,
  } = opts;

  throwIfAborted(signal);
  // No reuse-by-hash scan: createtorrent on a magnet already in the account
  // returns that torrent, so RD's five-page findTorrentByHash has no equivalent.
  const id = await createTorrent(token, magnet, opts);

  let torrent: TorBoxTorrent = {};
  // The last percent actually emitted to onProgress — tracked separately from
  // bestProgress below, because the loop can `break` (on download_finished)
  // before the stall bookkeeping below would otherwise update it.
  let lastEmitted = -1;
  let bestProgress = -1;
  let stalledMs = 0;
  for (;;) {
    throwIfAborted(signal);
    torrent = await getTorrent(token, id, opts);
    // ASSUMPTION, unverified against a live account: TorBox reports progress
    // as a 0..1 fraction. Every onProgress consumer in torlink assumes 0-100,
    // so this conversion happens exactly once, here.
    const percent = Math.min(100, Math.max(0, Math.round((torrent.progress ?? 0) * 100)));
    onProgress?.(percent);
    lastEmitted = percent;
    if (torrent.download_finished === true && torrent.download_present === true) break;
    if (torrent.download_state && ERROR_STATES.has(torrent.download_state)) {
      throw new TorBoxError(
        `TorBox couldn't fetch this torrent (${torrent.download_state}) — it may have no seeders.`,
      );
    }
    if (percent > bestProgress) {
      bestProgress = percent;
      stalledMs = 0;
    } else {
      stalledMs += pollIntervalMs;
      if (stalledMs >= stallMs) {
        throw new TorBoxError(
          "TorBox isn't caching this torrent — it may have no seeders (removed or dead).",
        );
      }
    }
    await sleepImpl(pollIntervalMs);
  }
  // The final poll that saw download_finished usually already emitted 100
  // above. But TorBox could report download_finished while progress is still
  // below 1 (or absent) — e.g. lastEmitted stuck at 97 — and callers still
  // need a terminal 100, so this only skips when 100 was already sent.
  if (lastEmitted !== 100) onProgress?.(100);

  const files = torrent.files ?? [];
  if (files.length === 0) throw new TorBoxError("TorBox returned no downloadable files.");

  const out: StreamFile[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    const fileId = file.id ?? 0;
    out.push({
      url: await requestDownloadLink(token, id, fileId, opts),
      filename: file.name ?? file.short_name ?? `file-${fileId}`,
      bytes: file.size ?? 0,
    });
  }
  return out;
}
