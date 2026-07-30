import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkCached,
  isTokenRejection,
  isTransient,
  resolveMagnet,
  TOKEN_REJECTED_MESSAGE,
  TorBoxError,
  validateToken,
} from "./torbox";
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
    // fetchResilient reads res.headers unconditionally for any status in its
    // retry set (408/425/429/500/502/503/504), even when retries is 0.
    headers: new Headers(),
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
    const err = await validateToken(TOKEN, { fetchImpl, sleepImpl: noSleep, retries: 0 }).catch(
      (e: unknown) => e,
    );
    const logged = spies.flatMap((s) => s.mock.calls.flat()).join("\n");
    expect(logged).not.toContain(TOKEN);
    // Proves the assertion above is not vacuous — something WAS logged.
    expect(logged).toContain("torbox");
    // The real HttpError → mapFailure path: a 500 with no recognised slug
    // produces a TorBoxError carrying the status and mapFailure's generic message.
    expect(err).toBeInstanceOf(TorBoxError);
    expect((err as TorBoxError).status).toBe(500);
    expect((err as TorBoxError).message).toBe("TorBox error: OOPS.");
  });

  it("never writes the token to the log on a failing requestdl call — the one route that actually carries it in the query string", async () => {
    // /api/user/me (the case above) has no token in its URL at all, so it
    // never exercised logPath()'s actual reason for existing: requestdl is
    // the one TorBox route that puts the API token in the query string
    // (torbox.ts's own contract comment, near requestDownloadLink).
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent() }),
        [REQUESTDL]: jsonRes(500, { success: false, error: "OOPS" }),
      },
      calls,
    );
    const err = await resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep }).catch(
      (e: unknown) => e,
    );
    const logged = spies.flatMap((s) => s.mock.calls.flat()).join("\n");
    expect(logged).not.toContain(TOKEN);
    // Proves the assertion above is not vacuous — the requestdl call really
    // was logged, just without its token.
    expect(logged).toContain("requestdl");
    expect(err).toBeInstanceOf(TorBoxError);
    expect((err as TorBoxError).status).toBe(500);
    expect((err as TorBoxError).message).toBe("TorBox error: OOPS.");
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

const MAGNET = "magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd&dn=Kestrel.2010.1080p.BluRay.x264";
const HASH = "aabbccddeeff00112233445566778899aabbccdd";

const CREATE = "/v1/api/torrents/createtorrent";
const MYLIST = "/v1/api/torrents/mylist";
const REQUESTDL = "/v1/api/torrents/requestdl";

function torrent(over: Record<string, unknown> = {}) {
  return {
    id: 4242,
    hash: HASH,
    name: "Kestrel.2010.1080p.BluRay.x264",
    download_finished: true,
    download_present: true,
    progress: 1,
    files: [{ id: 0, name: "Kestrel.2010.1080p.BluRay.x264.mkv", size: 8_000_000_000 }],
    ...over,
  };
}

