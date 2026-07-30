import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTokenRejection, isTransient, TOKEN_REJECTED_MESSAGE, validateToken } from "./torbox";
import { log } from "../../util/logger";

const TOKEN = "tb-secret-token-abc123";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A JSON Response, hand-rolled so no network is involved. */
function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * A fetch stub routing on pathname. Values are either a Response or a function
 * of the call count, so a poll sequence can change answer between attempts.
 */
function router(
  routes: Record<string, Response | ((n: number) => Response)>,
  calls: Call[],
): typeof fetch {
  const counts = new Map<string, number>();
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { pathname } = new URL(url);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const route = routes[pathname];
    if (!route) return Promise.resolve(jsonRes(404, { success: false, error: "NOT_FOUND" }));
    const n = (counts.get(pathname) ?? 0) + 1;
    counts.set(pathname, n);
    return Promise.resolve(typeof route === "function" ? route(n) : route);
  }) as unknown as typeof fetch;
}

const noSleep = () => Promise.resolve();

describe("TorBox request plumbing", () => {
  it("sends the token as a bearer header, never in the query string", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      { "/v1/api/user/me": jsonRes(200, { success: true, data: { email: "ada@example.com", plan: 2 } }) },
      calls,
    );
    await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep });
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url).not.toContain(TOKEN);
  });

  it("throws when success is false even though the status is 200", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      { "/v1/api/user/me": jsonRes(200, { success: false, error: "DATABASE_ERROR", detail: "try later" }) },
      calls,
    );
    await expect(
      validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 }),
    ).rejects.toThrow(/try later|DATABASE_ERROR/);
  });

  it("reports a rejected token from a 401", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      { "/v1/api/user/me": jsonRes(401, { success: false, error: "BAD_TOKEN" }) },
      calls,
    );
    const err = await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 })
      .catch((e: unknown) => e);
    expect(isTokenRejection(err)).toBe(true);
    expect((err as Error).message).toBe(TOKEN_REJECTED_MESSAGE);
  });

  it("reports a rejected token from AUTH_ERROR on a 200 envelope", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      { "/v1/api/user/me": jsonRes(200, { success: false, error: "AUTH_ERROR" }) },
      calls,
    );
    const err = await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 })
      .catch((e: unknown) => e);
    expect(isTokenRejection(err)).toBe(true);
  });

  it("classifies TorBox's rate limits as transient so an add is requeued", async () => {
    const calls: Call[] = [];
    for (const slug of ["TOO_MANY_REQUESTS", "MONTHLY_LIMIT", "ACTIVE_LIMIT"]) {
      const fetchImpl = router({ "/v1/api/user/me": jsonRes(200, { success: false, error: slug }) }, calls);
      const err = await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 })
        .catch((e: unknown) => e);
      expect(isTransient(err), slug).toBe(true);
    }
  });

  it("does not treat a bad token as transient", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ "/v1/api/user/me": jsonRes(401, { success: false, error: "BAD_TOKEN" }) }, calls);
    const err = await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 })
      .catch((e: unknown) => e);
    expect(isTransient(err)).toBe(false);
  });
});

describe("TorBox logging", () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      spies.push(vi.spyOn(log, level).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("never writes the token to the log, even for a failing call", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ "/v1/api/user/me": jsonRes(500, { success: false, error: "OOPS" }) }, calls);
    await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 }).catch(() => {});
    const logged = spies.flatMap((s) => s.mock.calls.flat()).join("\n");
    expect(logged).not.toContain(TOKEN);
    // Proves the assertion above is not vacuous — something WAS logged.
    expect(logged).toContain("torbox");
  });
});

describe("TorBox validateToken", () => {
  const NOW_ISO = "2026-08-20T00:00:00Z";

  async function statusFor(data: Record<string, unknown>) {
    const calls: Call[] = [];
    const fetchImpl = router({ "/v1/api/user/me": jsonRes(200, { success: true, data }) }, calls);
    return validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep });
  }

  it("maps a Pro plan with an expiry", async () => {
    expect(await statusFor({ email: "ada@example.com", plan: 2, premiumExpiresAt: NOW_ISO })).toEqual({
      provider: "torbox",
      username: "ada@example.com",
      active: true,
      planLabel: "pro",
      expiresAt: new Date(NOW_ISO),
    });
  });

  it("labels each plan integer", async () => {
    expect((await statusFor({ email: "a@b.c", plan: 0 })).planLabel).toBe("free");
    expect((await statusFor({ email: "a@b.c", plan: 1 })).planLabel).toBe("essential");
    expect((await statusFor({ email: "a@b.c", plan: 3 })).planLabel).toBe("standard");
  });

  it("treats an unknown plan integer as active with a generic label", async () => {
    const s = await statusFor({ email: "a@b.c", plan: 9 });
    expect(s.active).toBe(true);
    expect(s.planLabel).toBe("plan 9");
  });

  // ASSUMPTION, unverified: TorBox's free tier can add (cached) torrents, so
  // active is true for plan 0. If it cannot, this becomes false and the
  // existing torrent-confirm path covers it with no other change.
  it("treats the free plan as able to add torrents", async () => {
    expect((await statusFor({ email: "a@b.c", plan: 0 })).active).toBe(true);
  });

  it("has no expiry when premiumExpiresAt is absent or unparseable", async () => {
    expect((await statusFor({ email: "a@b.c", plan: 2 })).expiresAt).toBeNull();
    expect((await statusFor({ email: "a@b.c", plan: 2, premiumExpiresAt: "nope" })).expiresAt).toBeNull();
  });

  it("falls back to a placeholder username when TorBox sends no email", async () => {
    expect((await statusFor({ plan: 2 })).username).toBe("TorBox account");
  });
});
