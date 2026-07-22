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

export interface Recommendation {
  imdbId: string;
  title: string;
  year: number;
  score: number;
  reasons: string[];
}

export interface RecommendationQuery {
  type?: "movie" | "tv";
  genre?: string;
  explore?: boolean;
  limit?: number;
}

export type FetchRecommendationsResult =
  | { ok: true; items: Recommendation[] }
  | { ok: false; error: string };

function isRecommendation(v: unknown): v is Recommendation {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.imdbId === "string" &&
    typeof r.title === "string" &&
    typeof r.year === "number" &&
    typeof r.score === "number" &&
    Array.isArray(r.reasons) &&
    r.reasons.every((x) => typeof x === "string")
  );
}

// A blocking read, unlike the fire-and-forget postEvent: the user is waiting on
// these results, so failures are surfaced as a discriminated result rather than
// swallowed. reccd returns no magnet — the caller starts a torrent search from
// the returned title.
export async function fetchRecommendations(
  config: ReccClientConfig,
  query: RecommendationQuery,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<FetchRecommendationsResult> {
  if (!config.reccUrl) return { ok: false, error: "recommendations not configured" };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.genre && query.genre.trim()) params.set("genre", query.genre.trim());
  if (query.explore) params.set("explore", "true");
  params.set("limit", String(query.limit ?? 20));
  try {
    const res = await fetchImpl(`${config.reccUrl}/recommendations?${params.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
    });
    if (res.status === 401) return { ok: false, error: "reccd rejected the token — check reccToken" };
    if (!res.ok) return { ok: false, error: `recommendations unavailable (HTTP ${res.status})` };
    const body: unknown = await res.json();
    if (!Array.isArray(body) || !body.every(isRecommendation)) {
      return { ok: false, error: "unexpected response from reccd" };
    }
    return { ok: true, items: body };
  } catch (err) {
    log.debug(
      `recc fetchRecommendations: failed to reach ${config.reccUrl}/recommendations: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: "couldn't reach reccd" };
  }
}
