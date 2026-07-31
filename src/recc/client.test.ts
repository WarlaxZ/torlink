import { describe, it, expect, vi } from "vitest";
import { postEvent, fetchRecommendations, fetchTitleSuggestions, claimReccAccount } from "./client.js";
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
    const { impl } = fakeFetch(() => ({ status: 200, body: { results: [REC] } }));
    const res = await fetchRecommendations(CONFIG, { limit: 5 }, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, items: [REC] });
  });

  // The envelope exists so an attribution block can accompany plot text. torlink
  // never asks for plots, but a parser that demanded EXACTLY `results` would
  // break the day it did — so unknown siblings are ignored, not rejected.
  it("ignores an attribution block sitting beside the results", async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: {
        attribution: {
          source: "reccd",
          licence: "CC BY-SA 4.0",
          licenceUrl: "https://example.invalid/licence",
          modified: true,
        },
        results: [REC],
      },
    }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, items: [REC] });
  });

  // reccd's previous wire format. Accepting it would let torlink run against a
  // reccd too old to send the envelope, which is deliberately not supported.
  it("rejects a bare array, the wire format reccd used before the envelope", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [REC] }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("rejects an envelope whose results is not an array", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { results: "nope" } }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("rejects an object with no results key at all", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: {} }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("builds the query string from provided filters", async () => {
    const { impl, urls } = fakeFetch(() => ({ status: 200, body: { results: [] } }));
    await fetchRecommendations(CONFIG, { type: "movie", genre: "Western", explore: true, limit: 5 }, { fetchImpl: impl });
    expect(urls[0]).toContain("/recommendations?");
    expect(urls[0]).toContain("type=movie");
    expect(urls[0]).toContain("genre=Western");
    expect(urls[0]).toContain("explore=true");
    expect(urls[0]).toContain("limit=5");
  });

  it("omits type/genre/explore when unset and defaults limit to 20", async () => {
    const { impl, urls } = fakeFetch(() => ({ status: 200, body: { results: [] } }));
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

  // Item-level validation, not envelope-level: the envelope here is valid, so
  // the only thing that can reject this body is isRecommendation.
  it("rejects an envelope whose items are malformed", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { results: [{ imdbId: 1 }] } }));
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
  // A series, so a PASSING case carries both of reccd's two type values. Without
  // one, `isSuggestionType`'s `|| v === "tv"` arm could be deleted with the whole
  // suite still green — and the consequence is not "TV stops suggesting":
  // `isTitleSuggestion` is all-or-nothing over `body.every`, so ONE series in the
  // top 8 would reject the entire array and the user would get no suggestions at
  // all, films included.
  const SHOW = {
    imdbId: "tt0000002",
    title: "Kepler",
    year: 2019,
    type: "tv",
    matchedAka: null,
  };
  // reccd returns more than torlink models — this is what actually comes back.
  const WIRE_HIT = { ...HIT, genres: ["Drama"], rating: 7.4, votes: 90000 };
  const WIRE_SHOW = { ...SHOW, genres: ["Mystery"], rating: 8.1, votes: 40000 };

  it("accepts both of reccd's types in one reply", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [WIRE_HIT, WIRE_SHOW] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "ke" }, { fetchImpl });
    // Asserted as the whole result: a series rejected here takes the film with it.
    expect(res).toEqual({ ok: true, items: [HIT, SHOW] });
  });

  it("reads the hits out of reccd's results envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [WIRE_HIT] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: true, items: [HIT] });
  });

  it("ignores an attribution block sitting beside the results", async () => {
    const body = {
      attribution: {
        source: "reccd",
        licence: "CC BY-SA 4.0",
        licenceUrl: "https://example.invalid/licence",
        modified: true,
      },
      results: [WIRE_HIT],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, body));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: true, items: [HIT] });
  });

  // reccd's previous wire format, deliberately unsupported.
  it("rejects a bare array, the wire format reccd used before the envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [WIRE_HIT]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("rejects an envelope whose results is not an array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: "nope" }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("gets {reccUrl}/search with q, limit and a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [WIRE_HIT] }));
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
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [WIRE_HIT] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Length first: `not.toHaveProperty` on `items[0]` is satisfied by an empty
    // array, so without this the three negatives below pass for no items at all.
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).not.toHaveProperty("votes");
    expect(res.items[0]).not.toHaveProperty("rating");
    expect(res.items[0]).not.toHaveProperty("genres");
  });

  // reccd parses a trailing year out of q itself, and its own fallback rescues
  // titles that genuinely end in a year. Stripping it here would break both.
  it("forwards a year in the query verbatim rather than parsing it out", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [] }));
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

  // The body is a VALID envelope and the error is asserted exactly, so this can
  // only be satisfied by the status check — delete the `!res.ok` branch and it
  // falls through to a successful parse rather than passing for a shape error.
  it("reports any other non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(500, { results: [] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "title search unavailable (HTTP 500)" });
  });

  // The name of the key matters: an object is now the valid shape, and this one
  // carries the hits under the wrong key.
  it("rejects an envelope with no results array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { items: [WIRE_HIT] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  // All-or-nothing, matching isRecommendation: a body we only half understand
  // is a contract change, and silently rendering the half we parsed would hide
  // it until someone noticed rows missing. The envelope here is valid, so
  // isTitleSuggestion is the only thing that can reject this.
  it("rejects the whole list when one member is malformed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [WIRE_HIT, { imdbId: "tt2" }] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("rejects a hit whose type is neither movie nor tv", async () => {
    const bad = { ...WIRE_HIT, type: "tvEpisode" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [bad] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("accepts a hit that matched on an AKA", async () => {
    const aka = { ...WIRE_HIT, matchedAka: "Ashfall Rising" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [aka] }));
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
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [] }));
    await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes", limit: 3 }, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("http://r/search?q=kes&limit=3");
  });

  it("still fires with an empty bearer token when reccToken is omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [] }));
    await fetchTitleSuggestions({ reccUrl: "http://r" }, { q: "kes" }, { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe("Bearer ");
  });
});

