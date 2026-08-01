import type { FetchImpl } from "../util/net";
import type { ReccClientConfig } from "./client";

export type ReccConnection = "unconfigured" | "connected" | "badToken" | "unreachable";

export interface ReccAccount {
  name: string;
  claimed: boolean;
}

export interface ReccStatus {
  state: ReccConnection;
  host?: string;
  /**
   * Who reccd thinks we are, from GET /profile. Absent when the connection is
   * not up, or when reccd is an older self-hosted build that predates the
   * field — an unrecognised or malformed body must degrade to "no account
   * shown", never throw. reccd going wrong may cost this suffix and nothing.
   */
  account?: ReccAccount;
}

function parseAccount(body: unknown): ReccAccount | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const account = (body as { account?: unknown }).account;
  if (typeof account !== "object" || account === null) return undefined;
  const a = account as Record<string, unknown>;
  if (typeof a.name !== "string" || typeof a.claimed !== "boolean") return undefined;
  return { name: a.name, claimed: a.claimed };
}

function hostOf(reccUrl: string): string {
  try {
    return new URL(reccUrl).host || reccUrl;
  } catch {
    return reccUrl;
  }
}

// Pings reccd's authenticated GET /profile to classify the connection for the
// Accounts pane. Never throws — network/timeout/other errors map to
// "unreachable". /profile is a cheap authenticated GET that cleanly separates
// 200 (connected) from 401 (bad token).
export async function checkReccConnection(
  config: ReccClientConfig,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<ReccStatus> {
  if (!config.reccUrl) return { state: "unconfigured" };
  const host = hostOf(config.reccUrl);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  try {
    const res = await fetchImpl(`${config.reccUrl}/profile`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
    });
    if (res.status === 401) return { state: "badToken", host };
    if (!res.ok) return { state: "unreachable", host };
    // A body we cannot read costs the name suffix, not the verdict: the 200
    // already proves the token works, which is what this function is for.
    const body: unknown = await res.json().catch(() => undefined);
    const account = parseAccount(body);
    return account ? { state: "connected", host, account } : { state: "connected", host };
  } catch {
    return { state: "unreachable", host };
  }
}

// One-line status for the Accounts row / setup prompt.
export function formatReccStatus(status: ReccStatus | null): string {
  if (!status || status.state === "unconfigured") return "Not configured";
  switch (status.state) {
    case "connected": {
      const base = `Connected · ${status.host}`;
      if (!status.account) return base;
      const { name, claimed } = status.account;
      return `${base} · ${name}${claimed ? "" : " (unclaimed)"}`;
    }
    case "badToken":
      return "Token rejected";
    case "unreachable":
      return `Unreachable · ${status.host}`;
  }
}
