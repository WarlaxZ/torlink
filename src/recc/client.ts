import type { FetchImpl } from "../util/net";
import { log } from "../util/logger";
import {
  SUGGEST_LIMIT,
  SUGGEST_TIMEOUT_MS,
  type TitleSuggestion,
  type TitleSuggestionType,
} from "../util/titleSuggest";

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

// reccd wraps its list endpoints in an object so a response-level `attribution`
// block can ride alongside plot text. Unknown siblings are ignored rather than
// rejected: torlink does not send `plot=true` today, and a parser that demanded
// exactly `results` would break the day it did.
//
// A bare array — reccd's format before the envelope — is deliberately NOT
// accepted. This build requires a reccd new enough to send the envelope; the two
// deploy together.
function resultsOf(body: unknown): unknown[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const r = (body as Record<string, unknown>).results;
  return Array.isArray(r) ? r : null;
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
    const results = resultsOf(body);
    if (results === null || !results.every(isRecommendation)) {
      return { ok: false, error: "unexpected response from reccd" };
    }
    return { ok: true, items: results };
  } catch (err) {
    log.debug(
      `recc fetchRecommendations: failed to reach ${config.reccUrl}/recommendations: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: "couldn't reach reccd" };
  }
}

export type FetchTitleSuggestionsResult =
  | { ok: true; items: TitleSuggestion[] }
  | { ok: false; error: string };

function isSuggestionType(v: unknown): v is TitleSuggestionType {
  return v === "movie" || v === "tv";
}

// All-or-nothing, like isRecommendation above: a body we only half understand
// is a contract change, and rendering the half we parsed would hide it.
function isTitleSuggestion(v: unknown): v is TitleSuggestion & Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.imdbId === "string" &&
    typeof r.title === "string" &&
    typeof r.year === "number" &&
    isSuggestionType(r.type) &&
    (r.matchedAka === null || typeof r.matchedAka === "string")
  );
}

/**
 * reccd's `GET /search` — partial input to a ranked list of catalog titles.
 *
 * A blocking read like `fetchRecommendations`, and a discriminated result for
 * the same reason. But the CALLERS treat failure differently: this fires per
 * keystroke, so every one of these errors is rendered as "no suggestions" and
 * nothing else. An error banner per keystroke is worse than no suggestions.
 *
 * `q` is sent verbatim. reccd parses a trailing year out of it itself and has
 * its own literal-interpretation fallback for titles that genuinely end in a
 * year, so stripping one here would break both.
 */
export async function fetchTitleSuggestions(
  config: ReccClientConfig,
  query: { q: string; limit?: number },
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<FetchTitleSuggestionsResult> {
  if (!config.reccUrl) return { ok: false, error: "title search not configured" };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  const params = new URLSearchParams();
  params.set("q", query.q);
  params.set("limit", String(query.limit ?? SUGGEST_LIMIT));
  try {
    const res = await fetchImpl(`${config.reccUrl}/search?${params.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? SUGGEST_TIMEOUT_MS),
    });
    if (res.status === 401) return { ok: false, error: "reccd rejected the token — check reccToken" };
    // A reccd older than the /search endpoint. Not a fault — the feature is
    // simply unavailable, and the search box must behave as it did before.
    if (res.status === 404) return { ok: false, error: "this reccd has no title search" };
    if (!res.ok) return { ok: false, error: `title search unavailable (HTTP ${res.status})` };
    const body: unknown = await res.json();
    const results = resultsOf(body);
    if (results === null || !results.every(isTitleSuggestion)) {
      return { ok: false, error: "unexpected response from reccd" };
    }
    // Narrowed deliberately: reccd also sends genres, rating and votes, and
    // nothing here renders them.
    const items: TitleSuggestion[] = results.map((r) => ({
      imdbId: r.imdbId,
      title: r.title,
      year: r.year,
      type: r.type,
      matchedAka: r.matchedAka,
    }));
    return { ok: true, items };
  } catch (err) {
    log.debug(
      `recc fetchTitleSuggestions: failed to reach ${config.reccUrl}/search: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: "couldn't reach reccd" };
  }
}

export type ClaimReccResult =
  | { ok: true; name: string }
  | {
      ok: false;
      reason: "nameTaken" | "alreadyClaimed" | "invalid" | "unauthorized" | "unreachable";
      message: string;
    };

// Claims an anonymous account: sets the username and password the user chose,
// keeping the account's id, token and history.
//
// Blocking and reporting, unlike postEvent: the user is watching a prompt and
// needs to be told what happened. `message` is what the pane prints, so it is a
// sentence rather than a status code — except for a plain validation 400, where
// reccd's own wording ("password must be at least 8 characters") is better than
// anything this layer could invent, so it is passed through.
export async function claimReccAccount(
  config: ReccClientConfig,
  name: string,
  password: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<ClaimReccResult> {
  if (!config.reccUrl) {
    return { ok: false, reason: "unreachable", message: "reccd is not configured." };
  }
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  try {
    const res = await fetchImpl(`${config.reccUrl}/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.reccToken ?? ""}`,
      },
      body: JSON.stringify({ name, password }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
    });
    if (res.ok) return { ok: true, name };
    if (res.status === 409) {
      return { ok: false, reason: "nameTaken", message: "That username is taken — try another." };
    }
    if (res.status === 401) {
      return { ok: false, reason: "unauthorized", message: "reccd rejected the token — check the connection." };
    }
    if (res.status === 400) {
      const body: unknown = await res.json().catch(() => ({}));
      const error = typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
      if (error === "account already claimed") {
        return {
          ok: false,
          reason: "alreadyClaimed",
          message: "This account already has a username and password.",
        };
      }
      return { ok: false, reason: "invalid", message: error || "reccd rejected that username or password." };
    }
    return { ok: false, reason: "unreachable", message: `reccd couldn't claim the account (HTTP ${res.status}).` };
  } catch (err) {
    // Never the password, and never the name — this string reaches the log.
    log.debug(`recc claimReccAccount: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "unreachable", message: "couldn't reach reccd" };
  }
}
