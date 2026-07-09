import type { FetchImpl } from "../util/net";
import { log } from "../util/logger";

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
//
// Deliberately uses plain injected fetch with a single attempt instead of
// fetchResilient (used for blocking calls like Real-Debrid): retrying a
// dropped analytics event during a reccd outage would pile up concurrent
// requests precisely when the target is struggling, the opposite of what's
// wanted here.
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
        // reccd's server always requires a token, so an empty string here
        // (rather than omitting the header) is deliberate: it produces a
        // clearly-wrong-looking auth attempt rather than silently masking a
        // forgotten reccToken config value.
        authorization: `Bearer ${config.reccToken ?? ""}`,
      },
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
    if (!res.ok) {
      log.debug(`recc postEvent: non-ok response from ${config.reccUrl}/events (status ${res.status})`);
      return;
    }
  } catch (err) {
    log.debug(
      `recc postEvent: failed to reach ${config.reccUrl}/events: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