describe("TorBox resolveMagnet", () => {
  it("returns one StreamFile per file, with the direct URL", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent() }),
        [REQUESTDL]: jsonRes(200, { success: true, data: "https://cdn.torbox.app/dl/kestrel.mkv" }),
      },
      calls,
    );
    const files = await resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep });
    expect(files).toEqual([
      {
        url: "https://cdn.torbox.app/dl/kestrel.mkv",
        filename: "Kestrel.2010.1080p.BluRay.x264.mkv",
        bytes: 8_000_000_000,
      },
    ]);
    const create = calls.find((c) => c.url.includes("createtorrent"))!;
    expect(create.method).toBe("POST");
    expect(create.body).toContain(encodeURIComponent(MAGNET).slice(0, 20));
  });

  it("converts TorBox's 0-1 progress into the 0-100 every caller assumes", async () => {
    const calls: Call[] = [];
    const seen: number[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: (n: number) =>
          n < 3
            ? jsonRes(200, { success: true, data: torrent({ download_finished: false, progress: n === 1 ? 0.25 : 0.5 }) })
            : jsonRes(200, { success: true, data: torrent() }),
        [REQUESTDL]: jsonRes(200, { success: true, data: "https://cdn.torbox.app/dl/kestrel.mkv" }),
      },
      calls,
    );
    await resolveMagnet(TOKEN, MAGNET, {
      fetchImpl,
      sleepImpl: noSleep,
      pollIntervalMs: 1,
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toEqual([25, 50, 100]);
  });

  it("adds the magnet with no retries — a retry would duplicate the torrent", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ [CREATE]: jsonRes(503, { success: false, error: "OOPS" }) }, calls);
    await expect(
      resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep }),
    ).rejects.toThrow(/TorBox/);
    expect(calls.filter((c) => c.url.includes("createtorrent"))).toHaveLength(1);
  });

  it("accepts `id` as well as `torrent_id` in the createtorrent response", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent() }),
        [REQUESTDL]: jsonRes(200, { success: true, data: "https://cdn.torbox.app/dl/kestrel.mkv" }),
      },
      calls,
    );
    const files = await resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep });
    expect(files).toHaveLength(1);
  });

  it("fails clearly when createtorrent names no torrent id", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ [CREATE]: jsonRes(200, { success: true, data: { hash: HASH } }) }, calls);
    await expect(
      resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep }),
    ).rejects.toThrow(/did not return a torrent id/);
  });

  it("gives up when caching makes no progress for stallMs", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent({ download_finished: false, progress: 0.1 }) }),
      },
      calls,
    );
    await expect(
      resolveMagnet(TOKEN, MAGNET, {
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 10,
        stallMs: 30,
      }),
    ).rejects.toThrow(/no seeders|isn't caching/);
  });

  it("stops polling when the signal aborts", async () => {
    const calls: Call[] = [];
    const ctrl = new AbortController();
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: () => {
          ctrl.abort();
          return jsonRes(200, { success: true, data: torrent({ download_finished: false, progress: 0.1 }) });
        },
      },
      calls,
    );
    await expect(
      resolveMagnet(TOKEN, MAGNET, {
        fetchImpl,
        sleepImpl: noSleep,
        pollIntervalMs: 1,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });

  it("reports a torrent TorBox could not fetch", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, {
          success: true,
          data: torrent({ download_finished: false, download_state: "error", progress: 0 }),
        }),
      },
      calls,
    );
    await expect(
      resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep, pollIntervalMs: 1 }),
    ).rejects.toThrow(/TorBox couldn't/);
  });

  it("errors rather than returning an empty file list", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent({ files: [] }) }),
      },
      calls,
    );
    await expect(
      resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep }),
    ).rejects.toThrow(/no downloadable/);
  });

  it("redacts the token from a network-layer error message that embeds the requestdl URL", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CREATE]: jsonRes(200, { success: true, data: { torrent_id: 4242, hash: HASH } }),
        [MYLIST]: jsonRes(200, { success: true, data: torrent() }),
        [REQUESTDL]: () => {
          throw new Error(
            `fetch failed: connect ECONNRESET https://api.torbox.app/v1/api/torrents/requestdl?token=${TOKEN}&torrent_id=4242&file_id=0`,
          );
        },
      },
      calls,
    );
    const err = await resolveMagnet(TOKEN, MAGNET, { fetchImpl, sleepImpl: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain(TOKEN);
    // Not vacuous: the rest of the network error detail survives redaction.
    expect(message).toContain("ECONNRESET");
  });
});

const CHECKCACHED = "/v1/api/torrents/checkcached";
const HASH_B = "ffeeddccbbaa99887766554433221100ffeeddcc";

describe("TorBox checkCached", () => {
  it("returns the cached hashes, lowercased", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      {
        [CHECKCACHED]: jsonRes(200, {
          success: true,
          data: [{ hash: HASH.toUpperCase(), name: "Kestrel.2010.1080p.BluRay.x264", size: 1 }],
        }),
      },
      calls,
    );
    const cached = await checkCached(TOKEN, [HASH, HASH_B], { fetchImpl, sleepImpl: noSleep });
    expect(cached.has(HASH)).toBe(true);
    expect(cached.has(HASH_B)).toBe(false);
    expect(calls[0]!.url).toContain(`hash=${HASH}%2C${HASH_B}`);
    expect(calls[0]!.url).toContain("format=list");
  });

  it("treats an empty object as nothing cached", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ [CHECKCACHED]: jsonRes(200, { success: true, data: {} }) }, calls);
    const cached = await checkCached(TOKEN, [HASH], { fetchImpl, sleepImpl: noSleep });
    expect(cached.size).toBe(0);
  });

  it("treats an empty list as nothing cached", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({ [CHECKCACHED]: jsonRes(200, { success: true, data: [] }) }, calls);
    const cached = await checkCached(TOKEN, [HASH], { fetchImpl, sleepImpl: noSleep });
    expect(cached.size).toBe(0);
  });

  it("makes no request for an empty hash list", async () => {
    const calls: Call[] = [];
    const fetchImpl = router({}, calls);
    const cached = await checkCached(TOKEN, [], { fetchImpl, sleepImpl: noSleep });
    expect(cached.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
