import { fetchResilient, HttpError, USER_AGENT } from "../../util/net";
import { log } from "../../util/logger";
import type { DebridStatus, RequestOptions } from "./types";

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
    log.warn(`torbox ${method} ${shown} error=${e instanceof Error ? e.message : String(e)}`);
    throw new TorBoxError(e instanceof Error ? e.message : String(e));
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