describe("claimReccAccount", () => {
  const CFG = { reccUrl: "https://reccd.stream", reccToken: "tok" };

  function reply(status: number, body: unknown) {
    return (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as FetchImpl;
  }

  it("returns the claimed name on 200", async () => {
    const res = await claimReccAccount(CFG, "chosen", "correcthorsebattery", {
      fetchImpl: reply(200, { name: "chosen" }),
    });
    expect(res).toEqual({ ok: true, name: "chosen" });
  });

  it("POSTs name and password to /claim with the bearer token", async () => {
    let seenUrl = "";
    let seenInit: { headers?: Record<string, string>; body?: string; method?: string } = {};
    const impl = (async (url: string, init: typeof seenInit) => {
      seenUrl = String(url);
      seenInit = init;
      return { ok: true, status: 200, json: async () => ({ name: "chosen" }) } as unknown as Response;
    }) as unknown as FetchImpl;
    await claimReccAccount(CFG, "chosen", "correcthorsebattery", { fetchImpl: impl });
    expect(seenUrl).toBe("https://reccd.stream/claim");
    expect(seenInit.method).toBe("POST");
    expect(seenInit.headers?.authorization).toBe("Bearer tok");
    expect(JSON.parse(seenInit.body!)).toEqual({ name: "chosen", password: "correcthorsebattery" });
  });

  it("maps 409 to nameTaken", async () => {
    const res = await claimReccAccount(CFG, "taken", "correcthorsebattery", {
      fetchImpl: reply(409, { error: "name already taken" }),
    });
    expect(res).toEqual({ ok: false, reason: "nameTaken", message: "That username is taken — try another." });
  });

  it("maps 400 account already claimed to alreadyClaimed", async () => {
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", {
      fetchImpl: reply(400, { error: "account already claimed" }),
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("alreadyClaimed");
  });

  it("passes any other 400's own message through, so validation reads clearly", async () => {
    const res = await claimReccAccount(CFG, "x", "short", {
      fetchImpl: reply(400, { error: "password must be at least 8 characters" }),
    });
    expect(res).toEqual({ ok: false, reason: "invalid", message: "password must be at least 8 characters" });
  });

  it("falls back to a readable message when a 400 carries no error string", async () => {
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", { fetchImpl: reply(400, {}) });
    expect(res).toEqual({ ok: false, reason: "invalid", message: "reccd rejected that username or password." });
  });

  it("maps 401 to unauthorized", async () => {
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", { fetchImpl: reply(401, {}) });
    expect((res as { reason: string }).reason).toBe("unauthorized");
  });

  it("maps a 500 to unreachable", async () => {
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", { fetchImpl: reply(500, {}) });
    expect((res as { reason: string }).reason).toBe("unreachable");
  });

  it("maps a network error to unreachable rather than throwing", async () => {
    const impl = (async () => { throw new Error("ENOTFOUND"); }) as unknown as FetchImpl;
    const res = await claimReccAccount(CFG, "x", "correcthorsebattery", { fetchImpl: impl });
    expect((res as { reason: string }).reason).toBe("unreachable");
  });

  it("reports unreachable rather than calling out when no reccUrl is configured", async () => {
    let called = false;
    const impl = (async () => { called = true; return {} as unknown as Response; }) as unknown as FetchImpl;
    const res = await claimReccAccount({}, "x", "correcthorsebattery", { fetchImpl: impl });
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("never puts the password in a log-shaped return value", async () => {
    const res = await claimReccAccount(CFG, "x", "supersecretpassword", { fetchImpl: reply(500, {}) });
    expect(JSON.stringify(res)).not.toContain("supersecretpassword");
  });
});
