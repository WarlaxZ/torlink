import { describe, it, expect } from "vitest";
import { checkReccConnection, formatReccStatus } from "./status";
import type { FetchImpl } from "../util/net";

function fakeFetch(handler: (url: string) => { status: number; throwErr?: boolean }): FetchImpl {
  return (async (url: string) => {
    const r = handler(String(url));
    if (r.throwErr) throw new Error("network down");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => ({}) } as unknown as Response;
  }) as unknown as FetchImpl;
}

const CFG = { reccUrl: "http://192.168.0.98:4100", reccToken: "tok" };

describe("checkReccConnection", () => {
  it("returns unconfigured when reccUrl is missing", async () => {
    expect(await checkReccConnection({ reccToken: "t" })).toEqual({ state: "unconfigured" });
  });

  it("returns connected on 200", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetch(() => ({ status: 200 })) });
    expect(res).toEqual({ state: "connected", host: "192.168.0.98:4100" });
  });

  it("returns badToken on 401", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetch(() => ({ status: 401 })) });
    expect(res).toEqual({ state: "badToken", host: "192.168.0.98:4100" });
  });

  it("returns unreachable on other non-2xx", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetch(() => ({ status: 500 })) });
    expect(res).toEqual({ state: "unreachable", host: "192.168.0.98:4100" });
  });

  it("returns unreachable on a network error", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetch(() => ({ status: 0, throwErr: true })) });
    expect(res).toEqual({ state: "unreachable", host: "192.168.0.98:4100" });
  });

  it("hits the /profile endpoint with a bearer header", async () => {
    let seen = "";
    const impl = (async (url: string, init: { headers?: Record<string, string> }) => {
      seen = String(url);
      expect(init.headers?.authorization).toBe("Bearer tok");
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as FetchImpl;
    await checkReccConnection(CFG, { fetchImpl: impl });
    expect(seen).toBe("http://192.168.0.98:4100/profile");
  });
});

describe("formatReccStatus", () => {
  it("formats each state", () => {
    expect(formatReccStatus(null)).toBe("Not configured");
    expect(formatReccStatus({ state: "unconfigured" })).toBe("Not configured");
    expect(formatReccStatus({ state: "connected", host: "h:4100" })).toBe("Connected · h:4100");
    expect(formatReccStatus({ state: "badToken", host: "h:4100" })).toBe("Token rejected");
    expect(formatReccStatus({ state: "unreachable", host: "h:4100" })).toBe("Unreachable · h:4100");
  });
});

function fakeFetchJson(status: number, body: unknown): FetchImpl {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response) as unknown as FetchImpl;
}

describe("checkReccConnection — account", () => {
  it("reports the account from /profile", async () => {
    const res = await checkReccConnection(CFG, {
      fetchImpl: fakeFetchJson(200, { seenImdbIds: [], account: { name: "quiet-heron-4f2a", claimed: false } }),
    });
    expect(res).toEqual({
      state: "connected",
      host: "192.168.0.98:4100",
      account: { name: "quiet-heron-4f2a", claimed: false },
    });
  });

  // An older self-hosted reccd predates the field. It must degrade, not throw.
  it("omits account when /profile does not carry one", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetchJson(200, { seenImdbIds: [] }) });
    expect(res).toEqual({ state: "connected", host: "192.168.0.98:4100" });
  });

  it("omits account when the field is the wrong shape", async () => {
    for (const account of ["nope", 7, null, {}, { name: "n" }, { name: 1, claimed: true }]) {
      const res = await checkReccConnection(CFG, { fetchImpl: fakeFetchJson(200, { account }) });
      expect(res.account).toBeUndefined();
      expect(res.state).toBe("connected");
    }
  });

  it("stays connected when the body is not JSON at all", async () => {
    const impl = (async () => ({
      ok: true, status: 200, json: async () => { throw new Error("not json"); },
    }) as unknown as Response) as unknown as FetchImpl;
    const res = await checkReccConnection(CFG, { fetchImpl: impl });
    expect(res).toEqual({ state: "connected", host: "192.168.0.98:4100" });
  });
});

describe("formatReccStatus — account suffix", () => {
  it("names an unclaimed account", () => {
    expect(
      formatReccStatus({ state: "connected", host: "reccd.stream", account: { name: "quiet-heron-4f2a", claimed: false } }),
    ).toBe("Connected · reccd.stream · quiet-heron-4f2a (unclaimed)");
  });

  it("names a claimed account without the marker", () => {
    expect(
      formatReccStatus({ state: "connected", host: "reccd.stream", account: { name: "ash", claimed: true } }),
    ).toBe("Connected · reccd.stream · ash");
  });

  it("is unchanged with no account", () => {
    expect(formatReccStatus({ state: "connected", host: "h:4100" })).toBe("Connected · h:4100");
  });

  it("adds no suffix to a state where it would be misleading", () => {
    const account = { name: "quiet-heron-4f2a", claimed: false };
    expect(formatReccStatus({ state: "badToken", host: "h", account })).toBe("Token rejected");
    expect(formatReccStatus({ state: "unreachable", host: "h", account })).toBe("Unreachable · h");
  });
});
