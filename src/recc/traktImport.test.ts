import { describe, it, expect, vi } from "vitest";
import { connectTrakt, checkTraktStatus, runTraktImport } from "./traktImport.js";
import type { FetchImpl } from "../util/net";

function jsonRes(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CONFIG = { reccUrl: "http://host:4100", reccToken: "tok" };

describe("connectTrakt", () => {
  it("POSTs to /import/trakt/connect with a bearer token and returns device info", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes(200, { userCode: "AB12-CD34", verificationUrl: "https://trakt.tv/activate", interval: 5, expiresIn: 600 }),
    );
    const outcome = await connectTrakt(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({
      ok: true,
      info: { userCode: "AB12-CD34", verificationUrl: "https://trakt.tv/activate", interval: 5, expiresIn: 600 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe("http://host:4100/import/trakt/connect");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok");
  });

  it("flags notConfigured on a 501", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(501, { error: "trakt not configured" }));
    const outcome = await connectTrakt(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({ ok: false, error: "Trakt isn't enabled on your reccd server", notConfigured: true });
  });

  it("maps 401 to a token error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(401, { error: "unauthorized" }));
    const outcome = await connectTrakt(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("reccd rejected the token — check reccToken");
  });

  it("returns a not-linked error when reccUrl is missing", async () => {
    const outcome = await connectTrakt({ reccToken: "t" });
    expect(outcome).toEqual({ ok: false, error: "reccd is not linked — set it up in Accounts first" });
  });
});

describe("checkTraktStatus", () => {
  it("returns the status string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { status: "pending" }));
    const outcome = await checkTraktStatus(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({ ok: true, status: "pending" });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe("http://host:4100/import/trakt/connect/status");
  });

  it("rejects an unexpected status value", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { status: "banana" }));
    const outcome = await checkTraktStatus(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
  });
});

describe("runTraktImport", () => {
  it("returns the aggregated result on 202", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes(202, { imported: 5, resolved: 5, unresolved: 0, unresolvedTitles: [] }),
    );
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({ ok: true, result: { imported: 5, resolved: 5, unresolved: 0, unresolvedTitles: [] } });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe("http://host:4100/import/trakt");
  });

  it("flags notConnected on a 400", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(400, { error: "not connected" }));
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.notConnected).toBe(true);
  });

  it("flags notConnected on a reconnect-required 400", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(400, { error: "reconnect required" }));
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.notConnected).toBe(true);
  });

  it("flags notConfigured on a 501", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(501, { error: "trakt not configured" }));
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.notConfigured).toBe(true);
  });

  it("coerces stringy numeric fields and drops non-string titles", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes(202, { imported: "3", resolved: "2", unresolved: "1", unresolvedTitles: ["Heat", 42] }),
    );
    const outcome = await runTraktImport(CONFIG, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.imported).toBe(3);
      expect(outcome.result.unresolvedTitles).toEqual(["Heat"]);
    }
  });
});
