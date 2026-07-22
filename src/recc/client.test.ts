import { describe, it, expect, vi } from "vitest";
import { postEvent, fetchRecommendations } from "./client.js";
import type { FetchImpl } from "../util/net";

function jsonRes(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("postEvent", () => {
  it("posts to {reccUrl}/events with a bearer token and the event payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(202, { accepted: 1 }));
    await postEvent(
      { reccUrl: "http://localhost:4100", reccToken: "dev-token" },
      { type: "watched", rawName: "The.Matrix.1999.1080p", ts: 1000, source: "torlink" },
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
    const event = { type: "watched" as const, rawName: "The.Matrix.1999.1080p", ts: 1000, source: "torlink" };
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
const REC = { imdbId: "tt1", title: "Chernobyl", year: 2019, score: 33.4, reasons: ["highly rated classic"] };

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
