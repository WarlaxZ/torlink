import { fetchResilient, HttpError, USER_AGENT, type FetchImpl } from "../util/net";

export type RealDebridFetch = FetchImpl;

const BASE = "https://api.real-debrid.com/rest/1.0";

// Torrent lifecycle on Real-Debrid. `downloaded` is the only success state; the
// rest are either in-progress (keep polling) or terminal failures.
const DONE_STATUS = "downloaded";
const ERROR_STATUSES = new Set(["error", "magnet_error", "virus", "dead"]);

const DEFAULT_POLL_MS = 2000;

export interface ResolvedFile {
  url: string;
  filename: string;
  bytes: number;
}

export interface RealDebridUser {
  username: string;
  email?: string;
  // "premium" | "free". Torrents require a premium account.
  type?: string;
  // Seconds of premium remaining (0 when free/expired).
  premium?: number;
  expiration?: string;
}

// Torrents only work on a premium, non-expired account.
export function isPremiumActive(user: RealDebridUser): boolean {
  return user.type === "premium" && (user.premium ?? 0) > 0;
}

export interface TorrentInfo {
  status: string;
  progress?: number;
  links?: string[];
  filename?: string;
}

export interface TorrentListItem {
  id: string;
  hash?: string;
  status: string;
  filename?: string;
}

// A user-facing failure from Real-Debrid (bad token, dead magnet, outage…).
// `message` is safe to show in the UI.
export class RealDebridError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "RealDebridError";
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions {
  fetchImpl?: RealDebridFetch;
  sleepImpl?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  // Retry budget for this call. Defaults to a couple of retries; set 0 for
  // non-idempotent calls (addMagnet) where a retry could duplicate work.
  retries?: number;
}

export interface ResolveOptions extends RequestOptions {
  onProgress?: (percent: number) => void;
  pollIntervalMs?: number;
  // The torrent's infoHash (hex). When given, an already-added torrent with the
  // same hash is reused instead of adding a duplicate to the user's RD account
  // (and a cached one resolves instantly).
  knownHash?: string;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RealDebridError("Real-Debrid request cancelled.");
}

function mapStatus(status: number, code?: string): RealDebridError {
  if (status === 401 || status === 403) {
    return new RealDebridError("Real-Debrid rejected the token (invalid or expired).", status, code);
  }
  if (status === 404) {
    return new RealDebridError("Real-Debrid could not find this resource.", status, code);
  }
  if (status === 503) {
    return new RealDebridError("Real-Debrid is temporarily unavailable.", status, code);
  }
  return new RealDebridError(
    code
      ? `Real-Debrid error: ${code} (HTTP ${status}).`
      : `Real-Debrid request failed (HTTP ${status}).`,
    status,
    code,
  );
}

async function request(
  token: string,
  method: "GET" | "POST",
  path: string,
  body: Record<string, string> | undefined,
  opts: RequestOptions,
): Promise<Response> {
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
    });
  } catch (e) {
    if (e instanceof HttpError) throw mapStatus(e.status, e.message);
    throw new RealDebridError(e instanceof Error ? e.message : String(e));
  }

  if (!res.ok) {
    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { error?: string };
      code = parsed?.error;
    } catch {
      /* body may be empty or non-JSON */
    }
    throw mapStatus(res.status, code);
  }
  return res;
}

export async function validateToken(token: string, opts: RequestOptions = {}): Promise<RealDebridUser> {
  const res = await request(token, "GET", "/user", undefined, opts);
  return (await res.json()) as RealDebridUser;
}

export async function addMagnet(
  token: string,
  magnet: string,
  opts: RequestOptions = {},
): Promise<{ id: string }> {
  // No retries: addMagnet isn't idempotent, and a retry after a transient 5xx
  // that actually succeeded would leave a duplicate torrent in the account.
  const res = await request(token, "POST", "/torrents/addMagnet", { magnet }, { ...opts, retries: 0 });
  return (await res.json()) as { id: string };
}

export async function selectFiles(
  token: string,
  id: string,
  opts: RequestOptions = {},
  files = "all",
): Promise<void> {
  await request(token, "POST", `/torrents/selectFiles/${id}`, { files }, opts);
}

export async function listTorrents(
  token: string,
  opts: RequestOptions = {},
  limit = 100,
  page = 1,
): Promise<TorrentListItem[]> {
  const res = await request(token, "GET", `/torrents?limit=${limit}&page=${page}`, undefined, opts);
  const parsed = (await res.json()) as unknown;
  return Array.isArray(parsed) ? (parsed as TorrentListItem[]) : [];
}

