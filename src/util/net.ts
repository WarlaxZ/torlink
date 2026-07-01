export const USER_AGENT = "torlink (+https://www.npmjs.com/package/torlnk)";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepImpl = (ms: number) => Promise<void>;

export interface FetchResilientOptions extends RequestInit {
  retries?: number;
  baseMs?: number;
  capMs?: number;
  fetchImpl?: FetchImpl;
  sleepImpl?: SleepImpl;
  // Opt out of the Cloudflare/ddos-guard 503 short-circuit: retry those 503s with
  // backoff instead of throwing. For trusted APIs behind Cloudflare (e.g. the
  // Real-Debrid REST API) where a 503 is a transient rate-limit, not a block page.
  retryCdn503?: boolean;
  // Minimum backoff (ms) for a retryable response that has no Retry-After
  // header — a floor so retries aren't near-instant. Off by default; set by
  // trusted APIs (Real-Debrid) whose 503s are rate limits with no Retry-After.
  minBackoffMs?: number;
  // Called on each retryable response (before the backoff sleep) and on the
  // final give-up. Lets callers observe retries without this layer knowing about
  // logging. `delayMs` is 0 when giving up; `willRetry` distinguishes the two.
  onAttempt?: (info: {
    status: number;
    attempt: number;
    retries: number;
    retryAfterMs?: number;
    delayMs: number;
    willRetry: boolean;
    bodySnippet?: string;
  }) => void;
}

export class HttpError extends Error {
  status: number;
  body?: string;
  constructor(status: number, message?: string, body?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const DEFAULT_RETRIES = 5;
const DEFAULT_BASE_MS = 500;
const DEFAULT_CAP_MS = 20000;
const BODY_SNIPPET_MAX = 200;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || /aborted/i.test(e.message))
  );
}

// Best-effort short snippet of a response body, for diagnostics. Never throws —
// a missing/failed body yields undefined. Truncated so a stray HTML page can't
// bloat a log line.
async function readBodySnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.slice(0, BODY_SNIPPET_MAX).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseRetryAfter(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
  return undefined;
}

export function backoffDelay(
  attempt: number,
  baseMs: number,
  capMs: number,
  retryAfterMs?: number,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jittered = Math.floor(rand() * exp);
  if (retryAfterMs !== undefined) return Math.max(jittered, retryAfterMs);
  return jittered;
}

export async function fetchResilient(
  url: string,
  opts: FetchResilientOptions = {},
): Promise<Response> {
  const {
    retries = DEFAULT_RETRIES,
    baseMs = DEFAULT_BASE_MS,
    capMs = DEFAULT_CAP_MS,
    fetchImpl = fetch as FetchImpl,
    sleepImpl = realSleep,
    retryCdn503 = false,
    onAttempt,
    minBackoffMs,
    signal,
    ...init
  } = opts;

  const fetchInit: RequestInit = signal ? { ...init, signal } : init;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new HttpError(0, "aborted");

    let res: Response | undefined;
    try {
      res = await fetchImpl(url, fetchInit);
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) throw e;
      lastError = e;
      if (attempt < retries) {
        await sleepImpl(backoffDelay(attempt, baseMs, capMs));
        continue;
      }
      throw e;
    }

    if (!RETRY_STATUS.has(res.status)) return res;

    const server = res.headers.get("server")?.toLowerCase() || "";
    if (
      res.status === 503 &&
      !retryCdn503 &&
      (server.includes("ddos-guard") || server.includes("cloudflare"))
    ) {
      throw new HttpError(
        res.status,
        `Request to ${url} blocked by ${server} (HTTP ${res.status}).`,
      );
    }

    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    const willRetry = attempt < retries;
    const floorMs = retryAfterMs ?? minBackoffMs;
    const delayMs = willRetry ? backoffDelay(attempt, baseMs, capMs, floorMs) : 0;
    const bodySnippet = willRetry ? undefined : await readBodySnippet(res);
    onAttempt?.({ status: res.status, attempt, retries, retryAfterMs, delayMs, willRetry, bodySnippet });
    if (!willRetry) {
      throw new HttpError(
        res.status,
        `Request to ${url} failed after ${retries} retries (HTTP ${res.status}).`,
        bodySnippet,
      );
    }
    await sleepImpl(delayMs);
  }

  throw lastError instanceof Error
    ? lastError
    : new HttpError(0, "fetchResilient exhausted without a response");
}
