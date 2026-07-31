import { describe, it, expect, vi } from "vitest";
import { postEvent, fetchRecommendations, fetchTitleSuggestions } from "./client.js";
import type { FetchImpl } from "../util/net";

function jsonRes(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("postEvent", () => {
  it("posts to {reccUrl}/events with a bearer token and the event payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(202, { accepted: 1 }));
    await postEvent(
      { reccUrl: "http://localhost:4100", reccToken: "dev-token" },
      { type: "watched", rawName: "The.Ashfall.1999.1080p", ts: 1000, source: "torlink" },
      { fetchImpl }
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:4100/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer dev-token" }),
      })
    );
  });

  it("does nothing when reccUrl is not configured", async () => {
    const fetchImpl = vi.fn();
    await postEvent({}, { type: "watched", rawName: "x", ts: 1, source: "torlink" }, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows network errors without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      postEvent({ reccUrl: "http://localhost:4100", reccToken: "t" }, { type: "watched", rawName: "x", ts: 1, source: "torlink" }, { fetchImpl })
    ).resolves.toBeUndefined();
  });

  it("swallows non-2xx responses without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(500));
    await expect(
      postEvent({ reccUrl: "http://localhost:4100", reccToken: "t" }, { type: "watched", rawName: "x", ts: 1, source: "torlink" }, { fetchImpl })
    ).resolves.toBeUndefined();
  });

  it("sends a request body of exactly { events: [event] }", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(202, { accepted: 1 }));
    const event = { type: "watched" as const, rawName: "The.Ashfall.1999.1080p", ts: 1000, source: "torlink" };
    await postEvent({ reccUrl: "http://localhost:4100", reccToken: "dev-token" }, event, { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ events: [event] });
  });

  it("still fires with an empty bearer token when reccToken is omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(202, { accepted: 1 }));
    await postEvent(
      { reccUrl: "http://localhost:4100" },
      { type: "watched", rawName: "x", ts: 1, source: "torlink" },
      { fetchImpl }
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:4100/events",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer " }),
      })
    );
  });
});

function fakeFetch(
  handler: (url: string) => { status: number; body?: unknown; throwErr?: boolean },
): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    const r = handler(String(url));
    if (r.throwErr) throw new Error("network down");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

const CONFIG = { reccUrl: "http://host:4100", reccToken: "tok" };
const REC = { imdbId: "tt1", title: "Windmere", year: 2019, score: 33.4, reasons: ["highly rated classic"] };

describe("fetchRecommendations", () => {
  it("returns ok with parsed items on 200", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [REC] }));
    const res = await fetchRecommendations(CONFIG, { limit: 5 }, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, items: [REC] });
  });

  it("builds the query string from provided filters", async () => {
    const { impl, urls } = fakeFetch(() => ({ status: 200, body: [] }));
    await fetchRecommendations(CONFIG, { type: "movie", genre: "Western", explore: true, limit: 5 }, { fetchImpl: impl });
    expect(urls[0]).toContain("/recommendations?");
    expect(urls[0]).toContain("type=movie");
    expect(urls[0]).toContain("genre=Western");
    expect(urls[0]).toContain("explore=true");
    expect(urls[0]).toContain("limit=5");
  });

  it("omits type/genre/explore when unset and defaults limit to 20", async () => {
    const { impl, urls } = fakeFetch(() => ({ status: 200, body: [] }));
    await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(urls[0]).not.toContain("type=");
    expect(urls[0]).not.toContain("genre=");
    expect(urls[0]).not.toContain("explore=");
    expect(urls[0]).toContain("limit=20");
  });

  it("maps 401 to a token error", async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "reccd rejected the token — check reccToken" });
  });

  it("maps other non-2xx to an unavailable error", async () => {
    const { impl } = fakeFetch(() => ({ status: 500 }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "recommendations unavailable (HTTP 500)" });
  });

  it("maps a network throw to an unreachable error", async () => {
    const { impl } = fakeFetch(() => ({ status: 0, throwErr: true }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "couldn't reach reccd" });
  });

  it("rejects a malformed body", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [{ imdbId: 1 }] }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("returns a not-configured error when reccUrl is missing", async () => {
    const res = await fetchRecommendations({ reccToken: "t" }, {});
    expect(res).toEqual({ ok: false, error: "recommendations not configured" });
  });
});

describe("fetchTitleSuggestions", () => {
  const HIT = {
    imdbId: "tt0000001",
    title: "Kestrel",
    year: 2010,
    type: "movie",
    matchedAka: null,
  };
  // reccd returns more than torlink models — this is what actually comes back.
  const WIRE_HIT = { ...HIT, genres: ["Drama"], rating: 7.4, votes: 90000 };

  it("gets {reccUrl}/search with q, limit and a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [WIRE_HIT]));
    const res = await fetchTitleSuggestions(
      { reccUrl: "http://localhost:4100", reccToken: "dev-token" },
      { q: "kes" },
      { fetchImpl },
    );
    expect(res).toEqual({ ok: true, items: [HIT] });
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe("http://localhost:4100/search?q=kes&limit=8");
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer dev-token");
  });

  it("drops the fields torlink does not render", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [WIRE_HIT]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0]).not.toHaveProperty("votes");
    expect(res.items[0]).not.toHaveProperty("rating");
    expect(res.items[0]).not.toHaveProperty("genres");
  });

  // reccd parses a trailing year out of q itself, and its own fallback rescues
  // titles that genuinely end in a year. Stripping it here would break both.
  it("forwards a year in the query verbatim rather than parsing it out", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, []));
    await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kestrel 2010" }, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("http://r/search?q=kestrel+2010&limit=8");
  });

  it("does not call fetch at all when reccUrl is not configured", async () => {
    const fetchImpl = vi.fn();
    const res = await fetchTitleSuggestions({}, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a rejected token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(401, { error: "unauthorized" }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "bad" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "reccd rejected the token — check reccToken" });
  });

  // A reccd predating GET /search 404s. That is "this feature is unavailable",
  // not a fault, and must leave the search box behaving exactly as it does now.
  it("treats a 404 as an older reccd without the endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(404, { error: "not found" }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "this reccd has no title search" });
  });

  it("reports any other non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(500));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("rejects a body that is not an array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { items: [WIRE_HIT] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  // All-or-nothing, matching isRecommendation: a body we only half understand
  // is a contract change, and silently rendering the half we parsed would hide
  // it until someone noticed rows missing.
  it("rejects the whole array when one member is malformed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [WIRE_HIT, { imdbId: "tt2" }]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("rejects a hit whose type is neither movie nor tv", async () => {
    const bad = { ...WIRE_HIT, type: "tvEpisode" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [bad]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("accepts a hit that matched on an AKA", async () => {
    const aka = { ...WIRE_HIT, matchedAka: "Ashfall Rising" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [aka]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "ash" }, { fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0]?.matchedAka).toBe("Ashfall Rising");
  });

  it("never throws on a network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("honours an explicit limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, []));
    await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes", limit: 3 }, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("http://r/search?q=kes&limit=3");
  });

  it("still fires with an empty bearer token when reccToken is omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, []));
    await fetchTitleSuggestions({ reccUrl: "http://r" }, { q: "kes" }, { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe("Bearer ");
  });
});