// Reuse lookup is bounded so a power user with thousands of torrents doesn't
// turn every download into a long scan; we page until a match, the end of the
// list, or this cap (covers the most recent ~500 torrents).
const REUSE_PAGE_LIMIT = 100;
const REUSE_MAX_PAGES = 5;

// Find a usable (non-error) torrent already in the account with this infoHash.
export async function findTorrentByHash(
  token: string,
  hash: string,
  opts: RequestOptions = {},
): Promise<TorrentListItem | undefined> {
  const wanted = hash.toLowerCase();
  for (let page = 1; page <= REUSE_MAX_PAGES; page++) {
    const list = await listTorrents(token, opts, REUSE_PAGE_LIMIT, page);
    const hit = list.find((t) => t.hash?.toLowerCase() === wanted && !ERROR_STATUSES.has(t.status));
    if (hit) return hit;
    if (list.length < REUSE_PAGE_LIMIT) break; // reached the end of the list
  }
  return undefined;
}

export async function getInfo(
  token: string,
  id: string,
  opts: RequestOptions = {},
): Promise<TorrentInfo> {
  const res = await request(token, "GET", `/torrents/info/${id}`, undefined, opts);
  return (await res.json()) as TorrentInfo;
}

export async function unrestrictLink(
  token: string,
  link: string,
  opts: RequestOptions = {},
): Promise<ResolvedFile> {
  const res = await request(token, "POST", "/unrestrict/link", { link }, opts);
  const parsed = (await res.json()) as { download: string; filename: string; filesize?: number };
  return { url: parsed.download, filename: parsed.filename, bytes: parsed.filesize ?? 0 };
}

/**
 * Drive a magnet through the full Real-Debrid pipeline and return the direct,
 * downloadable file links:
 *   addMagnet → selectFiles(all) → poll info until `downloaded` → unrestrict each link.
 * `onProgress` reports the RD-side caching progress (0-100) while polling.
 */
export async function resolveMagnet(
  token: string,
  magnet: string,
  opts: ResolveOptions = {},
): Promise<ResolvedFile[]> {
  const { onProgress, pollIntervalMs = DEFAULT_POLL_MS, sleepImpl = realSleep, signal, knownHash } =
    opts;

  throwIfAborted(signal);

  // Reuse a torrent already in the user's RD pool (same infoHash) rather than
  // adding a duplicate. A cached one is already "downloaded", so this is the
  // instant path; one still awaiting selection just needs selectFiles.
  let id: string | undefined;
  // Whether files have been selected yet. A reused torrent that's still
  // converting hasn't reached file selection, so we may have to do it later in
  // the poll loop once it transitions to waiting_files_selection.
  let selected = false;
  if (knownHash) {
    try {
      const existing = await findTorrentByHash(token, knownHash, opts);
      if (existing) {
        id = existing.id;
        if (existing.status === "waiting_files_selection") {
          await selectFiles(token, id, opts);
          selected = true;
        } else if (existing.status === DONE_STATUS) {
          selected = true;
        }
      }
    } catch {
      // A transient listing failure shouldn't block the download; just add fresh.
    }
  }

  if (!id) {
    id = (await addMagnet(token, magnet, opts)).id;
    await selectFiles(token, id, opts);
    selected = true;
  }

  let links: string[] = [];
  for (;;) {
    throwIfAborted(signal);
    const info = await getInfo(token, id, opts);
    onProgress?.(info.progress ?? 0);
    if (info.status === DONE_STATUS) {
      links = info.links ?? [];
      break;
    }
    if (ERROR_STATUSES.has(info.status)) {
      throw new RealDebridError(`Real-Debrid could not fetch this torrent (${info.status}).`);
    }
    // A reused torrent can reach selection only after conversion; select once it
    // gets there so it doesn't sit waiting forever.
    if (info.status === "waiting_files_selection" && !selected) {
      await selectFiles(token, id, opts);
      selected = true;
    }
    await sleepImpl(pollIntervalMs);
  }

  if (links.length === 0) {
    throw new RealDebridError("Real-Debrid returned no downloadable links.");
  }

  const files: ResolvedFile[] = [];
  for (const link of links) {
    throwIfAborted(signal);
    files.push(await unrestrictLink(token, link, opts));
  }
  return files;
}
