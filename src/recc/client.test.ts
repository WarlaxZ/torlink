import { describe, it, expect, vi } from "vitest";
import { postEvent } from "./client.js";

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
});
