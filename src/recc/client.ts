import type { FetchImpl } from "../util/net";

export type ReccEventType =
  | "started"
  | "watched"
  | "favourited"
  | "unfavourited"
  | "liked"
  | "disliked"
  | "abandoned";

export interface ReccEvent {
  type: ReccEventType;
  rawName: string;
  ts: number;
  source: string;
}

export interface ReccClientConfig {
  reccUrl?: string;
  reccToken?: string;
}

export interface PostEventOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

// Fire-and-forget: posts a single event to the self-hosted reccd service.
// reccd being unreachable, slow, or erroring must never affect torlink — any
// failure (network error, non-2xx response) is swallowed silently.
export async function postEvent(
  config: ReccClientConfig,
  event: ReccEvent,
  opts: PostEventOptions = {},
): Promise<void> {
  if (!config.reccUrl) return;
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  try {
    const res = await fetchImpl(`${config.reccUrl}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.reccToken ?? ""}`,
      },
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
    if (!res.ok) return;
  } catch {
    // Network error, timeout, etc. — never surface to the caller.
  }
}
