import type { FetchImpl } from "../util/net";
import type { ReccClientConfig } from "./client";

export type ReccConnection = "unconfigured" | "connected" | "badToken" | "unreachable";

export interface ReccStatus {
  state: ReccConnection;
  host?: string;
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
    return { state: "connected", host };
  } catch {
    return { state: "unreachable", host };
  }
}

// One-line status for the Accounts row / setup prompt.
export function formatReccStatus(status: ReccStatus | null): string {
  if (!status || status.state === "unconfigured") return "Not configured";
  switch (status.state) {
    case "connected":
      return `Connected · ${status.host}`;
    case "badToken":
      return "Token rejected";
    case "unreachable":
      return `Unreachable · ${status.host}`;
  }
}
