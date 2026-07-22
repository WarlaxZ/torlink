import { log } from "../util/logger";
import type { FetchImpl, SleepImpl } from "../util/net";
import type { ReccClientConfig } from "./client";

const NOT_LINKED = "reccd is not linked — set it up in Accounts first";
const BAD_TOKEN = "reccd rejected the token — check reccToken";
const NOT_CONFIGURED = "Trakt isn't enabled on your reccd server";
const UNREACHABLE = "couldn't reach reccd";

export interface TraktRequestOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export interface TraktConnectInfo {
  userCode: string;
  verificationUrl: string;
  interval: number; // seconds between status polls
  expiresIn: number; // seconds until the device code expires
}

export type TraktStatus = "pending" | "connected" | "expired";

export interface TraktImportResult {
  imported: number;
  resolved: number;
  unresolved: number;
  unresolvedTitles: string[];
}

export type TraktConnectOutcome =
  | { ok: true; info: TraktConnectInfo }
  | { ok: false; error: string; notConfigured?: boolean };

export type TraktStatusOutcome =
  | { ok: true; status: TraktStatus }
  | { ok: false; error: string; notConfigured?: boolean };

export type TraktImportOutcome =
  | { ok: true; result: TraktImportResult }
  | { ok: false; error: string; notConnected?: boolean; notConfigured?: boolean };

function post(config: ReccClientConfig, path: string, fetchImpl: FetchImpl, timeoutMs: number): Promise<Response> {
  return fetchImpl(`${config.reccUrl}${path}`, {
    method: "POST",
    // reccd's server always requires a token, so an empty string here (rather
    // than omitting the header) is deliberate: a forgotten reccToken produces a
    // clean 401 instead of a silently different request.
    headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function connectTrakt(config: ReccClientConfig, opts: TraktRequestOptions = {}): Promise<TraktConnectOutcome> {
  if (!config.reccUrl) return { ok: false, error: NOT_LINKED };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  let res: Response;
  try {
    res = await post(config, "/import/trakt/connect", fetchImpl, opts.timeoutMs ?? 15000);
  } catch (err) {
    log.debug(`trakt connect: failed to reach ${config.reccUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: UNREACHABLE };
  }
  if (res.status === 401) return { ok: false, error: BAD_TOKEN };
  if (res.status === 501) return { ok: false, error: NOT_CONFIGURED, notConfigured: true };
  if (!res.ok) return { ok: false, error: `Trakt request failed (HTTP ${res.status})` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const userCode = body.userCode;
  const verificationUrl = body.verificationUrl;
  if (typeof userCode !== "string" || typeof verificationUrl !== "string") {
    return { ok: false, error: "unexpected response from reccd" };
  }
  return {
    ok: true,
    info: {
      userCode,
      verificationUrl,
      interval: Number(body.interval) || 5,
      expiresIn: Number(body.expiresIn) || 600,
    },
  };
}

export async function checkTraktStatus(config: ReccClientConfig, opts: TraktRequestOptions = {}): Promise<TraktStatusOutcome> {
  if (!config.reccUrl) return { ok: false, error: NOT_LINKED };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  let res: Response;
  try {
    res = await post(config, "/import/trakt/connect/status", fetchImpl, opts.timeoutMs ?? 15000);
  } catch (err) {
    log.debug(`trakt status: failed to reach ${config.reccUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: UNREACHABLE };
  }
  if (res.status === 401) return { ok: false, error: BAD_TOKEN };
  if (res.status === 501) return { ok: false, error: NOT_CONFIGURED, notConfigured: true };
  if (!res.ok) return { ok: false, error: `Trakt request failed (HTTP ${res.status})` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.status === "pending" || body.status === "connected" || body.status === "expired") {
    return { ok: true, status: body.status };
  }
  return { ok: false, error: "unexpected response from reccd" };
}

export async function runTraktImport(config: ReccClientConfig, opts: TraktRequestOptions = {}): Promise<TraktImportOutcome> {
  if (!config.reccUrl) return { ok: false, error: NOT_LINKED };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  let res: Response;
  try {
    res = await post(config, "/import/trakt", fetchImpl, opts.timeoutMs ?? 60000);
  } catch (err) {
    log.debug(`trakt import: failed to reach ${config.reccUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: UNREACHABLE };
  }
  if (res.status === 401) return { ok: false, error: BAD_TOKEN };
  if (res.status === 501) return { ok: false, error: NOT_CONFIGURED, notConfigured: true };
  if (res.status === 400) return { ok: false, error: "not connected to Trakt yet", notConnected: true };
  if (!res.ok) return { ok: false, error: `Trakt import failed (HTTP ${res.status})` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(body.unresolvedTitles) ? body.unresolvedTitles : []) {
    if (typeof t === "string" && !seen.has(t)) {
      seen.add(t);
      titles.push(t);
    }
  }
  return {
    ok: true,
    result: {
      imported: Number(body.imported) || 0,
      resolved: Number(body.resolved) || 0,
      unresolved: Number(body.unresolved) || 0,
      unresolvedTitles: titles,
    },
  };
}

export interface TraktFlowCallbacks {
  // Fires once the device code is issued: show the code + verification URL.
  onConnect?: (info: TraktConnectInfo) => void;
  // Fires on each poll result while waiting for the user to authorize.
  onStatus?: (status: TraktStatus) => void;
  // Fires just before the (post-authorization) import runs.
  onImporting?: () => void;
}

export interface TraktFlowOptions extends TraktRequestOptions {
  sleepImpl?: SleepImpl;
}

const defaultSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Orchestrates the full import. reccd persists the Trakt token, so the first
// step is an optimistic import: if a token is already stored it succeeds and we
// return straight away (no re-authorization). Only a "not connected" result
// drops into the device-code handshake (connect → poll → import).
export async function runTraktFlow(
  config: ReccClientConfig,
  callbacks: TraktFlowCallbacks = {},
  opts: TraktFlowOptions = {},
): Promise<TraktImportOutcome> {
  const sleep = opts.sleepImpl ?? defaultSleep;

  const first = await runTraktImport(config, opts);
  if (first.ok || !first.notConnected) return first; // success, or a real error (incl. notConfigured)

  const connect = await connectTrakt(config, opts);
  if (!connect.ok) return connect;
  callbacks.onConnect?.(connect.info);

  const interval = Math.max(1, connect.info.interval);
  const maxPolls = Math.max(1, Math.ceil(connect.info.expiresIn / interval));
  for (let i = 0; i < maxPolls; i++) {
    await sleep(interval * 1000);
    const status = await checkTraktStatus(config, opts);
    if (!status.ok) return status;
    callbacks.onStatus?.(status.status);
    if (status.status === "connected") {
      callbacks.onImporting?.();
      return runTraktImport(config, opts);
    }
    if (status.status === "expired") break;
  }
  return { ok: false, error: "Trakt authorization expired — try again" };
}
